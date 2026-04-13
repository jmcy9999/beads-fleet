// =============================================================================
// Integration tests for Dolt reader + JSONL fallback + fleet detection
// =============================================================================
// Tests the full data pipeline: Dolt/JSONL → issuesToPlan → buildFleetApps
// =============================================================================

// Mock child_process at the top level, before imports
jest.mock("child_process", () => {
  const actual = jest.requireActual("child_process");
  return {
    ...actual,
    execFileSync: jest.fn(actual.execFileSync),
  };
});

// Mock the Dolt reader — these tests use temp fixtures without real Dolt servers
jest.mock("@/lib/dolt-reader");

import {
  readIssuesFromJSONL,
  issuesToPlan,
} from "@/lib/jsonl-fallback";
import { readIssuesFromDolt } from "@/lib/dolt-reader";
const mockReadIssuesFromDolt = readIssuesFromDolt as jest.MockedFunction<typeof readIssuesFromDolt>;
import { buildFleetApps, type FleetStage } from "@/components/fleet/fleet-utils";
import {
  TEST_ISSUES,
  TEST_DEPENDENCIES,
  TEST_LABELS,
} from "../fixtures/create-test-db";
import type { BeadsIssue } from "@/lib/types";
import { execFileSync } from "child_process";

const mockExecFileSync = execFileSync as jest.MockedFunction<typeof execFileSync>;

// ---------------------------------------------------------------------------
// Test 1: Full pipeline — Dolt → issuesToPlan → fleet detection
// ---------------------------------------------------------------------------

describe("Full pipeline: Dolt → issuesToPlan → fleet detection", () => {
  beforeEach(() => {
    mockExecFileSync.mockClear();
    mockReadIssuesFromDolt.mockReset();
  });

  it("reads from Dolt, converts to plan, builds fleet apps", async () => {
    // Mock Dolt reader to return first 3 test issues
    const testIssues = TEST_ISSUES.slice(0, 3).map((issue) => {
      const deps = TEST_DEPENDENCIES.filter(([id]) => id === issue.id).map(
        ([issueId, dependsOn, type]) => ({
          issue_id: issueId,
          depends_on_id: dependsOn,
          type,
          created_at: "2026-01-01T00:00:00Z",
          created_by: "test",
        }),
      );
      const labels = TEST_LABELS.filter(([id]) => id === issue.id).map(([, label]) => label);
      return {
        ...issue,
        status: issue.status as any,
        priority: issue.priority as any,
        issue_type: issue.issue_type as any,
        labels: labels.length > 0 ? labels : undefined,
        dependencies: deps.length > 0 ? deps : undefined,
      };
    });
    mockReadIssuesFromDolt.mockResolvedValue(testIssues);

    // Step 1: Read issues
    const issues = await readIssuesFromJSONL("/test/path");
    expect(issues).toHaveLength(3);
    expect(issues.map((i) => i.id).sort()).toEqual(["TEST-001", "TEST-002", "TEST-003"]);

    // Step 2: Convert to plan
    const plan = issuesToPlan(issues, "/test/path");
    expect(plan.all_issues).toHaveLength(3);
    expect(plan.summary.open_count).toBe(1); // TEST-001
    expect(plan.summary.in_progress_count).toBe(1); // TEST-002
    expect(plan.summary.blocked_count).toBe(1); // TEST-003

    // Step 3: Build fleet apps (no epics in first 3 test issues, so empty)
    const fleetApps = buildFleetApps(plan.all_issues);
    expect(fleetApps).toHaveLength(0);
  });

  it("builds fleet apps with correct staging when epics are present", async () => {
    const epicIssues = [
      { id: "EPIC-1", title: "LensCycle", description: "Barcode scanner app", status: "open" as const, priority: 1 as const, issue_type: "epic" as const, owner: "jane@example.com", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-10T00:00:00Z" },
      { id: "EPIC-2", title: "MindStack", description: "ADHD focus app", status: "open" as const, priority: 2 as const, issue_type: "epic" as const, owner: "jane@example.com", created_at: "2026-01-02T00:00:00Z", updated_at: "2026-01-11T00:00:00Z" },
      { id: "TASK-1", title: "Research barcode APIs", description: "", status: "closed" as const, priority: 1 as const, issue_type: "task" as const, owner: "jane@example.com", created_at: "2026-01-03T00:00:00Z", updated_at: "2026-01-12T00:00:00Z" },
      { id: "TASK-2", title: "Build scanner view", description: "", status: "open" as const, priority: 1 as const, issue_type: "task" as const, owner: "jane@example.com", created_at: "2026-01-04T00:00:00Z", updated_at: "2026-01-13T00:00:00Z" },
    ];

    const epicLabels: [string, string][] = [
      ["EPIC-1", "pipeline:research-complete"], ["EPIC-2", "pipeline:development"],
      ["TASK-1", "research"], ["TASK-2", "development"],
    ];
    const epicDeps: [string, string, string][] = [
      ["TASK-1", "EPIC-1", "parent-child"], ["TASK-2", "EPIC-1", "parent-child"],
    ];

    const mockIssues = epicIssues.map((issue) => {
      const deps = epicDeps.filter(([id]) => id === issue.id).map(([issueId, dependsOn, type]) => ({
        issue_id: issueId, depends_on_id: dependsOn, type, created_at: "2026-01-01T00:00:00Z", created_by: "test",
      }));
      const labels = epicLabels.filter(([id]) => id === issue.id).map(([, label]) => label);
      return { ...issue, labels: labels.length > 0 ? labels : undefined, dependencies: deps.length > 0 ? deps : undefined };
    });
    mockReadIssuesFromDolt.mockResolvedValue(mockIssues as any);

    const issues = await readIssuesFromJSONL("/test/epics");
    const plan = issuesToPlan(issues, "/test/epics");
    const fleetApps = buildFleetApps(plan.all_issues);

    expect(fleetApps).toHaveLength(2);
    const lensCycle = fleetApps.find((a) => a.epic.id === "EPIC-1")!;
    const mindStack = fleetApps.find((a) => a.epic.id === "EPIC-2")!;
    expect(lensCycle.stage).toBe("research-complete");
    expect(mindStack.stage).toBe("development");
    expect(lensCycle.children).toHaveLength(2);
    expect(lensCycle.progress.closed).toBe(1);
    expect(lensCycle.progress.total).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Test 2: Dolt-backed project with no JSONL file
// ---------------------------------------------------------------------------

describe("Dolt reader integration", () => {
  beforeEach(() => {
    mockReadIssuesFromDolt.mockReset();
  });

  it("throws when Dolt server is not available", async () => {
    mockReadIssuesFromDolt.mockRejectedValue(new Error("No Dolt server port found"));

    await expect(readIssuesFromJSONL("/nonexistent")).rejects.toThrow("No Dolt server");
  });

  it("returns issues from Dolt reader", async () => {
    const mockIssues = [
      { id: "DOLT-1", title: "First issue", status: "open" as const, priority: 1 as const, issue_type: "task" as const, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
      { id: "DOLT-2", title: "Second issue", status: "closed" as const, priority: 2 as const, issue_type: "bug" as const, created_at: "2026-01-02T00:00:00Z", updated_at: "2026-01-02T00:00:00Z" },
    ];
    mockReadIssuesFromDolt.mockResolvedValue(mockIssues as any);

    const issues = await readIssuesFromJSONL("/test/dolt");
    expect(issues).toHaveLength(2);
    expect(issues[0].id).toBe("DOLT-1");
    expect(issues[1].id).toBe("DOLT-2");
  });
});

// ---------------------------------------------------------------------------
// Test 3: Dolt-backed project with stale JSONL vs fresh JSONL
// ---------------------------------------------------------------------------

describe("Dolt reader returns fresh data (no stale fallback)", () => {
  beforeEach(() => {
    mockReadIssuesFromDolt.mockReset();
  });

  it("always returns data from Dolt, never from JSONL", async () => {
    // Mock Dolt to return all 8 issues
    const allIssues = TEST_ISSUES.map((issue) => {
      const deps = TEST_DEPENDENCIES.filter(([id]) => id === issue.id).map(
        ([issueId, dependsOn, type]) => ({
          issue_id: issueId, depends_on_id: dependsOn, type,
          created_at: "2026-01-01T00:00:00Z", created_by: "test",
        }),
      );
      const labels = TEST_LABELS.filter(([id]) => id === issue.id).map(([, label]) => label);
      return { ...issue, status: issue.status as any, priority: issue.priority as any, issue_type: issue.issue_type as any, labels: labels.length > 0 ? labels : undefined, dependencies: deps.length > 0 ? deps : undefined };
    });
    mockReadIssuesFromDolt.mockResolvedValue(allIssues);

    const issues = await readIssuesFromJSONL("/test/fresh");
    expect(issues).toHaveLength(8);
  });

  it("does not fall back to stale data when Dolt fails", async () => {
    mockReadIssuesFromDolt.mockRejectedValue(new Error("Dolt server down"));

    await expect(readIssuesFromJSONL("/test/stale")).rejects.toThrow("Dolt server down");
  });
});

// ---------------------------------------------------------------------------
// Test 4: Fleet board epic visibility with pipeline labels
// ---------------------------------------------------------------------------

describe("Fleet board epic visibility with pipeline labels", () => {
  beforeEach(() => {
    mockReadIssuesFromDolt.mockReset();
  });

  it("correctly stages epics based on pipeline labels", async () => {
    const mockIssues = [
      { id: "APP-1", title: "App with no pipeline label", status: "open" as const, priority: 1 as const, issue_type: "epic" as const, owner: "", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
      { id: "APP-2", title: "App in research-complete", status: "open" as const, priority: 1 as const, issue_type: "epic" as const, owner: "", labels: ["pipeline:research-complete"], created_at: "2026-01-02T00:00:00Z", updated_at: "2026-01-02T00:00:00Z" },
      { id: "APP-3", title: "App in development", status: "open" as const, priority: 1 as const, issue_type: "epic" as const, owner: "", labels: ["pipeline:development"], created_at: "2026-01-03T00:00:00Z", updated_at: "2026-01-03T00:00:00Z" },
      { id: "APP-4", title: "App abandoned", status: "closed" as const, priority: 1 as const, issue_type: "epic" as const, owner: "", labels: ["pipeline:bad-idea"], created_at: "2026-01-04T00:00:00Z", updated_at: "2026-01-04T00:00:00Z" },
      { id: "TASK-1", title: "Some task", status: "open" as const, priority: 1 as const, issue_type: "task" as const, owner: "", created_at: "2026-01-05T00:00:00Z", updated_at: "2026-01-05T00:00:00Z" },
    ];
    mockReadIssuesFromDolt.mockResolvedValue(mockIssues as any);

    const issues = await readIssuesFromJSONL("/test/staging");
    const plan = issuesToPlan(issues, "/test/staging");
    const fleetApps = buildFleetApps(plan.all_issues);

    expect(fleetApps).toHaveLength(4);
    expect(fleetApps.find((a) => a.epic.id === "APP-1")!.stage).toBe("idea");
    expect(fleetApps.find((a) => a.epic.id === "APP-2")!.stage).toBe("research-complete");
    expect(fleetApps.find((a) => a.epic.id === "APP-3")!.stage).toBe("development");
    expect(fleetApps.find((a) => a.epic.id === "APP-4")!.stage).toBe("bad-idea");
    expect(fleetApps.some((a) => a.epic.id === "TASK-1")).toBe(false);
  });

  it("correctly stages epic in plan-review when plan labels are present", async () => {
    const mockIssues = [
      { id: "APP-PLANNED", title: "App with plan pending review", status: "open" as const, priority: 1 as const, issue_type: "epic" as const, owner: "", labels: ["pipeline:research-complete", "plan:pending"], created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
    ];
    mockReadIssuesFromDolt.mockResolvedValue(mockIssues as any);

    const issues = await readIssuesFromJSONL("/test/plan-review");
    const plan = issuesToPlan(issues, "/test/plan-review");
    const fleetApps = buildFleetApps(plan.all_issues);

    expect(fleetApps).toHaveLength(1);
    expect(fleetApps[0].stage).toBe("plan-review");
  });
});
