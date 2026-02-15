// =============================================================================
// Tests for src/app/api/issues/[id]/action/route.ts — POST /api/issues/:id/action
// =============================================================================

import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockExecFile = jest.fn();
jest.mock("child_process", () => ({
  execFile: (_cmd: string, _args: string[], _opts: object, cb: Function) =>
    mockExecFile(_cmd, _args, _opts, cb),
}));
jest.mock("util", () => ({
  promisify: () => mockExecFile,
}));

jest.mock("@/lib/repo-config", () => ({
  getActiveProjectPath: jest.fn(),
  findRepoForIssue: jest.fn(),
  ALL_PROJECTS_SENTINEL: "__all__",
}));

jest.mock("@/lib/bv-client", () => ({
  invalidateCache: jest.fn(),
}));

import { POST } from "@/app/api/issues/[id]/action/route";
import { getActiveProjectPath, findRepoForIssue } from "@/lib/repo-config";
import { invalidateCache } from "@/lib/bv-client";

const mockGetActiveProjectPath = getActiveProjectPath as jest.MockedFunction<
  typeof getActiveProjectPath
>;
const mockFindRepoForIssue = findRepoForIssue as jest.MockedFunction<
  typeof findRepoForIssue
>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_PROJECT_PATH = "/tmp/test-project";

function makeRequest(id: string, body: object): NextRequest {
  return new NextRequest(`http://localhost:3000/api/issues/${id}/action`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

function makeParams(id: string): { params: { id: string } } {
  return { params: { id } };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/issues/:id/action", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExecFile.mockResolvedValue({ stdout: "", stderr: "" });
  });

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  it("returns 400 for invalid issue ID", async () => {
    const response = await POST(
      makeRequest("bad id!", { action: "start" }),
      makeParams("bad id!"),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("Invalid issue ID");
  });

  it("returns 400 for invalid action", async () => {
    mockGetActiveProjectPath.mockResolvedValue(TEST_PROJECT_PATH);
    mockFindRepoForIssue.mockResolvedValue(TEST_PROJECT_PATH);

    const response = await POST(
      makeRequest("TEST-001", { action: "destroy" }),
      makeParams("TEST-001"),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("Invalid action");
  });

  it("returns 400 for missing JSON body", async () => {
    const request = new NextRequest(
      "http://localhost:3000/api/issues/TEST-001/action",
      { method: "POST", body: "not json" },
    );
    const response = await POST(request, makeParams("TEST-001"));
    expect(response.status).toBe(400);
  });

  // -------------------------------------------------------------------------
  // Single-project mode
  // -------------------------------------------------------------------------

  it("runs bd update for start action in single-project mode", async () => {
    mockGetActiveProjectPath.mockResolvedValue(TEST_PROJECT_PATH);
    mockFindRepoForIssue.mockResolvedValue(TEST_PROJECT_PATH);

    const response = await POST(
      makeRequest("TEST-001", { action: "start" }),
      makeParams("TEST-001"),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ success: true, action: "start", issueId: "TEST-001" });
    expect(mockExecFile).toHaveBeenCalledWith(
      "bd",
      ["update", "TEST-001", "--status=in_progress"],
      expect.objectContaining({ cwd: TEST_PROJECT_PATH }),
    );
    expect(invalidateCache).toHaveBeenCalled();
  });

  it("runs bd close for close action with reason", async () => {
    mockGetActiveProjectPath.mockResolvedValue(TEST_PROJECT_PATH);
    mockFindRepoForIssue.mockResolvedValue(TEST_PROJECT_PATH);

    const response = await POST(
      makeRequest("TEST-001", { action: "close", reason: "Done" }),
      makeParams("TEST-001"),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.action).toBe("close");
    expect(mockExecFile).toHaveBeenCalledWith(
      "bd",
      ["close", "TEST-001", "--reason", "Done"],
      expect.objectContaining({ cwd: TEST_PROJECT_PATH }),
    );
  });

  it("runs bd update for reopen action", async () => {
    mockGetActiveProjectPath.mockResolvedValue(TEST_PROJECT_PATH);
    mockFindRepoForIssue.mockResolvedValue(TEST_PROJECT_PATH);

    const response = await POST(
      makeRequest("TEST-001", { action: "reopen" }),
      makeParams("TEST-001"),
    );

    expect(response.status).toBe(200);
    expect(mockExecFile).toHaveBeenCalledWith(
      "bd",
      ["update", "TEST-001", "--status=open"],
      expect.objectContaining({ cwd: TEST_PROJECT_PATH }),
    );
  });

  // -------------------------------------------------------------------------
  // __all__ aggregation mode
  // -------------------------------------------------------------------------

  it("resolves repo via findRepoForIssue in __all__ mode", async () => {
    mockGetActiveProjectPath.mockResolvedValue("__all__");
    mockFindRepoForIssue.mockResolvedValue("/tmp/resolved-project");

    const response = await POST(
      makeRequest("PROJ-042", { action: "start" }),
      makeParams("PROJ-042"),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ success: true, action: "start", issueId: "PROJ-042" });
    expect(mockFindRepoForIssue).toHaveBeenCalledWith("PROJ-042");
    expect(mockExecFile).toHaveBeenCalledWith(
      "bd",
      ["update", "PROJ-042", "--status=in_progress"],
      expect.objectContaining({ cwd: "/tmp/resolved-project" }),
    );
  });

  it("returns 404 when issue not found in any repo in __all__ mode", async () => {
    mockGetActiveProjectPath.mockResolvedValue("__all__");
    mockFindRepoForIssue.mockResolvedValue(null);

    const response = await POST(
      makeRequest("GHOST-999", { action: "start" }),
      makeParams("GHOST-999"),
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toContain("GHOST-999");
    expect(body.error).toContain("not found in any configured repo");
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("uses findRepoForIssue as fallback in single-project mode", async () => {
    // Single-project mode but issue is in a different repo
    mockGetActiveProjectPath.mockResolvedValue(TEST_PROJECT_PATH);
    mockFindRepoForIssue.mockResolvedValue("/tmp/other-project");

    const response = await POST(
      makeRequest("OTHER-001", { action: "close" }),
      makeParams("OTHER-001"),
    );

    expect(response.status).toBe(200);
    expect(mockExecFile).toHaveBeenCalledWith(
      "bd",
      ["close", "OTHER-001"],
      expect.objectContaining({ cwd: "/tmp/other-project" }),
    );
  });

  // -------------------------------------------------------------------------
  // Comment action
  // -------------------------------------------------------------------------

  it("runs bd comment for comment action with text", async () => {
    mockGetActiveProjectPath.mockResolvedValue(TEST_PROJECT_PATH);
    mockFindRepoForIssue.mockResolvedValue(TEST_PROJECT_PATH);

    const response = await POST(
      makeRequest("TEST-001", { action: "comment", reason: "Need more competitor analysis" }),
      makeParams("TEST-001"),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ success: true, action: "comment", issueId: "TEST-001" });
    expect(mockExecFile).toHaveBeenCalledWith(
      "bd",
      ["comment", "TEST-001", "Need more competitor analysis"],
      expect.objectContaining({ cwd: TEST_PROJECT_PATH }),
    );
    expect(invalidateCache).toHaveBeenCalled();
  });

  it("returns 400 when comment action has no text", async () => {
    const response = await POST(
      makeRequest("TEST-001", { action: "comment" }),
      makeParams("TEST-001"),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain("Comment text is required");
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("comment action works in __all__ aggregation mode", async () => {
    mockGetActiveProjectPath.mockResolvedValue("__all__");
    mockFindRepoForIssue.mockResolvedValue("/tmp/resolved");

    const response = await POST(
      makeRequest("TEST-001", { action: "comment", reason: "Need more competitor analysis" }),
      makeParams("TEST-001"),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ success: true, action: "comment", issueId: "TEST-001" });
    expect(mockFindRepoForIssue).toHaveBeenCalledWith("TEST-001");
    expect(mockExecFile).toHaveBeenCalledWith(
      "bd",
      ["comment", "TEST-001", "Need more competitor analysis"],
      expect.objectContaining({ cwd: "/tmp/resolved" }),
    );
    expect(invalidateCache).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  it("returns 500 when bd command fails", async () => {
    mockGetActiveProjectPath.mockResolvedValue(TEST_PROJECT_PATH);
    mockFindRepoForIssue.mockResolvedValue(TEST_PROJECT_PATH);
    mockExecFile.mockRejectedValue(new Error("bd: issue not found"));

    const response = await POST(
      makeRequest("TEST-001", { action: "start" }),
      makeParams("TEST-001"),
    );
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toContain("Failed to start issue TEST-001");
  });
});
