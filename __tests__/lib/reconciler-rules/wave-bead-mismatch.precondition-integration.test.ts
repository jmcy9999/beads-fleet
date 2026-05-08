// =============================================================================
// Tests for beads_web-ehp.6 — wave-bead-mismatch × dispatch-preconditions
// integration (Wave 3).
//
// Load-bearing: AC #1 (NO_WAVE_BEADS) closes the niii phantom-wave-4
// redispatch loop (28+ marker churn). The refusal MUST land BEFORE any
// label mutation AND BEFORE the dispatch fetch. This file exercises that
// invariant explicitly: the load-bearing assertion is "labels were not
// mutated on refusal" — addLabelsToEpic / removeLabelsFromEpic are mocked
// to fail-the-test-if-called.
//
// Coverage:
//   1. niii phantom-wave-4 reproduction (epic at wave:4, no open wave:4
//      beads — listOpenWaveBeads returns []) → refusal with NO_WAVE_BEADS,
//      NO label mutation, NO dispatch fetch fires, reconciler-action-
//      refused event recorded.
//   2. Happy path (mismatch genuinely needs reconciling AND open wave
//      beads exist for the corrected wave) → existing dispatch behaviour
//      is unchanged (run-coherence-agent fetch fires; no refusal event).
//   3. Route returns HTTP 412 → reconciler-action-refused event with
//      ROUTE_REFUSED_412 code, act() returns WITHOUT throwing
//      (architecture § Seam 5 defense-in-depth handling).
//
// Mock pattern: mirrors marker-driven-routing.precondition-integration.
// test.ts (ehp.4 sibling). The lib-level reader interfaces consumed by
// buildDispatchContext are mocked at the import boundary; the rule's own
// readEpicSnapshot callback is independent.
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
// pipeline-labels: getEpicLabels is the precondition reader; addLabelsToEpic
// / removeLabelsFromEpic are the LOAD-BEARING "must NOT be called" mocks
// — the ehp.6 risk flag requires the refusal to leave labels untouched.
const mockAddLabels = jest.fn();
const mockRemoveLabels = jest.fn();
jest.mock("@/lib/pipeline-labels", () => ({
  addLabelsToEpic: (...args: unknown[]) => mockAddLabels(...args),
  removeLabelsFromEpic: (...args: unknown[]) => mockRemoveLabels(...args),
  getEpicLabels: jest.fn(),
}));
// listOpenWaveBeads feeds DispatchContext.openWaveBeadIds; the wave-beads
// predicate fires when this returns []. Per-scenario overrides drive the
// NO_WAVE_BEADS refusal vs happy-path branches.
jest.mock("@/lib/agent-launcher", () => {
  const actual = jest.requireActual("@/lib/agent-launcher");
  return { ...actual, listOpenWaveBeads: jest.fn() };
});

import { readEvents } from "@/lib/event-log";
import {
  buildWaveBeadMismatchRule,
  WAVE_BEAD_MISMATCH_RULE_NAME,
  type EpicSnapshot,
} from "@/lib/reconciler-rules/wave-bead-mismatch";
import type { BeadSnapshot } from "@/lib/bead-status-reader";
import { readBeadStatus } from "@/lib/bead-status-reader";
import { readMarker } from "@/lib/marker-reader";
import { getEpicLabels } from "@/lib/pipeline-labels";
import { listOpenWaveBeads } from "@/lib/agent-launcher";
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

// ---- Helpers --------------------------------------------------------------

async function makeRepo(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "ehp6-test-"));
}

function makeSnapshot(overrides: Partial<EpicSnapshot> = {}): EpicSnapshot {
  return {
    currentStage: "qa",
    lowestOpenWave: 4,
    allWavesComplete: false,
    hasWaves: true,
    labels: ["pipeline:qa", "ship-type:ios-app", "wave:4"],
    title: "ehp6 test epic",
    ...overrides,
  };
}

function makeBead(overrides: Partial<BeadSnapshot> = {}): BeadSnapshot {
  return {
    id: "factory-core-test",
    status: "open",
    labels: [],
    type: "task",
    pipelineStage: "qa",
    currentQaRound: null,
    currentWave: 4,
    hasAgentRunning: false,
    hasReviewNeedsHuman: false,
    ...overrides,
  };
}

// ---- Tests ----------------------------------------------------------------

describe("wave-bead-mismatch × dispatch-preconditions integration (beads_web-ehp.6)", () => {
  let fetchMock: jest.SpyInstance;
  let fetchCalls: Array<{ url: string; body: Record<string, unknown> }>;
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
              ? (JSON.parse(init.body) as Record<string, unknown>)
              : ({} as Record<string, unknown>);
          fetchCalls.push({ url: String(url), body });
          return fetchResponseFactory();
        },
      );

    // Reset all module-level mocks each test so prior tests don't bleed in.
    mockReadBeadStatus.mockReset();
    mockReadMarker.mockReset();
    mockGetEpicLabels.mockReset();
    mockListOpenWaveBeads.mockReset();
    mockAddLabels.mockReset();
    mockRemoveLabels.mockReset();

    // Sane defaults — explicit per-test overrides supersede.
    mockReadMarker.mockResolvedValue(null);
    mockGetEpicLabels.mockResolvedValue([]);
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  // ==========================================================================
  // AC #1 (LOAD-BEARING) — niii phantom-wave-4 reproduction
  // ==========================================================================
  // Reproduces the niii (factory-core-niii) failure mode: epic carries
  // `wave:4` label and a `pipeline:qa` label, but `bd list --label wave:4
  // --status=open` returns []. Pre-ehp.6, the rule would fire `act()` and
  // dispatch a coherence escalation (or in the older commented-out variant,
  // roll labels back + dispatch start-wave) — both wasted on an epic with
  // no work to do. Post-ehp.6, PRECOND_WAVE_BEADS_EXIST refuses with
  // NO_WAVE_BEADS BEFORE either side effect lands.
  //
  // Load-bearing assertions per the ehp.6 risk flag:
  //   1. NO label mutation occurred (mockAddLabels / mockRemoveLabels
  //      never called) — proves the no-side-effect contract of refusal.
  //   2. NO dispatch fetch fired (fetchCalls empty) — proves the redispatch
  //      loop is closed.
  //   3. A reconciler-action-refused event landed with refusalCode=
  //      NO_WAVE_BEADS — proves the gate fired (vs. silent skip).
  // --------------------------------------------------------------------------
  test("LOAD-BEARING: phantom wave:4 (no open wave:4 beads) refuses with NO_WAVE_BEADS — labels NOT mutated, no dispatch, refusal event recorded (closes niii redispatch loop)", async () => {
    const repo = await makeRepo();
    const epicId = "factory-core-niii-repro";

    // The phantom-wave-4 condition: openWaveBeadIds is empty for wave 4.
    mockListOpenWaveBeads.mockResolvedValue([]);
    // Open bead — universal predicates pass; the wave-beads predicate is
    // the one that fires.
    mockReadBeadStatus.mockResolvedValue(
      makeBead({ id: epicId, status: "open", currentWave: 4 }),
    );
    mockGetEpicLabels.mockResolvedValue([
      "pipeline:qa",
      "wave:4",
      "ship-type:ios-app",
    ]);

    const initialLabels = ["pipeline:qa", "wave:4", "ship-type:ios-app"];
    const rule = buildWaveBeadMismatchRule({
      repoPath: repo,
      readEpicSnapshot: async () =>
        makeSnapshot({
          currentStage: "qa",
          lowestOpenWave: 4,
          labels: initialLabels,
          title: "niii phantom-wave-4 reproduction",
        }),
      actionUrl: "http://localhost:3000/api/fleet/action",
    });

    const events: PipelineEvent[] = [
      {
        type: "agent-exited",
        epicId,
        stage: "qa",
        timestamp: new Date(Date.now() - 5 * 60_000).toISOString(),
        payload: { exitCode: 0 },
      },
    ];

    const matches = await rule.matches(events, new Date());
    expect(matches).toHaveLength(1);

    await rule.act(matches[0]);

    // ==== Load-bearing assertion 1 — NO label mutation =====================
    // This is the distinguishing proof from the broken pre-fix behaviour.
    // Per the ehp.6 risk flag: "if the precondition check is placed AFTER
    // the rollback, the no-side-effect contract of refusal is defeated AND
    // this bead does not fix the niii phantom-wave-4 redispatch loop."
    expect(mockAddLabels).not.toHaveBeenCalled();
    expect(mockRemoveLabels).not.toHaveBeenCalled();

    // ==== Load-bearing assertion 2 — NO dispatch fetch =====================
    expect(fetchCalls).toHaveLength(0);

    // ==== Load-bearing assertion 3 — refusal event recorded ================
    const refusals = await readEvents(repo, {
      type: "reconciler-action-refused",
    });
    expect(refusals).toHaveLength(1);
    const refusal = refusals[0];
    expect(refusal.epicId).toBe(epicId);
    expect(refusal.stage).toBe("qa");
    const payload = refusal.payload as Record<string, unknown>;
    expect(payload.ruleName).toBe(WAVE_BEAD_MISMATCH_RULE_NAME);
    expect(payload.action).toBe("run-coherence-agent");
    expect(payload.refusalCode).toBe("NO_WAVE_BEADS");
    expect(payload.failedCheck).toBe("wave-beads-exist");
    expect(typeof payload.reason).toBe("string");
  });

  // ==========================================================================
  // AC #2 — Happy path: mismatch genuinely needs reconciling AND open wave
  //         beads exist for the corrected wave → existing dispatch fires
  //         unchanged (no behaviour drift from pre-ehp.6).
  // ==========================================================================
  test("happy path: open wave-N beads exist → existing run-coherence-agent dispatch fires unchanged AND no refusal event recorded", async () => {
    const repo = await makeRepo();
    const epicId = "factory-core-happy-mismatch";

    // Open wave beads exist — the wave-beads predicate passes.
    mockListOpenWaveBeads.mockResolvedValue([
      { id: "factory-core-happy-mismatch.5", title: "wave2 bead a", files: [] },
      { id: "factory-core-happy-mismatch.6", title: "wave2 bead b", files: [] },
    ]);
    mockReadBeadStatus.mockResolvedValue(
      makeBead({ id: epicId, status: "open", currentWave: 2 }),
    );
    mockGetEpicLabels.mockResolvedValue(["pipeline:qa", "wave:2"]);

    const rule = buildWaveBeadMismatchRule({
      repoPath: repo,
      readEpicSnapshot: async () =>
        makeSnapshot({
          currentStage: "qa",
          lowestOpenWave: 2,
          labels: ["pipeline:qa", "wave:2", "ship-type:ios-app"],
          title: "Happy Path Mismatch",
        }),
      actionUrl: "http://localhost:3000/api/fleet/action",
    });

    const events: PipelineEvent[] = [
      {
        type: "agent-exited",
        epicId,
        stage: "qa",
        timestamp: new Date(Date.now() - 5 * 60_000).toISOString(),
        payload: { exitCode: 0 },
      },
    ];

    const matches = await rule.matches(events, new Date());
    expect(matches).toHaveLength(1);

    await rule.act(matches[0]);

    // Dispatch fired unchanged.
    expect(fetchCalls).toHaveLength(1);
    const body = fetchCalls[0].body as {
      action: string;
      epicId: string;
      anomalyClass: string;
    };
    expect(body.action).toBe("run-coherence-agent");
    expect(body.epicId).toBe(epicId);
    expect(body.anomalyClass).toBe("wave-bead-mismatch");

    // No label mutation (the post-wlsr.16 cutover removed rule-side
    // mutations; happy path must preserve that contract).
    expect(mockAddLabels).not.toHaveBeenCalled();
    expect(mockRemoveLabels).not.toHaveBeenCalled();

    // No refusal event for the happy path.
    const refusals = await readEvents(repo, {
      type: "reconciler-action-refused",
    });
    expect(refusals).toHaveLength(0);
  });

  // ==========================================================================
  // AC #3 — Route returns HTTP 412 → log + return without throwing.
  // ==========================================================================
  // Architecture § Seam 5 defense-in-depth: the rule's precondition gate
  // and the route's precondition gate are both load-bearing. If the rule's
  // gate passed but the route's gate refuses (race window — bead state
  // changed between the two checks), the rule must treat 412 as a refusal
  // (NOT a failure: throwing would propagate to the reconciler tick handler
  // and dispatch a different recovery path). Mirror of marker-driven-
  // routing.ts's 412 handling (ehp.4).
  // --------------------------------------------------------------------------
  test("route returns HTTP 412 → reconciler-action-refused event with ROUTE_REFUSED_412 code, no throw (defense-in-depth Seam 5)", async () => {
    const repo = await makeRepo();
    const epicId = "factory-core-412-defense";

    // Rule-side gate passes — open wave beads exist.
    mockListOpenWaveBeads.mockResolvedValue([
      { id: "factory-core-412-defense.5", title: "wave2 bead", files: [] },
    ]);
    mockReadBeadStatus.mockResolvedValue(
      makeBead({ id: epicId, status: "open", currentWave: 2 }),
    );
    mockGetEpicLabels.mockResolvedValue(["pipeline:qa", "wave:2"]);

    // Configure fetch to return 412 with a precondition body (the route
    // caught fresh state the rule's check missed).
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

    const rule = buildWaveBeadMismatchRule({
      repoPath: repo,
      readEpicSnapshot: async () =>
        makeSnapshot({
          currentStage: "qa",
          lowestOpenWave: 2,
          labels: ["pipeline:qa", "wave:2"],
          title: "412 Defense-in-Depth Test",
        }),
      actionUrl: "http://localhost:3000/api/fleet/action",
    });

    const events: PipelineEvent[] = [
      {
        type: "agent-exited",
        epicId,
        stage: "qa",
        timestamp: new Date(Date.now() - 1 * 60_000).toISOString(),
        payload: { exitCode: 0 },
      },
    ];

    const matches = await rule.matches(events, new Date());
    expect(matches).toHaveLength(1);

    // Must NOT throw — 412 is a refusal, not a failure. Under beads_web-3e6
    // the rule returns RuleActResult { refused: true, refusalCode } so the
    // reconciler skips the action-taken append on refusal.
    await expect(rule.act(matches[0])).resolves.toEqual({
      refused: true,
      refusalCode: "ROUTE_REFUSED_412",
    });

    // Fetch DID fire (the route is the gate that refused).
    expect(fetchCalls).toHaveLength(1);

    // No label mutation.
    expect(mockAddLabels).not.toHaveBeenCalled();
    expect(mockRemoveLabels).not.toHaveBeenCalled();

    // Refusal event recorded with the route-side discriminator.
    const refusals = await readEvents(repo, {
      type: "reconciler-action-refused",
    });
    expect(refusals).toHaveLength(1);
    const payload = refusals[0].payload as Record<string, unknown>;
    expect(payload.ruleName).toBe(WAVE_BEAD_MISMATCH_RULE_NAME);
    expect(payload.action).toBe("run-coherence-agent");
    expect(payload.refusalCode).toBe("ROUTE_REFUSED_412");
    expect(payload.failedCheck).toBe("route-side-precondition");
    expect(typeof payload.reason).toBe("string");
  });
});
