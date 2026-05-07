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

import { promises as fs } from "fs";
import path from "path";
import type { BeadSnapshot } from "./bead-status-reader";
import { readBeadStatus } from "./bead-status-reader";
import type { MarkerData } from "./marker-reader";
import { readMarker } from "./marker-reader";
import { getEpicLabels } from "./pipeline-labels";
// ehp.13: Class D + E predicates and full buildDispatchContext.
// listOpenWaveBeads is the published wave-bead reader (agent-launcher.ts ~1437)
// that ehp.3's "do not duplicate readers" risk flag explicitly cites.
// listAllStatusWaveBeads (beads_web-m2c) is the sibling reader returning
// wave-N beads of ANY status — drives the new
// PRECOND_WAVE_BEADS_OF_ANY_STATUS_EXIST predicate that distinguishes the
// phantom-wave case from the legitimate post-close review case (the
// 1cb58a5 regression fix).
import { listOpenWaveBeads, listAllStatusWaveBeads } from "./agent-launcher";
// ehp.13 Class E: reuse marker-routing's interpretMarkerForRouting + agent-
// action-map's getActionForAgent rather than re-deriving the routing logic.
// Both are existing pure functions; predicate composes them at evaluation time.
import {
  interpretMarkerForRouting,
  type AgentType,
  type EpicStateSnapshot,
} from "./marker-routing";
import { getActionForAgent } from "./agent-action-map";
// ehp.13 Class D: stage-entered-at is derived from the event-log. We use the
// EXISTING readEvents export (event-log.ts) to find the most-recent
// stage-dispatched event for the (epicId, stage) pair. See § Surprises in
// the marker for the architect-spec → codebase divergence: the architecture
// memo names "pipeline-label-set" but the actual event-log emits
// "stage-dispatched" (verified empirically — see marker for grep evidence).
import { readEvents } from "./event-log";

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
   * beads_web-m2c ADDITIVE — wave-N beads of ANY status (open + in_progress
   * + closed) for the current epic+wave. Populated by `buildDispatchContext`
   * via `listAllStatusWaveBeads`; defaults to [] when waveNumber is absent
   * or the read fails.
   *
   * Used by PRECOND_WAVE_BEADS_OF_ANY_STATUS_EXIST to distinguish the
   * "phantom wave" case (no wave-N beads exist for this epic at all → refuse
   * review-wave) from the "all wave-N beads closed" case (review-wave's
   * legitimate post-close trigger → allow). The 1cb58a5 fix removed
   * `review-wave` from ACTIONS_REQUIRING_WAVE_BEADS to unblock the
   * legitimate post-close case; this field powers the replacement
   * protection that catches the niii reviewer-4-wave-4-redundant phantom
   * dispatch without re-introducing the original bug.
   */
  readonly anyStatusWaveBeadIds: readonly string[];
  /**
   * Wave-2 SCAFFOLDED — defaults to null. ehp.13 fills via an event-log
   * read for the most-recent `pipeline-label-set` event. No Wave-2
   * predicate references this field.
   */
  readonly stageEnteredAt: string | null;
  /**
   * ehp.13 ADDITIVE — optional plan-file mtime in epoch milliseconds.
   * Populated by `buildDispatchContext` via `fs.stat(<plan>).mtimeMs` when
   * `planFileExists === true`; left undefined (NOT null) when plan file
   * absent OR fs.stat fails.
   *
   * Class D's `plan-not-modified-since-stage-entered` predicate compares
   * this against `stageEnteredAt`. Optional (`?:`) so ehp.3's helpers
   * and any caller that constructs DispatchContext literals without
   * mtime knowledge continue to type-check (additive surface; does not
   * narrow ehp.3's contract).
   */
  readonly planFileMtime?: number | null;
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
// ehp.13 — Per-action predicates (Class A: 5; Class B: 3; Class D: 1; Class E: 1)
//
// Each predicate's `appliesTo(action)` declares the action set it gates.
// The PRECONDITION_TABLE registration (further down) selects the union of
// universal predicates (always) plus the per-action predicates whose
// appliesTo returns true for that action.
//
// Action-set helpers — kept here at the predicate site so each predicate's
// applicability is co-located with its definition (audit-friendly per
// ADR-004 self-documentation).
// ---------------------------------------------------------------------------

/**
 * Actions that REQUIRE a plan file at `.beads/plans/<epicId>.md`.
 *
 * Source: per-action handler audits in route.ts (review-plan reads the plan;
 * approve-plan / approve-and-build promote it; review-wave compares plan
 * against built work; revise-plan-* expects the plan to exist for diffing;
 * start-wave consumes the plan to derive Files manifests).
 *
 * NOT included: research / spec / architecture / pre-plan stages, which
 * legitimately predate the plan file.
 */
const ACTIONS_REQUIRING_PLAN_FILE: ReadonlySet<string> = new Set([
  "review-plan",
  "approve-plan",
  "approve-and-build",
  "revise-plan",
  "revise-plan-from-launch",
  "revise-plan-from-review",
  "start-wave",
  "review-wave",
  "send-for-qa",
  "qa-fix-and-retest",
  "send-for-polish",
  "run-polish",
  "run-smoke-test",
]);

/**
 * Actions for which `plan:pending` is a refusal: the plan is not yet
 * finalised so any action that consumes the finalised plan must wait.
 */
const ACTIONS_REFUSED_BY_PLAN_PENDING: ReadonlySet<string> = new Set([
  "review-plan",
  "approve-plan",
  "approve-and-build",
  "start-wave",
  "review-wave",
]);

/**
 * Actions that operate on a wave-N bead set with OPEN beads expected.
 * Both `wave-beads-exist` (NO_WAVE_BEADS) and `wave-beads-not-all-closed`
 * (ALL_WAVE_BEADS_CLOSED) apply here.
 *
 * NOTE (2026-05-07 fix): review-wave was incorrectly listed here. By
 * definition review-wave runs AFTER all wave beads close — having ALL
 * wave-N beads closed is the SUCCESS condition, not a refusal trigger.
 * Both predicates fire on `openWaveBeadIds.length === 0`, which is the
 * EXACT post-close state review-wave is meant to handle. Including
 * review-wave here makes it impossible to dispatch — the design flaw
 * empirically reproduced 2026-05-07 00:17 BST when review-wave 4 was
 * refused with NO_WAVE_BEADS despite all 7 Wave-4 beads being correctly
 * closed. Tracked as part of beads_web-poh.3 (precondition library
 * design fixes follow-on). review-wave preconditions should refuse on
 * "no wave-N beads of ANY status exist" (phantom wave) — a separate
 * predicate not present in v1.
 */
const ACTIONS_REQUIRING_WAVE_BEADS: ReadonlySet<string> = new Set([
  "start-wave",
  "resume-build",
]);

/**
 * Actions that require AT LEAST ONE wave-N bead to exist in ANY status
 * (open, in_progress, OR closed) — i.e., the wave is not "phantom".
 *
 * Source: beads_web-m2c restoration of the niii reviewer-4-wave-4-redundant
 * protection that 1cb58a5 inadvertently dropped. `review-wave` legitimately
 * runs AFTER all wave-N beads close (so it cannot be in
 * ACTIONS_REQUIRING_WAVE_BEADS — that gate refuses on
 * `openWaveBeadIds.length === 0` which is exactly the success state for
 * review-wave). But review-wave MUST refuse when no wave-N beads exist at
 * all (the phantom-wave case where the epic carries `wave:N` and
 * `pipeline:build-review` labels but no wave-N children were ever
 * created — empirically observed in the niii incident). This set drives
 * the new PRECOND_WAVE_BEADS_OF_ANY_STATUS_EXIST predicate that fills
 * that gap without re-introducing 1cb58a5's regression.
 */
const ACTIONS_REQUIRING_ANY_STATUS_WAVE_BEADS: ReadonlySet<string> = new Set([
  "review-wave",
]);

/**
 * Actions that, if a prior architect marker reports status=success, MUST NOT
 * fire (re-architecting on top of a successful architecture is the
 * "premature re-dispatch" failure mode that Class A catches).
 */
const ACTIONS_REFUSED_BY_ARCHITECT_SUCCESS: ReadonlySet<string> = new Set([
  "run-architect",
]);

/**
 * Actions whose handler launches an agent (vs. only mutating labels).
 * `agent-running-has-session` (Class B) refuses these when the bead already
 * has `agent:running` — preventing double-launch.
 */
const ACTIONS_LAUNCHING_AGENT: ReadonlySet<string> = new Set([
  "start-research",
  "more-research",
  "run-pm",
  "run-architect",
  "generate-plan",
  "review-plan",
  "revise-plan",
  "revise-plan-from-launch",
  "revise-plan-from-review",
  "revise-spec",
  "revise-architecture",
  "run-test-spec",
  "revise-test-spec",
  "start-wave",
  "review-wave",
  "resume-build",
  "send-for-qa",
  "qa-fix-and-retest",
  "send-for-polish",
  "run-polish",
  "run-smoke-test",
  "run-coherence-agent",
  "send-for-review",
  "send-for-development",
]);

/**
 * Actions that progress QA rounds. `qa-round-monotonic` (Class B) gates
 * round-N+1 dispatch on round-N marker existence + status=success.
 */
const ACTIONS_QA_ROUND_PROGRESSING: ReadonlySet<string> = new Set([
  "send-for-qa",
  "qa-fix-and-retest",
]);

/**
 * Actions sensitive to plan-file modification after the current pipeline
 * stage was entered (Class D: PLAN_INSTABILITY).
 */
const ACTIONS_PLAN_STABILITY_SENSITIVE: ReadonlySet<string> = new Set([
  "review-plan",
  "approve-plan",
  "approve-and-build",
  "review-wave",
  "start-wave",
]);

// ---------------------------------------------------------------------------
// Class A predicates (ehp.13 — 5)
// ---------------------------------------------------------------------------

/**
 * A — plan-file-exists → PLAN_FILE_MISSING
 *
 * Refuses dispatch when the plan file at `.beads/plans/<epicId>.md` is
 * absent and the action requires it. `planFileExists` is populated by
 * `buildDispatchContext` via `fs.access`. Per Seam 3 (architecture) the
 * fail-closed posture: any fs error other than ENOENT becomes
 * `planFileExists=false` (treated as missing → PLAN_FILE_MISSING).
 */
export const PRECOND_PLAN_FILE_EXISTS: Precondition = {
  name: "plan-file-exists",
  refusalCode: "PLAN_FILE_MISSING",
  appliesTo(action) {
    return ACTIONS_REQUIRING_PLAN_FILE.has(action);
  },
  evaluate(ctx) {
    if (!ctx.planFileExists) {
      return {
        ok: false,
        refusalCode: "PLAN_FILE_MISSING",
        failedCheck: "plan-file-exists",
        reason: `no plan file at .beads/plans/<epicId>.md (action=${ctx.action} requires the plan file to exist)`,
      };
    }
    return { ok: true };
  },
};

/**
 * A — plan-not-pending → PLAN_PENDING
 *
 * Refuses when the epic still carries the `plan:pending` label and the
 * action is one that consumes a finalised plan (review-plan, approve-plan,
 * approve-and-build, start-wave, review-wave).
 *
 * The label spelling `plan:pending` mirrors what the planner sets when
 * the plan is drafted but awaiting review (verified against existing
 * pipeline-labels usage in factory-core's standing orders).
 */
export const PRECOND_PLAN_NOT_PENDING: Precondition = {
  name: "plan-not-pending",
  refusalCode: "PLAN_PENDING",
  appliesTo(action) {
    return ACTIONS_REFUSED_BY_PLAN_PENDING.has(action);
  },
  evaluate(ctx) {
    if (ctx.epicLabels.includes("plan:pending")) {
      return {
        ok: false,
        refusalCode: "PLAN_PENDING",
        failedCheck: "plan-not-pending",
        reason: `epic carries 'plan:pending' label — plan not finalised; action=${ctx.action} requires the finalised plan`,
      };
    }
    return { ok: true };
  },
};

/**
 * A — wave-beads-exist → NO_WAVE_BEADS
 *
 * Refuses wave-related dispatch when no open wave-N beads exist. The
 * predicate fires when `openWaveBeadIds.length === 0`. v1 limitation: this
 * predicate cannot distinguish "no wave-N beads at all" (NO_WAVE_BEADS)
 * from "wave-N beads exist but all are closed" (ALL_WAVE_BEADS_CLOSED) —
 * both cases produce an empty `openWaveBeadIds` from the existing
 * `listOpenWaveBeads` reader. The `wave-beads-not-all-closed` sibling
 * predicate (registered alongside) provides defensive double-coverage; the
 * first predicate to fire wins. Both refusal codes are valid per the
 * canonical RefusalCode enum so downstream tests should accept either
 * (per beads_web-ehp.12 risk flag #3 — assert refusalCode ∈ enum, not
 * specific code).
 */
export const PRECOND_WAVE_BEADS_EXIST: Precondition = {
  name: "wave-beads-exist",
  refusalCode: "NO_WAVE_BEADS",
  appliesTo(action) {
    return ACTIONS_REQUIRING_WAVE_BEADS.has(action);
  },
  evaluate(ctx) {
    if (ctx.openWaveBeadIds.length === 0) {
      return {
        ok: false,
        refusalCode: "NO_WAVE_BEADS",
        failedCheck: "wave-beads-exist",
        reason: `no open wave beads found for action=${ctx.action} (openWaveBeadIds is empty — either no wave-N beads exist or all are closed)`,
      };
    }
    return { ok: true };
  },
};

/**
 * A — wave-beads-not-all-closed → ALL_WAVE_BEADS_CLOSED
 *
 * Sibling to `wave-beads-exist`. Same fire condition (openWaveBeadIds
 * empty) — registered for defensive double-coverage at review-wave
 * (per ehp.7 prompt: "the library's PRECONDITION_TABLE for review-wave
 * should register both"). The first predicate to fire wins; v1 cannot
 * disambiguate the two states from `openWaveBeadIds` alone without an
 * additional bd query.
 */
export const PRECOND_WAVE_BEADS_NOT_ALL_CLOSED: Precondition = {
  name: "wave-beads-not-all-closed",
  refusalCode: "ALL_WAVE_BEADS_CLOSED",
  appliesTo(action) {
    return ACTIONS_REQUIRING_WAVE_BEADS.has(action);
  },
  evaluate(ctx) {
    if (ctx.openWaveBeadIds.length === 0) {
      return {
        ok: false,
        refusalCode: "ALL_WAVE_BEADS_CLOSED",
        failedCheck: "wave-beads-not-all-closed",
        reason: `no open wave beads for action=${ctx.action} — likely all wave beads are already closed (review/redispatch redundant)`,
      };
    }
    return { ok: true };
  },
};

/**
 * A — wave-beads-of-any-status-exist → NO_WAVE_BEADS  (beads_web-m2c)
 *
 * Restores the niii reviewer-4-wave-4-redundant protection that the 1cb58a5
 * fix inadvertently dropped. Fires for `review-wave` ONLY when there are
 * NO wave-N beads of ANY status (open, in_progress, OR closed) for the
 * epic+wave — i.e., a "phantom wave" where the epic carries `wave:N` +
 * `pipeline:build-review` labels but no wave-N children exist at all.
 *
 * Why a separate predicate (not just appliesTo on PRECOND_WAVE_BEADS_EXIST):
 * The existing PRECOND_WAVE_BEADS_EXIST and PRECOND_WAVE_BEADS_NOT_ALL_CLOSED
 * predicates fire on `openWaveBeadIds.length === 0`, which is the LEGITIMATE
 * success state for `review-wave` (the review runs AFTER every wave-N bead
 * closes). Including review-wave in `ACTIONS_REQUIRING_WAVE_BEADS` (the
 * pre-1cb58a5 state) inverted the semantic and refused the legitimate
 * post-close case — empirically reproduced 2026-05-07 00:17 BST. This
 * predicate uses the DIFFERENT `anyStatusWaveBeadIds` signal so the two
 * states are distinguishable: empty open + non-empty any-status = "all
 * closed" (legitimate, allow); empty open + empty any-status = "phantom"
 * (refuse).
 *
 * Refusal code is NO_WAVE_BEADS (matches the integration test's enum-subset
 * assertion at missed-wave-review-dispatch.precondition-integration.test.ts
 * line 358-360).
 */
export const PRECOND_WAVE_BEADS_OF_ANY_STATUS_EXIST: Precondition = {
  name: "wave-beads-of-any-status-exist",
  refusalCode: "NO_WAVE_BEADS",
  appliesTo(action) {
    return ACTIONS_REQUIRING_ANY_STATUS_WAVE_BEADS.has(action);
  },
  evaluate(ctx) {
    if (ctx.anyStatusWaveBeadIds.length === 0) {
      return {
        ok: false,
        refusalCode: "NO_WAVE_BEADS",
        failedCheck: "wave-beads-of-any-status-exist",
        reason: `no wave beads of ANY status found for action=${ctx.action} — phantom wave (no wave-N beads exist for this epic at all; review/redispatch would target nothing)`,
      };
    }
    return { ok: true };
  },
};

/**
 * A — architect-marker-not-success → ARCHITECT_MARKER_SUCCESS
 *
 * Refuses re-dispatch of run-architect when the prior architect marker
 * reports status=success (reading would re-do work that's already done).
 * Marker filename derivation matches `buildDispatchContext`'s convention
 * (per-bead marker `<epicId>.json`) — the routing-aware schema's stage
 * field carries the agent name; we check stage==='architect' and
 * status==='success'.
 */
export const PRECOND_ARCHITECT_MARKER_NOT_SUCCESS: Precondition = {
  name: "architect-marker-not-success",
  refusalCode: "ARCHITECT_MARKER_SUCCESS",
  appliesTo(action) {
    return ACTIONS_REFUSED_BY_ARCHITECT_SUCCESS.has(action);
  },
  evaluate(ctx) {
    const m = ctx.marker;
    if (!m) return { ok: true };
    if (m.stage === "architect" && m.status === "success") {
      return {
        ok: false,
        refusalCode: "ARCHITECT_MARKER_SUCCESS",
        failedCheck: "architect-marker-not-success",
        reason: `prior architect marker has status=success — re-dispatching run-architect would re-do completed work`,
      };
    }
    return { ok: true };
  },
};

// ---------------------------------------------------------------------------
// Class B predicates (ehp.13 — 3)
// ---------------------------------------------------------------------------

/**
 * B — pipeline-label-singleton → PIPELINE_LABEL_CONFLICT
 *
 * Refuses when the epic already carries multiple `pipeline:*` labels. This
 * is a state-already-conflicted check: the next mutation would not be
 * able to cleanly add a new pipeline label without first removing the
 * conflicting set, and the route handler's existing
 * `removeAllPipelineLabels` + `addLabelsToEpic` pattern is not atomic.
 * Refusing here forces the operator to clean up the existing conflict
 * before further dispatch.
 *
 * applicability: every action that mutates pipeline labels (most
 * dispatching actions). The check is cheap (single label scan).
 */
export const PRECOND_PIPELINE_LABEL_SINGLETON: Precondition = {
  name: "pipeline-label-singleton",
  refusalCode: "PIPELINE_LABEL_CONFLICT",
  appliesTo(_action) {
    return true; // applies to every dispatching action — pipeline label
    //              singleton is an epic-level invariant, not action-specific.
  },
  evaluate(ctx) {
    const pipelineLabels = ctx.epicLabels.filter((l) =>
      l.startsWith("pipeline:"),
    );
    if (pipelineLabels.length > 1) {
      return {
        ok: false,
        refusalCode: "PIPELINE_LABEL_CONFLICT",
        failedCheck: "pipeline-label-singleton",
        reason: `epic has multiple pipeline:* labels [${pipelineLabels.join(", ")}] — cannot dispatch without first resolving the label conflict`,
      };
    }
    return { ok: true };
  },
};

/**
 * B — agent-running-has-session → AGENT_RUNNING_NO_SESSION
 *
 * Refuses agent-launching actions when the bead already has the
 * `agent:running` label set. The label semantically means "an agent is
 * already claimed for this bead"; launching another would race.
 *
 * v1 simplification: we cannot synchronously verify a tmux session
 * exists from the precondition layer (no published reader for tmux state
 * in the predicate-pure-sync contract). The `bead.hasAgentRunning` flag
 * IS the proxy — if the label is set, refuse the launch. This catches
 * the actual production failure mode (orphaned `agent:running` label
 * after a tmux session crash); operator clears the label, dispatch
 * resumes.
 *
 * Naming note: the refusal code is `AGENT_RUNNING_NO_SESSION` (architecture
 * spec) which conflates "label set + no session" with "label set". v1 fires
 * on label-set; the "no session" half is the post-condition the operator
 * verifies during cleanup. Documented as a v1 limitation.
 */
export const PRECOND_AGENT_RUNNING_HAS_SESSION: Precondition = {
  name: "agent-running-has-session",
  refusalCode: "AGENT_RUNNING_NO_SESSION",
  appliesTo(action) {
    return ACTIONS_LAUNCHING_AGENT.has(action);
  },
  evaluate(ctx) {
    if (ctx.bead === null) {
      // Defer to A.5 BD_READ_FAILED — universal predicates run first.
      return { ok: true };
    }
    if (ctx.bead.hasAgentRunning) {
      return {
        ok: false,
        refusalCode: "AGENT_RUNNING_NO_SESSION",
        failedCheck: "agent-running-has-session",
        reason: `bead ${ctx.bead.id} has 'agent:running' label set — launching another agent for action=${ctx.action} would race`,
      };
    }
    return { ok: true };
  },
};

/**
 * B — qa-round-monotonic → QA_ROUND_OUT_OF_ORDER
 *
 * For QA-progressing actions, refuse round-(N+1) dispatch if the
 * round-N marker is missing or its status is not 'success'. The current
 * round N is sourced from `bead.currentQaRound` (derived from
 * `qa:round-N` labels at snapshot time).
 *
 * v1 limitation: the predicate only inspects ctx.marker (the per-bead
 * marker). The QA round marker filename pattern is
 * `<epicId>-qa-round-<N>.json` (verified against route.ts:1716/2512 and
 * repeated-qa-round.ts:17). buildDispatchContext does NOT today read
 * the QA-round-specific marker (the architecture's Seam 2 calls this
 * "action-classifying for marker reads"); the predicate falls open
 * (returns ok=true) when ctx.marker doesn't carry qa-round metadata.
 *
 * Concrete v1 behaviour: refuse only when ctx.bead.currentQaRound > 0
 * AND ctx.marker is non-null AND its `stage`/`bead_id` indicate a
 * QA-round marker AND its status !== 'success'. Otherwise pass. This
 * is conservative: false negatives possible (real QA-round marker
 * absent), but no false positives. The action route's existing inline
 * QA-round check at route.ts:1665+ remains the load-bearing gate;
 * Class B here adds defense-in-depth at the precondition layer.
 */
export const PRECOND_QA_ROUND_MONOTONIC: Precondition = {
  name: "qa-round-monotonic",
  refusalCode: "QA_ROUND_OUT_OF_ORDER",
  appliesTo(action) {
    return ACTIONS_QA_ROUND_PROGRESSING.has(action);
  },
  evaluate(ctx) {
    if (ctx.bead === null) return { ok: true }; // defer to A.5
    const round = ctx.bead.currentQaRound;
    if (round === null || round < 1) return { ok: true };
    const m = ctx.marker;
    // If no marker is loaded, fall open — the route handler's inline
    // QA-round check (route.ts:1665+) remains load-bearing.
    if (!m) return { ok: true };
    // Heuristic: a QA-round marker has stage 'qa' or 'qa-round' or its
    // bead_id contains '-qa-round-'. If we identify it as a QA-round
    // marker AND its status is not success, refuse.
    const stage = typeof m.stage === "string" ? m.stage.trim() : "";
    const beadId = typeof m.bead_id === "string" ? m.bead_id : "";
    const isQaRoundMarker =
      stage === "qa" ||
      stage === "qa-round" ||
      stage.startsWith("qa-round") ||
      /-qa-round-\d+/.test(beadId);
    if (isQaRoundMarker && m.status !== "success") {
      return {
        ok: false,
        refusalCode: "QA_ROUND_OUT_OF_ORDER",
        failedCheck: "qa-round-monotonic",
        reason: `QA round marker (stage=${stage}, status=${m.status}) does not report success — round-${round + 1} dispatch refused until current round resolves`,
      };
    }
    return { ok: true };
  },
};

// ---------------------------------------------------------------------------
// Class D predicate (ehp.13 — 1)
// ---------------------------------------------------------------------------

/**
 * D — plan-not-modified-since-stage-entered → PLAN_INSTABILITY
 *
 * Refuses dispatch when the plan file's mtime is newer than when the
 * epic entered its current pipeline stage. Indicates the plan was
 * revised after the stage transition; downstream review/build is
 * operating on a moving target.
 *
 * **Fail-OPEN posture (deliberate exception to ADR-002's fail-closed
 * default for bd reads).** Class D's source signal is the event-log,
 * which per `event-log.ts` is RESILIENCE-FIRST: read failures are
 * documented as "missed events are tolerable; broken pipelines are not"
 * (event-log.ts comment at line 26-30). When `stageEnteredAt` is null
 * (event-log read returned no matching event OR the read itself
 * failed), the predicate skips — returning ok=true. This is the
 * INVERSE of A.5's BD_READ_FAILED behaviour: bd reads are fail-closed
 * (a phantom dispatch is worse than a missed legitimate dispatch),
 * but event-log reads are fail-open (the event log is telemetry,
 * not source of truth). Both postures are documented in their
 * respective ADRs.
 *
 * Similarly, when `planFileMtime` is undefined or null (file absent
 * OR fs.stat failed), the predicate skips — Class A's PLAN_FILE_MISSING
 * already gates plan-required actions; Class D layers on top.
 */
export const PRECOND_PLAN_NOT_MODIFIED_SINCE_STAGE_ENTERED: Precondition = {
  name: "plan-not-modified-since-stage-entered",
  refusalCode: "PLAN_INSTABILITY",
  appliesTo(action) {
    return ACTIONS_PLAN_STABILITY_SENSITIVE.has(action);
  },
  evaluate(ctx) {
    // Fail-OPEN: missing telemetry → skip (cannot determine staleness).
    if (ctx.stageEnteredAt === null) return { ok: true };
    if (ctx.planFileMtime === undefined || ctx.planFileMtime === null) {
      return { ok: true };
    }
    const stageEnteredMs = Date.parse(ctx.stageEnteredAt);
    if (Number.isNaN(stageEnteredMs)) return { ok: true }; // malformed → skip
    if (ctx.planFileMtime > stageEnteredMs) {
      return {
        ok: false,
        refusalCode: "PLAN_INSTABILITY",
        failedCheck: "plan-not-modified-since-stage-entered",
        reason: `plan file modified at ${new Date(ctx.planFileMtime).toISOString()} — newer than stage entered at ${ctx.stageEnteredAt}; review/build would target a moving plan`,
      };
    }
    return { ok: true };
  },
};

// ---------------------------------------------------------------------------
// Class E predicate (ehp.13 — 1)
// ---------------------------------------------------------------------------

/**
 * E — action-matches-marker-next-agent → ACTION_NEXT_AGENT_MISMATCH
 *
 * Refuses when the action being dispatched does not match the canonical
 * action for the marker's `next_agent` (after marker-routing's loop-agent
 * rewrite per ADR-001). Reuses existing `interpretMarkerForRouting` +
 * `getActionForAgent` rather than re-deriving the routing logic.
 *
 * Pass conditions (predicate skips with ok=true):
 *   - No marker loaded.
 *   - Marker loaded but `interpretMarkerForRouting` returns
 *     `override=false` (the marker doesn't dictate a specific next
 *     action; pipeline-routes default progression applies).
 *   - Marker's routing decision matches the action being dispatched.
 *
 * Refuse condition: marker has explicit override AND the canonical
 * action for the routed agent differs from `ctx.action`.
 */
export const PRECOND_ACTION_MATCHES_MARKER_NEXT_AGENT: Precondition = {
  name: "action-matches-marker-next-agent",
  refusalCode: "ACTION_NEXT_AGENT_MISMATCH",
  appliesTo(_action) {
    return true; // applies universally — Class E is "action vs marker"
    //              consistency, valid for every dispatching action.
  },
  evaluate(ctx) {
    const m = ctx.marker;
    if (!m) return { ok: true };
    // Build a minimal EpicStateSnapshot — interpretMarkerForRouting's
    // EpicStateSnapshot parameter is currently unused by the function
    // (see marker-routing.ts: `_snapshot` underscore-prefixed),
    // but constructing a real snapshot keeps us future-proof if the
    // function later consumes it.
    const beadId = ctx.bead?.id ?? (typeof m.bead_id === "string" ? m.bead_id : "");
    const snapshot: EpicStateSnapshot = {
      epicId: beadId,
      currentStage: ctx.bead?.pipelineStage ?? "",
      labels: [...ctx.epicLabels],
    };
    const decision = interpretMarkerForRouting(m, snapshot);
    if (!decision.override) return { ok: true };
    if (!decision.nextAgent) return { ok: true };
    const canonicalAction = getActionForAgent(decision.nextAgent as AgentType);
    if (canonicalAction === ctx.action) return { ok: true };
    return {
      ok: false,
      refusalCode: "ACTION_NEXT_AGENT_MISMATCH",
      failedCheck: "action-matches-marker-next-agent",
      reason: `action='${ctx.action}' contradicts marker routing decision (next_agent='${decision.nextAgent}' → canonical action='${canonicalAction}'; reason: ${decision.reason})`,
    };
  },
};

/**
 * Snapshot of every per-action predicate ehp.13 ships — exported for tests
 * that assert PRECONDITION_TABLE coverage and for the table builder.
 */
export const PER_ACTION_PRECONDITIONS: readonly Precondition[] = [
  // Class A
  PRECOND_PLAN_FILE_EXISTS,
  PRECOND_PLAN_NOT_PENDING,
  PRECOND_WAVE_BEADS_EXIST,
  PRECOND_WAVE_BEADS_NOT_ALL_CLOSED,
  PRECOND_WAVE_BEADS_OF_ANY_STATUS_EXIST, // beads_web-m2c (review-wave only)
  PRECOND_ARCHITECT_MARKER_NOT_SUCCESS,
  // Class B
  PRECOND_PIPELINE_LABEL_SINGLETON,
  PRECOND_AGENT_RUNNING_HAS_SESSION,
  PRECOND_QA_ROUND_MONOTONIC,
  // Class D
  PRECOND_PLAN_NOT_MODIFIED_SINCE_STAGE_ENTERED,
  // Class E
  PRECOND_ACTION_MATCHES_MARKER_NEXT_AGENT,
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
// ehp.13 — DISPATCHING_ACTIONS + extended PRECONDITION_TABLE
//
// Audit basis: route.ts has 37 unique action case branches (verified via
// `grep -n "case ['\"]" src/app/api/fleet/action/route.ts | sort -u`).
// Of those, 3 are EXEMPT per beads_web-ehp.11 (only mutate `human-decision:*`
// labels OR stop a running agent — no pipeline:* mutation, no agent launch):
//   - stop-agent     (only stops a running agent)
//   - human-approve  (only mutates human-decision:* labels)
//   - human-dismiss  (only mutates human-decision:* labels)
//
// The remaining 34 actions are DISPATCHING and registered in the extended
// table. Reconciler-rule actions (run-coherence-agent, start-wave,
// run-smoke-test, etc.) are all subsets of route.ts's action set; no
// reconciler-only action exists outside this 34-element set.
//
// The bead description's "~38 dispatching actions" count tracks the
// architecture's File Structure Plan (~38 case branches), which includes
// the 3 EXEMPT cases. ehp.13 honours the dispatching subset — exempt
// cases are not in the table by design.
// ---------------------------------------------------------------------------

/**
 * The 34 dispatching actions that ehp.13 registers in the extended
 * PRECONDITION_TABLE. EXEMPT actions (stop-agent, human-approve,
 * human-dismiss) are intentionally NOT in this set.
 */
export const DISPATCHING_ACTIONS: ReadonlyArray<string> = [
  // From route.ts case branches — DISPATCHING subset (34 total).
  "start-research",
  "send-for-development",
  "more-research",
  "deprioritise",
  "approve-submission",
  "send-back-to-dev",
  "mark-as-live",
  "generate-plan",
  "approve-plan",
  "approve-and-build",
  "revise-plan",
  "skip-to-plan",
  "revise-plan-from-launch",
  "send-for-qa",
  "qa-fix-and-retest",
  "mark-ready-to-deploy",
  "mark-venture-live",
  "mark-venture-complete",
  "start-wave",
  "review-wave",
  "resume-build",
  "send-for-review",
  "send-for-polish",
  "run-pm",
  "run-architect",
  "run-smoke-test",
  "run-polish",
  "revise-spec",
  "revise-architecture",
  "run-test-spec",
  "revise-test-spec",
  "review-plan",
  "revise-plan-from-review",
  "run-coherence-agent",
];

/**
 * The 3 EXEMPT actions (per beads_web-ehp.11 audit). Exported for tests
 * that assert "exempt actions are NOT in PRECONDITION_TABLE".
 */
export const EXEMPT_ACTIONS: ReadonlyArray<string> = [
  "stop-agent",
  "human-approve",
  "human-dismiss",
];

/**
 * Build the extended PRECONDITION_TABLE that includes ALL 34 dispatching
 * actions, registering universal predicates + per-action predicates whose
 * `appliesTo(action)` returns true.
 *
 * Ordering invariant per architecture § predicate priority:
 *   1. Universal predicates first (BD_READ_FAILED branches via A.5
 *      take precedence over per-action checks).
 *   2. Per-action predicates in PER_ACTION_PRECONDITIONS list order
 *      (Class A → B → D → E).
 */
function buildExtendedTable(): ReadonlyMap<string, readonly Precondition[]> {
  const table = new Map<string, readonly Precondition[]>();
  for (const action of DISPATCHING_ACTIONS) {
    const universal = UNIVERSAL_PRECONDITIONS.filter((p) =>
      p.appliesTo(action),
    );
    const perAction = PER_ACTION_PRECONDITIONS.filter((p) =>
      p.appliesTo(action),
    );
    table.set(action, [...universal, ...perAction]);
  }
  return table;
}

/**
 * The full PRECONDITION_TABLE used by `evaluatePreconditions` after ehp.13
 * lands. Replaces the Wave-2 minimal `PRECONDITION_TABLE` for
 * lookup purposes (the Wave-2 export remains for backwards-compatibility
 * with ehp.3 tests that asserted the minimal 10-action shape).
 *
 * `evaluatePreconditions` consults `EXTENDED_PRECONDITION_TABLE` first
 * for any action in `DISPATCHING_ACTIONS`; falls back to the minimal
 * table for the universal-action set; warns + passes for unknown actions.
 */
export const EXTENDED_PRECONDITION_TABLE: ReadonlyMap<
  string,
  readonly Precondition[]
> = buildExtendedTable();

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
  // ehp.13: consult the EXTENDED table first (covers all 34 dispatching
  // actions with universal + per-action predicates). Fall back to the
  // Wave-2 minimal table for the 10 universal-action set (preserves
  // ehp.3's contract — minimal table coverage tests still pass). Unknown
  // actions: warn + pass (preserves ehp.3's fail-OPEN policy for
  // unregistered actions; EXEMPT_ACTIONS land here intentionally).
  const preconditions =
    EXTENDED_PRECONDITION_TABLE.get(ctx.action) ??
    PRECONDITION_TABLE.get(ctx.action);
  if (!preconditions) {
    console.warn(
      `[dispatch-preconditions] action='${ctx.action}' not registered in PRECONDITION_TABLE — passing through (EXEMPT actions land here by design; unregistered dispatching actions are a coverage gap).`,
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
  const [
    bead,
    marker,
    epicLabels,
    planFileMeta,
    openWaveBeadIds,
    anyStatusWaveBeadIds,
  ] = await Promise.all([
    readBeadStatus(input.epicId, input.repoPath),
    readMarker(input.repoPath, input.epicId),
    getEpicLabels(input.epicId, input.repoPath),
    // ehp.13: plan-file existence + mtime (Class A PLAN_FILE_MISSING +
    // Class D PLAN_INSTABILITY). Per architecture Seam 3, fail-closed:
    // any fs error other than ENOENT is treated as exists=false.
    readPlanFileMeta(input.repoPath, input.epicId),
    // ehp.13: open wave beads (Class A NO_WAVE_BEADS / ALL_WAVE_BEADS_CLOSED).
    // Reuses the existing `listOpenWaveBeads` reader — does NOT duplicate.
    // When waveNumber is undefined, we skip the read (no wave context).
    input.waveNumber !== undefined
      ? safeListOpenWaveBeads(
          input.epicId,
          input.waveNumber,
          input.repoPath,
        )
      : Promise.resolve<readonly string[]>([]),
    // beads_web-m2c: ALL-status wave beads (Class A NO_WAVE_BEADS via
    // PRECOND_WAVE_BEADS_OF_ANY_STATUS_EXIST — phantom-wave protection
    // for review-wave). Reuses `listAllStatusWaveBeads` (the new
    // sibling export of listOpenWaveBeads); when waveNumber is undefined
    // we skip the read.
    input.waveNumber !== undefined
      ? safeListAllStatusWaveBeads(
          input.epicId,
          input.waveNumber,
          input.repoPath,
        )
      : Promise.resolve<readonly string[]>([]),
  ]);

  // ehp.13: Class D stageEnteredAt — read event-log for the most-recent
  // stage-dispatched event matching this epic+stage. Sequenced AFTER the
  // bead read because we need bead.pipelineStage to know which stage to
  // filter on. Fail-OPEN per Class D commentary (event-log read failure
  // → null → predicate skips). The architecture spec named the event
  // type "pipeline-label-set" but the codebase actually emits
  // "stage-dispatched" (verified empirically — see ehp.13 marker
  // surprises_or_findings).
  let stageEnteredAt: string | null = null;
  if (bead && bead.pipelineStage) {
    try {
      const events = await readEvents(input.repoPath, {
        type: "stage-dispatched",
        epicId: input.epicId,
        limit: 50, // small lookback; events are newest-first
      });
      // Find the most-recent event matching this stage. readEvents returns
      // newest-first; the first match is the most-recent transition INTO
      // the current stage.
      const match = events.find((e) => e.stage === bead.pipelineStage);
      if (match) stageEnteredAt = match.timestamp;
    } catch (err) {
      // Fail-OPEN per Class D commentary — event-log is telemetry, not
      // source of truth. Predicate will skip when stageEnteredAt is null.
      console.warn(
        `[dispatch-preconditions] event-log read failed for epic=${input.epicId} stage=${bead.pipelineStage} — Class D PLAN_INSTABILITY will skip:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return {
    action: input.action,
    bead,
    marker,
    epicLabels,
    planFileExists: planFileMeta.exists,
    openWaveBeadIds,
    anyStatusWaveBeadIds,
    stageEnteredAt,
    planFileMtime: planFileMeta.mtimeMs,
  };
}

// ---------------------------------------------------------------------------
// ehp.13 helpers — small wrappers around the published readers. These live
// in this file (not in a separate reader module) per ADR-003 single-file
// library and to avoid creating new exports that downstream callers might
// import for non-precondition use (single responsibility).
// ---------------------------------------------------------------------------

interface PlanFileMeta {
  readonly exists: boolean;
  readonly mtimeMs: number | null;
}

/**
 * Read the plan file's existence + mtime. Per architecture Seam 3:
 * - File present + readable → exists=true, mtimeMs=fs.stat.mtimeMs.
 * - ENOENT → exists=false, mtimeMs=null (the documented "no plan file" case).
 * - Other fs errors (EACCES, EIO) → exists=false, mtimeMs=null with a
 *   single-line warn (fail-closed: PLAN_FILE_MISSING fires, operator
 *   re-triggers after fixing the filesystem).
 */
async function readPlanFileMeta(
  repoPath: string,
  epicId: string,
): Promise<PlanFileMeta> {
  const planPath = path.join(repoPath, ".beads", "plans", `${epicId}.md`);
  try {
    const stat = await fs.stat(planPath);
    return { exists: true, mtimeMs: stat.mtimeMs };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      console.warn(
        `[dispatch-preconditions] fs.stat failed for plan ${planPath} (code=${code}) — treating as missing per Seam 3 fail-closed`,
      );
    }
    return { exists: false, mtimeMs: null };
  }
}

/**
 * Wrap `listOpenWaveBeads` with a try/catch that returns `[]` on error.
 * The underlying reader THROWS on bd failures (per factory-core-z9h.9
 * contract — see agent-launcher.ts:1437); the precondition library
 * cannot let those throws propagate or `buildDispatchContext` would
 * become a non-total function. Instead we surface bd-read failures
 * here as an empty array (consistent with the other reader's
 * "null on failure" pattern); the NO_WAVE_BEADS / ALL_WAVE_BEADS_CLOSED
 * predicates will fire as the structured signal of "wave state
 * could not be determined". Logged for observability.
 */
async function safeListOpenWaveBeads(
  epicId: string,
  wave: number,
  repoPath: string,
): Promise<readonly string[]> {
  try {
    const beads = await listOpenWaveBeads(epicId, wave, repoPath);
    return beads.map((b) => b.id);
  } catch (err) {
    console.warn(
      `[dispatch-preconditions] listOpenWaveBeads threw for epic=${epicId} wave=${wave} — treating as empty:`,
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

/**
 * Sibling of `safeListOpenWaveBeads` for `listAllStatusWaveBeads` — returns
 * wave-N beads of ANY status (open + in_progress + closed). Drives the
 * PRECOND_WAVE_BEADS_OF_ANY_STATUS_EXIST predicate (beads_web-m2c) so
 * review-wave dispatches against phantom waves are refused without
 * re-introducing the 1cb58a5 bug. Same fail-closed degradation as the
 * sibling: bd errors → [] + warn → predicate fires NO_WAVE_BEADS.
 */
async function safeListAllStatusWaveBeads(
  epicId: string,
  wave: number,
  repoPath: string,
): Promise<readonly string[]> {
  try {
    const beads = await listAllStatusWaveBeads(epicId, wave, repoPath);
    return beads.map((b) => b.id);
  } catch (err) {
    console.warn(
      `[dispatch-preconditions] listAllStatusWaveBeads threw for epic=${epicId} wave=${wave} — treating as empty:`,
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

// ---------------------------------------------------------------------------
// PreconditionRefusalResponse — HTTP 412 body helper (ehp.13 Contract 3)
//
// Projects a refusal `PreconditionResult` into the HTTP-412 response body
// shape consumed by route.ts (per architecture § Component Boundaries
// Contract 3). Includes `observedState` so coherence reasoning can
// pattern-match on the bead/marker/labels at refusal time without re-
// reading.
//
// Used by route.ts (ehp.11 integration site) to emit:
//   return NextResponse.json(
//     buildPreconditionRefusalResponse(result, ctx.bead),
//     { status: 412 }
//   );
// ---------------------------------------------------------------------------

/**
 * The HTTP 412 body shape returned by route.ts when a precondition refuses.
 *
 * Mirrors architecture § Component Boundaries Contract 3:
 *   - `refused: true` is the discriminator.
 *   - `refusalCode`, `failedCheck`, `reason` from the PreconditionResult.
 *   - `observedState` is a small bead snapshot for downstream pattern-
 *     matching (coherence reasoning consumes this).
 */
export interface PreconditionRefusalResponse {
  readonly refused: true;
  readonly refusalCode: RefusalCode;
  readonly failedCheck: string;
  readonly reason: string;
  readonly observedState: {
    readonly beadId: string | null;
    readonly status: string | null;
    readonly pipelineStage: string | null;
    readonly currentWave: number | null;
    readonly currentQaRound: number | null;
    readonly hasAgentRunning: boolean;
    readonly hasReviewNeedsHuman: boolean;
  };
}

/**
 * Type for the refusal branch of PreconditionResult — exported so callers
 * can write `if (!result.ok) buildPreconditionRefusalResponse(result, …)`
 * with full type narrowing.
 */
export type PreconditionRefusal = Extract<PreconditionResult, { ok: false }>;

/**
 * Project a refusal `PreconditionResult` + bead snapshot into the HTTP 412
 * response body shape.
 *
 * The function is total — accepts any refusal shape (every RefusalCode
 * value is in the canonical enum) and any BeadSnapshot (or null when bd
 * read failed). When bead is null, observedState fields default to safe
 * "unknown" sentinels (null / false / 0).
 *
 * Pure function: no I/O, no side effects. Safe to call from any context.
 */
export function buildPreconditionRefusalResponse(
  result: PreconditionRefusal,
  bead: BeadSnapshot | null,
): PreconditionRefusalResponse {
  return {
    refused: true,
    refusalCode: result.refusalCode,
    failedCheck: result.failedCheck,
    reason: result.reason,
    observedState: {
      beadId: bead?.id ?? null,
      status: bead?.status ?? null,
      pipelineStage: bead?.pipelineStage ?? null,
      currentWave: bead?.currentWave ?? null,
      currentQaRound: bead?.currentQaRound ?? null,
      hasAgentRunning: bead?.hasAgentRunning ?? false,
      hasReviewNeedsHuman: bead?.hasReviewNeedsHuman ?? false,
    },
  };
}
