// =============================================================================
// Next.js Instrumentation Hook — OTEL SDK Initialization
// =============================================================================
//
// Called by Next.js on server start when experimental.instrumentationHook is
// enabled in next.config.mjs. Initializes the OpenTelemetry SDK with
// LangfuseSpanProcessor so server-side spans are forwarded to Langfuse Cloud.
//
// Guards:
// - Only initializes when Langfuse credentials are present
// - Only initializes in Node.js runtime (not Edge)
// - Logs initialization status for debugging
//
// ADR-001: OTEL SDK init via instrumentation.ts (factory-core-75e)
// =============================================================================

export async function register() {
  // Only run in Node.js runtime (not Edge)
  if (process.env.NEXT_RUNTIME === "edge") {
    return;
  }

  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;

  if (!publicKey || !publicKey.trim() || !secretKey || !secretKey.trim()) {
    console.log("[instrumentation] Langfuse credentials not configured — OTEL SDK not initialized");
    return;
  }

  try {
    const { NodeSDK } = await import("@opentelemetry/sdk-node");
    const { LangfuseSpanProcessor } = await import("@langfuse/otel");

    const sdk = new NodeSDK({
      spanProcessors: [new LangfuseSpanProcessor()],
    });

    sdk.start();
    console.log("[instrumentation] OTEL SDK initialized with LangfuseSpanProcessor");
  } catch (err) {
    // Graceful degradation: log error but don't prevent server start
    console.error("[instrumentation] Failed to initialize OTEL SDK:", err);
  }
}
