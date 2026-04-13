// =============================================================================
// Tests for src/lib/bv-client.ts — getPlan() SQLite supplementation logic
// =============================================================================
//
// Validates that getPlan() supplements the small bv --robot-plan triage set
// with the full issue list from SQLite, so the dashboard shows all issues
// (not just the 4-5 triage picks).
// =============================================================================

import type { BeadsIssue, IssueStatus, IssueType, Priority } from "@/lib/types";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

// Mock child_process.execFile (used via promisify in bv-client.ts).
//
// The real Node.js execFile has a custom promisify implementation that
// returns { stdout, stderr } instead of just the first callback arg.
// Our mock must replicate this behavior since bv-client.ts destructures
// `const { stdout } = await execFile(...)`.
import { promisify } from "util";

let execFileBehavior: (cmd: string, args: string[], opts: Record<string, unknown>) => { stdout: string; error?: NodeJS.ErrnoException } =
  () => ({ stdout: "{}" });

jest.mock("child_process", () => {
  // Build a callback-style function with a custom promisify that returns { stdout, stderr }
  const mockFn = (
    cmd: string,
    args: string[],
    opts: Record<string, unknown>,
    callback: (err: Error | null, stdout: string, stderr: string) => void,
  ) => {
    try {
      const result = execFileBehavior(cmd, args, opts);
      if (result.error) {
        callback(result.error, "", "");
      } else {
        callback(null, result.stdout, "");
      }
    } catch (e) {
      callback(e as Error, "", "");
    }
    return undefined;
  };

  // Attach the custom promisify symbol so `promisify(execFile)` returns { stdout, stderr }
  (mockFn as any)[Symbol.for("nodejs.util.promisify.custom")] = async (
    cmd: string,
    args: string[],
    opts: Record<string, unknown>,
  ) => {
    const result = execFileBehavior(cmd, args, opts);
    if (result.error) {
      throw result.error;
    }
    return { stdout: result.stdout, stderr: "" };
  };

  return {
    execFile: mockFn,
    execFileSync: jest.fn(() => {
      throw new Error("not found");
    }),
  };
});

// Mock fs.existsSync for getBvPath() local binary check
jest.mock("fs", () => {
  const actual = jest.requireActual("fs");
  return {
    ...actual,
    existsSync: jest.fn(() => false),
  };
});

// Mock the cache to avoid stale data between tests
jest.mock("@/lib/cache", () => ({
  cache: {
    get: jest.fn(() => null),
    set: jest.fn(),
    invalidate: jest.fn(),
    invalidateAll: jest.fn(),
  },
}));

// Mock graph-metrics to avoid pulling in its dependencies
jest.mock("@/lib/graph-metrics", () => ({
  computeInsightsFromIssues: jest.fn(() => ({
    timestamp: new Date().toISOString(),
    project_path: "",
    total_issues: 0,
    graph_density: 0,
    bottlenecks: [],
    keystones: [],
    influencers: [],
    hubs: [],
    authorities: [],
    cycles: [],
  })),
}));

// Mock readIssuesFromDolt from dolt-reader
const mockReadIssuesFromDolt = jest.fn();
jest.mock("@/lib/dolt-reader", () => ({
  readIssuesFromDolt: (...args: unknown[]) => mockReadIssuesFromDolt(...args),
}));

// Mock issuesToPlan from plan-builder
const mockIssuesToPlan = jest.fn();
jest.mock("@/lib/plan-builder", () => ({
  issuesToPlan: (...args: unknown[]) => mockIssuesToPlan(...args),
  emptyPriority: jest.fn((projectPath: string) => ({
    timestamp: new Date().toISOString(),
    project_path: projectPath,
    recommendations: [],
    aligned_count: 0,
    misaligned_count: 0,
  })),
}));

// Import AFTER mocks are set up
import { getPlan } from "@/lib/bv-client";

// ---------------------------------------------------------------------------
// Test data helpers
// ---------------------------------------------------------------------------

const TEST_PROJECT_PATH = "/tmp/test-bv-client-project";

/**
 * Build a minimal BeadsIssue for test purposes.
 */
function makeBeadsIssue(
  id: string,
  status: IssueStatus = "open",
  priority: Priority = 2,
  issueType: IssueType = "task",
): BeadsIssue {
  return {
    id,
    title: `Issue ${id}`,
    status,
    priority,
    issue_type: issueType,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-10T00:00:00Z",
    blocked_by: [],
    blocks: [],
  } as BeadsIssue;
}

/**
 * Build a bv --robot-plan JSON envelope with a small triage set.
 * This simulates what the real bv CLI returns.
 */
function makeBvPlanEnvelope(items: { id: string; title: string; priority: number; status: string }[]) {
  return {
    generated_at: "2026-01-15T00:00:00Z",
    data_hash: "abc123",
    status: "ok",
    plan: {
      tracks: [
        {
          track_id: "track-triage",
          reason: "Highest impact triage items",
          items: items.map((item) => ({
            id: item.id,
            title: item.title,
            priority: item.priority,
            status: item.status,
            unblocks: null,
          })),
        },
      ],
      total_actionable: items.length,
      total_blocked: 0,
      summary: {
        highest_impact: items[0]?.id ?? null,
        impact_reason: "Unblocks the most downstream work",
        unblocks_count: 3,
      },
    },
  };
}

/**
 * Generate N BeadsIssues with a mix of statuses.
 * Returns a predictable distribution: ~50% open, ~20% in_progress, ~15% closed, ~10% blocked, ~5% deferred
 */
function generateIssueSet(count: number): BeadsIssue[] {
  const statuses: IssueStatus[] = ["open", "in_progress", "closed", "blocked", "deferred"];
  const weights = [0.50, 0.20, 0.15, 0.10, 0.05];

  const issues: BeadsIssue[] = [];
  for (let i = 1; i <= count; i++) {
    // Deterministic status assignment based on index
    let cumulative = 0;
    let statusIdx = 0;
    const fraction = (i - 1) / count;
    for (let w = 0; w < weights.length; w++) {
      cumulative += weights[w];
      if (fraction < cumulative) {
        statusIdx = w;
        break;
      }
    }
    const status = statuses[statusIdx];
    const priority = ((i % 5) as Priority);
    issues.push(makeBeadsIssue(`FULL-${String(i).padStart(3, "0")}`, status, priority));
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getPlan() — SQLite supplementation", () => {
  // The bv triage set: only 4 items
  const BV_TRIAGE_ITEMS = [
    { id: "FULL-001", title: "Issue FULL-001", priority: 1, status: "open" },
    { id: "FULL-010", title: "Issue FULL-010", priority: 0, status: "open" },
    { id: "FULL-020", title: "Issue FULL-020", priority: 1, status: "in_progress" },
    { id: "FULL-030", title: "Issue FULL-030", priority: 2, status: "blocked" },
  ];

  const BV_ENVELOPE = makeBvPlanEnvelope(BV_TRIAGE_ITEMS);

  // The full SQLite issue set: 50 issues with mixed statuses
  const FULL_ISSUES = generateIssueSet(50);

  beforeEach(() => {
    jest.clearAllMocks();

    // Set up BV_PATH so getBvPath() finds a known path (avoids execFileSync call)
    process.env.BV_PATH = "/usr/local/bin/bv";
    process.env.BEADS_PROJECT_PATH = TEST_PROJECT_PATH;

    // Default: execFile returns the small bv plan envelope
    execFileBehavior = () => ({ stdout: JSON.stringify(BV_ENVELOPE) });

    // Default: readIssuesFromDolt returns the full 50-issue set
    mockReadIssuesFromDolt.mockResolvedValue(FULL_ISSUES);

    // Default: issuesToPlan converts full issues into a plan
    mockIssuesToPlan.mockImplementation((issues: BeadsIssue[], projectPath: string) => {
      const statusCounts: Record<string, number> = { open: 0, in_progress: 0, blocked: 0, closed: 0 };
      for (const issue of issues) {
        if (issue.status in statusCounts) {
          statusCounts[issue.status]++;
        }
      }
      return {
        timestamp: "2026-01-15T00:00:00Z",
        project_path: projectPath,
        summary: {
          open_count: statusCounts.open,
          in_progress_count: statusCounts.in_progress,
          blocked_count: statusCounts.blocked,
          closed_count: statusCounts.closed,
        },
        tracks: [{ track_number: 1, label: "All Issues", issues: issues.map((i: BeadsIssue) => ({
          id: i.id,
          title: i.title,
          status: i.status,
          priority: i.priority,
          issue_type: i.issue_type,
          blocked_by: [],
          blocks: [],
        })) }],
        all_issues: issues.map((i: BeadsIssue) => ({
          id: i.id,
          title: i.title,
          status: i.status,
          priority: i.priority,
          issue_type: i.issue_type,
          blocked_by: [],
          blocks: [],
        })),
      };
    });
  });

  afterEach(() => {
    delete process.env.BV_PATH;
    delete process.env.BEADS_PROJECT_PATH;
  });

  // -------------------------------------------------------------------------
  // Test 1: bv returns small triage set, SQLite has full list
  // -------------------------------------------------------------------------

  it("all_issues contains ALL issues from SQLite, not just the bv triage set", async () => {
    const plan = await getPlan(TEST_PROJECT_PATH);

    // The bv triage only has 4 items, but all_issues should have all 50
    expect(plan.all_issues.length).toBe(50);
    expect(plan.all_issues.length).toBeGreaterThan(BV_TRIAGE_ITEMS.length);
  });

  it("summary counts reflect the full issue set, not the triage subset", async () => {
    const plan = await getPlan(TEST_PROJECT_PATH);

    // Count expected statuses from the full 50-issue set
    const expectedCounts: Record<string, number> = { open: 0, in_progress: 0, blocked: 0, closed: 0 };
    for (const issue of FULL_ISSUES) {
      if (issue.status in expectedCounts) {
        expectedCounts[issue.status]++;
      }
    }

    expect(plan.summary.open_count).toBe(expectedCounts.open);
    expect(plan.summary.in_progress_count).toBe(expectedCounts.in_progress);
    expect(plan.summary.blocked_count).toBe(expectedCounts.blocked);
    expect(plan.summary.closed_count).toBe(expectedCounts.closed);

    // Total should be much more than 4
    const totalFromSummary =
      plan.summary.open_count +
      plan.summary.in_progress_count +
      plan.summary.blocked_count +
      plan.summary.closed_count;
    expect(totalFromSummary).toBeGreaterThan(4);
  });

  it("readIssuesFromDolt is called with the project path", async () => {
    await getPlan(TEST_PROJECT_PATH);

    expect(mockReadIssuesFromDolt).toHaveBeenCalledWith(TEST_PROJECT_PATH);
  });

  it("issuesToPlan is called with the full issue set when SQLite has more issues", async () => {
    await getPlan(TEST_PROJECT_PATH);

    expect(mockIssuesToPlan).toHaveBeenCalledWith(FULL_ISSUES, TEST_PROJECT_PATH);
  });

  // -------------------------------------------------------------------------
  // Test 2: all_issues includes closed issues
  // -------------------------------------------------------------------------

  it("all_issues includes closed issues from the full set", async () => {
    const plan = await getPlan(TEST_PROJECT_PATH);

    const closedIssues = plan.all_issues.filter((i) => i.status === "closed");
    expect(closedIssues.length).toBeGreaterThan(0);

    // Verify the count matches what we generated
    const expectedClosedCount = FULL_ISSUES.filter((i) => i.status === "closed").length;
    expect(closedIssues.length).toBe(expectedClosedCount);
  });

  it("all_issues includes issues of every status present in SQLite", async () => {
    const plan = await getPlan(TEST_PROJECT_PATH);

    const statusesInResult = new Set(plan.all_issues.map((i) => i.status));
    const statusesInSource = new Set(FULL_ISSUES.map((i) => i.status));

    // Every status from the source should appear in the result
    for (const status of statusesInSource) {
      // deferred issues are in all_issues even though not in tracks
      if (status === "deferred") {
        // deferred may or may not be in PlanIssue depending on issuesToPlan
        // Our mock includes them, so check
        const deferredInResult = plan.all_issues.filter((i) => i.status === "deferred");
        const deferredInSource = FULL_ISSUES.filter((i) => i.status === "deferred");
        expect(deferredInResult.length).toBe(deferredInSource.length);
      } else {
        expect(statusesInResult.has(status)).toBe(true);
      }
    }
  });

  // -------------------------------------------------------------------------
  // Test 3: bv highest_impact is preserved
  // -------------------------------------------------------------------------

  it("preserves bv highest_impact in the summary when bv provides one", async () => {
    const plan = await getPlan(TEST_PROJECT_PATH);

    // The bv envelope's summary.highest_impact was "FULL-001"
    expect(plan.summary.highest_impact).toBeDefined();
    expect(plan.summary.highest_impact!.issue_id).toBe("FULL-001");
  });

  it("preserves bv unblocks_count from the triage summary", async () => {
    const plan = await getPlan(TEST_PROJECT_PATH);

    expect(plan.summary.highest_impact).toBeDefined();
    expect(plan.summary.highest_impact!.unblocks_count).toBe(3);
  });

  it("uses SQLite highest_impact as fallback when bv does not provide one", async () => {
    // Create a bv envelope with no highest_impact
    const envelopeNoImpact = {
      generated_at: "2026-01-15T00:00:00Z",
      plan: {
        tracks: [],
        total_actionable: 0,
        total_blocked: 0,
        summary: {
          highest_impact: null,
          impact_reason: null,
          unblocks_count: 0,
        },
      },
    };

    execFileBehavior = () => ({ stdout: JSON.stringify(envelopeNoImpact) });

    // Make issuesToPlan return a plan with its own highest_impact
    mockIssuesToPlan.mockImplementation((issues: BeadsIssue[], projectPath: string) => ({
      timestamp: "2026-01-15T00:00:00Z",
      project_path: projectPath,
      summary: {
        open_count: issues.length,
        in_progress_count: 0,
        blocked_count: 0,
        closed_count: 0,
        highest_impact: {
          issue_id: "FULL-005",
          title: "Issue FULL-005",
          impact_score: 42,
          unblocks_count: 7,
        },
      },
      tracks: [],
      all_issues: issues.map((i: BeadsIssue) => ({
        id: i.id,
        title: i.title,
        status: i.status,
        priority: i.priority,
        issue_type: i.issue_type,
        blocked_by: [],
        blocks: [],
      })),
    }));

    const plan = await getPlan(TEST_PROJECT_PATH);

    // When bv has no highest_impact (undefined), the SQLite fallback should be used
    // The code does: data.summary.highest_impact ?? fullPlan.summary.highest_impact
    // Since normalizePlan sets highestImpact to undefined when null, the ?? kicks in
    expect(plan.summary.highest_impact).toBeDefined();
    expect(plan.summary.highest_impact!.issue_id).toBe("FULL-005");
  });

  // -------------------------------------------------------------------------
  // Edge case: SQLite has fewer or equal issues (no supplementation)
  // -------------------------------------------------------------------------

  it("does not replace all_issues when SQLite has fewer issues than bv", async () => {
    // Return only 2 issues from SQLite (fewer than the 4 bv triage items)
    const smallIssueSet = [
      makeBeadsIssue("SMALL-001", "open"),
      makeBeadsIssue("SMALL-002", "closed"),
    ];
    mockReadIssuesFromDolt.mockResolvedValue(smallIssueSet);

    const plan = await getPlan(TEST_PROJECT_PATH);

    // The bv triage set has 4 items; SQLite only has 2
    // So all_issues should remain the bv set (4 items)
    expect(plan.all_issues.length).toBe(4);
    // issuesToPlan should NOT have been called since fullIssues.length <= data.all_issues.length
    expect(mockIssuesToPlan).not.toHaveBeenCalled();
  });

  it("preserves bv tracks even when all_issues is replaced with SQLite data", async () => {
    const plan = await getPlan(TEST_PROJECT_PATH);

    // The bv triage track should still be present
    expect(plan.tracks.length).toBeGreaterThanOrEqual(1);
    expect(plan.tracks[0].label).toBe("Highest impact triage items");

    // Track issues should be the original bv triage items
    const trackIssueIds = plan.tracks[0].issues.map((i) => i.id);
    expect(trackIssueIds).toContain("FULL-001");
    expect(trackIssueIds).toContain("FULL-010");
    expect(trackIssueIds).toContain("FULL-020");
    expect(trackIssueIds).toContain("FULL-030");
  });

  // -------------------------------------------------------------------------
  // Fallback: bv is not available, falls back entirely to JSONL
  // -------------------------------------------------------------------------

  it("falls back to full JSONL plan when bv CLI is not found (ENOENT)", async () => {
    // Simulate bv not being installed
    execFileBehavior = () => {
      const err = new Error("spawn bv ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      return { stdout: "", error: err };
    };

    const plan = await getPlan(TEST_PROJECT_PATH);

    // Should fall back to issuesToPlan with all SQLite issues
    expect(mockReadIssuesFromDolt).toHaveBeenCalledWith(TEST_PROJECT_PATH);
    expect(mockIssuesToPlan).toHaveBeenCalledWith(FULL_ISSUES, TEST_PROJECT_PATH);
    expect(plan.all_issues.length).toBe(50);
  });
});
