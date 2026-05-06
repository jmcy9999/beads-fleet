// =============================================================================
// Beads Fleet — Dispatch Preconditions Library (beads_web-ehp.3, Wave 2 minimal)
// =============================================================================
//
// Single source of truth for the "is this dispatch actually safe to fire?"
// gate that every dispatch site in beads_web (action route, reconciler rules,
// and dispatchChainAction's inline marker-routing branch) must call BEFORE
// mutating labels or launching agents.
//
// This Wave-2 minimal scaffold ships:
//   - The full type skeleton (RefusalCode union, PreconditionResult,
//     DispatchContext, Precondition) populated EXHAUSTIVELY so Wave-3
//     siblings (ehp.4 + ehp.13) can import without type rework.
//   - `buildDispatchContext({ epicId, repoPath, action, waveNumber? })`
//     async aggregator. Populates BeadSnapshot + marker + epic labels via
//     the published reader interfaces; SCAFFOLDS planFileExists,
//     openWaveBeadIds, stageEnteredAt to safe defaults (false / [] / null).
//   - `evaluatePreconditions(ctx)` pure synchronous verdict over the
//     PRECONDITION_TABLE.
//   - FOUR universal predicates that fire against every action ehp.4 invokes:
//       1. A.5 bd-status-not-deferred  → BD_STATUS_DEFERRED (load-bearing
//          for the 372-bead mass-defer per ADR-002 fail-closed posture)
//       2. A.5 bd-status-not-closed    → BD_STATUS_CLOSED
//       3. C   operator-decision-not-pending → OPERATOR_DECISION_PENDING
//          (marker.next_agent === "operator" AND marker.blocker_class set)
//       4. C   review-needs-human-not-set    → REVIEW_NEEDS_HUMAN
//          (epic labels include "human-decision:required")
//   - Minimal PRECONDITION_TABLE registering all 4 universal predicates
//     against EVERY action invoked by `marker-driven-routing.ts`'s `act()`,
//     verified against `agent-action-map.ts`'s `AGENT_TO_ACTION` table.
//
// The Wave-3 sibling beads_web-ehp.13 EXTENDS this file with per-action
// predicates (Class A: 5; B: 3; D: 1; E: 1), fills the SCAFFOLDED context
// fields, populates the full 38-action table, and adds the
// `PreconditionRefusalResponse` HTTP-412 helper. ehp.13 is purely additive
// to this file — type definitions, A.5 predicates, C predicates, and the
// minimal PRECONDITION_TABLE entries land here unchanged.
//
// Architecture references:
//   - ADR-001: discriminated-union PreconditionResult, NOT exceptions.
//   - ADR-002: bd-read failure is fail-closed refusal (BD_READ_FAILED) —
//     load-bearing for 372-bead defer.
//   - ADR-003: single-file library at src/lib/dispatch-preconditions.ts.
//   - ADR-004: PRECONDITION_TABLE keyed by action name; predicates also
//     carry `appliesTo(action)` for self-documentation.
//   - ADR-005: classes A, A.5, B, C, D, E all ship in v1 (split across
//     ehp.3 + ehp.13).
//
// Precedent for the design:
//   - Discriminated-union result over exception throwing — same shape as
//     marker-routing.ts's `RoutingDecision` (override + nextAgent + reason).
//   - Pure synchronous predicates over async — predicates are total
//     functions of the snapshot; I/O lives in `buildDispatchContext` only.
// =============================================================================

import type { BeadSnapshot } from "./bead-status-reader";
import { readBeadStatus } from "./bead-status-reader";
import type { MarkerData } from "./marker-reader";
import { readMarker } from "./marker-reader";
import { getEpicLabels } from "./pipeline-labels";

// ---------------------------------------------------------------------------
// RefusalCode — exhaustive 12-code union (per architecture § Refusal Codes)
//
// Architecture lists 12 codes; the test scenarios doc mentions an extended
// roster including PLAN_INSTABILITY and ACTION_NEXT_AGENT_MISMATCH (Class
// D + E) that ehp.13 will also use. The Wave-2 minimal table only RAISES
// 5 codes (the four Class A.5 + C codes plus BD_READ_FAILED), but the
// type skeleton ships ALL codes that any v1 predicate will produce so that
// ehp.13 can extend without touching the type union (avoids cross-wave
// file conflict on the type definition — explicit risk flag in the bead).
// ---------------------------------------------------------------------------

export type RefusalCode =
  // Class A — preconditions for plan/wave/architect-marker scaffolding (ehp.13)
  | "PLAN_FILE_MISSING"
  | "PLAN_PENDING"
  | "NO_WAVE_BEADS"
  | "ALL_WAVE_BEADS_CLOSED"
  | "ARCHITECT_MARKER_SUCCESS"
  // Class A.5 — bd-status preconditions (ehp.3, load-bearing)
  | "BD_STATUS_DEFERRED"
  | "BD_STATUS_CLOSED"
  | "BD_READ_FAILED"
  // Class B — pipeline-label / agent-running / qa-round (ehp.13)
  | "PIPELINE_LABEL_CONFLICT"
  | "AGENT_RUNNING_NO_SESSION"
  | "QA_ROUND_OUT_OF_ORDER"
  // Class C — operator-decision / review-needs-human (ehp.3)
  | "OPERATOR_DECISION_PENDING"
  | "REVIEW_NEEDS_HUMAN"
  // Class D — plan-file modified after stage-entered (ehp.13)
  | "PLAN_INSTABILITY"
  // Class E — action vs marker.next_agent mismatch (ehp.13)
  | "ACTION_NEXT_AGENT_MISMATCH";

/**
 * Runtime exhaustiveness map for RefusalCode. A test in
 * `dispatch-preconditions.test.ts` iterates this object's keys to assert
 * the union has exactly the codes the architecture specifies (no missed
 * code, no spurious code). The boolean value is incidental — the keys
 * are the contract.
 */
export const REFUSAL_CODES: Record<RefusalCode, true> = {
  PLAN_FILE_MISSING: true,
  PLAN_PENDING: true,
  NO_WAVE_BEADS: true,
  ALL_WAVE_BEADS_CLOSED: true,
  ARCHITECT_MARKER_SUCCESS: true,
  BD_STATUS_DEFERRED: true,
  BD_STATUS_CLOSED: true,
  BD_READ_FAILED: true,
  PIPELINE_LABEL_CONFLICT: true,
  AGENT_RUNNING_NO_SESSION: true,
  QA_ROUND_OUT_OF_ORDER: true,
  OPERATOR_DECISION_PENDING: true,
  REVIEW_NEEDS_HUMAN: true,
  PLAN_INSTABILITY: true,
  ACTION_NEXT_AGENT_MISMATCH: true,
};

// ---------------------------------------------------------------------------
// PreconditionResult — discriminated union per ADR-001
//
// Type narrows on `ok`. When ok=true, no refusalCode/failedCheck/reason
// are present. When ok=false, all three are required. TypeScript enforces
// the shape; tests assert the runtime invariant.
// ---------------------------------------------------------------------------

export type PreconditionResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly refusalCode: RefusalCode;
      readonly failedCheck: string;
      readonly reason: string;
    };

// ---------------------------------------------------------------------------
// DispatchContext — the snapshot every predicate reads from
//
// Wave-2 (this bead) populates `bead`, `marker`, `epicLabels`. The remaining
// three fields are SCAFFOLDED: `planFileExists` defaults false (no Wave-2
// predicate references it), `openWaveBeadIds` defaults [] (no Wave-2 ref),
// `stageEnteredAt` defaults null (no Wave-2 ref). ehp.13's builder MUST
// fill these via `fs.access`, a wave-bead query, and an event-log read
// respectively (per architecture § Seam 3 / Seam 4).
//
// The presence of the scaffolded fields in the type ensures Wave-3
// callers (ehp.4 reads only bead/marker/epicLabels; ehp.13 reads all 6)
// don't see a different DispatchContext shape and don't need a type
// migration. ehp.4 sees `planFileExists=false` etc. but never reads it
// (its predicates only inspect the universal-class fields).
// ---------------------------------------------------------------------------

export interface DispatchContext {
  /** Action name being dispatched (e.g., "run-architect", "start-wave"). */
  readonly action: string;
  /** Bead snapshot from `readBeadStatus`. null on bd-read failure (ADR-002). */
  readonly bead: BeadSnapshot | null;
  /** Marker data from `readMarker`. null when no marker file exists. */
  readonly marker: MarkerData | null;
  /** Epic labels from `getEpicLabels`. Empty array on read failure. */
  readonly epicLabels: readonly string[];
  /**
   * Wave-2 SCAFFOLDED — defaults to false. ehp.13 fills via `fs.access`
   * against `<repoPath>/.beads/plans/<epicId>.md`. No Wave-2 predicate
   * references this field; it is purely a placeholder for the type contract.
   */
  readonly planFileExists: boolean;
  /**
   * Wave-2 SCAFFOLDED — defaults to []. ehp.13 fills via a wave-N bead
   * query (likely `bd list --label wave:N --status=open`). No Wave-2
   * predicate references this field.
   */
  readonly openWaveBeadIds: readonly string[];
  /**
   * Wave-2 SCAFFOLDED — defaults to null. ehp.13 fills via an event-log
   * read for the most-recent `pipeline-label-set` event. No Wave-2
   * predicate references this field.
   */
  readonly stageEnteredAt: string | null;
}

// ---------------------------------------------------------------------------
// Precondition — pure predicate over DispatchContext
//
// Predicates are TOTAL functions: they always return a PreconditionResult,
// never throw. `appliesTo(action)` lets callers / tests introspect whether
// a predicate is registered for a given action name (per ADR-004 self-
// documentation). The PRECONDITION_TABLE separately maps actions to their
// predicates; `appliesTo` is the per-predicate side of the contract.
// ---------------------------------------------------------------------------

export interface Precondition {
  /** Stable identifier (e.g., "bd-status-not-deferred"). Logged on refusal. */
  readonly name: string;
  /** Refusal code this predicate emits (consistent across all callers). */
  readonly refusalCode: RefusalCode;
  /** True iff this predicate should run for the given action. */
  appliesTo(action: string): boolean;
  /** Synchronous verdict over the snapshot. Never throws. */
  evaluate(ctx: DispatchContext): PreconditionResult;
}

// ---------------------------------------------------------------------------
// Universal action set
//
// Verified against `agent-action-map.ts`'s `AGENT_TO_ACTION` table (each
// entry corresponds to one AgentType in the 10-agent canonical roster).
// `marker-driven-routing.ts`'s `act()` invokes `getActionForAgent(nextAgent)`
// to resolve the action name; therefore EVERY value in this set is an
// action ehp.4 may fire. The Wave-2 PRECONDITION_TABLE registers the four
// universal predicates against each.
//
// Note on naming: the bead description's example list (`'run-builder'`,
// `'run-reviewer'`, etc.) is a placeholder pattern. The bead AC text
// explicitly says "Verify the action set against agent-action-map.ts's
// exports" — that verification produced this set. Concrete differences:
//   - planner       → "generate-plan"   (NOT "run-planner")
//   - builder       → "start-wave"      (NOT "run-builder")
//   - reviewer      → "review-wave"     (NOT "run-reviewer")
//   - qa            → "send-for-qa"     (NOT "run-qa")
//   - polish        → "send-for-polish" (NOT "run-polish")
//   - product-mgr   → "run-pm"          (NOT "run-product-manager")
//   - operator      → "send-for-review" (NOT "run-operator" — see comment
//                     in agent-action-map.ts about ADR-001 stage-aware
//                     rewrite gating this action upstream)
// ---------------------------------------------------------------------------

const UNIVERSAL_ACTIONS: readonly string[] = [
  "run-architect", // architect
  "generate-plan", // planner
  "start-wave", // builder
  "review-wave", // reviewer
  "send-for-qa", // qa
  "send-for-polish", // polish
  "run-test-spec", // test-spec
  "run-pm", // product-manager
  "send-for-review", // operator (reachable only via coherence's escalation
  //              per marker-routing.ts ADR-001; still registered for
  //              defense in depth in case the rewrite layer is bypassed)
  "run-coherence-agent", // coherence
];

/**
 * Snapshot of the universal-action set (read-only) — exported for tests
 * that assert PRECONDITION_TABLE coverage.
 */
export const UNIVERSAL_ACTION_SET: ReadonlySet<string> = new Set(
  UNIVERSAL_ACTIONS,
);

// ---------------------------------------------------------------------------
// Universal predicates (ehp.3 — class A.5 + class C)
// ---------------------------------------------------------------------------

/**
 * A.5 — bd-status-not-deferred → BD_STATUS_DEFERRED
 *
 * Load-bearing for the 372-bead mass-defer protection. If the bead's
 * actual status is `deferred` (per a fresh `bd show --json` read), no
 * dispatch may fire. ADR-002 fail-closed posture: if the bead snapshot
 * is null (bd unreachable, malformed JSON, etc.), the BD_READ_FAILED
 * branch fires — NEVER silent skip.
 */
export const PRECOND_BD_STATUS_NOT_DEFERRED: Precondition = {
  name: "bd-status-not-deferred",
  refusalCode: "BD_STATUS_DEFERRED",
  appliesTo(_action) {
    return true; // universal across every dispatching action
  },
  evaluate(ctx) {
    if (ctx.bead === null) {
      return {
        ok: false,
        refusalCode: "BD_READ_FAILED",
        failedCheck: "bd-read-succeeded",
        reason:
          "bd read returned null (binary missing, non-zero exit, or schema mismatch) — fail-closed per ADR-002 to protect the 372-bead defer",
      };
    }
    if (ctx.bead.status === "deferred") {
      return {
        ok: false,
        refusalCode: "BD_STATUS_DEFERRED",
        failedCheck: "bd-status-not-deferred",
        reason: `bead ${ctx.bead.id} status=deferred — dispatch refused (load-bearing for 372-bead mass-defer)`,
      };
    }
    return { ok: true };
  },
};

/**
 * A.5 — bd-status-not-closed → BD_STATUS_CLOSED
 *
 * Closed beads must not receive further dispatches. Same fail-closed
 * posture as the deferred predicate (null → BD_READ_FAILED).
 */
export const PRECOND_BD_STATUS_NOT_CLOSED: Precondition = {
  name: "bd-status-not-closed",
  refusalCode: "BD_STATUS_CLOSED",
  appliesTo(_action) {
    return true;
  },
  evaluate(ctx) {
    if (ctx.bead === null) {
      return {
        ok: false,
        refusalCode: "BD_READ_FAILED",
        failedCheck: "bd-read-succeeded",
        reason:
          "bd read returned null — fail-closed per ADR-002 (cannot confirm bead is open)",
      };
    }
    if (ctx.bead.status === "closed") {
      return {
        ok: false,
        refusalCode: "BD_STATUS_CLOSED",
        failedCheck: "bd-status-not-closed",
        reason: `bead ${ctx.bead.id} status=closed — dispatch refused`,
      };
    }
    return { ok: true };
  },
};

/**
 * C — operator-decision-not-pending → OPERATOR_DECISION_PENDING
 *
 * If the marker says the next agent is the operator AND a blocker_class
 * is set, an explicit operator decision is pending — auto-progression
 * must NOT fire. Per architecture § Class C definition the predicate is
 * AND-gated: `marker.next_agent === "operator"` alone doesn't trigger;
 * the blocker_class field must also be populated (test scenarios assert
 * this — a marker with operator routing but no blocker_class is the
 * loop-agent contract violation that interpretMarkerForRouting rewrites
 * to coherence at read-time, NOT a Class-C operator decision).
 *
 * The predicate uses optional-chaining (`marker?.next_agent`) so that a
 * null marker is treated as "no operator decision pending" (passes), per
 * test scenario "Marker absence vs marker present".
 */
export const PRECOND_OPERATOR_DECISION_NOT_PENDING: Precondition = {
  name: "operator-decision-not-pending",
  refusalCode: "OPERATOR_DECISION_PENDING",
  appliesTo(_action) {
    return true;
  },
  evaluate(ctx) {
    const m = ctx.marker;
    if (!m) return { ok: true };
    const nextAgent =
      typeof m.next_agent === "string" ? m.next_agent.trim() : "";
    const blockerClass =
      typeof m.blocker_class === "string" ? m.blocker_class.trim() : "";
    if (nextAgent === "operator" && blockerClass !== "") {
      return {
        ok: false,
        refusalCode: "OPERATOR_DECISION_PENDING",
        failedCheck: "operator-decision-not-pending",
        reason: `marker.next_agent="operator" and blocker_class="${blockerClass}" — operator decision required before further dispatch`,
      };
    }
    return { ok: true };
  },
};

/**
 * C — review-needs-human-not-set → REVIEW_NEEDS_HUMAN
 *
 * If epic labels include `human-decision:required`, no auto-progression
 * may fire. The label is the "park for human" signal applied by
 * coherence's send-for-review action; it persists until a human acts.
 *
 * Architecture uses the exact label string `human-decision:required`
 * (NOT `review:needs-human` — that's a different label tracked by
 * BeadSnapshot.hasReviewNeedsHuman; the two are intentionally distinct).
 */
export const PRECOND_REVIEW_NEEDS_HUMAN_NOT_SET: Precondition = {
  name: "review-needs-human-not-set",
  refusalCode: "REVIEW_NEEDS_HUMAN",
  appliesTo(_action) {
    return true;
  },
  evaluate(ctx) {
    if (ctx.epicLabels.includes("human-decision:required")) {
      return {
        ok: false,
        refusalCode: "REVIEW_NEEDS_HUMAN",
        failedCheck: "review-needs-human-not-set",
        reason:
          "epic labels include 'human-decision:required' — auto-dispatch refused; human must act before further progression",
      };
    }
    return { ok: true };
  },
};

/**
 * Ordered universal-predicate list. Evaluation order matters: the
 * BD_READ_FAILED branch (inside A.5 predicates) takes precedence over
 * Class C (per architecture § predicate priority — a null bead snapshot
 * is more fundamental than any marker decision). The order here, plus
 * the early-return in `evaluatePreconditions`, encodes that priority.
 */
export const UNIVERSAL_PRECONDITIONS: readonly Precondition[] = [
  PRECOND_BD_STATUS_NOT_DEFERRED,
  PRECOND_BD_STATUS_NOT_CLOSED,
  PRECOND_OPERATOR_DECISION_NOT_PENDING,
  PRECOND_REVIEW_NEEDS_HUMAN_NOT_SET,
];

// ---------------------------------------------------------------------------
// PRECONDITION_TABLE — minimal Wave-2 registration
//
// Maps action names to ordered predicate lists. ehp.13 will extend each
// entry with per-action predicates AND register the remaining 28 actions
// covered by `route.ts` (38 actions total per architecture). The Wave-2
// table covers the 10 actions ehp.4 may fire — sufficient for the
// load-bearing 372-bead-defer protection landing in Wave 3.
//
// Architecture ADR-004: actions are looked up by name; a missing entry
// is a programmer error (not a silent pass). This file's lookup policy:
// `evaluatePreconditions` returns `{ ok: true }` for unregistered actions
// with a console.warn (so ehp.13's coverage extension is observable as
// it lands action-by-action without failing in-flight dispatches). The
// route.ts coverage check in ehp.13's table-completeness test will assert
// every dispatching action is registered.
// ---------------------------------------------------------------------------

/**
 * Build the per-action predicate list. Each action gets a copy of the
 * universal predicates filtered by `appliesTo` (defensive — every
 * universal predicate's `appliesTo` returns true for all actions, but
 * the filter step makes the contract explicit and survives ehp.13's
 * extension to per-action predicates).
 */
function buildTable(): ReadonlyMap<string, readonly Precondition[]> {
  const table = new Map<string, readonly Precondition[]>();
  for (const action of UNIVERSAL_ACTIONS) {
    const preconditions = UNIVERSAL_PRECONDITIONS.filter((p) =>
      p.appliesTo(action),
    );
    table.set(action, preconditions);
  }
  return table;
}

export const PRECONDITION_TABLE: ReadonlyMap<string, readonly Precondition[]> =
  buildTable();

// ---------------------------------------------------------------------------
// evaluatePreconditions — pure synchronous verdict
//
// Iterates the action's predicate list in order. Returns the FIRST refusal
// (architecture § predicate priority — refusal codes are ordered by class
// importance: A.5 BD_READ_FAILED > A.5 status checks > C operator/review).
// Returns `{ ok: true }` when every predicate passes OR the action is not
// registered in the table.
//
// Unregistered-action policy: returns `{ ok: true }` + warn. This is the
// fail-OPEN choice for unrecognised actions, on the rationale that ehp.13
// will extend the table action-by-action and we don't want existing
// dispatches to fail in-flight while the extension lands. ehp.13's table-
// completeness test catches missing registrations at build time.
// ---------------------------------------------------------------------------

export function evaluatePreconditions(ctx: DispatchContext): PreconditionResult {
  const preconditions = PRECONDITION_TABLE.get(ctx.action);
  if (!preconditions) {
    // Action not yet registered in the minimal Wave-2 table. ehp.13
    // extends this; until then, do not block. This is the documented
    // fail-OPEN policy for unregistered actions.
    console.warn(
      `[dispatch-preconditions] action='${ctx.action}' not registered in PRECONDITION_TABLE — passing through. Wave-3 (beads_web-ehp.13) will register it.`,
    );
    return { ok: true };
  }
  for (const precond of preconditions) {
    const result = precond.evaluate(ctx);
    if (!result.ok) return result;
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// buildDispatchContext — async aggregator
//
// Composes a DispatchContext from the existing reader interfaces:
//   - readBeadStatus(beadId, repoPath)  → BeadSnapshot | null
//   - readMarker(repoPath, markerId)    → MarkerData | null
//   - getEpicLabels(epicId, repoPath)   → string[]
//
// Wave-2 SCAFFOLDS the remaining three fields with safe defaults (false /
// [] / null). ehp.13's builder fills them via `fs.access` (planFileExists),
// a wave-bead query (openWaveBeadIds), and an event-log read for the
// most-recent `pipeline-label-set` event (stageEnteredAt).
//
// Marker filename derivation: per the architecture's marker schema, an
// epic-scope marker is `<epicId>-<stage>.json`. For Wave-2 we read the
// PER-BEAD marker (`<beadId>.json`) — that's the marker that ehp.4's
// caller (marker-driven-routing) inspects. Per the architecture's Seam 2
// (action-classifying for marker reads), the right marker filename
// depends on which action is being dispatched: actions targeting the
// epic stage read epic-scope markers; per-bead actions read per-bead
// markers. The Wave-2 minimal aggregator is designed for the per-bead
// case (ehp.4's load-bearing scenario operates on a bead epicId that
// IS the bead-id at the bd level). ehp.13's builder MAY refine this if
// the per-action predicate set requires reading a different marker.
//
// Input validation: epicId, repoPath, action are required. waveNumber is
// optional (only meaningful for `start-wave` actions; ehp.13's wave-beads
// predicate consumes it). Callers passing bad input get a TypeError —
// programmer error, NOT a refusal (per architecture § Security).
// ---------------------------------------------------------------------------

export interface BuildDispatchContextInput {
  /** Bead identifier (used as bd id AND marker filename root). */
  readonly epicId: string;
  /** Absolute path to the bd repo hosting epicId. */
  readonly repoPath: string;
  /** Action name (must be a recognised action; predicates fire per table). */
  readonly action: string;
  /** Optional wave number — required by Class A's wave-beads-exist (ehp.13). */
  readonly waveNumber?: number;
}

export async function buildDispatchContext(
  input: BuildDispatchContextInput,
): Promise<DispatchContext> {
  // ---- Input validation (programmer errors throw; refusals do not) -----
  if (typeof input.epicId !== "string" || input.epicId.trim() === "") {
    throw new TypeError(
      "buildDispatchContext: epicId must be a non-empty string",
    );
  }
  if (typeof input.repoPath !== "string" || input.repoPath.trim() === "") {
    throw new TypeError(
      "buildDispatchContext: repoPath must be a non-empty string",
    );
  }
  if (typeof input.action !== "string" || input.action.trim() === "") {
    throw new TypeError(
      "buildDispatchContext: action must be a non-empty string",
    );
  }
  if (input.waveNumber !== undefined) {
    if (typeof input.waveNumber !== "number" || input.waveNumber <= 0) {
      throw new TypeError(
        "buildDispatchContext: waveNumber, if provided, must be a positive number",
      );
    }
  }

  // ---- Parallel reads via the published reader interfaces ----------------
  // No internal mocks beyond the readers' own implementations. Each reader
  // tolerates failures internally (returns null / [] on error); we surface
  // those signals via the DispatchContext fields.
  const [bead, marker, epicLabels] = await Promise.all([
    readBeadStatus(input.epicId, input.repoPath),
    readMarker(input.repoPath, input.epicId),
    getEpicLabels(input.epicId, input.repoPath),
  ]);

  return {
    action: input.action,
    bead,
    marker,
    epicLabels,
    // ---- Wave-2 SCAFFOLDED fields (ehp.13 fills) -------------------------
    planFileExists: false,
    openWaveBeadIds: [],
    stageEnteredAt: null,
  };
}
