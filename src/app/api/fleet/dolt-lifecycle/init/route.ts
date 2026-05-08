// =============================================================================
// GET /api/fleet/dolt-lifecycle/init — beads_web-6pf
// =============================================================================
// Bootstrap route for the Dolt lifecycle shutdown handler. Self-fetched by
// instrumentation.ts at server boot to register SIGTERM/SIGINT handlers in
// Node-runtime context.
//
// Mirrors the reconciler-status route pattern (factory-core-6wrk.1):
// instrumentation.ts cannot directly import node-only modules (dual-runtime
// webpack trap), so it self-fetches this route handler, which IS
// unambiguously Node-runtime and safe for those imports.
//
// Per Q2b decision (2026-04-30): bootstrap via route-handler self-fetch.
// =============================================================================

import { NextResponse } from "next/server";
import { ensureDoltLifecycleRegistered } from "@/lib/dolt-lifecycle";

export const runtime = "nodejs";
// beads_web-poh follow-on (2026-05-08): MUST be force-dynamic. Without
// this declaration, Next.js App Router prerenders the GET response at
// build time, so the handler never runs in production and the SIGTERM/
// SIGINT lifecycle handlers are never registered. See the matching
// comment in /api/fleet/reconciler/status/route.ts for the full
// failure mode. Same symptom shape: lifecycle bootstrap routes that
// rely on first-GET to register process-wide hooks must be marked
// dynamic, otherwise their hooks never get installed.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    ensureDoltLifecycleRegistered();
    return NextResponse.json({ registered: true });
  } catch (err) {
    console.error("[dolt-lifecycle/init] bootstrap failed:", err);
    return NextResponse.json(
      {
        registered: false,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
