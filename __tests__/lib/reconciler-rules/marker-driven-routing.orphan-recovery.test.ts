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
    const { readMarker: realReadMarker } = await import("@/lib/marker-reader");

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
