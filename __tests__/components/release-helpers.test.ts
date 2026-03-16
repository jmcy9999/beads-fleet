// =============================================================================
// Tests for src/components/releases/types.ts — Release helpers & grouping
// =============================================================================

import {
  extractReleaseVersion,
  extractReleaseStatus,
  getReleaseLabel,
  getStatusColor,
  getStatusLabel,
  sortIssuesForRelease,
  buildReleaseGroups,
} from "@/components/releases/types";
import type { PlanIssue } from "@/lib/types";

// ---------------------------------------------------------------------------
// Fixtures
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

const issueV21Open = makeIssue({
  id: "PC-1",
  title: "Fix onboarding",
  status: "open",
  priority: 1,
  labels: ["release:2.1"],
});

const issueV21InProgress = makeIssue({
  id: "PC-2",
  title: "HIG audit",
  status: "in_progress",
  priority: 0,
  labels: ["release:2.1", "checkpoint: human-verify"],
});

const issueV21Closed = makeIssue({
  id: "PC-3",
  title: "Rename tabs",
  status: "closed",
  priority: 1,
  labels: ["release:2.1"],
});

const issueV30 = makeIssue({
  id: "PC-4",
  title: "AI insights",
  status: "open",
  priority: 3,
  labels: ["release:3.0"],
});

const issueUnassigned = makeIssue({
  id: "PC-5",
  title: "Performance fix",
  status: "open",
  priority: 2,
});

const issueNoLabels = makeIssue({
  id: "PC-6",
  title: "Bug fix",
  status: "blocked",
  priority: 0,
});

const issueWithReleaseStatus = makeIssue({
  id: "PC-7",
  title: "Release tracking",
  status: "open",
  priority: 2,
  labels: ["release:2.1", "release-status:in-progress"],
});

// ---------------------------------------------------------------------------
// extractReleaseVersion
// ---------------------------------------------------------------------------

describe("extractReleaseVersion", () => {
  it("strips release: prefix", () => {
    expect(extractReleaseVersion("release:2.1")).toBe("2.1");
  });

  it("handles multi-digit versions", () => {
    expect(extractReleaseVersion("release:10.23.4")).toBe("10.23.4");
  });
});

// ---------------------------------------------------------------------------
// getReleaseLabel
// ---------------------------------------------------------------------------

describe("getReleaseLabel", () => {
  it("returns release label when present", () => {
    expect(getReleaseLabel(issueV21Open)).toBe("release:2.1");
  });

  it("returns undefined when no release label", () => {
    expect(getReleaseLabel(issueUnassigned)).toBeUndefined();
  });

  it("returns undefined when labels is undefined", () => {
    expect(getReleaseLabel(issueNoLabels)).toBeUndefined();
  });

  it("ignores release-status: labels", () => {
    const issue = makeIssue({
      id: "X-1",
      labels: ["release-status:live"],
    });
    expect(getReleaseLabel(issue)).toBeUndefined();
  });

  it("returns release: even when release-status: is also present", () => {
    expect(getReleaseLabel(issueWithReleaseStatus)).toBe("release:2.1");
  });
});

// ---------------------------------------------------------------------------
// extractReleaseStatus
// ---------------------------------------------------------------------------

describe("extractReleaseStatus", () => {
  it("returns null when no release-status label", () => {
    expect(extractReleaseStatus([issueV21Open, issueV21Closed])).toBeNull();
  });

  it("extracts release-status from issue labels", () => {
    expect(extractReleaseStatus([issueWithReleaseStatus])).toBe("in-progress");
  });
});

// ---------------------------------------------------------------------------
// getStatusColor / getStatusLabel
// ---------------------------------------------------------------------------

describe("getStatusColor", () => {
  it("returns green classes for live", () => {
    expect(getStatusColor("live")).toContain("green");
  });

  it("returns blue classes for in-progress", () => {
    expect(getStatusColor("in-progress")).toContain("blue");
  });

  it("returns gray classes for null", () => {
    expect(getStatusColor(null)).toContain("gray");
  });
});

describe("getStatusLabel", () => {
  it("returns 'No status' for null", () => {
    expect(getStatusLabel(null)).toBe("No status");
  });

  it("capitalizes and de-hyphenates", () => {
    expect(getStatusLabel("in-progress")).toBe("In progress");
  });

  it("capitalizes simple status", () => {
    expect(getStatusLabel("live")).toBe("Live");
  });
});

// ---------------------------------------------------------------------------
// sortIssuesForRelease
// ---------------------------------------------------------------------------

describe("sortIssuesForRelease", () => {
  it("sorts in_progress before open before closed", () => {
    const sorted = sortIssuesForRelease([
      issueV21Closed,
      issueV21Open,
      issueV21InProgress,
    ]);
    expect(sorted.map((i) => i.id)).toEqual(["PC-2", "PC-1", "PC-3"]);
  });

  it("sorts by priority within same status", () => {
    const a = makeIssue({ id: "A", status: "open", priority: 3 });
    const b = makeIssue({ id: "B", status: "open", priority: 1 });
    const c = makeIssue({ id: "C", status: "open", priority: 2 });
    const sorted = sortIssuesForRelease([a, b, c]);
    expect(sorted.map((i) => i.id)).toEqual(["B", "C", "A"]);
  });

  it("puts blocked before open", () => {
    const sorted = sortIssuesForRelease([issueUnassigned, issueNoLabels]);
    expect(sorted[0].id).toBe("PC-6"); // blocked
    expect(sorted[1].id).toBe("PC-5"); // open
  });

  it("does not mutate input array", () => {
    const input = [issueV21Closed, issueV21InProgress];
    const inputCopy = [...input];
    sortIssuesForRelease(input);
    expect(input).toEqual(inputCopy);
  });
});

// ---------------------------------------------------------------------------
// buildReleaseGroups
// ---------------------------------------------------------------------------

describe("buildReleaseGroups", () => {
  const allIssues = [
    issueV21Open,
    issueV21InProgress,
    issueV21Closed,
    issueV30,
    issueUnassigned,
    issueNoLabels,
  ];

  it("groups issues by release label", () => {
    const groups = buildReleaseGroups(allIssues);
    const versions = groups.map((g) => g.version);
    expect(versions).toContain("2.1");
    expect(versions).toContain("3.0");
    expect(versions).toContain("Unassigned");
  });

  it("sorts releases ascending (lowest version first)", () => {
    const groups = buildReleaseGroups(allIssues);
    const versionedGroups = groups.filter((g) => g.label);
    expect(versionedGroups[0].version).toBe("2.1");
    expect(versionedGroups[1].version).toBe("3.0");
  });

  it("puts Unassigned group last", () => {
    const groups = buildReleaseGroups(allIssues);
    expect(groups[groups.length - 1].version).toBe("Unassigned");
  });

  it("counts open and closed correctly for v2.1", () => {
    const groups = buildReleaseGroups(allIssues);
    const v21 = groups.find((g) => g.version === "2.1")!;
    expect(v21.open).toBe(2);    // PC-1 open + PC-2 in_progress
    expect(v21.closed).toBe(1);  // PC-3
    expect(v21.total).toBe(3);
  });

  it("counts correctly for v3.0", () => {
    const groups = buildReleaseGroups(allIssues);
    const v30 = groups.find((g) => g.version === "3.0")!;
    expect(v30.open).toBe(1);
    expect(v30.closed).toBe(0);
    expect(v30.total).toBe(1);
  });

  it("collects unassigned issues (no release label)", () => {
    const groups = buildReleaseGroups(allIssues);
    const unassigned = groups.find((g) => g.version === "Unassigned")!;
    expect(unassigned.total).toBe(2);
    expect(unassigned.issues.map((i) => i.id).sort()).toEqual(["PC-5", "PC-6"]);
  });

  it("sets label to empty string for Unassigned group", () => {
    const groups = buildReleaseGroups(allIssues);
    const unassigned = groups.find((g) => g.version === "Unassigned")!;
    expect(unassigned.label).toBe("");
  });

  it("extracts release-status when present", () => {
    const groups = buildReleaseGroups([issueWithReleaseStatus]);
    const v21 = groups.find((g) => g.version === "2.1")!;
    expect(v21.status).toBe("in-progress");
  });

  it("returns empty array when no issues", () => {
    expect(buildReleaseGroups([])).toEqual([]);
  });

  it("returns only Unassigned when no release labels", () => {
    const groups = buildReleaseGroups([issueUnassigned, issueNoLabels]);
    expect(groups.length).toBe(1);
    expect(groups[0].version).toBe("Unassigned");
  });

  it("handles issues with only release labels (no unassigned)", () => {
    const groups = buildReleaseGroups([issueV21Open, issueV30]);
    expect(groups.length).toBe(2);
    expect(groups.every((g) => g.version !== "Unassigned")).toBe(true);
  });
});
