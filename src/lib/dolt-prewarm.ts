/**
 * Dolt server pre-warm.
 *
 * Problem observed 2026-04-29: after a fresh server restart (or after
 * killing leaked Dolt processes), most per-repo Dolt sql-servers are
 * dead. beads_web's plan-prewarm probes each repo (`probeDolt` from
 * dolt-health.ts); dead-Dolt repos shortcut to UnreachableRobotPlan
 * before bv has a chance to spawn the server. Result: the dashboard
 * shows ~41 of 43 repos as "offline" until something else (a user
 * action, the orchestrator hitting bd in that repo) wakes the Dolt.
 *
 * Fix: invoke `bd list --limit 1` in each repo's cwd at boot. bd
 * auto-spawns the Dolt sql-server for that repo if not running. With
 * all 43 servers alive, plan-prewarm's probes succeed for all of them
 * and the dashboard shows real data for the full portfolio.
 *
 * Concurrency: Promise.allSettled across all repos. Each spawn is
 * independent (different cwd, different port) so parallelism is real.
 * Wall-time on 43 repos: ~2-5s on first boot (dominated by the
 * slowest Dolt to come up).
 *
 * Idempotency: a global singleton promise, same pattern as
 * plan-prewarm.ts. Subsequent calls within the same process return
 * the same resolved/in-flight promise.
 *
 * Error tolerance: any per-repo failure (missing .beads, broken
 * config, slow Dolt) is swallowed — a single broken repo cannot
 * block the rest of the portfolio from coming alive.
 */

import { execFile as execFileCb } from "child_process";
import { existsSync } from "fs";
import { promisify } from "util";

const execFile = promisify(execFileCb);

const PER_REPO_TIMEOUT_MS = 15_000; // generous; first-spawn can take a few seconds

interface GlobalWithDoltPrewarm {
  __doltPrewarmPromise?: Promise<void> | null;
  __resolvedBdBinary?: string | null;
}

function getGlobal(): GlobalWithDoltPrewarm {
  return globalThis as unknown as GlobalWithDoltPrewarm;
}

/**
 * Find the bd binary that has the CGO/Dolt backend compiled in.
 *
 * The local `node_modules/.bin/bd` is the JS-only bd that cannot speak
 * Dolt (errors with "dolt backend requires CGO"). Repos with
 * `metadata.json: { backend: "dolt" }` need the prebuilt CGO binary,
 * which lives at one of the standard system install locations.
 *
 * Resolution order:
 *   1. BD_BIN env var (explicit override)
 *   2. /opt/homebrew/bin/bd (Apple Silicon Homebrew default)
 *   3. /usr/local/bin/bd (Intel Homebrew / manual install default)
 *   4. /usr/bin/bd (system-wide install)
 *   5. Last resort: just "bd" and trust PATH (may pick up the wrong one)
 *
 * Cached on globalThis so we resolve once per process.
 */
function resolveBdBinary(): string {
  const g = getGlobal();
  if (g.__resolvedBdBinary) return g.__resolvedBdBinary;

  const candidates = [
    process.env.BD_BIN,
    "/opt/homebrew/bin/bd",
    "/usr/local/bin/bd",
    "/usr/bin/bd",
  ].filter((p): p is string => Boolean(p));

  for (const p of candidates) {
    if (existsSync(p)) {
      g.__resolvedBdBinary = p;
      return p;
    }
  }

  g.__resolvedBdBinary = "bd"; // PATH fallback
  return g.__resolvedBdBinary;
}

/**
 * Spawn the Dolt sql-server for one repo by running a cheap bd query
 * in that repo's cwd. bd is responsible for the spawn lifecycle —
 * we just trigger it.
 */
async function wakeOneRepo(repoPath: string): Promise<{ repoPath: string; ok: boolean; latencyMs: number; error?: string }> {
  const t0 = Date.now();
  try {
    await execFile(resolveBdBinary(), ["list", "--limit", "1"], {
      cwd: repoPath,
      timeout: PER_REPO_TIMEOUT_MS,
      env: { ...process.env, NO_COLOR: "1" },
    });
    return { repoPath, ok: true, latencyMs: Date.now() - t0 };
  } catch (err) {
    return {
      repoPath,
      ok: false,
      latencyMs: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Idempotent, awaitable prewarm. Spawns Dolt servers for every repo
 * in the registry. Returns when all spawns have completed (success
 * or failure). Caller MAY await this — `plan-prewarm` does, so plan
 * queries don't fire until Dolts are alive.
 */
export function ensureDoltPrewarmed(): Promise<void> {
  const g = getGlobal();
  if (g.__doltPrewarmPromise) return g.__doltPrewarmPromise;

  const start = Date.now();
  g.__doltPrewarmPromise = (async () => {
    try {
      const { getAllRepoPaths } = await import("./repo-config");
      const paths = await getAllRepoPaths();
      const results = await Promise.allSettled(paths.map(wakeOneRepo));

      const ok = results.filter(
        (r) => r.status === "fulfilled" && r.value.ok,
      ).length;
      const failed = results.length - ok;
      const elapsed = Date.now() - start;
      console.log(
        `[dolt-prewarm] ${ok}/${results.length} repos awake in ${elapsed}ms (${failed} failed)`,
      );

      if (failed > 0) {
        const failures = results
          .filter((r) => r.status === "fulfilled" && !r.value.ok)
          .map((r) => {
            const v = (r as PromiseFulfilledResult<{ repoPath: string; ok: boolean; latencyMs: number; error?: string }>).value;
            return `  - ${path.basename(v.repoPath)}: ${v.error}`;
          });
        if (failures.length > 0) {
          console.warn(`[dolt-prewarm] failed repos:\n${failures.join("\n")}`);
        }
      }
    } catch (err) {
      const g2 = getGlobal();
      g2.__doltPrewarmPromise = null;
      console.error(
        "[dolt-prewarm] failed (will retry on next caller):",
        err instanceof Error ? err.message : err,
      );
    }
  })();

  return g.__doltPrewarmPromise;
}

/**
 * Test helper. Production code MUST NOT call this.
 */
export function __resetDoltPrewarmForTests(): void {
  getGlobal().__doltPrewarmPromise = null;
}
