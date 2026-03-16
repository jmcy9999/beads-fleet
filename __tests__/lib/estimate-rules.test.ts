// =============================================================================
// Tests for src/lib/estimate-rules.ts — Risk modifiers and base estimates
// =============================================================================

import {
  RISK_MODIFIERS,
  BASE_MINUTES,
  applyRiskModifiers,
  computeEstimate,
} from "@/lib/estimate-rules";

// ---------------------------------------------------------------------------
// applyRiskModifiers
// ---------------------------------------------------------------------------

describe("applyRiskModifiers", () => {
  it("returns base unchanged when no risk labels", () => {
    expect(applyRiskModifiers(120, ["release:2.1", "some-label"])).toBe(120);
  });

  it("adds modifier for a single risk label", () => {
    expect(applyRiskModifiers(120, ["external-api"])).toBe(120 + 2160);
  });

  it("stacks multiple risk modifiers", () => {
    const result = applyRiskModifiers(120, ["external-api", "ui-polish"]);
    expect(result).toBe(120 + 2160 + 2880);
  });

  it("handles empty labels array", () => {
    expect(applyRiskModifiers(120, [])).toBe(120);
  });

  it("ignores non-risk labels mixed with risk labels", () => {
    const result = applyRiskModifiers(100, ["release:2.1", "needs-testing", "checkpoint"]);
    expect(result).toBe(100 + RISK_MODIFIERS["needs-testing"]);
  });

  it("applies all known risk modifiers", () => {
    const allRiskLabels = Object.keys(RISK_MODIFIERS);
    const totalModifiers = Object.values(RISK_MODIFIERS).reduce((a, b) => a + b, 0);
    expect(applyRiskModifiers(0, allRiskLabels)).toBe(totalModifiers);
  });

  it("handles architecture-change correctly", () => {
    expect(applyRiskModifiers(240, ["architecture-change"])).toBe(240 + 1440);
  });

  it("handles compliance label", () => {
    expect(applyRiskModifiers(60, ["compliance"])).toBe(60 + 960);
  });

  it("handles performance label", () => {
    expect(applyRiskModifiers(60, ["performance"])).toBe(60 + 720);
  });

  it("handles migration label", () => {
    expect(applyRiskModifiers(60, ["migration"])).toBe(60 + 1440);
  });
});

// ---------------------------------------------------------------------------
// computeEstimate
// ---------------------------------------------------------------------------

describe("computeEstimate", () => {
  it("uses estimated_minutes when provided", () => {
    expect(computeEstimate(480, "task", [])).toBe(480);
  });

  it("falls back to base for issue type when no estimate", () => {
    expect(computeEstimate(undefined, "bug", [])).toBe(BASE_MINUTES.bug);
    expect(computeEstimate(undefined, "task", [])).toBe(BASE_MINUTES.task);
    expect(computeEstimate(undefined, "feature", [])).toBe(BASE_MINUTES.feature);
    expect(computeEstimate(undefined, "epic", [])).toBe(BASE_MINUTES.epic);
  });

  it("falls back to task base for unknown issue type", () => {
    expect(computeEstimate(undefined, "unknown-type", [])).toBe(BASE_MINUTES.task);
  });

  it("treats 0 estimate as missing (falls back to base)", () => {
    expect(computeEstimate(0, "bug", [])).toBe(BASE_MINUTES.bug);
  });

  it("applies risk modifiers on top of explicit estimate", () => {
    expect(computeEstimate(120, "task", ["external-api"])).toBe(120 + 2160);
  });

  it("applies risk modifiers on top of base estimate", () => {
    expect(computeEstimate(undefined, "bug", ["ui-polish"])).toBe(
      BASE_MINUTES.bug + 2880
    );
  });

  it("stacks risk modifiers with explicit estimate", () => {
    const result = computeEstimate(200, "feature", ["external-api", "needs-testing"]);
    expect(result).toBe(200 + 2160 + 1440);
  });
});

// ---------------------------------------------------------------------------
// Constants sanity checks
// ---------------------------------------------------------------------------

describe("RISK_MODIFIERS", () => {
  it("all values are positive numbers", () => {
    for (const [label, value] of Object.entries(RISK_MODIFIERS)) {
      expect(typeof value).toBe("number");
      expect(value).toBeGreaterThan(0);
    }
  });
});

describe("BASE_MINUTES", () => {
  it("covers all standard issue types", () => {
    expect(BASE_MINUTES).toHaveProperty("bug");
    expect(BASE_MINUTES).toHaveProperty("task");
    expect(BASE_MINUTES).toHaveProperty("feature");
    expect(BASE_MINUTES).toHaveProperty("epic");
  });

  it("all values are positive", () => {
    for (const value of Object.values(BASE_MINUTES)) {
      expect(value).toBeGreaterThan(0);
    }
  });

  it("epic > feature > task > bug (complexity ordering)", () => {
    expect(BASE_MINUTES.epic).toBeGreaterThan(BASE_MINUTES.feature);
    expect(BASE_MINUTES.feature).toBeGreaterThan(BASE_MINUTES.task);
    expect(BASE_MINUTES.task).toBeGreaterThan(BASE_MINUTES.bug);
  });
});
