import { NextRequest } from "next/server";
import type { PlanIssue, RobotPlan } from "@/lib/types";

const mockGetAllRepoPaths = jest.fn<Promise<string[]>, []>();
const mockGetPortfolioReadSnapshot = jest.fn();

jest.mock("@/lib/repo-config", () => ({
  getAllRepoPaths: () => mockGetAllRepoPaths(),
}));

jest.mock("@/lib/read-model-snapshot", () => ({
  getPortfolioReadSnapshot: (...args: unknown[]) =>
    mockGetPortfolioReadSnapshot(...args),
}));

import { GET } from "@/app/api/fleet/wave-status/route";

function planIssue(overrides: Partial<PlanIssue>): PlanIssue {
  return {
    id: "issue-1",
    title: "Issue",
    status: "open",
    priority: 2,
    issue_type: "task",
    blocked_by: [],
    blocks: [],
    labels: [],
    ...overrides,
  };
}

function plan(issues: PlanIssue[]): RobotPlan {
  return {
    timestamp: "2026-01-01T00:00:00Z",
    project_path: "__all__",
    summary: {
      open_count: 0,
      in_progress_count: 0,
      blocked_count: 0,
      closed_count: 0,
    },
    tracks: [],
    all_issues: issues,
    offline_repos: [],
  };
}

function request(params: Record<string, string> = {}): NextRequest {
  const url = new URL("http://localhost:3000/api/fleet/wave-status");
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return new NextRequest(url);
}

describe("GET /api/fleet/wave-status", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAllRepoPaths.mockResolvedValue(["/repo-a", "/repo-b"]);
  });

  it("returns 400 when epicId is missing", async () => {
    const res = await GET(request());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("epicId");
  });

  it("returns child counts and wave progress from the portfolio snapshot", async () => {
    mockGetPortfolioReadSnapshot.mockResolvedValue({
      plan: plan([
        planIssue({
          id: "child-open",
          labels: ["epic:epic-1", "wave:1"],
          status: "open",
        }),
        planIssue({
          id: "child-closed",
          epic: "epic-1",
          labels: ["wave:1"],
          status: "closed",
        }),
        planIssue({
          id: "child-progress",
          labels: ["epic:epic-1", "wave:2"],
          status: "in_progress",
        }),
        planIssue({
          id: "other",
          labels: ["epic:other", "wave:1"],
          status: "blocked",
        }),
      ]),
    });

    const res = await GET(request({ epicId: "epic-1" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mockGetPortfolioReadSnapshot).toHaveBeenCalledWith([
      "/repo-a",
      "/repo-b",
    ]);
    expect(body.children).toEqual({
      total: 3,
      closed: 1,
      inProgress: 1,
      blocked: 0,
    });
    expect(body.waveProgress).toEqual([
      { wave: 1, total: 2, closed: 1 },
      { wave: 2, total: 1, closed: 0 },
    ]);
  });
});
