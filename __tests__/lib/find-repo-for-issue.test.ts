// =============================================================================
// Tests for findRepoForIssue() in src/lib/repo-config.ts
// =============================================================================

import path from "path";
import fs from "fs";
import os from "os";

// Mock mysql2/promise
jest.mock("mysql2/promise");
import * as mysql from "mysql2/promise";
const mockCreateConnection = mysql.createConnection as jest.MockedFunction<typeof mysql.createConnection>;

// Mock the dolt-health TCP probe — factory-core-3p1e.5 added a TCP probe
// before the MySQL handshake. Since these tests use synthetic ports (55001,
// 55002) without real listeners, a real probe would always return
// "connection_refused" and short-circuit the test. Force "reachable" so the
// existing test scenarios continue to exercise the MySQL handshake mocks.
jest.mock("@/lib/dolt-health", () => ({
  probeDolt: jest.fn(async (host: string, port: number) => ({
    host,
    port,
    category: "reachable",
    latencyMs: 0,
  })),
  clearProbeCache: jest.fn(),
}));

import { findRepoForIssue } from "@/lib/repo-config";

// ---------------------------------------------------------------------------
// Test fixtures — temp repos with Dolt port files
// ---------------------------------------------------------------------------

let tmpDir: string;
let repoA: string;
let repoB: string;
let repoNoPort: string;

function createDoltFixture(repoPath: string, port: number, database: string) {
  const beadsDir = path.join(repoPath, ".beads");
  fs.mkdirSync(beadsDir, { recursive: true });
  fs.writeFileSync(path.join(beadsDir, "dolt-server.port"), String(port));
  fs.writeFileSync(
    path.join(beadsDir, "metadata.json"),
    JSON.stringify({ dolt_database: database }),
  );
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "find-repo-test-"));

  repoA = path.join(tmpDir, "repo-a");
  repoB = path.join(tmpDir, "repo-b");
  repoNoPort = path.join(tmpDir, "repo-no-port");

  fs.mkdirSync(repoA, { recursive: true });
  fs.mkdirSync(repoB, { recursive: true });
  fs.mkdirSync(repoNoPort, { recursive: true });

  createDoltFixture(repoA, 55001, "repo_a");
  createDoltFixture(repoB, 55002, "repo_b");
  // repoNoPort intentionally has no .beads/dolt-server.port
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Mock readConfig to return our test repos
// ---------------------------------------------------------------------------

jest.mock("fs", () => {
  const actual = jest.requireActual("fs");
  return {
    ...actual,
    promises: {
      ...actual.promises,
      readFile: jest.fn(),
    },
  };
});

import { promises as fsPromises } from "fs";
const mockReadFile = fsPromises.readFile as jest.MockedFunction<typeof fsPromises.readFile>;

// ---------------------------------------------------------------------------
// Helper: set up mock mysql2 to return results for specific repos
// ---------------------------------------------------------------------------

function setupMockConnections(issueMap: Record<number, string[]>) {
  mockCreateConnection.mockImplementation(async (opts) => {
    const port = (opts as { port: number }).port;
    const mockQuery = jest.fn().mockImplementation(async (_sql: string, params?: unknown[]) => {
      const issueId = params?.[0] as string;
      const issues = issueMap[port] || [];
      if (issues.includes(issueId)) {
        return [[{ "1": 1 }]];
      }
      return [[]];
    });
    return {
      query: mockQuery,
      end: jest.fn(),
    } as unknown as mysql.Connection;
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("findRepoForIssue", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        repos: [
          { name: "repo-a", path: repoA },
          { name: "repo-b", path: repoB },
          { name: "repo-no-port", path: repoNoPort },
        ],
        activeRepo: "__all__",
      }),
    );
    // Default: repo-a has ALPHA issues, repo-b has BETA issues
    setupMockConnections({
      55001: ["ALPHA-001", "ALPHA-002", "ALPHA-003"],
      55002: ["BETA-001", "BETA-002"],
    });
  });

  it("finds an issue in the first repo", async () => {
    const result = await findRepoForIssue("ALPHA-001");
    expect(result).toBe(repoA);
  });

  it("finds an issue in the second repo", async () => {
    const result = await findRepoForIssue("BETA-002");
    expect(result).toBe(repoB);
  });

  it("returns null when issue is not in any repo", async () => {
    const result = await findRepoForIssue("NONEXISTENT-999");
    expect(result).toBeNull();
  });

  it("skips repos without a dolt-server.port file", async () => {
    const result = await findRepoForIssue("BETA-001");
    expect(result).toBe(repoB);
  });

  it("returns null when no repos are configured", async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ repos: [] }));
    const result = await findRepoForIssue("ALPHA-001");
    expect(result).toBeNull();
  });

  it("skips repos where Dolt connection fails", async () => {
    mockCreateConnection.mockImplementation(async (opts) => {
      const port = (opts as { port: number }).port;
      if (port === 55001) throw new Error("ECONNREFUSED");
      const mockQuery = jest.fn().mockResolvedValue([[{ "1": 1 }]]);
      return { query: mockQuery, end: jest.fn() } as unknown as mysql.Connection;
    });

    const result = await findRepoForIssue("BETA-001");
    expect(result).toBe(repoB);
  });

  it("closes connections after each query", async () => {
    const mockEnd = jest.fn();
    mockCreateConnection.mockImplementation(async () => {
      const mockQuery = jest.fn().mockResolvedValue([[]]);
      return { query: mockQuery, end: mockEnd } as unknown as mysql.Connection;
    });

    await findRepoForIssue("NONEXISTENT");
    // Should have connected to repo-a and repo-b (repo-no-port skipped)
    expect(mockEnd).toHaveBeenCalledTimes(2);
  });
});
