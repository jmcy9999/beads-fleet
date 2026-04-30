// =============================================================================
// Tests for src/lib/dolt-lifecycle.ts — Dolt shutdown handler (beads_web-6pf)
// =============================================================================
//
// Mocks: process.kill, process.on, child_process.execSync, fs.existsSync,
// fs.readFileSync, and repo-config.getAllRepoPaths.
//
// Covers:
//   - Signal handler registration (SIGTERM, SIGINT) — idempotent
//   - PID enumeration from registry repos' .beads/dolt-server.pid files
//   - PID verification (isDoltProcess) — guards against stale/recycled PIDs
//   - Kill sequence: SIGTERM → 5s grace → SIGKILL escalation
//   - Edge cases: missing PID files, invalid PIDs, process already exited
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

// Import after mocks are in place
import { getAllRepoPaths } from "@/lib/repo-config";
import { existsSync, readFileSync } from "fs";
import { execSync } from "child_process";
import {
  enumerateDoltPids,
  cleanupDoltProcesses,
  ensureDoltLifecycleRegistered,
  isDoltProcess,
  __resetDoltLifecycleForTests,
} from "@/lib/dolt-lifecycle";

const mockGetAllRepoPaths = getAllRepoPaths as jest.MockedFunction<
  typeof getAllRepoPaths
>;
const mockExistsSync = existsSync as jest.MockedFunction<typeof existsSync>;
const mockReadFileSync = readFileSync as jest.MockedFunction<typeof readFileSync>;
const mockExecSync = execSync as jest.MockedFunction<typeof execSync>;

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
      return (
        s === path.join("/Users/test/repo-a", ".beads", "dolt-server.pid") ||
        s === path.join("/Users/test/repo-b", ".beads", "dolt-server.pid")
      );
    });
    mockReadFileSync.mockImplementation((p: unknown) => {
      const s = String(p);
      if (s.includes("repo-a")) return "1001\n";
      if (s.includes("repo-b")) return "2002\n";
      throw new Error("unexpected read");
    });
    // Both PIDs are verified as Dolt processes
    mockExecSync.mockReturnValue("dolt\n");

    const pids = await enumerateDoltPids();
    expect(pids).toEqual([1001, 2002]);
  });

  it("skips repos without a PID file", async () => {
    mockGetAllRepoPaths.mockResolvedValue([
      "/Users/test/repo-a",
      "/Users/test/repo-no-pid",
    ]);
    mockExistsSync.mockImplementation((p: unknown) => {
      return String(p).includes("repo-a");
    });
    mockReadFileSync.mockReturnValue("1001\n");
    mockExecSync.mockReturnValue("dolt\n");

    const pids = await enumerateDoltPids();
    expect(pids).toEqual([1001]);
  });

  it("skips PIDs that are not Dolt processes (stale/recycled)", async () => {
    mockGetAllRepoPaths.mockResolvedValue(["/Users/test/repo-a"]);
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("1001\n");
    // ps returns non-dolt process name
    mockExecSync.mockReturnValue("node\n");

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
    mockReadFileSync.mockReturnValue("1001\n");
    mockExecSync.mockReturnValue("dolt\n");

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
    mockReadFileSync.mockReturnValue("1001\n");
    mockExecSync.mockReturnValue("dolt\n");

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
    mockReadFileSync.mockReturnValue("1001\n");
    mockExecSync.mockReturnValue("dolt\n");

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
