// =============================================================================
// Tests for findRepoForIssue() in src/lib/repo-config.ts
// beads_web-ccn: added parallel-walk correctness and performance tests.
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

// ---------------------------------------------------------------------------
// beads_web-ccn: Parallel-walk correctness tests
// AC item 6 — parallel walk returns same result as sequential reference for:
//   (a) bead in repo[0], (b) bead in repo[N-1], (c) bead in no repo,
//   (d) bead in multiple repos (returns first in registry order).
// ---------------------------------------------------------------------------

describe("findRepoForIssue — parallel correctness (beads_web-ccn)", () => {
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
  });

  it("(a) bead exists in repo[0] — returns repo[0]", async () => {
    setupMockConnections({
      55001: ["TARGET-001"],
      55002: [],
    });
    const result = await findRepoForIssue("TARGET-001");
    expect(result).toBe(repoA);
  });

  it("(b) bead exists in repo[N-1] — returns repo[N-1]", async () => {
    setupMockConnections({
      55001: [],
      55002: ["TARGET-002"],
    });
    const result = await findRepoForIssue("TARGET-002");
    expect(result).toBe(repoB);
  });

  it("(c) bead exists in no repo — returns null", async () => {
    setupMockConnections({
      55001: [],
      55002: [],
    });
    const result = await findRepoForIssue("GHOST-999");
    expect(result).toBeNull();
  });

  it("(d) bead exists in multiple repos — returns first in registry order", async () => {
    // Both repos contain the same bead ID (shouldn't happen in practice,
    // but must return deterministic result — first in registry order).
    setupMockConnections({
      55001: ["SHARED-001"],
      55002: ["SHARED-001"],
    });
    const result = await findRepoForIssue("SHARED-001");
    expect(result).toBe(repoA);
  });
});

// ---------------------------------------------------------------------------
// beads_web-ccn: Connection cleanup under parallel fanout
// AC item 7 — per-closure try/finally with conn.end() preserved.
// ---------------------------------------------------------------------------

describe("findRepoForIssue — connection cleanup (beads_web-ccn)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        repos: [
          { name: "repo-a", path: repoA },
          { name: "repo-b", path: repoB },
        ],
        activeRepo: "__all__",
      }),
    );
  });

  it("closes every connection even when one repo throws", async () => {
    const endFns: jest.Mock[] = [];
    mockCreateConnection.mockImplementation(async (opts) => {
      const port = (opts as { port: number }).port;
      const mockEnd = jest.fn();
      endFns.push(mockEnd);
      if (port === 55001) {
        // Simulate a query failure after successful connection
        const mockQuery = jest.fn().mockRejectedValue(new Error("table not found"));
        return { query: mockQuery, end: mockEnd } as unknown as mysql.Connection;
      }
      const mockQuery = jest.fn().mockResolvedValue([[{ "1": 1 }]]);
      return { query: mockQuery, end: mockEnd } as unknown as mysql.Connection;
    });

    const result = await findRepoForIssue("BETA-001");
    expect(result).toBe(repoB);
    // Both connections must have been closed
    expect(endFns).toHaveLength(2);
    for (const endFn of endFns) {
      expect(endFn).toHaveBeenCalledTimes(1);
    }
  });

  it("closes connection even when issue is found (early match)", async () => {
    const endFns: jest.Mock[] = [];
    mockCreateConnection.mockImplementation(async () => {
      const mockEnd = jest.fn();
      endFns.push(mockEnd);
      const mockQuery = jest.fn().mockResolvedValue([[{ "1": 1 }]]);
      return { query: mockQuery, end: mockEnd } as unknown as mysql.Connection;
    });

    await findRepoForIssue("ANY-001");
    // All connections opened in parallel must be closed
    for (const endFn of endFns) {
      expect(endFn).toHaveBeenCalledTimes(1);
    }
  });
});

// ---------------------------------------------------------------------------
// beads_web-ccn: Parallel performance — wall-time comparison
// AC items 3-5 — parallel fanout is faster than sequential for N repos.
// Uses artificial delays to demonstrate parallelism without real I/O.
// ---------------------------------------------------------------------------

describe("findRepoForIssue — parallel performance (beads_web-ccn)", () => {
  // Create a large repo registry (N repos) with artificial delay per probe
  const N = 20;
  const DELAY_MS = 50; // each probe takes 50ms

  let manyRepos: { name: string; path: string }[];

  beforeAll(() => {
    // Create N repo fixtures on disk
    manyRepos = [];
    for (let i = 0; i < N; i++) {
      const repoPath = path.join(tmpDir, `perf-repo-${i}`);
      fs.mkdirSync(repoPath, { recursive: true });
      createDoltFixture(repoPath, 56000 + i, `perf_db_${i}`);
      manyRepos.push({ name: `perf-repo-${i}`, path: repoPath });
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        repos: manyRepos,
        activeRepo: "__all__",
      }),
    );
  });

  it("parallel fanout completes in O(1) wall time, not O(N)", async () => {
    // Each mock connection takes DELAY_MS to resolve.
    // Sequential: N * DELAY_MS = 1000ms.
    // Parallel: ~DELAY_MS = ~50ms.
    mockCreateConnection.mockImplementation(async (opts) => {
      const port = (opts as { port: number }).port;
      await new Promise((r) => setTimeout(r, DELAY_MS));
      const targetPort = 56000 + (N - 1); // issue in last repo
      const mockQuery = jest.fn().mockImplementation(async () => {
        if (port === targetPort) return [[{ "1": 1 }]];
        return [[]];
      });
      return { query: mockQuery, end: jest.fn() } as unknown as mysql.Connection;
    });

    const start = Date.now();
    const result = await findRepoForIssue("PERF-TARGET");
    const elapsed = Date.now() - start;

    // The issue is in the last repo
    expect(result).toBe(manyRepos[N - 1].path);

    // Sequential would take ~N*DELAY_MS = ~1000ms.
    // Parallel should take ~DELAY_MS + overhead = ~100-200ms.
    // We use a generous threshold: must be under N*DELAY_MS/2 = 500ms.
    const sequentialEstimate = N * DELAY_MS;
    expect(elapsed).toBeLessThan(sequentialEstimate / 2);

    // Log for the marker's wall-time delta
    console.log(
      `[beads_web-ccn perf] ${N} repos, ${DELAY_MS}ms/probe: ` +
      `parallel=${elapsed}ms vs sequential-estimate=${sequentialEstimate}ms ` +
      `(${((1 - elapsed / sequentialEstimate) * 100).toFixed(0)}% faster)`,
    );
  });

  it("all-dead case completes quickly when all TCP probes fail", async () => {
    // Override the probeDolt mock to return "connection_refused" for all repos
    const { probeDolt: mockProbeDolt } = require("@/lib/dolt-health");
    (mockProbeDolt as jest.Mock).mockImplementation(async (host: string, port: number) => ({
      host,
      port,
      category: "connection_refused",
      latencyMs: 1,
    }));

    const start = Date.now();
    const result = await findRepoForIssue("DEAD-001");
    const elapsed = Date.now() - start;

    expect(result).toBeNull();
    // All-dead with mocked probes should be near-instant (no MySQL handshakes)
    expect(elapsed).toBeLessThan(200);

    console.log(
      `[beads_web-ccn perf] all-dead ${N} repos: ${elapsed}ms`,
    );
  });
});
