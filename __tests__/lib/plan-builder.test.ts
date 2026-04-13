// =============================================================================
// Tests for src/lib/plan-builder.ts — plan conversion and stubs
// =============================================================================

import {
  issuesToPlan,
  emptyPriority,
  emptyInsights,
} from "@/lib/plan-builder";
import {
  TEST_ISSUES,
  TEST_DEPENDENCIES,
  TEST_LABELS,
} from "../fixtures/create-test-db";
import type { BeadsIssue } from "@/lib/types";

// =============================================================================
// issuesToPlan
// =============================================================================

describe("issuesToPlan", () => {
  let testIssues: BeadsIssue[];

  beforeAll(() => {
    // Build BeadsIssue[] from the test data constants
    testIssues = TEST_ISSUES.map((issue) => {
      const deps = TEST_DEPENDENCIES.filter(([id]) => id === issue.id).map(
        ([issueId, dependsOn, type]) => ({
          issue_id: issueId,
          depends_on_id: dependsOn,
          type: type as "blocks",
          created_at: "2026-01-01T00:00:00Z",
          created_by: "test",
        }),
      );
      const labels = TEST_LABELS.filter(([id]) => id === issue.id).map(
        ([, label]) => label as string,
      );
      return {
        ...issue,
        status: issue.status as BeadsIssue["status"],
        priority: issue.priority as BeadsIssue["priority"],
        issue_type: issue.issue_type as BeadsIssue["issue_type"],
        labels: labels.length > 0 ? labels : undefined,
        dependencies: deps.length > 0 ? deps : undefined,
      };
    });
  });

  describe("summary", () => {
    it("has correct open_count", () => {
      const plan = issuesToPlan(testIssues, "/test/path");
      // open: TEST-001, TEST-004, TEST-006, TEST-007 = 4
      expect(plan.summary.open_count).toBe(4);
    });

    it("has correct in_progress_count", () => {
      const plan = issuesToPlan(testIssues, "/test/path");
      // in_progress: TEST-002 = 1
      expect(plan.summary.in_progress_count).toBe(1);
    });

    it("has correct blocked_count", () => {
      const plan = issuesToPlan(testIssues, "/test/path");
      // blocked: TEST-003 = 1
      expect(plan.summary.blocked_count).toBe(1);
    });

    it("has correct closed_count", () => {
      const plan = issuesToPlan(testIssues, "/test/path");
      // closed: TEST-005 = 1
      expect(plan.summary.closed_count).toBe(1);
    });
  });

  describe("all_issues", () => {
    it("has correct length (8 issues)", () => {
      const plan = issuesToPlan(testIssues, "/test/path");
      expect(plan.all_issues).toHaveLength(8);
    });

    it("includes all issue ids", () => {
      const plan = issuesToPlan(testIssues, "/test/path");
      const ids = plan.all_issues.map((i) => i.id).sort();
      expect(ids).toEqual(TEST_ISSUES.map((i) => i.id).sort());
    });
  });

  describe("blocked_by arrays", () => {
    it("TEST-003 is blocked_by TEST-001", () => {
      const plan = issuesToPlan(testIssues, "/test/path");
      const issue3 = plan.all_issues.find((i) => i.id === "TEST-003");
      expect(issue3!.blocked_by).toEqual(["TEST-001"]);
    });

    it("TEST-004 is blocked_by TEST-001", () => {
      const plan = issuesToPlan(testIssues, "/test/path");
      const issue4 = plan.all_issues.find((i) => i.id === "TEST-004");
      expect(issue4!.blocked_by).toEqual(["TEST-001"]);
    });

    it("TEST-007 is blocked_by TEST-001 and TEST-006", () => {
      const plan = issuesToPlan(testIssues, "/test/path");
      const issue7 = plan.all_issues.find((i) => i.id === "TEST-007");
      expect(issue7!.blocked_by.sort()).toEqual(["TEST-001", "TEST-006"]);
    });

    it("TEST-002 is blocked_by TEST-006", () => {
      const plan = issuesToPlan(testIssues, "/test/path");
      const issue2 = plan.all_issues.find((i) => i.id === "TEST-002");
      expect(issue2!.blocked_by).toEqual(["TEST-006"]);
    });

    it("TEST-001 has no blockers", () => {
      const plan = issuesToPlan(testIssues, "/test/path");
      const issue1 = plan.all_issues.find((i) => i.id === "TEST-001");
      expect(issue1!.blocked_by).toEqual([]);
    });
  });

  describe("blocks arrays (reverse of blocked_by)", () => {
    it("TEST-001 blocks TEST-003, TEST-004, TEST-007", () => {
      const plan = issuesToPlan(testIssues, "/test/path");
      const issue1 = plan.all_issues.find((i) => i.id === "TEST-001");
      expect(issue1!.blocks.sort()).toEqual(["TEST-003", "TEST-004", "TEST-007"]);
    });

    it("TEST-006 blocks TEST-002, TEST-007", () => {
      const plan = issuesToPlan(testIssues, "/test/path");
      const issue6 = plan.all_issues.find((i) => i.id === "TEST-006");
      expect(issue6!.blocks.sort()).toEqual(["TEST-002", "TEST-007"]);
    });

    it("TEST-005 blocks nothing", () => {
      const plan = issuesToPlan(testIssues, "/test/path");
      const issue5 = plan.all_issues.find((i) => i.id === "TEST-005");
      expect(issue5!.blocks).toEqual([]);
    });
  });

  describe("tracks", () => {
    it("tracks contain only non-closed, non-deferred issues", () => {
      const plan = issuesToPlan(testIssues, "/test/path");
      const trackIssueIds = plan.tracks.flatMap((t) =>
        t.issues.map((i) => i.id),
      );
      // TEST-005 is closed, TEST-008 is deferred — neither should be in tracks
      expect(trackIssueIds).not.toContain("TEST-005");
      expect(trackIssueIds).not.toContain("TEST-008");
    });

    it("tracks contain all active issues", () => {
      const plan = issuesToPlan(testIssues, "/test/path");
      const trackIssueIds = plan.tracks
        .flatMap((t) => t.issues.map((i) => i.id))
        .sort();
      // Active: TEST-001, TEST-002, TEST-003, TEST-004, TEST-006, TEST-007
      expect(trackIssueIds).toEqual([
        "TEST-001",
        "TEST-002",
        "TEST-003",
        "TEST-004",
        "TEST-006",
        "TEST-007",
      ]);
    });

    it("has a single track labeled 'All Issues'", () => {
      const plan = issuesToPlan(testIssues, "/test/path");
      expect(plan.tracks).toHaveLength(1);
      expect(plan.tracks[0].label).toBe("All Issues");
      expect(plan.tracks[0].track_number).toBe(1);
    });
  });

  describe("metadata", () => {
    it("includes project_path", () => {
      const plan = issuesToPlan(testIssues, "/my/project");
      expect(plan.project_path).toBe("/my/project");
    });

    it("includes a timestamp", () => {
      const plan = issuesToPlan(testIssues, "/test/path");
      expect(plan.timestamp).toBeDefined();
      // Should be a valid ISO string
      expect(new Date(plan.timestamp).toISOString()).toBe(plan.timestamp);
    });
  });

  describe("edge case: empty issues", () => {
    it("returns empty tracks and zero counts", () => {
      const plan = issuesToPlan([], "/test/path");
      expect(plan.all_issues).toHaveLength(0);
      expect(plan.tracks).toHaveLength(0);
      expect(plan.summary.open_count).toBe(0);
      expect(plan.summary.in_progress_count).toBe(0);
      expect(plan.summary.blocked_count).toBe(0);
      expect(plan.summary.closed_count).toBe(0);
    });
  });
});

// =============================================================================
// emptyPriority
// =============================================================================

describe("emptyPriority", () => {
  it("returns correct structure with project path", () => {
    const result = emptyPriority("/my/project");
    expect(result.project_path).toBe("/my/project");
    expect(result.recommendations).toEqual([]);
    expect(result.aligned_count).toBe(0);
    expect(result.misaligned_count).toBe(0);
  });

  it("includes a valid timestamp", () => {
    const result = emptyPriority("/test");
    expect(result.timestamp).toBeDefined();
    expect(new Date(result.timestamp).toISOString()).toBe(result.timestamp);
  });
});

// =============================================================================
// emptyInsights
// =============================================================================

describe("emptyInsights", () => {
  it("returns correct structure with project path and total", () => {
    const result = emptyInsights("/my/project", 42);
    expect(result.project_path).toBe("/my/project");
    expect(result.total_issues).toBe(42);
    expect(result.graph_density).toBe(0);
    expect(result.bottlenecks).toEqual([]);
    expect(result.keystones).toEqual([]);
    expect(result.influencers).toEqual([]);
    expect(result.hubs).toEqual([]);
    expect(result.authorities).toEqual([]);
    expect(result.cycles).toEqual([]);
  });

  it("defaults totalIssues to 0", () => {
    const result = emptyInsights("/test");
    expect(result.total_issues).toBe(0);
  });
});
