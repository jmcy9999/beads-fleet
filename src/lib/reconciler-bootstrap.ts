/**
 * Reconciler bootstrap (factory-core-lfcf, hotfix 3).
 *
 * Lazy-initializes the global reconciler on first call. Designed to be
 * invoked from route handlers (which are unambiguously Node-runtime in
 * Next.js) rather than from instrumentation.ts (which Next.js compiles
 * for BOTH node and edge targets, causing child_process bundling
 * failures in the edge build).
 *
 * Idempotent: subsequent calls are no-ops once the reconciler is up.
 * The bootstrap is called opportunistically — e.g. on the first request
 * to the fleet action endpoint or the reconciler status endpoint — so
 * the reconciler starts running as soon as the server actually handles
 * pipeline traffic. For a completely idle server this means the
 * reconciler doesn't spin up until something asks it to, which is fine:
 * there are no pipeline events to reconcile in that state anyway.
 */

import { initReconciler, getGlobalReconciler } from "./reconciler";
import { buildMissedWaveReviewDispatchRule } from "./reconciler-rules/missed-wave-review-dispatch";
import { readEpicState } from "./agent-launcher";

let bootstrapped = false;

/**
 * Idempotent bootstrap. Call freely from any route handler or server
 * component — subsequent calls after the first return immediately.
 * Swallows errors by design; the reconciler is defence-in-depth, not a
 * hard requirement, and a failed bootstrap must not break the route
 * that triggered it.
 */
export function ensureReconcilerRunning(): void {
  if (bootstrapped) return;
  bootstrapped = true;

  try {
    const repoPath =
      process.env.FLEET_CORE_PATH ?? "/Users/janemckay/dev/fleet/fleet-core";
    const rec = initReconciler(repoPath);

    // Register the one production rule. When more rules arrive, add
    // them here — keeps the wiring in one place.
    rec.registerRule(
      buildMissedWaveReviewDispatchRule({
        readEpicSnapshot: async (epicId: string) => {
          const snap = await readEpicState(epicId, repoPath);
          return {
            waveStatus: {
              hasWaves: snap.waveStatus.hasWaves,
              currentWave: snap.waveStatus.currentWave,
              allWavesComplete: snap.waveStatus.allWavesComplete,
              error: snap.waveStatus.error,
            },
            openBugCount: snap.openBugCount,
            labels: snap.labels,
            title: epicId,
          };
        },
      }),
    );

    rec.start();
    console.log("[reconciler-bootstrap] reconciler started from route handler");
  } catch (err) {
    // Reset the flag so a subsequent call can try again — don't
    // permanently mark the bootstrap as done if it actually failed.
    bootstrapped = false;
    console.error(
      "[reconciler-bootstrap] init failed — will retry on next call:",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * For tests only: reset the bootstrap flag and stop the global reconciler
 * so subsequent test cases start clean.
 */
export function __resetReconcilerBootstrapForTests(): void {
  bootstrapped = false;
  const rec = getGlobalReconciler();
  if (rec) rec.stop();
}
