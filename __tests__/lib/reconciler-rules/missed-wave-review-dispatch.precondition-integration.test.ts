// =============================================================================
// Tests for beads_web-ehp.7 — missed-wave-review-dispatch ×
// dispatch-preconditions integration (Wave 4).
//
// Load-bearing: AC #1 (PLAN_FILE_MISSING) and AC #2 (NO_WAVE_BEADS /
// ALL_WAVE_BEADS_CLOSED) close the niii reviewer-4-wave-4-redundant
// reproduction — the rule was missing dispatches because no review-wave
// could legitimately be dispatched (no plan file OR no open wave beads).
// The refusal MUST land BEFORE the dispatch fetch so the rule never
// pollutes the event log with a downstream coherence escalation that
// has no work to do.
//
// Coverage:
//   1. PLAN_FILE_MISSING (Class A) — review-wave dispatch but no plan file
//      at .beads/plans/<epic>.md → refusal with PLAN_FILE_MISSING. NO
//      dispatch fetch fires. reconciler-action-refused event recorded.
//   2. ALL_WAVE_BEADS_CLOSED / NO_WAVE_BEADS (Class A) — review-wave for
//      wave N where ALL wave:N beads are closed (review redundant, the
//      niii reviewer-4-wave-4-redundant reproduction) → refusal with
//      a code in {NO_WAVE_BEADS, ALL_WAVE_BEADS_CLOSED}. The library
//      cannot disambiguate the two states from openWaveBeadIds alone
//      per the v1 limitation noted at dispatch-preconditions.ts §
//      PRECOND_WAVE_BEADS_*; the test asserts membership in the canonical
//      enum subset (per beads_web-ehp.12 risk flag #3 + the architect
//      memo's risk flag for this bead).
//   3. Happy path — plan file exists AND open wave beads exist for the
//      current wave → existing run-coherence-agent dispatch fires
//      unchanged; no refusal event recorded.
//   4. Route returns HTTP 412 → reconciler-action-refused event with
//      ROUTE_REFUSED_412 code, act() returns WITHOUT throwing
//      (architecture § Seam 5 defense-in-depth handling).
//
// Mock pattern: mirrors wave-bead-mismatch.precondition-integration.test.ts
// (ehp.6 sibling). The lib-level reader interfaces consumed by
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
jest.mock("@/lib/pipeline-labels", () => ({
  getEpicLabels: jest.fn(),
}));
// listOpenWaveBeads feeds DispatchContext.openWaveBeadIds; the wave-beads
// predicates fire when this returns []. Per-scenario overrides drive the
// NO_WAVE_BEADS / ALL_WAVE_BEADS_CLOSED refusals vs happy-path branch.
//
// listAllStatusWaveBeads (beads_web-m2c) feeds
// DispatchContext.anyStatusWaveBeadIds; the new
// PRECOND_WAVE_BEADS_OF_ANY_STATUS_EXIST predicate fires when this returns
// [] (the phantom-wave case). Mocked here so the integration test can drive
// the dual-signal model without standing up a real bd repo with closed beads.
jest.mock("@/lib/agent-launcher", () => {
  const actual = jest.requireActual("@/lib/agent-launcher");
  return {
    ...actual,
    listOpenWaveBeads: jest.fn(),
    listAllStatusWaveBeads: jest.fn(),
  };
});

import { appendEvent, readEvents } from "@/lib/event-log";
import {
  buildMissedWaveReviewDispatchRule,
  MISSED_WAVE_REVIEW_DISPATCH_RULE_NAME,
  type EpicSnapshot,
} from "@/lib/reconciler-rules/missed-wave-review-dispatch";
import { Reconciler } from "@/lib/reconciler";
import type { BeadSnapshot } from "@/lib/bead-status-reader";
import { readBeadStatus } from "@/lib/bead-status-reader";
import { readMarker } from "@/lib/marker-reader";
import { getEpicLabels } from "@/lib/pipeline-labels";
import { listOpenWaveBeads, listAllStatusWaveBeads } from "@/lib/agent-launcher";

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
  return await fs.mkdtemp(path.join(os.tmpdir(), "ehp7-test-"));
}

/**
 * Materialise a plan file at .beads/plans/<epicId>.md so the
 * PLAN_FILE_MISSING predicate passes. The happy-path + 412 tests need this;
 * the PLAN_FILE_MISSING test deliberately skips it.
 */
async function writePlanFile(repo: string, epicId: string): Promise<void> {
  const plansDir = path.join(repo, ".beads", "plans");
  await fs.mkdir(plansDir, { recursive: true });
  await fs.writeFile(
    path.join(plansDir, `${epicId}.md`),
    `# Plan for ${epicId}\n\nstub plan body for ehp.7 integration test\n`,
  );
}

function makeSnapshot(overrides: Partial<EpicSnapshot> = {}): EpicSnapshot {
  return {
    waveStatus: {
      hasWaves: true,
      currentWave: 4,
      allWavesComplete: false,
    },
    openBugCount: 0,
    labels: ["pipeline:build-review", "ship-type:ios-app", "wave:4"],
    title: "ehp7 test epic",
    ...overrides,
  };
}

function makeBead(overrides: Partial<BeadSnapshot> = {}): BeadSnapshot {
  return {
    id: "factory-core-test",
    status: "open",
    labels: [],
    type: "task",
    pipelineStage: "build-review",
    currentQaRound: null,
    currentWave: 4,
    hasAgentRunning: false,
    hasReviewNeedsHuman: false,
    ...overrides,
  };
}

/**
 * Seed the event log with a build-review agent-exited event old enough to
 * pass the pairing-grace window but young enough to be inside the recovery
 * horizon. matches() requires this event AND no following stage-dispatched.
 */
async function seedMissedExit(
  repo: string,
  epicId: string,
  exitAt: string,
): Promise<void> {
  await appendEvent(repo, {
    type: "agent-exited",
    epicId,
    stage: "build-review",
    correlationId: `tmux-${epicId}`,
    timestamp: exitAt,
    payload: { exitCode: 0 },
  });
}

// ---- Tests ----------------------------------------------------------------

describe("missed-wave-review-dispatch × dispatch-preconditions integration (beads_web-ehp.7)", () => {
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
    mockListAllStatusWaveBeads.mockReset();

    // Sane defaults — explicit per-test overrides supersede.
    mockReadMarker.mockResolvedValue(null);
    mockGetEpicLabels.mockResolvedValue([]);
    // beads_web-m2c default: assume wave-N beads exist (any-status reader
    // returns at least the open ones). Per-test overrides set this to []
    // for the phantom-wave scenario or to closed-bead lists for the
    // 1cb58a5 success-case regression test.
    mockListAllStatusWaveBeads.mockResolvedValue([]);
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  // ==========================================================================
  // AC #1 — PLAN_FILE_MISSING refusal (Class A)
  // ==========================================================================
  // The rule's logical recovery action is `review-wave`. PRECOND_PLAN_FILE_
  // EXISTS is registered for review-wave in the EXTENDED_PRECONDITION_TABLE
  // and fires when no plan file exists at .beads/plans/<epicId>.md. The
  // gate must refuse BEFORE the run-coherence-agent fetch so the rule never
  // escalates to coherence asking it to consider firing review-wave when no
  // plan exists to review against.
  //
  // Load-bearing assertions:
  //   1. NO dispatch fetch fired (fetchCalls empty) — proves the gate fired.
  //   2. reconciler-action-refused event landed with refusalCode=
  //      PLAN_FILE_MISSING + failedCheck=plan-file-exists.
  // --------------------------------------------------------------------------
  test("AC #1 — review-wave dispatch but no plan file → refusal with PLAN_FILE_MISSING, no fetch fires, refusal event recorded", async () => {
    const repo = await makeRepo();
    const epicId = "factory-core-ehp7-no-plan";
    const now = new Date("2026-04-21T10:00:00.000Z");
    const exitAt = new Date(now.getTime() - 65_000).toISOString();

    // Open wave beads exist (so wave-beads predicate passes); only the
    // plan-file predicate should fire.
    mockListOpenWaveBeads.mockResolvedValue([
      { id: `${epicId}.5`, title: "wave-4 bead a", files: [] },
    ]);
    // beads_web-m2c: wave-4 beads exist in any status (so phantom-wave
    // predicate passes); only the plan-file predicate should fire.
    mockListAllStatusWaveBeads.mockResolvedValue([
      { id: `${epicId}.5`, title: "wave-4 bead a", files: [] },
    ]);
    mockReadBeadStatus.mockResolvedValue(
      makeBead({ id: epicId, status: "open", currentWave: 4 }),
    );
    mockGetEpicLabels.mockResolvedValue([
      "pipeline:build-review",
      "ship-type:ios-app",
      "wave:4",
    ]);
    // Deliberately DO NOT call writePlanFile — that's the refusal trigger.

    await seedMissedExit(repo, epicId, exitAt);

    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildMissedWaveReviewDispatchRule({
        repoPath: repo,
        readEpicSnapshot: async () =>
          makeSnapshot({
            waveStatus: {
              hasWaves: true,
              currentWave: 4,
              allWavesComplete: false,
            },
            labels: ["pipeline:build-review", "wave:4", "ship-type:ios-app"],
            title: "ehp7 PLAN_FILE_MISSING reproduction",
          }),
        actionUrl: "http://localhost:3000/api/fleet/action",
      }),
    );
    await rec.tick(now);

    // ==== Load-bearing assertion 1 — NO dispatch fetch =====================
    expect(fetchCalls).toHaveLength(0);

    // ==== Load-bearing assertion 2 — refusal event recorded ================
    const refusals = await readEvents(repo, {
      type: "reconciler-action-refused",
    });
    expect(refusals).toHaveLength(1);
    const refusal = refusals[0];
    expect(refusal.epicId).toBe(epicId);
    expect(refusal.stage).toBe("build-review");
    const payload = refusal.payload as Record<string, unknown>;
    expect(payload.ruleName).toBe(MISSED_WAVE_REVIEW_DISPATCH_RULE_NAME);
    expect(payload.action).toBe("review-wave");
    expect(payload.refusalCode).toBe("PLAN_FILE_MISSING");
    expect(payload.failedCheck).toBe("plan-file-exists");
    expect(typeof payload.reason).toBe("string");
  });

  // ==========================================================================
  // AC #2 (LOAD-BEARING) — niii reviewer-4-wave-4-redundant reproduction
  // ==========================================================================
  // Reproduces the niii reviewer-4-wave-4-redundant failure mode: epic
  // carries `wave:4` label and a `pipeline:build-review` label, but `bd list
  // --label wave:4 --status=open` returns [] (every wave:4 bead is closed).
  // Pre-ehp.7, the rule would escalate to coherence asking it to consider
  // firing review-wave on a wave that has nothing left to review. Post-ehp.7,
  // PRECOND_WAVE_BEADS_EXIST / PRECOND_WAVE_BEADS_NOT_ALL_CLOSED refuses
  // BEFORE the dispatch.
  //
  // Per the ehp.7 risk flag and the v1 library limitation: openWaveBeadIds
  // is empty in BOTH the "no wave-N beads at all" (NO_WAVE_BEADS) AND the
  // "all wave-N beads closed" (ALL_WAVE_BEADS_CLOSED) cases, and the
  // predicates fire in registration order (PRECOND_WAVE_BEADS_EXIST first
  // → NO_WAVE_BEADS wins). The dispatch-preconditions test at
  // dispatch-preconditions.test.ts:1504-1521 establishes the canonical
  // assertion shape: refusalCode ∈ {NO_WAVE_BEADS, ALL_WAVE_BEADS_CLOSED}.
  // We mirror that here so the test is robust to future predicate-ordering
  // refinements (per beads_web-ehp.12 risk flag #3).
  // --------------------------------------------------------------------------
  test("AC #2 — niii reviewer-4-wave-4-redundant: phantom wave (no wave:4 beads exist) → refusal with NO_WAVE_BEADS, no fetch fires, refusal event recorded", async () => {
    const repo = await makeRepo();
    const epicId = "factory-core-niii-reviewer-4-wave-4";
    const now = new Date("2026-04-21T10:00:00.000Z");
    const exitAt = new Date(now.getTime() - 65_000).toISOString();

    // beads_web-m2c (post-1cb58a5): the phantom-wave-4 condition is now
    // signalled via the NEW any-status reader returning [] (no wave-4
    // beads of ANY status exist). The OLD `openWaveBeadIds=[]` signal
    // alone no longer refuses review-wave (1cb58a5 fix unblocked the
    // legitimate post-close case where all wave beads close successfully).
    // The new dual-signal model: openWaveBeadIds=[] alone = success;
    // anyStatusWaveBeadIds=[] = phantom = refuse.
    mockListOpenWaveBeads.mockResolvedValue([]);
    mockListAllStatusWaveBeads.mockResolvedValue([]);
    mockReadBeadStatus.mockResolvedValue(
      makeBead({ id: epicId, status: "open", currentWave: 4 }),
    );
    mockGetEpicLabels.mockResolvedValue([
      "pipeline:build-review",
      "wave:4",
      "ship-type:ios-app",
    ]);
    // Plan file exists — only the wave-beads predicate should fire.
    await writePlanFile(repo, epicId);

    await seedMissedExit(repo, epicId, exitAt);

    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildMissedWaveReviewDispatchRule({
        repoPath: repo,
        readEpicSnapshot: async () =>
          makeSnapshot({
            waveStatus: {
              hasWaves: true,
              currentWave: 4,
              allWavesComplete: false,
            },
            labels: ["pipeline:build-review", "wave:4", "ship-type:ios-app"],
            title: "niii reviewer-4-wave-4-redundant reproduction",
          }),
        actionUrl: "http://localhost:3000/api/fleet/action",
      }),
    );
    await rec.tick(now);

    // ==== Load-bearing assertion 1 — NO dispatch fetch =====================
    expect(fetchCalls).toHaveLength(0);

    // ==== Load-bearing assertion 2 — refusal event recorded ================
    const refusals = await readEvents(repo, {
      type: "reconciler-action-refused",
    });
    expect(refusals).toHaveLength(1);
    const refusal = refusals[0];
    expect(refusal.epicId).toBe(epicId);
    expect(refusal.stage).toBe("build-review");
    const payload = refusal.payload as Record<string, unknown>;
    expect(payload.ruleName).toBe(MISSED_WAVE_REVIEW_DISPATCH_RULE_NAME);
    expect(payload.action).toBe("review-wave");
    // Per ehp.7 risk flag + dispatch-preconditions.test.ts:1517: assert the
    // refusal code is in the canonical enum subset (predicate ordering may
    // evolve; v1 cannot disambiguate the two states from openWaveBeadIds).
    expect(["NO_WAVE_BEADS", "ALL_WAVE_BEADS_CLOSED"]).toContain(
      payload.refusalCode,
    );
    expect(typeof payload.failedCheck).toBe("string");
    expect(typeof payload.reason).toBe("string");
  });

  // ==========================================================================
  // AC #3 — Happy path: plan file exists + open wave beads → existing
  //         dispatch fires unchanged (no behaviour drift from pre-ehp.7).
  // ==========================================================================
  test("AC #3 — happy path: plan file exists AND open wave beads exist → existing run-coherence-agent dispatch fires unchanged AND no refusal event recorded", async () => {
    const repo = await makeRepo();
    const epicId = "factory-core-ehp7-happy";
    const now = new Date("2026-04-21T10:00:00.000Z");
    const exitAt = new Date(now.getTime() - 65_000).toISOString();

    // Open wave beads exist — the wave-beads predicate passes.
    mockListOpenWaveBeads.mockResolvedValue([
      { id: `${epicId}.5`, title: "wave-2 bead a", files: [] },
      { id: `${epicId}.6`, title: "wave-2 bead b", files: [] },
    ]);
    // beads_web-m2c: any-status reader returns the open beads (and would
    // also include any closed siblings in a real bd state). Non-empty
    // means the new phantom-wave predicate passes.
    mockListAllStatusWaveBeads.mockResolvedValue([
      { id: `${epicId}.5`, title: "wave-2 bead a", files: [] },
      { id: `${epicId}.6`, title: "wave-2 bead b", files: [] },
    ]);
    mockReadBeadStatus.mockResolvedValue(
      makeBead({ id: epicId, status: "open", currentWave: 2 }),
    );
    mockGetEpicLabels.mockResolvedValue([
      "pipeline:build-review",
      "ship-type:ios-app",
      "wave:2",
    ]);
    // Plan file exists — the plan-file predicate passes.
    await writePlanFile(repo, epicId);

    await seedMissedExit(repo, epicId, exitAt);

    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildMissedWaveReviewDispatchRule({
        repoPath: repo,
        readEpicSnapshot: async () =>
          makeSnapshot({
            waveStatus: {
              hasWaves: true,
              currentWave: 2,
              allWavesComplete: false,
            },
            labels: ["pipeline:build-review", "wave:2", "ship-type:ios-app"],
            title: "ehp7 Happy Path",
          }),
        actionUrl: "http://localhost:3000/api/fleet/action",
      }),
    );
    await rec.tick(now);

    // Dispatch fired unchanged with run-coherence-agent body.
    expect(fetchCalls).toHaveLength(1);
    const body = fetchCalls[0].body as {
      action: string;
      epicId: string;
      anomalyClass: string;
    };
    expect(body.action).toBe("run-coherence-agent");
    expect(body.epicId).toBe(epicId);
    expect(body.anomalyClass).toBe("missed-wave-review-dispatch");

    // No refusal event for the happy path.
    const refusals = await readEvents(repo, {
      type: "reconciler-action-refused",
    });
    expect(refusals).toHaveLength(0);
  });

  // ==========================================================================
  // AC #4 — Route returns HTTP 412 → log + return without throwing.
  // ==========================================================================
  // Architecture § Seam 5 defense-in-depth: the rule's precondition gate
  // and the route's precondition gate are both load-bearing. If the rule's
  // gate passed but the route's gate refuses (race window — bead state
  // changed between the two checks), the rule must treat 412 as a refusal
  // (NOT a failure: throwing would propagate to the reconciler tick handler
  // and dispatch a different recovery path). Mirror of marker-driven-
  // routing.ts / wave-bead-mismatch.ts / stuck-in-stage.ts 412 handling.
  // --------------------------------------------------------------------------
  test("AC #4 — route returns HTTP 412 → reconciler-action-refused event with ROUTE_REFUSED_412 code, no throw (defense-in-depth Seam 5)", async () => {
    const repo = await makeRepo();
    const epicId = "factory-core-ehp7-412-defense";
    const now = new Date("2026-04-21T10:00:00.000Z");
    const exitAt = new Date(now.getTime() - 65_000).toISOString();

    // Rule-side gate passes — open wave beads exist + plan file present.
    mockListOpenWaveBeads.mockResolvedValue([
      { id: `${epicId}.5`, title: "wave-2 bead", files: [] },
    ]);
    // beads_web-m2c: any-status reader returns at least the open beads so
    // the new phantom-wave predicate passes. The route-side 412 simulates
    // a different refusal (BD_STATUS_DEFERRED) detected between the rule
    // check and the route check (Seam 5 race).
    mockListAllStatusWaveBeads.mockResolvedValue([
      { id: `${epicId}.5`, title: "wave-2 bead", files: [] },
    ]);
    mockReadBeadStatus.mockResolvedValue(
      makeBead({ id: epicId, status: "open", currentWave: 2 }),
    );
    mockGetEpicLabels.mockResolvedValue([
      "pipeline:build-review",
      "ship-type:ios-app",
      "wave:2",
    ]);
    await writePlanFile(repo, epicId);

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

    await seedMissedExit(repo, epicId, exitAt);

    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildMissedWaveReviewDispatchRule({
        repoPath: repo,
        readEpicSnapshot: async () =>
          makeSnapshot({
            waveStatus: {
              hasWaves: true,
              currentWave: 2,
              allWavesComplete: false,
            },
            labels: ["pipeline:build-review", "wave:2", "ship-type:ios-app"],
            title: "ehp7 412 Defense-in-Depth",
          }),
        actionUrl: "http://localhost:3000/api/fleet/action",
      }),
    );

    // Must NOT throw — 412 is a refusal, not a failure. rec.tick swallows
    // act() resolutions; the contract verified here is that act() resolves
    // (via no thrown error from the reconciler tick).
    await expect(rec.tick(now)).resolves.toBeUndefined();

    // Fetch DID fire (the route is the gate that refused).
    expect(fetchCalls).toHaveLength(1);

    // Refusal event recorded with the route-side discriminator.
    const refusals = await readEvents(repo, {
      type: "reconciler-action-refused",
    });
    expect(refusals).toHaveLength(1);
    const refusal = refusals[0];
    expect(refusal.epicId).toBe(epicId);
    expect(refusal.stage).toBe("build-review");
    const payload = refusal.payload as Record<string, unknown>;
    expect(payload.ruleName).toBe(MISSED_WAVE_REVIEW_DISPATCH_RULE_NAME);
    expect(payload.action).toBe("run-coherence-agent");
    expect(payload.refusalCode).toBe("ROUTE_REFUSED_412");
    expect(payload.failedCheck).toBe("route-side-precondition");
    expect(typeof payload.reason).toBe("string");
  });

  // ==========================================================================
  // beads_web-m2c REGRESSION GUARD — review-wave success case (1cb58a5 fix)
  // ==========================================================================
  // Positive regression test: verifies that review-wave dispatch FIRES (not
  // refuses) when all wave-N beads are closed but at least one wave-N bead
  // exists. This is the LEGITIMATE post-close trigger that 1cb58a5 unblocked.
  // If a future edit re-couples review-wave to ACTIONS_REQUIRING_WAVE_BEADS
  // (or otherwise re-checks `openWaveBeadIds=[]` for review-wave), this test
  // fails — preventing the original 1cb58a5 bug from re-surfacing.
  //
  // Difference from AC #2 (the niii redundant case): here `anyStatusWaveBeadIds`
  // is NON-empty (closed beads exist). The new
  // PRECOND_WAVE_BEADS_OF_ANY_STATUS_EXIST predicate distinguishes "phantom
  // wave (no beads at all)" from "all closed (legitimate review trigger)".
  // --------------------------------------------------------------------------
  test("beads_web-m2c regression guard — review-wave with all wave-N beads closed (1cb58a5 success case): dispatch fires, no refusal", async () => {
    const repo = await makeRepo();
    const epicId = "factory-core-m2c-regression-guard";
    const now = new Date("2026-04-21T10:00:00.000Z");
    const exitAt = new Date(now.getTime() - 65_000).toISOString();

    // openWaveBeadIds=[] (every wave-2 bead closed) — the SUCCESS state for
    // review-wave per 1cb58a5.
    mockListOpenWaveBeads.mockResolvedValue([]);
    // anyStatusWaveBeadIds NON-empty (the closed beads exist) — the new m2c
    // predicate passes because the wave is not phantom.
    mockListAllStatusWaveBeads.mockResolvedValue([
      { id: `${epicId}.5`, title: "wave-2 bead a (closed)", files: [] },
      { id: `${epicId}.6`, title: "wave-2 bead b (closed)", files: [] },
    ]);
    mockReadBeadStatus.mockResolvedValue(
      makeBead({ id: epicId, status: "open", currentWave: 2 }),
    );
    mockGetEpicLabels.mockResolvedValue([
      "pipeline:build-review",
      "ship-type:ios-app",
      "wave:2",
    ]);
    await writePlanFile(repo, epicId);

    await seedMissedExit(repo, epicId, exitAt);

    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildMissedWaveReviewDispatchRule({
        repoPath: repo,
        readEpicSnapshot: async () =>
          makeSnapshot({
            waveStatus: {
              hasWaves: true,
              currentWave: 2,
              allWavesComplete: false,
            },
            labels: ["pipeline:build-review", "wave:2", "ship-type:ios-app"],
            title: "m2c regression guard: 1cb58a5 success case",
          }),
        actionUrl: "http://localhost:3000/api/fleet/action",
      }),
    );
    await rec.tick(now);

    // ==== Load-bearing assertion 1 — Dispatch DID fire ====================
    // 1cb58a5 success case: review-wave fires when all wave beads are closed
    // (because that's exactly when the review is appropriate). If the new
    // predicate were over-eager and refused on `openWaveBeadIds=[]`, this
    // assertion would fail and the 1cb58a5 regression would have re-surfaced.
    expect(fetchCalls).toHaveLength(1);
    const body = fetchCalls[0].body as {
      action: string;
      epicId: string;
      anomalyClass: string;
    };
    expect(body.action).toBe("run-coherence-agent");
    expect(body.epicId).toBe(epicId);
    expect(body.anomalyClass).toBe("missed-wave-review-dispatch");

    // ==== Load-bearing assertion 2 — NO refusal event recorded ============
    const refusals = await readEvents(repo, {
      type: "reconciler-action-refused",
    });
    expect(refusals).toHaveLength(0);
  });
});
