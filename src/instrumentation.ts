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

  // factory-core-6wrk.1: self-fetch the reconciler status endpoint after
  // the server starts listening. This triggers ensureReconcilerRunning
  // AND ensurePlanPrewarmed on the server side — so the plan cache is
  // warming BEFORE the user's browser hits /fleet. Without this, a
  // user who arrives within ~66s of `npm run dev` waits for the cold
  // prewarm to finish (all their parallel fetches converge on the same
  // cache.getOrCompute promise).
  //
  // Delayed so the HTTP listener is bound by the time we fetch. Uses a
  // self-fetch to localhost:3000 (or the configured port via env) so
  // the prewarm runs inside the normal route-handler context — avoids
  // direct-importing bv-client here which would repeat the webpack
  // dual-runtime bundling problem.
  setTimeout(() => {
    const port = process.env.PORT ?? "3000";
    const url = `http://localhost:${port}/api/fleet/reconciler/status`;
    fetch(url, { method: "GET" }).catch((err) => {
      console.warn(
        `[instrumentation] boot self-fetch to ${url} failed (prewarm will trigger on first user request instead):`,
        err instanceof Error ? err.message : err,
      );
    });
  }, 2_000);
}
