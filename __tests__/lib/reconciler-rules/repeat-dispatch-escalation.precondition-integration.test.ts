// =============================================================================
// Tests for beads_web-ehp.8 — repeat-dispatch-escalation × dispatch-preconditions
// integration (Wave 4).
//
// Load-bearing: AC #1 (BD_STATUS_DEFERRED) extends the 372-bead mass-defer
// protection to the repeat-dispatch-escalation path. The rule fires
// `run-coherence-agent` when the same (epic, stage) has been re-dispatched
// 3+ times in the last hour without progress; without the precondition gate,
// a deferred bead would still receive the coherence escalation, violating
// the operator's defer intent.
//
// Coverage:
//   1. bd status=deferred (mass-defer scenario) → BD_STATUS_DEFERRED refusal,
//      no escalation fetch fires, reconciler-action-refused event recorded.
//   2. Happy path — open bead → existing escalation dispatch fetch fires
//      unchanged AND no refusal event is recorded.
//   3. Route returns HTTP 412 → reconciler_dispatch_refused_at_route warn-
//      log + reconciler-action-refused event with ROUTE_REFUSED_412 code,
//      and act() returns WITHOUT throwing (architecture § Seam 5
//      defense-in-depth handling, distinguished from genuine HTTP failure).
//
// Mock pattern: jest.mock the published reader interfaces consumed by
// buildDispatchContext (bead-status-reader, marker-reader at the lib
// boundary, pipeline-labels). The rule's own opts.readEpicSnapshot callback
// is independent — it returns the per-epic snapshot for the dispatch body.
// Real bd / dolt end-to-end coverage lives in
// dispatch-preconditions.integration.test.ts (Wave-2 sibling); here we
// verify the WIRING is correct: refusals stop the fetch, happy path lets
// it through, 412 is treated as a refusal not a failure.
//
// Note on action coverage: this rule dispatches a SINGLE action,
// `run-coherence-agent`, which is registered in the
// EXTENDED_PRECONDITION_TABLE (verified by manual inspection at
// src/lib/dispatch-preconditions.ts:1109 — "run-coherence-agent" is in
// DISPATCHING_ACTIONS, so universal predicates fire on it).
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

import { appendEvent, readEvents } from "@/lib/event-log";
import {
  buildRepeatDispatchEscalationRule,
  REPEAT_DISPATCH_ESCALATION_RULE_NAME,
  type EpicSnapshot,
} from "@/lib/reconciler-rules/repeat-dispatch-escalation";
import type { BeadSnapshot } from "@/lib/bead-status-reader";
import { readBeadStatus } from "@/lib/bead-status-reader";
import { readMarker } from "@/lib/marker-reader";
import { getEpicLabels } from "@/lib/pipeline-labels";

const mockReadBeadStatus = readBeadStatus as jest.MockedFunction<
  typeof readBeadStatus
>;
const mockReadMarker = readMarker as jest.MockedFunction<typeof readMarker>;
const mockGetEpicLabels = getEpicLabels as jest.MockedFunction<
  typeof getEpicLabels
>;

// ---- Helpers --------------------------------------------------------------

async function makeRepo(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "ehp8-test-"));
}

function makeSnapshot(overrides: Partial<EpicSnapshot> = {}): EpicSnapshot {
  return {
    currentStage: "plan-review",
    labels: ["pipeline:plan-review", "ship-type:internal"],
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

/** Seed N stuck-in-stage action-taken events that drive the rule into
 *  matches() emitting an escalation match. Spaced 20 min apart so each
 *  falls in a distinct 15-min bucket and matches() counts them. */
async function seedStuckInStageActions(
  repo: string,
  epicId: string,
  stage: string,
  count: number,
  baseNow: number = Date.now(),
  spacingMs = 20 * 60_000,
): Promise<void> {
  for (let i = 0; i < count; i++) {
    const ts = new Date(baseNow - (count - 1 - i) * spacingMs).toISOString();
    await appendEvent(repo, {
      type: "reconciler-action-taken",
      epicId,
      timestamp: ts,
      payload: {
        ruleName: "stuck-in-stage",
        idempotencyKey: `stuck-in-stage::${epicId}::${stage}::bucket-${i}`,
        context: {
          stage,
          resumeAction: "review-plan",
          lastEventAt: ts,
          ageMs: 1000,
        },
      },
    });
  }
}

// ---- Tests ----------------------------------------------------------------

describe("repeat-dispatch-escalation × dispatch-preconditions integration (beads_web-ehp.8)", () => {
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
    // Sane defaults — explicit per-test overrides supersede.
    mockReadMarker.mockResolvedValue(null);
    mockGetEpicLabels.mockResolvedValue([]);
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  // ==========================================================================
  // AC #1 (LOAD-BEARING) — bd status=deferred refuses with BD_STATUS_DEFERRED
  // ==========================================================================
  // The 372-bead mass-defer is operationally protected by the precondition
  // gate. Without this gate firing on the repeat-dispatch-escalation path, a
  // deferred bead that previously triggered 3+ stuck-in-stage recoveries
  // would still receive a coherence escalation, defying the defer intent.
  // --------------------------------------------------------------------------
  test("LOAD-BEARING: bd status=deferred refuses with BD_STATUS_DEFERRED — no dispatch, refusal event recorded (mass-defer protection)", async () => {
    const repo = await makeRepo();
    const epicId = "factory-core-deferred";
    const stage = "plan-review";
    const now = new Date();

    // Seed 3 stuck-in-stage events to push matches() over THRESHOLD.
    await seedStuckInStageActions(repo, epicId, stage, 3, now.getTime());

    // The bead-status reader returns a deferred snapshot — Class A.5
    // BD_STATUS_DEFERRED predicate fires.
    mockReadBeadStatus.mockResolvedValue(
      makeBead({ id: epicId, status: "deferred" }),
    );
    mockReadMarker.mockResolvedValue(null);
    mockGetEpicLabels.mockResolvedValue(["pipeline:plan-review"]);

    const rule = buildRepeatDispatchEscalationRule({
      readEpicSnapshot: async () =>
        makeSnapshot({
          currentStage: stage,
          labels: ["pipeline:plan-review", "ship-type:internal"],
          title: "Deferred Bead Test",
        }),
      repoPath: repo,
      actionUrl: "http://localhost:3000/api/fleet/action",
    });

    // Drive matches() directly with the seeded events so the test does not
    // depend on Reconciler internals (mirrors marker-driven-routing pattern).
    const events = await readEvents(repo);
    const matches = await rule.matches(events, now);
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
    expect(payload.ruleName).toBe(REPEAT_DISPATCH_ESCALATION_RULE_NAME);
    expect(payload.action).toBe("run-coherence-agent");
    expect(payload.refusalCode).toBe("BD_STATUS_DEFERRED");
    expect(payload.failedCheck).toBe("bd-status-not-deferred");
    expect(typeof payload.reason).toBe("string");
    expect(payload.reason as string).toContain("deferred");
  });

  // ==========================================================================
  // AC #2 — Happy path: existing escalation dispatch fetch fires unchanged.
  // ==========================================================================
  test("happy path: open bead → escalation fetch fires unchanged, no refusal event (no behaviour drift)", async () => {
    const repo = await makeRepo();
    const epicId = "factory-core-happy";
    const stage = "plan-review";
    const now = new Date();

    await seedStuckInStageActions(repo, epicId, stage, 3, now.getTime());

    // Open bead — A.5 predicates pass.
    mockReadBeadStatus.mockResolvedValue(
      makeBead({ id: epicId, status: "open" }),
    );
    mockReadMarker.mockResolvedValue(null);
    mockGetEpicLabels.mockResolvedValue(["pipeline:plan-review"]);

    const rule = buildRepeatDispatchEscalationRule({
      readEpicSnapshot: async () =>
        makeSnapshot({
          currentStage: stage,
          labels: ["pipeline:plan-review", "ship-type:internal"],
          title: "Happy Path Test",
        }),
      repoPath: repo,
      actionUrl: "http://localhost:3000/api/fleet/action",
    });

    const events = await readEvents(repo);
    const matches = await rule.matches(events, now);
    expect(matches).toHaveLength(1);

    await rule.act(matches[0]);

    // Escalation fetch fired unchanged.
    expect(fetchCalls).toHaveLength(1);
    const body = fetchCalls[0].body as Record<string, unknown>;
    expect(body.action).toBe("run-coherence-agent");
    expect(body.epicId).toBe(epicId);
    expect(body.anomalyClass).toBe("repeat-dispatch-no-progress");
    const coherenceContext = body.coherenceContext as Record<string, unknown>;
    expect(coherenceContext.stuckStage).toBe(stage);
    expect(coherenceContext.attemptCount).toBe(3);

    // No refusal event for the happy path.
    const refusals = await readEvents(repo, {
      type: "reconciler-action-refused",
    });
    expect(refusals).toHaveLength(0);
  });

  // ==========================================================================
  // AC #3 — Route returns HTTP 412 → log reconciler_dispatch_refused_at_route
  //         event AND return without throwing (architecture § Seam 5).
  // ==========================================================================
  test("route returns HTTP 412 → reconciler-action-refused event with ROUTE_REFUSED_412 code, no throw (defense-in-depth Seam 5)", async () => {
    const repo = await makeRepo();
    const epicId = "factory-core-412";
    const stage = "plan-review";
    const now = new Date();

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

    await seedStuckInStageActions(repo, epicId, stage, 3, now.getTime());

    // Rule-side precondition passes (open bead). The route is the one
    // refusing — defense-in-depth catch.
    mockReadBeadStatus.mockResolvedValue(
      makeBead({ id: epicId, status: "open" }),
    );
    mockReadMarker.mockResolvedValue(null);
    mockGetEpicLabels.mockResolvedValue(["pipeline:plan-review"]);

    const rule = buildRepeatDispatchEscalationRule({
      readEpicSnapshot: async () =>
        makeSnapshot({
          currentStage: stage,
          labels: ["pipeline:plan-review"],
          title: "412 Defense-in-Depth Test",
        }),
      repoPath: repo,
      actionUrl: "http://localhost:3000/api/fleet/action",
    });

    const events = await readEvents(repo);
    const matches = await rule.matches(events, now);
    expect(matches).toHaveLength(1);

    // Must NOT throw — 412 is a refusal, not a failure.
    await expect(rule.act(matches[0])).resolves.toBeUndefined();

    // Fetch DID fire (the route is the gate that refused).
    expect(fetchCalls).toHaveLength(1);

    // Refusal event recorded with the route-side discriminator.
    const refusals = await readEvents(repo, {
      type: "reconciler-action-refused",
    });
    expect(refusals).toHaveLength(1);
    const payload = refusals[0].payload as Record<string, unknown>;
    expect(payload.ruleName).toBe(REPEAT_DISPATCH_ESCALATION_RULE_NAME);
    expect(payload.action).toBe("run-coherence-agent");
    expect(payload.refusalCode).toBe("ROUTE_REFUSED_412");
    expect(payload.failedCheck).toBe("route-side-precondition");
    expect(typeof payload.reason).toBe("string");
  });
});
