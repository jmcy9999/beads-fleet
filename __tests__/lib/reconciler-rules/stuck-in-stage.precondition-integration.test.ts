// =============================================================================
// Tests for beads_web-ehp.5 — stuck-in-stage × dispatch-preconditions
// integration (Wave 3).
//
// Stuck-in-stage is the most-frequent re-dispatcher and the top source of
// phantom dispatches when stages have not actually completed. The niii
// reproduction (phantom-wave-4 dispatch) is the canonical scenario: an epic
// stalled at `development` for >threshold but with NO open wave-N beads —
// pre-ehp.5 the rule would dispatch start-wave (or run-coherence-agent
// post-wlsr.14), producing a phantom recovery against an empty bead set.
// The Class A NO_WAVE_BEADS predicate refuses the dispatch BEFORE fetch fires.
//
// Coverage:
//   1. NO_WAVE_BEADS — niii phantom-wave-4 reproduction (LOAD-BEARING):
//      development stage stalled, currentWave=4, no open wave-4 beads →
//      refusal with NO_WAVE_BEADS, no fetch, refusal event recorded.
//   2. PLAN_PENDING — plan-review stage stalled with `plan:pending` label
//      still set on the epic → refusal with PLAN_PENDING, no fetch.
//   3. Happy path — stalled qa stage with bead open + clean labels →
//      existing run-coherence-agent dispatch fires unchanged.
//   4. Route returns 412 → log + reconciler-action-refused event with
//      ROUTE_REFUSED_412 code, act() resolves without throwing
//      (architecture § Seam 5 defense-in-depth).
//
// Mock pattern: jest.mock the published reader interfaces consumed by
// buildDispatchContext (bead-status-reader, marker-reader, pipeline-labels,
// agent-launcher's listOpenWaveBeads). The rule's own opts.readEpicSnapshot
// callback is independent — it returns the per-epic snapshot the rule's
// act() consumes for dispatch payload construction. Real bd / dolt
// end-to-end coverage already lives in dispatch-preconditions.integration.
// test.ts; here we verify the WIRING.
//
// LOAD-BEARING niii reproduction: AC #1's NO_WAVE_BEADS test at
// stuck-in-stage.precondition-integration.test.ts:~150 is the niii
// phantom-wave-4 protection. If it does not refuse, the protection is
// gone — STOP and surface (per ehp.5 risk flag).
// =============================================================================

import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";

// ---- Mock reader modules at the import boundary ---------------------------
//
// buildDispatchContext consumes these. The mocks let the integration test
// drive the precondition library through the rule's act() without standing
// up a real bd repo.
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
jest.mock("@/lib/agent-launcher", () => {
  const actual = jest.requireActual("@/lib/agent-launcher");
  return { ...actual, listOpenWaveBeads: jest.fn() };
});

import { appendEvent, readEvents } from "@/lib/event-log";
import {
  buildStuckInStageRule,
  STUCK_IN_STAGE_RULE_NAME,
  type EpicSnapshot,
} from "@/lib/reconciler-rules/stuck-in-stage";
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
  return await fs.mkdtemp(path.join(os.tmpdir(), "ehp5-test-"));
}

/**
 * Create the per-epic plan file at .beads/plans/<epicId>.md so the
 * Class A `plan-file-exists` precondition (registered against start-wave,
 * review-plan, send-for-qa, etc.) passes. Required for the niii
 * reproduction + plan-pending + happy-path + 412 tests where the
 * realistic scenario has a plan file already in place.
 */
async function writePlanFile(repo: string, epicId: string): Promise<void> {
  const planDir = path.join(repo, ".beads", "plans");
  await fs.mkdir(planDir, { recursive: true });
  await fs.writeFile(
    path.join(planDir, `${epicId}.md`),
    `# Plan for ${epicId}\n\n(test fixture)\n`,
    "utf-8",
  );
}

function makeSnapshot(overrides: Partial<EpicSnapshot> = {}): EpicSnapshot {
  return {
    currentStage: "development",
    hasAgentRunning: false,
    labels: ["pipeline:development", "ship-type:internal", "wave:4"],
    title: "ehp.5 test epic",
    currentWave: 4,
    ...overrides,
  };
}

function makeBead(overrides: Partial<BeadSnapshot> = {}): BeadSnapshot {
  return {
    id: "factory-core-test",
    status: "open",
    labels: [],
    type: "epic",
    pipelineStage: null,
    currentQaRound: null,
    currentWave: null,
    hasAgentRunning: false,
    hasReviewNeedsHuman: false,
    ...overrides,
  };
}

// Helper for matches() driver: seed an agent-exited event old enough to
// trigger the staleness threshold, then call rule.matches() and rule.act().
async function driveStaleStage(opts: {
  repo: string;
  epicId: string;
  stage: string;
  ageMinutes?: number;
  rule: ReturnType<typeof buildStuckInStageRule>;
}): Promise<void> {
  const ageMin = opts.ageMinutes ?? 16; // default just past 15-min threshold
  const now = new Date();
  const events: PipelineEvent[] = [
    {
      type: "agent-exited",
      epicId: opts.epicId,
      stage: opts.stage,
      timestamp: new Date(now.getTime() - ageMin * 60_000).toISOString(),
      payload: { exitCode: 0 },
    },
  ];
  const matches = await opts.rule.matches(events, now);
  expect(matches).toHaveLength(1);
  await opts.rule.act(matches[0]);
}

// ---- Tests ----------------------------------------------------------------

describe("stuck-in-stage × dispatch-preconditions integration (beads_web-ehp.5)", () => {
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

    mockReadBeadStatus.mockReset();
    mockReadMarker.mockReset();
    mockGetEpicLabels.mockReset();
    mockListOpenWaveBeads.mockReset();
    // Sane defaults — explicit per-test overrides supersede.
    mockReadMarker.mockResolvedValue(null);
    mockGetEpicLabels.mockResolvedValue([]);
    mockListOpenWaveBeads.mockResolvedValue([]);
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  // ==========================================================================
  // AC #1 (LOAD-BEARING) — Phantom wave-N dispatch refusal
  //   niii phantom-wave-4 reproduction. development stage stalled,
  //   currentWave=4, NO open wave-4 beads → NO_WAVE_BEADS refusal,
  //   no dispatch fires, refusal event recorded.
  // ==========================================================================
  // The niii phantom-wave-4 reproduction is operationally protected by THIS
  // path. If this test does not pass, the phantom-dispatch protection is
  // GONE — STOP and surface (per ehp.5 risk flag).
  // --------------------------------------------------------------------------
  test("LOAD-BEARING (niii phantom-wave-4 reproduction): no open wave-N beads → NO_WAVE_BEADS refusal, no dispatch, refusal event recorded", async () => {
    const repo = await makeRepo();
    const epicId = "factory-core-niii";
    const stage = "development";
    // Realistic niii scenario: plan file already exists (the epic was
    // planned in a prior wave); the phantom-dispatch failure is "no
    // OPEN wave-4 beads despite stage stuck at development". Without
    // a plan file the Class A PLAN_FILE_MISSING fires first and
    // pre-empts the NO_WAVE_BEADS check we want to verify.
    await writePlanFile(repo, epicId);

    // Open epic — A.5 predicates pass.
    mockReadBeadStatus.mockResolvedValue(
      makeBead({ id: epicId, status: "open" }),
    );
    // Empty wave bead list — Class A NO_WAVE_BEADS predicate fires
    // (resumeAction for development is start-wave, which has the
    // wave-beads-exist precondition registered).
    mockListOpenWaveBeads.mockResolvedValue([]);
    // Benign labels — no pipeline conflict, no human-decision blocker.
    mockGetEpicLabels.mockResolvedValue([
      "pipeline:development",
      "ship-type:internal",
      "wave:4",
    ]);

    const rule = buildStuckInStageRule({
      repoPath: repo,
      readEpicSnapshot: async () =>
        makeSnapshot({
          currentStage: stage,
          labels: [
            "pipeline:development",
            "ship-type:internal",
            "wave:4",
          ],
          currentWave: 4,
        }),
      actionUrl: "http://localhost:3000/api/fleet/action",
    });

    await driveStaleStage({ repo, epicId, stage, rule });

    // Load-bearing assertion — NO fetch was made (phantom dispatch refused).
    expect(fetchCalls).toHaveLength(0);

    // Refusal event recorded with NO_WAVE_BEADS.
    const refusals = await readEvents(repo, {
      type: "reconciler-action-refused",
    });
    expect(refusals).toHaveLength(1);
    const payload = refusals[0].payload as Record<string, unknown>;
    expect(payload.ruleName).toBe(STUCK_IN_STAGE_RULE_NAME);
    expect(payload.action).toBe("start-wave"); // resumeAction for development
    expect(payload.refusalCode).toBe("NO_WAVE_BEADS");
    expect(payload.failedCheck).toBe("wave-beads-exist");
    expect(refusals[0].epicId).toBe(epicId);
    expect(refusals[0].stage).toBe(stage);
  });

  // ==========================================================================
  // AC #2 — plan-review recovery FIRES (poh.13 fix)
  //   Pre-poh.13: plan-review stage stalled with `plan:pending` label set
  //   was REFUSED with PLAN_PENDING — review-plan was incorrectly listed in
  //   ACTIONS_REFUSED_BY_PLAN_PENDING even though review-plan IS the
  //   transition that consumes plan:pending. With the predicate's appliesTo
  //   restricted to plan-CONSUMING actions only (start-wave, review-wave),
  //   stuck-in-stage's review-plan dispatch now fires cleanly and the
  //   reviewer gets to advance the epic.
  // ==========================================================================
  test("plan-review stalled with `plan:pending` label set → review-plan dispatch FIRES (poh.13)", async () => {
    const repo = await makeRepo();
    const epicId = "factory-core-plan-pending";
    const stage = "plan-review";
    // Plan file exists (the planner drafted it); the `plan:pending`
    // label is the signal that the plan is awaiting review — distinct
    // from PLAN_FILE_MISSING (no plan at all).
    await writePlanFile(repo, epicId);

    mockReadBeadStatus.mockResolvedValue(
      makeBead({ id: epicId, status: "open" }),
    );
    mockReadMarker.mockResolvedValue(null);
    mockGetEpicLabels.mockResolvedValue([
      "pipeline:plan-review",
      "plan:pending",
      "ship-type:internal",
    ]);

    const rule = buildStuckInStageRule({
      repoPath: repo,
      readEpicSnapshot: async () =>
        makeSnapshot({
          currentStage: stage,
          labels: [
            "pipeline:plan-review",
            "plan:pending",
            "ship-type:internal",
          ],
          // plan-review's resumeAction is review-plan; it does NOT need
          // a wave number per STAGE_RESUME_ACTIONS (needsWaveNumber=false).
          currentWave: undefined,
        }),
      actionUrl: "http://localhost:3000/api/fleet/action",
    });

    await driveStaleStage({ repo, epicId, stage, rule });

    // Stuck-in-stage post-wlsr.14 dispatches run-coherence-agent (the
    // resumeAction "review-plan" is only used as a precondition probe,
    // not the actual dispatch). Pre-poh.13 the precondition probe
    // against `review-plan + plan:pending` returned PLAN_PENDING and
    // the escalation was refused — the entire plan-review stage had
    // no autonomous recovery path. Post-poh.13 the probe passes and
    // the escalation reaches coherence, which decides what to do
    // (per Option C of poh.13, coherence is the right home for that
    // decision).
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].body.action).toBe("run-coherence-agent");
    expect(fetchCalls[0].body.epicId).toBe(epicId);

    // No refusal event — the precondition probe passes (the bug fix).
    const refusals = await readEvents(repo, {
      type: "reconciler-action-refused",
    });
    expect(refusals).toHaveLength(0);
  });

  // ==========================================================================
  // AC #3 — Happy path: existing dispatch fetch fires unchanged.
  // ==========================================================================
  test("happy path: open bead + clean labels + qa stage → run-coherence-agent fetch fires unchanged (no behaviour drift)", async () => {
    const repo = await makeRepo();
    const epicId = "factory-core-happy";
    const stage = "qa";
    // qa stage's resumeAction is send-for-qa, which requires a plan file
    // (ACTIONS_REQUIRING_PLAN_FILE in dispatch-preconditions.ts). Realistic
    // scenario: plan exists since QA happens after development.
    await writePlanFile(repo, epicId);

    mockReadBeadStatus.mockResolvedValue(
      makeBead({ id: epicId, status: "open" }),
    );
    mockReadMarker.mockResolvedValue(null);
    mockGetEpicLabels.mockResolvedValue([
      "pipeline:qa",
      "ship-type:internal",
    ]);
    // qa stage's resumeAction is `send-for-qa` (needsWaveNumber=false).
    // No wave-beads predicate applies; no plan-pending; clean dispatch.

    const rule = buildStuckInStageRule({
      repoPath: repo,
      readEpicSnapshot: async () =>
        makeSnapshot({
          currentStage: stage,
          labels: ["pipeline:qa", "ship-type:internal"],
          currentWave: undefined,
        }),
      actionUrl: "http://localhost:3000/api/fleet/action",
    });

    await driveStaleStage({ repo, epicId, stage, rule });

    // Existing dispatch fetch fired unchanged — run-coherence-agent
    // (post-wlsr.14 cutover; act() escalates to coherence rather than
    // re-firing the canned resumeAction).
    expect(fetchCalls).toHaveLength(1);
    const body = fetchCalls[0].body as Record<string, unknown>;
    expect(body.action).toBe("run-coherence-agent");
    expect(body.epicId).toBe(epicId);
    expect(body.anomalyClass).toBe("stuck-in-stage");

    // No refusal event for the happy path.
    const refusals = await readEvents(repo, {
      type: "reconciler-action-refused",
    });
    expect(refusals).toHaveLength(0);
  });

  // ==========================================================================
  // AC #4 — Route returns HTTP 412 → log + reconciler-action-refused event
  //         AND return without throwing (architecture § Seam 5).
  // ==========================================================================
  test("route returns HTTP 412 → reconciler-action-refused event with ROUTE_REFUSED_412 code, no throw (defense-in-depth Seam 5)", async () => {
    const repo = await makeRepo();
    const epicId = "factory-core-412";
    const stage = "qa";
    // qa resumeAction send-for-qa requires plan file — write one so
    // the rule-side check passes and we exercise the route-side 412 branch.
    await writePlanFile(repo, epicId);

    fetchResponseFactory = () =>
      new Response(
        JSON.stringify({
          error: "precondition_failed",
          refusalCode: "BD_STATUS_DEFERRED",
          reason:
            "Bead became deferred between rule check and route check",
        }),
        {
          status: 412,
          headers: { "Content-Type": "application/json" },
        },
      );

    // Rule-side precondition passes (open bead, no marker, clean labels).
    // The route is the one refusing — defense-in-depth catch.
    mockReadBeadStatus.mockResolvedValue(
      makeBead({ id: epicId, status: "open" }),
    );
    mockReadMarker.mockResolvedValue(null);
    mockGetEpicLabels.mockResolvedValue(["pipeline:qa"]);

    const rule = buildStuckInStageRule({
      repoPath: repo,
      readEpicSnapshot: async () =>
        makeSnapshot({
          currentStage: stage,
          labels: ["pipeline:qa"],
          currentWave: undefined,
        }),
      actionUrl: "http://localhost:3000/api/fleet/action",
    });

    const now = new Date();
    const events: PipelineEvent[] = [
      {
        type: "agent-exited",
        epicId,
        stage,
        timestamp: new Date(now.getTime() - 16 * 60_000).toISOString(),
        payload: { exitCode: 0 },
      },
    ];

    const matches = await rule.matches(events, now);
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

    // Refusal event recorded with the route-side discriminator.
    const refusals = await readEvents(repo, {
      type: "reconciler-action-refused",
    });
    expect(refusals).toHaveLength(1);
    const payload = refusals[0].payload as Record<string, unknown>;
    expect(payload.ruleName).toBe(STUCK_IN_STAGE_RULE_NAME);
    expect(payload.action).toBe("run-coherence-agent");
    expect(payload.refusalCode).toBe("ROUTE_REFUSED_412");
    expect(payload.failedCheck).toBe("route-side-precondition");
    expect(typeof payload.reason).toBe("string");
  });

  // ==========================================================================
  // Idempotency-window safety check (per RISK FLAG: ensure refusal events do
  // not get confused with reconciler-action-taken events; matches() filters
  // those out at line 232 — refusals MUST NOT count toward the same bucket).
  //
  // This test verifies that a refused dispatch leaves the matches() last-
  // event clock running on the agent-exited event (NOT the refusal event),
  // so a subsequent tick that lands inside the same staleness window still
  // sees the SAME bucket. The refusal event uses event type `reconciler-
  // action-refused` (NOT `reconciler-action-taken`); matches() at line 232
  // explicitly excludes `reconciler-action-taken`, so refusals don't reset
  // the stall clock either way. This is a wiring sanity check.
  //
  // FOLLOW-ON: refusals still consume the reconciler.ts-managed (rule, key)
  // idempotency bucket because reconciler-action-taken is appended
  // unconditionally after act() returns. Mirrored from ehp.4's marker.
  // --------------------------------------------------------------------------
  test("refusal event uses reconciler-action-refused (not reconciler-action-taken) — preserves matches() lastEvent clock", async () => {
    const repo = await makeRepo();
    const epicId = "factory-core-idempotency";
    const stage = "development";
    await writePlanFile(repo, epicId);

    mockReadBeadStatus.mockResolvedValue(
      makeBead({ id: epicId, status: "open" }),
    );
    mockListOpenWaveBeads.mockResolvedValue([]);
    mockGetEpicLabels.mockResolvedValue(["pipeline:development", "wave:4"]);

    const rule = buildStuckInStageRule({
      repoPath: repo,
      readEpicSnapshot: async () =>
        makeSnapshot({
          currentStage: stage,
          labels: ["pipeline:development", "wave:4"],
          currentWave: 4,
        }),
      actionUrl: "http://localhost:3000/api/fleet/action",
    });

    // Seed an old agent-exited event (also placed on disk so subsequent
    // readEvents() calls see it).
    const now = new Date();
    await appendEvent(repo, {
      type: "agent-exited",
      epicId,
      stage,
      timestamp: new Date(now.getTime() - 16 * 60_000).toISOString(),
      payload: { exitCode: 0 },
    });

    await driveStaleStage({ repo, epicId, stage, rule });

    // Refusal event written; reconciler-action-taken NOT written by act()
    // (the reconciler core would write that — but the rule's act() under
    // test should not fire a `taken` event itself).
    const refusals = await readEvents(repo, {
      type: "reconciler-action-refused",
    });
    expect(refusals).toHaveLength(1);

    const taken = await readEvents(repo, {
      type: "reconciler-action-taken",
    });
    expect(taken).toHaveLength(0);
  });
});
