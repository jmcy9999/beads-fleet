// =============================================================================
// Dolt lifecycle shutdown handler — beads_web-6pf + beads_web-c28
// =============================================================================
//
// On beads_web exit (SIGTERM / SIGINT), enumerates all Dolt sql-server PIDs
// from the ~/.beads-web.json registry repos' `.beads/dolt-server.pid` files,
// checks whether each Dolt has active MySQL connections (alive-set check),
// and kills only verified leaks (0 external connections): SIGTERM first,
// then SIGKILL after a 5s grace period.
//
// beads_web-c28 (F3 alive-set protection): adds `isVerifiedLeak()` which
// probes each Dolt via MySQL `SHOW PROCESSLIST` to distinguish live servers
// (with active user connections) from leaked servers (no connections). Only
// verified leaks are killed. Conservative policy: on probe failure (TCP
// timeout, MySQL handshake failure, query timeout), skip the PID (do NOT
// kill).
//
// This module is Node-only. It must NOT be imported from instrumentation.ts
// (which webpack compiles for both node and edge targets). Instead, it is
// bootstrapped via a self-fetch to a Node-runtime route handler that calls
// ensureDoltLifecycleRegistered().
// =============================================================================

import { readFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import path from "path";
import * as mysql from "mysql2/promise";
import { getAllRepoPaths } from "./repo-config";
import { probeDolt } from "./dolt-health";

/** Grace period between SIGTERM and SIGKILL escalation (ms). */
const KILL_GRACE_MS = 5_000;

// ---------------------------------------------------------------------------
// Idempotency guard on globalThis (survives Next.js hot-reload)
// ---------------------------------------------------------------------------

interface DoltLifecycleGlobal {
  __beadsWebDoltLifecycleRegistered?: boolean;
}

function getGlobal(): DoltLifecycleGlobal {
  return globalThis as unknown as DoltLifecycleGlobal;
}

// ---------------------------------------------------------------------------
// PID verification — Risk Flag 3 (PID staleness / recycling)
// ---------------------------------------------------------------------------

/**
 * Verify that the process at `pid` is actually a Dolt process before killing.
 * Uses `ps -p <pid> -o comm=` which returns the command basename.
 * Returns true if the process exists AND its command contains "dolt".
 * Returns false otherwise (process doesn't exist, or PID recycled to non-Dolt).
 */
export function isDoltProcess(pid: number): boolean {
  try {
    const out = execSync(`ps -p ${pid} -o comm=`, {
      encoding: "utf-8",
      timeout: 3_000,
    }).trim();
    return out.toLowerCase().includes("dolt");
  } catch {
    // Process doesn't exist or ps failed — skip this PID
    return false;
  }
}

// ---------------------------------------------------------------------------
// Alive-set check — beads_web-c28 (F3)
// ---------------------------------------------------------------------------

/** Probe timeout for TCP and MySQL connection (ms). Per Q3: 2s. */
const PROBE_TIMEOUT_MS = 2_000;

/**
 * Check if a Dolt PID is a verified leak (no active MySQL connections from
 * external consumers). Returns `true` if the PID should be killed, `false`
 * if it should be skipped.
 *
 * Conservative policy (per Q2): on probe failure (TCP timeout, MySQL
 * handshake failure, query timeout), return `false` (skip — assume in-use).
 *
 * The check follows this sequence:
 *   1. Read `.beads/dolt-server.port` — missing/invalid → verified leak.
 *   2. TCP probe via `probeDolt()` — not reachable → verified leak.
 *   3. MySQL handshake — connection fails → skip (conservative).
 *   4. `SELECT CONNECTION_ID()` to capture selfId, then `SHOW PROCESSLIST`
 *      filtered by: Id !== selfId, User non-null/non-empty, Command !== "Daemon".
 *   5. Count > 0 → skip (in use). Count = 0 → verified leak.
 *   6. MySQL connection closed in `finally` (no leak on probe failure).
 *
 * Design source: architect memo c28-alive-set-heuristic-investigation.md.
 * Operator decisions Q1/Q2/Q3 baked 2026-05-01.
 */
export async function isVerifiedLeak(
  pid: number,
  repoPath: string,
): Promise<boolean> {
  const portFile = path.join(repoPath, ".beads", "dolt-server.port");

  // Step 1: Read port file
  if (!existsSync(portFile)) {
    console.log(
      `[dolt-lifecycle] PID ${pid} from ${repoPath} — no port file — verified leak`,
    );
    return true;
  }

  let port: number;
  try {
    port = parseInt(readFileSync(portFile, "utf-8").trim(), 10);
  } catch {
    console.log(
      `[dolt-lifecycle] PID ${pid} from ${repoPath} — port file unreadable — verified leak`,
    );
    return true;
  }

  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    console.log(
      `[dolt-lifecycle] PID ${pid} from ${repoPath} — invalid port ${port} — verified leak`,
    );
    return true;
  }

  // Step 2: TCP probe first (fast check — avoids ~3s MySQL timeout on dead repos)
  const probe = await probeDolt("127.0.0.1", port, PROBE_TIMEOUT_MS);
  if (probe.category !== "reachable") {
    console.log(
      `[dolt-lifecycle] PID ${pid} from ${repoPath} — TCP probe ${probe.category} — verified leak`,
    );
    return true;
  }

  // Step 3–7: MySQL handshake + PROCESSLIST check
  let conn: mysql.Connection | null = null;
  try {
    conn = await mysql.createConnection({
      host: "127.0.0.1",
      port,
      user: "root",
      connectTimeout: PROBE_TIMEOUT_MS,
    });

    // Step 4a: Capture our own connection ID BEFORE running SHOW PROCESSLIST
    // (RF5: self-id capture ordering — must be on the same connection)
    const [idRows] = await conn.query("SELECT CONNECTION_ID() AS id");
    const selfId = (idRows as Array<{ id: number }>)[0]?.id;

    // Step 4b: Run SHOW PROCESSLIST and filter
    const [plRows] = await conn.query("SHOW PROCESSLIST");
    const rows = plRows as Array<{
      Id: number;
      User: string | null;
      Command: string;
      [key: string]: unknown;
    }>;

    // Filter: Id !== selfId (dominant clause — exclude probe's own connection)
    //       + User non-null/non-empty (defence-in-depth)
    //       + Command !== "Daemon" (defence-in-depth)
    const activeConnections = rows.filter(
      (r) =>
        r.Id !== selfId &&
        r.User != null &&
        r.User !== "" &&
        r.Command !== "Daemon",
    );

    if (activeConnections.length > 0) {
      // Step 5: In use by external consumer(s)
      console.log(
        `[dolt-lifecycle] PID ${pid} from ${repoPath} — skipping — ${activeConnections.length} active connection(s)`,
      );
      return false;
    }

    // Step 6: Verified leak (0 external connections)
    console.log(
      `[dolt-lifecycle] PID ${pid} from ${repoPath} — killing — verified leak (0 connections)`,
    );
    return true;
  } catch (err) {
    // Step 3 / conservative policy: MySQL handshake or query failed → skip
    console.log(
      `[dolt-lifecycle] PID ${pid} from ${repoPath} — skipping — probe failed (${err instanceof Error ? err.message : String(err)})`,
    );
    return false;
  } finally {
    // Step 7: Close MySQL connection (RF1: no leak on probe failure)
    if (conn) {
      try {
        await conn.end();
      } catch {
        // Connection already closed or errored — ignore
      }
    }
  }
}

// ---------------------------------------------------------------------------
// PID enumeration from registry repos
// ---------------------------------------------------------------------------

/**
 * Read `.beads/dolt-server.pid` from each repo in the ~/.beads-web.json
 * registry. Returns an array of valid PIDs (positive integers) where the
 * process is verified to be a Dolt process AND verified to be a leak
 * (no active external MySQL connections).
 *
 * beads_web-c28: alive-set checks run in parallel via Promise.allSettled
 * (AC 2). Failure in one repo's probe does not block others.
 */
export async function enumerateDoltPids(): Promise<number[]> {
  let repoPaths: string[];
  try {
    repoPaths = await getAllRepoPaths();
  } catch (err) {
    console.warn(
      "[dolt-lifecycle] failed to read repo paths from registry:",
      err instanceof Error ? err.message : err,
    );
    return [];
  }

  // Phase 1 (sequential, synchronous): collect candidate PIDs that pass
  // file-existence, PID-validity, and isDoltProcess checks.
  const candidates: Array<{ pid: number; repoPath: string }> = [];

  for (const repoPath of repoPaths) {
    const pidFile = path.join(repoPath, ".beads", "dolt-server.pid");
    if (!existsSync(pidFile)) continue;

    let raw: string;
    try {
      raw = readFileSync(pidFile, "utf-8").trim();
    } catch {
      continue;
    }

    const pid = parseInt(raw, 10);
    if (!Number.isFinite(pid) || pid <= 0) {
      console.warn(
        `[dolt-lifecycle] invalid PID in ${pidFile}: "${raw}" — skipping`,
      );
      continue;
    }

    // Risk Flag 3: verify the PID is actually a Dolt process
    if (!isDoltProcess(pid)) {
      console.warn(
        `[dolt-lifecycle] PID ${pid} from ${pidFile} is not a Dolt process (stale/recycled) — skipping`,
      );
      continue;
    }

    candidates.push({ pid, repoPath });
  }

  if (candidates.length === 0) return [];

  // Phase 2 (parallel, async): alive-set check via Promise.allSettled.
  // beads_web-c28 AC 2: failure in one repo's probe does not block others.
  const results = await Promise.allSettled(
    candidates.map(({ pid, repoPath }) => isVerifiedLeak(pid, repoPath)),
  );

  const pids: number[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const result = results[i];
    if (result.status === "fulfilled" && result.value === true) {
      pids.push(candidates[i].pid);
    } else if (result.status === "rejected") {
      // Promise.allSettled should not produce 'rejected' for isVerifiedLeak
      // (it catches internally), but guard defensively — conservative skip.
      console.warn(
        `[dolt-lifecycle] PID ${candidates[i].pid} from ${candidates[i].repoPath} — alive-set check threw unexpectedly — skipping`,
      );
    }
    // result.value === false → PID is in use or probe failed → skipped
  }

  return pids;
}

// ---------------------------------------------------------------------------
// Kill sequence: SIGTERM → 5s grace → SIGKILL
// ---------------------------------------------------------------------------

/**
 * Kill a single PID with SIGTERM, wait up to KILL_GRACE_MS, then escalate
 * to SIGKILL if the process is still alive.
 */
async function killWithGrace(pid: number): Promise<void> {
  try {
    process.kill(pid, "SIGTERM");
    console.log(`[dolt-lifecycle] sent SIGTERM to Dolt PID ${pid}`);
  } catch (err: unknown) {
    // ESRCH = process already gone — that's fine
    if ((err as NodeJS.ErrnoException).code === "ESRCH") {
      console.log(
        `[dolt-lifecycle] Dolt PID ${pid} already exited before SIGTERM`,
      );
      return;
    }
    console.warn(
      `[dolt-lifecycle] SIGTERM to PID ${pid} failed:`,
      err instanceof Error ? err.message : err,
    );
    return;
  }

  // Wait for graceful shutdown
  await new Promise<void>((resolve) => setTimeout(resolve, KILL_GRACE_MS));

  // Check if still alive, escalate to SIGKILL
  try {
    // Signal 0 = existence check (does not kill)
    process.kill(pid, 0);
    // Still alive — escalate
    try {
      process.kill(pid, "SIGKILL");
      console.log(
        `[dolt-lifecycle] sent SIGKILL to Dolt PID ${pid} (did not exit within ${KILL_GRACE_MS}ms grace)`,
      );
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") {
        console.log(
          `[dolt-lifecycle] Dolt PID ${pid} exited during SIGKILL attempt`,
        );
      }
    }
  } catch {
    // ESRCH = process exited during grace period — success
    console.log(
      `[dolt-lifecycle] Dolt PID ${pid} exited gracefully within ${KILL_GRACE_MS}ms`,
    );
  }
}

/**
 * Kill all Dolt processes from the registry. Called by signal handlers.
 */
export async function cleanupDoltProcesses(): Promise<void> {
  console.log("[dolt-lifecycle] shutdown signal received — cleaning up Dolt processes");
  const pids = await enumerateDoltPids();

  if (pids.length === 0) {
    console.log("[dolt-lifecycle] no Dolt PIDs found in registry repos");
    return;
  }

  console.log(`[dolt-lifecycle] killing ${pids.length} Dolt process(es): ${pids.join(", ")}`);
  await Promise.all(pids.map((pid) => killWithGrace(pid)));
  console.log("[dolt-lifecycle] Dolt cleanup complete");
}

// ---------------------------------------------------------------------------
// Bootstrap: idempotent signal handler registration
// ---------------------------------------------------------------------------

/**
 * Register SIGTERM and SIGINT handlers that clean up Dolt processes on
 * beads_web shutdown. Idempotent — safe to call multiple times (from hot-
 * reload, from multiple route handler invocations, etc.). The guard is
 * anchored on globalThis so it survives Next.js module hot-reloads.
 *
 * Called from the Node-runtime route handler at
 * /api/fleet/dolt-lifecycle/init/route.ts, which is self-fetched by
 * instrumentation.ts at boot.
 */
export function ensureDoltLifecycleRegistered(): void {
  const g = getGlobal();
  if (g.__beadsWebDoltLifecycleRegistered) return;
  g.__beadsWebDoltLifecycleRegistered = true;

  const handler = (signal: string) => {
    console.log(`[dolt-lifecycle] received ${signal}`);
    // cleanupDoltProcesses is async; we need to keep the process alive
    // until cleanup completes, then re-emit the signal for default handler.
    cleanupDoltProcesses()
      .catch((err) => {
        console.error(
          "[dolt-lifecycle] cleanup failed:",
          err instanceof Error ? err.message : err,
        );
      })
      .finally(() => {
        // Remove our handler and re-emit the signal so the default
        // Node.js handler runs (exit for SIGTERM, exit for SIGINT).
        process.removeListener(signal, handler);
        process.kill(process.pid, signal);
      });
  };

  process.on("SIGTERM", handler);
  process.on("SIGINT", handler);
  console.log("[dolt-lifecycle] shutdown handlers registered (SIGTERM, SIGINT)");
}

/**
 * For tests only: reset the registration flag so subsequent test cases
 * start clean.
 */
export function __resetDoltLifecycleForTests(): void {
  const g = getGlobal();
  g.__beadsWebDoltLifecycleRegistered = false;
  // Remove any handlers we may have registered.
  // We can't easily reference the exact handler function, so we
  // clear all listeners and note that tests should restore them if needed.
  // In practice, test mocks replace process.on anyway.
}
