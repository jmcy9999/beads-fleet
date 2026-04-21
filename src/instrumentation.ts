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
  // factory-core-lfcf: reconciler init is NOT done here.
  // instrumentation.ts gets webpack-compiled for both node and edge
  // targets, which causes child_process (via agent-launcher.ts) to fail
  // the edge bundle. Instead, the reconciler is lazy-initialized on the
  // first call to ensureReconcilerRunning() from a route handler —
  // route handlers are unambiguously Node-runtime in Next.js.
  // See src/lib/reconciler-bootstrap.ts.
}
