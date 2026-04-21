// =============================================================================
// Next.js Instrumentation Hook — Langfuse OTEL
// =============================================================================
//
// Calls initLangfuse() from src/lib/langfuse.ts on server start.
// Uses the lightweight approach: NodeTracerProvider + LangfuseSpanProcessor.
// No @opentelemetry/sdk-node (which pulls in gRPC and breaks webpack).
// =============================================================================

export async function register() {
  if (process.env.NEXT_RUNTIME === "edge") {
    return;
  }

  try {
    const { initLangfuse } = await import("./lib/langfuse");
    initLangfuse();
  } catch (err) {
    console.error("[instrumentation] Failed to initialize Langfuse:", err);
  }

  // factory-core-lfcf.2: start the reconciler loop on server boot so
  // dropped auto-chain transitions get caught structurally rather than
  // depending on operator intervention. Rules register themselves via
  // initReconciler (placeholder in lfcf.2; real rules from lfcf.4+).
  try {
    const { initReconciler } = await import("./lib/reconciler");
    const { buildMissedWaveReviewDispatchRule } = await import(
      "./lib/reconciler-rules/missed-wave-review-dispatch"
    );
    // agent-launcher.ts uses child_process + bd CLI — must NEVER be
    // imported from a module that could be bundled client-side. We
    // import it here in instrumentation.ts (server-only by Next.js
    // contract) to keep the reconciler module itself pure.
    const { readEpicState } = await import("./lib/agent-launcher");

    const repoPath =
      process.env.FLEET_CORE_PATH ?? "/Users/janemckay/dev/fleet/fleet-core";
    const rec = initReconciler(repoPath);
    rec.registerRule(
      buildMissedWaveReviewDispatchRule({
        readEpicSnapshot: async (epicId) => {
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
            // Fallback: use epicId as title when we don't have a
            // human-readable title handy. OK for reconciler dispatches —
            // it's logged, not shown to users.
            title: epicId,
          };
        },
      }),
    );
    rec.start();
  } catch (err) {
    console.error("[instrumentation] Failed to initialize reconciler:", err);
  }
}
