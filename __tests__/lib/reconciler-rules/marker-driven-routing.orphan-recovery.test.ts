// =============================================================================
// Tests for beads_web-hs5 — filesystem-walk fallback in marker-driven-routing
//
// 6 unit tests + 1 integration test covering the orphaned marker recovery
// path added in hs5. These complement the existing 6 event-based tests in
// marker-driven-routing.test.ts (beads_web-xfc).
//
// Unit tests (AC#5):
//   1. Orphaned marker + open bead + routing -> dispatch fires
//   2. Orphaned marker + closed bead -> skip
//   3. Orphaned marker + recent reconciler-action-taken -> skip (idempotency)
//   4. Throttle: second call within 300s skips filesystem walk
//   5. Repo missing .beads/markers/ -> continue, no throw
//   6. Malformed marker JSON -> continue, no throw
//
// Integration test (AC#6):
//   7. Synthetic orphaned marker -> reconciler tick -> correct agent dispatched
// =============================================================================

import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";

// beads_web-ehp.4: marker-driven-routing's act() now wraps the dispatch
// fetch with a dispatch-precondition gate. The gate calls readBeadStatus /
// readMarker / getEpicLabels. Mock these at the import boundary so legacy
// orphan-recovery tests (which don't stand up a real bd repo) bypass the
// precondition layer cleanly — open bead, no marker, no labels means every
// universal predicate passes and the existing dispatch behaviour is
// preserved.
jest.mock("@/lib/bead-status-reader", () => {
  const actual = jest.requireActual("@/lib/bead-status-reader");
  return {
    ...actual,
    readBeadStatus: jest.fn().mockImplementation(async (id: string) => ({
      id,
      status: "open",
      labels: [],
      type: "task",
      pipelineStage: null,
      currentQaRound: null,
      currentWave: null,
      hasAgentRunning: false,
      hasReviewNeedsHuman: false,
    })),
  };
});
jest.mock("@/lib/marker-reader", () => {
  const actual = jest.requireActual("@/lib/marker-reader");
  return {
    ...actual,
    readMarker: jest.fn().mockResolvedValue(null),
  };
});
jest.mock("@/lib/pipeline-labels", () => ({
  getEpicLabels: jest.fn().mockResolvedValue([]),
}));

import { Reconciler } from "@/lib/reconciler";
import { appendEvent, readEvents } from "@/lib/event-log";
import {
  buildMarkerDrivenRoutingRule,
  MARKER_DRIVEN_ROUTING_RULE_NAME,
  type MarkerDrivenRoutingEpicSnapshot,
  type RegisteredRepo,
} from "@/lib/reconciler-rules/marker-driven-routing";
import type { MarkerData } from "@/lib/marker-reader";

/** Create a temp directory for the event log. */
async function makeRepo(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "hs5-test-"));
}

/** Build a minimal valid MarkerData object with epic_id (epic-scope marker). */
function makeEpicMarker(overrides: Partial<MarkerData> = {}): MarkerData {
  return {
    version: "1",
    epic_id: "factory-core-test",
    status: "success",
    stage: "planner",
    started_at: new Date().toISOString(),
    exited_at: new Date().toISOString(),
    ...overrides,
  };
}

/** Build a minimal epic snapshot. */
function makeSnapshot(
  overrides: Partial<MarkerDrivenRoutingEpicSnapshot> = {},
): MarkerDrivenRoutingEpicSnapshot {
  return {
    currentStage: "plan-review",
    labels: ["pipeline:plan-review"],
    title: "Test Epic",
    ...overrides,
  };
}

describe("marker-driven-routing orphan recovery (beads_web-hs5)", () => {
  let fetchMock: jest.SpyInstance;
  let fetchCalls: Array<{ url: string; body: unknown }>;

  beforeEach(() => {
    fetchCalls = [];
    fetchMock = jest
      .spyOn(global, "fetch")
      .mockImplementation(
        async (url: RequestInfo | URL, init?: RequestInit) => {
          const body =
            init?.body && typeof init.body === "string"
              ? JSON.parse(init.body)
              : undefined;
          fetchCalls.push({ url: String(url), body });
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      );
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  // =========================================================================
  // Unit Test 1 (AC#5): Orphaned marker + open bead + routing -> dispatch
  // =========================================================================
  test("filesystem-walk discovers orphaned marker with routing intent and open bead", async () => {
    const orphanMarker = makeEpicMarker({
      epic_id: "factory-core-lmxb",
      status: "blocked",
      stage: "planner",
      next_agent: "architect",
    });

    const rule = buildMarkerDrivenRoutingRule({
      readMarker: async (_rp: string, markerId: string) => {
        if (markerId === "factory-core-lmxb-planner") return orphanMarker;
        return null;
      },
      readEpicSnapshot: async () =>
        makeSnapshot({
          currentStage: "plan-review",
          labels: ["pipeline:plan-review", "ship-type:internal"],
          title: "LMXB Orphan Test",
        }),
      repoPath: "/tmp/hs5-main-repo",
      actionUrl: "http://localhost:3000/api/fleet/action",
      // Filesystem-walk callbacks
      listRegisteredRepos: () => [
        { name: "factory-core", path: "/tmp/hs5-fc-repo" },
      ],
      listMarkerFiles: () => ["factory-core-lmxb-planner.json"],
      readBeadStatus: () => "open",
    });

    // No agent-exited events -> event-based discovery returns empty ->
    // filesystem-walk runs.
    const events: import("@/lib/event-log").PipelineEvent[] = [];
    const matches = await rule.matches(events, new Date());

    expect(matches).toHaveLength(1);
    expect(matches[0].epicId).toBe("factory-core-lmxb");
    expect(matches[0].idempotencyKey).toBe(
      "marker-driven-routing::factory-core-lmxb::planner",
    );
    const ctx = matches[0].context as Record<string, unknown>;
    expect(ctx.discoveredVia).toBe("filesystem-walk");

    // act() should dispatch architect
    await rule.act(matches[0]);
    expect(fetchCalls).toHaveLength(1);
    const body = fetchCalls[0].body as Record<string, unknown>;
    expect(body.action).toBe("run-architect");
    expect(body.epicId).toBe("factory-core-lmxb");
  });

  // =========================================================================
  // Unit Test 2 (AC#5): Orphaned marker + closed bead -> skip
  // =========================================================================
  test("filesystem-walk skips orphaned marker when bead is closed", async () => {
    const orphanMarker = makeEpicMarker({
      epic_id: "factory-core-old",
      status: "blocked",
      stage: "planner",
      next_agent: "architect",
    });

    const rule = buildMarkerDrivenRoutingRule({
      readMarker: async () => orphanMarker,
      readEpicSnapshot: async () => makeSnapshot(),
      repoPath: "/tmp/hs5-test",
      actionUrl: "http://localhost:3000/api/fleet/action",
      listRegisteredRepos: () => [
        { name: "factory-core", path: "/tmp/hs5-fc" },
      ],
      listMarkerFiles: () => ["factory-core-old-planner.json"],
      readBeadStatus: () => "closed", // bead is CLOSED
    });

    const matches = await rule.matches([], new Date());
    expect(matches).toHaveLength(0);
  });

  // =========================================================================
  // Unit Test 3 (AC#5): Orphaned marker + recent reconciler-action-taken
  // -> skip (idempotency handled by reconciler core, not by rule)
  // =========================================================================
  test("reconciler core idempotency skips duplicate dispatch from filesystem-walk", async () => {
    const repo = await makeRepo();

    const orphanMarker = makeEpicMarker({
      epic_id: "factory-core-dup",
      status: "blocked",
      stage: "planner",
      next_agent: "architect",
    });

    const rule = buildMarkerDrivenRoutingRule({
      readMarker: async () => orphanMarker,
      readEpicSnapshot: async () =>
        makeSnapshot({
          currentStage: "plan-review",
          labels: ["pipeline:plan-review"],
          title: "Dup Test",
        }),
      repoPath: repo,
      actionUrl: "http://localhost:3000/api/fleet/action",
      listRegisteredRepos: () => [
        { name: "factory-core", path: "/tmp/hs5-dup" },
      ],
      listMarkerFiles: () => ["factory-core-dup-planner.json"],
      readBeadStatus: () => "open",
    });

    // Seed a prior reconciler-action-taken event for this (epicId, stage).
    await appendEvent(repo, {
      type: "reconciler-action-taken",
      epicId: "factory-core-dup",
      stage: "planner",
      payload: {
        ruleName: MARKER_DRIVEN_ROUTING_RULE_NAME,
        idempotencyKey: "marker-driven-routing::factory-core-dup::planner",
      },
    });

    // The rule still produces a match (that's its job).
    const events = await readEvents(repo, {});
    const matches = await rule.matches(events, new Date());
    // The filesystem-walk finds the marker (no agent-exited events means
    // event-based path returns empty, filesystem-walk runs).
    expect(matches).toHaveLength(1);

    // But the reconciler core's tick will see the prior action-taken event
    // and skip act(). We verify this via the Reconciler class directly.
    const reconciler = new Reconciler({
      repoPath: repo,
      tickIntervalMs: 999_999, // don't auto-tick
      maxConcurrentDispatches: 10,
    });
    reconciler.registerRule(rule);
    await reconciler.tick(new Date());

    // No fetch calls — idempotency blocked the dispatch.
    expect(fetchCalls).toHaveLength(0);

    reconciler.stop();
  });

  // =========================================================================
  // Unit Test 4 (AC#5): Throttle — second call within 300s skips walk
  // =========================================================================
  test("reconciler throttle skips rule when called within minTickIntervalMs", async () => {
    const repo = await makeRepo();

    let walkCallCount = 0;
    const rule = buildMarkerDrivenRoutingRule({
      readMarker: async () =>
        makeEpicMarker({
          epic_id: "factory-core-throttle",
          stage: "planner",
          next_agent: "architect",
        }),
      readEpicSnapshot: async () => makeSnapshot({ title: "Throttle Test" }),
      repoPath: repo,
      actionUrl: "http://localhost:3000/api/fleet/action",
      listRegisteredRepos: () => {
        walkCallCount += 1;
        return [{ name: "fc", path: "/tmp/hs5-throttle" }];
      },
      listMarkerFiles: () => ["factory-core-throttle-planner.json"],
      readBeadStatus: () => "open",
    });

    // Apply 300s throttle (mimics reconciler-bootstrap.ts wiring).
    rule.minTickIntervalMs = 300_000;

    const reconciler = new Reconciler({
      repoPath: repo,
      tickIntervalMs: 999_999, // manual ticks
      maxConcurrentDispatches: 10,
    });
    reconciler.registerRule(rule);

    // First tick at T=0 — rule runs (matches called, filesystem walk runs).
    const t0 = new Date("2026-05-01T10:00:00Z");
    await reconciler.tick(t0);
    const firstWalkCount = walkCallCount;
    expect(firstWalkCount).toBeGreaterThanOrEqual(1);

    // Second tick at T=60s — within 300s window, rule should be SKIPPED.
    const t60 = new Date("2026-05-01T10:01:00Z");
    await reconciler.tick(t60);
    // walkCallCount should not have increased.
    expect(walkCallCount).toBe(firstWalkCount);

    reconciler.stop();
  });

  // =========================================================================
  // Unit Test 5 (AC#5): Repo missing .beads/markers/ -> continue, no throw
  // =========================================================================
  test("filesystem-walk tolerates missing .beads/markers/ directory", async () => {
    const rule = buildMarkerDrivenRoutingRule({
      readMarker: async () => null,
      readEpicSnapshot: async () => makeSnapshot(),
      repoPath: "/tmp/hs5-test",
      actionUrl: "http://localhost:3000/api/fleet/action",
      listRegisteredRepos: () => [
        { name: "missing-repo", path: "/tmp/nonexistent-repo-hs5" },
      ],
      listMarkerFiles: (_rp: string) => {
        // Simulate ENOENT — return empty array per AC#8 tolerance.
        return [];
      },
      readBeadStatus: () => "open",
    });

    // Should complete without throwing, return empty matches.
    const matches = await rule.matches([], new Date());
    expect(matches).toHaveLength(0);
  });

  // =========================================================================
  // Unit Test 6 (AC#5): Malformed marker JSON -> continue, no throw
  // =========================================================================
  test("filesystem-walk tolerates malformed marker JSON (readMarker returns null)", async () => {
    let goodMarkerRead = false;

    const rule = buildMarkerDrivenRoutingRule({
      readMarker: async (_rp: string, markerId: string) => {
        if (markerId === "broken-marker") {
          return null; // malformed JSON — readMarker returns null
        }
        if (markerId === "factory-core-good-planner") {
          goodMarkerRead = true;
          return makeEpicMarker({
            epic_id: "factory-core-good",
            stage: "planner",
            next_agent: "architect",
          });
        }
        return null;
      },
      readEpicSnapshot: async () => makeSnapshot({ title: "Malformed Test" }),
      repoPath: "/tmp/hs5-test",
      actionUrl: "http://localhost:3000/api/fleet/action",
      listRegisteredRepos: () => [
        { name: "fc", path: "/tmp/hs5-malformed" },
      ],
      listMarkerFiles: () => [
        "broken-marker.json",
        "factory-core-good-planner.json",
      ],
      readBeadStatus: () => "open",
    });

    const matches = await rule.matches([], new Date());

    // Broken marker skipped, good marker matched.
    expect(goodMarkerRead).toBe(true);
    expect(matches).toHaveLength(1);
    expect(matches[0].epicId).toBe("factory-core-good");
  });

  // =========================================================================
  // Integration Test (AC#6): Synthetic orphaned marker -> reconciler tick
  // -> correct agent dispatched
  // =========================================================================
  test("integration: orphaned marker discovered and dispatched via reconciler tick", async () => {
    const repo = await makeRepo();

    // Write a synthetic orphaned marker to disk.
    const markersDir = path.join(repo, ".beads", "markers");
    await fs.mkdir(markersDir, { recursive: true });
    const orphanMarker: MarkerData = {
      version: "1",
      epic_id: "factory-core-orphan",
      status: "blocked",
      stage: "planner",
      started_at: "2026-05-01T10:00:00Z",
      exited_at: "2026-05-01T10:05:00Z",
      next_agent: "planner",
    };
    await fs.writeFile(
      path.join(markersDir, "factory-core-orphan-planner.json"),
      JSON.stringify(orphanMarker),
    );

    // Build the rule with real filesystem-walk (reading from the temp repo).
    const { readdirSync } = require("fs");
    // beads_web-ehp.4: jest.mock at file-top now intercepts the
    // readMarker import. This test wants the REAL filesystem reader for
    // the rule's own opts.readMarker (so it discovers the synthetic
    // marker file we wrote above) — use requireActual to bypass the mock.
    const { readMarker: realReadMarker } = jest.requireActual(
      "@/lib/marker-reader",
    );

    const rule = buildMarkerDrivenRoutingRule({
      readMarker: realReadMarker,
      readEpicSnapshot: async () =>
        makeSnapshot({
          currentStage: "plan-review",
          labels: ["pipeline:plan-review", "ship-type:internal"],
          title: "Orphan Integration Test",
        }),
      repoPath: repo,
      actionUrl: "http://localhost:3000/api/fleet/action",
      listRegisteredRepos: () => [{ name: "test-repo", path: repo }],
      listMarkerFiles: (rp: string) => {
        try {
          const dir = path.join(rp, ".beads", "markers");
          return readdirSync(dir).filter((f: string) => f.endsWith(".json"));
        } catch {
          return [];
        }
      },
      readBeadStatus: () => "open", // test bead is "open"
    });

    // No agent-exited events — the marker is truly orphaned.
    // Build a reconciler with no throttle to run immediately.
    const reconciler = new Reconciler({
      repoPath: repo,
      tickIntervalMs: 999_999, // manual ticks
      maxConcurrentDispatches: 10,
    });
    reconciler.registerRule(rule);

    // Run a tick — should discover the orphaned marker and dispatch planner.
    await reconciler.tick(new Date());

    expect(fetchCalls).toHaveLength(1);
    const body = fetchCalls[0].body as Record<string, unknown>;
    expect(body.action).toBe("generate-plan");
    expect(body.epicId).toBe("factory-core-orphan");

    // Verify a reconciler-action-taken event was emitted (idempotency).
    const events = await readEvents(repo, {});
    const actionTaken = events.find(
      (e) =>
        e.type === "reconciler-action-taken" &&
        (e.payload as Record<string, unknown>)?.idempotencyKey ===
          "marker-driven-routing::factory-core-orphan::planner",
    );
    expect(actionTaken).toBeDefined();

    // Second tick — idempotency should prevent double-dispatch.
    fetchCalls.length = 0;
    await reconciler.tick(new Date());
    expect(fetchCalls).toHaveLength(0);

    reconciler.stop();
  });
});

// =============================================================================
// beads_web-poh.17 — persistent dispatch-sentinel dedupe.
//
// The reconciler's event-log dedupe expires after 60 minutes and depends
// on events.jsonl being intact. A stale marker (still on disk, untouched)
// re-fires when the bucket rotates or the log is lost — empirically this
// re-dispatched the product-manager agent 4× on factory-core-1vud (V1
// retest, 2026-05-07).
//
// The sentinel is a small JSON file written next to each marker after a
// successful dispatch. matches() consults it before pushing a re-dispatch
// from the filesystem-walk fallback. Genuine retries (agent rewrites the
// marker with a new next_agent) are still allowed because the marker's
// new mtime is > sentinel.markerMtimeMs.
// =============================================================================

describe("marker-driven-routing dispatch sentinels (beads_web-poh.17)", () => {
  let fetchMock: jest.SpyInstance;
  let fetchCalls: Array<{ url: string; body: unknown }>;
  let fetchStatus = 200;

  beforeEach(() => {
    fetchCalls = [];
    fetchStatus = 200;
    fetchMock = jest
      .spyOn(global, "fetch")
      .mockImplementation(
        async (url: RequestInfo | URL, init?: RequestInit) => {
          const body =
            init?.body && typeof init.body === "string"
              ? JSON.parse(init.body)
              : undefined;
          fetchCalls.push({ url: String(url), body });
          return new Response(JSON.stringify({ ok: fetchStatus < 400 }), {
            status: fetchStatus,
            headers: { "Content-Type": "application/json" },
          });
        },
      );
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  test("matches() SKIPS a marker whose sentinel says it was already dispatched and the marker is unchanged", async () => {
    // factory-core-1vud V1 retest reproducer: research's marker was
    // dispatched once, the 60-min idempotency horizon rotated, and the
    // filesystem-walk re-discovered the SAME marker on the next tick.
    // With the sentinel: same marker mtime as recorded → skip.
    const marker = makeEpicMarker({
      epic_id: "factory-core-1vud",
      stage: "research",
      next_agent: "product-manager",
    });
    const idempotencyKey =
      "marker-driven-routing::factory-core-1vud::research";

    const rule = buildMarkerDrivenRoutingRule({
      readMarker: async () => marker,
      readEpicSnapshot: async () => makeSnapshot(),
      repoPath: "/tmp/poh17-skip",
      actionUrl: "http://localhost:3000/api/fleet/action",
      listRegisteredRepos: () => [
        { name: "factory-core", path: "/tmp/poh17-skip" },
      ],
      listMarkerFiles: () => ["factory-core-1vud-research.json"],
      readBeadStatus: () => "open",
      readDispatchSentinel: () => ({
        idempotencyKey,
        dispatchedAt: "2026-05-07T13:54:00Z",
        // Sentinel says marker was at mtime=1000 when dispatched.
        markerMtimeMs: 1000,
      }),
      writeDispatchSentinel: async () => {},
      // Marker hasn't been rewritten — same mtime as the sentinel.
      statMarkerMtime: () => 1000,
    });

    const matches = await rule.matches([], new Date());
    expect(matches).toHaveLength(0); // sentinel-skip — no re-dispatch
  });

  test("matches() PUSHES a marker whose sentinel exists BUT the marker was rewritten (mtime newer)", async () => {
    // Genuine retry: the agent re-ran and wrote a NEW marker with a
    // different next_agent. mtime > sentinel.markerMtimeMs → the
    // routing intent is fresh, dispatch must fire.
    const marker = makeEpicMarker({
      epic_id: "factory-core-1vud",
      stage: "research",
      next_agent: "product-manager",
    });
    const idempotencyKey =
      "marker-driven-routing::factory-core-1vud::research";

    const rule = buildMarkerDrivenRoutingRule({
      readMarker: async () => marker,
      readEpicSnapshot: async () => makeSnapshot(),
      repoPath: "/tmp/poh17-retry",
      actionUrl: "http://localhost:3000/api/fleet/action",
      listRegisteredRepos: () => [
        { name: "factory-core", path: "/tmp/poh17-retry" },
      ],
      listMarkerFiles: () => ["factory-core-1vud-research.json"],
      readBeadStatus: () => "open",
      readDispatchSentinel: () => ({
        idempotencyKey,
        dispatchedAt: "2026-05-07T13:54:00Z",
        markerMtimeMs: 1000, // when dispatched
      }),
      writeDispatchSentinel: async () => {},
      // Marker has been rewritten — mtime is now newer.
      statMarkerMtime: () => 2000,
    });

    const matches = await rule.matches([], new Date());
    expect(matches).toHaveLength(1);
    expect(matches[0].idempotencyKey).toBe(idempotencyKey);
  });

  test("matches() PUSHES a marker when no sentinel exists (genuine first dispatch)", async () => {
    const marker = makeEpicMarker({
      epic_id: "factory-core-fresh",
      stage: "planner",
      next_agent: "test-spec",
    });

    const rule = buildMarkerDrivenRoutingRule({
      readMarker: async () => marker,
      readEpicSnapshot: async () => makeSnapshot(),
      repoPath: "/tmp/poh17-fresh",
      actionUrl: "http://localhost:3000/api/fleet/action",
      listRegisteredRepos: () => [
        { name: "factory-core", path: "/tmp/poh17-fresh" },
      ],
      listMarkerFiles: () => ["factory-core-fresh-planner.json"],
      readBeadStatus: () => "open",
      readDispatchSentinel: () => null, // no sentinel
      writeDispatchSentinel: async () => {},
      statMarkerMtime: () => 5000,
    });

    const matches = await rule.matches([], new Date());
    expect(matches).toHaveLength(1);
  });

  test("act() WRITES the sentinel with marker mtime after a successful dispatch", async () => {
    const marker = makeEpicMarker({
      epic_id: "factory-core-write",
      stage: "planner",
      next_agent: "test-spec",
    });
    const writes: Array<{
      repoPath: string;
      key: string;
      sentinel: { markerMtimeMs: number; nextAgent?: string };
    }> = [];

    const rule = buildMarkerDrivenRoutingRule({
      readMarker: async () => marker,
      readEpicSnapshot: async () =>
        makeSnapshot({
          currentStage: "plan-review",
          labels: ["pipeline:plan-review", "ship-type:internal"],
        }),
      repoPath: "/tmp/poh17-write",
      actionUrl: "http://localhost:3000/api/fleet/action",
      listRegisteredRepos: () => [
        { name: "factory-core", path: "/tmp/poh17-write" },
      ],
      listMarkerFiles: () => ["factory-core-write-planner.json"],
      readBeadStatus: () => "open",
      readDispatchSentinel: () => null,
      writeDispatchSentinel: async (rp, key, s) => {
        writes.push({ repoPath: rp, key, sentinel: s });
      },
      statMarkerMtime: () => 8000,
    });

    const matches = await rule.matches([], new Date());
    expect(matches).toHaveLength(1);
    await rule.act(matches[0]);

    expect(fetchCalls).toHaveLength(1); // dispatch went out
    expect(writes).toHaveLength(1);
    expect(writes[0].repoPath).toBe("/tmp/poh17-write");
    expect(writes[0].key).toBe(
      "marker-driven-routing::factory-core-write::planner",
    );
    // Sentinel records the marker's mtime captured at matches() time.
    expect(writes[0].sentinel.markerMtimeMs).toBe(8000);
    expect(writes[0].sentinel.nextAgent).toBe("test-spec");
  });

  test("act() does NOT write the sentinel when the action route refuses with HTTP 412", async () => {
    // 412 = precondition refusal. The dispatch did NOT happen, so we
    // must not pin the marker as dispatched — otherwise a real later
    // tick (when preconditions clear) would be sentinel-blocked.
    fetchStatus = 412;

    const marker = makeEpicMarker({
      epic_id: "factory-core-refused",
      stage: "planner",
      next_agent: "test-spec",
    });
    const writes: Array<unknown> = [];

    const rule = buildMarkerDrivenRoutingRule({
      readMarker: async () => marker,
      readEpicSnapshot: async () =>
        makeSnapshot({
          currentStage: "plan-review",
          labels: ["pipeline:plan-review", "ship-type:internal"],
        }),
      repoPath: "/tmp/poh17-refused",
      actionUrl: "http://localhost:3000/api/fleet/action",
      listRegisteredRepos: () => [
        { name: "factory-core", path: "/tmp/poh17-refused" },
      ],
      listMarkerFiles: () => ["factory-core-refused-planner.json"],
      readBeadStatus: () => "open",
      readDispatchSentinel: () => null,
      writeDispatchSentinel: async (rp, key, s) => {
        writes.push({ rp, key, s });
      },
      statMarkerMtime: () => 9000,
    });

    const matches = await rule.matches([], new Date());
    await rule.act(matches[0]);

    // Dispatch attempted (412), but no sentinel written.
    expect(fetchCalls).toHaveLength(1);
    expect(writes).toHaveLength(0);
  });

  test("rule remains backward-compatible when sentinel callbacks are NOT supplied", async () => {
    // Pre-poh.17 wiring (bootstrap callers that haven't been updated)
    // must continue to work. Sentinel logic is purely additive.
    const marker = makeEpicMarker({
      epic_id: "factory-core-legacy",
      stage: "planner",
      next_agent: "test-spec",
    });

    const rule = buildMarkerDrivenRoutingRule({
      readMarker: async () => marker,
      readEpicSnapshot: async () => makeSnapshot(),
      repoPath: "/tmp/poh17-legacy",
      actionUrl: "http://localhost:3000/api/fleet/action",
      listRegisteredRepos: () => [
        { name: "factory-core", path: "/tmp/poh17-legacy" },
      ],
      listMarkerFiles: () => ["factory-core-legacy-planner.json"],
      readBeadStatus: () => "open",
      // NO readDispatchSentinel / writeDispatchSentinel / statMarkerMtime.
    });

    const matches = await rule.matches([], new Date());
    expect(matches).toHaveLength(1); // legacy behaviour preserved
    await rule.act(matches[0]);
    expect(fetchCalls).toHaveLength(1); // dispatch fires
  });

  test("filesystem-walk throttle is now scoped INSIDE the rule (poh.18) — second call within budget skips walk only, event-based runs every tick", async () => {
    // Pre-poh.18: the whole rule was wrapped in throttled(rule, 300_000)
    // and a coherence-exit marker waited up to 5 minutes for the next
    // unblocked tick — long enough for stuck-in-stage to dispatch
    // coherence ahead of it. Now the throttle is INSIDE the rule and
    // only gates the filesystem-walk fallback. The cheap event-based
    // path runs every tick.
    let walkCallCount = 0;

    const rule = buildMarkerDrivenRoutingRule({
      readMarker: async () =>
        makeEpicMarker({
          epic_id: "factory-core-walk",
          stage: "planner",
          next_agent: "test-spec",
        }),
      readEpicSnapshot: async () => makeSnapshot(),
      repoPath: "/tmp/poh18-walk",
      actionUrl: "http://localhost:3000/api/fleet/action",
      filesystemWalkThrottleMs: 60_000, // 60s for testing
      listRegisteredRepos: () => {
        walkCallCount += 1;
        return [{ name: "factory-core", path: "/tmp/poh18-walk" }];
      },
      listMarkerFiles: () => ["factory-core-walk-planner.json"],
      readBeadStatus: () => "open",
    });

    // First call at t=0 — walk runs, finds the orphan, returns 1 match.
    const t0 = new Date("2026-05-07T13:54:00Z");
    const matches1 = await rule.matches([], t0);
    expect(matches1).toHaveLength(1);
    expect(walkCallCount).toBe(1);

    // Second call at t=30s — within the 60s budget, walk MUST be skipped.
    const t30 = new Date("2026-05-07T13:54:30Z");
    const matches2 = await rule.matches([], t30);
    expect(walkCallCount).toBe(1); // walk did NOT run again
    expect(matches2).toHaveLength(0); // event-based had no events

    // Third call at t=70s — past the 60s budget, walk runs again.
    const t70 = new Date("2026-05-07T13:55:10Z");
    const matches3 = await rule.matches([], t70);
    expect(walkCallCount).toBe(2);
    expect(matches3).toHaveLength(1);
  });

  test("event-based path is UNTHROTTLED — runs every tick even when filesystem walk is in cooldown (poh.18)", async () => {
    // Same scenario as the previous test but driving the event-based
    // path: any agent-exited event in the lookback window produces a
    // match on every tick, regardless of the filesystem-walk throttle.
    let walkCallCount = 0;
    let eventReadCount = 0;

    const rule = buildMarkerDrivenRoutingRule({
      readMarker: async () => {
        eventReadCount += 1;
        return makeEpicMarker({
          epic_id: "factory-core-evt",
          stage: "coherence",
          next_agent: "product-manager",
        });
      },
      readEpicSnapshot: async () => makeSnapshot(),
      repoPath: "/tmp/poh18-evt",
      actionUrl: "http://localhost:3000/api/fleet/action",
      filesystemWalkThrottleMs: 60_000,
      listRegisteredRepos: () => {
        walkCallCount += 1;
        return [];
      },
      listMarkerFiles: () => [],
    });

    const events: import("@/lib/event-log").PipelineEvent[] = [
      {
        type: "agent-exited",
        epicId: "factory-core-evt",
        stage: "coherence",
        timestamp: "2026-05-07T13:53:00Z",
        correlationId: "evt-1",
        payload: {},
      },
    ];

    // Three back-to-back ticks 1s apart. The walk would be blocked on
    // ticks 2 and 3 if it were ever invoked, but the event-based path
    // produces a match on every tick so the walk never runs at all.
    const t1 = new Date("2026-05-07T13:54:00Z");
    const t2 = new Date("2026-05-07T13:54:01Z");
    const t3 = new Date("2026-05-07T13:54:02Z");
    const m1 = await rule.matches(events, t1);
    const m2 = await rule.matches(events, t2);
    const m3 = await rule.matches(events, t3);

    expect(m1).toHaveLength(1);
    expect(m2).toHaveLength(1);
    expect(m3).toHaveLength(1);
    // Walk was never invoked because event-based path produced matches.
    expect(walkCallCount).toBe(0);
    // Marker was read three times — once per tick, no throttle.
    expect(eventReadCount).toBe(3);
  });

  test("matches() ignores the sentinel when statMarkerMtime is unavailable (fail-safe)", async () => {
    // Defensive case: if statMarkerMtime is not configured, we cannot
    // compare the marker's freshness to the sentinel — fail open and
    // push the match. The reconciler's event-log dedupe still catches
    // the duplicate within the 60-minute horizon.
    const marker = makeEpicMarker({
      epic_id: "factory-core-no-stat",
      stage: "planner",
      next_agent: "test-spec",
    });

    const rule = buildMarkerDrivenRoutingRule({
      readMarker: async () => marker,
      readEpicSnapshot: async () => makeSnapshot(),
      repoPath: "/tmp/poh17-no-stat",
      actionUrl: "http://localhost:3000/api/fleet/action",
      listRegisteredRepos: () => [
        { name: "factory-core", path: "/tmp/poh17-no-stat" },
      ],
      listMarkerFiles: () => ["factory-core-no-stat-planner.json"],
      readBeadStatus: () => "open",
      readDispatchSentinel: () => ({
        idempotencyKey:
          "marker-driven-routing::factory-core-no-stat::planner",
        dispatchedAt: "2026-05-07T13:54:00Z",
        markerMtimeMs: 1000,
      }),
      writeDispatchSentinel: async () => {},
      // statMarkerMtime: undefined  ← deliberately omitted
    });

    const matches = await rule.matches([], new Date());
    expect(matches).toHaveLength(1);
  });
});
