// =============================================================================
// Tests for beads_web-ehp.4 — marker-driven-routing × dispatch-preconditions
// integration (Wave 3).
//
// Load-bearing: AC #1 (BD_STATUS_DEFERRED) protects the 372-bead mass-defer.
// If the deferred-bead test does not refuse, the protection is gone — STOP
// and surface (per bead risk flag). Documented at the test boundary so any
// future regression is unambiguous.
//
// Coverage:
//   1. bd status=deferred (372-bead mass-defer scenario) → BD_STATUS_DEFERRED
//      refusal, no fetch fires, reconciler-action-refused event recorded.
//   2. Marker has next_agent=operator + blocker_class=spec-ambiguity →
//      OPERATOR_DECISION_PENDING refusal, no auto-progression.
//   3. Happy path — open bead + benign marker → existing dispatch fetch
//      fires unchanged AND reconciler-action-taken is recorded as today.
//   4. Route returns HTTP 412 → reconciler_dispatch_refused_at_route warn-
//      log + reconciler-action-refused event with ROUTE_REFUSED_412 code,
//      and act() returns WITHOUT throwing (architecture § Seam 5
//      defense-in-depth handling, distinguished from genuine HTTP failure).
//
// Mock pattern: jest.mock the published reader interfaces consumed by
// buildDispatchContext (bead-status-reader, marker-reader at the lib
// boundary, pipeline-labels). The rule's own opts.readMarker callback is
// independent — it returns the per-stage marker the rule's matches() and
// act() consume. Real bd / dolt end-to-end coverage lives in
// dispatch-preconditions.integration.test.ts (Wave-2 sibling); here we
// verify the WIRING is correct: refusals stop the fetch, happy path lets
// it through, 412 is treated as a refusal not a failure.
// =============================================================================

import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";

// ---- Mock reader modules at the import boundary ---------------------------
//
// buildDispatchContext consumes these. The mocks let the integration test
// drive the precondition library through the rule's act() without standing
// up a real bd repo. The dispatch-preconditions.integration.test.ts already
// covers the real-bd path end-to-end.
jest.mock("@/lib/bead-status-reader", () => {
  const actual = jest.requireActual("@/lib/bead-status-reader");
  return { ...actual, readBeadStatus: jest.fn() };
});
jest.mock("@/lib/marker-reader", () => {
  const actual = jest.requireActual("@/lib/marker-reader");
  return { ...actual, readMarker: jest.fn() };
});
jest.mock("@/lib/pipeline-labels", () => ({
  getEpicLabels: jest.fn(),
}));
// beads_web-vpu: agent-launcher mock so the wave-bead-listing readers used
// by buildDispatchContext can be driven per-test. Required for regression
// tests that exercise actionName="start-wave" / "review-wave" — the rule
// derives waveNumber and forwards it to buildDispatchContext, which calls
// these readers via safeListOpenWaveBeads / safeListAllStatusWaveBeads.
jest.mock("@/lib/agent-launcher", () => {
  const actual = jest.requireActual("@/lib/agent-launcher");
  return {
    ...actual,
    listOpenWaveBeads: jest.fn(),
    listAllStatusWaveBeads: jest.fn(),
  };
});

import { Reconciler } from "@/lib/reconciler";
import { appendEvent, readEvents } from "@/lib/event-log";
import {
  buildMarkerDrivenRoutingRule,
  MARKER_DRIVEN_ROUTING_RULE_NAME,
  type MarkerDrivenRoutingEpicSnapshot,
} from "@/lib/reconciler-rules/marker-driven-routing";
import type { MarkerData } from "@/lib/marker-reader";
import type { BeadSnapshot } from "@/lib/bead-status-reader";
import { readBeadStatus } from "@/lib/bead-status-reader";
import { readMarker } from "@/lib/marker-reader";
import { getEpicLabels } from "@/lib/pipeline-labels";
import { listOpenWaveBeads, listAllStatusWaveBeads } from "@/lib/agent-launcher";
import type { PipelineEvent } from "@/lib/event-log";

const mockReadBeadStatus = readBeadStatus as jest.MockedFunction<
  typeof readBeadStatus
>;
const mockReadMarker = readMarker as jest.MockedFunction<typeof readMarker>;
const mockGetEpicLabels = getEpicLabels as jest.MockedFunction<
  typeof getEpicLabels
>;
const mockListOpenWaveBeads = listOpenWaveBeads as jest.MockedFunction<
  typeof listOpenWaveBeads
>;
const mockListAllStatusWaveBeads = listAllStatusWaveBeads as jest.MockedFunction<
  typeof listAllStatusWaveBeads
>;

// ---- Helpers --------------------------------------------------------------

async function makeRepo(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "ehp4-test-"));
}

/**
 * Create a stub plan file at the conventional location so the start-wave /
 * approve-plan PLAN_FILE_EXISTS predicate is satisfied. Required for any
 * test that drives an action subject to PLAN_FILE_MISSING (start-wave,
 * approve-plan, send-for-development). Returns the plan-file path.
 */
async function writePlanFile(repo: string, epicId: string): Promise<string> {
  const planDir = path.join(repo, ".beads", "plans");
  await fs.mkdir(planDir, { recursive: true });
  const planPath = path.join(planDir, `${epicId}.md`);
  await fs.writeFile(planPath, `# Plan for ${epicId}\n\nstub\n`);
  return planPath;
}

function makeMarker(overrides: Partial<MarkerData> = {}): MarkerData {
  return {
    version: "1",
    epic_id: "factory-core-test",
    status: "success",
    stage: "plan-review",
    started_at: "2026-05-06T00:00:00Z",
    exited_at: "2026-05-06T00:01:00Z",
    ...overrides,
  };
}

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

function makeBead(overrides: Partial<BeadSnapshot> = {}): BeadSnapshot {
  return {
    id: "factory-core-test",
    status: "open",
    labels: [],
    type: "task",
    pipelineStage: null,
    currentQaRound: null,
    currentWave: null,
    hasAgentRunning: false,
    hasReviewNeedsHuman: false,
    ...overrides,
  };
}

// ---- Tests ----------------------------------------------------------------

describe("marker-driven-routing × dispatch-preconditions integration (beads_web-ehp.4)", () => {
  let fetchMock: jest.SpyInstance;
  let fetchCalls: Array<{ url: string; body: unknown }>;
  let fetchResponseFactory: () => Response;

  beforeEach(() => {
    fetchCalls = [];
    fetchResponseFactory = () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    fetchMock = jest
      .spyOn(global, "fetch")
      .mockImplementation(
        async (url: RequestInfo | URL, init?: RequestInit) => {
          const body =
            init?.body && typeof init.body === "string"
              ? JSON.parse(init.body)
              : undefined;
          fetchCalls.push({ url: String(url), body });
          return fetchResponseFactory();
        },
      );

    // Reset module-level mocks each test so prior tests don't bleed in.
    mockReadBeadStatus.mockReset();
    mockReadMarker.mockReset();
    mockGetEpicLabels.mockReset();
    mockListOpenWaveBeads.mockReset();
    mockListAllStatusWaveBeads.mockReset();
    // Sane defaults — explicit per-test overrides supersede.
    mockReadMarker.mockResolvedValue(null);
    mockGetEpicLabels.mockResolvedValue([]);
    mockListOpenWaveBeads.mockResolvedValue([]);
    mockListAllStatusWaveBeads.mockResolvedValue([]);
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  // ==========================================================================
  // AC #1 (LOAD-BEARING) — bd status=deferred refuses with BD_STATUS_DEFERRED
  // ==========================================================================
  // The 372-bead mass-defer is operationally protected by THIS path. If this
  // test does not pass, the protection is GONE — STOP and surface (do not
  // document degradation). Per ehp.4 risk flag.
  // --------------------------------------------------------------------------
  test("LOAD-BEARING: bd status=deferred refuses with BD_STATUS_DEFERRED — no dispatch, refusal event recorded (372-bead mass-defer protection)", async () => {
    const repo = await makeRepo();
    const epicId = "factory-core-deferred";
    const stage = "plan-review";

    // The per-stage marker the rule consumes via opts.readMarker — has
    // routing intent so the rule's act() reaches the precondition gate.
    const stageMarker = makeMarker({
      epic_id: epicId,
      status: "blocked",
      stage,
      next_agent: "architect",
    });

    // The bead-status reader returns a deferred snapshot — Class A.5
    // BD_STATUS_DEFERRED predicate fires.
    mockReadBeadStatus.mockResolvedValue(
      makeBead({ id: epicId, status: "deferred" }),
    );
    // No per-bead marker (the rule's own per-stage marker is fed via
    // opts.readMarker, separate from this lib-level reader).
    mockReadMarker.mockResolvedValue(null);
    mockGetEpicLabels.mockResolvedValue(["pipeline:plan-review"]);

    const rule = buildMarkerDrivenRoutingRule({
      readMarker: async () => stageMarker,
      readEpicSnapshot: async () =>
        makeSnapshot({
          currentStage: stage,
          labels: ["pipeline:plan-review", "ship-type:internal"],
          title: "Deferred Bead Test",
        }),
      repoPath: repo,
      actionUrl: "http://localhost:3000/api/fleet/action",
    });

    const events: PipelineEvent[] = [
      {
        type: "agent-exited",
        epicId,
        stage,
        timestamp: new Date(Date.now() - 5 * 60_000).toISOString(),
        payload: { exitCode: 0 },
      },
    ];

    const matches = await rule.matches(events, new Date());
    expect(matches).toHaveLength(1);

    await rule.act(matches[0]);

    // Load-bearing assertion — NO fetch was made.
    expect(fetchCalls).toHaveLength(0);

    // Refusal event was written to the event log.
    const written = await readEvents(repo, {
      type: "reconciler-action-refused",
    });
    expect(written).toHaveLength(1);
    const refusal = written[0];
    expect(refusal.epicId).toBe(epicId);
    expect(refusal.stage).toBe(stage);
    const payload = refusal.payload as Record<string, unknown>;
    expect(payload.ruleName).toBe(MARKER_DRIVEN_ROUTING_RULE_NAME);
    expect(payload.action).toBe("run-architect");
    expect(payload.refusalCode).toBe("BD_STATUS_DEFERRED");
    expect(payload.failedCheck).toBe("bd-status-not-deferred");
    expect(typeof payload.reason).toBe("string");
    expect(payload.reason as string).toContain("deferred");
  });

  // ==========================================================================
  // AC #2 — Marker next_agent=operator + blocker_class=spec-ambiguity
  //         → OPERATOR_DECISION_PENDING refusal, no auto-progression.
  // ==========================================================================
  test("marker.next_agent=operator + blocker_class=spec-ambiguity refuses with OPERATOR_DECISION_PENDING (operator visibility preserved)", async () => {
    const repo = await makeRepo();
    const epicId = "factory-core-operator-pending";
    // Use stage="coherence" so interpretMarkerForRouting preserves the
    // operator routing (Precedence 1.5 escape hatch). The action becomes
    // "send-for-review", which is a registered universal action.
    const stage = "coherence";

    const stageMarker = makeMarker({
      epic_id: epicId,
      status: "needs-decision",
      stage,
      next_agent: "operator",
      blocker_class: "spec-ambiguity",
    });

    // Open bead — A.5 predicates pass.
    mockReadBeadStatus.mockResolvedValue(makeBead({ id: epicId, status: "open" }));
    // Per-bead marker reader (consumed by buildDispatchContext) returns the
    // SAME shape so the OPERATOR_DECISION_PENDING predicate (which checks
    // the per-bead marker) fires.
    mockReadMarker.mockResolvedValue({
      version: "1",
      bead_id: epicId,
      status: "needs-decision",
      stage: "coherence",
      started_at: "2026-05-06T00:00:00Z",
      exited_at: "2026-05-06T00:01:00Z",
      next_agent: "operator",
      blocker_class: "spec-ambiguity",
    });
    mockGetEpicLabels.mockResolvedValue(["pipeline:coherence"]);

    const rule = buildMarkerDrivenRoutingRule({
      readMarker: async () => stageMarker,
      readEpicSnapshot: async () =>
        makeSnapshot({
          currentStage: stage,
          labels: ["pipeline:coherence"],
          title: "Operator Pending Test",
        }),
      repoPath: repo,
      actionUrl: "http://localhost:3000/api/fleet/action",
    });

    const events: PipelineEvent[] = [
      {
        type: "agent-exited",
        epicId,
        stage,
        timestamp: new Date(Date.now() - 2 * 60_000).toISOString(),
        payload: { exitCode: 0 },
      },
    ];

    const matches = await rule.matches(events, new Date());
    expect(matches).toHaveLength(1);

    await rule.act(matches[0]);

    expect(fetchCalls).toHaveLength(0);

    const written = await readEvents(repo, {
      type: "reconciler-action-refused",
    });
    expect(written).toHaveLength(1);
    const payload = written[0].payload as Record<string, unknown>;
    expect(payload.refusalCode).toBe("OPERATOR_DECISION_PENDING");
    expect(payload.failedCheck).toBe("operator-decision-not-pending");
    expect(payload.action).toBe("send-for-review");
  });

  // ==========================================================================
  // AC #3 — Happy path: existing dispatch fetch fires unchanged AND existing
  //         reconciler-action-taken event is recorded as today.
  // ==========================================================================
  test("happy path: open bead + benign marker → fetch fires AND reconciler-action-taken event recorded (no behaviour drift)", async () => {
    const repo = await makeRepo();
    const epicId = "factory-core-happy";
    const stage = "plan-review";

    const stageMarker = makeMarker({
      epic_id: epicId,
      status: "blocked",
      stage,
      next_agent: "architect",
    });

    mockReadBeadStatus.mockResolvedValue(
      makeBead({ id: epicId, status: "open" }),
    );
    mockReadMarker.mockResolvedValue(null); // no per-bead marker → Class C passes
    mockGetEpicLabels.mockResolvedValue(["pipeline:plan-review"]);

    const rule = buildMarkerDrivenRoutingRule({
      readMarker: async () => stageMarker,
      readEpicSnapshot: async () =>
        makeSnapshot({
          currentStage: stage,
          labels: ["pipeline:plan-review", "ship-type:internal"],
          title: "Happy Path Test",
        }),
      repoPath: repo,
      actionUrl: "http://localhost:3000/api/fleet/action",
    });

    // Seed an agent-exited event so matches() finds the marker.
    await appendEvent(repo, {
      type: "agent-exited",
      epicId,
      stage,
      payload: { exitCode: 0 },
    });

    const reconciler = new Reconciler({
      repoPath: repo,
      tickIntervalMs: 999_999,
      maxConcurrentDispatches: 10,
    });
    reconciler.registerRule(rule);

    await reconciler.tick(new Date());

    // Existing dispatch fetch fired unchanged.
    expect(fetchCalls).toHaveLength(1);
    const body = fetchCalls[0].body as Record<string, unknown>;
    expect(body.action).toBe("run-architect");
    expect(body.epicId).toBe(epicId);

    // Existing reconciler-action-taken event was recorded.
    const taken = await readEvents(repo, { type: "reconciler-action-taken" });
    expect(taken).toHaveLength(1);
    const takenPayload = taken[0].payload as Record<string, unknown>;
    expect(takenPayload.ruleName).toBe(MARKER_DRIVEN_ROUTING_RULE_NAME);
    expect(takenPayload.idempotencyKey).toBe(
      `${MARKER_DRIVEN_ROUTING_RULE_NAME}::${epicId}::${stage}`,
    );

    // No refusal event for the happy path.
    const refusals = await readEvents(repo, {
      type: "reconciler-action-refused",
    });
    expect(refusals).toHaveLength(0);

    reconciler.stop();
  });

  // ==========================================================================
  // AC #4 — Route returns HTTP 412 → log reconciler_dispatch_refused_at_route
  //         event AND return without throwing (architecture § Seam 5).
  // ==========================================================================
  test("route returns HTTP 412 → reconciler-action-refused event with ROUTE_REFUSED_412 code, no throw (defense-in-depth Seam 5)", async () => {
    const repo = await makeRepo();
    const epicId = "factory-core-412";
    const stage = "plan-review";

    // Configure fetch to return 412 with a precondition body. The route's
    // own precondition layer would emit this on a race window where the
    // rule's check passed but the route's check (run a few ms later)
    // caught fresh state.
    fetchResponseFactory = () =>
      new Response(
        JSON.stringify({
          error: "precondition_failed",
          refusalCode: "BD_STATUS_DEFERRED",
          reason: "Bead became deferred between rule check and route check",
        }),
        {
          status: 412,
          headers: { "Content-Type": "application/json" },
        },
      );

    const stageMarker = makeMarker({
      epic_id: epicId,
      status: "blocked",
      stage,
      next_agent: "architect",
    });

    // Rule-side precondition passes (open bead, no marker, no labels).
    // The route is the one refusing — defense-in-depth catch.
    mockReadBeadStatus.mockResolvedValue(
      makeBead({ id: epicId, status: "open" }),
    );
    mockReadMarker.mockResolvedValue(null);
    mockGetEpicLabels.mockResolvedValue(["pipeline:plan-review"]);

    const rule = buildMarkerDrivenRoutingRule({
      readMarker: async () => stageMarker,
      readEpicSnapshot: async () =>
        makeSnapshot({
          currentStage: stage,
          labels: ["pipeline:plan-review"],
          title: "412 Defense-in-Depth Test",
        }),
      repoPath: repo,
      actionUrl: "http://localhost:3000/api/fleet/action",
    });

    const events: PipelineEvent[] = [
      {
        type: "agent-exited",
        epicId,
        stage,
        timestamp: new Date(Date.now() - 1 * 60_000).toISOString(),
        payload: { exitCode: 0 },
      },
    ];

    const matches = await rule.matches(events, new Date());
    expect(matches).toHaveLength(1);

    // Must NOT throw — 412 is a refusal, not a failure. Under beads_web-3e6
    // the rule returns RuleActResult { refused: true, refusalCode } instead
    // of undefined so the reconciler skips the action-taken append.
    await expect(rule.act(matches[0])).resolves.toEqual({
      refused: true,
      refusalCode: "ROUTE_REFUSED_412",
    });

    // Fetch DID fire (the route is the gate that refused).
    expect(fetchCalls).toHaveLength(1);

    // Refusal event recorded with the route-side discriminator.
    const refusals = await readEvents(repo, {
      type: "reconciler-action-refused",
    });
    expect(refusals).toHaveLength(1);
    const payload = refusals[0].payload as Record<string, unknown>;
    expect(payload.ruleName).toBe(MARKER_DRIVEN_ROUTING_RULE_NAME);
    expect(payload.action).toBe("run-architect");
    expect(payload.refusalCode).toBe("ROUTE_REFUSED_412");
    expect(payload.failedCheck).toBe("route-side-precondition");
    expect(typeof payload.reason).toBe("string");
  });

  // ==========================================================================
  // beads_web-vpu — start-wave dispatch passes waveNumber to buildDispatchContext
  // ==========================================================================
  // Empirical reproducer: factory-core-855c (C2 attempt-7 T2) at 2026-05-08
  // 21:29 BST. Marker-driven-routing rule retried start-wave indefinitely,
  // every retry refused NO_WAVE_BEADS even though the wave-1 child existed.
  // Root cause: buildDispatchContext called without waveNumber → openWaveBeadIds
  // short-circuits to []. Fix: derive waveNumber from epic labels (wave:N) or
  // default 1 for first start-wave; pass to buildDispatchContext AND POST body.
  // --------------------------------------------------------------------------
  test("vpu AC2: start-wave dispatch with open wave-1 child → no NO_WAVE_BEADS refusal, fetch fires with waveNumber=1", async () => {
    const repo = await makeRepo();
    const epicId = "factory-core-vpu-test";
    await writePlanFile(repo, epicId);
    // The marker that fires start-wave is the test-spec exit marker — its
    // stage is "test-spec" and next_agent="builder" routes to start-wave.
    const stage = "test-spec";

    const stageMarker = makeMarker({
      epic_id: epicId,
      status: "success",
      stage,
      next_agent: "builder",
    });

    // Open epic with the wave-1 child still open. No wave:N on the epic
    // itself — first start-wave should default to wave=1.
    mockReadBeadStatus.mockResolvedValue(
      makeBead({ id: epicId, status: "open" }),
    );
    mockReadMarker.mockResolvedValue(null);
    mockGetEpicLabels.mockResolvedValue([
      "pipeline:test-spec",
      "ship-type:internal",
    ]);
    // Wave-1 children exist: precondition gate must NOT refuse.
    mockListOpenWaveBeads.mockResolvedValue([`${epicId}.1`]);
    mockListAllStatusWaveBeads.mockResolvedValue([`${epicId}.1`]);

    const rule = buildMarkerDrivenRoutingRule({
      readMarker: async () => stageMarker,
      readEpicSnapshot: async () =>
        makeSnapshot({
          currentStage: stage,
          labels: ["pipeline:test-spec", "ship-type:internal"],
          title: "vpu Regression Test",
        }),
      repoPath: repo,
      actionUrl: "http://localhost:3000/api/fleet/action",
    });

    const events: PipelineEvent[] = [
      {
        type: "agent-exited",
        epicId,
        stage,
        timestamp: new Date(Date.now() - 1 * 60_000).toISOString(),
        payload: { exitCode: 0 },
      },
    ];

    const matches = await rule.matches(events, new Date());
    expect(matches).toHaveLength(1);

    await rule.act(matches[0]);

    // No NO_WAVE_BEADS refusal — gate passed.
    const refusals = await readEvents(repo, {
      type: "reconciler-action-refused",
    });
    expect(refusals).toHaveLength(0);

    // Fetch DID fire with waveNumber=1 in the POST body.
    expect(fetchCalls).toHaveLength(1);
    const body = fetchCalls[0].body as Record<string, unknown>;
    expect(body.action).toBe("start-wave");
    expect(body.epicId).toBe(epicId);
    expect(body.waveNumber).toBe(1);

    // listOpenWaveBeads was called with waveNumber=1.
    expect(mockListOpenWaveBeads).toHaveBeenCalledWith(
      epicId,
      1,
      expect.any(String),
    );
  });

  test("vpu AC1: review-wave dispatch reads wave:N from epic labels (wave:2)", async () => {
    const repo = await makeRepo();
    const epicId = "factory-core-vpu-review";
    await writePlanFile(repo, epicId);
    const stage = "review:wave-2";

    const stageMarker = makeMarker({
      epic_id: epicId,
      status: "success",
      stage,
      next_agent: "reviewer",
    });

    mockReadBeadStatus.mockResolvedValue(
      makeBead({ id: epicId, status: "open" }),
    );
    mockReadMarker.mockResolvedValue(null);
    mockGetEpicLabels.mockResolvedValue([
      `pipeline:${stage}`,
      "ship-type:internal",
      "wave:2",
    ]);
    mockListOpenWaveBeads.mockResolvedValue([`${epicId}.2`]);
    mockListAllStatusWaveBeads.mockResolvedValue([`${epicId}.2`]);

    const rule = buildMarkerDrivenRoutingRule({
      readMarker: async () => stageMarker,
      readEpicSnapshot: async () =>
        makeSnapshot({
          currentStage: stage,
          labels: [`pipeline:${stage}`, "ship-type:internal", "wave:2"],
          title: "vpu Review Wave Test",
        }),
      repoPath: repo,
      actionUrl: "http://localhost:3000/api/fleet/action",
    });

    const events: PipelineEvent[] = [
      {
        type: "agent-exited",
        epicId,
        stage,
        timestamp: new Date(Date.now() - 1 * 60_000).toISOString(),
        payload: { exitCode: 0 },
      },
    ];

    const matches = await rule.matches(events, new Date());
    expect(matches).toHaveLength(1);

    await rule.act(matches[0]);

    // listOpenWaveBeads was called with waveNumber=2 (read from wave:2 label).
    expect(mockListOpenWaveBeads).toHaveBeenCalledWith(
      epicId,
      2,
      expect.any(String),
    );
    // Fetch fired with waveNumber=2.
    expect(fetchCalls).toHaveLength(1);
    const body = fetchCalls[0].body as Record<string, unknown>;
    expect(body.action).toBe("review-wave");
    expect(body.waveNumber).toBe(2);
  });

  test("vpu AC3: start-wave with NO open wave-N beads still refuses NO_WAVE_BEADS (legitimate refusal preserved)", async () => {
    const repo = await makeRepo();
    const epicId = "factory-core-vpu-empty";
    await writePlanFile(repo, epicId);
    const stage = "test-spec";

    const stageMarker = makeMarker({
      epic_id: epicId,
      status: "success",
      stage,
      next_agent: "builder",
    });

    mockReadBeadStatus.mockResolvedValue(
      makeBead({ id: epicId, status: "open" }),
    );
    mockReadMarker.mockResolvedValue(null);
    mockGetEpicLabels.mockResolvedValue([
      "pipeline:test-spec",
      "ship-type:internal",
    ]);
    // No wave-1 children exist — legitimate NO_WAVE_BEADS case.
    mockListOpenWaveBeads.mockResolvedValue([]);
    mockListAllStatusWaveBeads.mockResolvedValue([]);

    const rule = buildMarkerDrivenRoutingRule({
      readMarker: async () => stageMarker,
      readEpicSnapshot: async () =>
        makeSnapshot({
          currentStage: stage,
          labels: ["pipeline:test-spec", "ship-type:internal"],
          title: "vpu Empty Wave Test",
        }),
      repoPath: repo,
      actionUrl: "http://localhost:3000/api/fleet/action",
    });

    const events: PipelineEvent[] = [
      {
        type: "agent-exited",
        epicId,
        stage,
        timestamp: new Date(Date.now() - 1 * 60_000).toISOString(),
        payload: { exitCode: 0 },
      },
    ];

    const matches = await rule.matches(events, new Date());
    expect(matches).toHaveLength(1);

    await rule.act(matches[0]);

    // No fetch — refused at gate.
    expect(fetchCalls).toHaveLength(0);

    // Refusal event recorded with NO_WAVE_BEADS.
    const refusals = await readEvents(repo, {
      type: "reconciler-action-refused",
    });
    expect(refusals).toHaveLength(1);
    const payload = refusals[0].payload as Record<string, unknown>;
    expect(payload.refusalCode).toBe("NO_WAVE_BEADS");
    expect(payload.action).toBe("start-wave");
  });

  test("vpu: non-wave action (run-architect) still passes waveNumber=undefined (no regression)", async () => {
    const repo = await makeRepo();
    const epicId = "factory-core-vpu-non-wave";
    const stage = "plan-review";

    const stageMarker = makeMarker({
      epic_id: epicId,
      status: "blocked",
      stage,
      next_agent: "architect",
    });

    mockReadBeadStatus.mockResolvedValue(
      makeBead({ id: epicId, status: "open" }),
    );
    mockReadMarker.mockResolvedValue(null);
    mockGetEpicLabels.mockResolvedValue(["pipeline:plan-review"]);

    const rule = buildMarkerDrivenRoutingRule({
      readMarker: async () => stageMarker,
      readEpicSnapshot: async () =>
        makeSnapshot({
          currentStage: stage,
          labels: ["pipeline:plan-review"],
          title: "vpu Non-Wave Action Test",
        }),
      repoPath: repo,
      actionUrl: "http://localhost:3000/api/fleet/action",
    });

    const events: PipelineEvent[] = [
      {
        type: "agent-exited",
        epicId,
        stage,
        timestamp: new Date(Date.now() - 1 * 60_000).toISOString(),
        payload: { exitCode: 0 },
      },
    ];

    const matches = await rule.matches(events, new Date());
    expect(matches).toHaveLength(1);

    await rule.act(matches[0]);

    // Fetch fired without waveNumber in the body.
    expect(fetchCalls).toHaveLength(1);
    const body = fetchCalls[0].body as Record<string, unknown>;
    expect(body.action).toBe("run-architect");
    expect(body).not.toHaveProperty("waveNumber");

    // listOpenWaveBeads was NOT called (action is not start-wave/review-wave;
    // dispatch-preconditions short-circuits when waveNumber is undefined).
    expect(mockListOpenWaveBeads).not.toHaveBeenCalled();
  });
});
