// =============================================================================
// Tests for src/app/api/cross-repo/list/route.ts — GET /api/cross-repo/list
// =============================================================================
// Covers AC items 8a-8d:
//   8a. Label-filter precision (exact match, not substring)
//   8b. Missing-label returns 400
//   8c. Status filter applies correctly (open, closed, all)
//   8d. .repo field populated from project:<repoName> label
// =============================================================================

import { NextRequest } from "next/server";
import type { RobotPlan, PlanIssue, PlanSummary } from "@/lib/types";

// ---------------------------------------------------------------------------
// Mocks — mock getAllProjectsPlan and getAllRepoPaths
// ---------------------------------------------------------------------------

const mockGetAllProjectsPlan = jest.fn<Promise<RobotPlan>, [string[]]>();
const mockGetAllRepoPaths = jest.fn<Promise<string[]>, []>();

jest.mock("@/lib/bv-client", () => ({
  getAllProjectsPlan: (...args: unknown[]) => mockGetAllProjectsPlan(...(args as [string[]])),
}));

jest.mock("@/lib/repo-config", () => ({
  getAllRepoPaths: () => mockGetAllRepoPaths(),
}));

import { GET } from "@/app/api/cross-repo/list/route";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makePlanIssue(overrides: Partial<PlanIssue>): PlanIssue {
  return {
    id: "test-1",
    title: "Test issue",
    status: "open",
    priority: 2,
    issue_type: "task",
    blocked_by: [],
    blocks: [],
    labels: [],
    ...overrides,
  };
}

const EMPTY_SUMMARY: PlanSummary = {
  open_count: 0,
  in_progress_count: 0,
  blocked_count: 0,
  closed_count: 0,
};

/**
 * Build a RobotPlan containing the given issues.
 */
function makePlan(issues: PlanIssue[]): RobotPlan {
  return {
    timestamp: new Date().toISOString(),
    project_path: "__all__",
    summary: EMPTY_SUMMARY,
    tracks: [],
    all_issues: issues,
  };
}

function makeGetRequest(params: Record<string, string>): NextRequest {
  const url = new URL("http://localhost:3000/api/cross-repo/list");
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return new NextRequest(url.toString());
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  mockGetAllRepoPaths.mockResolvedValue(["/repos/alpha", "/repos/beta"]);
});

// ---------------------------------------------------------------------------
// 8b. Missing-label returns 400
// ---------------------------------------------------------------------------

describe("AC 8b: missing label returns 400", () => {
  it("returns 400 when label param is omitted", async () => {
    const req = makeGetRequest({});
    const res = await GET(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/label/i);
  });

  it("returns 400 when label param is empty string", async () => {
    const req = makeGetRequest({ label: "" });
    const res = await GET(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/label/i);
  });

  it("returns 400 when label param is whitespace only", async () => {
    const req = makeGetRequest({ label: "   " });
    const res = await GET(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/label/i);
  });
});

// ---------------------------------------------------------------------------
// 8a. Label-filter precision: exact match, NOT substring
// ---------------------------------------------------------------------------

describe("AC 8a: label-filter precision (exact match, not substring)", () => {
  const issueSo74 = makePlanIssue({
    id: "bead-so74",
    title: "Issue in so74 epic",
    labels: ["epic:factory-core-so74", "project:fleet-core"],
    status: "open",
  });

  const issueSo7 = makePlanIssue({
    id: "bead-so7",
    title: "Issue in so7 epic",
    labels: ["epic:factory-core-so7", "project:fleet-core"],
    status: "open",
  });

  beforeEach(() => {
    mockGetAllProjectsPlan.mockResolvedValue(makePlan([issueSo74, issueSo7]));
  });

  it("returns ONLY the so74 issue when filtering by epic:factory-core-so74", async () => {
    const req = makeGetRequest({ label: "epic:factory-core-so74" });
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.count).toBe(1);
    expect(body.issues).toHaveLength(1);
    expect(body.issues[0].id).toBe("bead-so74");
  });

  it("returns ONLY the so7 issue when filtering by epic:factory-core-so7", async () => {
    const req = makeGetRequest({ label: "epic:factory-core-so7" });
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.count).toBe(1);
    expect(body.issues).toHaveLength(1);
    expect(body.issues[0].id).toBe("bead-so7");
  });

  it("returns no issues when filtering by a label that no issue has", async () => {
    const req = makeGetRequest({ label: "epic:nonexistent" });
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.count).toBe(0);
    expect(body.issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 8c. Status filter applies correctly (open, closed, all)
// ---------------------------------------------------------------------------

describe("AC 8c: status filter applies correctly", () => {
  const openIssue = makePlanIssue({
    id: "open-1",
    title: "Open issue",
    labels: ["epic:test-epic", "project:alpha"],
    status: "open",
  });

  const closedIssue = makePlanIssue({
    id: "closed-1",
    title: "Closed issue",
    labels: ["epic:test-epic", "project:alpha"],
    status: "closed",
  });

  const inProgressIssue = makePlanIssue({
    id: "ip-1",
    title: "In-progress issue",
    labels: ["epic:test-epic", "project:alpha"],
    status: "in_progress",
  });

  beforeEach(() => {
    mockGetAllProjectsPlan.mockResolvedValue(
      makePlan([openIssue, closedIssue, inProgressIssue]),
    );
  });

  it("defaults to status=open, returning only open issues", async () => {
    const req = makeGetRequest({ label: "epic:test-epic" });
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.status).toBe("open");
    expect(body.count).toBe(1);
    expect(body.issues[0].id).toBe("open-1");
  });

  it("status=closed returns only closed issues", async () => {
    const req = makeGetRequest({ label: "epic:test-epic", status: "closed" });
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.status).toBe("closed");
    expect(body.count).toBe(1);
    expect(body.issues[0].id).toBe("closed-1");
  });

  it("status=all returns all matching issues regardless of status", async () => {
    const req = makeGetRequest({ label: "epic:test-epic", status: "all" });
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.status).toBe("all");
    expect(body.count).toBe(3);
    const ids = body.issues.map((i: { id: string }) => i.id).sort();
    expect(ids).toEqual(["closed-1", "ip-1", "open-1"]);
  });
});

// ---------------------------------------------------------------------------
// 8d. .repo field populated from project:<repoName> label
// ---------------------------------------------------------------------------

describe("AC 8d: .repo field populated from project:<repoName> label", () => {
  it("extracts repo name from project: label and promotes to top-level .repo field", async () => {
    const issue = makePlanIssue({
      id: "repo-test-1",
      title: "Issue with project label",
      labels: ["epic:test-epic", "project:factory-core"],
      status: "open",
    });
    mockGetAllProjectsPlan.mockResolvedValue(makePlan([issue]));

    const req = makeGetRequest({ label: "epic:test-epic" });
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.issues[0].repo).toBe("factory-core");
  });

  it("sets .repo to undefined when no project: label exists", async () => {
    const issue = makePlanIssue({
      id: "repo-test-2",
      title: "Issue without project label",
      labels: ["epic:test-epic"],
      status: "open",
    });
    mockGetAllProjectsPlan.mockResolvedValue(makePlan([issue]));

    const req = makeGetRequest({ label: "epic:test-epic" });
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();

    // JSON serialization omits undefined, so repo won't be present
    expect(body.issues[0].repo).toBeUndefined();
  });

  it("handles multiple issues from different repos", async () => {
    const issue1 = makePlanIssue({
      id: "multi-1",
      title: "From fleet-core",
      labels: ["epic:test-epic", "project:fleet-core"],
      status: "open",
    });
    const issue2 = makePlanIssue({
      id: "multi-2",
      title: "From beads_web",
      labels: ["epic:test-epic", "project:beads_web"],
      status: "open",
    });
    mockGetAllProjectsPlan.mockResolvedValue(makePlan([issue1, issue2]));

    const req = makeGetRequest({ label: "epic:test-epic" });
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.count).toBe(2);
    const repos = body.issues.map((i: { repo: string }) => i.repo).sort();
    expect(repos).toEqual(["beads_web", "fleet-core"]);
  });
});

// ---------------------------------------------------------------------------
// Additional: response shape and error handling
// ---------------------------------------------------------------------------

describe("Response shape", () => {
  it("includes label, status, count, and issues fields", async () => {
    mockGetAllProjectsPlan.mockResolvedValue(makePlan([]));

    const req = makeGetRequest({ label: "epic:test" });
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body).toHaveProperty("label", "epic:test");
    expect(body).toHaveProperty("status", "open");
    expect(body).toHaveProperty("count", 0);
    expect(body).toHaveProperty("issues");
    expect(Array.isArray(body.issues)).toBe(true);
  });
});

describe("Error handling", () => {
  it("returns 500 when getAllProjectsPlan throws", async () => {
    mockGetAllProjectsPlan.mockRejectedValue(new Error("Dolt unreachable"));

    const req = makeGetRequest({ label: "epic:test" });
    const res = await GET(req);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/failed/i);
    expect(body.detail).toMatch(/Dolt unreachable/);
  });

  it("returns 400 for invalid status parameter", async () => {
    const req = makeGetRequest({ label: "epic:test", status: "invalid" });
    const res = await GET(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/invalid status/i);
  });
});

// ---------------------------------------------------------------------------
// beads_web-cnr (A.8) — Cross-cutting integration tests
// ---------------------------------------------------------------------------
// These tests exercise A.4's route in combination with A.1-A.3's primitives,
// covering the integration surface between the cross-repo enumeration
// HTTP route and the underlying getAllProjectsPlan + getAllRepoPaths chain.
// ---------------------------------------------------------------------------

describe("A.8 cross-cutting: multi-repo response shape", () => {
  it("issues from different repos have distinct .repo values", async () => {
    const issues = [
      makePlanIssue({
        id: "fleet-1",
        title: "Fleet issue",
        labels: ["epic:test-cross", "project:factory-core"],
        status: "open",
      }),
      makePlanIssue({
        id: "web-1",
        title: "Web issue",
        labels: ["epic:test-cross", "project:beads_web"],
        status: "open",
      }),
      makePlanIssue({
        id: "study-1",
        title: "Study issue",
        labels: ["epic:test-cross", "project:StudyCycle"],
        status: "open",
      }),
    ];
    mockGetAllProjectsPlan.mockResolvedValue(makePlan(issues));

    const req = makeGetRequest({ label: "epic:test-cross" });
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.count).toBe(3);
    const repos = body.issues.map((i: { repo: string }) => i.repo).sort();
    expect(repos).toEqual(["StudyCycle", "beads_web", "factory-core"]);
  });

  it("getAllRepoPaths is called to resolve repo paths for the aggregation", async () => {
    mockGetAllProjectsPlan.mockResolvedValue(makePlan([]));
    mockGetAllRepoPaths.mockResolvedValue([
      "/repos/factory-core",
      "/repos/beads_web",
    ]);

    const req = makeGetRequest({ label: "epic:test" });
    await GET(req);

    // getAllRepoPaths must have been called to get the repo list for
    // getAllProjectsPlan.
    expect(mockGetAllRepoPaths).toHaveBeenCalled();
  });

  it("in_progress issues are excluded by default (status=open filter)", async () => {
    const issues = [
      makePlanIssue({
        id: "open-1",
        labels: ["epic:test-filter", "project:fleet-core"],
        status: "open",
      }),
      makePlanIssue({
        id: "ip-1",
        labels: ["epic:test-filter", "project:fleet-core"],
        status: "in_progress",
      }),
    ];
    mockGetAllProjectsPlan.mockResolvedValue(makePlan(issues));

    const req = makeGetRequest({ label: "epic:test-filter" });
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();

    // Only open issues returned (in_progress excluded by default).
    expect(body.count).toBe(1);
    expect(body.issues[0].id).toBe("open-1");
  });

  it("status=all includes open, in_progress, and closed issues from all repos", async () => {
    const issues = [
      makePlanIssue({
        id: "open-fleet",
        labels: ["epic:test-all", "project:fleet-core"],
        status: "open",
      }),
      makePlanIssue({
        id: "ip-web",
        labels: ["epic:test-all", "project:beads_web"],
        status: "in_progress",
      }),
      makePlanIssue({
        id: "closed-study",
        labels: ["epic:test-all", "project:StudyCycle"],
        status: "closed",
      }),
    ];
    mockGetAllProjectsPlan.mockResolvedValue(makePlan(issues));

    const req = makeGetRequest({ label: "epic:test-all", status: "all" });
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.count).toBe(3);
    const ids = body.issues.map((i: { id: string }) => i.id).sort();
    expect(ids).toEqual(["closed-study", "ip-web", "open-fleet"]);
  });
});
