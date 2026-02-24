// =============================================================================
// Tests for src/lib/recipes.ts — Filter engine and built-in views
// =============================================================================

import {
  applyFilter,
  BUILT_IN_VIEWS,
  type FilterCriteria,
} from "@/lib/recipes";
import type { PlanIssue } from "@/lib/types";

// ---------------------------------------------------------------------------
// Test data (inline, no DB fixture needed)
// ---------------------------------------------------------------------------

const testPlanIssues: PlanIssue[] = [
  {
    id: "T-1",
    title: "Auth feature",
    status: "open",
    priority: 1,
    issue_type: "feature",
    owner: "alice",
    blocked_by: [],
    blocks: ["T-2"],
    labels: ["auth", "backend"],
  },
  {
    id: "T-2",
    title: "Fix login bug",
    status: "in_progress",
    priority: 0,
    issue_type: "bug",
    owner: "bob",
    blocked_by: ["T-1"],
    blocks: [],
    labels: ["auth", "bug-fix"],
  },
  {
    id: "T-3",
    title: "Write tests",
    status: "blocked",
    priority: 2,
    issue_type: "task",
    owner: "alice",
    blocked_by: ["T-1"],
    blocks: [],
    labels: ["testing"],
  },
  {
    id: "T-4",
    title: "Deploy pipeline",
    status: "closed",
    priority: 1,
    issue_type: "task",
    owner: "charlie",
    blocked_by: [],
    blocks: [],
    labels: ["infra"],
  },
];

describe("applyFilter", () => {
  // ---------------------------------------------------------------------------
  // Empty / no-op filter
  // ---------------------------------------------------------------------------

  describe("empty filter", () => {
    it("returns all issues when filter is empty", () => {
      const result = applyFilter(testPlanIssues, {});
      expect(result).toHaveLength(4);
    });

    it("returns all issues when filter has only undefined fields", () => {
      const filter: FilterCriteria = {
        statuses: undefined,
        priorities: undefined,
        types: undefined,
        owner: undefined,
        search: undefined,
      };
      const result = applyFilter(testPlanIssues, filter);
      expect(result).toHaveLength(4);
    });

    it("returns all issues when filter arrays are empty", () => {
      const filter: FilterCriteria = {
        statuses: [],
        priorities: [],
        types: [],
      };
      const result = applyFilter(testPlanIssues, filter);
      expect(result).toHaveLength(4);
    });
  });

  // ---------------------------------------------------------------------------
  // Status filter
  // ---------------------------------------------------------------------------

  describe("status filter", () => {
    it("filters to open only", () => {
      const result = applyFilter(testPlanIssues, { statuses: ["open"] });
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("T-1");
    });

    it("filters to in_progress only", () => {
      const result = applyFilter(testPlanIssues, {
        statuses: ["in_progress"],
      });
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("T-2");
    });

    it("filters to closed only", () => {
      const result = applyFilter(testPlanIssues, { statuses: ["closed"] });
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("T-4");
    });

    it("filters to multiple statuses", () => {
      const result = applyFilter(testPlanIssues, {
        statuses: ["open", "blocked"],
      });
      expect(result).toHaveLength(2);
      expect(result.map((i) => i.id).sort()).toEqual(["T-1", "T-3"]);
    });

    it("returns empty when no issues match the status", () => {
      const result = applyFilter(testPlanIssues, { statuses: ["deferred"] });
      expect(result).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Priority filter
  // ---------------------------------------------------------------------------

  describe("priority filter", () => {
    it("filters to P0 (critical) only", () => {
      const result = applyFilter(testPlanIssues, { priorities: [0] });
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("T-2");
    });

    it("filters to P0 and P1", () => {
      const result = applyFilter(testPlanIssues, { priorities: [0, 1] });
      expect(result).toHaveLength(3);
      expect(result.map((i) => i.id).sort()).toEqual(["T-1", "T-2", "T-4"]);
    });

    it("filters to P2 only", () => {
      const result = applyFilter(testPlanIssues, { priorities: [2] });
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("T-3");
    });

    it("returns empty when no issues match the priority", () => {
      const result = applyFilter(testPlanIssues, { priorities: [4] });
      expect(result).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Type filter
  // ---------------------------------------------------------------------------

  describe("type filter", () => {
    it("filters to bug only", () => {
      const result = applyFilter(testPlanIssues, { types: ["bug"] });
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("T-2");
    });

    it("filters to feature only", () => {
      const result = applyFilter(testPlanIssues, { types: ["feature"] });
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("T-1");
    });

    it("filters to task only", () => {
      const result = applyFilter(testPlanIssues, { types: ["task"] });
      expect(result).toHaveLength(2);
      expect(result.map((i) => i.id).sort()).toEqual(["T-3", "T-4"]);
    });

    it("filters to multiple types", () => {
      const result = applyFilter(testPlanIssues, {
        types: ["bug", "feature"],
      });
      expect(result).toHaveLength(2);
      expect(result.map((i) => i.id).sort()).toEqual(["T-1", "T-2"]);
    });

    it("returns empty for a type that does not exist", () => {
      const result = applyFilter(testPlanIssues, { types: ["epic"] });
      expect(result).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Owner filter
  // ---------------------------------------------------------------------------

  describe("owner filter", () => {
    it("matches exact owner name", () => {
      const result = applyFilter(testPlanIssues, { owner: "alice" });
      expect(result).toHaveLength(2);
      expect(result.map((i) => i.id).sort()).toEqual(["T-1", "T-3"]);
    });

    it("matches case-insensitively", () => {
      const result = applyFilter(testPlanIssues, { owner: "ALICE" });
      expect(result).toHaveLength(2);
    });

    it("matches partial owner name", () => {
      const result = applyFilter(testPlanIssues, { owner: "ali" });
      expect(result).toHaveLength(2);
      expect(result.map((i) => i.id).sort()).toEqual(["T-1", "T-3"]);
    });

    it("matches partial owner name case-insensitively", () => {
      const result = applyFilter(testPlanIssues, { owner: "BOB" });
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("T-2");
    });

    it("returns empty when no owner matches", () => {
      const result = applyFilter(testPlanIssues, { owner: "nobody" });
      expect(result).toHaveLength(0);
    });

    it("excludes issues with no owner", () => {
      const issuesWithNoOwner: PlanIssue[] = [
        {
          id: "X-1",
          title: "No owner",
          status: "open",
          priority: 1,
          issue_type: "task",
          blocked_by: [],
          blocks: [],
        },
      ];
      const result = applyFilter(issuesWithNoOwner, { owner: "alice" });
      expect(result).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Search filter
  // ---------------------------------------------------------------------------

  describe("search filter", () => {
    it("matches by issue id", () => {
      const result = applyFilter(testPlanIssues, { search: "T-2" });
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("T-2");
    });

    it("matches by title", () => {
      const result = applyFilter(testPlanIssues, { search: "deploy" });
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("T-4");
    });

    it("matches by owner", () => {
      const result = applyFilter(testPlanIssues, { search: "charlie" });
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("T-4");
    });

    it("search is case-insensitive", () => {
      const result = applyFilter(testPlanIssues, { search: "AUTH" });
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("T-1");
    });

    it("partial match works on title", () => {
      const result = applyFilter(testPlanIssues, { search: "login" });
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("T-2");
    });

    it("returns empty when search matches nothing", () => {
      const result = applyFilter(testPlanIssues, {
        search: "xyznonexistent",
      });
      expect(result).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // hasBlockers filter
  // ---------------------------------------------------------------------------

  describe("hasBlockers filter", () => {
    it("true returns only issues with blocked_by entries", () => {
      const result = applyFilter(testPlanIssues, { hasBlockers: true });
      expect(result).toHaveLength(2);
      expect(result.map((i) => i.id).sort()).toEqual(["T-2", "T-3"]);
    });

    it("false returns only issues without blocked_by entries", () => {
      const result = applyFilter(testPlanIssues, { hasBlockers: false });
      expect(result).toHaveLength(2);
      expect(result.map((i) => i.id).sort()).toEqual(["T-1", "T-4"]);
    });
  });

  // ---------------------------------------------------------------------------
  // Labels filter
  // ---------------------------------------------------------------------------

  describe("labels filter", () => {
    it("filters by a single label", () => {
      const result = applyFilter(testPlanIssues, { labels: ["auth"] });
      expect(result).toHaveLength(2);
      expect(result.map((i) => i.id).sort()).toEqual(["T-1", "T-2"]);
    });

    it("filters by multiple labels (OR logic)", () => {
      const result = applyFilter(testPlanIssues, {
        labels: ["infra", "testing"],
      });
      expect(result).toHaveLength(2);
      expect(result.map((i) => i.id).sort()).toEqual(["T-3", "T-4"]);
    });

    it("excludes issues without labels", () => {
      const issuesWithoutLabels: PlanIssue[] = [
        {
          id: "NL-1",
          title: "No labels",
          status: "open",
          priority: 1,
          issue_type: "task",
          blocked_by: [],
          blocks: [],
        },
      ];
      const result = applyFilter(issuesWithoutLabels, { labels: ["auth"] });
      expect(result).toHaveLength(0);
    });

    it("returns empty when no issue has the label", () => {
      const result = applyFilter(testPlanIssues, {
        labels: ["nonexistent-label"],
      });
      expect(result).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Label prefix filter
  // ---------------------------------------------------------------------------

  describe("labelPrefix filter", () => {
    const submissionIssues: PlanIssue[] = [
      {
        id: "S-1",
        title: "App ready for review",
        status: "open",
        priority: 1,
        issue_type: "task",
        blocked_by: [],
        blocks: [],
        labels: ["submission:ready", "app:LensCycle"],
      },
      {
        id: "S-2",
        title: "App in review",
        status: "in_progress",
        priority: 1,
        issue_type: "task",
        blocked_by: [],
        blocks: [],
        labels: ["submission:in-review"],
      },
      {
        id: "S-3",
        title: "No submission label",
        status: "open",
        priority: 2,
        issue_type: "task",
        blocked_by: [],
        blocks: [],
        labels: ["dev"],
      },
      {
        id: "S-4",
        title: "No labels at all",
        status: "open",
        priority: 3,
        issue_type: "task",
        blocked_by: [],
        blocks: [],
      },
    ];

    it("matches issues with labels starting with the prefix", () => {
      const result = applyFilter(submissionIssues, { labelPrefix: "submission:" });
      expect(result).toHaveLength(2);
      expect(result.map((i) => i.id).sort()).toEqual(["S-1", "S-2"]);
    });

    it("excludes issues without matching prefix", () => {
      const result = applyFilter(submissionIssues, { labelPrefix: "nonexistent:" });
      expect(result).toHaveLength(0);
    });

    it("excludes issues with no labels", () => {
      const result = applyFilter(submissionIssues, { labelPrefix: "submission:" });
      expect(result.find((i) => i.id === "S-4")).toBeUndefined();
    });

    it("combines with status filter", () => {
      const result = applyFilter(submissionIssues, {
        labelPrefix: "submission:",
        statuses: ["open"],
      });
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("S-1");
    });
  });

  // ---------------------------------------------------------------------------
  // Multiple filters (AND logic)
  // ---------------------------------------------------------------------------

  describe("combined filters (AND logic)", () => {
    it("status + priority", () => {
      const result = applyFilter(testPlanIssues, {
        statuses: ["open", "in_progress"],
        priorities: [1],
      });
      // open+P1 = T-1, in_progress+P1 = none
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("T-1");
    });

    it("status + type", () => {
      const result = applyFilter(testPlanIssues, {
        statuses: ["open", "in_progress", "blocked"],
        types: ["task"],
      });
      // Non-closed task = T-3 (blocked)
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("T-3");
    });

    it("owner + hasBlockers", () => {
      const result = applyFilter(testPlanIssues, {
        owner: "alice",
        hasBlockers: true,
      });
      // alice + has blockers = T-3
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("T-3");
    });

    it("search + status", () => {
      const result = applyFilter(testPlanIssues, {
        search: "alice",
        statuses: ["open"],
      });
      // alice + open = T-1
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("T-1");
    });

    it("all filters returning nothing", () => {
      const result = applyFilter(testPlanIssues, {
        statuses: ["closed"],
        priorities: [0],
        types: ["feature"],
        owner: "nobody",
      });
      expect(result).toHaveLength(0);
    });

    it("status + labels", () => {
      const result = applyFilter(testPlanIssues, {
        statuses: ["open", "in_progress"],
        labels: ["auth"],
      });
      // open+auth = T-1, in_progress+auth = T-2
      expect(result).toHaveLength(2);
      expect(result.map((i) => i.id).sort()).toEqual(["T-1", "T-2"]);
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe("edge cases", () => {
    it("handles empty issues array", () => {
      const result = applyFilter([], { statuses: ["open"] });
      expect(result).toHaveLength(0);
    });

    it("preserves issue order", () => {
      const result = applyFilter(testPlanIssues, {});
      expect(result.map((i) => i.id)).toEqual(["T-1", "T-2", "T-3", "T-4"]);
    });

    it("does not mutate the input array", () => {
      const copy = [...testPlanIssues];
      applyFilter(testPlanIssues, { statuses: ["open"] });
      expect(testPlanIssues).toEqual(copy);
    });
  });

  // ---------------------------------------------------------------------------
  // Date created filter (createdAfter / createdBefore)
  // ---------------------------------------------------------------------------

  describe("date created filter", () => {
    const datedIssues: PlanIssue[] = [
      {
        id: "D-1",
        title: "Old issue",
        status: "open",
        priority: 2,
        issue_type: "task",
        blocked_by: [],
        blocks: [],
        created_at: "2025-01-15T10:00:00Z",
        updated_at: "2025-01-20T10:00:00Z",
      },
      {
        id: "D-2",
        title: "Mid issue",
        status: "open",
        priority: 2,
        issue_type: "task",
        blocked_by: [],
        blocks: [],
        created_at: "2025-06-15T10:00:00Z",
        updated_at: "2025-06-20T10:00:00Z",
      },
      {
        id: "D-3",
        title: "Recent issue",
        status: "open",
        priority: 2,
        issue_type: "task",
        blocked_by: [],
        blocks: [],
        created_at: "2026-02-20T10:00:00Z",
        updated_at: "2026-02-22T10:00:00Z",
      },
      {
        id: "D-4",
        title: "No date issue",
        status: "open",
        priority: 2,
        issue_type: "task",
        blocked_by: [],
        blocks: [],
      },
    ];

    it("createdAfter filters out issues before the date", () => {
      const result = applyFilter(datedIssues, { createdAfter: "2025-06-01" });
      expect(result.map((i) => i.id)).toEqual(["D-2", "D-3"]);
    });

    it("createdBefore filters out issues after the date", () => {
      const result = applyFilter(datedIssues, { createdBefore: "2025-06-30" });
      expect(result.map((i) => i.id)).toEqual(["D-1", "D-2"]);
    });

    it("createdAfter + createdBefore combines into a range", () => {
      const result = applyFilter(datedIssues, {
        createdAfter: "2025-06-01",
        createdBefore: "2025-12-31",
      });
      expect(result.map((i) => i.id)).toEqual(["D-2"]);
    });

    it("excludes issues with no created_at when date filter is active", () => {
      const result = applyFilter(datedIssues, { createdAfter: "2020-01-01" });
      // D-4 has no created_at, so it's excluded
      expect(result.map((i) => i.id)).toEqual(["D-1", "D-2", "D-3"]);
    });
  });
});

// =============================================================================
// BUILT_IN_VIEWS
// =============================================================================

describe("BUILT_IN_VIEWS", () => {
  it("has 9 entries", () => {
    expect(BUILT_IN_VIEWS).toHaveLength(9);
  });

  it("has correct ids", () => {
    const ids = BUILT_IN_VIEWS.map((v) => v.id);
    expect(ids).toEqual([
      "all",
      "actionable",
      "in-progress",
      "blocked",
      "high-priority",
      "bugs",
      "recent",
      "stale",
      "submissions",
    ]);
  });

  it("all views have isBuiltIn = true", () => {
    for (const view of BUILT_IN_VIEWS) {
      expect(view.isBuiltIn).toBe(true);
    }
  });

  it("all views have a name and filter", () => {
    for (const view of BUILT_IN_VIEWS) {
      expect(view.name).toBeDefined();
      expect(typeof view.name).toBe("string");
      expect(view.name.length).toBeGreaterThan(0);
      expect(view.filter).toBeDefined();
    }
  });

  it("the 'all' view filters non-closed statuses", () => {
    const allView = BUILT_IN_VIEWS.find((v) => v.id === "all");
    expect(allView!.filter.statuses).toEqual([
      "open",
      "in_progress",
      "blocked",
      "deferred",
      "pinned",
    ]);
  });

  it("the 'actionable' view filters open + no blockers", () => {
    const view = BUILT_IN_VIEWS.find((v) => v.id === "actionable");
    expect(view!.filter.statuses).toEqual(["open"]);
    expect(view!.filter.hasBlockers).toBe(false);
  });

  it("the 'high-priority' view filters P0 and P1", () => {
    const view = BUILT_IN_VIEWS.find((v) => v.id === "high-priority");
    expect(view!.filter.priorities).toEqual([0, 1]);
  });

  it("the 'bugs' view filters bug type", () => {
    const view = BUILT_IN_VIEWS.find((v) => v.id === "bugs");
    expect(view!.filter.types).toEqual(["bug"]);
  });

  describe("built-in view filters work with applyFilter", () => {
    it("'actionable' returns open issues without blockers", () => {
      const view = BUILT_IN_VIEWS.find((v) => v.id === "actionable")!;
      const result = applyFilter(testPlanIssues, view.filter);
      // T-1 is open with no blockers
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("T-1");
    });

    it("'in-progress' returns in_progress issues", () => {
      const view = BUILT_IN_VIEWS.find((v) => v.id === "in-progress")!;
      const result = applyFilter(testPlanIssues, view.filter);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("T-2");
    });

    it("'blocked' returns blocked issues with blockers", () => {
      const view = BUILT_IN_VIEWS.find((v) => v.id === "blocked")!;
      const result = applyFilter(testPlanIssues, view.filter);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("T-3");
    });

    it("'bugs' returns open/in_progress/blocked bugs", () => {
      const view = BUILT_IN_VIEWS.find((v) => v.id === "bugs")!;
      const result = applyFilter(testPlanIssues, view.filter);
      // T-2 is in_progress bug
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("T-2");
    });

    it("'submissions' returns issues with submission: labels", () => {
      const view = BUILT_IN_VIEWS.find((v) => v.id === "submissions")!;
      const submissionIssues: PlanIssue[] = [
        ...testPlanIssues,
        {
          id: "SUB-1",
          title: "App submission",
          status: "open",
          priority: 1,
          issue_type: "task",
          blocked_by: [],
          blocks: [],
          labels: ["submission:ready"],
        },
      ];
      const result = applyFilter(submissionIssues, view.filter);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("SUB-1");
    });

    it("'high-priority' returns P0/P1 non-closed issues", () => {
      const view = BUILT_IN_VIEWS.find((v) => v.id === "high-priority")!;
      const result = applyFilter(testPlanIssues, view.filter);
      // T-1 (open, P1), T-2 (in_progress, P0) — T-4 is closed so excluded
      expect(result).toHaveLength(2);
      expect(result.map((i) => i.id).sort()).toEqual(["T-1", "T-2"]);
    });
  });
});
