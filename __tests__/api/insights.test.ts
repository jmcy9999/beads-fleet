// =============================================================================
// Tests for src/app/api/insights/route.ts — GET /api/insights
// =============================================================================

import type { RobotInsights } from "@/lib/types";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock("@/lib/repo-config", () => ({
  getActiveProjectPath: jest.fn(),
  getAllRepoPaths: jest.fn(),
  ALL_PROJECTS_SENTINEL: "__all__",
}));

jest.mock("@/lib/bv-client", () => ({
  getInsights: jest.fn(),
}));

jest.mock("@/lib/read-model-snapshot", () => ({
  getPortfolioReadSnapshot: jest.fn(),
}));

jest.mock("@/lib/graph-metrics", () => ({
  computeInsightsFromIssues: jest.fn(),
}));

import { GET } from "@/app/api/insights/route";
import { getActiveProjectPath, getAllRepoPaths } from "@/lib/repo-config";
import { getInsights } from "@/lib/bv-client";
import { getPortfolioReadSnapshot } from "@/lib/read-model-snapshot";
import { computeInsightsFromIssues } from "@/lib/graph-metrics";

const mockGetActiveProjectPath = getActiveProjectPath as jest.MockedFunction<
  typeof getActiveProjectPath
>;
const mockGetAllRepoPaths = getAllRepoPaths as jest.MockedFunction<
  typeof getAllRepoPaths
>;
const mockGetInsights = getInsights as jest.MockedFunction<typeof getInsights>;
const mockGetPortfolioReadSnapshot =
  getPortfolioReadSnapshot as jest.MockedFunction<
    typeof getPortfolioReadSnapshot
  >;
const mockComputeInsightsFromIssues =
  computeInsightsFromIssues as jest.MockedFunction<
    typeof computeInsightsFromIssues
  >;

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const TEST_PROJECT_PATH = "/tmp/test-project";

const MOCK_INSIGHTS: RobotInsights = {
  timestamp: "2026-01-15T00:00:00Z",
  project_path: TEST_PROJECT_PATH,
  total_issues: 8,
  graph_density: 0.15,
  bottlenecks: [{ issue_id: "TEST-001", title: "Auth", score: 3.5 }],
  keystones: [],
  influencers: [],
  hubs: [],
  authorities: [],
  cycles: [],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/insights", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns 200 with insights data", async () => {
    mockGetActiveProjectPath.mockResolvedValue(TEST_PROJECT_PATH);
    mockGetInsights.mockResolvedValue(MOCK_INSIGHTS);

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual(MOCK_INSIGHTS);
    expect(mockGetActiveProjectPath).toHaveBeenCalledTimes(1);
    expect(mockGetInsights).toHaveBeenCalledWith(TEST_PROJECT_PATH);
  });

  it("uses the portfolio snapshot in all-projects mode", async () => {
    const allInsights = { ...MOCK_INSIGHTS, project_path: "__all__" };
    mockGetActiveProjectPath.mockResolvedValue("__all__");
    mockGetAllRepoPaths.mockResolvedValue(["/repo-a"]);
    mockGetPortfolioReadSnapshot.mockResolvedValue({
      repoPaths: ["/repo-a"],
      repos: [],
      issues: [
        {
          id: "A-1",
          title: "A",
          status: "open",
          priority: 2,
          issue_type: "task",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
      ],
      plan: {
        timestamp: "2026-01-01T00:00:00Z",
        project_path: "__all__",
        summary: {
          open_count: 1,
          in_progress_count: 0,
          blocked_count: 0,
          closed_count: 0,
        },
        tracks: [],
        all_issues: [],
        offline_repos: [],
      },
      offline_repos: [],
      generatedAt: "2026-01-01T00:00:00Z",
      refreshDurationMs: 1,
    });
    mockComputeInsightsFromIssues.mockReturnValue(allInsights);

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual(allInsights);
    expect(mockGetPortfolioReadSnapshot).toHaveBeenCalledWith(["/repo-a"]);
    expect(mockGetInsights).not.toHaveBeenCalled();
  });

  it("returns 503 when project path is not configured", async () => {
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
    mockGetInsights.mockRejectedValue(new Error("Subprocess timed out"));

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe("Failed to fetch insights");
    expect(body.detail).toBe("Subprocess timed out");
  });
});
