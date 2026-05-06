// =============================================================================
// Tests — Marker Routing Interpretation (beads_web-gc2)
// =============================================================================
//
// 12 unit tests covering:
// - All 5 precedence branches (per architect memo § 6 Q4)
// - All blocker-class mappings (per architect memo § 4)
// - Fallback/edge cases (invalid marker, unknown blocker_class, etc.)
//
// Pure function tests — no I/O mocking needed. Pass mock MarkerData directly.
// =============================================================================

import { interpretMarkerForRouting } from "../../src/lib/marker-routing";
import type { MarkerData } from "../../src/lib/marker-reader";
import type { EpicStateSnapshot } from "../../src/lib/marker-routing";

describe("marker-routing (beads_web-gc2)", () => {
  const mockSnapshot: EpicStateSnapshot = {
    epicId: "factory-core-lmxb",
    currentStage: "planner",
    labels: ["pipeline:plan-review"],
  };

  // Test 1: Explicit next_agent → returns it (AC 5 test 1)
  test("explicit next_agent field → override=true, returns nextAgent", () => {
    const marker: MarkerData = {
      version: "1",
      epic_id: "factory-core-lmxb",
      status: "needs-decision",
      stage: "planner",
      started_at: "2026-05-01T10:00:00Z",
      exited_at: "2026-05-01T10:30:00Z",
      next_agent: "architect",
    };

    const result = interpretMarkerForRouting(marker, mockSnapshot);

    expect(result.override).toBe(true);
    expect(result.nextAgent).toBe("architect");
    expect(result.reason).toContain("explicit next_agent field");
  });

  // Test 2: blocked + design-question → architect (AC 5 test 2)
  test("status=blocked, blocker_class=design-question → architect", () => {
    const marker: MarkerData = {
      version: "1",
      epic_id: "factory-core-lmxb",
      status: "blocked",
      stage: "planner",
      started_at: "2026-05-01T10:00:00Z",
      exited_at: "2026-05-01T10:30:00Z",
      blocker_class: "design-question",
    };

    const result = interpretMarkerForRouting(marker, mockSnapshot);

    expect(result.override).toBe(true);
    expect(result.nextAgent).toBe("architect");
    expect(result.reason).toContain("blocker_class=design-question");
  });

  // Test 3: blocked + test-fail → builder (AC 5 test 3)
  test("status=blocked, blocker_class=test-fail → builder", () => {
    const marker: MarkerData = {
      version: "1",
      bead_id: "factory-core-a4tx.21",
      status: "blocked",
      stage: "builder",
      started_at: "2026-05-01T14:00:00Z",
      exited_at: "2026-05-01T15:00:00Z",
      blocker_class: "test-fail",
    };

    const result = interpretMarkerForRouting(marker, mockSnapshot);

    expect(result.override).toBe(true);
    expect(result.nextAgent).toBe("builder");
    expect(result.reason).toContain("blocker_class=test-fail");
  });

  // Test 4: blocked + orchestrator-down → coherence (factory-core-wlsr.18
  // divergence fix). Per ADR-008 (universal-coherence-routing-agents-
  // never-architecture.md lines 925-933), the architect explicitly REJECTED
  // a separate operator-direct routing path for orchestrator-down.
  // orchestrator-down → coherence; coherence then escalates to operator
  // with escalationReason="external-dependency-failure" via its own
  // marker. This test guards the divergence fix (was: operator).
  // Standing-order alignment: marker-protocol.md § 2 routing table
  // line 137 maps orchestrator-down → coherence (post-wlsr.5).
  test("status=blocked, blocker_class=orchestrator-down → coherence (wlsr.18 divergence fix per ADR-008)", () => {
    const marker: MarkerData = {
      version: "1",
      epic_id: "factory-core-lmxb",
      status: "blocked",
      stage: "planner",
      started_at: "2026-05-01T10:00:00Z",
      exited_at: "2026-05-01T10:30:00Z",
      blocker_class: "orchestrator-down",
    };

    const result = interpretMarkerForRouting(marker, mockSnapshot);

    expect(result.override).toBe(true);
    // wlsr.18: was "operator" pre-fix; now "coherence" per ADR-008.
    // Coherence handles the orchestrator-down → escalate-to-operator path
    // with escalationReason="external-dependency-failure".
    expect(result.nextAgent).toBe("coherence");
    expect(result.reason).toContain("blocker_class=orchestrator-down");
    expect(result.reason).toContain("coherence");
  });

  // Test 5: blocked + unknown blocker_class → coherence fallback (AC 5 test 5)
  test("status=blocked, blocker_class=unknown-value → coherence fallback", () => {
    const marker: MarkerData = {
      version: "1",
      epic_id: "factory-core-lmxb",
      status: "blocked",
      stage: "planner",
      started_at: "2026-05-01T10:00:00Z",
      exited_at: "2026-05-01T10:30:00Z",
      blocker_class: "some-future-blocker-class",
    };

    const result = interpretMarkerForRouting(marker, mockSnapshot);

    expect(result.override).toBe(true);
    expect(result.nextAgent).toBe("coherence");
    expect(result.reason).toContain("unknown blocker_class");
    expect(result.reason).toContain("fallback to coherence");
  });

  // Test 6: needs-decision + BLOCKER in whats_open → coherence (AC 5 test 6)
  test("status=needs-decision, BLOCKER in whats_open → coherence", () => {
    const marker: MarkerData = {
      version: "1",
      epic_id: "factory-core-3p1e",
      status: "needs-decision",
      stage: "qa",
      started_at: "2026-05-01T16:00:00Z",
      exited_at: "2026-05-01T16:45:00Z",
      whats_open: [
        "BLOCKER: Test infrastructure broken",
        "FOLLOW-ON: Update docs",
      ],
    };

    const result = interpretMarkerForRouting(marker, mockSnapshot);

    expect(result.override).toBe(true);
    expect(result.nextAgent).toBe("coherence");
    expect(result.reason).toContain("needs-decision with BLOCKER");
  });

  // Test 7: success + no next_agent → override=false (AC 5 test 7)
  test("status=success, next_agent absent → override=false (fallback to pipeline-routes)", () => {
    const marker: MarkerData = {
      version: "1",
      bead_id: "factory-core-a4tx.27",
      status: "success",
      stage: "builder",
      started_at: "2026-05-01T14:00:00Z",
      exited_at: "2026-05-01T15:00:00Z",
    };

    const result = interpretMarkerForRouting(marker, mockSnapshot);

    expect(result.override).toBe(false);
    expect(result.reason).toContain("fallback to pipeline-routes");
  });

  // Test 8: failure → coherence (factory-core-wlsr.3 AC 7 — was:
  // re-dispatch same agent). Per operator-set principle P2, failure is a
  // non-success outcome that merits coherence reasoning rather than blind
  // same-agent re-dispatch. See marker-routing-coherence-rewrite.test.ts
  // for the full new-behaviour test suite.
  test("status=failure → coherence (wlsr.3 Precedence 5 change)", () => {
    const marker: MarkerData = {
      version: "1",
      bead_id: "factory-core-a4tx.21",
      status: "failure",
      stage: "builder",
      started_at: "2026-05-01T14:00:00Z",
      exited_at: "2026-05-01T15:00:00Z",
      surprises_or_findings: "Build failed: missing dependency",
    };

    const result = interpretMarkerForRouting(marker, mockSnapshot);

    expect(result.override).toBe(true);
    expect(result.nextAgent).toBe("coherence");
    expect(result.reason).toContain("status=failure");
  });

  // Test 9: both next_agent and blocker_class → next_agent wins (AC 5 test 9)
  test("marker with both next_agent and blocker_class → next_agent wins (precedence)", () => {
    const marker: MarkerData = {
      version: "1",
      epic_id: "factory-core-lmxb",
      status: "blocked",
      stage: "planner",
      started_at: "2026-05-01T10:00:00Z",
      exited_at: "2026-05-01T10:30:00Z",
      next_agent: "planner",
      blocker_class: "design-question", // would map to architect, but next_agent wins
    };

    const result = interpretMarkerForRouting(marker, mockSnapshot);

    expect(result.override).toBe(true);
    expect(result.nextAgent).toBe("planner");
    expect(result.reason).toContain("explicit next_agent field");
  });

  // Test 10: success + explicit next_agent → override=true (AC 5 test 10)
  test("status=success but next_agent=planner → override=true (explicit override beats status)", () => {
    const marker: MarkerData = {
      version: "1",
      epic_id: "factory-core-lmxb",
      status: "success",
      stage: "architect",
      started_at: "2026-05-01T09:00:00Z",
      exited_at: "2026-05-01T10:00:00Z",
      next_agent: "planner",
    };

    const result = interpretMarkerForRouting(marker, mockSnapshot);

    expect(result.override).toBe(true);
    expect(result.nextAgent).toBe("planner");
    expect(result.reason).toContain("explicit next_agent field");
  });

  // Test 11: invalid marker (missing status) → override=false (AC 5 test 11)
  test("invalid marker (missing status field) → override=false", () => {
    const marker: Partial<MarkerData> = {
      version: "1",
      epic_id: "factory-core-lmxb",
      // status missing
      stage: "planner",
      started_at: "2026-05-01T10:00:00Z",
      exited_at: "2026-05-01T10:30:00Z",
    };

    const result = interpretMarkerForRouting(
      marker as MarkerData,
      mockSnapshot,
    );

    expect(result.override).toBe(false);
    expect(result.reason).toContain("invalid marker");
  });

  // Test 12: status=blocked with no blocker_class → coherence safety net (beads_web-02d AC 1-2)
  test("status=blocked, blocker_class absent → coherence safety net", () => {
    const marker: MarkerData = {
      version: "1",
      epic_id: "factory-core-lmxb",
      status: "blocked",
      stage: "planner",
      started_at: "2026-05-01T10:00:00Z",
      exited_at: "2026-05-01T10:30:00Z",
      // blocker_class intentionally absent
    };

    const result = interpretMarkerForRouting(marker, mockSnapshot);

    expect(result.override).toBe(true);
    expect(result.nextAgent).toBe("coherence");
    expect(result.reason).toContain("no blocker_class");
    expect(result.reason).toContain("coherence");
  });

  // Test 13: status=blocked, blocker_class=null → coherence safety net (beads_web-02d AC 2)
  test("status=blocked, blocker_class=null → coherence safety net", () => {
    const marker: MarkerData = {
      version: "1",
      epic_id: "factory-core-lmxb",
      status: "blocked",
      stage: "planner",
      started_at: "2026-05-01T10:00:00Z",
      exited_at: "2026-05-01T10:30:00Z",
      blocker_class: null as unknown as string,
    };

    const result = interpretMarkerForRouting(marker, mockSnapshot);

    expect(result.override).toBe(true);
    expect(result.nextAgent).toBe("coherence");
    expect(result.reason).toContain("no blocker_class");
  });

  // Test 14: status=blocked, blocker_class=undefined → coherence safety net (beads_web-02d AC 2)
  test("status=blocked, blocker_class=undefined → coherence safety net", () => {
    const marker: MarkerData = {
      version: "1",
      epic_id: "factory-core-lmxb",
      status: "blocked",
      stage: "planner",
      started_at: "2026-05-01T10:00:00Z",
      exited_at: "2026-05-01T10:30:00Z",
      blocker_class: undefined,
    };

    const result = interpretMarkerForRouting(marker, mockSnapshot);

    expect(result.override).toBe(true);
    expect(result.nextAgent).toBe("coherence");
    expect(result.reason).toContain("no blocker_class");
  });

  // Test 15: status=blocked, blocker_class="" (empty string) → coherence safety net (beads_web-02d)
  test("status=blocked, blocker_class=empty-string → coherence safety net", () => {
    const marker: MarkerData = {
      version: "1",
      epic_id: "factory-core-lmxb",
      status: "blocked",
      stage: "planner",
      started_at: "2026-05-01T10:00:00Z",
      exited_at: "2026-05-01T10:30:00Z",
      blocker_class: "",
    };

    const result = interpretMarkerForRouting(marker, mockSnapshot);

    // empty string is falsy — Precedence 2 skipped, Precedence 2.5 catches it
    expect(result.override).toBe(true);
    expect(result.nextAgent).toBe("coherence");
    expect(result.reason).toContain("no blocker_class");
  });

  // Test 16: Verify existing blocked+blocker_class still works after fix (beads_web-02d verification)
  test("status=blocked, blocker_class=design-question still routes to architect (regression guard)", () => {
    const marker: MarkerData = {
      version: "1",
      epic_id: "factory-core-lmxb",
      status: "blocked",
      stage: "planner",
      started_at: "2026-05-01T10:00:00Z",
      exited_at: "2026-05-01T10:30:00Z",
      blocker_class: "design-question",
      next_agent: "architect",
    };

    const result = interpretMarkerForRouting(marker, mockSnapshot);

    // next_agent wins (Precedence 1)
    expect(result.override).toBe(true);
    expect(result.nextAgent).toBe("architect");
    expect(result.reason).toContain("explicit next_agent field");
  });

  // Test 17: Verify status=success with no next_agent still falls through (beads_web-02d non-blocked guard)
  test("status=success, no next_agent → still override=false (no regression from blocked fix)", () => {
    const marker: MarkerData = {
      version: "1",
      bead_id: "factory-core-a4tx.15",
      status: "success",
      stage: "builder",
      started_at: "2026-05-01T14:00:00Z",
      exited_at: "2026-05-01T15:00:00Z",
    };

    const result = interpretMarkerForRouting(marker, mockSnapshot);

    expect(result.override).toBe(false);
    expect(result.reason).toContain("fallback to pipeline-routes");
  });

  // Test 18: needs-decision without BLOCKER → coherence (factory-core-
  // wlsr.3 AC 6 — was: fallthrough to override=false). Per operator-set
  // principle P2, needs-decision is a non-success outcome (the agent saying
  // "I don't know") and now routes to coherence rather than silently
  // falling through. See marker-routing-coherence-rewrite.test.ts for the
  // full new-behaviour test suite.
  test("whats_open present but no BLOCKER prefix → coherence (wlsr.3 Precedence 3.5)", () => {
    const marker: MarkerData = {
      version: "1",
      epic_id: "factory-core-3p1e",
      status: "needs-decision",
      stage: "qa",
      started_at: "2026-05-01T16:00:00Z",
      exited_at: "2026-05-01T16:45:00Z",
      whats_open: [
        "FOLLOW-ON: Update docs",
        "FOLLOW-ON: Refactor test helpers",
      ],
    };

    const result = interpretMarkerForRouting(marker, mockSnapshot);

    expect(result.override).toBe(true);
    expect(result.nextAgent).toBe("coherence");
    expect(result.reason).toContain("needs-decision");
    expect(result.reason).toContain("without BLOCKER");
  });
});
