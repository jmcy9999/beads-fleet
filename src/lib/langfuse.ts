// =============================================================================
// Langfuse OTEL Initialization (restored from beads_web-6o5 approach)
// =============================================================================
//
// Uses @opentelemetry/sdk-trace-node + @langfuse/otel LangfuseSpanProcessor.
// This is the LIGHTWEIGHT approach — no @opentelemetry/sdk-node, no gRPC
// exporters, no webpack-incompatible dependencies.
//
// The heavy @opentelemetry/sdk-node approach (from 75e builder) pulled in
// grpc-js which broke Next.js webpack with "Module not found: stream/fs".
// =============================================================================

let initialized = false;

export function initLangfuse(): void {
  if (initialized) return;

  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;

  if (!publicKey || !publicKey.trim() || !secretKey || !secretKey.trim()) {
    console.log("[langfuse] Credentials not configured — tracing disabled");
    return;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { NodeTracerProvider } = require("@opentelemetry/sdk-trace-node");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { LangfuseSpanProcessor } = require("@langfuse/otel");

    const provider = new NodeTracerProvider({
      spanProcessors: [new LangfuseSpanProcessor()],
    });
    provider.register();

    initialized = true;
    console.log("[langfuse] OTEL initialized with LangfuseSpanProcessor");
  } catch (err) {
    console.error("[langfuse] Failed to initialize:", err);
  }
}
