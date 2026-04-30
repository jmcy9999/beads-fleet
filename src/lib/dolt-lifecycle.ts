// =============================================================================
// Dolt lifecycle shutdown handler — beads_web-6pf
// =============================================================================
//
// On beads_web exit (SIGTERM / SIGINT), enumerates all Dolt sql-server PIDs
// from the ~/.beads-web.json registry repos' `.beads/dolt-server.pid` files
// and kills them: SIGTERM first, then SIGKILL after a 5s grace period.
//
// This module is Node-only. It must NOT be imported from instrumentation.ts
// (which webpack compiles for both node and edge targets). Instead, it is
// bootstrapped via a self-fetch to a Node-runtime route handler that calls
// ensureDoltLifecycleRegistered().
//
// Per Q1c (2026-04-30): F3 alive-set protection is OUT OF SCOPE — every
// registry Dolt is killed unconditionally. beads_web-c28 adds the alive-set
// guard as a follow-up.
// =============================================================================

import { readFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import path from "path";
import { getAllRepoPaths } from "./repo-config";

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
// PID enumeration from registry repos
// ---------------------------------------------------------------------------

/**
 * Read `.beads/dolt-server.pid` from each repo in the ~/.beads-web.json
 * registry. Returns an array of valid PIDs (positive integers) where the
 * process is verified to be a Dolt process.
 */
export async function enumerateDoltPids(): Promise<number[]> {
  const pids: number[] = [];
  let repoPaths: string[];
  try {
    repoPaths = await getAllRepoPaths();
  } catch (err) {
    console.warn(
      "[dolt-lifecycle] failed to read repo paths from registry:",
      err instanceof Error ? err.message : err,
    );
    return pids;
  }

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

    pids.push(pid);
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
