// =============================================================================
// Tests for src/hooks/useAttentionItems.ts
// =============================================================================
// Covers:
//   - Returns empty result for undefined / empty input
//   - Flatly aggregates items across multiple epics
//   - Groups items by epicId
//   - totalCount matches allItems.length
//   - Excludes closed epics
//   - Includes child-level "human" flags alongside epic-level checkpoints
//   - Memoises on array reference (stable output when input unchanged)
// (factory-core-509.4)
// =============================================================================

import React from "react";
import { renderHook } from "@testing-library/react";
import { useAttentionItems } from "@/hooks/useAttentionItems";
import type { PlanIssue } from "@/lib/types";

// ---------------------------------------------------------------------------
// Helper — mock PlanIssue factory
// ---------------------------------------------------------------------------

function makePlanIssue(overrides: Partial<PlanIssue> = {}): PlanIssue {
  return {
    id: "ISSUE-1",
    title: "Test issue",
    status: "open",
    priority: 2,
    issue_type: "task",
    blocked_by: [],
    blocks: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Empty / undefined input
// ---------------------------------------------------------------------------

describe("useAttentionItems — empty input", () => {
  it("returns empty result when allIssues is undefined", () => {
    const { result } = renderHook(() => useAttentionItems(undefined));
    expect(result.current.allItems).toEqual([]);
    expect(result.current.countByEpic.size).toBe(0);
    expect(result.current.totalCount).toBe(0);
  });

  it("returns empty result when allIssues is an empty array", () => {
    const { result } = renderHook(() => useAttentionItems([]));
    expect(result.current.allItems).toEqual([]);
    expect(result.current.countByEpic.size).toBe(0);
    expect(result.current.totalCount).toBe(0);
  });

  it("returns empty result when no epics need attention", () => {
    const issues: PlanIssue[] = [
      makePlanIssue({ id: "epic-1", issue_type: "epic", labels: ["pipeline:development"] }),
      makePlanIssue({ id: "epic-1.1", issue_type: "task", epic: "epic-1" }),
    ];
    const { result } = renderHook(() => useAttentionItems(issues));
    expect(result.current.allItems).toEqual([]);
    expect(result.current.countByEpic.size).toBe(0);
    expect(result.current.totalCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Single-epic detection
// ---------------------------------------------------------------------------

describe("useAttentionItems — single epic", () => {
  it("surfaces a verification-needed item from checkpoint:human-verify", () => {
    const issues: PlanIssue[] = [
      makePlanIssue({
        id: "epic-1",
        issue_type: "epic",
        labels: ["pipeline:development", "checkpoint:human-verify"],
      }),
    ];
    const { result } = renderHook(() => useAttentionItems(issues));
    expect(result.current.totalCount).toBe(1);
    expect(result.current.allItems[0]).toMatchObject({
      epicId: "epic-1",
      type: "verification-needed",
      reason: "Human Verification Required",
      targetLabel: "checkpoint:human-verify",
    });
    expect(result.current.countByEpic.get("epic-1")?.length).toBe(1);
  });

  it("surfaces multiple items from one epic with multiple checkpoint labels", () => {
    const issues: PlanIssue[] = [
      makePlanIssue({
        id: "epic-1",
        issue_type: "epic",
        labels: ["checkpoint:human-verify", "qa:needs-review"],
      }),
    ];
    const { result } = renderHook(() => useAttentionItems(issues));
    expect(result.current.totalCount).toBe(2);
    expect(result.current.countByEpic.get("epic-1")?.length).toBe(2);
  });

  it("surfaces a human-flagged child bead alongside its parent epic", () => {
    const issues: PlanIssue[] = [
      makePlanIssue({ id: "epic-1", issue_type: "epic", labels: ["pipeline:development"] }),
      makePlanIssue({
        id: "epic-1.3",
        title: "Flagged child",
        issue_type: "task",
        epic: "epic-1",
        labels: ["human"],
      }),
    ];
    const { result } = renderHook(() => useAttentionItems(issues));
    expect(result.current.totalCount).toBe(1);
    const item = result.current.allItems[0];
    expect(item.type).toBe("human-flagged");
    expect(item.beadId).toBe("epic-1.3");
    expect(item.beadTitle).toBe("Flagged child");
    expect(item.epicId).toBe("epic-1");
  });
});

// ---------------------------------------------------------------------------
// Multi-epic aggregation
// ---------------------------------------------------------------------------

describe("useAttentionItems — multi-epic aggregation", () => {
  it("flattens items across multiple epics and groups them per epic", () => {
    const issues: PlanIssue[] = [
      makePlanIssue({ id: "e1", issue_type: "epic", labels: ["checkpoint:human-verify"] }),
      makePlanIssue({ id: "e2", issue_type: "epic", labels: ["checkpoint:decision"] }),
      makePlanIssue({ id: "e3", issue_type: "epic", labels: ["qa:needs-review"] }),
      // no attention
      makePlanIssue({ id: "e4", issue_type: "epic", labels: ["pipeline:development"] }),
    ];
    const { result } = renderHook(() => useAttentionItems(issues));
    expect(result.current.totalCount).toBe(3);
    expect(result.current.countByEpic.size).toBe(3);
    expect(result.current.countByEpic.get("e1")?.[0].type).toBe("verification-needed");
    expect(result.current.countByEpic.get("e2")?.[0].type).toBe("decision-required");
    expect(result.current.countByEpic.get("e3")?.[0].type).toBe("qa-review");
    expect(result.current.countByEpic.has("e4")).toBe(false);
  });

  it("excludes closed epics even if they carry stale checkpoint labels", () => {
    const issues: PlanIssue[] = [
      makePlanIssue({
        id: "closed-epic",
        issue_type: "epic",
        status: "closed",
        labels: ["pipeline:completed", "checkpoint:human-verify"],
      }),
      makePlanIssue({
        id: "open-epic",
        issue_type: "epic",
        labels: ["checkpoint:human-verify"],
      }),
    ];
    const { result } = renderHook(() => useAttentionItems(issues));
    expect(result.current.totalCount).toBe(1);
    expect(result.current.countByEpic.has("closed-epic")).toBe(false);
    expect(result.current.countByEpic.has("open-epic")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// totalCount consistency (ADR-002 single source of truth)
// ---------------------------------------------------------------------------

describe("useAttentionItems — totalCount integrity", () => {
  it("keeps totalCount aligned with allItems.length", () => {
    const issues: PlanIssue[] = [
      makePlanIssue({
        id: "e1",
        issue_type: "epic",
        labels: ["checkpoint:human-verify", "checkpoint:human-action"],
      }),
      makePlanIssue({ id: "e2", issue_type: "epic", labels: ["qa:needs-review"] }),
      makePlanIssue({ id: "e2.1", issue_type: "task", epic: "e2", labels: ["human"] }),
    ];
    const { result } = renderHook(() => useAttentionItems(issues));
    expect(result.current.totalCount).toBe(result.current.allItems.length);
    expect(result.current.totalCount).toBe(4);
  });

  it("keeps card-grouped counts consistent with the flat total", () => {
    const issues: PlanIssue[] = [
      makePlanIssue({ id: "e1", issue_type: "epic", labels: ["checkpoint:human-verify"] }),
      makePlanIssue({ id: "e2", issue_type: "epic", labels: ["checkpoint:decision"] }),
    ];
    const { result } = renderHook(() => useAttentionItems(issues));
    const groupedTotal = Array.from(result.current.countByEpic.values()).reduce(
      (sum, items) => sum + items.length,
      0,
    );
    expect(groupedTotal).toBe(result.current.totalCount);
  });
});

// ---------------------------------------------------------------------------
// Memoisation
// ---------------------------------------------------------------------------

describe("useAttentionItems — memoisation", () => {
  it("returns the same result object across re-renders when input is unchanged", () => {
    const issues: PlanIssue[] = [
      makePlanIssue({ id: "e1", issue_type: "epic", labels: ["checkpoint:human-verify"] }),
    ];
    const { result, rerender } = renderHook(({ input }) => useAttentionItems(input), {
      initialProps: { input: issues },
    });
    const first = result.current;
    rerender({ input: issues });
    expect(result.current).toBe(first);
  });

  it("recomputes when the input reference changes", () => {
    const a: PlanIssue[] = [
      makePlanIssue({ id: "e1", issue_type: "epic", labels: ["checkpoint:human-verify"] }),
    ];
    const b: PlanIssue[] = [
      ...a,
      makePlanIssue({ id: "e2", issue_type: "epic", labels: ["qa:needs-review"] }),
    ];
    const { result, rerender } = renderHook(({ input }) => useAttentionItems(input), {
      initialProps: { input: a },
    });
    expect(result.current.totalCount).toBe(1);
    rerender({ input: b });
    expect(result.current.totalCount).toBe(2);
  });
});
