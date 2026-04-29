// =============================================================================
// Orchestrator URL — env-var-driven URL builder for beads_web's loopback fetch
// =============================================================================
//
// Hot-fix for factory-core-ijh2 (Bucket E preview): the 5 reconciler rules,
// wave-completeness.ts, and ~17 fetch sites in agent-launcher.ts all hardcoded
// http://localhost:3000/api/fleet/action. When beads_web runs on a non-3000
// port (e.g., port 3010 for the IMPROVED fork), every reconciler dispatch and
// chain auto-dispatch fails with `fetch failed`.
//
// This helper replaces the hardcoded literal with an env-var-driven URL:
//   - process.env.BEADS_WEB_URL — full override (e.g. http://localhost:3010/api/fleet/action)
//   - process.env.PORT          — port to combine with localhost (default 3000)
//
// Bucket E (Phase 2 plan Items 9+10) properly fixes this by replacing the
// loopback fetch with a direct in-process function call. Until that lands,
// this helper unblocks the IMPROVED fork.
// =============================================================================

export function getDefaultActionUrl(): string {
  if (process.env.BEADS_WEB_URL) return process.env.BEADS_WEB_URL;
  const port = process.env.PORT || "3000";
  return `http://localhost:${port}/api/fleet/action`;
}
