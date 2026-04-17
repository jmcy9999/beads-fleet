// =============================================================================
// Tests for src/lib/agent-launcher.ts — Feature 3 multi-agent same-repo
// regression coverage (factory-core-ppx.10)
// =============================================================================
//
// Validates z9h-shipped behaviour: two concurrent epics targeting the SAME
// repo must be tracked under distinct `activeAgents` Map keys so neither
// launch returns 409 and handleAgentExit for one does not clobber the
// other. This is a test-only bead; the production implementation already
// shipped in factory-core-z9h.3.
//
// The `activeAgents` Map is module-private. We verify the key-format
// invariant via `activeAgentKey`, a pure function exported for regression
// coverage (same precedent as `sessionFileFor` from z9h.12 — that was
// exported so the write path / delete path could be verified to derive
// the same filename from the same inputs). Pure-function coverage of the
// key is sufficient because:
//
//   1. The Map uses `activeAgentKey(repoPath, beadId)` as the ONLY source
//      of its keys. If the key format is distinct for two (repo, bead)
//      tuples, the Map entries are distinct.
//   2. `handleAgentExit` deletes by the same key, so if the key is
//      unique, deletion cannot cross-affect other entries.
//   3. `isAgentActive(repoPath, beadId)` uses the same key, so probe
//      consistency is guaranteed.
//
// If in future the Map becomes keyed by a different function, those
// assumptions break — and a separate bug bead should be filed.
// =============================================================================

import {
  activeAgentKey,
  isAgentActive,
  hasActiveAgentForEpic,
  getFleetAgentStatus,
} from "@/lib/agent-launcher";
import { realpathSync } from "fs";

// Use fleet-core's real path — it exists on this machine and is the
// canonical "same repo" for the two-concurrent-epics scenario.
const FLEET_CORE_PATH = "/Users/janemckay/dev/fleet/fleet-core";
const fleetCoreReal = realpathSync(FLEET_CORE_PATH);

describe("activeAgentKey — Feature 3 invariant (factory-core-ppx.10)", () => {
  describe("key format (regression pattern #7 — Type Confusion)", () => {
    it("with beadId uses `${realpath}::${beadId}` format", () => {
      const key = activeAgentKey(FLEET_CORE_PATH, "factory-core-aaa");
      expect(key).toBe(`${fleetCoreReal}::factory-core-aaa`);
    });

    it("without beadId uses legacy bare realpath (single-agent-per-repo compat)", () => {
      const key = activeAgentKey(FLEET_CORE_PATH);
      expect(key).toBe(fleetCoreReal);
    });

    it("uses `::` (double colon) as the path-beadId separator, not `:` — distinct from LockKey's `:` separator", () => {
      const key = activeAgentKey(FLEET_CORE_PATH, "factory-core-aaa");
      // The key contains exactly one `::` and no lone `:` beyond it.
      expect(key.includes("::")).toBe(true);
      // A key like `/path::bead-id` has exactly one `::` and no other.
      expect(key.split("::")).toHaveLength(2);
    });

    it("key regex matches the spec: path::bead-id shape", () => {
      // Test-spec format: `/^.+:[a-z0-9-]+-[a-z0-9]+$/` — path, colon(s),
      // bd-ID trailing segment. Works against our `::` because `.+:`
      // consumes through the first `:` leaving the second + bead-id.
      const key = activeAgentKey(FLEET_CORE_PATH, "factory-core-aaa");
      expect(key).toMatch(/^.+:[a-z0-9-]+-[a-z0-9]+$/);
    });

    it("resolves the repoPath to a canonical realpath (symlinks do NOT duplicate keys)", () => {
      // Construct a key using FLEET_CORE_PATH and the pre-resolved
      // realpath — they should produce identical keys.
      const keyA = activeAgentKey(FLEET_CORE_PATH, "bead-x");
      const keyB = activeAgentKey(fleetCoreReal, "bead-x");
      expect(keyA).toBe(keyB);
    });
  });

  describe("key distinctness — the Feature 3 guarantee", () => {
    it("two epics on the SAME repo produce DISTINCT keys (the Feature 3 core invariant)", () => {
      // This is the exact scenario that z9h.3 shipped to support: two
      // internal epics (factory-core-aaa, factory-core-bbb) running
      // builders on fleet-core concurrently.
      const keyA = activeAgentKey(FLEET_CORE_PATH, "factory-core-aaa");
      const keyB = activeAgentKey(FLEET_CORE_PATH, "factory-core-bbb");
      expect(keyA).not.toBe(keyB);
    });

    it("same epic on DIFFERENT repos produces DISTINCT keys", () => {
      // Use two pre-existing directories so realpathSync can resolve both.
      // The repo paths themselves are arbitrary — the invariant is that
      // distinct repoPaths map to distinct keys.
      const keyA = activeAgentKey("/Users", "factory-core-aaa");
      const keyB = activeAgentKey("/tmp", "factory-core-aaa");
      expect(keyA).not.toBe(keyB);
    });

    it("legacy call (no beadId) does NOT collide with bead-scoped call on the same repo", () => {
      // Legacy: `${realpath}`
      // Bead-scoped: `${realpath}::something`
      const legacy = activeAgentKey(FLEET_CORE_PATH);
      const scoped = activeAgentKey(FLEET_CORE_PATH, "factory-core-aaa");
      expect(legacy).not.toBe(scoped);
      expect(scoped.startsWith(legacy + "::")).toBe(true);
    });

    it("boundary — 5 concurrent epics on the same repo produce 5 distinct keys", () => {
      const ids = ["a-111", "a-222", "a-333", "a-444", "a-555"];
      const keys = new Set(ids.map((id) => activeAgentKey(FLEET_CORE_PATH, id)));
      expect(keys.size).toBe(5);
    });
  });

  describe("nil / missing input (defensive)", () => {
    it("empty beadId treated as legacy (falsy check in production code)", () => {
      // Empty string is falsy in the `beadId ? ... : legacy` check.
      const key = activeAgentKey(FLEET_CORE_PATH, "");
      expect(key).toBe(fleetCoreReal);
    });

    it("bead with complex characters produces a key without mangling (raw beadId in key)", () => {
      // activeAgentKey does NOT sanitise — the Map key is internal so
      // we can carry any beadId string. sessionScopeSuffix handles
      // filename sanitisation separately.
      const key = activeAgentKey(FLEET_CORE_PATH, "bead.with.dots");
      expect(key).toBe(`${fleetCoreReal}::bead.with.dots`);
    });
  });
});

describe("activeAgents observability — empty-state invariants (factory-core-ppx.10)", () => {
  // These tests run without launching any agents — they baseline the
  // empty-state behaviour of the already-exported probes. They do NOT
  // populate activeAgents; they only assert that empty state is safe to
  // query.

  it("isAgentActive returns false when no agent is tracked", () => {
    // Use a key guaranteed not to collide with any real agent.
    const sentinel = `ppx-test-sentinel-${Date.now()}-${Math.random()}`;
    expect(isAgentActive(FLEET_CORE_PATH, sentinel)).toBe(false);
  });

  it("hasActiveAgentForEpic returns false for a nonexistent epic", () => {
    const sentinel = `ppx-test-epic-${Date.now()}-${Math.random()}`;
    expect(hasActiveAgentForEpic(sentinel)).toBe(false);
  });

  it("getFleetAgentStatus is safe to call (does not crash) in empty state", async () => {
    // Should NOT throw; we don't assert on the shape because ambient
    // agents (if any) may be running on the dev machine.
    const status = await getFleetAgentStatus();
    expect(Array.isArray(status.agents)).toBe(true);
    expect(typeof status.totalRunning).toBe("number");
    expect(status.totalRunning).toBe(status.agents.length);
  });

  it("getFleetAgentStatus snapshot uses Array.from-like semantics (no Map-mutation crash)", async () => {
    // This is a smoke test — the production code iterates activeAgents
    // via `for (const [key, agent] of activeAgents)`. The Feature 3 NFR
    // is that iteration uses a snapshot (Array.from). Since we can't
    // mutate the Map from outside, we simply verify the status call
    // completes without an iterator-invalidation error.
    await expect(getFleetAgentStatus()).resolves.toBeDefined();
    // Call a second time — still safe.
    await expect(getFleetAgentStatus()).resolves.toBeDefined();
  });
});
