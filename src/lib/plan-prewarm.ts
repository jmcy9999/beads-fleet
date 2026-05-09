/**
 * Plan cache pre-warm (factory-core-6wrk.1).
 *
 * Problem observed 2026-04-21: first /api/fleet/wave-status request after
 * a fresh `npm run dev` took 99.5 seconds. Root cause = cold-start cache
 * population. The hot dashboard routes now share a Dolt-backed portfolio
 * read snapshot. The first call pays the full fan-out cost; subsequent
 * calls are fast. With ~N epics, the fleet page issues N parallel
 * wave-status requests — all queued behind the one cold compute. User sees
 * "Failed to fetch" because the browser times out before 99s elapses.
 *
 * Fix: populate the cache from a route-handler-initiated lazy bootstrap,
 * exactly like reconciler-bootstrap.ts. First HTTP request to any route
 * that calls ensurePlanPrewarmed triggers a background fetch of the full
 * portfolio snapshot. By the time the fleet page issues its wave-status
 * fetches, the cache is hot (or warming in parallel — both fetches
 * converge on the same read-model promise so the second one waits for the
 * first rather than re-doing the work).
 *
 * Why not instrumentation.ts: Next.js compiles instrumentation.ts for
 * both node and edge runtimes. bv-client imports child_process, which
 * breaks the edge bundle. Route handlers are unambiguously node-runtime;
 * bootstrapping from there keeps the module graph clean. Same pattern
 * the reconciler uses (reconciler-bootstrap.ts).
 *
 * Fire-and-forget semantics:
 *   - ensurePlanPrewarmed() returns immediately; caller does NOT await.
 *   - Internal promise stored on globalThis so every module instance
 *     (Next.js dev-mode compiles routes into separate chunks) sees the
 *     same singleton — avoids re-running the prewarm per-route.
 *   - On failure, the promise is cleared so the next call retries.
 *   - Swallows errors; a failed prewarm must not block any route.
 */

interface GlobalWithPrewarm {
  __planPrewarmPromise?: Promise<void> | null;
}

function getGlobal(): GlobalWithPrewarm {
  return globalThis as unknown as GlobalWithPrewarm;
}

/**
 * Idempotent, fire-and-forget prewarm. Call freely from any route
 * handler — first call triggers a background portfolio snapshot refresh;
 * subsequent calls return the same resolved promise.
 *
 * Callers typically do NOT await this. It's fire-and-forget; the cache
 * it populates is shared with the actual wave-status / issues endpoints
 * which transparently consume it once populated.
 */
export function ensurePlanPrewarmed(): Promise<void> {
  const g = getGlobal();
  if (g.__planPrewarmPromise) return g.__planPrewarmPromise;

  const start = Date.now();
  g.__planPrewarmPromise = (async () => {
    try {
      // Wake all per-repo Dolt sql-servers BEFORE snapshot queries fire.
      // With this, the read-model cache is populated with real data for the
      // full portfolio when the user's first dashboard request arrives.
      const { ensureDoltPrewarmed } = await import("./dolt-prewarm");
      await ensureDoltPrewarmed();

      const { getPortfolioReadSnapshot } = await import(
        "./read-model-snapshot"
      );
      const { getAllRepoPaths } = await import("./repo-config");
      const paths = await getAllRepoPaths();
      await getPortfolioReadSnapshot(paths);

      import("./startup-collision-scan")
        .then(({ scanForBeadIdCollisions }) => scanForBeadIdCollisions())
        .catch((err) => {
          console.warn(
            "[plan-prewarm] collision scan failed (non-fatal):",
            err instanceof Error ? err.message : err,
          );
        });
      const elapsed = Date.now() - start;
      console.log(
        `[plan-prewarm] cache populated for ${paths.length} repo(s) in ${elapsed}ms`,
      );
    } catch (err) {
      const g2 = getGlobal();
      // Clear so the next caller can retry. Otherwise a boot-time hiccup
      // would pin the cache in a perpetually-cold state.
      g2.__planPrewarmPromise = null;
      console.error(
        "[plan-prewarm] failed (will retry on next caller):",
        err instanceof Error ? err.message : err,
      );
    }
  })();

  return g.__planPrewarmPromise;
}

/**
 * Test helper: reset the prewarm state so subsequent tests see a cold
 * cache. Production code MUST NOT call this.
 */
export function __resetPlanPrewarmForTests(): void {
  getGlobal().__planPrewarmPromise = null;
}
