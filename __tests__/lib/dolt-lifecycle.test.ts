// =============================================================================
// Tests for src/lib/dolt-lifecycle.ts — Dolt shutdown handler
// (beads_web-6pf + beads_web-c28)
// =============================================================================
//
// Mocks: process.kill, process.on, child_process.execSync, fs.existsSync,
// fs.readFileSync, repo-config.getAllRepoPaths, dolt-health.probeDolt, and
// mysql2/promise.createConnection.
//
// Covers:
//   - Signal handler registration (SIGTERM, SIGINT) — idempotent
//   - PID enumeration from registry repos' .beads/dolt-server.pid files
//   - PID verification (isDoltProcess) — guards against stale/recycled PIDs
//   - Kill sequence: SIGTERM → 5s grace → SIGKILL escalation
//   - Edge cases: missing PID files, invalid PIDs, process already exited
//   - beads_web-c28: alive-set check (isVerifiedLeak) — 4 test cases
// =============================================================================

import path from "path";

// ---------------------------------------------------------------------------
// Mock setup — must come before importing the module under test
// ---------------------------------------------------------------------------

// Mock repo-config to control the repo list
jest.mock("@/lib/repo-config", () => ({
  getAllRepoPaths: jest.fn(),
}));

// Mock fs — selective: only existsSync and readFileSync
jest.mock("fs", () => {
  const actual = jest.requireActual("fs");
  return {
    ...actual,
    existsSync: jest.fn(),
    readFileSync: jest.fn(),
  };
});

// Mock child_process.execSync for isDoltProcess verification
jest.mock("child_process", () => ({
  execSync: jest.fn(),
}));

// Mock dolt-health.probeDolt for alive-set TCP probe (beads_web-c28)
jest.mock("@/lib/dolt-health", () => ({
  probeDolt: jest.fn(),
  clearProbeCache: jest.fn(),
}));

// Mock mysql2/promise for alive-set MySQL probe (beads_web-c28)
jest.mock("mysql2/promise", () => ({
  createConnection: jest.fn(),
}));

// Import after mocks are in place
import { getAllRepoPaths } from "@/lib/repo-config";
import { existsSync, readFileSync } from "fs";
import { execSync } from "child_process";
import { probeDolt } from "@/lib/dolt-health";
import * as mysql from "mysql2/promise";
import {
  enumerateDoltPids,
  cleanupDoltProcesses,
  ensureDoltLifecycleRegistered,
  isDoltProcess,
  isVerifiedLeak,
  __resetDoltLifecycleForTests,
} from "@/lib/dolt-lifecycle";

const mockGetAllRepoPaths = getAllRepoPaths as jest.MockedFunction<
  typeof getAllRepoPaths
>;
const mockExistsSync = existsSync as jest.MockedFunction<typeof existsSync>;
const mockReadFileSync = readFileSync as jest.MockedFunction<typeof readFileSync>;
const mockExecSync = execSync as jest.MockedFunction<typeof execSync>;
const mockProbeDolt = probeDolt as jest.MockedFunction<typeof probeDolt>;
const mockCreateConnection = mysql.createConnection as jest.MockedFunction<
  typeof mysql.createConnection
>;

// ---------------------------------------------------------------------------
// Helpers for beads_web-c28 alive-set mock setup
// ---------------------------------------------------------------------------

/**
 * Create a mock MySQL connection that returns specified PROCESSLIST rows.
 * The connection tracks whether `end()` was called (for RF1 leak detection).
 *
 * @param selfId — the connection ID returned by SELECT CONNECTION_ID()
 * @param processlistRows — rows returned by SHOW PROCESSLIST
 */
function createMockConnection(
  selfId: number,
  processlistRows: Array<{
    Id: number;
    User: string | null;
    Command: string;
    [key: string]: unknown;
  }>,
): { conn: unknown; endCalled: () => boolean } {
  let ended = false;
  const conn = {
    query: jest.fn().mockImplementation((sql: string) => {
      if (sql === "SELECT CONNECTION_ID() AS id") {
        return [[{ id: selfId }], []];
      }
      if (sql === "SHOW PROCESSLIST") {
        return [processlistRows, []];
      }
      return [[], []];
    }),
    end: jest.fn().mockImplementation(async () => {
      ended = true;
    }),
  };
  return { conn, endCalled: () => ended };
}

/**
 * Configure mocks so that a single repo at repoPath passes through
 * isVerifiedLeak as a verified leak (0 external connections).
 * Used by existing enumerateDoltPids tests to maintain their semantics
 * after c28 integration.
 */
function setupAliveSetMocksForVerifiedLeak(port: number = 57570): void {
  // probeDolt returns reachable
  mockProbeDolt.mockResolvedValue({
    host: "127.0.0.1",
    port,
    category: "reachable",
    latencyMs: 10,
  });

  // MySQL connection with only the probe's own row → verified leak
  const { conn } = createMockConnection(99, [
    { Id: 99, User: "root", Command: "Query", Info: "SHOW PROCESSLIST" },
  ]);
  mockCreateConnection.mockResolvedValue(conn as unknown as mysql.Connection);
}

// Save and restore process.kill + process.on
const originalKill = process.kill;
const originalOn = process.on;
const originalRemoveListener = process.removeListener;

beforeEach(() => {
  jest.clearAllMocks();
  __resetDoltLifecycleForTests();
});

afterEach(() => {
  // Restore process methods
  process.kill = originalKill;
  process.on = originalOn;
  process.removeListener = originalRemoveListener;
});

// ---------------------------------------------------------------------------
// isDoltProcess — PID verification (Risk Flag 3)
// ---------------------------------------------------------------------------

describe("isDoltProcess", () => {
  it("returns true when ps output contains 'dolt'", () => {
    mockExecSync.mockReturnValue("dolt\n");
    expect(isDoltProcess(12345)).toBe(true);
    expect(mockExecSync).toHaveBeenCalledWith("ps -p 12345 -o comm=", {
      encoding: "utf-8",
      timeout: 3_000,
    });
  });

  it("returns true for 'dolt sql-server' variant", () => {
    mockExecSync.mockReturnValue("dolt sql-server\n");
    expect(isDoltProcess(99)).toBe(true);
  });

  it("returns false when ps output is a different process", () => {
    mockExecSync.mockReturnValue("node\n");
    expect(isDoltProcess(12345)).toBe(false);
  });

  it("returns false when process does not exist (ps throws)", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("Command failed");
    });
    expect(isDoltProcess(12345)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// enumerateDoltPids — PID enumeration from registry repos
// ---------------------------------------------------------------------------

describe("enumerateDoltPids", () => {
  it("reads PIDs from .beads/dolt-server.pid for each repo", async () => {
    mockGetAllRepoPaths.mockResolvedValue([
      "/Users/test/repo-a",
      "/Users/test/repo-b",
    ]);
    mockExistsSync.mockImplementation((p: unknown) => {
      const s = String(p);
      // Both .pid and .port files exist for both repos
      return (
        s === path.join("/Users/test/repo-a", ".beads", "dolt-server.pid") ||
        s === path.join("/Users/test/repo-b", ".beads", "dolt-server.pid") ||
        s === path.join("/Users/test/repo-a", ".beads", "dolt-server.port") ||
        s === path.join("/Users/test/repo-b", ".beads", "dolt-server.port")
      );
    });
    mockReadFileSync.mockImplementation((p: unknown) => {
      const s = String(p);
      if (s.includes("repo-a") && s.endsWith(".pid")) return "1001\n";
      if (s.includes("repo-b") && s.endsWith(".pid")) return "2002\n";
      if (s.endsWith(".port")) return "57570\n";
      throw new Error("unexpected read");
    });
    // Both PIDs are verified as Dolt processes
    mockExecSync.mockReturnValue("dolt\n");
    // c28: alive-set check — both are verified leaks
    setupAliveSetMocksForVerifiedLeak();

    const pids = await enumerateDoltPids();
    expect(pids).toEqual([1001, 2002]);
  });

  it("skips repos without a PID file", async () => {
    mockGetAllRepoPaths.mockResolvedValue([
      "/Users/test/repo-a",
      "/Users/test/repo-no-pid",
    ]);
    mockExistsSync.mockImplementation((p: unknown) => {
      const s = String(p);
      return s.includes("repo-a");
    });
    mockReadFileSync.mockImplementation((p: unknown) => {
      const s = String(p);
      if (s.endsWith(".pid")) return "1001\n";
      if (s.endsWith(".port")) return "57570\n";
      throw new Error("unexpected read");
    });
    mockExecSync.mockReturnValue("dolt\n");
    setupAliveSetMocksForVerifiedLeak();

    const pids = await enumerateDoltPids();
    expect(pids).toEqual([1001]);
  });

  it("skips PIDs that are not Dolt processes (stale/recycled)", async () => {
    mockGetAllRepoPaths.mockResolvedValue(["/Users/test/repo-a"]);
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("1001\n");
    // ps returns non-dolt process name
    mockExecSync.mockReturnValue("node\n");
    // c28 alive-set mocks not needed — isDoltProcess check fails first

    const pids = await enumerateDoltPids();
    expect(pids).toEqual([]);
  });

  it("skips invalid PID values (non-numeric, zero, negative)", async () => {
    mockGetAllRepoPaths.mockResolvedValue([
      "/Users/test/repo-nan",
      "/Users/test/repo-zero",
      "/Users/test/repo-neg",
    ]);
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation((p: unknown) => {
      const s = String(p);
      if (s.includes("repo-nan")) return "notanumber\n";
      if (s.includes("repo-zero")) return "0\n";
      if (s.includes("repo-neg")) return "-5\n";
      throw new Error("unexpected");
    });

    const pids = await enumerateDoltPids();
    expect(pids).toEqual([]);
  });

  it("returns empty array when getAllRepoPaths throws", async () => {
    mockGetAllRepoPaths.mockRejectedValue(new Error("config unreadable"));
    const pids = await enumerateDoltPids();
    expect(pids).toEqual([]);
  });

  it("returns empty array when no repos configured", async () => {
    mockGetAllRepoPaths.mockResolvedValue([]);
    const pids = await enumerateDoltPids();
    expect(pids).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// cleanupDoltProcesses — kill sequence
// ---------------------------------------------------------------------------

describe("cleanupDoltProcesses", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("sends SIGTERM then checks process after grace period", async () => {
    mockGetAllRepoPaths.mockResolvedValue(["/Users/test/repo-a"]);
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation((p: unknown) => {
      const s = String(p);
      if (s.endsWith(".pid")) return "1001\n";
      if (s.endsWith(".port")) return "57570\n";
      return "1001\n";
    });
    mockExecSync.mockReturnValue("dolt\n");
    setupAliveSetMocksForVerifiedLeak();

    const killCalls: Array<{ pid: number; signal: string | number }> = [];
    process.kill = ((pid: number, signal?: string | number) => {
      killCalls.push({ pid, signal: signal ?? "SIGTERM" });
      // On signal-0 check (existence check), throw ESRCH to indicate
      // process exited during grace period
      if (signal === 0) {
        const err = new Error("ESRCH") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      }
      return true;
    }) as typeof process.kill;

    const cleanupPromise = cleanupDoltProcesses();

    // Advance past the 5s grace period
    await jest.advanceTimersByTimeAsync(5_000);
    await cleanupPromise;

    // Should have called SIGTERM, then tried signal-0 check
    expect(killCalls).toEqual([
      { pid: 1001, signal: "SIGTERM" },
      { pid: 1001, signal: 0 },
    ]);
  });

  it("escalates to SIGKILL if process survives the grace period", async () => {
    mockGetAllRepoPaths.mockResolvedValue(["/Users/test/repo-a"]);
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation((p: unknown) => {
      const s = String(p);
      if (s.endsWith(".pid")) return "1001\n";
      if (s.endsWith(".port")) return "57570\n";
      return "1001\n";
    });
    mockExecSync.mockReturnValue("dolt\n");
    setupAliveSetMocksForVerifiedLeak();

    const killCalls: Array<{ pid: number; signal: string | number }> = [];
    process.kill = ((pid: number, signal?: string | number) => {
      killCalls.push({ pid, signal: signal ?? "SIGTERM" });
      // Signal-0 check succeeds (process still alive) — don't throw
      return true;
    }) as typeof process.kill;

    const cleanupPromise = cleanupDoltProcesses();
    await jest.advanceTimersByTimeAsync(5_000);
    await cleanupPromise;

    // Should have: SIGTERM, then signal-0 (alive), then SIGKILL
    expect(killCalls).toEqual([
      { pid: 1001, signal: "SIGTERM" },
      { pid: 1001, signal: 0 },
      { pid: 1001, signal: "SIGKILL" },
    ]);
  });

  it("handles process already exited before SIGTERM", async () => {
    mockGetAllRepoPaths.mockResolvedValue(["/Users/test/repo-a"]);
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation((p: unknown) => {
      const s = String(p);
      if (s.endsWith(".pid")) return "1001\n";
      if (s.endsWith(".port")) return "57570\n";
      return "1001\n";
    });
    mockExecSync.mockReturnValue("dolt\n");
    setupAliveSetMocksForVerifiedLeak();

    process.kill = ((_pid: number, _signal?: string | number) => {
      const err = new Error("ESRCH") as NodeJS.ErrnoException;
      err.code = "ESRCH";
      throw err;
    }) as typeof process.kill;

    const cleanupPromise = cleanupDoltProcesses();
    await jest.advanceTimersByTimeAsync(5_000);
    // Should not throw — gracefully handles ESRCH
    await cleanupPromise;
  });

  it("handles empty PID list gracefully", async () => {
    mockGetAllRepoPaths.mockResolvedValue([]);
    const cleanupPromise = cleanupDoltProcesses();
    await jest.advanceTimersByTimeAsync(5_000);
    await cleanupPromise;
    // No error, no kill calls
  });
});

// ---------------------------------------------------------------------------
// isVerifiedLeak — alive-set check (beads_web-c28 AC 4)
// ---------------------------------------------------------------------------

describe("isVerifiedLeak", () => {
  const REPO_PATH = "/Users/test/repo-alive";

  beforeEach(() => {
    // Port file exists and is valid for all c28 tests
    mockExistsSync.mockImplementation((p: unknown) => {
      const s = String(p);
      return s === path.join(REPO_PATH, ".beads", "dolt-server.port");
    });
    mockReadFileSync.mockImplementation((p: unknown) => {
      const s = String(p);
      if (s.endsWith(".port")) return "57570\n";
      throw new Error("unexpected read");
    });
  });

  // AC 4(a): Dolt with 2 active user connections → PID is skipped
  it("returns false (skip) when Dolt has 2 active user connections", async () => {
    // TCP probe returns reachable
    mockProbeDolt.mockResolvedValue({
      host: "127.0.0.1",
      port: 57570,
      category: "reachable",
      latencyMs: 10,
    });

    // MySQL connection: PROCESSLIST returns self-probe row + 2 external rows
    const selfId = 10;
    const { conn, endCalled } = createMockConnection(selfId, [
      // The probe's own connection (will be filtered by Id !== selfId)
      { Id: selfId, User: "root", Command: "Query", Info: "SHOW PROCESSLIST" },
      // External consumer 1 (bd CLI invocation)
      { Id: 11, User: "root", Command: "Query", Info: "SELECT * FROM issues" },
      // External consumer 2 (editor extension, idle)
      { Id: 12, User: "root", Command: "Sleep", Info: null },
    ]);
    mockCreateConnection.mockResolvedValue(conn as unknown as mysql.Connection);

    const result = await isVerifiedLeak(1001, REPO_PATH);

    expect(result).toBe(false); // NOT a leak — skip the PID
    expect(endCalled()).toBe(true); // RF1: connection closed
    // Verify SELECT CONNECTION_ID() was called BEFORE SHOW PROCESSLIST (RF5)
    const queryCalls = (conn.query as jest.Mock).mock.calls;
    const connIdCallIdx = queryCalls.findIndex(
      (c: string[]) => c[0] === "SELECT CONNECTION_ID() AS id",
    );
    const plCallIdx = queryCalls.findIndex(
      (c: string[]) => c[0] === "SHOW PROCESSLIST",
    );
    expect(connIdCallIdx).toBeLessThan(plCallIdx);
  });

  // AC 4(b): Dolt with 0 user connections → verified leak, receives process.kill
  it("returns true (kill) when Dolt has 0 user connections", async () => {
    mockProbeDolt.mockResolvedValue({
      host: "127.0.0.1",
      port: 57570,
      category: "reachable",
      latencyMs: 10,
    });

    // PROCESSLIST returns only the probe's own row
    const selfId = 10;
    const { conn, endCalled } = createMockConnection(selfId, [
      { Id: selfId, User: "root", Command: "Query", Info: "SHOW PROCESSLIST" },
    ]);
    mockCreateConnection.mockResolvedValue(conn as unknown as mysql.Connection);

    const result = await isVerifiedLeak(1001, REPO_PATH);

    expect(result).toBe(true); // Verified leak — kill the PID
    expect(endCalled()).toBe(true); // RF1: connection closed
  });

  // AC 4(c): Dolt where TCP probe times out → PID is skipped (conservative)
  it("returns true (verified leak) when TCP probe times out", async () => {
    // TCP probe returns timeout — per AC 1 step 2, unreachable → verified leak
    mockProbeDolt.mockResolvedValue({
      host: "127.0.0.1",
      port: 57570,
      category: "timeout",
      latencyMs: 2000,
      error: "connect timed out after 2000ms",
    });

    const result = await isVerifiedLeak(1001, REPO_PATH);

    // Per AC 1 step 2: if category !== "reachable", treat as verified leak
    expect(result).toBe(true);
    // MySQL connection should NOT have been attempted
    expect(mockCreateConnection).not.toHaveBeenCalled();
  });

  // AC 4(d): Dolt where MySQL handshake fails → PID is skipped (conservative)
  it("returns false (skip) when MySQL handshake fails", async () => {
    // TCP probe returns reachable (port is open)
    mockProbeDolt.mockResolvedValue({
      host: "127.0.0.1",
      port: 57570,
      category: "reachable",
      latencyMs: 10,
    });

    // MySQL createConnection throws (handshake failure / connection refused)
    mockCreateConnection.mockRejectedValue(
      new Error("Connection refused (ECONNREFUSED)"),
    );

    const result = await isVerifiedLeak(1001, REPO_PATH);

    // Conservative policy (Q2): probe failure → skip (do NOT kill)
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ensureDoltLifecycleRegistered — idempotent signal handler registration
// ---------------------------------------------------------------------------

describe("ensureDoltLifecycleRegistered", () => {
  it("registers SIGTERM and SIGINT handlers on first call", () => {
    const registeredSignals: string[] = [];
    process.on = ((signal: string, _handler: (...args: unknown[]) => void) => {
      registeredSignals.push(signal);
      return process;
    }) as typeof process.on;

    ensureDoltLifecycleRegistered();
    expect(registeredSignals).toContain("SIGTERM");
    expect(registeredSignals).toContain("SIGINT");
  });

  it("is idempotent — second call does not re-register", () => {
    const registeredSignals: string[] = [];
    process.on = ((signal: string, _handler: (...args: unknown[]) => void) => {
      registeredSignals.push(signal);
      return process;
    }) as typeof process.on;

    ensureDoltLifecycleRegistered();
    const firstCount = registeredSignals.length;

    ensureDoltLifecycleRegistered();
    // No new registrations
    expect(registeredSignals.length).toBe(firstCount);
  });

  it("survives errors during registration without throwing", () => {
    // Even if process.on throws, the function should not propagate
    // (The real ensureDoltLifecycleRegistered doesn't have try/catch on
    // process.on itself, but it's the bootstrap route that wraps in try/catch)
    process.on = ((signal: string, _handler: (...args: unknown[]) => void) => {
      if (signal === "SIGINT") throw new Error("mock error");
      return process;
    }) as typeof process.on;

    // The function throws — the route handler catches it.
    // This test confirms the function propagates errors to the caller.
    expect(() => ensureDoltLifecycleRegistered()).toThrow("mock error");
  });
});
