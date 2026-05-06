// =============================================================================
// Tests — Universal Coherence Routing Rewrite (factory-core-wlsr.3)
// =============================================================================
//
// Covers the four new/changed precedence rules added by wlsr.3:
//   - Precedence 1.5: stage-aware operator→coherence rewrite (ADR-001)
//     incl. the coherence escape hatch (ADR-001) and the unknown-stage
//     fail-safe (ADR-004).
//   - Precedence 2.6: status=success + BLOCKER: in whats_open → coherence.
//   - Precedence 3.5: status=needs-decision without BLOCKER → coherence
//     (was: fallthrough to override=false).
//   - Precedence 5 (changed): status=failure → coherence (was: re-dispatch
//     same agent).
//
// Design source: factory-core/docs/research/universal-coherence-routing-
//   agents-never-architecture.md § ADR-001/003/004; bead AC §§ 1-13.
//
// Discipline: tests exercise the real interpretMarkerForRouting (no mocks of
// the function under test). Each new rule has positive AND negative cases
// per AC 10. Pre-existing cases are NOT duplicated here — see
// __tests__/lib/marker-routing.test.ts for the wlsr.3-pre baseline tests.
// =============================================================================

import {
  interpretMarkerForRouting,
  LOOP_AGENT_STAGES,
} from "../../src/lib/marker-routing";
import type { MarkerData } from "../../src/lib/marker-reader";
import type { EpicStateSnapshot } from "../../src/lib/marker-routing";

const mockSnapshot: EpicStateSnapshot = {
  epicId: "factory-core-wlsr",
  currentStage: "builder",
  labels: ["pipeline:build", "ship-type:internal"],
};

// ---------------------------------------------------------------------------
// LOOP_AGENT_STAGES constant — AC 1
// ---------------------------------------------------------------------------

describe("LOOP_AGENT_STAGES (factory-core-wlsr.3 AC 1)", () => {
  test("contains exactly the 8 canonical loop-agent stages", () => {
    const expected = new Set([
      "architect",
      "planner",
      "builder",
      "reviewer",
      "qa",
      "polish",
      "test-spec",
      "product-manager",
    ]);
    // Bidirectional containment check — no extras, no omissions.
    expect(LOOP_AGENT_STAGES.size).toBe(8);
    for (const stage of expected) {
      expect(LOOP_AGENT_STAGES.has(stage)).toBe(true);
    }
    for (const stage of LOOP_AGENT_STAGES) {
      expect(expected.has(stage)).toBe(true);
    }
  });

  test("does NOT contain 'coherence' (escape hatch invariant per ADR-001)", () => {
    // If coherence were in the set, its own escalation marker (stage=
    // coherence, next_agent=operator) would be rewritten back to coherence,
    // breaking ADR-001's escape hatch and risking infinite recursion.
    expect(LOOP_AGENT_STAGES.has("coherence")).toBe(false);
  });

  test("does NOT contain 'operator' (operator is the human, never a loop agent)", () => {
    expect(LOOP_AGENT_STAGES.has("operator")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Precedence 1.5 — stage-aware operator→coherence rewrite (ADR-001) — AC 2-4
// ---------------------------------------------------------------------------

describe("Precedence 1.5: stage-aware operator→coherence rewrite (factory-core-wlsr.3 AC 2-4)", () => {
  // Positive cases — every loop-agent stage should rewrite operator→coherence.
  for (const stage of [
    "architect",
    "planner",
    "builder",
    "reviewer",
    "qa",
    "polish",
    "test-spec",
    "product-manager",
  ] as const) {
    test(`stage=${stage} + next_agent=operator → coherence (loop-agent rewrite)`, () => {
      const marker: MarkerData = {
        version: "1",
        epic_id: "factory-core-wlsr",
        status: "needs-decision",
        stage,
        started_at: "2026-05-06T10:00:00Z",
        exited_at: "2026-05-06T10:30:00Z",
        next_agent: "operator",
      };

      const result = interpretMarkerForRouting(marker, mockSnapshot);

      expect(result.override).toBe(true);
      expect(result.nextAgent).toBe("coherence");
      expect(result.reason).toContain("stage-aware rewrite");
      expect(result.reason).toContain(`stage=${stage}`);
    });
  }

  // ADR-001 escape hatch — coherence's own escalation MUST be preserved.
  // Named test case per close-note discipline (test for AC 3 / fail-safe).
  test("coherence-escape-hatch: stage=coherence + next_agent=operator → preserve operator routing (ADR-001 escape hatch)", () => {
    const marker: MarkerData = {
      version: "1",
      epic_id: "factory-core-wlsr",
      stage: "coherence",
      status: "needs-decision",
      started_at: "2026-05-06T11:00:00Z",
      exited_at: "2026-05-06T11:15:00Z",
      next_agent: "operator",
      // Coherence's own marker — legitimate escalation per ADR-001.
    };

    const result = interpretMarkerForRouting(marker, mockSnapshot);

    expect(result.override).toBe(true);
    expect(result.nextAgent).toBe("operator");
    // Reason should NOT indicate stage-aware rewrite — it should fall through
    // to Precedence 1 (explicit next_agent field).
    expect(result.reason).toContain("explicit next_agent field");
    expect(result.reason).not.toContain("stage-aware rewrite");
  });

  test("coherence-escape-hatch: stage=coherence with leading/trailing whitespace also preserves operator routing", () => {
    // Defensive: marker.stage written by coherence agent might have
    // whitespace from prompt formatting. The trim() in the implementation
    // handles this.
    const marker: MarkerData = {
      version: "1",
      epic_id: "factory-core-wlsr",
      stage: "  coherence  ",
      status: "needs-decision",
      started_at: "2026-05-06T11:00:00Z",
      exited_at: "2026-05-06T11:15:00Z",
      next_agent: "operator",
    };

    const result = interpretMarkerForRouting(marker, mockSnapshot);

    expect(result.override).toBe(true);
    expect(result.nextAgent).toBe("operator");
    expect(result.reason).toContain("explicit next_agent field");
  });

  // ADR-004 fail-safe — unknown/missing stage treated as loop-agent.
  // Named test case per close-note discipline (test for AC 4 / fail-safe).
  test("fail-safe-unknown-stage: stage=unknown-future-agent + next_agent=operator → rewrite to coherence (ADR-004 fail-safe)", () => {
    const marker: MarkerData = {
      version: "1",
      epic_id: "factory-core-wlsr",
      stage: "some-future-agent-not-yet-loop",
      status: "needs-decision",
      started_at: "2026-05-06T12:00:00Z",
      exited_at: "2026-05-06T12:30:00Z",
      next_agent: "operator",
    };

    const result = interpretMarkerForRouting(marker, mockSnapshot);

    expect(result.override).toBe(true);
    expect(result.nextAgent).toBe("coherence");
    expect(result.reason).toContain("stage-aware rewrite");
    expect(result.reason).toContain("unknown stage");
  });

  test("fail-safe-missing-stage: stage missing + next_agent=operator → rewrite to coherence (ADR-004 fail-safe)", () => {
    const marker = {
      version: "1",
      epic_id: "factory-core-wlsr",
      status: "needs-decision",
      // stage intentionally absent — defensive against malformed markers
      started_at: "2026-05-06T12:00:00Z",
      exited_at: "2026-05-06T12:30:00Z",
      next_agent: "operator",
    } as Partial<MarkerData> as MarkerData;

    const result = interpretMarkerForRouting(marker, mockSnapshot);

    expect(result.override).toBe(true);
    expect(result.nextAgent).toBe("coherence");
    expect(result.reason).toContain("stage-aware rewrite");
    expect(result.reason).toContain("missing stage");
  });

  // Negative cases — Precedence 1.5 must NOT rewrite when next_agent ≠ operator.
  test("loop-agent stage + next_agent=architect → NOT rewritten (Precedence 1 path)", () => {
    const marker: MarkerData = {
      version: "1",
      epic_id: "factory-core-wlsr",
      status: "blocked",
      stage: "planner",
      started_at: "2026-05-06T13:00:00Z",
      exited_at: "2026-05-06T13:30:00Z",
      next_agent: "architect",
    };

    const result = interpretMarkerForRouting(marker, mockSnapshot);

    expect(result.override).toBe(true);
    expect(result.nextAgent).toBe("architect");
    expect(result.reason).toContain("explicit next_agent field");
    expect(result.reason).not.toContain("stage-aware rewrite");
  });

  test("loop-agent stage + next_agent=coherence → NOT rewritten (already routes to coherence)", () => {
    const marker: MarkerData = {
      version: "1",
      epic_id: "factory-core-wlsr",
      status: "needs-decision",
      stage: "builder",
      started_at: "2026-05-06T13:00:00Z",
      exited_at: "2026-05-06T13:30:00Z",
      next_agent: "coherence",
    };

    const result = interpretMarkerForRouting(marker, mockSnapshot);

    expect(result.override).toBe(true);
    expect(result.nextAgent).toBe("coherence");
    expect(result.reason).toContain("explicit next_agent field");
    expect(result.reason).not.toContain("stage-aware rewrite");
  });

  test("Precedence 1.5 ordering: rewrite fires BEFORE Precedence 1 returns next_agent unchanged", () => {
    // Risk-flag regression guard: if Precedence 1.5 were placed AFTER
    // Precedence 1, this marker would return operator unrewritten. The
    // expected nextAgent of "coherence" verifies the ordering.
    const marker: MarkerData = {
      version: "1",
      epic_id: "factory-core-wlsr",
      status: "success",
      stage: "reviewer",
      started_at: "2026-05-06T13:00:00Z",
      exited_at: "2026-05-06T13:30:00Z",
      next_agent: "operator",
    };

    const result = interpretMarkerForRouting(marker, mockSnapshot);

    expect(result.override).toBe(true);
    expect(result.nextAgent).toBe("coherence");
  });
});

// ---------------------------------------------------------------------------
// Precedence 2.6 — status=success + BLOCKER: in whats_open → coherence — AC 5
// ---------------------------------------------------------------------------

describe("Precedence 2.6: status=success + BLOCKER → coherence (factory-core-wlsr.3 AC 5)", () => {
  test("status=success + BLOCKER: in whats_open → coherence", () => {
    const marker: MarkerData = {
      version: "1",
      bead_id: "factory-core-wlsr.3",
      status: "success",
      stage: "builder",
      started_at: "2026-05-06T14:00:00Z",
      exited_at: "2026-05-06T14:30:00Z",
      whats_open: [
        "BLOCKER: Migration script failed against staging dataset",
        "FOLLOW-ON: Add retry logic",
      ],
    };

    const result = interpretMarkerForRouting(marker, mockSnapshot);

    expect(result.override).toBe(true);
    expect(result.nextAgent).toBe("coherence");
    expect(result.reason).toContain("status=success with BLOCKER");
  });

  test("status=success + lowercase 'blocker:' prefix → coherence (case-insensitive)", () => {
    // Reuses the same trim().toUpperCase() predicate as Precedence 3.
    const marker: MarkerData = {
      version: "1",
      bead_id: "factory-core-wlsr.3",
      status: "success",
      stage: "qa",
      started_at: "2026-05-06T14:00:00Z",
      exited_at: "2026-05-06T14:30:00Z",
      whats_open: ["blocker: lowercase prefix variant"],
    };

    const result = interpretMarkerForRouting(marker, mockSnapshot);

    expect(result.override).toBe(true);
    expect(result.nextAgent).toBe("coherence");
  });

  test("status=success + BLOCKER: with leading whitespace → coherence", () => {
    // Whitespace tolerance — same as Precedence 3.
    const marker: MarkerData = {
      version: "1",
      bead_id: "factory-core-wlsr.3",
      status: "success",
      stage: "qa",
      started_at: "2026-05-06T14:00:00Z",
      exited_at: "2026-05-06T14:30:00Z",
      whats_open: ["   BLOCKER: leading whitespace tolerated"],
    };

    const result = interpretMarkerForRouting(marker, mockSnapshot);

    expect(result.override).toBe(true);
    expect(result.nextAgent).toBe("coherence");
  });

  // Negative cases — Precedence 2.6 must NOT fire when there is no BLOCKER.
  test("status=success + only FOLLOW-ON in whats_open → fallback to pipeline-routes (Precedence 4)", () => {
    const marker: MarkerData = {
      version: "1",
      bead_id: "factory-core-wlsr.3",
      status: "success",
      stage: "builder",
      started_at: "2026-05-06T14:00:00Z",
      exited_at: "2026-05-06T14:30:00Z",
      whats_open: ["FOLLOW-ON: Update docs", "FOLLOW-ON: Refactor test helpers"],
    };

    const result = interpretMarkerForRouting(marker, mockSnapshot);

    expect(result.override).toBe(false);
    expect(result.reason).toContain("fallback to pipeline-routes");
  });

  test("status=success + empty whats_open → fallback to pipeline-routes (Precedence 4)", () => {
    const marker: MarkerData = {
      version: "1",
      bead_id: "factory-core-wlsr.3",
      status: "success",
      stage: "builder",
      started_at: "2026-05-06T14:00:00Z",
      exited_at: "2026-05-06T14:30:00Z",
      whats_open: [],
    };

    const result = interpretMarkerForRouting(marker, mockSnapshot);

    expect(result.override).toBe(false);
    expect(result.reason).toContain("fallback to pipeline-routes");
  });

  test("status=success + 'BLOCKERS:' (plural, mid-string) does NOT match prefix predicate → fallback", () => {
    // Predicate is .startsWith("BLOCKER:") after trim().toUpperCase().
    // "BLOCKERS:" starts with the substring "BLOCKER" but NOT "BLOCKER:" —
    // the colon position differs. Defensive: this test guards against a
    // future regression that loosens the predicate to .includes("BLOCKER").
    const marker: MarkerData = {
      version: "1",
      bead_id: "factory-core-wlsr.3",
      status: "success",
      stage: "builder",
      started_at: "2026-05-06T14:00:00Z",
      exited_at: "2026-05-06T14:30:00Z",
      whats_open: ["NOTE: Multiple BLOCKERS were considered but resolved"],
    };

    const result = interpretMarkerForRouting(marker, mockSnapshot);

    expect(result.override).toBe(false);
    expect(result.reason).toContain("fallback to pipeline-routes");
  });
});

// ---------------------------------------------------------------------------
// Precedence 3.5 — status=needs-decision (no BLOCKER) → coherence — AC 6
// ---------------------------------------------------------------------------

describe("Precedence 3.5: needs-decision without BLOCKER → coherence (factory-core-wlsr.3 AC 6)", () => {
  test("status=needs-decision + no whats_open → coherence (was: fallthrough)", () => {
    const marker: MarkerData = {
      version: "1",
      epic_id: "factory-core-wlsr",
      status: "needs-decision",
      stage: "planner",
      started_at: "2026-05-06T15:00:00Z",
      exited_at: "2026-05-06T15:15:00Z",
    };

    const result = interpretMarkerForRouting(marker, mockSnapshot);

    expect(result.override).toBe(true);
    expect(result.nextAgent).toBe("coherence");
    expect(result.reason).toContain("needs-decision");
    expect(result.reason).toContain("without BLOCKER");
  });

  test("status=needs-decision + only FOLLOW-ON whats_open → coherence (was: fallthrough)", () => {
    const marker: MarkerData = {
      version: "1",
      epic_id: "factory-core-wlsr",
      status: "needs-decision",
      stage: "qa",
      started_at: "2026-05-06T15:00:00Z",
      exited_at: "2026-05-06T15:15:00Z",
      whats_open: [
        "FOLLOW-ON: Tighten retry logic",
        "FOLLOW-ON: Document edge case",
      ],
    };

    const result = interpretMarkerForRouting(marker, mockSnapshot);

    expect(result.override).toBe(true);
    expect(result.nextAgent).toBe("coherence");
    expect(result.reason).toContain("needs-decision");
    expect(result.reason).toContain("without BLOCKER");
  });

  // Negative case — Precedence 3 (with BLOCKER) MUST still fire BEFORE 3.5.
  test("status=needs-decision + BLOCKER → still routes via Precedence 3 (existing behaviour preserved)", () => {
    const marker: MarkerData = {
      version: "1",
      epic_id: "factory-core-wlsr",
      status: "needs-decision",
      stage: "qa",
      started_at: "2026-05-06T15:00:00Z",
      exited_at: "2026-05-06T15:15:00Z",
      whats_open: ["BLOCKER: Test infra broken", "FOLLOW-ON: Update docs"],
    };

    const result = interpretMarkerForRouting(marker, mockSnapshot);

    expect(result.override).toBe(true);
    expect(result.nextAgent).toBe("coherence");
    // Precedence 3 (BLOCKER path) — distinct reason text from 3.5.
    expect(result.reason).toContain("needs-decision with BLOCKER");
    expect(result.reason).not.toContain("without BLOCKER");
  });
});

// ---------------------------------------------------------------------------
// Precedence 5 — status=failure → coherence (was: re-dispatch) — AC 7
// ---------------------------------------------------------------------------

describe("Precedence 5: status=failure → coherence (factory-core-wlsr.3 AC 7)", () => {
  test("status=failure on builder stage → coherence (was: re-dispatch builder)", () => {
    const marker: MarkerData = {
      version: "1",
      bead_id: "factory-core-wlsr.3",
      status: "failure",
      stage: "builder",
      started_at: "2026-05-06T16:00:00Z",
      exited_at: "2026-05-06T17:00:00Z",
      surprises_or_findings: "Build failed: tsc reported 42 errors",
    };

    const result = interpretMarkerForRouting(marker, mockSnapshot);

    expect(result.override).toBe(true);
    expect(result.nextAgent).toBe("coherence");
    expect(result.reason).toContain("status=failure");
    expect(result.reason).toContain("coherence");
    // Regression guard: must NOT carry the prior "re-dispatch same agent"
    // language since the behaviour changed in wlsr.3.
    expect(result.reason).not.toContain("re-dispatch");
  });

  test("status=failure on planner stage → coherence (no longer re-dispatches planner blindly)", () => {
    const marker: MarkerData = {
      version: "1",
      epic_id: "factory-core-wlsr",
      status: "failure",
      stage: "planner",
      started_at: "2026-05-06T16:00:00Z",
      exited_at: "2026-05-06T17:00:00Z",
    };

    const result = interpretMarkerForRouting(marker, mockSnapshot);

    expect(result.override).toBe(true);
    expect(result.nextAgent).toBe("coherence");
  });

  test("status=failure on coherence stage → coherence (coherence-failure also routed to coherence; not re-dispatched)", () => {
    // Edge case — coherence's own marker reports failure. Per P2 (any
    // non-success outcome → coherence), even a coherence-stage failure
    // routes to coherence (coherence reasoning over its own failure marker
    // is the correct loop; if coherence repeatedly fails, the journal
    // entries plus stuck-in-stage rule will eventually escalate to operator).
    const marker: MarkerData = {
      version: "1",
      epic_id: "factory-core-wlsr",
      status: "failure",
      stage: "coherence",
      started_at: "2026-05-06T16:00:00Z",
      exited_at: "2026-05-06T17:00:00Z",
    };

    const result = interpretMarkerForRouting(marker, mockSnapshot);

    expect(result.override).toBe(true);
    expect(result.nextAgent).toBe("coherence");
  });
});

// ---------------------------------------------------------------------------
// Loose-schema discipline (AC 9) — function never throws
// ---------------------------------------------------------------------------

describe("Loose-schema discipline (factory-core-wlsr.3 AC 9)", () => {
  test("function does NOT throw on next_agent set to non-string value", () => {
    const marker = {
      version: "1",
      epic_id: "factory-core-wlsr",
      status: "needs-decision",
      stage: "planner",
      started_at: "2026-05-06T10:00:00Z",
      exited_at: "2026-05-06T10:30:00Z",
      next_agent: 42, // malformed — number instead of string
    } as unknown as MarkerData;

    expect(() => interpretMarkerForRouting(marker, mockSnapshot)).not.toThrow();
  });

  test("function does NOT throw on next_agent='operator' with stage as non-string", () => {
    // Defensive: the Precedence 1.5 trim() check on stage must tolerate a
    // non-string stage value (loose-schema discipline).
    const marker = {
      version: "1",
      epic_id: "factory-core-wlsr",
      status: "needs-decision",
      stage: 12345, // malformed — numeric stage
      started_at: "2026-05-06T10:00:00Z",
      exited_at: "2026-05-06T10:30:00Z",
      next_agent: "operator",
    } as unknown as MarkerData;

    expect(() => interpretMarkerForRouting(marker, mockSnapshot)).not.toThrow();
    const result = interpretMarkerForRouting(marker, mockSnapshot);
    // Per ADR-004 fail-safe: non-string stage is treated as missing →
    // rewrite to coherence.
    expect(result.override).toBe(true);
    expect(result.nextAgent).toBe("coherence");
  });

  test("function does NOT throw on next_agent='operator' + whitespace-only stage", () => {
    const marker = {
      version: "1",
      epic_id: "factory-core-wlsr",
      status: "needs-decision",
      stage: "   ", // whitespace-only — trims to empty string
      started_at: "2026-05-06T10:00:00Z",
      exited_at: "2026-05-06T10:30:00Z",
      next_agent: "operator",
    } as unknown as MarkerData;

    expect(() => interpretMarkerForRouting(marker, mockSnapshot)).not.toThrow();
    const result = interpretMarkerForRouting(marker, mockSnapshot);
    // Whitespace-only stage trims to empty → treated as missing per ADR-004.
    expect(result.override).toBe(true);
    expect(result.nextAgent).toBe("coherence");
  });
});
