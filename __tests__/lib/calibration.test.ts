// =============================================================================
// Tests for src/lib/calibration.ts — Historical estimate calibration
// =============================================================================

import {
  computeCalibration,
  applyCalibratedEstimate,
  hasCalibrationData,
} from "@/lib/calibration";
import type { PlanIssue } from "@/lib/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIssue(overrides: Partial<PlanIssue> & { id: string }): PlanIssue {
  return {
    title: overrides.id,
    status: "open",
    priority: 2,
    issue_type: "task",
    blocked_by: [],
    blocks: [],
    ...overrides,
  };
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

function makeClosedWithEstimate(
  id: string,
  issueType: string,
  priority: number,
  estimatedMinutes: number,
  actualDays: number
): PlanIssue {
  return makeIssue({
    id,
    status: "closed",
    issue_type: issueType as any,
    priority: priority as any,
    estimated_minutes: estimatedMinutes,
    created_at: daysAgo(actualDays + 1),
    closed_at: daysAgo(1),
  });
}

// ---------------------------------------------------------------------------
// computeCalibration
// ---------------------------------------------------------------------------

describe("computeCalibration", () => {
  it("returns empty when no closed issues", () => {
    const factors = computeCalibration([makeIssue({ id: "A" })]);
    expect(Object.keys(factors)).toHaveLength(0);
  });

  it("returns empty when fewer than 5 samples per bucket", () => {
    const issues = Array.from({ length: 4 }, (_, i) =>
      makeClosedWithEstimate(`C-${i}`, "task", 1, 120, 1)
    );
    const factors = computeCalibration(issues);
    expect(Object.keys(factors)).toHaveLength(0);
  });

  it("computes factor when 5+ samples exist", () => {
    // 5 P1 tasks, each estimated at 120 min, each took 1 day (1440 min)
    const issues = Array.from({ length: 5 }, (_, i) =>
      makeClosedWithEstimate(`C-${i}`, "task", 1, 120, 1)
    );
    const factors = computeCalibration(issues);
    expect(factors["task_p1"]).toBeDefined();
    expect(factors["task_p1"].sampleCount).toBe(5);
    // actual ~1440 min / estimated 120 min = ~12.0 factor
    expect(factors["task_p1"].factor).toBeGreaterThan(10);
  });

  it("groups by issue_type and priority", () => {
    const issues = [
      // bugs estimated 60 min, took 0.5 days (~720 min) → factor ~12
      ...Array.from({ length: 5 }, (_, i) =>
        makeClosedWithEstimate(`bug-${i}`, "bug", 0, 60, 0.5)
      ),
      // tasks estimated 1440 min, took 2 days (~2880 min) → factor ~2
      ...Array.from({ length: 5 }, (_, i) =>
        makeClosedWithEstimate(`task-${i}`, "task", 2, 1440, 2)
      ),
    ];
    const factors = computeCalibration(issues);
    expect(factors["bug_p0"]).toBeDefined();
    expect(factors["task_p2"]).toBeDefined();
    // Different estimate/actual ratios should produce different factors
    expect(factors["bug_p0"].factor).toBeGreaterThan(factors["task_p2"].factor);
  });

  it("ignores issues without estimated_minutes", () => {
    const issues = Array.from({ length: 10 }, (_, i) =>
      makeIssue({
        id: `C-${i}`,
        status: "closed",
        issue_type: "task",
        priority: 1,
        created_at: daysAgo(3),
        closed_at: daysAgo(1),
        // no estimated_minutes
      })
    );
    const factors = computeCalibration(issues);
    expect(Object.keys(factors)).toHaveLength(0);
  });

  it("ignores issues with 0 estimated_minutes", () => {
    const issues = Array.from({ length: 5 }, (_, i) =>
      makeIssue({
        id: `C-${i}`,
        status: "closed",
        issue_type: "task",
        priority: 1,
        estimated_minutes: 0,
        created_at: daysAgo(3),
        closed_at: daysAgo(1),
      })
    );
    const factors = computeCalibration(issues);
    expect(Object.keys(factors)).toHaveLength(0);
  });

  it("ignores open issues", () => {
    const issues = Array.from({ length: 10 }, (_, i) =>
      makeIssue({
        id: `O-${i}`,
        status: "open",
        estimated_minutes: 120,
        created_at: daysAgo(5),
      })
    );
    const factors = computeCalibration(issues);
    expect(Object.keys(factors)).toHaveLength(0);
  });

  it("factor < 1 means estimates are too high", () => {
    // Estimated 1440 min (1 day) each, actually took ~0.5 days = ~720 min
    const issues = Array.from({ length: 5 }, (_, i) =>
      makeClosedWithEstimate(`C-${i}`, "task", 2, 1440, 0.5)
    );
    const factors = computeCalibration(issues);
    expect(factors["task_p2"].factor).toBeLessThan(1);
  });
});

// ---------------------------------------------------------------------------
// applyCalibratedEstimate
// ---------------------------------------------------------------------------

describe("applyCalibratedEstimate", () => {
  const factors = {
    task_p1: { factor: 1.5, sampleCount: 10 },
    bug_p0: { factor: 0.8, sampleCount: 7 },
  };

  it("applies factor to estimate", () => {
    expect(applyCalibratedEstimate(100, "task", 1, factors)).toBe(150);
  });

  it("returns original when no factor for bucket", () => {
    expect(applyCalibratedEstimate(100, "feature", 2, factors)).toBe(100);
  });

  it("rounds to nearest integer", () => {
    expect(applyCalibratedEstimate(100, "bug", 0, factors)).toBe(80);
  });

  it("handles factor < 1 (overestimation)", () => {
    const result = applyCalibratedEstimate(200, "bug", 0, factors);
    expect(result).toBe(160); // 200 * 0.8
  });

  it("handles empty factors", () => {
    expect(applyCalibratedEstimate(100, "task", 1, {})).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// hasCalibrationData
// ---------------------------------------------------------------------------

describe("hasCalibrationData", () => {
  it("returns false for empty factors", () => {
    expect(hasCalibrationData({})).toBe(false);
  });

  it("returns true when factors exist", () => {
    expect(
      hasCalibrationData({ task_p1: { factor: 1.2, sampleCount: 10 } })
    ).toBe(true);
  });
});
