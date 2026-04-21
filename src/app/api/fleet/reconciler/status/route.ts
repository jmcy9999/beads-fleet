// =============================================================================
// GET /api/fleet/reconciler/status — factory-core-lfcf.5
// =============================================================================
// Status-only read endpoint. Returns the reconciler's current health and
// recent actions so the dashboard can render a "last tick, last action"
// card. Per zero-human-touchpoints directive (feedback memory
// 2026-04-21), this endpoint is READ-ONLY — no pause / kick / reset
// CTAs. If the reconciler is broken, tmux-attach is the debug path.
// =============================================================================

import { NextResponse } from "next/server";

export async function GET() {
  try {
    const { getGlobalReconciler } = await import("@/lib/reconciler");
    const rec = getGlobalReconciler();
    if (!rec) {
      return NextResponse.json({
        running: false,
        reason: "reconciler not initialized",
        tickIntervalMs: 0,
        eventsProcessedLastTick: 0,
        actionsDispatchedLastTick: 0,
        rulesRegistered: [],
        recentActions: [],
      });
    }
    return NextResponse.json(rec.getStatus());
  } catch (err) {
    console.error("[reconciler/status] failed:", err);
    return NextResponse.json(
      {
        running: false,
        reason: err instanceof Error ? err.message : String(err),
        tickIntervalMs: 0,
        eventsProcessedLastTick: 0,
        actionsDispatchedLastTick: 0,
        rulesRegistered: [],
        recentActions: [],
      },
      { status: 500 },
    );
  }
}
