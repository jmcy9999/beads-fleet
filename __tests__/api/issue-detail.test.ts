// =============================================================================
// Tests for src/app/api/issues/[id]/route.ts — GET /api/issues/:id
// =============================================================================

import { NextRequest } from "next/server";
import type { PlanIssue, BeadsIssue } from "@/lib/types";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock("@/lib/repo-config", () => ({
  getActiveProjectPath: jest.fn(),
  findRepoForIssue: jest.fn(),
  ALL_PROJECTS_SENTINEL: "__all__",
}));

jest.mock("@/lib/bv-client", () => ({
  getIssueById: jest.fn(),
}));

jest.mock("@/lib/read-model-snapshot", () => ({
  getRepoReadSnapshot: jest.fn(),
}));

import { GET } from "@/app/api/issues/[id]/route";
import { getActiveProjectPath, findRepoForIssue } from "@/lib/repo-config";
import { getRepoReadSnapshot } from "@/lib/read-model-snapshot";

const mockGetActiveProjectPath = getActiveProjectPath as jest.MockedFunction<
  typeof getActiveProjectPath
>;
const mockFindRepoForIssue = findRepoForIssue as jest.MockedFunction<
  typeof findRepoForIssue
>;
const mockGetRepoReadSnapshot = getRepoReadSnapshot as jest.MockedFunction<
  typeof getRepoReadSnapshot
>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_PROJECT_PATH = "/tmp/test-project";

function makeRequest(id: string): NextRequest {
  return new NextRequest(`http://localhost:3000/api/issues/${id}`);
}

function makeParams(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function mockSnapshot({
  planIssue = MOCK_PLAN_ISSUE,
  rawIssue = MOCK_RAW_ISSUE,
}: {
  planIssue?: PlanIssue;
  rawIssue?: BeadsIssue | null;
} = {}) {
  mockGetRepoReadSnapshot.mockResolvedValue({
    repoPath: TEST_PROJECT_PATH,
    repoName: "test-project",
    issues: rawIssue ? [rawIssue] : [],
    plan: {
      timestamp: "2026-01-10T00:00:00Z",
      project_path: TEST_PROJECT_PATH,
      summary: {
        open_count: 1,
        in_progress_count: 0,
        blocked_count: 0,
        closed_count: 0,
      },
      tracks: [],
      all_issues: [planIssue],
    },
    generatedAt: "2026-01-10T00:00:00Z",
    refreshDurationMs: 1,
  });
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const MOCK_PLAN_ISSUE: PlanIssue = {
  id: "TEST-001",
  title: "Implement user authentication",
  status: "open",
  priority: 1,
  issue_type: "feature",
  owner: "alice@example.com",
  labels: ["auth", "backend"],
  blocked_by: [],
  blocks: ["TEST-003", "TEST-004", "TEST-007"],
  impact_score: 3.5,
};

const MOCK_RAW_ISSUE: BeadsIssue = {
  id: "TEST-001",
  title: "Implement user authentication",
  description: "Add login/signup flow with JWT tokens",
  status: "open",
  priority: 1,
  issue_type: "feature",
  owner: "alice@example.com",
  labels: ["auth", "backend"],
  dependencies: [],
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-10T00:00:00Z",
};

const MOCK_ISSUE_RESPONSE = {
  plan_issue: MOCK_PLAN_ISSUE,
  raw_issue: MOCK_RAW_ISSUE,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/issues/:id", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns 200 with issue data", async () => {
    mockGetActiveProjectPath.mockResolvedValue(TEST_PROJECT_PATH);
    mockSnapshot();

    const response = await GET(makeRequest("TEST-001"), makeParams("TEST-001"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual(MOCK_ISSUE_RESPONSE);
    expect(mockGetActiveProjectPath).toHaveBeenCalledTimes(1);
    expect(mockGetRepoReadSnapshot).toHaveBeenCalledWith(TEST_PROJECT_PATH);
  });

  it("returns 404 when issue is not found", async () => {
    mockGetActiveProjectPath.mockResolvedValue(TEST_PROJECT_PATH);
    mockSnapshot();

    const response = await GET(
      makeRequest("NONEXISTENT-999"),
      makeParams("NONEXISTENT-999"),
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toContain("not found");
  });

  it("returns 500 on generic errors", async () => {
    mockGetActiveProjectPath.mockResolvedValue(TEST_PROJECT_PATH);
    mockGetRepoReadSnapshot.mockRejectedValue(
      new Error("Database connection lost"),
    );

    const response = await GET(makeRequest("TEST-001"), makeParams("TEST-001"));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe("Database connection lost");
  });

  it("passes the correct ID from params to getIssueById", async () => {
    mockGetActiveProjectPath.mockResolvedValue(TEST_PROJECT_PATH);
    mockSnapshot({
      planIssue: { ...MOCK_PLAN_ISSUE, id: "PROJ-042" },
      rawIssue: null,
    });

    await GET(makeRequest("PROJ-042"), makeParams("PROJ-042"));

    expect(mockGetRepoReadSnapshot).toHaveBeenCalledWith(TEST_PROJECT_PATH);
  });

  it("returns issue data even when raw_issue is null", async () => {
    mockGetActiveProjectPath.mockResolvedValue(TEST_PROJECT_PATH);
    mockSnapshot({ rawIssue: null });

    const response = await GET(makeRequest("TEST-001"), makeParams("TEST-001"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.plan_issue).toEqual(MOCK_PLAN_ISSUE);
    expect(body.raw_issue).toBeNull();
  });

  // -------------------------------------------------------------------------
  // __all__ aggregation mode
  // -------------------------------------------------------------------------

  it("resolves repo via findRepoForIssue in __all__ mode", async () => {
    mockGetActiveProjectPath.mockResolvedValue("__all__");
    mockFindRepoForIssue.mockResolvedValue("/tmp/resolved-project");
    mockGetRepoReadSnapshot.mockResolvedValue({
      repoPath: "/tmp/resolved-project",
      repoName: "resolved-project",
      issues: [MOCK_RAW_ISSUE],
      plan: {
        timestamp: "2026-01-10T00:00:00Z",
        project_path: "/tmp/resolved-project",
        summary: {
          open_count: 1,
          in_progress_count: 0,
          blocked_count: 0,
          closed_count: 0,
        },
        tracks: [],
        all_issues: [MOCK_PLAN_ISSUE],
      },
      generatedAt: "2026-01-10T00:00:00Z",
      refreshDurationMs: 1,
    });

    const response = await GET(makeRequest("TEST-001"), makeParams("TEST-001"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual(MOCK_ISSUE_RESPONSE);
    expect(mockFindRepoForIssue).toHaveBeenCalledWith("TEST-001");
    expect(mockGetRepoReadSnapshot).toHaveBeenCalledWith(
      "/tmp/resolved-project",
    );
  });

  it("returns 404 when issue not found in any repo in __all__ mode", async () => {
    mockGetActiveProjectPath.mockResolvedValue("__all__");
    mockFindRepoForIssue.mockResolvedValue(null);

    const response = await GET(
      makeRequest("GHOST-999"),
      makeParams("GHOST-999"),
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toContain("GHOST-999");
    expect(body.error).toContain("not found in any configured repo");
    expect(mockGetRepoReadSnapshot).not.toHaveBeenCalled();
  });
});
