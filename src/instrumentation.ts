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
  // targets. BOTH static imports AND dynamic imports that transitively
  // touch node-only modules (child_process, fs sync, etc.) will cause
  // the edge bundle to fail. Even a `setTimeout(() => import(...))` is
  // NOT safe — webpack analyzes the import() call statically and emits
  // a chunk for the edge bundle.
  //
  // Instead: the reconciler is lazy-initialized on the first call to
  // ensureReconcilerRunning() from a route handler. Route handlers are
  // unambiguously Node-runtime in Next.js (mark with `export const
  // runtime = "nodejs"`), so their static imports never touch the edge
  // bundle. See src/lib/reconciler-bootstrap.ts for the bootstrap
  // logic and /api/fleet/reconciler/status/route.ts for the canonical
  // self-fetch pattern from instrumentation.ts.
  //
  // beads_web-8wh note: Boot-time diagnostics that need Node-only code
  // can live directly in Node-only helpers that are already called at
  // boot (e.g., the read-model prewarm path). No self-fetch needed if
  // the helper is already on the boot path.

  // factory-core-6wrk.1: self-fetch the reconciler status endpoint after
  // the server starts listening. This triggers ensureReconcilerRunning
  // AND ensurePlanPrewarmed on the server side — so the read-model cache is
  // warming BEFORE the user's browser hits /fleet. Without this, a
  // user who arrives within ~66s of `npm run dev` waits for the cold
  // prewarm to finish (all their parallel fetches converge on the same
  // read-model refresh promise).
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

  // beads_web-6pf: self-fetch the dolt-lifecycle init endpoint to register
  // SIGTERM/SIGINT shutdown handlers in Node-runtime context. On beads_web
  // exit, these handlers kill all Dolt sql-server processes spawned by bd
  // for registry repos — preventing orphaned Dolts on restart.
  //
  // Same self-fetch pattern as the reconciler-status boot above (Q2b
  // decision 2026-04-30). Slightly longer delay to avoid contention with
  // the reconciler bootstrap at 2s. The route handler at
  // /api/fleet/dolt-lifecycle/init calls ensureDoltLifecycleRegistered()
  // which is idempotent — safe across hot-reloads.
  setTimeout(() => {
    const port = process.env.PORT ?? "3000";
    const url = `http://localhost:${port}/api/fleet/dolt-lifecycle/init`;
    fetch(url, { method: "GET" }).catch((err) => {
      console.warn(
        `[instrumentation] boot self-fetch to ${url} failed (dolt lifecycle handlers not registered):`,
        err instanceof Error ? err.message : err,
      );
    });
  }, 3_000);

  // beads_web-8wh redesign: the collision scan is folded into the
  // Node-only plan-prewarm path above. It shares the portfolio read snapshot
  // rather than doing a second `bv --robot-plan` fan-out.
}
