// =============================================================================
// Beads Fleet — Plan Review Integrity Sweep HTTP endpoint
// =============================================================================
//
// factory-core-k7gy.8 (F2 transport layer — see the architecture doc at
// docs/research/plan-review-by-reviewer-agent-architecture.md §Component
// Boundaries, §Interface Contracts, §Security Architecture, and ADR-006).
//
// Thin HTTP wrapper around `runIntegritySweep` (k7gy.4). The reviewer agent
// calls this endpoint via `curl http://localhost:3000/api/plan-review/integrity`
// from its Phase 2 (see `.claude/agents/reviewer.md` Stage 3 Phase 2). The
// agent never imports the integrity module or talks to Dolt directly —
// internal guardrail #2 (centralised Dolt access) and #10 (never `dolt sql`
// directly).
//
// Responsibilities (single-responsibility per architecture-principles.md):
//   1. Input validation — `epicId` format + `planManifestPath` shape.
//   2. Resolve the epic's app repo path so a reviewer-relative plan path
//      (`.beads/plans/<epic>.md`) resolves correctly regardless of beads_web's
//      cwd. Uses `findRepoForIssue` from `repo-config.ts`.
//   3. Call `runIntegritySweep(epicId, planManifestPath, { baseDir })`.
//   4. Enforce a 60s total wall-clock cap as defence-in-depth (the module
//      also honours its own cap).
//   5. Format the result as JSON with the canonical shape. On any failure
//      inside the sweep, return HTTP 200 with a fail-closed partial shape
//      (ADR-006 / regression pattern #13) — NEVER an error status the agent
//      would mistakenly treat as "try again later" and silently advance.
//
// Security posture (architecture §Security):
//   - Loopback-only. No CORS headers (Next.js default); external requests
//     are blocked by the browser's CORS policy.
//   - No secrets, no auth — localhost dev convention matches the rest of
//     beads_web.
//   - Input validation rejects path traversal (`..`), absolute paths, and
//     invalid `epicId` shapes with HTTP 400 before touching the filesystem
//     or Dolt.
//
// This route does NOT import `@/lib/dolt-reader` directly — all Dolt access
// flows through `runIntegritySweep` (architecture §Scope Boundaries).
// =============================================================================

import { NextRequest, NextResponse } from "next/server";
import * as path from "path";

import {
  runIntegritySweep,
  INTEGRITY_SWEEP_TIMEOUT_MS,
  InvalidEpicIdError,
  InvalidPathError,
  type IntegrityResult,
} from "@/lib/plan-review/integrity";
import { findRepoForIssue } from "@/lib/repo-config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Canonical epic ID shape — matches integrity.ts's EPIC_ID_REGEX and the
// architecture §Security regex. Example matches: `factory-core-k7gy`,
// `factory-core-k7gy.3`, `abc-1.2.3`. Empty string does NOT match.
const EPIC_ID_REGEX = /^[a-z0-9-]+(\.[0-9]+)*$/;

// Sentinel repoId for the `unavailable` list when the sweep itself fails
// (unexpected throw, total-cap timeout, or repo cannot be located). The
// reviewer treats any non-empty `unavailable` list as a critical finding
// — see ADR-006.
const SENTINEL_UNAVAILABLE_UNRESOLVED_REPO = "unresolved-app-repo";
const SENTINEL_UNAVAILABLE_SWEEP_ERROR = "integrity-sweep-error";
const SENTINEL_UNAVAILABLE_TIMEOUT = "integrity-sweep-timeout";

/**
 * Fail-closed shape per ADR-006: empty orphans/strays/mislabels plus a
 * non-empty `unavailable` list. The reviewer short-circuits Phase 3 when it
 * sees any unavailable entry, so we must never accidentally send an empty
 * `unavailable` when the sweep did not complete.
 */
function failClosed(sentinel: string): IntegrityResult {
  return {
    orphans: [],
    strays: [],
    mislabels: [],
    unavailable: [sentinel],
  };
}

/**
 * GET /api/plan-review/integrity
 *
 * Query params:
 *   - epicId           — required. Matches `^[a-z0-9-]+(\.[0-9]+)*$`.
 *   - planManifestPath — required. Relative path (no absolute, no `..`).
 *
 * Responses:
 *   - 200 with `{orphans, strays, mislabels, unavailable}` — success shape
 *     or fail-closed shape. The agent always parses the response as this
 *     shape; an empty `unavailable` means the full sweep completed.
 *   - 400 with `{error}` — input validation failed. The agent surfaces
 *     these as `integrity-sweep:unavailable` bugs per Phase 2 fail-closed.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const url = new URL(request.url);
  const epicId = url.searchParams.get("epicId");
  const planManifestPath = url.searchParams.get("planManifestPath");

  // ---------------------------------------------------------------------
  // Input validation (validation in the route, not the module —
  // regression pattern #4 keeps the module's validation as a defensive
  // backstop; the route owns the 400 response shape).
  // ---------------------------------------------------------------------

  // Missing `epicId` — discriminated from empty so the agent log reads clearly.
  if (epicId === null) {
    return NextResponse.json(
      { error: "Missing required query parameter: epicId" },
      { status: 400 },
    );
  }
  // Empty or malformed `epicId` — regression #12 (empty string as query param).
  if (!epicId || !EPIC_ID_REGEX.test(epicId)) {
    return NextResponse.json(
      { error: `Invalid epicId: ${JSON.stringify(epicId)}` },
      { status: 400 },
    );
  }

  if (planManifestPath === null) {
    return NextResponse.json(
      { error: "Missing required query parameter: planManifestPath" },
      { status: 400 },
    );
  }
  if (!planManifestPath) {
    return NextResponse.json(
      { error: "Invalid planManifestPath: empty" },
      { status: 400 },
    );
  }
  // Absolute paths are rejected (path must be relative to the epic's repo).
  if (path.isAbsolute(planManifestPath)) {
    return NextResponse.json(
      {
        error: `Invalid planManifestPath: absolute paths not permitted (${JSON.stringify(planManifestPath)})`,
      },
      { status: 400 },
    );
  }
  // Path traversal — any `..` segment is rejected (architecture §Security).
  const normalised = path.normalize(planManifestPath);
  if (normalised.split(path.sep).includes("..")) {
    return NextResponse.json(
      {
        error: `Invalid planManifestPath: path traversal rejected (${JSON.stringify(planManifestPath)})`,
      },
      { status: 400 },
    );
  }

  // ---------------------------------------------------------------------
  // Resolve the app repo path for this epic.
  //
  // `findRepoForIssue` queries each configured repo's Dolt server for the
  // epicId and returns the absolute repo path, or `null` if no repo knows
  // the epic. If we cannot resolve, fail-closed with a clear sentinel — the
  // reviewer will file an `integrity-sweep:unavailable` bug and short-circuit
  // to NEEDS REVISION rather than running semantic review against a plan
  // whose home repo is unknown.
  // ---------------------------------------------------------------------

  let baseDir: string | null;
  try {
    baseDir = await findRepoForIssue(epicId);
  } catch {
    baseDir = null;
  }

  if (!baseDir) {
    return NextResponse.json(failClosed(SENTINEL_UNAVAILABLE_UNRESOLVED_REPO), {
      status: 200,
    });
  }

  // ---------------------------------------------------------------------
  // Run the sweep with a route-level total cap.
  //
  // The module also enforces `INTEGRITY_SWEEP_TIMEOUT_MS` across its per-repo
  // queries (parallel, so 2 × 45s repos still finish in ~45s). The route-level
  // cap is defence-in-depth: if the module hangs for any reason, we still
  // return a well-formed fail-closed response within 60s so the reviewer's
  // curl doesn't stall its session.
  // ---------------------------------------------------------------------

  try {
    const result = await withTotalCap(
      runIntegritySweep(epicId, planManifestPath, { baseDir }),
      INTEGRITY_SWEEP_TIMEOUT_MS,
    );
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    // The module's own validators throw named errors. We already pre-validated
    // above, but keep these branches as defence-in-depth; if reached, the
    // input really was invalid and 400 is the correct response.
    if (error instanceof InvalidEpicIdError || error instanceof InvalidPathError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    // Route-level timeout — return fail-closed with a distinct sentinel so
    // the reviewer's log identifies the failure mode (regression #2).
    if (error instanceof RouteTimeoutError) {
      return NextResponse.json(failClosed(SENTINEL_UNAVAILABLE_TIMEOUT), {
        status: 200,
      });
    }
    // Everything else — MissingBeadSummaryError (plan malformed), ENOENT,
    // Dolt transport errors, anything unexpected — fail-closed per ADR-006.
    // NEVER return 500 in a way that an agent calling curl might misread
    // as transient (regression pattern #13).
    void error; // retained for Langfuse/server logs; body stays sanitised.
    return NextResponse.json(failClosed(SENTINEL_UNAVAILABLE_SWEEP_ERROR), {
      status: 200,
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class RouteTimeoutError extends Error {
  constructor(capMs: number) {
    super(`Route total cap exceeded (${capMs}ms)`);
    this.name = "RouteTimeoutError";
  }
}

/**
 * Race a promise against a hard wall-clock cap. Resolves with the promise's
 * value if it completes in time; otherwise rejects with `RouteTimeoutError`.
 *
 * The timer is `unref`'d so it doesn't keep the Node process alive during
 * tests. If the underlying promise rejects, we still clear the timer so
 * subsequent requests' timers don't pile up.
 */
function withTotalCap<T>(promise: Promise<T>, capMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new RouteTimeoutError(capMs));
    }, capMs);
    if (typeof timer === "object" && timer && "unref" in timer) {
      (timer as { unref: () => void }).unref();
    }
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
