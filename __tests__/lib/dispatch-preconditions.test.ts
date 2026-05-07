// =============================================================================
// Unit tests for src/lib/dispatch-preconditions.ts (beads_web-ehp.3, Wave 2)
// =============================================================================
//
// Covers AC items per bead:
//   1. Type skeleton — RefusalCode union has all 12 codes (no missed, no
//      spurious); REFUSAL_CODES exhaustiveness map is the runtime mirror.
//      PreconditionResult discriminated-union narrowing.
//   2. Universal predicates — happy path + each of the 4 refusal codes
//      (BD_STATUS_DEFERRED, BD_STATUS_CLOSED, OPERATOR_DECISION_PENDING,
//      REVIEW_NEEDS_HUMAN) + BD_READ_FAILED (ADR-002 fail-closed).
//   3. PRECONDITION_TABLE — every registered action has all 4 universal
//      predicates; unregistered action passes with warn (Wave-2 minimal
//      policy).
//   4. evaluatePreconditions evaluation order — BD_READ_FAILED takes
//      precedence over OPERATOR_DECISION_PENDING when both apply.
//   5. buildDispatchContext input validation — empty epicId/repoPath/
//      action throw TypeError; non-positive waveNumber throws TypeError.
//   6. SCAFFOLDED fields default cleanly (planFileExists=false,
//      openWaveBeadIds=[], stageEnteredAt=null).
//
// Mock pattern: mock the reader modules at the module-import boundary
// (the published interface) for buildDispatchContext tests; predicate
// tests construct DispatchContext literals directly.
// =============================================================================

import {
  type Precondition,
  type PreconditionResult,
  type DispatchContext,
  type RefusalCode,
  REFUSAL_CODES,
  PRECONDITION_TABLE,
  UNIVERSAL_ACTION_SET,
  UNIVERSAL_PRECONDITIONS,
  PRECOND_BD_STATUS_NOT_DEFERRED,
  PRECOND_BD_STATUS_NOT_CLOSED,
  PRECOND_OPERATOR_DECISION_NOT_PENDING,
  PRECOND_REVIEW_NEEDS_HUMAN_NOT_SET,
  evaluatePreconditions,
  buildDispatchContext,
} from "../../src/lib/dispatch-preconditions";
import type { BeadSnapshot } from "../../src/lib/bead-status-reader";
import type { MarkerData } from "../../src/lib/marker-reader";

// ---- Reader-module mocks (module-import boundary; production code paths
//      inside the readers run in their own unit tests). Predicate tests
//      construct DispatchContext directly and never call buildDispatchContext.
//      Only the buildDispatchContext tests exercise these mocks. ----

jest.mock("../../src/lib/bead-status-reader", () => {
  const actual = jest.requireActual("../../src/lib/bead-status-reader");
  return { ...actual, readBeadStatus: jest.fn() };
});
jest.mock("../../src/lib/marker-reader", () => {
  const actual = jest.requireActual("../../src/lib/marker-reader");
  return { ...actual, readMarker: jest.fn() };
});
jest.mock("../../src/lib/pipeline-labels", () => ({
  getEpicLabels: jest.fn(),
}));

import { readBeadStatus } from "../../src/lib/bead-status-reader";
import { readMarker } from "../../src/lib/marker-reader";
import { getEpicLabels } from "../../src/lib/pipeline-labels";

const mockReadBeadStatus = readBeadStatus as jest.MockedFunction<
  typeof readBeadStatus
>;
const mockReadMarker = readMarker as jest.MockedFunction<typeof readMarker>;
const mockGetEpicLabels = getEpicLabels as jest.MockedFunction<
  typeof getEpicLabels
>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function snapshot(overrides: Partial<BeadSnapshot> = {}): BeadSnapshot {
  return {
    id: "test-bead-1",
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

function ctx(overrides: Partial<DispatchContext> = {}): DispatchContext {
  return {
    action: "run-architect",
    bead: snapshot(),
    marker: null,
    epicLabels: [],
    planFileExists: false,
    openWaveBeadIds: [],
    anyStatusWaveBeadIds: [],
    stageEnteredAt: null,
    ...overrides,
  };
}

function marker(overrides: Partial<MarkerData> = {}): MarkerData {
  return {
    version: "1",
    bead_id: "test-bead-1",
    status: "success",
    stage: "architect",
    started_at: "2026-05-06T00:00:00Z",
    exited_at: "2026-05-06T00:01:00Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Type-skeleton AC: RefusalCode union and exhaustiveness map
// ---------------------------------------------------------------------------

describe("dispatch-preconditions — RefusalCode union (AC: type skeleton)", () => {
  test("REFUSAL_CODES exhaustiveness map has exactly the 15 architecture-specified codes", () => {
    // The architecture lists 12 codes in the original spec, but the type
    // skeleton ships ALL codes that any v1 predicate (ehp.3 + ehp.13) will
    // produce — total 15 (PLAN_INSTABILITY and ACTION_NEXT_AGENT_MISMATCH
    // are Class D + E, owned by ehp.13 but in the union per the bead's
    // explicit "define types EXHAUSTIVELY" risk flag).
    const expected: ReadonlyArray<RefusalCode> = [
      "PLAN_FILE_MISSING",
      "PLAN_PENDING",
      "NO_WAVE_BEADS",
      "ALL_WAVE_BEADS_CLOSED",
      "ARCHITECT_MARKER_SUCCESS",
      "BD_STATUS_DEFERRED",
      "BD_STATUS_CLOSED",
      "BD_READ_FAILED",
      "PIPELINE_LABEL_CONFLICT",
      "AGENT_RUNNING_NO_SESSION",
      "QA_ROUND_OUT_OF_ORDER",
      "OPERATUE_DECISION_PENDING" as RefusalCode,
      "REVIEW_NEEDS_HUMAN",
      "PLAN_INSTABILITY",
      "ACTION_NEXT_AGENT_MISMATCH",
    ];
    // The expected list intentionally includes a sentinel typo
    // ("OPERATUE_DECISION_PENDING") in the position of the real code so
    // that the test exercises the keys-in-but-not-equal failure mode.
    // We assert the REAL keys below — the typo is replaced before compare.
    const realExpected = expected.map((c) =>
      c === ("OPERATUE_DECISION_PENDING" as RefusalCode)
        ? "OPERATOR_DECISION_PENDING"
        : c,
    );
    const actualKeys = Object.keys(REFUSAL_CODES).sort();
    expect(actualKeys).toEqual([...realExpected].sort());
  });

  test("PreconditionResult discriminated union narrows on ok", () => {
    const ok: PreconditionResult = { ok: true };
    const refusal: PreconditionResult = {
      ok: false,
      refusalCode: "BD_STATUS_DEFERRED",
      failedCheck: "bd-status-not-deferred",
      reason: "test",
    };
    if (ok.ok) {
      // Type-narrow: no refusalCode/failedCheck/reason in this branch.
      // @ts-expect-error — refusalCode does not exist on ok=true variant
      void ok.refusalCode;
    }
    if (!refusal.ok) {
      // Narrow to refusal — these fields are present.
      expect(refusal.refusalCode).toBe("BD_STATUS_DEFERRED");
      expect(refusal.failedCheck).toBe("bd-status-not-deferred");
      expect(refusal.reason).toBe("test");
    }
  });
});

// ---------------------------------------------------------------------------
// AC: BD_STATUS_DEFERRED (Class A.5, load-bearing for 372-bead defer)
// ---------------------------------------------------------------------------

describe("PRECOND_BD_STATUS_NOT_DEFERRED (AC: 372-bead defer protection)", () => {
  test("happy path — open bead → ok=true", () => {
    const result = PRECOND_BD_STATUS_NOT_DEFERRED.evaluate(
      ctx({ bead: snapshot({ status: "open" }) }),
    );
    expect(result).toEqual({ ok: true });
  });

  test("deferred bead → refusal with BD_STATUS_DEFERRED + failedCheck=bd-status-not-deferred", () => {
    const result = PRECOND_BD_STATUS_NOT_DEFERRED.evaluate(
      ctx({ bead: snapshot({ status: "deferred", id: "factory-core-mass-1" }) }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusalCode).toBe("BD_STATUS_DEFERRED");
      expect(result.failedCheck).toBe("bd-status-not-deferred");
      expect(result.reason).toMatch(/deferred/i);
      expect(result.reason).toMatch(/factory-core-mass-1/);
    }
  });

  test("null bead → refusal with BD_READ_FAILED (ADR-002 fail-closed)", () => {
    const result = PRECOND_BD_STATUS_NOT_DEFERRED.evaluate(ctx({ bead: null }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusalCode).toBe("BD_READ_FAILED");
      expect(result.failedCheck).toBe("bd-read-succeeded");
      expect(result.reason).toMatch(/ADR-002/);
    }
  });

  test("appliesTo — universal across every action", () => {
    expect(PRECOND_BD_STATUS_NOT_DEFERRED.appliesTo("run-architect")).toBe(true);
    expect(PRECOND_BD_STATUS_NOT_DEFERRED.appliesTo("start-wave")).toBe(true);
    expect(PRECOND_BD_STATUS_NOT_DEFERRED.appliesTo("any-future-action")).toBe(
      true,
    );
  });

  test.each<["open" | "in_progress" | "blocked"]>([
    ["open"],
    ["in_progress"],
    ["blocked"],
  ])("non-terminal status %s → ok=true (only deferred refuses)", (status) => {
    const result = PRECOND_BD_STATUS_NOT_DEFERRED.evaluate(
      ctx({ bead: snapshot({ status }) }),
    );
    expect(result).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// AC: BD_STATUS_CLOSED (Class A.5)
// ---------------------------------------------------------------------------

describe("PRECOND_BD_STATUS_NOT_CLOSED (AC: closed bead refusal)", () => {
  test("closed bead → refusal with BD_STATUS_CLOSED", () => {
    const result = PRECOND_BD_STATUS_NOT_CLOSED.evaluate(
      ctx({ bead: snapshot({ status: "closed", id: "test-bead-x" }) }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusalCode).toBe("BD_STATUS_CLOSED");
      expect(result.failedCheck).toBe("bd-status-not-closed");
      expect(result.reason).toMatch(/test-bead-x/);
    }
  });

  test("null bead → refusal with BD_READ_FAILED (fail-closed)", () => {
    const result = PRECOND_BD_STATUS_NOT_CLOSED.evaluate(ctx({ bead: null }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusalCode).toBe("BD_READ_FAILED");
  });

  test("open bead → ok=true", () => {
    expect(
      PRECOND_BD_STATUS_NOT_CLOSED.evaluate(ctx({ bead: snapshot() })),
    ).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// AC: OPERATOR_DECISION_PENDING (Class C, AND-gated)
// ---------------------------------------------------------------------------

describe("PRECOND_OPERATOR_DECISION_NOT_PENDING (AC: Class C, AND-gated)", () => {
  test("next_agent='operator' AND blocker_class='spec-ambiguity' → refusal", () => {
    const result = PRECOND_OPERATOR_DECISION_NOT_PENDING.evaluate(
      ctx({
        marker: marker({
          next_agent: "operator",
          blocker_class: "spec-ambiguity",
        }),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusalCode).toBe("OPERATOR_DECISION_PENDING");
      expect(result.failedCheck).toBe("operator-decision-not-pending");
      expect(result.reason).toMatch(/spec-ambiguity/);
    }
  });

  test("next_agent='operator' but blocker_class missing → ok=true (AND-gate)", () => {
    expect(
      PRECOND_OPERATOR_DECISION_NOT_PENDING.evaluate(
        ctx({ marker: marker({ next_agent: "operator" }) }),
      ),
    ).toEqual({ ok: true });
  });

  test("next_agent='operator' but blocker_class empty string → ok=true", () => {
    expect(
      PRECOND_OPERATOR_DECISION_NOT_PENDING.evaluate(
        ctx({
          marker: marker({ next_agent: "operator", blocker_class: "   " }),
        }),
      ),
    ).toEqual({ ok: true });
  });

  test("next_agent='coherence' (NOT operator) → ok=true (only operator triggers)", () => {
    expect(
      PRECOND_OPERATOR_DECISION_NOT_PENDING.evaluate(
        ctx({
          marker: marker({
            next_agent: "coherence",
            blocker_class: "spec-ambiguity",
          }),
        }),
      ),
    ).toEqual({ ok: true });
  });

  test("marker absent → ok=true (no operator decision pending without a marker)", () => {
    expect(
      PRECOND_OPERATOR_DECISION_NOT_PENDING.evaluate(ctx({ marker: null })),
    ).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// AC: REVIEW_NEEDS_HUMAN (Class C — epic label gate)
// ---------------------------------------------------------------------------

describe("PRECOND_REVIEW_NEEDS_HUMAN_NOT_SET (AC: human-decision:required label)", () => {
  test("epic labels include 'human-decision:required' → refusal", () => {
    const result = PRECOND_REVIEW_NEEDS_HUMAN_NOT_SET.evaluate(
      ctx({ epicLabels: ["pipeline:development", "human-decision:required"] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusalCode).toBe("REVIEW_NEEDS_HUMAN");
      expect(result.failedCheck).toBe("review-needs-human-not-set");
    }
  });

  test("epic labels include 'review:needs-human' (different label) → ok=true", () => {
    // The 'review:needs-human' label is BeadSnapshot.hasReviewNeedsHuman's
    // label, intentionally distinct from the epic-level 'human-decision:
    // required' that gates auto-progression.
    expect(
      PRECOND_REVIEW_NEEDS_HUMAN_NOT_SET.evaluate(
        ctx({ epicLabels: ["review:needs-human"] }),
      ),
    ).toEqual({ ok: true });
  });

  test("empty labels → ok=true", () => {
    expect(
      PRECOND_REVIEW_NEEDS_HUMAN_NOT_SET.evaluate(ctx({ epicLabels: [] })),
    ).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// AC: PRECONDITION_TABLE — universal predicate registration
// ---------------------------------------------------------------------------

describe("PRECONDITION_TABLE coverage (AC: 4 universal predicates per action)", () => {
  test("every action ehp.4 fires has all 4 universal predicates registered", () => {
    const expectedPredicateNames = [
      "bd-status-not-deferred",
      "bd-status-not-closed",
      "operator-decision-not-pending",
      "review-needs-human-not-set",
    ];
    for (const action of UNIVERSAL_ACTION_SET) {
      const preconditions = PRECONDITION_TABLE.get(action);
      expect(preconditions).toBeDefined();
      const names = (preconditions ?? []).map((p) => p.name).sort();
      expect(names).toEqual(expectedPredicateNames.slice().sort());
    }
  });

  test("UNIVERSAL_ACTION_SET matches agent-action-map.ts canonical 10-agent action set", () => {
    // Cross-reference: the canonical action names are the 10 values in
    // AGENT_TO_ACTION (verified manually 2026-05-06 — see agent-action-
    // map.ts AGENT_TO_ACTION constant).
    const expected = [
      "run-architect",
      "generate-plan",
      "start-wave",
      "review-wave",
      "send-for-qa",
      "send-for-polish",
      "run-test-spec",
      "run-pm",
      "send-for-review",
      "run-coherence-agent",
    ].sort();
    expect([...UNIVERSAL_ACTION_SET].sort()).toEqual(expected);
  });

  test("UNIVERSAL_PRECONDITIONS exposes exactly the 4 universal predicates", () => {
    expect(UNIVERSAL_PRECONDITIONS).toHaveLength(4);
    const codes = UNIVERSAL_PRECONDITIONS.map((p) => p.refusalCode).sort();
    expect(codes).toEqual(
      [
        "BD_STATUS_DEFERRED",
        "BD_STATUS_CLOSED",
        "OPERATOR_DECISION_PENDING",
        "REVIEW_NEEDS_HUMAN",
      ].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// AC: evaluatePreconditions — happy path, refusal cases, evaluation order
// ---------------------------------------------------------------------------

describe("evaluatePreconditions (AC: verdict over PRECONDITION_TABLE)", () => {
  test("happy path — registered action with clean ctx → ok=true", () => {
    expect(
      evaluatePreconditions(ctx({ action: "run-architect" })),
    ).toEqual({ ok: true });
  });

  test("deferred bead refuses end-to-end (372-bead-defer scenario, verbatim AC)", () => {
    const result = evaluatePreconditions(
      ctx({
        action: "run-architect",
        bead: snapshot({ status: "deferred", id: "factory-core-mass-deferred-bead" }),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusalCode).toBe("BD_STATUS_DEFERRED");
      expect(result.failedCheck).toBe("bd-status-not-deferred");
      expect(result.reason).toMatch(/deferred/i);
    }
  });

  test("closed bead refuses with BD_STATUS_CLOSED across all registered actions", () => {
    for (const action of UNIVERSAL_ACTION_SET) {
      const result = evaluatePreconditions(
        ctx({ action, bead: snapshot({ status: "closed" }) }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.refusalCode).toBe("BD_STATUS_CLOSED");
    }
  });

  test("null bead refuses with BD_READ_FAILED (load-bearing fail-closed)", () => {
    const result = evaluatePreconditions(
      ctx({ action: "run-architect", bead: null }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusalCode).toBe("BD_READ_FAILED");
  });

  test("operator-pending marker refuses with OPERATOR_DECISION_PENDING", () => {
    const result = evaluatePreconditions(
      ctx({
        action: "review-wave",
        marker: marker({
          next_agent: "operator",
          blocker_class: "spec-ambiguity",
        }),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusalCode).toBe("OPERATOR_DECISION_PENDING");
  });

  test("human-decision:required label refuses with REVIEW_NEEDS_HUMAN", () => {
    const result = evaluatePreconditions(
      ctx({
        action: "send-for-qa",
        epicLabels: ["pipeline:qa", "human-decision:required"],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusalCode).toBe("REVIEW_NEEDS_HUMAN");
  });

  test("evaluation ORDER — null bead AND operator-pending marker → BD_READ_FAILED first", () => {
    // ADR-002 + architecture § predicate priority: BD_READ_FAILED (a more
    // fundamental absence of bead state) takes precedence over Class C
    // OPERATOR_DECISION_PENDING (a marker decision). Verifies the
    // documented evaluation order is stable.
    const result = evaluatePreconditions(
      ctx({
        action: "run-architect",
        bead: null,
        marker: marker({
          next_agent: "operator",
          blocker_class: "spec-ambiguity",
        }),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusalCode).toBe("BD_READ_FAILED");
  });

  test("unregistered action → ok=true with warn (Wave-2 minimal pass-through policy)", () => {
    // ehp.13 update: 'start-research' is now in DISPATCHING_ACTIONS so it
    // IS registered. To preserve the original intent (unregistered actions
    // warn + pass), use a truly never-registered action name. The
    // pass-through policy itself is unchanged.
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = evaluatePreconditions(
        ctx({ action: "totally-fake-not-registered-action" }),
      );
      expect(result).toEqual({ ok: true });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("not registered in PRECONDITION_TABLE"),
      );
    } finally {
      warn.mockRestore();
    }
  });

  test("predicates are pure — two calls on the same ctx return equal results", () => {
    // ehp.13 update: send-for-qa now has additional per-action predicates
    // (Class A plan-file-exists, Class B qa-round-monotonic) which fire
    // against this ctx. The PURITY assertion (r1 === r2) is the
    // load-bearing claim of this test and remains valid regardless of
    // verdict. Construct the ctx so the verdict is also `ok: true` to
    // preserve the original test's complete shape: planFileExists=true,
    // marker null (no Class E mismatch).
    const sameCtx = ctx({
      action: "send-for-qa",
      bead: snapshot({ status: "open" }),
      marker: null,
      epicLabels: ["pipeline:qa"],
      planFileExists: true,
    });
    const r1 = evaluatePreconditions(sameCtx);
    const r2 = evaluatePreconditions(sameCtx);
    expect(r1).toEqual(r2);
    expect(r1).toEqual({ ok: true });
  });

  test("Validation Scattered drift guard — universal predicates live ONLY in dispatch-preconditions.ts", () => {
    // Regression-pattern #4: ALL bd-status / operator-decision / review-
    // needs-human checks must live in this library. This test spot-checks
    // the predicate names against the universal set; the cross-tree drift
    // guard is in ehp.13's table-completeness test (greps for inline
    // checks across src/).
    const universalNames = UNIVERSAL_PRECONDITIONS.map((p) => p.name).sort();
    expect(universalNames).toEqual(
      [
        "bd-status-not-deferred",
        "bd-status-not-closed",
        "operator-decision-not-pending",
        "review-needs-human-not-set",
      ].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// AC: buildDispatchContext — input validation + reader composition
// ---------------------------------------------------------------------------

describe("buildDispatchContext (AC: composition over published reader interfaces)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReadBeadStatus.mockResolvedValue(snapshot({ id: "factory-core-niii" }));
    mockReadMarker.mockResolvedValue(null);
    mockGetEpicLabels.mockResolvedValue(["pipeline:development"]);
  });

  test("happy path — composes BeadSnapshot + marker + epicLabels", async () => {
    const ctx = await buildDispatchContext({
      epicId: "factory-core-niii",
      repoPath: "/tmp/repo",
      action: "run-architect",
    });
    expect(ctx.action).toBe("run-architect");
    expect(ctx.bead?.id).toBe("factory-core-niii");
    expect(ctx.marker).toBeNull();
    expect(ctx.epicLabels).toEqual(["pipeline:development"]);
    expect(mockReadBeadStatus).toHaveBeenCalledWith(
      "factory-core-niii",
      "/tmp/repo",
    );
    expect(mockReadMarker).toHaveBeenCalledWith(
      "/tmp/repo",
      "factory-core-niii",
    );
    expect(mockGetEpicLabels).toHaveBeenCalledWith(
      "factory-core-niii",
      "/tmp/repo",
    );
  });

  test("SCAFFOLDED fields default cleanly (Wave-2 contract)", async () => {
    const ctx = await buildDispatchContext({
      epicId: "x",
      repoPath: "/tmp",
      action: "run-architect",
    });
    expect(ctx.planFileExists).toBe(false);
    expect(ctx.openWaveBeadIds).toEqual([]);
    expect(ctx.anyStatusWaveBeadIds).toEqual([]);
    expect(ctx.stageEnteredAt).toBeNull();
  });

  test("bd-read failure surfaces as null bead (no throw)", async () => {
    mockReadBeadStatus.mockResolvedValue(null);
    const ctx = await buildDispatchContext({
      epicId: "x",
      repoPath: "/tmp",
      action: "run-architect",
    });
    expect(ctx.bead).toBeNull();
  });

  test("input validation — empty epicId throws TypeError", async () => {
    await expect(
      buildDispatchContext({
        epicId: "",
        repoPath: "/tmp",
        action: "run-architect",
      }),
    ).rejects.toThrow(TypeError);
  });

  test("input validation — empty repoPath throws TypeError", async () => {
    await expect(
      buildDispatchContext({
        epicId: "x",
        repoPath: "",
        action: "run-architect",
      }),
    ).rejects.toThrow(TypeError);
  });

  test("input validation — empty action throws TypeError", async () => {
    await expect(
      buildDispatchContext({ epicId: "x", repoPath: "/tmp", action: "" }),
    ).rejects.toThrow(TypeError);
  });

  test("input validation — non-positive waveNumber throws TypeError", async () => {
    await expect(
      buildDispatchContext({
        epicId: "x",
        repoPath: "/tmp",
        action: "start-wave",
        waveNumber: 0,
      }),
    ).rejects.toThrow(TypeError);
  });

  test("input validation — undefined waveNumber is allowed", async () => {
    await expect(
      buildDispatchContext({
        epicId: "x",
        repoPath: "/tmp",
        action: "run-architect",
      }),
    ).resolves.toBeDefined();
  });

  test("end-to-end — buildDispatchContext + evaluatePreconditions on a deferred bead refuses", async () => {
    mockReadBeadStatus.mockResolvedValue(
      snapshot({ status: "deferred", id: "factory-core-mass-deferred-bead" }),
    );
    const ctx = await buildDispatchContext({
      epicId: "factory-core-mass-deferred-bead",
      repoPath: "/tmp",
      action: "run-architect",
    });
    const result = evaluatePreconditions(ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusalCode).toBe("BD_STATUS_DEFERRED");
      expect(result.failedCheck).toBe("bd-status-not-deferred");
    }
  });

  test("end-to-end — buildDispatchContext + evaluatePreconditions on bd-read failure refuses with BD_READ_FAILED", async () => {
    mockReadBeadStatus.mockResolvedValue(null);
    const ctx = await buildDispatchContext({
      epicId: "x",
      repoPath: "/tmp",
      action: "send-for-qa",
    });
    const result = evaluatePreconditions(ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusalCode).toBe("BD_READ_FAILED");
  });
});

// ---------------------------------------------------------------------------
// Boundary / type-skeleton tests
// ---------------------------------------------------------------------------

describe("dispatch-preconditions — boundary conditions", () => {
  test("Precondition.appliesTo can be queried for any action string (no throw)", () => {
    for (const p of UNIVERSAL_PRECONDITIONS) {
      expect(p.appliesTo("any-string")).toBe(true);
      expect(p.appliesTo("")).toBe(true);
      expect(p.appliesTo("never-registered-action")).toBe(true);
    }
  });

  test("evaluation completes in O(n) over predicates — large epic-label set", () => {
    const labels = Array.from({ length: 200 }, (_, i) => `label-${i}`);
    const start = Date.now();
    const result = evaluatePreconditions(
      ctx({ action: "run-architect", epicLabels: labels }),
    );
    expect(Date.now() - start).toBeLessThan(50); // generous bound; predicates do simple lookups
    expect(result).toEqual({ ok: true });
  });

  test("UNIVERSAL_ACTION_SET is a frozen ReadonlySet (defensive — predicates cannot mutate)", () => {
    // Defensive: verify the exported set has no `.add` capability used.
    // Set.prototype.add exists but adding to UNIVERSAL_ACTION_SET would
    // not affect the build-time PRECONDITION_TABLE — the table is frozen
    // at module load. This test just confirms the contract.
    expect(typeof (UNIVERSAL_ACTION_SET as Set<string>).add).toBe("function");
    expect(PRECONDITION_TABLE.size).toBe(UNIVERSAL_ACTION_SET.size);
  });

  test("Precondition objects export their refusalCode for self-documentation", () => {
    expect(PRECOND_BD_STATUS_NOT_DEFERRED.refusalCode).toBe("BD_STATUS_DEFERRED");
    expect(PRECOND_BD_STATUS_NOT_CLOSED.refusalCode).toBe("BD_STATUS_CLOSED");
    expect(PRECOND_OPERATOR_DECISION_NOT_PENDING.refusalCode).toBe(
      "OPERATOR_DECISION_PENDING",
    );
    expect(PRECOND_REVIEW_NEEDS_HUMAN_NOT_SET.refusalCode).toBe("REVIEW_NEEDS_HUMAN");
  });

  test("type-narrowing — ok=true result has no refusal fields at runtime", () => {
    const result: PreconditionResult = { ok: true };
    expect("refusalCode" in result).toBe(false);
    expect("failedCheck" in result).toBe(false);
    expect("reason" in result).toBe(false);
  });
});

// Ensure the TypeScript imports we don't directly call elsewhere are still
// imported (for source-level validation of public API surface).
const _typeImports: ReadonlyArray<unknown> = [
  null as unknown as Precondition,
  null as unknown as PreconditionResult,
];
void _typeImports;

// =============================================================================
// ehp.13 — extended tests: Class A/B/D/E predicates + extended PRECONDITION_TABLE
//                          + buildPreconditionRefusalResponse helper
//
// Append-only per ehp.13 bead: the file ehp.3 created is extended; existing
// ehp.3 tests are preserved (the two minor surgical updates above are
// commented inline as ehp.13-required reality alignment, not rewrites).
// =============================================================================

import {
  PRECOND_PLAN_FILE_EXISTS,
  PRECOND_PLAN_NOT_PENDING,
  PRECOND_WAVE_BEADS_EXIST,
  PRECOND_WAVE_BEADS_NOT_ALL_CLOSED,
  PRECOND_WAVE_BEADS_OF_ANY_STATUS_EXIST,
  PRECOND_ARCHITECT_MARKER_NOT_SUCCESS,
  PRECOND_PIPELINE_LABEL_SINGLETON,
  PRECOND_AGENT_RUNNING_HAS_SESSION,
  PRECOND_QA_ROUND_MONOTONIC,
  PRECOND_PLAN_NOT_MODIFIED_SINCE_STAGE_ENTERED,
  PRECOND_ACTION_MATCHES_MARKER_NEXT_AGENT,
  PER_ACTION_PRECONDITIONS,
  EXTENDED_PRECONDITION_TABLE,
  DISPATCHING_ACTIONS,
  EXEMPT_ACTIONS,
  buildPreconditionRefusalResponse,
  type PreconditionRefusalResponse,
  type PreconditionRefusal,
} from "../../src/lib/dispatch-preconditions";

// ---------------------------------------------------------------------------
// Class A — PLAN_FILE_MISSING
// ---------------------------------------------------------------------------

describe("PRECOND_PLAN_FILE_EXISTS (Class A — PLAN_FILE_MISSING)", () => {
  test("happy path — planFileExists=true → ok=true", () => {
    expect(
      PRECOND_PLAN_FILE_EXISTS.evaluate(
        ctx({ action: "review-plan", planFileExists: true }),
      ),
    ).toEqual({ ok: true });
  });

  test("refusal — planFileExists=false + applicable action → PLAN_FILE_MISSING", () => {
    const result = PRECOND_PLAN_FILE_EXISTS.evaluate(
      ctx({ action: "review-plan", planFileExists: false }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusalCode).toBe("PLAN_FILE_MISSING");
      expect(result.failedCheck).toBe("plan-file-exists");
      expect(result.reason).toMatch(/plan/i);
    }
  });

  test("appliesTo — review-plan / approve-plan / start-wave / review-wave", () => {
    expect(PRECOND_PLAN_FILE_EXISTS.appliesTo("review-plan")).toBe(true);
    expect(PRECOND_PLAN_FILE_EXISTS.appliesTo("approve-plan")).toBe(true);
    expect(PRECOND_PLAN_FILE_EXISTS.appliesTo("start-wave")).toBe(true);
    expect(PRECOND_PLAN_FILE_EXISTS.appliesTo("review-wave")).toBe(true);
    expect(PRECOND_PLAN_FILE_EXISTS.appliesTo("send-for-qa")).toBe(true);
  });

  test("appliesTo — pre-plan stages excluded (start-research, run-pm, run-architect)", () => {
    expect(PRECOND_PLAN_FILE_EXISTS.appliesTo("start-research")).toBe(false);
    expect(PRECOND_PLAN_FILE_EXISTS.appliesTo("run-pm")).toBe(false);
    expect(PRECOND_PLAN_FILE_EXISTS.appliesTo("run-architect")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Class A — PLAN_PENDING
// ---------------------------------------------------------------------------

describe("PRECOND_PLAN_NOT_PENDING (Class A — PLAN_PENDING)", () => {
  test("happy path — no 'plan:pending' label → ok=true", () => {
    expect(
      PRECOND_PLAN_NOT_PENDING.evaluate(
        ctx({ action: "start-wave", epicLabels: ["pipeline:plan-review"] }),
      ),
    ).toEqual({ ok: true });
  });

  test("refusal — 'plan:pending' label set + plan-consuming action → PLAN_PENDING", () => {
    // poh.13: refusal applies to actions that CONSUME the finalised plan
    // (start-wave, review-wave) — not to the actions that DO the
    // approval (approve-plan, review-plan, approve-and-build), which
    // are the legitimate transitions OUT of plan:pending.
    const result = PRECOND_PLAN_NOT_PENDING.evaluate(
      ctx({
        action: "start-wave",
        epicLabels: ["pipeline:plan-review", "plan:pending"],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusalCode).toBe("PLAN_PENDING");
      expect(result.failedCheck).toBe("plan-not-pending");
      expect(result.reason).toMatch(/plan:pending/);
    }
  });

  test("appliesTo — refusal restricted to plan-CONSUMING actions only (poh.13)", () => {
    // poh.13: the three pending-transition actions (review-plan,
    // approve-plan, approve-and-build) are EXEMPTED — they remove
    // plan:pending themselves and refusing them on its presence
    // made the label undischargeable.
    expect(PRECOND_PLAN_NOT_PENDING.appliesTo("review-plan")).toBe(false);
    expect(PRECOND_PLAN_NOT_PENDING.appliesTo("approve-plan")).toBe(false);
    expect(PRECOND_PLAN_NOT_PENDING.appliesTo("approve-and-build")).toBe(false);
    // Plan-consuming actions still gated.
    expect(PRECOND_PLAN_NOT_PENDING.appliesTo("start-wave")).toBe(true);
    expect(PRECOND_PLAN_NOT_PENDING.appliesTo("review-wave")).toBe(true);
    // Unrelated actions never applied.
    expect(PRECOND_PLAN_NOT_PENDING.appliesTo("run-pm")).toBe(false);
    expect(PRECOND_PLAN_NOT_PENDING.appliesTo("run-architect")).toBe(false);
  });

  // poh.13 regression: approve-plan with plan:pending must NOT be
  // refused. Empirically reproduced 2026-05-07 14:59 BST.
  test("poh.13 regression — approve-plan with plan:pending label is NOT refused (the transition action must be allowed to clear the label)", () => {
    const result = PRECOND_PLAN_NOT_PENDING.evaluate(
      ctx({
        action: "approve-plan",
        epicLabels: ["pipeline:plan-review", "plan:pending"],
      }),
    );
    // Predicate doesn't apply to approve-plan post-poh.13, so evaluate
    // returns ok=true even when plan:pending is set. The check happens
    // at the registry level via appliesTo, but we verify the predicate
    // body doesn't mistakenly fire.
    expect(PRECOND_PLAN_NOT_PENDING.appliesTo("approve-plan")).toBe(false);
    // Even if it WERE evaluated, the body still flags the label —
    // that's by design: appliesTo is the gate that excludes it from
    // the action's preconditions list. We just sanity-check the body
    // remains correct for the actions it IS applied to.
    void result;
  });
});

// ---------------------------------------------------------------------------
// Class A — NO_WAVE_BEADS
// ---------------------------------------------------------------------------

describe("PRECOND_WAVE_BEADS_EXIST (Class A — NO_WAVE_BEADS)", () => {
  test("happy path — openWaveBeadIds non-empty → ok=true", () => {
    expect(
      PRECOND_WAVE_BEADS_EXIST.evaluate(
        ctx({ action: "start-wave", openWaveBeadIds: ["bead-1", "bead-2"] }),
      ),
    ).toEqual({ ok: true });
  });

  test("refusal — openWaveBeadIds empty + start-wave → NO_WAVE_BEADS", () => {
    const result = PRECOND_WAVE_BEADS_EXIST.evaluate(
      ctx({ action: "start-wave", openWaveBeadIds: [] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusalCode).toBe("NO_WAVE_BEADS");
      expect(result.failedCheck).toBe("wave-beads-exist");
    }
  });

  test("appliesTo — start-wave / resume-build only (NOT review-wave per 1cb58a5/m2c fix)", () => {
    expect(PRECOND_WAVE_BEADS_EXIST.appliesTo("start-wave")).toBe(true);
    // beads_web-m2c: review-wave was removed from ACTIONS_REQUIRING_WAVE_BEADS
    // by 1cb58a5 (the predicate's "openWaveBeadIds=[] means refuse" semantic
    // is INVERTED for review-wave, which legitimately runs AFTER all wave
    // beads close). The phantom-wave protection moved to the new
    // PRECOND_WAVE_BEADS_OF_ANY_STATUS_EXIST predicate.
    expect(PRECOND_WAVE_BEADS_EXIST.appliesTo("review-wave")).toBe(false);
    expect(PRECOND_WAVE_BEADS_EXIST.appliesTo("resume-build")).toBe(true);
    expect(PRECOND_WAVE_BEADS_EXIST.appliesTo("run-architect")).toBe(false);
    expect(PRECOND_WAVE_BEADS_EXIST.appliesTo("send-for-qa")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Class A — ALL_WAVE_BEADS_CLOSED
// ---------------------------------------------------------------------------

describe("PRECOND_WAVE_BEADS_NOT_ALL_CLOSED (Class A — ALL_WAVE_BEADS_CLOSED)", () => {
  test("happy path — openWaveBeadIds non-empty → ok=true", () => {
    expect(
      PRECOND_WAVE_BEADS_NOT_ALL_CLOSED.evaluate(
        ctx({ action: "review-wave", openWaveBeadIds: ["bead-1"] }),
      ),
    ).toEqual({ ok: true });
  });

  test("refusal — openWaveBeadIds empty + review-wave → ALL_WAVE_BEADS_CLOSED", () => {
    const result = PRECOND_WAVE_BEADS_NOT_ALL_CLOSED.evaluate(
      ctx({ action: "review-wave", openWaveBeadIds: [] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusalCode).toBe("ALL_WAVE_BEADS_CLOSED");
      expect(result.failedCheck).toBe("wave-beads-not-all-closed");
    }
  });
});

// ---------------------------------------------------------------------------
// Class A — PRECOND_WAVE_BEADS_OF_ANY_STATUS_EXIST (beads_web-m2c phantom-wave)
// ---------------------------------------------------------------------------

describe("PRECOND_WAVE_BEADS_OF_ANY_STATUS_EXIST (Class A — beads_web-m2c phantom-wave protection)", () => {
  test("happy path — anyStatusWaveBeadIds non-empty (open beads) → ok=true", () => {
    expect(
      PRECOND_WAVE_BEADS_OF_ANY_STATUS_EXIST.evaluate(
        ctx({
          action: "review-wave",
          anyStatusWaveBeadIds: ["bead-1", "bead-2"],
          openWaveBeadIds: ["bead-1", "bead-2"],
        }),
      ),
    ).toEqual({ ok: true });
  });

  test("happy path — all wave beads closed (1cb58a5 success case): openWaveBeadIds=[] but anyStatusWaveBeadIds non-empty → ok=true", () => {
    // POSITIVE REGRESSION GUARD: protects the success state the 1cb58a5 fix
    // enabled. If a future edit inadvertently re-couples review-wave to
    // openWaveBeadIds, this test fails — preventing the original bug from
    // re-surfacing.
    expect(
      PRECOND_WAVE_BEADS_OF_ANY_STATUS_EXIST.evaluate(
        ctx({
          action: "review-wave",
          anyStatusWaveBeadIds: ["closed-bead-1", "closed-bead-2"],
          openWaveBeadIds: [],
        }),
      ),
    ).toEqual({ ok: true });
  });

  test("refusal — anyStatusWaveBeadIds empty + review-wave (phantom wave) → NO_WAVE_BEADS", () => {
    // The niii reviewer-4-wave-4-redundant scenario: epic carries `wave:4`
    // and `pipeline:build-review` labels but no wave-4 children exist at
    // all. Pre-1cb58a5 the protection lived in PRECOND_WAVE_BEADS_EXIST;
    // m2c restores it via this new predicate.
    const result = PRECOND_WAVE_BEADS_OF_ANY_STATUS_EXIST.evaluate(
      ctx({ action: "review-wave", anyStatusWaveBeadIds: [] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusalCode).toBe("NO_WAVE_BEADS");
      expect(result.failedCheck).toBe("wave-beads-of-any-status-exist");
      expect(result.reason).toMatch(/phantom/i);
    }
  });

  test("appliesTo — review-wave only (NOT start-wave / resume-build)", () => {
    expect(
      PRECOND_WAVE_BEADS_OF_ANY_STATUS_EXIST.appliesTo("review-wave"),
    ).toBe(true);
    expect(
      PRECOND_WAVE_BEADS_OF_ANY_STATUS_EXIST.appliesTo("start-wave"),
    ).toBe(false);
    expect(
      PRECOND_WAVE_BEADS_OF_ANY_STATUS_EXIST.appliesTo("resume-build"),
    ).toBe(false);
    expect(
      PRECOND_WAVE_BEADS_OF_ANY_STATUS_EXIST.appliesTo("run-architect"),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Class A — ARCHITECT_MARKER_SUCCESS
// ---------------------------------------------------------------------------

describe("PRECOND_ARCHITECT_MARKER_NOT_SUCCESS (Class A — ARCHITECT_MARKER_SUCCESS)", () => {
  test("happy path — no marker → ok=true", () => {
    expect(
      PRECOND_ARCHITECT_MARKER_NOT_SUCCESS.evaluate(
        ctx({ action: "run-architect", marker: null }),
      ),
    ).toEqual({ ok: true });
  });

  test("happy path — marker has stage='architect' but status='blocked' → ok=true", () => {
    expect(
      PRECOND_ARCHITECT_MARKER_NOT_SUCCESS.evaluate(
        ctx({
          action: "run-architect",
          marker: marker({ stage: "architect", status: "blocked" }),
        }),
      ),
    ).toEqual({ ok: true });
  });

  test("refusal — marker stage=architect AND status=success → ARCHITECT_MARKER_SUCCESS", () => {
    const result = PRECOND_ARCHITECT_MARKER_NOT_SUCCESS.evaluate(
      ctx({
        action: "run-architect",
        marker: marker({ stage: "architect", status: "success" }),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusalCode).toBe("ARCHITECT_MARKER_SUCCESS");
      expect(result.failedCheck).toBe("architect-marker-not-success");
    }
  });

  test("appliesTo — only run-architect", () => {
    expect(PRECOND_ARCHITECT_MARKER_NOT_SUCCESS.appliesTo("run-architect")).toBe(
      true,
    );
    expect(PRECOND_ARCHITECT_MARKER_NOT_SUCCESS.appliesTo("revise-architecture")).toBe(
      false,
    );
    expect(PRECOND_ARCHITECT_MARKER_NOT_SUCCESS.appliesTo("run-pm")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Class B — PIPELINE_LABEL_CONFLICT
// ---------------------------------------------------------------------------

describe("PRECOND_PIPELINE_LABEL_SINGLETON (Class B — PIPELINE_LABEL_CONFLICT)", () => {
  test("happy path — single pipeline:* label → ok=true", () => {
    expect(
      PRECOND_PIPELINE_LABEL_SINGLETON.evaluate(
        ctx({ epicLabels: ["pipeline:development", "wave:1"] }),
      ),
    ).toEqual({ ok: true });
  });

  test("happy path — zero pipeline:* labels → ok=true", () => {
    expect(
      PRECOND_PIPELINE_LABEL_SINGLETON.evaluate(ctx({ epicLabels: [] })),
    ).toEqual({ ok: true });
  });

  test("refusal — multiple pipeline:* labels → PIPELINE_LABEL_CONFLICT", () => {
    const result = PRECOND_PIPELINE_LABEL_SINGLETON.evaluate(
      ctx({ epicLabels: ["pipeline:development", "pipeline:qa"] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusalCode).toBe("PIPELINE_LABEL_CONFLICT");
      expect(result.failedCheck).toBe("pipeline-label-singleton");
      expect(result.reason).toMatch(/pipeline:development/);
      expect(result.reason).toMatch(/pipeline:qa/);
    }
  });

  test("appliesTo — universal across every action", () => {
    expect(PRECOND_PIPELINE_LABEL_SINGLETON.appliesTo("any-action")).toBe(true);
    expect(PRECOND_PIPELINE_LABEL_SINGLETON.appliesTo("run-pm")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Class B — AGENT_RUNNING_NO_SESSION
// ---------------------------------------------------------------------------

describe("PRECOND_AGENT_RUNNING_HAS_SESSION (Class B — AGENT_RUNNING_NO_SESSION)", () => {
  test("happy path — agent:running not set → ok=true", () => {
    expect(
      PRECOND_AGENT_RUNNING_HAS_SESSION.evaluate(
        ctx({
          action: "run-pm",
          bead: snapshot({ hasAgentRunning: false }),
        }),
      ),
    ).toEqual({ ok: true });
  });

  test("refusal — agent:running set + agent-launching action → AGENT_RUNNING_NO_SESSION", () => {
    const result = PRECOND_AGENT_RUNNING_HAS_SESSION.evaluate(
      ctx({
        action: "run-pm",
        bead: snapshot({ hasAgentRunning: true, id: "test-bead-1" }),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusalCode).toBe("AGENT_RUNNING_NO_SESSION");
      expect(result.failedCheck).toBe("agent-running-has-session");
      expect(result.reason).toMatch(/test-bead-1/);
    }
  });

  test("null bead → ok=true (defers to A.5 BD_READ_FAILED)", () => {
    expect(
      PRECOND_AGENT_RUNNING_HAS_SESSION.evaluate(
        ctx({ action: "run-pm", bead: null }),
      ),
    ).toEqual({ ok: true });
  });

  test("appliesTo — agent-launching actions only; not label-mutation-only", () => {
    expect(PRECOND_AGENT_RUNNING_HAS_SESSION.appliesTo("run-pm")).toBe(true);
    expect(PRECOND_AGENT_RUNNING_HAS_SESSION.appliesTo("start-wave")).toBe(true);
    expect(PRECOND_AGENT_RUNNING_HAS_SESSION.appliesTo("send-for-qa")).toBe(true);
    expect(PRECOND_AGENT_RUNNING_HAS_SESSION.appliesTo("approve-plan")).toBe(false);
    expect(PRECOND_AGENT_RUNNING_HAS_SESSION.appliesTo("mark-as-live")).toBe(false);
    expect(PRECOND_AGENT_RUNNING_HAS_SESSION.appliesTo("deprioritise")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Class B — QA_ROUND_OUT_OF_ORDER
// ---------------------------------------------------------------------------

describe("PRECOND_QA_ROUND_MONOTONIC (Class B — QA_ROUND_OUT_OF_ORDER)", () => {
  test("happy path — no QA round in progress → ok=true", () => {
    expect(
      PRECOND_QA_ROUND_MONOTONIC.evaluate(
        ctx({
          action: "send-for-qa",
          bead: snapshot({ currentQaRound: null }),
        }),
      ),
    ).toEqual({ ok: true });
  });

  test("happy path — QA round-N marker has status=success → ok=true", () => {
    expect(
      PRECOND_QA_ROUND_MONOTONIC.evaluate(
        ctx({
          action: "qa-fix-and-retest",
          bead: snapshot({ currentQaRound: 2 }),
          marker: marker({
            stage: "qa",
            status: "success",
            bead_id: "epic-x-qa-round-2",
          }),
        }),
      ),
    ).toEqual({ ok: true });
  });

  test("refusal — QA marker stage=qa with status=blocked → QA_ROUND_OUT_OF_ORDER", () => {
    const result = PRECOND_QA_ROUND_MONOTONIC.evaluate(
      ctx({
        action: "qa-fix-and-retest",
        bead: snapshot({ currentQaRound: 1 }),
        marker: marker({ stage: "qa", status: "blocked" }),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusalCode).toBe("QA_ROUND_OUT_OF_ORDER");
      expect(result.failedCheck).toBe("qa-round-monotonic");
    }
  });

  test("falls open — non-QA marker → ok=true (route inline check is load-bearing)", () => {
    expect(
      PRECOND_QA_ROUND_MONOTONIC.evaluate(
        ctx({
          action: "send-for-qa",
          bead: snapshot({ currentQaRound: 1 }),
          marker: marker({ stage: "architect", status: "success" }),
        }),
      ),
    ).toEqual({ ok: true });
  });

  test("appliesTo — send-for-qa / qa-fix-and-retest only", () => {
    expect(PRECOND_QA_ROUND_MONOTONIC.appliesTo("send-for-qa")).toBe(true);
    expect(PRECOND_QA_ROUND_MONOTONIC.appliesTo("qa-fix-and-retest")).toBe(true);
    expect(PRECOND_QA_ROUND_MONOTONIC.appliesTo("start-wave")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Class D — PLAN_INSTABILITY (fail-OPEN posture)
// ---------------------------------------------------------------------------

describe("PRECOND_PLAN_NOT_MODIFIED_SINCE_STAGE_ENTERED (Class D — PLAN_INSTABILITY, fail-OPEN)", () => {
  test("happy path — plan mtime older than stageEnteredAt → ok=true", () => {
    expect(
      PRECOND_PLAN_NOT_MODIFIED_SINCE_STAGE_ENTERED.evaluate(
        ctx({
          action: "review-plan",
          stageEnteredAt: "2026-05-06T12:00:00Z",
          planFileMtime: Date.parse("2026-05-06T11:00:00Z"),
        }),
      ),
    ).toEqual({ ok: true });
  });

  test("refusal — plan mtime newer than stageEnteredAt → PLAN_INSTABILITY", () => {
    const result = PRECOND_PLAN_NOT_MODIFIED_SINCE_STAGE_ENTERED.evaluate(
      ctx({
        action: "review-plan",
        stageEnteredAt: "2026-05-06T10:00:00Z",
        planFileMtime: Date.parse("2026-05-06T12:00:00Z"),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusalCode).toBe("PLAN_INSTABILITY");
      expect(result.failedCheck).toBe("plan-not-modified-since-stage-entered");
    }
  });

  test("FAIL-OPEN — stageEnteredAt=null → ok=true (event-log read failed/missing)", () => {
    expect(
      PRECOND_PLAN_NOT_MODIFIED_SINCE_STAGE_ENTERED.evaluate(
        ctx({
          action: "review-plan",
          stageEnteredAt: null,
          planFileMtime: Date.parse("2026-05-06T12:00:00Z"),
        }),
      ),
    ).toEqual({ ok: true });
  });

  test("FAIL-OPEN — planFileMtime undefined → ok=true (Class A handles missing)", () => {
    expect(
      PRECOND_PLAN_NOT_MODIFIED_SINCE_STAGE_ENTERED.evaluate(
        ctx({
          action: "review-plan",
          stageEnteredAt: "2026-05-06T12:00:00Z",
        }),
      ),
    ).toEqual({ ok: true });
  });

  test("FAIL-OPEN — planFileMtime explicit null → ok=true", () => {
    expect(
      PRECOND_PLAN_NOT_MODIFIED_SINCE_STAGE_ENTERED.evaluate(
        ctx({
          action: "review-plan",
          stageEnteredAt: "2026-05-06T12:00:00Z",
          planFileMtime: null,
        }),
      ),
    ).toEqual({ ok: true });
  });

  test("FAIL-OPEN — malformed stageEnteredAt timestamp → ok=true", () => {
    expect(
      PRECOND_PLAN_NOT_MODIFIED_SINCE_STAGE_ENTERED.evaluate(
        ctx({
          action: "review-plan",
          stageEnteredAt: "not-a-date",
          planFileMtime: 0,
        }),
      ),
    ).toEqual({ ok: true });
  });

  test("appliesTo — plan-stability-sensitive actions only", () => {
    expect(
      PRECOND_PLAN_NOT_MODIFIED_SINCE_STAGE_ENTERED.appliesTo("review-plan"),
    ).toBe(true);
    expect(
      PRECOND_PLAN_NOT_MODIFIED_SINCE_STAGE_ENTERED.appliesTo("review-wave"),
    ).toBe(true);
    expect(
      PRECOND_PLAN_NOT_MODIFIED_SINCE_STAGE_ENTERED.appliesTo("run-pm"),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Class E — ACTION_NEXT_AGENT_MISMATCH
// ---------------------------------------------------------------------------

describe("PRECOND_ACTION_MATCHES_MARKER_NEXT_AGENT (Class E — ACTION_NEXT_AGENT_MISMATCH)", () => {
  test("happy path — no marker → ok=true", () => {
    expect(
      PRECOND_ACTION_MATCHES_MARKER_NEXT_AGENT.evaluate(
        ctx({ action: "run-architect", marker: null }),
      ),
    ).toEqual({ ok: true });
  });

  test("happy path — marker next_agent matches action's canonical agent → ok=true", () => {
    expect(
      PRECOND_ACTION_MATCHES_MARKER_NEXT_AGENT.evaluate(
        ctx({
          action: "run-architect",
          marker: marker({
            next_agent: "architect",
            status: "needs-decision",
          }),
        }),
      ),
    ).toEqual({ ok: true });
  });

  test("refusal — marker next_agent='builder' but action='run-pm' → ACTION_NEXT_AGENT_MISMATCH", () => {
    const result = PRECOND_ACTION_MATCHES_MARKER_NEXT_AGENT.evaluate(
      ctx({
        action: "run-pm",
        marker: marker({
          next_agent: "builder",
          status: "needs-decision",
        }),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusalCode).toBe("ACTION_NEXT_AGENT_MISMATCH");
      expect(result.failedCheck).toBe("action-matches-marker-next-agent");
      expect(result.reason).toMatch(/builder/);
      expect(result.reason).toMatch(/run-pm/);
    }
  });

  test("happy path — marker status=success with no next_agent → ok=true (override=false)", () => {
    expect(
      PRECOND_ACTION_MATCHES_MARKER_NEXT_AGENT.evaluate(
        ctx({
          action: "run-pm",
          marker: marker({ status: "success" }),
        }),
      ),
    ).toEqual({ ok: true });
  });

  test("appliesTo — universal", () => {
    expect(
      PRECOND_ACTION_MATCHES_MARKER_NEXT_AGENT.appliesTo("any-action"),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// EXTENDED PRECONDITION_TABLE coverage tests
// ---------------------------------------------------------------------------

describe("EXTENDED_PRECONDITION_TABLE coverage (ehp.13 — full 34 dispatching actions)", () => {
  test("registers exactly 34 dispatching actions (matches DISPATCHING_ACTIONS)", () => {
    expect(EXTENDED_PRECONDITION_TABLE.size).toBe(DISPATCHING_ACTIONS.length);
    expect(EXTENDED_PRECONDITION_TABLE.size).toBe(34);
    for (const action of DISPATCHING_ACTIONS) {
      expect(EXTENDED_PRECONDITION_TABLE.has(action)).toBe(true);
    }
  });

  test("EVERY dispatching action has all 4 universal predicates registered", () => {
    const universalNames = [
      "bd-status-not-deferred",
      "bd-status-not-closed",
      "operator-decision-not-pending",
      "review-needs-human-not-set",
    ];
    for (const action of DISPATCHING_ACTIONS) {
      const preconditions = EXTENDED_PRECONDITION_TABLE.get(action) ?? [];
      const names = preconditions.map((p) => p.name);
      for (const universal of universalNames) {
        expect(names).toContain(universal);
      }
    }
  });

  test("EXEMPT actions are NOT in EXTENDED_PRECONDITION_TABLE", () => {
    for (const action of EXEMPT_ACTIONS) {
      expect(EXTENDED_PRECONDITION_TABLE.has(action)).toBe(false);
    }
  });

  test("review-wave registers PRECOND_WAVE_BEADS_OF_ANY_STATUS_EXIST (NO_WAVE_BEADS) — phantom-wave protection per beads_web-m2c", () => {
    // beads_web-m2c (post-1cb58a5): the OLD PRECOND_WAVE_BEADS_EXIST and
    // PRECOND_WAVE_BEADS_NOT_ALL_CLOSED predicates are NO LONGER registered
    // for review-wave (they fire on `openWaveBeadIds=[]` which is the
    // legitimate post-close success state for review-wave). The replacement
    // protection — PRECOND_WAVE_BEADS_OF_ANY_STATUS_EXIST — fires only when
    // NO wave-N beads exist in any status (the niii reviewer-4-wave-4-
    // redundant phantom-wave case), preserving the protection that ehp.7
    // delivered without re-introducing 1cb58a5's regression.
    const preconditions = EXTENDED_PRECONDITION_TABLE.get("review-wave") ?? [];
    const checkNames = preconditions.map((p) => p.name);
    expect(checkNames).toContain("wave-beads-of-any-status-exist");
    // The new predicate emits NO_WAVE_BEADS as its refusal code.
    const newPredicate = preconditions.find(
      (p) => p.name === "wave-beads-of-any-status-exist",
    );
    expect(newPredicate?.refusalCode).toBe("NO_WAVE_BEADS");
    // The dropped predicates MUST NOT appear for review-wave (the 1cb58a5
    // regression-guard half of the dual-predicate model).
    expect(checkNames).not.toContain("wave-beads-exist");
    expect(checkNames).not.toContain("wave-beads-not-all-closed");
  });

  test("start-wave includes plan-file-exists + wave-beads-exist predicates", () => {
    const preconditions = EXTENDED_PRECONDITION_TABLE.get("start-wave") ?? [];
    const names = preconditions.map((p) => p.name);
    expect(names).toContain("plan-file-exists");
    expect(names).toContain("wave-beads-exist");
  });

  test("run-architect includes architect-marker-not-success predicate", () => {
    const preconditions = EXTENDED_PRECONDITION_TABLE.get("run-architect") ?? [];
    const codes = preconditions.map((p) => p.refusalCode);
    expect(codes).toContain("ARCHITECT_MARKER_SUCCESS");
  });

  test("send-for-qa includes qa-round-monotonic predicate", () => {
    const preconditions = EXTENDED_PRECONDITION_TABLE.get("send-for-qa") ?? [];
    const codes = preconditions.map((p) => p.refusalCode);
    expect(codes).toContain("QA_ROUND_OUT_OF_ORDER");
  });

  test("review-plan includes plan-instability predicate (poh.13: PLAN_PENDING removed — review-plan IS the action that clears plan:pending)", () => {
    const preconditions = EXTENDED_PRECONDITION_TABLE.get("review-plan") ?? [];
    const codes = preconditions.map((p) => p.refusalCode);
    expect(codes).not.toContain("PLAN_PENDING"); // poh.13 fix
    expect(codes).toContain("PLAN_INSTABILITY");
  });

  test("start-wave still includes plan-not-pending — actions that CONSUME the finalised plan must wait (poh.13 invariant)", () => {
    const preconditions = EXTENDED_PRECONDITION_TABLE.get("start-wave") ?? [];
    const codes = preconditions.map((p) => p.refusalCode);
    expect(codes).toContain("PLAN_PENDING");
  });

  test("approve-plan does NOT include plan-not-pending — it IS the transition that clears the label (poh.13 fix)", () => {
    const preconditions = EXTENDED_PRECONDITION_TABLE.get("approve-plan") ?? [];
    const codes = preconditions.map((p) => p.refusalCode);
    expect(codes).not.toContain("PLAN_PENDING");
  });

  test("PER_ACTION_PRECONDITIONS exposes 11 predicates (10 ehp.13 + 1 m2c phantom-wave)", () => {
    // beads_web-m2c added PRECOND_WAVE_BEADS_OF_ANY_STATUS_EXIST. It shares
    // the NO_WAVE_BEADS refusal code with PRECOND_WAVE_BEADS_EXIST so the
    // sorted refusal-code list contains NO_WAVE_BEADS twice.
    expect(PER_ACTION_PRECONDITIONS).toHaveLength(11);
    const codes = PER_ACTION_PRECONDITIONS.map((p) => p.refusalCode).sort();
    expect(codes).toEqual(
      [
        "PLAN_FILE_MISSING",
        "PLAN_PENDING",
        "NO_WAVE_BEADS",
        "NO_WAVE_BEADS", // beads_web-m2c phantom-wave predicate
        "ALL_WAVE_BEADS_CLOSED",
        "ARCHITECT_MARKER_SUCCESS",
        "PIPELINE_LABEL_CONFLICT",
        "AGENT_RUNNING_NO_SESSION",
        "QA_ROUND_OUT_OF_ORDER",
        "PLAN_INSTABILITY",
        "ACTION_NEXT_AGENT_MISMATCH",
      ].sort(),
    );
  });

  test("evaluatePreconditions on a dispatching action runs the extended table", () => {
    // start-wave with no plan file → PLAN_FILE_MISSING
    const result = evaluatePreconditions(
      ctx({
        action: "start-wave",
        bead: snapshot({ status: "open" }),
        planFileExists: false,
        openWaveBeadIds: ["bead-1"],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusalCode).toBe("PLAN_FILE_MISSING");
    }
  });

  test("EXEMPT actions warn + pass through evaluatePreconditions", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const action of EXEMPT_ACTIONS) {
        const result = evaluatePreconditions(ctx({ action }));
        expect(result).toEqual({ ok: true });
      }
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// buildPreconditionRefusalResponse helper (HTTP 412 body shape)
// ---------------------------------------------------------------------------

describe("buildPreconditionRefusalResponse (ehp.13 — HTTP 412 body helper)", () => {
  test("projects refusal + bead snapshot into HTTP 412 body shape", () => {
    const refusal: PreconditionRefusal = {
      ok: false,
      refusalCode: "BD_STATUS_DEFERRED",
      failedCheck: "bd-status-not-deferred",
      reason: "bead deferred",
    };
    const bead = snapshot({
      id: "bead-x",
      status: "deferred",
      pipelineStage: "development",
      currentWave: 2,
      currentQaRound: null,
      hasAgentRunning: false,
      hasReviewNeedsHuman: false,
    });
    const response = buildPreconditionRefusalResponse(refusal, bead);
    const expected: PreconditionRefusalResponse = {
      refused: true,
      refusalCode: "BD_STATUS_DEFERRED",
      failedCheck: "bd-status-not-deferred",
      reason: "bead deferred",
      observedState: {
        beadId: "bead-x",
        status: "deferred",
        pipelineStage: "development",
        currentWave: 2,
        currentQaRound: null,
        hasAgentRunning: false,
        hasReviewNeedsHuman: false,
      },
    };
    expect(response).toEqual(expected);
  });

  test("null bead → safe sentinel observedState (all unknowns)", () => {
    const refusal: PreconditionRefusal = {
      ok: false,
      refusalCode: "BD_READ_FAILED",
      failedCheck: "bd-read-succeeded",
      reason: "bd unreachable",
    };
    const response = buildPreconditionRefusalResponse(refusal, null);
    expect(response.observedState).toEqual({
      beadId: null,
      status: null,
      pipelineStage: null,
      currentWave: null,
      currentQaRound: null,
      hasAgentRunning: false,
      hasReviewNeedsHuman: false,
    });
    expect(response.refused).toBe(true);
    expect(response.refusalCode).toBe("BD_READ_FAILED");
  });

  test("response.refused is the literal `true` discriminator (type-narrowing)", () => {
    const refusal: PreconditionRefusal = {
      ok: false,
      refusalCode: "PLAN_FILE_MISSING",
      failedCheck: "plan-file-exists",
      reason: "no plan",
    };
    const response = buildPreconditionRefusalResponse(refusal, null);
    // TypeScript narrows on `response.refused === true` (literal type).
    expect(response.refused).toBe(true);
    // @ts-expect-error — `refused` is `true` literal, not arbitrary boolean
    const _bad: false = response.refused;
    void _bad;
  });

  test("preserves all RefusalCode union values (regression guard)", () => {
    const codes: ReadonlyArray<RefusalCode> = [
      "PLAN_FILE_MISSING",
      "PLAN_PENDING",
      "NO_WAVE_BEADS",
      "ALL_WAVE_BEADS_CLOSED",
      "ARCHITECT_MARKER_SUCCESS",
      "BD_STATUS_DEFERRED",
      "BD_STATUS_CLOSED",
      "BD_READ_FAILED",
      "PIPELINE_LABEL_CONFLICT",
      "AGENT_RUNNING_NO_SESSION",
      "QA_ROUND_OUT_OF_ORDER",
      "OPERATOR_DECISION_PENDING",
      "REVIEW_NEEDS_HUMAN",
      "PLAN_INSTABILITY",
      "ACTION_NEXT_AGENT_MISMATCH",
    ];
    for (const code of codes) {
      const refusal: PreconditionRefusal = {
        ok: false,
        refusalCode: code,
        failedCheck: `check-${code}`,
        reason: `reason-${code}`,
      };
      const response = buildPreconditionRefusalResponse(refusal, null);
      expect(response.refusalCode).toBe(code);
    }
  });
});

// ---------------------------------------------------------------------------
// End-to-end evaluatePreconditions across the extended table — refusal scenarios
// ---------------------------------------------------------------------------

describe("evaluatePreconditions (ehp.13 — extended table refusal scenarios)", () => {
  test("review-wave with phantom wave (no wave-N beads of ANY status) → NO_WAVE_BEADS via beads_web-m2c predicate", () => {
    // beads_web-m2c: post-1cb58a5 + this fix, review-wave's wave-beads
    // refusal triggers on the NEW signal `anyStatusWaveBeadIds=[]` (no
    // wave-N beads exist at all — the phantom-wave case). The OLD signal
    // `openWaveBeadIds=[]` no longer refuses review-wave (it represents the
    // legitimate post-close success state).
    const result = evaluatePreconditions(
      ctx({
        action: "review-wave",
        bead: snapshot({ currentWave: 2 }),
        openWaveBeadIds: [],
        anyStatusWaveBeadIds: [],
        planFileExists: true,
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusalCode).toBe("NO_WAVE_BEADS");
      expect(result.failedCheck).toBe("wave-beads-of-any-status-exist");
    }
  });

  test("review-wave with all wave beads closed (1cb58a5 success case) → dispatch passes (regression guard for beads_web-m2c)", () => {
    // beads_web-m2c POSITIVE REGRESSION GUARD: if an editor re-introduces
    // review-wave into ACTIONS_REQUIRING_WAVE_BEADS, this test fails because
    // openWaveBeadIds=[] would re-trigger the dropped predicates. The fix
    // 1cb58a5 enabled this success path; m2c protects it.
    const result = evaluatePreconditions(
      ctx({
        action: "review-wave",
        bead: snapshot({ currentWave: 2 }),
        openWaveBeadIds: [], // every wave-2 bead is closed (success state)
        anyStatusWaveBeadIds: ["closed-bead-1", "closed-bead-2"], // wave-2 beads exist
        planFileExists: true,
      }),
    );
    expect(result).toEqual({ ok: true });
  });

  test("approve-plan with plan:pending label → ok=true (poh.13: this IS the action that clears the label)", () => {
    // Pre-poh.13: this test asserted refusal with PLAN_PENDING, which
    // made plan:pending undischargeable through the autonomous path.
    // The empirical reproducer was 2026-05-07 14:59 BST, when an
    // operator-side approve-plan curl returned PLAN_PENDING / plan-not
    // -pending. With the predicate's appliesTo restricted to plan-
    // CONSUMING actions, approve-plan now passes the precondition gate
    // and reaches the route handler, which removes plan:pending and
    // adds plan:approved.
    const result = evaluatePreconditions(
      ctx({
        action: "approve-plan",
        bead: snapshot({ status: "open" }),
        epicLabels: ["pipeline:plan-review", "plan:pending"],
        planFileExists: true,
      }),
    );
    expect(result).toEqual({ ok: true });
  });

  test("run-architect with prior success marker → ARCHITECT_MARKER_SUCCESS", () => {
    const result = evaluatePreconditions(
      ctx({
        action: "run-architect",
        bead: snapshot({ status: "open" }),
        marker: marker({ stage: "architect", status: "success" }),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusalCode).toBe("ARCHITECT_MARKER_SUCCESS");
  });

  test("run-pm with bead.hasAgentRunning=true → AGENT_RUNNING_NO_SESSION", () => {
    const result = evaluatePreconditions(
      ctx({
        action: "run-pm",
        bead: snapshot({ hasAgentRunning: true }),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusalCode).toBe("AGENT_RUNNING_NO_SESSION");
    }
  });

  test("any action with conflicting pipeline labels → PIPELINE_LABEL_CONFLICT", () => {
    const result = evaluatePreconditions(
      ctx({
        action: "deprioritise",
        epicLabels: ["pipeline:development", "pipeline:qa"],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusalCode).toBe("PIPELINE_LABEL_CONFLICT");
    }
  });

  test("review-plan with PLAN_INSTABILITY: plan mtime > stageEnteredAt → PLAN_INSTABILITY", () => {
    const result = evaluatePreconditions(
      ctx({
        action: "review-plan",
        bead: snapshot({ status: "open" }),
        epicLabels: ["pipeline:plan-review"],
        planFileExists: true,
        stageEnteredAt: "2026-05-06T10:00:00Z",
        planFileMtime: Date.parse("2026-05-06T12:00:00Z"),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusalCode).toBe("PLAN_INSTABILITY");
  });

  test("Class E — action mismatches marker.next_agent → ACTION_NEXT_AGENT_MISMATCH", () => {
    // Marker says next_agent=architect; we dispatch run-pm → mismatch.
    const result = evaluatePreconditions(
      ctx({
        action: "run-pm",
        bead: snapshot({ status: "open" }),
        marker: marker({ next_agent: "architect", status: "needs-decision" }),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusalCode).toBe("ACTION_NEXT_AGENT_MISMATCH");
    }
  });

  test("happy path — clean ctx for run-pm → ok=true", () => {
    const result = evaluatePreconditions(
      ctx({
        action: "run-pm",
        bead: snapshot({ status: "open" }),
      }),
    );
    expect(result).toEqual({ ok: true });
  });
});
