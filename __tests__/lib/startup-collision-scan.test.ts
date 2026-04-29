// =============================================================================
// Tests for src/lib/startup-collision-scan.ts — scanForBeadIdCollisions()
// =============================================================================
//
// beads_web-8wh AC 7: verifies collision detection with mocked getPlan. Two
// test cases:
//   1. Collision: two RobotPlans share a bead ID -> warns
//   2. No collision: disjoint ID sets -> logs clean message
//
// No live .beads/issues.jsonl mutation.
// =============================================================================

import type { RobotPlan, PlanIssue } from "@/lib/types";

// ---------------------------------------------------------------------------
// Mocks — declared before importing module under test
// ---------------------------------------------------------------------------

const mockGetAllRepoPaths = jest.fn<Promise<string[]>, []>();
const mockGetPlan = jest.fn<Promise<RobotPlan>, [string?]>();

jest.mock("@/lib/repo-config", () => ({
  getAllRepoPaths: (...args: unknown[]) => mockGetAllRepoPaths(...(args as [])),
}));

jest.mock("@/lib/bv-client", () => ({
  getPlan: (...args: unknown[]) => mockGetPlan(...(args as [string?])),
}));

// Import module under test AFTER mocks are registered
import { scanForBeadIdCollisions } from "@/lib/startup-collision-scan";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePlanIssue(id: string): PlanIssue {
  return {
    id,
    title: `Issue ${id}`,
    status: "open",
    priority: 2,
    issue_type: "task",
    blocked_by: [],
    blocks: [],
  };
}

function makeRobotPlan(projectPath: string, issues: PlanIssue[]): RobotPlan {
  return {
    timestamp: new Date().toISOString(),
    project_path: projectPath,
    summary: {
      open_count: issues.length,
      in_progress_count: 0,
      blocked_count: 0,
      closed_count: 0,
    },
    tracks: [],
    all_issues: issues,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("scanForBeadIdCollisions", () => {
  let consoleWarnSpy: jest.SpyInstance;
  let consoleLogSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    consoleLogSpy = jest.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
    consoleLogSpy.mockRestore();
  });

  it("logs collision warning when two repos share a bead ID", async () => {
    // AC 7 test 1: two RobotPlans where all_issues both contain
    // an issue with id: "test-collision-1"
    const repoA = "/repos/alpha";
    const repoB = "/repos/beta";

    mockGetAllRepoPaths.mockResolvedValue([repoA, repoB]);
    mockGetPlan.mockImplementation(async (repoPath?: string) => {
      if (repoPath === repoA) {
        return makeRobotPlan(repoA, [
          makePlanIssue("test-collision-1"),
          makePlanIssue("alpha-only-1"),
        ]);
      }
      if (repoPath === repoB) {
        return makeRobotPlan(repoB, [
          makePlanIssue("test-collision-1"),
          makePlanIssue("beta-only-1"),
        ]);
      }
      throw new Error(`Unexpected repo: ${repoPath}`);
    });

    await scanForBeadIdCollisions();

    // Should log the collision summary line
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      "[COLLISION SCAN] Found 1 bead-ID collisions at startup:",
    );

    // Should log the per-collision detail line
    const detailCalls = consoleWarnSpy.mock.calls.filter(
      (args: unknown[]) =>
        typeof args[0] === "string" &&
        (args[0] as string).includes("test-collision-1"),
    );
    expect(detailCalls.length).toBe(1);
    expect(detailCalls[0][0]).toContain("test-collision-1");
    expect(detailCalls[0][0]).toContain(repoA);
    expect(detailCalls[0][0]).toContain(repoB);

    // Should NOT log the clean-registry message
    const cleanCalls = consoleLogSpy.mock.calls.filter(
      (args: unknown[]) =>
        typeof args[0] === "string" &&
        (args[0] as string).includes("No bead-ID collisions found"),
    );
    expect(cleanCalls.length).toBe(0);

    // Should log completion with timing
    const completionCalls = consoleLogSpy.mock.calls.filter(
      (args: unknown[]) =>
        typeof args[0] === "string" &&
        (args[0] as string).includes("[COLLISION SCAN] Completed in"),
    );
    expect(completionCalls.length).toBe(1);
    expect(completionCalls[0][0]).toContain("across 2 repos");
  });

  it("logs clean-registry message when no collisions found", async () => {
    // AC 7 test 2: disjoint issue ID sets -> no collisions
    const repoA = "/repos/alpha";
    const repoB = "/repos/beta";

    mockGetAllRepoPaths.mockResolvedValue([repoA, repoB]);
    mockGetPlan.mockImplementation(async (repoPath?: string) => {
      if (repoPath === repoA) {
        return makeRobotPlan(repoA, [
          makePlanIssue("alpha-issue-1"),
          makePlanIssue("alpha-issue-2"),
        ]);
      }
      if (repoPath === repoB) {
        return makeRobotPlan(repoB, [
          makePlanIssue("beta-issue-1"),
          makePlanIssue("beta-issue-2"),
        ]);
      }
      throw new Error(`Unexpected repo: ${repoPath}`);
    });

    await scanForBeadIdCollisions();

    // Should log the clean-registry message
    expect(consoleLogSpy).toHaveBeenCalledWith(
      "[COLLISION SCAN] No bead-ID collisions found across 2 repos.",
    );

    // Should NOT log the collision summary
    const collisionCalls = consoleWarnSpy.mock.calls.filter(
      (args: unknown[]) =>
        typeof args[0] === "string" &&
        (args[0] as string).includes("bead-ID collisions at startup"),
    );
    expect(collisionCalls.length).toBe(0);

    // Should log completion with timing
    const completionCalls = consoleLogSpy.mock.calls.filter(
      (args: unknown[]) =>
        typeof args[0] === "string" &&
        (args[0] as string).includes("[COLLISION SCAN] Completed in"),
    );
    expect(completionCalls.length).toBe(1);
    expect(completionCalls[0][0]).toContain("across 2 repos");
  });

  it("handles per-repo getPlan failure gracefully via Promise.allSettled", async () => {
    // AC 5: if getPlan fails for one repo, log a warning and continue
    const repoA = "/repos/alpha";
    const repoB = "/repos/beta-broken";
    const repoC = "/repos/gamma";

    mockGetAllRepoPaths.mockResolvedValue([repoA, repoB, repoC]);
    mockGetPlan.mockImplementation(async (repoPath?: string) => {
      if (repoPath === repoA) {
        return makeRobotPlan(repoA, [makePlanIssue("alpha-1")]);
      }
      if (repoPath === repoB) {
        throw new Error("Dolt server unreachable");
      }
      if (repoPath === repoC) {
        return makeRobotPlan(repoC, [makePlanIssue("gamma-1")]);
      }
      throw new Error(`Unexpected repo: ${repoPath}`);
    });

    await scanForBeadIdCollisions();

    // Should warn about the failed repo
    const failWarns = consoleWarnSpy.mock.calls.filter(
      (args: unknown[]) =>
        typeof args[0] === "string" &&
        (args[0] as string).includes("Failed to read plan for repo"),
    );
    expect(failWarns.length).toBe(1);
    expect(failWarns[0][0]).toContain(repoB);

    // Should still report clean scan for the 2 successful repos
    expect(consoleLogSpy).toHaveBeenCalledWith(
      "[COLLISION SCAN] No bead-ID collisions found across 2 repos.",
    );
  });

  it("handles empty repo list gracefully", async () => {
    mockGetAllRepoPaths.mockResolvedValue([]);

    await scanForBeadIdCollisions();

    expect(consoleLogSpy).toHaveBeenCalledWith(
      "[COLLISION SCAN] No repos registered, skipping scan.",
    );
  });

  it("handles getAllRepoPaths failure gracefully", async () => {
    mockGetAllRepoPaths.mockRejectedValue(new Error("Config file corrupt"));

    await scanForBeadIdCollisions();

    const failWarns = consoleWarnSpy.mock.calls.filter(
      (args: unknown[]) =>
        typeof args[0] === "string" &&
        (args[0] as string).includes("Failed to read repo paths"),
    );
    expect(failWarns.length).toBe(1);
  });

  it("detects multiple collisions across multiple repos", async () => {
    const repoA = "/repos/alpha";
    const repoB = "/repos/beta";
    const repoC = "/repos/gamma";

    mockGetAllRepoPaths.mockResolvedValue([repoA, repoB, repoC]);
    mockGetPlan.mockImplementation(async (repoPath?: string) => {
      if (repoPath === repoA) {
        return makeRobotPlan(repoA, [
          makePlanIssue("collision-1"),
          makePlanIssue("collision-2"),
        ]);
      }
      if (repoPath === repoB) {
        return makeRobotPlan(repoB, [
          makePlanIssue("collision-1"),
          makePlanIssue("unique-b"),
        ]);
      }
      if (repoPath === repoC) {
        return makeRobotPlan(repoC, [
          makePlanIssue("collision-2"),
          makePlanIssue("unique-c"),
        ]);
      }
      throw new Error(`Unexpected repo: ${repoPath}`);
    });

    await scanForBeadIdCollisions();

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      "[COLLISION SCAN] Found 2 bead-ID collisions at startup:",
    );
  });
});
