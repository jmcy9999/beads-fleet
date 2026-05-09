// =============================================================================
// Tests for src/app/api/issues/route.ts — GET /api/issues
// =============================================================================

import type { RobotPlan } from "@/lib/types";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock("@/lib/repo-config", () => ({
  getActiveProjectPath: jest.fn(),
  getAllRepoPaths: jest.fn(),
  ALL_PROJECTS_SENTINEL: "__all__",
}));

jest.mock("@/lib/bv-client", () => ({
  invalidateCache: jest.fn(),
}));

jest.mock("@/lib/read-model-snapshot", () => ({
  getRepoReadSnapshot: jest.fn(),
  getPortfolioReadSnapshot: jest.fn(),
}));

import { GET } from "@/app/api/issues/route";
import { getActiveProjectPath, getAllRepoPaths } from "@/lib/repo-config";
import {
  getPortfolioReadSnapshot,
  getRepoReadSnapshot,
} from "@/lib/read-model-snapshot";

const mockGetActiveProjectPath = getActiveProjectPath as jest.MockedFunction<
  typeof getActiveProjectPath
>;
const mockGetAllRepoPaths = getAllRepoPaths as jest.MockedFunction<
  typeof getAllRepoPaths
>;
const mockGetRepoReadSnapshot = getRepoReadSnapshot as jest.MockedFunction<
  typeof getRepoReadSnapshot
>;
const mockGetPortfolioReadSnapshot =
  getPortfolioReadSnapshot as jest.MockedFunction<
    typeof getPortfolioReadSnapshot
  >;

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const TEST_PROJECT_PATH = "/tmp/test-project";

const MOCK_PLAN: RobotPlan = {
  timestamp: "2026-01-15T00:00:00Z",
  project_path: TEST_PROJECT_PATH,
  summary: {
    open_count: 3,
    in_progress_count: 1,
    blocked_count: 1,
    closed_count: 1,
  },
  tracks: [],
  all_issues: [
    {
      id: "TEST-001",
      title: "Test issue",
      status: "open",
      priority: 1,
      issue_type: "feature",
      blocked_by: [],
      blocks: [],
    },
  ],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/issues", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns 200 with plan data", async () => {
    mockGetActiveProjectPath.mockResolvedValue(TEST_PROJECT_PATH);
    mockGetRepoReadSnapshot.mockResolvedValue({
      repoPath: TEST_PROJECT_PATH,
      repoName: "test-project",
      issues: [],
      plan: MOCK_PLAN,
      generatedAt: MOCK_PLAN.timestamp,
      refreshDurationMs: 1,
    });

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual(MOCK_PLAN);
    expect(mockGetActiveProjectPath).toHaveBeenCalledTimes(1);
    expect(mockGetRepoReadSnapshot).toHaveBeenCalledWith(TEST_PROJECT_PATH);
  });

  it("returns 200 with aggregated plan data in all-projects mode", async () => {
    mockGetActiveProjectPath.mockResolvedValue("__all__");
    mockGetAllRepoPaths.mockResolvedValue(["/repo-a", "/repo-b"]);
    mockGetPortfolioReadSnapshot.mockResolvedValue({
      repoPaths: ["/repo-a", "/repo-b"],
      repos: [],
      issues: [],
      plan: { ...MOCK_PLAN, project_path: "__all__" },
      offline_repos: [],
      generatedAt: MOCK_PLAN.timestamp,
      refreshDurationMs: 1,
    });

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.project_path).toBe("__all__");
    expect(mockGetPortfolioReadSnapshot).toHaveBeenCalledWith([
      "/repo-a",
      "/repo-b",
    ]);
  });

  it("returns 503 when BEADS_PROJECT_PATH is not configured", async () => {
    mockGetActiveProjectPath.mockRejectedValue(
      new Error(
        "No repository configured. Set BEADS_PROJECT_PATH or add a repo via Settings.",
      ),
    );

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error).toBe("BEADS_PROJECT_PATH not configured");
    expect(body.detail).toContain("BEADS_PROJECT_PATH");
  });

  it("returns 500 on generic errors", async () => {
    mockGetActiveProjectPath.mockResolvedValue(TEST_PROJECT_PATH);
    mockGetRepoReadSnapshot.mockRejectedValue(new Error("Unexpected failure"));

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe("Failed to fetch issues");
    expect(body.detail).toBe("Unexpected failure");
  });
});
