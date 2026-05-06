// =============================================================================
// Tests for src/lib/reconciler-rules/marker-driven-routing.ts (beads_web-xfc)
//
// Defense-in-depth reconciler rule that catches markers the inline fast path
// (kvn) missed. 6 tests covering:
//   1. agent-exited + marker next_agent=architect -> architect dispatched
//   2. agent-exited + marker status=success, no next_agent -> reconciler skips
//   3. idempotency: duplicate agent-exited events produce single match
//   4. missing marker -> reconciler skips
//   5. malformed marker (readMarker returns null) -> reconciler skips
//   6. agent:running label present -> reconciler dispatches anyway
//      (agent-exited events by definition mean agent is no longer running;
//       stale labels are liveness-check's job to clear)
// =============================================================================

import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";

// beads_web-ehp.4: marker-driven-routing's act() now wraps the dispatch
// fetch with a dispatch-precondition gate. The gate calls readBeadStatus /
// readMarker / getEpicLabels. Mock these at the import boundary so legacy
// tests (which don't stand up a real bd repo) bypass the precondition layer
// cleanly — opening the bead, returning no marker, returning no labels means
// every universal predicate passes.
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
import { appendEvent } from "@/lib/event-log";
import {
  buildMarkerDrivenRoutingRule,
  MARKER_DRIVEN_ROUTING_RULE_NAME,
  type MarkerDrivenRoutingEpicSnapshot,
} from "@/lib/reconciler-rules/marker-driven-routing";
import type { MarkerData } from "@/lib/marker-reader";
import type { PipelineEvent } from "@/lib/event-log";

/** Create a temp directory for the event log. */
async function makeRepo(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "xfc-test-"));
}

/** Seed an agent-exited event into the event log. */
async function seedAgentExitedEvent(
  repo: string,
  epicId: string,
  stage: string,
): Promise<void> {
  await appendEvent(repo, {
    type: "agent-exited",
    epicId,
    stage,
    payload: { exitCode: 0 },
  });
}

/** Build a minimal valid MarkerData object. */
function makeMarker(overrides: Partial<MarkerData> = {}): MarkerData {
  return {
    version: "1",
    bead_id: "test-bead",
    status: "success",
    stage: "development",
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
    currentStage: "development",
    labels: ["pipeline:development"],
    title: "Test Epic",
    ...overrides,
  };
}

describe("marker-driven-routing reconciler rule (beads_web-xfc)", () => {
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

  // Test 1 — AC 6: agent-exited event + marker next_agent=architect
  //                -> architect dispatched
  test("agent-exited with marker next_agent=architect dispatches architect", async () => {
    const repo = await makeRepo();
    await seedAgentExitedEvent(repo, "factory-core-lmxb", "plan-review");

    const marker = makeMarker({
      epic_id: "factory-core-lmxb",
      status: "blocked",
      stage: "plan-review",
      next_agent: "architect",
    });

    const rule = buildMarkerDrivenRoutingRule({
      readMarker: async () => marker,
      readEpicSnapshot: async () =>
        makeSnapshot({
          currentStage: "plan-review",
          labels: ["pipeline:plan-review", "ship-type:internal"],
          title: "LMXB Test Epic",
        }),
      repoPath: repo,
      actionUrl: "http://localhost:3000/api/fleet/action",
    });

    // Build events matching what the reconciler would pass.
    const events: PipelineEvent[] = [
      {
        type: "agent-exited",
        epicId: "factory-core-lmxb",
        stage: "plan-review",
        timestamp: new Date(Date.now() - 5 * 60_000).toISOString(),
        payload: { exitCode: 0 },
      },
    ];

    // matches() should find one match
    const matches = await rule.matches(events, new Date());
    expect(matches).toHaveLength(1);
    expect(matches[0].idempotencyKey).toBe(
      "marker-driven-routing::factory-core-lmxb::plan-review",
    );
    expect(matches[0].epicId).toBe("factory-core-lmxb");

    // act() should dispatch architect
    await rule.act(matches[0]);

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe(
      "http://localhost:3000/api/fleet/action",
    );
    const body = fetchCalls[0].body as Record<string, unknown>;
    expect(body.action).toBe("run-architect");
    expect(body.epicId).toBe("factory-core-lmxb");
  });

  // Test 2 — AC 6: agent-exited + marker status=success, no next_agent
  //                -> reconciler skips (no routing intent)
  test("agent-exited with marker status=success and no next_agent produces zero matches", async () => {
    const marker = makeMarker({
      epic_id: "factory-core-xxxx",
      status: "success",
      stage: "plan-review",
      // next_agent intentionally absent
    });

    const rule = buildMarkerDrivenRoutingRule({
      readMarker: async () => marker,
      readEpicSnapshot: async () => makeSnapshot(),
      repoPath: "/tmp/xfc-test-noop",
      actionUrl: "http://localhost:3000/api/fleet/action",
    });

    const events: PipelineEvent[] = [
      {
        type: "agent-exited",
        epicId: "factory-core-xxxx",
        stage: "plan-review",
        timestamp: new Date(Date.now() - 5 * 60_000).toISOString(),
        payload: { exitCode: 0 },
      },
    ];

    const matches = await rule.matches(events, new Date());
    expect(matches).toHaveLength(0);
  });

  // Test 3 — AC 7: idempotency — duplicate agent-exited events for the same
  //                (epicId, stage) produce ONE match (deduped by Map).
  //                The reconciler loop's event-log idempotency check handles
  //                the "already dispatched" case; xfc just returns the same
  //                idempotency key for the reconciler to dedupe.
  test("duplicate agent-exited events for same (epicId, stage) produce single match", async () => {
    const marker = makeMarker({
      epic_id: "factory-core-yyyy",
      status: "success",
      stage: "architecture",
      next_agent: "planner",
    });

    const rule = buildMarkerDrivenRoutingRule({
      readMarker: async () => marker,
      readEpicSnapshot: async () => makeSnapshot(),
      repoPath: "/tmp/xfc-test-idem",
      actionUrl: "http://localhost:3000/api/fleet/action",
    });

    const events: PipelineEvent[] = [
      {
        type: "agent-exited",
        epicId: "factory-core-yyyy",
        stage: "architecture",
        timestamp: new Date(Date.now() - 10 * 60_000).toISOString(),
        payload: { exitCode: 0 },
      },
      {
        type: "agent-exited",
        epicId: "factory-core-yyyy",
        stage: "architecture",
        timestamp: new Date(Date.now() - 5 * 60_000).toISOString(),
        payload: { exitCode: 0 },
      },
    ];

    const matches = await rule.matches(events, new Date());
    expect(matches).toHaveLength(1);
    expect(matches[0].idempotencyKey).toBe(
      "marker-driven-routing::factory-core-yyyy::architecture",
    );
  });

  // Test 4 — edge case: missing marker file (readMarker returns null)
  test("agent-exited with missing marker produces zero matches", async () => {
    const rule = buildMarkerDrivenRoutingRule({
      readMarker: async () => null, // marker missing
      readEpicSnapshot: async () => makeSnapshot(),
      repoPath: "/tmp/xfc-test-missing",
      actionUrl: "http://localhost:3000/api/fleet/action",
    });

    const events: PipelineEvent[] = [
      {
        type: "agent-exited",
        epicId: "factory-core-zzzz",
        stage: "qa",
        timestamp: new Date(Date.now() - 5 * 60_000).toISOString(),
        payload: { exitCode: 0 },
      },
    ];

    const matches = await rule.matches(events, new Date());
    expect(matches).toHaveLength(0);
  });

  // Test 5 — edge case: malformed marker JSON (readMarker returns null per 28k
  //          error-handling). Functionally identical to test 4 from xfc's
  //          perspective — readMarker abstracts the parse failure away.
  test("agent-exited with malformed marker (readMarker null) produces zero matches", async () => {
    const rule = buildMarkerDrivenRoutingRule({
      readMarker: async () => null, // malformed -> readMarker returns null
      readEpicSnapshot: async () => makeSnapshot(),
      repoPath: "/tmp/xfc-test-malformed",
      actionUrl: "http://localhost:3000/api/fleet/action",
    });

    const events: PipelineEvent[] = [
      {
        type: "agent-exited",
        epicId: "factory-core-aaaa",
        stage: "development",
        timestamp: new Date(Date.now() - 5 * 60_000).toISOString(),
        payload: { exitCode: 0 },
      },
    ];

    const matches = await rule.matches(events, new Date());
    expect(matches).toHaveLength(0);
  });

  // Test 6 — belt-and-suspenders: agent:running label present on the epic
  //          snapshot. xfc does NOT check for agent:running — agent-exited
  //          events by definition mean the agent has exited. Stale
  //          agent:running labels are liveness-check's job. xfc dispatches
  //          regardless.
  //
  // ehp.13 cross-bead alignment (2026-05-06): this test dispatches
  // send-for-qa, which after ehp.13's per-action predicate addition
  // requires a plan file at .beads/plans/<epicId>.md. Without a fixture,
  // PLAN_FILE_MISSING fires before dispatch. Adding a real plan file
  // fixture preserves the test's original intent (verify dispatch fires
  // despite agent:running label) without disabling the new precondition
  // protection. This is a 4-line fixture addition by ehp.13's builder,
  // documented as a deviation in beads_web-ehp.13's marker.
  test("agent-exited with agent:running label still dispatches (belt-and-suspenders)", async () => {
    const marker = makeMarker({
      epic_id: "factory-core-bbbb",
      status: "success",
      stage: "build-review",
      next_agent: "qa",
    });

    // ehp.13 fixture: plan file required by send-for-qa precondition.
    const repoPath = "/tmp/xfc-test-running";
    const planDir = path.join(repoPath, ".beads", "plans");
    await fs.mkdir(planDir, { recursive: true });
    await fs.writeFile(path.join(planDir, "factory-core-bbbb.md"), "# Plan\n");

    const rule = buildMarkerDrivenRoutingRule({
      readMarker: async () => marker,
      readEpicSnapshot: async () =>
        makeSnapshot({
          currentStage: "build-review",
          labels: [
            "pipeline:build-review",
            "ship-type:ios-app",
            "agent:running",
          ],
          title: "BBBB Test Epic",
        }),
      repoPath,
      actionUrl: "http://localhost:3000/api/fleet/action",
    });

    const events: PipelineEvent[] = [
      {
        type: "agent-exited",
        epicId: "factory-core-bbbb",
        stage: "build-review",
        timestamp: new Date(Date.now() - 5 * 60_000).toISOString(),
        payload: { exitCode: 0 },
      },
    ];

    // matches() should find one match (ignores agent:running)
    const matches = await rule.matches(events, new Date());
    expect(matches).toHaveLength(1);

    // act() should dispatch qa (not skip due to agent:running)
    await rule.act(matches[0]);

    expect(fetchCalls).toHaveLength(1);
    const body = fetchCalls[0].body as Record<string, unknown>;
    expect(body.action).toBe("send-for-qa");
    expect(body.epicId).toBe("factory-core-bbbb");
  });
});
