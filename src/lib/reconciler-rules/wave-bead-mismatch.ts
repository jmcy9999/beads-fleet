/**
 * factory-core-zsjv.2 — Wave-bead-mismatch detector.
 *
 * Catches the structural anomaly that BreathCycle (factory-core-jtjn)
 * exposed: an epic has a pipeline:* label implying post-development
 * (qa, ux-polish, submission-prep, etc.) but still has open wave:N
 * beads. Some upstream path — a manual CTA, a pre-zszt.2 auto-chain,
 * or a future regression — advanced the pipeline past the
 * wave-completeness invariant.
 *
 * factory-core-wlsr.16 (Phase B cutover, 2026-05-06):
 * Rewritten under ADR-015 detector/decider separation principle. The
 * rule's detection predicate is preserved unchanged. The act() method
 * NO LONGER (a) rolls back the pipeline:<wrongStage> label to
 * pipeline:development, nor (b) dispatches start-wave directly.
 * Instead, act() builds a structured EscalationContext (anomalyType=
 * "wave-bead-mismatch") and escalates to the coherence agent via the
 * canonical run-coherence-agent dispatch path (mirror of
 * coherence-escalation.ts). Coherence is the principle-driven decider:
 * it reads the marker / journal / state, decides whether to roll the
 * stage back, dispatch start-wave, file a bug, or escalate to operator
 * with `escalationReason=irreducible-uncertainty` if no in-vocabulary
 * action applies. The rule's PRIOR decision logic (label rollback +
 * start-wave dispatch) is retained as a commented-out fallback per
 * ADR-015 § 4 step 3; a follow-on bead retires it once coherence's
 * decisions for this anomaly class show consistently positive
 * outcomes per ADR-010 outcome attribution.
 *
 * Idempotency key shape: (epicId, stage) per ADR-009 — anomalyType is
 * implicit in the rule-name prefix, so the key drops the prior
 * `::wave-<N>` suffix. This aligns with the coherence-escalation rule's
 * key shape so cross-rule dedup at the (rule-name, key) tuple behaves
 * predictably.
 *
 * zszt.2 guards this invariant at the QA-PASS and polish-PASS
 * boundaries in the synchronous handleChainAction. This reconciler rule
 * is the reconciler-side safety net: any epic that finds itself in an
 * inconsistent state escalates to coherence for principled decision.
 */

import type { ReconcilerRule, ReconcilerMatch } from "../reconciler";
import type { PipelineEvent } from "../event-log";
import {
  type EscalationContext,
  type EventSummary,
} from "../coherence-journal";
import { getDefaultActionUrl } from "../orchestrator-url";
import {
  buildDispatchContext,
  evaluatePreconditions,
  PRECOND_WAVE_BEADS_EXIST,
} from "../dispatch-preconditions";
import { appendEvent, RECONCILER_ACTION_REFUSED } from "../event-log";

export const WAVE_BEAD_MISMATCH_RULE_NAME = "wave-bead-mismatch";

/**
 * The action this rule dispatches. Pinned as a constant so the precondition
 * gate, the actual fetch body, and any logging always agree on the same
 * action string (mirrors marker-driven-routing's pattern).
 */
const DISPATCH_ACTION = "run-coherence-agent";

/**
 * Pipeline stages that should NEVER coexist with open wave beads.
 * Everything past development is post-build; they imply "the plan was
 * fully built, now we're verifying/polishing/shipping."
 */
const POST_DEVELOPMENT_STAGES = new Set([
  "qa",
  "ux-polish",
  "submission-prep",
  "submitted",
  "awaiting-review",
  "in-review",
  "package",
  "deploying",
]);

export interface EpicSnapshot {
  /** The pipeline stage derived from pipeline:* label (prefix stripped). */
  currentStage: string | null;
  /** Current (lowest open) wave; undefined if no waves. */
  lowestOpenWave: number | undefined;
  /** True when every wave has closed == total. */
  allWavesComplete: boolean;
  /** True if epic has no wave labels at all (legacy). */
  hasWaves: boolean;
  /** Error from wave-status lookup; triggers fail-safe (skip) when set. */
  waveStatusError?: string;
  /** Labels for dispatch. */
  labels: string[];
  /** Title for dispatch. */
  title: string;
}

export interface WaveBeadMismatchRuleOptions {
  actionUrl?: string;
  /**
   * Reads live epic state from bd. Returns null for bd failure (caller
   * treats as 'skip' — can't make a safe decision).
   */
  readEpicSnapshot: (epicId: string) => Promise<EpicSnapshot | null>;
  /**
   * beads_web-ehp.6: bd repo path for the precondition gate. Used by
   * `buildDispatchContext` (reads bead status, marker, epic labels, open
   * wave beads) and by `appendEvent` when emitting refusal events. Mirrors
   * the repoPath option on `marker-driven-routing.ts` (ehp.4 wiring).
   */
  repoPath: string;
}

/**
 * Filter recent events for the given epic and cap at N, newest-first.
 * Used to source `EscalationContext.recentEvents`.
 *
 * factory-core-wlsr.21: Aligned with the sibling Wave 3 rules
 * (`stuck-in-stage.ts:recentEpicEvents` and
 * `missed-wave-review-dispatch.ts:recentEpicEvents`) which both sort
 * newest-first by explicit timestamp. ADR-015 § 3 default is "last N
 * events from events.jsonl scoped to epic" and the wlsr.14/15 markers
 * call out "cap 10, newest-first" as the contract; the coherence
 * agent's heuristic depends on `recentEvents[0]` being the most recent
 * action.
 */
function recentEventsForEpic(
  events: PipelineEvent[],
  epicId: string,
  cap = 10,
): EventSummary[] {
  const filtered = events.filter((e) => e.epicId === epicId);
  filtered.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  return filtered.slice(0, cap);
}

/**
 * Derive the recent builder dispatches for the epic (best-effort
 * substitute for the audit-table's `dispatchedBuilders` field, which is
 * not surfaced in the current EpicSnapshot shape per wlsr.16 marker).
 * Coherence can re-derive from bd directly if it needs canonical bead
 * status — this is advisory context only (ruleSpecificContext is
 * free-form per ADR-015 § 3).
 */
function dispatchedBuilders(
  events: PipelineEvent[],
  epicId: string,
): Array<{ timestamp: string; action: string }> {
  const out: Array<{ timestamp: string; action: string }> = [];
  for (const e of events) {
    if (e.type !== "stage-dispatched") continue;
    if (e.epicId !== epicId) continue;
    const action = (e.payload as { toAction?: string } | undefined)?.toAction;
    if (!action) continue;
    if (action !== "run-builder-agent" && action !== "start-wave") continue;
    out.push({ timestamp: e.timestamp, action });
  }
  return out;
}

export function buildWaveBeadMismatchRule(
  opts: WaveBeadMismatchRuleOptions,
): ReconcilerRule {
  const actionUrl = opts.actionUrl ?? getDefaultActionUrl();

  return {
    name: WAVE_BEAD_MISMATCH_RULE_NAME,

    async matches(events, _now) {
      // Candidate epics from the discovery horizon (lookback window of
      // the reconciler governs how far back we search).
      const epicIds = new Set<string>();
      for (const e of events) {
        if (e.epicId) epicIds.add(e.epicId);
      }

      const matches: ReconcilerMatch[] = [];

      for (const epicId of epicIds) {
        const snap = await opts.readEpicSnapshot(epicId);
        if (!snap) continue;
        if (snap.waveStatusError) continue; // unknown state — don't guess
        if (!snap.currentStage) continue;
        if (!POST_DEVELOPMENT_STAGES.has(snap.currentStage)) continue;
        if (!snap.hasWaves) continue; // legacy no-wave epic — not our scope
        if (snap.allWavesComplete) continue; // invariant satisfied
        if (snap.lowestOpenWave === undefined) continue; // inconsistent snapshot; skip

        // Idempotency: per ADR-015 § Consequences, key shape is
        // (epicId, stage, anomalyType). anomalyType is implicit in the
        // rule-name prefix `wave-bead-mismatch::`, so the key collapses to
        // (epicId, stage). Same epic stuck at same stage produces ONE
        // escalation per horizon; stage transition (qa → ux-polish for
        // example) changes the key and allows refire. This is a
        // tightening from the prior key shape (which included the open
        // wave number) — see wlsr.16 close-note for rationale.
        matches.push({
          idempotencyKey: `${WAVE_BEAD_MISMATCH_RULE_NAME}::${epicId}::${snap.currentStage}`,
          epicId,
          context: {
            anomalyType: "wave-bead-mismatch",
            wrongStage: snap.currentStage,
            waveNumber: snap.lowestOpenWave,
            // Stash recent events so act() can construct EscalationContext
            // without a second event-log read (ReconcilerRule.act receives
            // only the match — events are not re-passed).
            recentEvents: recentEventsForEpic(events, epicId),
            dispatchedBuilders: dispatchedBuilders(events, epicId),
          },
        });
      }

      return matches;
    },

    async act(match) {
      const ctx = match.context as {
        anomalyType: "wave-bead-mismatch";
        wrongStage: string;
        waveNumber: number;
        recentEvents: EventSummary[];
        dispatchedBuilders: Array<{ timestamp: string; action: string }>;
      };

      // Re-read snapshot at act-time for labels + title freshness.
      const snap = await opts.readEpicSnapshot(match.epicId);
      if (!snap) {
        throw new Error(
          `[wave-bead-mismatch] snapshot read failed for ${match.epicId} at act-time; retrying next tick`,
        );
      }

      // Build the structured handoff to coherence per ADR-015 § 3.
      // `eligibleBeads` is documented in ADR-015 § 2 audit table but is
      // NOT surfaced in the current EpicSnapshot shape; coherence reads
      // bd directly if it needs canonical bead status. We pass an empty
      // array as a typed substitute; the marker for wlsr.16 surfaces this
      // substitution. ruleSpecificContext is intentionally free-form per
      // ADR-015 § 3.
      const escalationContext: EscalationContext = {
        anomalyType: "wave-bead-mismatch",
        epicId: match.epicId,
        ruleId: WAVE_BEAD_MISMATCH_RULE_NAME,
        recentEvents: ctx.recentEvents,
        // No marker triggered this rule — wave-bead-mismatch is a state-
        // observation rule (epic snapshot, not marker). Field is optional
        // per ADR-015 § 3.
        ruleSpecificContext: {
          waveNumber: ctx.waveNumber,
          wrongStage: ctx.wrongStage,
          eligibleBeads: [],
          dispatchedBuilders: ctx.dispatchedBuilders,
        },
      };

      console.log(
        `[wave-bead-mismatch] escalating to coherence for ${match.epicId}: pipeline=${ctx.wrongStage} but wave:${ctx.waveNumber} open. anomalyType=${escalationContext.anomalyType}.`,
      );

      // -----------------------------------------------------------------
      // beads_web-ehp.6: dispatch-precondition gate.
      //
      // Architecture § Seam 5 (defense-in-depth): the gate runs BEFORE the
      // action-route fetch. CRITICAL — per the ehp.6 risk flag, it MUST
      // also run BEFORE any label-rollback / state mutation; this rule
      // currently performs no rule-side mutation (post-wlsr.16 cutover
      // commented the rollback out — see FALLBACK block at the end of the
      // file), so the gate just precedes the fetch. The placement is
      // load-bearing: if the rollback is ever uncommented, the gate must
      // STILL be the first side-effect-bearing step in act() to prevent the
      // niii phantom-wave-4 redispatch loop (28+ marker churn).
      //
      // Wave-bead specificity: this rule's anomaly is, by definition, a
      // wave-bead state inconsistency. The general PRECONDITION_TABLE for
      // `run-coherence-agent` does NOT include `wave-beads-exist` (other
      // coherence escalations target non-wave anomalies — stuck-in-stage,
      // QA loops, etc.). So the gate runs the universal predicate set via
      // `evaluatePreconditions` AND additionally invokes
      // `PRECOND_WAVE_BEADS_EXIST.evaluate` directly for the wave-bead
      // check. The latter is the predicate that produces the NO_WAVE_BEADS
      // refusal that closes the niii phantom-wave-4 loop.
      //
      // On refusal: structured warn-log + `reconciler-action-refused`
      // event + early return (NO label mutation, NO dispatch).
      // -----------------------------------------------------------------
      const precondCtx = await buildDispatchContext({
        epicId: match.epicId,
        repoPath: opts.repoPath,
        action: DISPATCH_ACTION,
        waveNumber: ctx.waveNumber,
      });

      // Wave-bead-specific predicate (NO_WAVE_BEADS) — fires when no open
      // wave-N beads exist for the wave the rule wants coherence to
      // reconcile. Run FIRST because it's the load-bearing predicate for
      // this rule's specific anomaly: the niii phantom-wave-4 case
      // (epic at wave:4 but no wave:4 open beads) MUST refuse here so
      // the redispatch loop stops without further escalation.
      const waveBeadsResult = PRECOND_WAVE_BEADS_EXIST.evaluate(precondCtx);
      if (!waveBeadsResult.ok) {
        console.warn(
          `[wave-bead-mismatch] reconciler_dispatch_refused: rule=${WAVE_BEAD_MISMATCH_RULE_NAME} epicId=${match.epicId} action=${DISPATCH_ACTION} refusalCode=${waveBeadsResult.refusalCode} failedCheck=${waveBeadsResult.failedCheck} reason="${waveBeadsResult.reason}"`,
        );
        await appendEvent(opts.repoPath, {
          type: RECONCILER_ACTION_REFUSED,
          epicId: match.epicId,
          stage: ctx.wrongStage,
          payload: {
            ruleName: WAVE_BEAD_MISMATCH_RULE_NAME,
            action: DISPATCH_ACTION,
            refusalCode: waveBeadsResult.refusalCode,
            failedCheck: waveBeadsResult.failedCheck,
            reason: waveBeadsResult.reason,
          },
        });
        return;
      }

      // Universal + per-action predicates registered against
      // `run-coherence-agent` in EXTENDED_PRECONDITION_TABLE (BD_STATUS_*,
      // OPERATOR_DECISION_PENDING, REVIEW_NEEDS_HUMAN, etc.).
      const precondResult = evaluatePreconditions(precondCtx);
      if (!precondResult.ok) {
        console.warn(
          `[wave-bead-mismatch] reconciler_dispatch_refused: rule=${WAVE_BEAD_MISMATCH_RULE_NAME} epicId=${match.epicId} action=${DISPATCH_ACTION} refusalCode=${precondResult.refusalCode} failedCheck=${precondResult.failedCheck} reason="${precondResult.reason}"`,
        );
        await appendEvent(opts.repoPath, {
          type: RECONCILER_ACTION_REFUSED,
          epicId: match.epicId,
          stage: ctx.wrongStage,
          payload: {
            ruleName: WAVE_BEAD_MISMATCH_RULE_NAME,
            action: DISPATCH_ACTION,
            refusalCode: precondResult.refusalCode,
            failedCheck: precondResult.failedCheck,
            reason: precondResult.reason,
          },
        });
        return;
      }

      // zsjv hotfix 2026-04-21: fetch timeout (15s — preserved from prior
      // dispatch path).
      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), 15_000);
      let res: Response;
      try {
        // Mirror of coherence-escalation.ts dispatch shape: dispatch
        // run-coherence-agent with anomalyClass and the structured
        // escalation context. The orchestrator forwards anomalyClass +
        // escalationContext to the coherence agent's launch payload.
        res = await fetch(actionUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: DISPATCH_ACTION,
            epicId: match.epicId,
            epicTitle: snap.title,
            currentLabels: snap.labels,
            anomalyClass: escalationContext.anomalyType,
            escalationContext,
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutHandle);
      }

      // -----------------------------------------------------------------
      // beads_web-ehp.6: route-side precondition refusal (HTTP 412).
      //
      // Architecture § Seam 5 defense-in-depth: the route may catch fresh
      // state the rule's own check missed (race window between rule check
      // and route dispatch). Treat 412 as a refusal — log + emit refusal
      // event + return WITHOUT throwing. Throwing would propagate to the
      // reconciler tick handler and count as an act() failure (wrong
      // semantics for a refusal). Mirror of marker-driven-routing's 412
      // handling (ehp.4).
      // -----------------------------------------------------------------
      if (res.status === 412) {
        const text = await res.text().catch(() => "<unreadable>");
        console.warn(
          `[wave-bead-mismatch] reconciler_dispatch_refused_at_route: rule=${WAVE_BEAD_MISMATCH_RULE_NAME} epicId=${match.epicId} action=${DISPATCH_ACTION} httpStatus=412 body="${text}"`,
        );
        await appendEvent(opts.repoPath, {
          type: RECONCILER_ACTION_REFUSED,
          epicId: match.epicId,
          stage: ctx.wrongStage,
          payload: {
            ruleName: WAVE_BEAD_MISMATCH_RULE_NAME,
            action: DISPATCH_ACTION,
            refusalCode: "ROUTE_REFUSED_412",
            failedCheck: "route-side-precondition",
            reason: text,
          },
        });
        return;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => "<unreadable>");
        throw new Error(
          `[wave-bead-mismatch] run-coherence-agent dispatch for ${match.epicId} returned HTTP ${res.status}: ${text}`,
        );
      }

      console.log(
        `[wave-bead-mismatch] escalated ${match.epicId} to coherence (anomaly=${escalationContext.anomalyType}, wave=${ctx.waveNumber})`,
      );
    },
  };
}

// ---------------------------------------------------------------------------
// FALLBACK: the prior decision-logic code is retained below as
// commented-out reference per ADR-015 § 4 step 3 (factory-core-wlsr.16).
// Do NOT delete in this bead.
//
// This block represents the rule's pre-cutover behaviour: rolling back
// the pipeline:<wrongStage> label to pipeline:development AND directly
// dispatching action="start-wave" with the lowest open wave number. Both
// were rule-side decisions ADR-015 § 1 prohibits ("MUST NOT apply or
// remove labels other than for pure hygiene"; "MUST NOT call
// fetch(actionUrl, ...) with a directly-chosen action other than
// run-coherence-agent").
//
// A follow-on bead retires this block once coherence's escalation
// decisions for the wave-bead-mismatch anomaly class show consistently
// positive outcomes over a calendar week per ADR-010 outcome attribution.
//
// /*
// async function priorAct_DEPRECATED(
//   match: ReconcilerMatch,
//   opts: WaveBeadMismatchRuleOptions,
//   actionUrl: string,
// ): Promise<void> {
//   const context = match.context as {
//     wrongStage: string;
//     dispatchWave: number;
//   };
//
//   console.log(
//     `[zsjv.2] wave-bead-mismatch for ${match.epicId}: pipeline=${context.wrongStage} but wave:${context.dispatchWave} open. Rolling back to development + dispatching start-wave ${context.dispatchWave}.`,
//   );
//
//   // Re-read snapshot at act-time for labels + title freshness.
//   const snap = await opts.readEpicSnapshot(match.epicId);
//   if (!snap) {
//     throw new Error(
//       `[zsjv.2] snapshot read failed for ${match.epicId} at act-time; retrying next tick`,
//     );
//   }
//
//   // Roll pipeline label back to development. Uses addLabelsToEpic +
//   // removeLabelsFromEpic via dynamic import so the rule module stays
//   // portable (pipeline-labels.ts is server-only).
//   try {
//     const { addLabelsToEpic, removeLabelsFromEpic } = await import(
//       "../pipeline-labels"
//     );
//     await removeLabelsFromEpic(match.epicId, [
//       `pipeline:${context.wrongStage}`,
//     ]);
//     await addLabelsToEpic(match.epicId, ["pipeline:development"]);
//   } catch (err) {
//     console.error(
//       `[zsjv.2] label rollback failed for ${match.epicId} — dispatching start-wave anyway:`,
//       err instanceof Error ? err.message : err,
//     );
//   }
//
//   // zsjv hotfix 2026-04-21: fetch timeout.
//   const controller = new AbortController();
//   const timeoutHandle = setTimeout(() => controller.abort(), 15_000);
//   let res: Response;
//   try {
//     res = await fetch(actionUrl, {
//       method: "POST",
//       headers: { "Content-Type": "application/json" },
//       body: JSON.stringify({
//         action: "start-wave",
//         epicId: match.epicId,
//         epicTitle: snap.title,
//         currentLabels: snap.labels,
//         waveNumber: context.dispatchWave,
//       }),
//       signal: controller.signal,
//     });
//   } finally {
//     clearTimeout(timeoutHandle);
//   }
//
//   if (!res.ok) {
//     const text = await res.text().catch(() => "<unreadable>");
//     throw new Error(
//       `[zsjv.2] start-wave dispatch for ${match.epicId} wave:${context.dispatchWave} returned HTTP ${res.status}: ${text}`,
//     );
//   }
//
//   console.log(
//     `[zsjv.2] rolled back ${match.epicId} to development + dispatched start-wave ${context.dispatchWave}`,
//   );
// }
// */
