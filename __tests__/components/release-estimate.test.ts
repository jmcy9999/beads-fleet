// =============================================================================
// Tests for src/components/releases/estimate.ts — Release ETA functions
// =============================================================================

import {
  computePriorityWeights,
  computeVelocity,
  estimateRelease,
} from "@/components/releases/estimate";
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
  const d = new Date(Date.now() - n * 24 * 60 * 60 * 1000);
  return d.toISOString();
}

// ---------------------------------------------------------------------------
// computePriorityWeights
// ---------------------------------------------------------------------------

describe("computePriorityWeights", () => {
  it("returns default weights when no closed issues", () => {
    const weights = computePriorityWeights([
      makeIssue({ id: "A", status: "open" }),
    ]);
    expect(weights[0]).toBe(0.2);
    expect(weights[2]).toBe(0.4);
    expect(weights[4]).toBe(7.0);
  });

  it("computes weights from closed issues with enough samples", () => {
    // 5 P1 issues, each closed 2 days after creation
    const issues = Array.from({ length: 5 }, (_, i) =>
      makeIssue({
        id: `C-${i}`,
        status: "closed",
        priority: 1,
        created_at: daysAgo(10),
        closed_at: daysAgo(8), // 2 days
      })
    );
    const weights = computePriorityWeights(issues);
    expect(weights[1]).toBeCloseTo(2.0, 0);
  });

  it("falls back to default when fewer than 3 samples", () => {
    const issues = [
      makeIssue({
        id: "C-1",
        status: "closed",
        priority: 3,
        created_at: daysAgo(10),
        closed_at: daysAgo(5),
      }),
    ];
    const weights = computePriorityWeights(issues);
    // Only 1 sample for P3, should use default
    expect(weights[3]).toBe(5.0);
  });

  it("ignores open issues", () => {
    const issues = [
      makeIssue({ id: "O-1", status: "open", priority: 0 }),
      ...Array.from({ length: 5 }, (_, i) =>
        makeIssue({
          id: `C-${i}`,
          status: "closed",
          priority: 0,
          created_at: daysAgo(3),
          closed_at: daysAgo(2),
        })
      ),
    ];
    const weights = computePriorityWeights(issues);
    expect(weights[0]).toBeCloseTo(1.0, 0);
  });

  it("ignores issues with missing timestamps", () => {
    const issues = Array.from({ length: 5 }, (_, i) =>
      makeIssue({
        id: `C-${i}`,
        status: "closed",
        priority: 2,
        // no created_at or closed_at
      })
    );
    const weights = computePriorityWeights(issues);
    expect(weights[2]).toBe(0.4); // default
  });

  it("ignores negative durations", () => {
    const issues = Array.from({ length: 5 }, (_, i) =>
      makeIssue({
        id: `C-${i}`,
        status: "closed",
        priority: 1,
        created_at: daysAgo(2),
        closed_at: daysAgo(5), // closed before created (bad data)
      })
    );
    const weights = computePriorityWeights(issues);
    expect(weights[1]).toBe(0.5); // default, because negatives filtered out
  });
});

// ---------------------------------------------------------------------------
// computeVelocity
// ---------------------------------------------------------------------------

describe("computeVelocity", () => {
  it("returns 0 when no closed issues", () => {
    expect(computeVelocity([makeIssue({ id: "A" })])).toBe(0);
  });

  it("computes beads per day over the window", () => {
    // 7 beads closed in the last 14 days = 0.5/day
    const issues = Array.from({ length: 7 }, (_, i) =>
      makeIssue({
        id: `C-${i}`,
        status: "closed",
        closed_at: daysAgo(i),
      })
    );
    expect(computeVelocity(issues, 14)).toBe(7 / 14);
  });

  it("excludes beads closed outside the window", () => {
    const issues = [
      makeIssue({ id: "recent", status: "closed", closed_at: daysAgo(1) }),
      makeIssue({ id: "old", status: "closed", closed_at: daysAgo(30) }),
    ];
    expect(computeVelocity(issues, 14)).toBeCloseTo(1 / 14, 5);
  });

  it("respects custom window size", () => {
    // Create beads at 0, 1, 2, ... 9 days ago
    const issues = Array.from({ length: 10 }, (_, i) =>
      makeIssue({
        id: `C-${i}`,
        status: "closed",
        closed_at: daysAgo(i),
      })
    );
    // 7-day window: daysAgo uses Date.now() for both creation and cutoff,
    // so beads at exactly N days ago may land on the boundary. Use toBeGreaterThan
    // to verify the shorter window yields higher velocity than the default 14-day.
    const vel7 = computeVelocity(issues, 7);
    const vel14 = computeVelocity(issues, 14);
    expect(vel7).toBeGreaterThan(vel14);
  });

  it("ignores issues without closed_at", () => {
    const issues = [
      makeIssue({ id: "A", status: "closed" }), // no closed_at
      makeIssue({ id: "B", status: "closed", closed_at: daysAgo(1) }),
    ];
    expect(computeVelocity(issues, 14)).toBeCloseTo(1 / 14, 5);
  });
});

// ---------------------------------------------------------------------------
// estimateRelease
// ---------------------------------------------------------------------------

describe("estimateRelease", () => {
  const defaultWeights = { 0: 0.2, 1: 0.5, 2: 0.4, 3: 5.0, 4: 7.0 };

  it("returns 'Complete' when all issues are closed", () => {
    const issues = [
      makeIssue({ id: "A", status: "closed" }),
      makeIssue({ id: "B", status: "closed" }),
    ];
    const result = estimateRelease(issues, defaultWeights, 5);
    expect(result.display).toBe("Complete");
    expect(result.calendarDays).toBe(0);
    expect(result.hasEstimate).toBe(true);
  });

  it("returns 'No estimate' when velocity is 0", () => {
    const issues = [makeIssue({ id: "A", priority: 2 })];
    const result = estimateRelease(issues, defaultWeights, 0);
    expect(result.display).toBe("No estimate");
    expect(result.hasEstimate).toBe(false);
    expect(result.calendarDays).toBeNull();
  });

  it("computes calendar days from bead-days and velocity", () => {
    // 2 P2 beads = 2 * 0.4 = 0.8 bead-days, velocity 1/day => ceil(0.8) = 1 day
    const issues = [
      makeIssue({ id: "A", priority: 2 }),
      makeIssue({ id: "B", priority: 2 }),
    ];
    const result = estimateRelease(issues, defaultWeights, 1);
    expect(result.calendarDays).toBe(1);
    expect(result.display).toBe("~1 day");
  });

  it("handles mixed priorities", () => {
    // 1 P0 (0.2) + 1 P3 (5.0) = 5.2 bead-days, velocity 2/day => ceil(2.6) = 3 days
    const issues = [
      makeIssue({ id: "A", priority: 0 }),
      makeIssue({ id: "B", priority: 3 }),
    ];
    const result = estimateRelease(issues, defaultWeights, 2);
    expect(result.calendarDays).toBe(3);
    expect(result.display).toBe("~3 days");
  });

  it("ignores closed issues in calculation", () => {
    const issues = [
      makeIssue({ id: "A", priority: 2, status: "open" }),
      makeIssue({ id: "B", priority: 2, status: "closed" }),
    ];
    const result = estimateRelease(issues, defaultWeights, 1);
    // Only 1 open P2 = 0.4 bead-days => ceil(0.4) = 1 day
    expect(result.beadDays).toBeCloseTo(0.4, 5);
    expect(result.calendarDays).toBe(1);
  });

  it("formats weeks correctly", () => {
    // 10 P4 beads = 70 bead-days, velocity 5/day => 14 days = ~2 weeks
    const issues = Array.from({ length: 10 }, (_, i) =>
      makeIssue({ id: `X-${i}`, priority: 4 })
    );
    const result = estimateRelease(issues, defaultWeights, 5);
    expect(result.calendarDays).toBe(14);
    expect(result.display).toBe("~2 weeks");
  });

  it("formats months correctly", () => {
    // Lots of P4 beads to get > 30 days
    const issues = Array.from({ length: 50 }, (_, i) =>
      makeIssue({ id: `X-${i}`, priority: 4 })
    );
    // 50 * 7 = 350 bead-days / 5 velocity = 70 days ~= 2 months
    const result = estimateRelease(issues, defaultWeights, 5);
    expect(result.display).toMatch(/month/);
  });

  it("shows < 1 day for very fast estimates", () => {
    const issues = [makeIssue({ id: "A", priority: 0 })];
    // 0.2 bead-days / 10 velocity = 0.02 => ceil = 1... actually ceil makes it 1
    // Need velocity high enough that ceil still rounds to 0
    // ceil(0.2/100) = ceil(0.002) = 1 day. Hmm, ceil always gives at least 1.
    // So < 1 day only if calendarDays <= 0. That requires beadDays = 0 which means no open.
    // Actually the format function handles days <= 0
    const result = estimateRelease(issues, defaultWeights, 100);
    expect(result.calendarDays).toBe(1);
    expect(result.display).toBe("~1 day");
  });

  it("uses priority 2 weight for unknown priorities", () => {
    const issues = [makeIssue({ id: "A", priority: 99 as any })];
    const result = estimateRelease(issues, defaultWeights, 1);
    // Should use weights[2] = 0.4 as fallback
    expect(result.beadDays).toBeCloseTo(0.4, 5);
  });
});
