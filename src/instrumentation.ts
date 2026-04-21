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
    const repoPath =
      process.env.FLEET_CORE_PATH ?? "/Users/janemckay/dev/fleet/fleet-core";
    initReconciler(repoPath);
  } catch (err) {
    console.error("[instrumentation] Failed to initialize reconciler:", err);
  }
}
