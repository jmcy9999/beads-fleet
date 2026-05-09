// =============================================================================
// Tests for src/app/api/signals/route.ts — GET /api/signals
// =============================================================================

import type { BeadsIssue } from "@/lib/types";

const mockReadIssues = jest.fn<Promise<BeadsIssue[]>, [string]>();

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock("@/lib/repo-config", () => ({
  getActiveProjectPath: jest.fn(),
  getAllRepoPaths: jest.fn(),
  ALL_PROJECTS_SENTINEL: "__all__",
}));

jest.mock("@/lib/dolt-reader", () => ({
  readIssuesFromDolt: (...args: [string]) => mockReadIssues(...args),
}));

jest.mock("@/lib/read-model-snapshot", () => ({
  getRepoReadSnapshot: async (repoPath: string) => ({
    repoPath,
    repoName: repoPath.split("/").pop() ?? "repo",
    issues: await mockReadIssues(repoPath),
    plan: {
      timestamp: "2026-02-10T00:00:00Z",
      project_path: repoPath,
      summary: {
        open_count: 0,
        in_progress_count: 0,
        blocked_count: 0,
        closed_count: 0,
      },
      tracks: [],
      all_issues: [],
    },
    generatedAt: "2026-02-10T00:00:00Z",
    refreshDurationMs: 1,
  }),
  getPortfolioReadSnapshot: async (repoPaths: string[]) => {
    const issueArrays = await Promise.all(
      repoPaths.map((repoPath) => mockReadIssues(repoPath)),
    );
    return {
      repoPaths,
      repos: [],
      issues: issueArrays.flat(),
      plan: {
        timestamp: "2026-02-10T00:00:00Z",
        project_path: "__all__",
        summary: {
          open_count: 0,
          in_progress_count: 0,
          blocked_count: 0,
          closed_count: 0,
        },
        tracks: [],
        all_issues: [],
        offline_repos: [],
      },
      offline_repos: [],
      generatedAt: "2026-02-10T00:00:00Z",
      refreshDurationMs: 1,
    };
  },
}));

import { GET } from "@/app/api/signals/route";
import { getActiveProjectPath, getAllRepoPaths } from "@/lib/repo-config";
import { NextRequest } from "next/server";

const mockGetActiveProjectPath = getActiveProjectPath as jest.MockedFunction<typeof getActiveProjectPath>;
const mockGetAllRepoPaths = getAllRepoPaths as jest.MockedFunction<typeof getAllRepoPaths>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_PATH = "/tmp/test-project";

function makeRequest(params: Record<string, string | string[]> = {}): NextRequest {
  const url = new URL("http://localhost:3000/api/signals");
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const v of value) url.searchParams.append(key, v);
    } else {
      url.searchParams.set(key, value);
    }
  }
  return new NextRequest(url);
}

function makeIssue(overrides: Partial<BeadsIssue> = {}): BeadsIssue {
  return {
    id: "TEST-001",
    title: "Test issue",
    status: "closed",
    priority: 2,
    issue_type: "task",
    created_at: "2026-02-01T00:00:00Z",
    updated_at: "2026-02-10T00:00:00Z",
    closed_at: "2026-02-10T00:00:00Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/signals", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetActiveProjectPath.mockResolvedValue(TEST_PATH);
  });

  it("returns 400 when 'since' parameter is missing", async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("since");
  });

  it("returns 400 when 'since' is not a valid timestamp", async () => {
    const res = await GET(makeRequest({ since: "not-a-date" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid");
  });

  it("returns 400 for invalid 'field' parameter", async () => {
    const res = await GET(makeRequest({ since: "2026-02-01T00:00:00Z", field: "created_at" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("field");
  });

  it("returns closed issues after the 'since' timestamp", async () => {
    mockReadIssues.mockResolvedValue([
      makeIssue({ id: "A-1", closed_at: "2026-02-15T10:00:00Z" }),
      makeIssue({ id: "A-2", closed_at: "2026-02-01T00:00:00Z" }), // before since
      makeIssue({ id: "A-3", status: "open", closed_at: undefined }), // not closed
    ]);

    const res = await GET(makeRequest({ since: "2026-02-10T00:00:00Z" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.signals).toHaveLength(1);
    expect(body.signals[0].id).toBe("A-1");
    expect(body.count).toBe(1);
  });

  it("filters by label", async () => {
    mockReadIssues.mockResolvedValue([
      makeIssue({ id: "R-1", labels: ["research"], closed_at: "2026-02-15T10:00:00Z" }),
      makeIssue({ id: "D-1", labels: ["development"], closed_at: "2026-02-15T10:00:00Z" }),
      makeIssue({ id: "R-2", labels: ["research", "urgent"], closed_at: "2026-02-15T11:00:00Z" }),
    ]);

    const res = await GET(makeRequest({ since: "2026-02-10T00:00:00Z", label: "research" }));
    const body = await res.json();
    expect(body.signals).toHaveLength(2);
    expect(body.signals.map((s: { id: string }) => s.id)).toEqual(["R-2", "R-1"]);
  });

  it("filters by multiple labels (AND logic)", async () => {
    mockReadIssues.mockResolvedValue([
      makeIssue({ id: "R-1", labels: ["research"], closed_at: "2026-02-15T10:00:00Z" }),
      makeIssue({ id: "R-2", labels: ["research", "urgent"], closed_at: "2026-02-15T11:00:00Z" }),
    ]);

    const res = await GET(makeRequest({ since: "2026-02-10T00:00:00Z", label: ["research", "urgent"] }));
    const body = await res.json();
    expect(body.signals).toHaveLength(1);
    expect(body.signals[0].id).toBe("R-2");
  });

  it("can filter by updated_at instead of closed_at", async () => {
    mockReadIssues.mockResolvedValue([
      makeIssue({ id: "U-1", status: "closed", updated_at: "2026-02-20T00:00:00Z", closed_at: "2026-02-01T00:00:00Z" }),
    ]);

    // Using closed_at filter — should miss it (closed before since)
    const res1 = await GET(makeRequest({ since: "2026-02-10T00:00:00Z" }));
    const body1 = await res1.json();
    expect(body1.signals).toHaveLength(0);

    // Using updated_at filter — should find it
    const res2 = await GET(makeRequest({ since: "2026-02-10T00:00:00Z", field: "updated_at" }));
    const body2 = await res2.json();
    expect(body2.signals).toHaveLength(1);
    expect(body2.signals[0].id).toBe("U-1");
  });

  it("can filter by non-closed statuses", async () => {
    mockReadIssues.mockResolvedValue([
      makeIssue({ id: "B-1", status: "blocked", updated_at: "2026-02-15T10:00:00Z" }),
      makeIssue({ id: "C-1", status: "closed", closed_at: "2026-02-15T10:00:00Z" }),
    ]);

    const res = await GET(makeRequest({
      since: "2026-02-10T00:00:00Z",
      status: "blocked",
      field: "updated_at",
    }));
    const body = await res.json();
    expect(body.signals).toHaveLength(1);
    expect(body.signals[0].id).toBe("B-1");
  });

  it("returns signals sorted newest first", async () => {
    mockReadIssues.mockResolvedValue([
      makeIssue({ id: "OLD", closed_at: "2026-02-11T00:00:00Z" }),
      makeIssue({ id: "NEW", closed_at: "2026-02-15T00:00:00Z" }),
      makeIssue({ id: "MID", closed_at: "2026-02-13T00:00:00Z" }),
    ]);

    const res = await GET(makeRequest({ since: "2026-02-10T00:00:00Z" }));
    const body = await res.json();
    expect(body.signals.map((s: { id: string }) => s.id)).toEqual(["NEW", "MID", "OLD"]);
  });

  it("includes close_reason and epic in response", async () => {
    mockReadIssues.mockResolvedValue([
      makeIssue({
        id: "R-1",
        close_reason: "Research complete. Market size: $2.3B",
        parent: "EPIC-1",
        closed_at: "2026-02-15T00:00:00Z",
      }),
    ]);

    const res = await GET(makeRequest({ since: "2026-02-10T00:00:00Z" }));
    const body = await res.json();
    expect(body.signals[0].close_reason).toBe("Research complete. Market size: $2.3B");
    expect(body.signals[0].epic).toBe("EPIC-1");
  });

  it("supports __all__ aggregation mode", async () => {
    mockGetActiveProjectPath.mockResolvedValue("__all__");
    mockGetAllRepoPaths.mockResolvedValue(["/project-a", "/project-b"]);
    mockReadIssues
      .mockResolvedValueOnce([makeIssue({ id: "A-1", closed_at: "2026-02-15T00:00:00Z" })])
      .mockResolvedValueOnce([makeIssue({ id: "B-1", closed_at: "2026-02-16T00:00:00Z" })]);

    const res = await GET(makeRequest({ since: "2026-02-10T00:00:00Z" }));
    const body = await res.json();
    expect(body.signals).toHaveLength(2);
    expect(mockReadIssues).toHaveBeenCalledTimes(2);
  });

  it("returns 503 when project path not configured", async () => {
    mockGetActiveProjectPath.mockRejectedValue(
      new Error("No repository configured. Set BEADS_PROJECT_PATH or add a repo via Settings."),
    );

    const res = await GET(makeRequest({ since: "2026-02-10T00:00:00Z" }));
    expect(res.status).toBe(503);
  });

  it("returns empty signals when no issues match", async () => {
    mockReadIssues.mockResolvedValue([]);

    const res = await GET(makeRequest({ since: "2026-02-10T00:00:00Z" }));
    const body = await res.json();
    expect(body.signals).toEqual([]);
    expect(body.count).toBe(0);
  });
});
