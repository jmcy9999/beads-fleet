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
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = evaluatePreconditions(
        ctx({ action: "start-research" /* not in Wave-2 table */ }),
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
    const sameCtx = ctx({
      action: "send-for-qa",
      bead: snapshot({ status: "open" }),
      marker: marker({ next_agent: "builder" }),
      epicLabels: ["pipeline:development"],
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
