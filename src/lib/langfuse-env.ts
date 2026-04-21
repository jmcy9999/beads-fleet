// =============================================================================
// Langfuse Environment Utilities
// =============================================================================
//
// Pure functions for building OTEL environment variables, Langfuse trace URLs,
// and checking Langfuse configuration status. Used by agent-launcher.ts to
// wire Claude Code CLI child processes into Langfuse observability.
//
// All functions are side-effect-free and read only from process.env.
// Epic: factory-core-75e (Langfuse agent observability)
// =============================================================================

/**
 * Context for building OTEL resource attributes.
 * All fields are optional — missing fields are omitted from the attributes.
 */
export interface OtelContext {
  epicId?: string;
  agentType?: string;
  pipelineStage?: string;
  repoName?: string;
}

/**
 * Check whether Langfuse is configured with valid credentials.
 *
 * @returns true if both LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are set
 *          and non-empty in process.env
 */
export function isLangfuseConfigured(): boolean {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  return !!(publicKey && publicKey.trim() && secretKey && secretKey.trim());
}

/**
 * Build OTEL environment variables for a Claude Code CLI child process.
 *
 * When Langfuse credentials are configured, returns env vars that enable
 * Claude Code's native OTEL telemetry and route spans to Langfuse Cloud.
 * When credentials are missing, returns an empty object (graceful degradation).
 *
 * The returned object should be spread into the child process env:
 *   spawn("claude", args, { env: { ...process.env, ...buildOtelEnv(ctx) } })
 *
 * @param context - Agent context for OTEL resource attributes
 * @returns Record of env vars, or empty object if Langfuse is not configured
 */
export function buildOtelEnv(context: OtelContext = {}): Record<string, string> {
  if (!isLangfuseConfigured()) {
    return {};
  }

  const publicKey = process.env.LANGFUSE_PUBLIC_KEY!;
  const secretKey = process.env.LANGFUSE_SECRET_KEY!;
  const baseUrl = (process.env.LANGFUSE_BASE_URL || "https://cloud.langfuse.com").replace(/\/$/, "");

  // Base64-encode "publicKey:secretKey" for Basic auth
  const authString = Buffer.from(`${publicKey}:${secretKey}`).toString("base64");

  // Build resource attributes from context
  const attrs: string[] = [];
  if (context.epicId) attrs.push(`epic.id=${context.epicId}`);
  if (context.agentType) attrs.push(`agent.type=${context.agentType}`);
  if (context.pipelineStage) attrs.push(`pipeline.stage=${context.pipelineStage}`);
  if (context.repoName) attrs.push(`repo.name=${context.repoName}`);

  // Langfuse uses session.id for grouping traces in the session view
  if (context.epicId) attrs.push(`session.id=${context.epicId}`);

  const env: Record<string, string> = {
    // Enable the langfuse_hook.py Claude Code hook (reads transcript, sends turns to Langfuse)
    TRACE_TO_LANGFUSE: "true",
    CC_LANGFUSE_DEBUG: "true",
    // Native Claude Code OTEL telemetry
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1",
    OTEL_TRACES_EXPORTER: "otlp",
    OTEL_METRICS_EXPORTER: "otlp",
    OTEL_LOGS_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
    OTEL_EXPORTER_OTLP_ENDPOINT: `${baseUrl}/api/public/otel`,
    OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Basic ${authString}`,
  };

  if (attrs.length > 0) {
    env.OTEL_RESOURCE_ATTRIBUTES = attrs.join(",");
  }

  return env;
}

/**
 * Build a Langfuse Cloud URL for the session view of an epic.
 *
 * Returns undefined if LANGFUSE_PROJECT_ID is not configured, since the
 * URL cannot be constructed without it.
 *
 * @param epicId - The epic ID to link to (used as Langfuse session ID)
 * @returns Langfuse Cloud session URL, or undefined
 */
export function buildLangfuseTraceUrl(epicId: string): string | undefined {
  const projectId = process.env.LANGFUSE_PROJECT_ID;
  if (!projectId || !projectId.trim()) {
    return undefined;
  }

  const baseUrl = (process.env.LANGFUSE_BASE_URL || "https://cloud.langfuse.com").replace(/\/$/, "");
  return `${baseUrl}/project/${projectId.trim()}/sessions/${encodeURIComponent(epicId)}`;
}
