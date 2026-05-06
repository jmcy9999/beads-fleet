// =============================================================================
// Tests for beads_web-ehp.9 — repeated-qa-round × dispatch-preconditions
// integration (Wave 4).
//
// Coverage:
//   1. Class B QA_ROUND_OUT_OF_ORDER refusal: bead has qa:round-3 label
//      (currentQaRound=3) but the latest QA-round marker is non-success
//      (round 2 ended with status=failure) → predicate fires, addLabelsToEpic
//      NOT called, reconciler-action-refused event recorded.
//   2. Happy path: bead is in a coherent QA-round state → existing
//      addLabelsToEpic call fires unchanged (no behaviour drift).
//   3. HTTP 412 handling — DOCUMENTED N/A. The bead's AC #3 is structurally
//      not applicable: this rule's act() does not perform any HTTP fetch
//      (its only side effect is addLabelsToEpic). The 412 path landed in
//      ehp.4 because marker-driven-routing.ts DOES fetch /api/fleet/action;
//      repeated-qa-round.ts does not. Surfaced as a deviations_from_ac
//      entry in the ehp.9 marker per the STOP-and-surface discipline
//      (precedent: beads_web-1nm 2026-05-01). A skipped test with an
//      explanatory message documents the gap at the test boundary so
//      future readers see it without re-deriving the conclusion.
//
// Mock pattern: jest.mock the published reader interfaces consumed by
// buildDispatchContext (bead-status-reader, marker-reader, pipeline-labels)
// so the integration test drives the precondition library through the
// rule's act() without standing up a real bd repo. The dispatch-
// preconditions.integration.test.ts already covers the real-bd path
// end-to-end; here we verify the WIRING is correct.
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

// pipeline-labels carries TWO callers in this test path:
//   - getEpicLabels  (consumed by buildDispatchContext)
//   - addLabelsToEpic (called by repeated-qa-round.act() on the happy path)
// Both are mocked so the integration test asserts their (non-)invocation.
const addLabelsMock = jest.fn();
jest.mock("@/lib/pipeline-labels", () => ({
  addLabelsToEpic: (id: string, labels: string[]) => addLabelsMock(id, labels),
  removeLabelsFromEpic: jest.fn().mockResolvedValue(undefined),
  getEpicLabels: jest.fn(),
}));

import { Reconciler } from "@/lib/reconciler";
import { readEvents } from "@/lib/event-log";
import {
  buildRepeatedQaRoundRule,
  REPEATED_QA_ROUND_RULE_NAME,
  type EpicSnapshot,
} from "@/lib/reconciler-rules/repeated-qa-round";
import type { MarkerData } from "@/lib/marker-reader";
import type { BeadSnapshot } from "@/lib/bead-status-reader";
import { readBeadStatus } from "@/lib/bead-status-reader";
import { readMarker } from "@/lib/marker-reader";
import { getEpicLabels } from "@/lib/pipeline-labels";
import { appendEvent } from "@/lib/event-log";

const mockReadBeadStatus = readBeadStatus as jest.MockedFunction<
  typeof readBeadStatus
>;
const mockReadMarker = readMarker as jest.MockedFunction<typeof readMarker>;
const mockGetEpicLabels = getEpicLabels as jest.MockedFunction<
  typeof getEpicLabels
>;

// ---- Helpers --------------------------------------------------------------

async function makeRepo(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "ehp9-test-"));
}

/**
 * Create the per-epic plan file fixture at `<repo>/.beads/plans/<epicId>.md`.
 * The Class A `plan-file-exists` predicate registers for `qa-fix-and-retest`
 * (the action this rule passes to `evaluatePreconditions`); without the
 * plan file the universal A precondition fires PLAN_FILE_MISSING BEFORE
 * Class B's `qa-round-monotonic` is reached, which would mask the test's
 * intent. Callers should invoke this helper before `rec.tick()` for any
 * scenario that expects the precondition library to reach Class B/C/D/E.
 */
async function seedPlanFile(repo: string, epicId: string): Promise<void> {
  const planDir = path.join(repo, ".beads", "plans");
  await fs.mkdir(planDir, { recursive: true });
  await fs.writeFile(
    path.join(planDir, `${epicId}.md`),
    `# Plan for ${epicId}\n\n(integration-test fixture)\n`,
    "utf-8",
  );
}

function makeBead(overrides: Partial<BeadSnapshot> = {}): BeadSnapshot {
  return {
    id: "factory-core-test",
    status: "open",
    labels: [],
    type: "epic",
    pipelineStage: "qa",
    currentQaRound: null,
    currentWave: null,
    hasAgentRunning: false,
    hasReviewNeedsHuman: false,
    ...overrides,
  };
}

function snap(partial: Partial<EpicSnapshot> = {}): EpicSnapshot {
  return {
    currentStage: "qa",
    highestQaRound: 5,
    openBugCount: 3,
    hasNeedsHuman: false,
    labels: ["pipeline:qa", "qa:round-5"],
    title: "test-epic",
    ...partial,
  };
}

async function seedEvent(repo: string, epicId: string): Promise<void> {
  await appendEvent(repo, {
    type: "agent-exited",
    epicId,
    stage: "qa",
    payload: { exitCode: 0 },
  });
}

// ---- Tests ----------------------------------------------------------------

describe("repeated-qa-round × dispatch-preconditions integration (beads_web-ehp.9)", () => {
  beforeEach(() => {
    addLabelsMock.mockReset();
    addLabelsMock.mockResolvedValue(undefined);
    mockReadBeadStatus.mockReset();
    mockReadMarker.mockReset();
    mockGetEpicLabels.mockReset();
    // Sane defaults — explicit per-test overrides supersede.
    mockReadMarker.mockResolvedValue(null);
    mockGetEpicLabels.mockResolvedValue([]);
  });

  // ==========================================================================
  // AC #1 — Class B QA_ROUND_OUT_OF_ORDER refusal.
  //
  // Setup: bead has qa:round-3 label (currentQaRound=3) and the latest QA-
  // round marker (returned by mocked readMarker) reports stage="qa" with
  // status="failure" — i.e., round 2 (the most recent completed round) did
  // not end with status=success. The Class B `qa-round-monotonic` predicate
  // refuses the conceptual round-N+1 dispatch with QA_ROUND_OUT_OF_ORDER.
  //
  // Expected: addLabelsToEpic NOT called; reconciler-action-refused event
  // recorded with refusalCode='QA_ROUND_OUT_OF_ORDER' + ruleName=
  // 'repeated-qa-round' + action='qa-fix-and-retest'.
  //
  // Test verification anchor for the marker `what_was_tested` field:
  // __tests__/lib/reconciler-rules/repeated-qa-round.precondition-integration.test.ts:THIS_LINE
  // ==========================================================================
  test("QA_ROUND_OUT_OF_ORDER: latest QA-round marker is non-success → refusal, no label-add", async () => {
    const repo = await makeRepo();
    const epicId = "factory-core-stuck-qa";

    // The bead-status reader returns a snapshot with currentQaRound=3 (the
    // qa:round-3 label is present). Class B predicate requires
    // currentQaRound >= 1 to fire.
    mockReadBeadStatus.mockResolvedValue(
      makeBead({
        id: epicId,
        status: "open",
        labels: ["pipeline:qa", "qa:round-3"],
        currentQaRound: 3,
      }),
    );
    // The QA-round marker (loaded into ctx.marker by buildDispatchContext)
    // is identified as a QA-round marker via stage="qa" AND its status is
    // not "success" — Class B fires.
    mockReadMarker.mockResolvedValue({
      version: "1",
      bead_id: `${epicId}-qa-round-2`,
      status: "failure",
      stage: "qa",
      started_at: "2026-05-06T00:00:00Z",
      exited_at: "2026-05-06T00:30:00Z",
    } as MarkerData);
    mockGetEpicLabels.mockResolvedValue(["pipeline:qa", "qa:round-3"]);

    await seedEvent(repo, epicId);
    await seedPlanFile(repo, epicId); // bypass Class A PLAN_FILE_MISSING
    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildRepeatedQaRoundRule({
        // Branch 1 (zsjv.3) fires: round >= 5 + open bugs > 0.
        readEpicSnapshot: async () =>
          snap({
            highestQaRound: 5,
            openBugCount: 3,
            labels: ["pipeline:qa", "qa:round-5"],
          }),
        repoPath: repo,
      }),
    );

    await rec.tick();

    // Load-bearing assertion — addLabelsToEpic was NOT called.
    expect(addLabelsMock).not.toHaveBeenCalled();

    // Refusal event was written to the event log with the canonical
    // payload shape.
    const refusals = await readEvents(repo, {
      type: "reconciler-action-refused",
    });
    expect(refusals).toHaveLength(1);
    const payload = refusals[0].payload as Record<string, unknown>;
    expect(payload.ruleName).toBe(REPEATED_QA_ROUND_RULE_NAME);
    expect(payload.action).toBe("qa-fix-and-retest");
    expect(payload.refusalCode).toBe("QA_ROUND_OUT_OF_ORDER");
    expect(payload.failedCheck).toBe("qa-round-monotonic");
    expect(typeof payload.reason).toBe("string");
    expect(refusals[0].epicId).toBe(epicId);
    expect(refusals[0].stage).toBe("qa");
  });

  // ==========================================================================
  // AC #2 — Happy path: existing addLabelsToEpic call fires unchanged.
  //
  // Setup: open bead, no QA-round marker loaded (mocked readMarker returns
  // null). The Class B predicate falls open per its v1 limitation
  // (no marker → ok=true). All universal predicates (A.5 + C) pass.
  // Expected: addLabelsToEpic called with ['review:needs-human'], no
  // refusal event.
  // ==========================================================================
  test("happy path: open bead + no incoherent marker → addLabelsToEpic fires unchanged", async () => {
    const repo = await makeRepo();
    const epicId = "factory-core-happy-qa";

    mockReadBeadStatus.mockResolvedValue(
      makeBead({
        id: epicId,
        status: "open",
        labels: ["pipeline:qa", "qa:round-5"],
        currentQaRound: 5,
      }),
    );
    // No marker loaded → Class B predicate falls open per its v1
    // limitation (no marker → ok=true).
    mockReadMarker.mockResolvedValue(null);
    mockGetEpicLabels.mockResolvedValue(["pipeline:qa", "qa:round-5"]);

    await seedEvent(repo, epicId);
    await seedPlanFile(repo, epicId); // bypass Class A PLAN_FILE_MISSING
    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildRepeatedQaRoundRule({
        readEpicSnapshot: async () =>
          snap({
            highestQaRound: 5,
            openBugCount: 3,
            labels: ["pipeline:qa", "qa:round-5"],
          }),
        repoPath: repo,
      }),
    );

    await rec.tick();

    // addLabelsToEpic fired with the expected label set.
    expect(addLabelsMock).toHaveBeenCalledTimes(1);
    expect(addLabelsMock).toHaveBeenCalledWith(epicId, ["review:needs-human"]);

    // No refusal event for the happy path.
    const refusals = await readEvents(repo, {
      type: "reconciler-action-refused",
    });
    expect(refusals).toHaveLength(0);
  });

  // Additional defense-in-depth: when the bead is loaded as an explicit
  // QA-round marker with status="success", the predicate also passes.
  test("happy path (explicit success marker): QA-round marker status=success → addLabelsToEpic fires", async () => {
    const repo = await makeRepo();
    const epicId = "factory-core-success-marker";

    mockReadBeadStatus.mockResolvedValue(
      makeBead({
        id: epicId,
        status: "open",
        labels: ["pipeline:qa", "qa:round-5"],
        currentQaRound: 5,
      }),
    );
    mockReadMarker.mockResolvedValue({
      version: "1",
      bead_id: `${epicId}-qa-round-4`,
      status: "success",
      stage: "qa",
      started_at: "2026-05-06T00:00:00Z",
      exited_at: "2026-05-06T00:30:00Z",
    } as MarkerData);
    mockGetEpicLabels.mockResolvedValue(["pipeline:qa", "qa:round-5"]);

    await seedEvent(repo, epicId);
    await seedPlanFile(repo, epicId); // bypass Class A PLAN_FILE_MISSING
    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildRepeatedQaRoundRule({
        readEpicSnapshot: async () =>
          snap({
            highestQaRound: 5,
            openBugCount: 3,
            labels: ["pipeline:qa", "qa:round-5"],
          }),
        repoPath: repo,
      }),
    );

    await rec.tick();

    expect(addLabelsMock).toHaveBeenCalledTimes(1);
    expect(addLabelsMock).toHaveBeenCalledWith(epicId, ["review:needs-human"]);

    const refusals = await readEvents(repo, {
      type: "reconciler-action-refused",
    });
    expect(refusals).toHaveLength(0);
  });

  // ==========================================================================
  // AC #3 — DOCUMENTED N/A. The bead description's "Route returns 412 → log
  // + return without throwing" AC is structurally not applicable: this
  // rule's act() does not perform any HTTP fetch. The 412 path landed in
  // beads_web-ehp.4 because marker-driven-routing.ts DOES fetch /api/fleet/
  // action; repeated-qa-round.ts has no fetch. Surfaced as a deviation
  // in the ehp.9 marker per the STOP-and-surface discipline.
  //
  // The skipped test below pins the documentation at the test boundary so
  // a future reader sees the rationale without re-deriving it.
  // ==========================================================================
  test.skip("AC #3 (HTTP 412): N/A — repeated-qa-round.act() does not perform HTTP fetch (see marker deviations_from_ac)", () => {
    // Structural N/A. If this rule grows an HTTP fetch in the future, lift
    // the 412-handling pattern from marker-driven-routing.ts (lines
    // 458-477 of commit 6bda934) and reactivate this test.
  });

  // --------------------------------------------------------------------------
  // Backwards-compat: legacy callers that do NOT pass repoPath skip the
  // gate and retain their unconditional label-add semantics. This test
  // pins the documented opt-in behaviour so a future refactor that
  // tightens the gate (makes repoPath required) is a deliberate decision
  // visible in the test diff.
  // --------------------------------------------------------------------------
  test("legacy: rule without repoPath skips the gate and falls back to unconditional addLabelsToEpic", async () => {
    const repo = await makeRepo();
    const epicId = "factory-core-legacy-skip";

    // Even with a hostile bead-status reader (would refuse via A.5 if the
    // gate ran), the legacy path is unaffected.
    mockReadBeadStatus.mockResolvedValue(
      makeBead({ id: epicId, status: "deferred" }),
    );

    await seedEvent(repo, epicId);
    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildRepeatedQaRoundRule({
        readEpicSnapshot: async () =>
          snap({
            highestQaRound: 5,
            openBugCount: 3,
            labels: ["pipeline:qa", "qa:round-5"],
          }),
        // NB: no repoPath — gate is skipped by design.
      }),
    );

    await rec.tick();

    expect(addLabelsMock).toHaveBeenCalledTimes(1);
    expect(addLabelsMock).toHaveBeenCalledWith(epicId, ["review:needs-human"]);

    const refusals = await readEvents(repo, {
      type: "reconciler-action-refused",
    });
    expect(refusals).toHaveLength(0);
  });
});
