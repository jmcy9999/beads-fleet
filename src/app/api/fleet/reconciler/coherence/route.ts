// =============================================================================
// GET /api/fleet/reconciler/coherence — factory-core-zsjv.5
// =============================================================================
// Returns recent coherence actions across all epics. Coherence actions are
// identified by ruleName prefix "coherence-" on reconciler-action-taken
// events, or toAction === "run-coherence-agent" on stage-dispatched events.
// Powers the dashboard card extension that distinguishes coherence-driven
// recoveries from mechanical rule recoveries.
// =============================================================================

import { NextResponse } from "next/server";

export const runtime = "nodejs";
// beads_web-poh follow-on (2026-05-08): MUST be force-dynamic. The
// response is built from a fresh JSONL event-log read every call, so
// caching at the framework layer is wrong on its face. More
// importantly, the sibling route /api/fleet/reconciler/status was
// silently being prerendered (build-time response cached forever), and
// this route shares the same structural risk — a stale prerender here
// would mask coherence escalations from the dashboard. Marking dynamic
// matches every other /api/fleet/* route's contract.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { readEvents } = await import("@/lib/event-log");
    // factory-core-so74 A.8 deferred-AC fix: fallback updated to
    // factory-core (the active fork). See
    // docs/aspirational-pipeline/a8-deferred-fixes.md.
    const repoPath =
      process.env.FLEET_CORE_PATH ?? "/Users/janemckay/dev/fleet/factory-core";

    // Lookback: 24 hours by default — enough to cover overnight runs.
    const sinceMs = Date.now() - 24 * 60 * 60_000;
    const since = new Date(sinceMs).toISOString();

    const [actionTakenEvents, dispatchEvents] = await Promise.all([
      readEvents(repoPath, { type: "reconciler-action-taken", since }),
      readEvents(repoPath, { type: "stage-dispatched", since }),
    ]);

    // Coherence-rule firings (escalation rule triggered)
    const coherenceActionsTaken = actionTakenEvents
      .filter((e) => {
        const payload = e.payload as { ruleName?: string } | undefined;
        return payload?.ruleName?.startsWith("coherence-") ?? false;
      })
      .map((e) => {
        const payload = e.payload as {
          ruleName?: string;
          idempotencyKey?: string;
          context?: Record<string, unknown>;
        };
        return {
          kind: "escalation-triggered" as const,
          at: e.timestamp,
          epicId: e.epicId,
          ruleName: payload.ruleName,
          idempotencyKey: payload.idempotencyKey,
          context: payload.context,
        };
      });

    // Coherence agent dispatches (actual agent spawns)
    const coherenceDispatches = dispatchEvents
      .filter((e) => {
        const payload = e.payload as { toAction?: string } | undefined;
        return payload?.toAction === "run-coherence-agent";
      })
      .map((e) => {
        const payload = e.payload as Record<string, unknown>;
        return {
          kind: "agent-dispatched" as const,
          at: e.timestamp,
          epicId: e.epicId,
          toAction: payload.toAction as string,
          correlationId: e.correlationId,
        };
      });

    return NextResponse.json({
      windowHours: 24,
      coherenceActionsTaken,
      coherenceDispatches,
      totals: {
        escalationsTriggered: coherenceActionsTaken.length,
        agentsDispatched: coherenceDispatches.length,
      },
    });
  } catch (err) {
    console.error("[reconciler/coherence] failed:", err);
    return NextResponse.json(
      {
        windowHours: 24,
        coherenceActionsTaken: [],
        coherenceDispatches: [],
        totals: { escalationsTriggered: 0, agentsDispatched: 0 },
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
