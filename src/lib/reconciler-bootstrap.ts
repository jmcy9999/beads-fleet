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
import { buildStuckInStageRule } from "./reconciler-rules/stuck-in-stage";
import { buildWaveBeadMismatchRule } from "./reconciler-rules/wave-bead-mismatch";
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

    // factory-core-zsjv.1: stuck-in-stage detector — generalises the
    // missed-wave-review recovery pattern to every pipeline stage.
    rec.registerRule(
      buildStuckInStageRule({
        readEpicSnapshot: async (epicId: string) => {
          const snap = await readEpicState(epicId, repoPath);
          const pipelineLabel = snap.labels.find((l) =>
            l.startsWith("pipeline:"),
          );
          const currentStage = pipelineLabel
            ? pipelineLabel.replace("pipeline:", "")
            : null;
          const hasAgentRunning = snap.labels.includes("agent:running");
          const currentWave = snap.waveStatus.hasWaves
            ? snap.waveStatus.currentWave
            : undefined;
          return {
            currentStage,
            hasAgentRunning,
            labels: snap.labels,
            title: epicId,
            currentWave,
          };
        },
      }),
    );

    // factory-core-zsjv.2: wave-bead-mismatch detector — catches epics
    // that advanced past development while wave beads remained open.
    // Rolls the epic back to pipeline:development + re-dispatches
    // start-wave for the lowest open wave.
    rec.registerRule(
      buildWaveBeadMismatchRule({
        readEpicSnapshot: async (epicId: string) => {
          const snap = await readEpicState(epicId, repoPath);
          const pipelineLabel = snap.labels.find((l) =>
            l.startsWith("pipeline:"),
          );
          const currentStage = pipelineLabel
            ? pipelineLabel.replace("pipeline:", "")
            : null;
          // Derive lowestOpenWave from the waveStatus map.
          let lowestOpenWave: number | undefined;
          if (snap.waveStatus.hasWaves && !snap.waveStatus.allWavesComplete) {
            for (const [n, entry] of snap.waveStatus.waves) {
              if (entry.closed < entry.total) {
                if (lowestOpenWave === undefined || n < lowestOpenWave) {
                  lowestOpenWave = n;
                }
              }
            }
          }
          return {
            currentStage,
            lowestOpenWave,
            allWavesComplete: snap.waveStatus.allWavesComplete,
            hasWaves: snap.waveStatus.hasWaves,
            waveStatusError: snap.waveStatus.error,
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
