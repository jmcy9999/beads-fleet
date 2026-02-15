// =============================================================================
// Tests for src/app/api/research/[appName]/route.ts — GET /api/research/[appName]
// =============================================================================

import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock("@/lib/repo-config", () => ({
  getAllRepoPaths: jest.fn(),
}));

jest.mock("fs", () => ({
  promises: {
    readFile: jest.fn(),
  },
}));

import { GET } from "@/app/api/research/[appName]/route";
import { getAllRepoPaths } from "@/lib/repo-config";
import { promises as fs } from "fs";

const mockGetAllRepoPaths = getAllRepoPaths as jest.MockedFunction<
  typeof getAllRepoPaths
>;
const mockReadFile = fs.readFile as jest.MockedFunction<typeof fs.readFile>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(appName: string): [NextRequest, { params: { appName: string } }] {
  const request = new NextRequest(
    `http://localhost:3000/api/research/${appName}`,
  );
  return [request, { params: { appName } }];
}

const TEST_REPOS = ["/home/user/factory-alpha", "/home/user/factory-beta"];

const SAMPLE_REPORT = `# Research Report\n\nThis is a sample research report for testing.`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/research/[appName]", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Validation errors
  // -------------------------------------------------------------------------

  it("returns 400 for invalid app name with spaces", async () => {
    const [request, params] = makeRequest("invalid name");

    const response = await GET(request, params);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain("Invalid app name");
  });

  it("returns 400 for invalid app name with special chars", async () => {
    const [request, params] = makeRequest("app/../etc/passwd");

    const response = await GET(request, params);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain("Invalid app name");
  });

  it("returns 400 for empty app name", async () => {
    const [request, params] = makeRequest("");

    const response = await GET(request, params);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain("Invalid app name");
  });

  // -------------------------------------------------------------------------
  // Not found
  // -------------------------------------------------------------------------

  it("returns 404 when no report found in any repo", async () => {
    mockGetAllRepoPaths.mockResolvedValue(TEST_REPOS);
    mockReadFile.mockRejectedValue(new Error("ENOENT: no such file or directory"));

    const [request, params] = makeRequest("NonExistentApp");

    const response = await GET(request, params);
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toContain("No research report found");
    expect(body.error).toContain("NonExistentApp");
    // Should have tried reading from both repos
    expect(mockReadFile).toHaveBeenCalledTimes(TEST_REPOS.length);
  });

  // -------------------------------------------------------------------------
  // Successful lookups
  // -------------------------------------------------------------------------

  it("returns report content from first matching repo", async () => {
    mockGetAllRepoPaths.mockResolvedValue(TEST_REPOS);
    mockReadFile.mockResolvedValue(SAMPLE_REPORT as never);

    const [request, params] = makeRequest("PatchCycle");

    const response = await GET(request, params);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.content).toBe(SAMPLE_REPORT);
    expect(body.repoPath).toBe(TEST_REPOS[0]);
    // Should stop after first successful read
    expect(mockReadFile).toHaveBeenCalledTimes(1);
    expect(mockReadFile).toHaveBeenCalledWith(
      expect.stringContaining("apps/PatchCycle/research/report.md"),
      "utf-8",
    );
  });

  it("searches multiple repos and returns first match", async () => {
    mockGetAllRepoPaths.mockResolvedValue(TEST_REPOS);
    // First repo: file not found
    mockReadFile.mockRejectedValueOnce(
      new Error("ENOENT: no such file or directory"),
    );
    // Second repo: file found
    mockReadFile.mockResolvedValueOnce(SAMPLE_REPORT as never);

    const [request, params] = makeRequest("LensCycle");

    const response = await GET(request, params);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.content).toBe(SAMPLE_REPORT);
    expect(body.repoPath).toBe(TEST_REPOS[1]);
    expect(mockReadFile).toHaveBeenCalledTimes(2);
    // Verify paths searched in order
    expect(mockReadFile).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("factory-alpha/apps/LensCycle/research/report.md"),
      "utf-8",
    );
    expect(mockReadFile).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("factory-beta/apps/LensCycle/research/report.md"),
      "utf-8",
    );
  });

  // -------------------------------------------------------------------------
  // Server errors
  // -------------------------------------------------------------------------

  it("returns 500 on unexpected error from getAllRepoPaths", async () => {
    mockGetAllRepoPaths.mockRejectedValue(
      new Error("Config file corrupted"),
    );

    const [request, params] = makeRequest("PatchCycle");

    const response = await GET(request, params);
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe("Failed to fetch research report");
    expect(body.detail).toBe("Config file corrupted");
  });
});
