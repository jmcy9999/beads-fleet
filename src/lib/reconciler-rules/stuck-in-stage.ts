/**
 * factory-core-zsjv.1 — Stuck-in-stage detector.
 *
 * factory-core-wlsr.14 (Phase B cutover, ADR-015 § 4):
 *   The act() method NO LONGER chooses an action from STAGE_RESUME_ACTIONS.
 *   Per ADR-015 ("reconciler rules detect; coherence decides"), the rule's
 *   act() now constructs an EscalationContext and dispatches
 *   `run-coherence-agent` via the existing coherence-escalation pattern.
 *
 *   STAGE_RESUME_ACTIONS is RETAINED as an exported constant per ADR-015 §
 *   4 step 3 (do NOT delete in this bead — the table is unused by act() but
 *   kept around as a fallback during empirical verification of coherence's
 *   competence at the broader trigger surface). A follow-on bead will
 *   retire the constant once coherence's escalation decisions for the
 *   `stuck-in-stage` anomaly class show consistently positive outcomes
 *   over a calendar week per ADR-010 outcome attribution.
 *
 *   Detection (matches()) is preserved unchanged: thresholds, predicates,
 *   and skip conditions (including "stage has no canned recovery → skip"
 *   via STAGE_RESUME_ACTIONS membership) match pre-wlsr.14 behaviour
 *   bit-for-bit. Only the action authority moves to coherence.
 *
 * Generalises factory-core-lfcf.4 (which only caught missed
 * build-review dispatches) to every pipeline stage. When an epic has
 * been at pipeline:X for longer than the staleness window, has no
 * agent:running label, and has had no recent events, the rule
 * escalates to the coherence agent for diagnosis (was: dispatched the
 * canned resume action for stage X). This closes the 8sz5-class
 * failure at every stage.
 *
 * Design notes:
 *   - Epics are discovered via recent agent-exited events rather than a
 *     bd query. This keeps the rule scoped to epics the reconciler has
 *     observed in its lifetime. Pre-existing stalls from before the
 *     event log existed are invisible (acceptable for MVP — owner
 *     resolves historical debt manually).
 *   - Stage → action mapping (STAGE_RESUME_ACTIONS) is kept as a
 *     detection-time predicate ONLY. Stages NOT in the table are still
 *     intentionally skipped at detection (their recovery is owner/
 *     platform-owned). Stages IN the table escalate to coherence with
 *     the stuck-in-stage anomalyType.
 *   - Idempotency window ties a match to a (epic, stage, anomalyType,
 *     15-min window-start) triple so successive ticks inside the same
 *     stall don't re-fire. Next stall window gets a fresh idempotency
 *     key. The anomalyType component is added per ADR-015 § Consequences
 *     refinement of ADR-009 (cross-rule de-dup discriminator).
 */

import type { PipelineEvent } from "../event-log";
import type { ReconcilerRule, ReconcilerMatch } from "../reconciler";
import { getDefaultActionUrl } from "../orchestrator-url";
import type {
  EscalationContext,
  EventSummary,
} from "../coherence-journal";
import {
  buildDispatchContext,
  evaluatePreconditions,
} from "../dispatch-preconditions";
import {
  appendEvent,
  RECONCILER_ACTION_REFUSED,
} from "../event-log";

export const STUCK_IN_STAGE_RULE_NAME = "stuck-in-stage";

/**
 * AnomalyType for this rule (closed enum value from ADR-015 § 3).
 * Hard-coded as a literal here so the value stays in lock-step with the
 * coherence-journal AnomalyType enum at the type level.
 */
const STUCK_IN_STAGE_ANOMALY_TYPE: EscalationContext["anomalyType"] =
  "stuck-in-stage";

/** 15 min default — short enough to recover from typical drops, long
 *  enough that normal agent runs (which can take 5-10 min) don't trigger
 *  premature re-dispatches. */
export const DEFAULT_STALENESS_MS = 15 * 60_000;

/** How far back in the event log to look for candidate epics. */
export const DEFAULT_DISCOVERY_HORIZON_MS = 60 * 60_000; // 1 hour

/** How many recent epic-scoped events to attach to EscalationContext. Per
 *  ADR-015 § 3 default ("last N events from events.jsonl scoped to epic
 *  ... default 10"). */
export const RECENT_EVENTS_CAP = 10;

/**
 * Canonical stage → resume-action mapping. Each entry describes the
 * exact /api/fleet/action that pre-wlsr.14 act() would have fired when
 * the stage is stuck.
 *
 * factory-core-wlsr.14: NO LONGER CONSULTED BY act(). Retained as an
 * exported constant per ADR-015 § 4 step 3 — used only at detection
 * time (matches() skips stages NOT in this table, preserving the
 * original "skip stages whose recovery is owner-owned" predicate).
 *
 * Stages NOT in this table are intentionally left alone at detection
 * (submission-related stages, terminal states, and stages whose
 * recovery involves owner decision rather than mechanical re-fire).
 */
export const STAGE_RESUME_ACTIONS: Record<
  string,
  { action: string; needsWaveNumber: boolean }
> = {
  research: { action: "start-research", needsWaveNumber: false },
  "research-complete": { action: "run-pm", needsWaveNumber: false },
  "product-spec": { action: "run-architect", needsWaveNumber: false },
  architecture: { action: "generate-plan", needsWaveNumber: false },
  "plan-review": { action: "review-plan", needsWaveNumber: false },
  "test-spec": { action: "run-test-spec", needsWaveNumber: false },
  development: { action: "start-wave", needsWaveNumber: true },
  "build-review": { action: "review-wave", needsWaveNumber: true },
  "smoke-test": { action: "run-smoke-test", needsWaveNumber: false },
  qa: { action: "send-for-qa", needsWaveNumber: false },
  "ux-polish": { action: "run-polish", needsWaveNumber: false },
};

export interface EpicSnapshot {
  /** Current pipeline stage (from pipeline:* label, stripped of prefix). */
  currentStage: string | null;
  /** True if bd shows agent:running on the epic. */
  hasAgentRunning: boolean;
  /** Labels for dispatch payload. */
  labels: string[];
  /** Title for dispatch payload. */
  title: string;
  /** Current wave number for stages that need it. */
  currentWave?: number;
}

export interface StuckInStageRuleOptions {
  actionUrl?: string;
  stalenessMs?: number;
  discoveryHorizonMs?: number;
  /**
   * Reads live epic state from bd. Injected so tests can stub without
   * hitting bd. Production binds to a helper that wraps readEpicState.
   */
  readEpicSnapshot: (epicId: string) => Promise<EpicSnapshot | null>;
  /**
   * beads_web-ehp.5: repo path used by the precondition gate. Passed to
   * `buildDispatchContext({ repoPath })` (which feeds `readBeadStatus` /
   * `readMarker` / event-log reads via the dispatch-preconditions library)
   * AND to `appendEvent` for the `reconciler-action-refused` records.
   *
   * Optional for backwards-compat with tests that constructed the rule
   * before ehp.5 landed; when absent, the precondition gate falls open
   * (logged warn-line) and the rule preserves pre-ehp.5 behaviour. Bootstrap
   * passes the production repoPath unconditionally, so the production path
   * is fully gated.
   */
  repoPath?: string;
}

/**
 * Internal: extract a `dispatchHistory` summary from the event log for the
 * given epic. We treat the history as the recent record of dispatches the
 * reconciler made for this epic, regardless of which rule fired. Coherence
 * uses this as advisory context for "what has been tried already?".
 *
 * Source: `reconciler-action-taken` events scoped to the epic, in the
 * discovery-horizon window. Each entry surfaces the rule that acted, the
 * idempotency key, and (when present) the resumeAction stuck-in-stage
 * would have chosen pre-wlsr.14.
 *
 * Surfaced in the bead marker (per RISK FLAGS) — there is no
 * `dispatchHistory` field on EpicSnapshot or the (non-existent)
 * ReconcilerSnapshot type, so we derive it from events here.
 */
function deriveDispatchHistory(
  events: PipelineEvent[],
  epicId: string,
): Array<{
  at: string;
  ruleName: string;
  idempotencyKey?: string;
  resumeAction?: string;
}> {
  const out: Array<{
    at: string;
    ruleName: string;
    idempotencyKey?: string;
    resumeAction?: string;
  }> = [];
  for (const e of events) {
    if (e.type !== "reconciler-action-taken") continue;
    if (e.epicId !== epicId) continue;
    const payload = e.payload as
      | {
          ruleName?: string;
          idempotencyKey?: string;
          context?: { resumeAction?: string };
        }
      | undefined;
    if (!payload?.ruleName) continue;
    out.push({
      at: e.timestamp,
      ruleName: payload.ruleName,
      idempotencyKey: payload.idempotencyKey,
      resumeAction: payload.context?.resumeAction,
    });
  }
  // Newest-first.
  out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return out;
}

/**
 * Internal: take the last N events scoped to the given epic, newest-first.
 * Fed to EscalationContext.recentEvents per ADR-015 § 3 default.
 */
function recentEpicEvents(
  events: PipelineEvent[],
  epicId: string,
  cap: number,
): EventSummary[] {
  const filtered = events.filter((e) => e.epicId === epicId);
  filtered.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  return filtered.slice(0, cap);
}

export function buildStuckInStageRule(
  opts: StuckInStageRuleOptions,
): ReconcilerRule {
  const actionUrl = opts.actionUrl ?? getDefaultActionUrl();
  const stalenessMs = opts.stalenessMs ?? DEFAULT_STALENESS_MS;
  const discoveryHorizonMs =
    opts.discoveryHorizonMs ?? DEFAULT_DISCOVERY_HORIZON_MS;

  return {
    name: STUCK_IN_STAGE_RULE_NAME,

    async matches(events, now) {
      const nowMs = now.getTime();
      const horizonMs = nowMs - discoveryHorizonMs;

      // Candidate epics: any epic referenced by an event in the discovery
      // horizon. Collect distinct epic ids.
      const epicIds = new Set<string>();
      for (const e of events) {
        const t = Date.parse(e.timestamp);
        if (!Number.isFinite(t) || t < horizonMs) continue;
        if (e.epicId) epicIds.add(e.epicId);
      }

      const matches: ReconcilerMatch[] = [];

      for (const epicId of epicIds) {
        // Last ANY event for this epic (exit, dispatch, reconciler-action).
        // Skip reconciler-action-taken events to avoid false-positives
        // where the reconciler's OWN action resets the stall clock.
        const lastEvent = events
          .filter(
            (e) =>
              e.epicId === epicId &&
              e.type !== "reconciler-action-taken",
          )
          .reduce<PipelineEvent | null>((latest, candidate) => {
            if (!latest) return candidate;
            return Date.parse(candidate.timestamp) >
              Date.parse(latest.timestamp)
              ? candidate
              : latest;
          }, null);

        if (!lastEvent) continue;
        const lastEventMs = Date.parse(lastEvent.timestamp);
        if (!Number.isFinite(lastEventMs)) continue;
        const ageMs = nowMs - lastEventMs;
        if (ageMs < stalenessMs) continue; // not yet stale

        // Read live epic state. Null means bd failed or epic not found —
        // skip rather than re-dispatch blindly.
        const snapshot = await opts.readEpicSnapshot(epicId);
        if (!snapshot) continue;
        if (snapshot.hasAgentRunning) continue; // an agent is working; not stuck
        if (!snapshot.currentStage) continue; // no pipeline label; not our concern

        // factory-core-wlsr.14: predicate preserved unchanged. Stages
        // not in STAGE_RESUME_ACTIONS still skip detection (their
        // recovery is owner/platform-owned, not coherence-resolvable
        // by re-dispatching a canned action — though coherence could
        // in principle reason about them, ADR-015 Phase B keeps the
        // detection scope identical to pre-cutover behaviour).
        const resume = STAGE_RESUME_ACTIONS[snapshot.currentStage];
        if (!resume) continue; // stage has no canned recovery (predicate preserved)

        if (resume.needsWaveNumber && !snapshot.currentWave) continue; // can't act without it

        // Bucket the idempotency key by 15-minute windows so that if the
        // rule fires once and the dispatch itself fails (or we fail to
        // detect recovery), the NEXT stall window gets a fresh key and
        // can retry. Without bucketing, one failed attempt would mark
        // the stall permanently-attempted for the idempotency horizon.
        //
        // factory-core-wlsr.14: anomalyType component added per ADR-015
        // § Consequences refinement of ADR-009 (cross-rule de-dup
        // discriminator). For this rule the anomalyType is constant, so
        // it adds no behavioural change; the discriminator matters when
        // future rules detect different anomaly types on the same
        // (epicId, stage) and should not dedup against each other.
        const windowStart = Math.floor(nowMs / stalenessMs) * stalenessMs;
        const idempotencyKey = `${STUCK_IN_STAGE_RULE_NAME}::${epicId}::${snapshot.currentStage}::${STUCK_IN_STAGE_ANOMALY_TYPE}::${windowStart}`;

        // factory-core-wlsr.14: capture rule-side context for coherence.
        // recentEvents (last N scoped to epic, newest-first) and
        // dispatchHistory (recent reconciler-action-taken events) are
        // derived at match time so act() can build EscalationContext
        // without re-reading the event log.
        const recentEvents = recentEpicEvents(events, epicId, RECENT_EVENTS_CAP);
        const dispatchHistory = deriveDispatchHistory(events, epicId);

        matches.push({
          idempotencyKey,
          epicId,
          context: {
            stage: snapshot.currentStage,
            // resumeAction is RETAINED in match.context for two reasons:
            //   1. Backwards compat with audit logs (reconciler-action-
            //      taken events historically include it; downstream tools
            //      like repeat-dispatch-escalation read it from the
            //      payload's context.resumeAction).
            //   2. As advisory data inside ruleSpecificContext — coherence
            //      MAY use it as a hint, treating it as one possible
            //      action among others. This is NOT a fast-path bypass:
            //      act() never calls fetch with this action.
            resumeAction: resume.action,
            currentWave: snapshot.currentWave,
            lastEventAt: lastEvent.timestamp,
            ageMs,
            recentEvents,
            dispatchHistory,
          },
        });
      }

      return matches;
    },

    async act(match) {
      const context = match.context as {
        stage: string;
        resumeAction?: string;
        currentWave?: number;
        lastEventAt: string;
        ageMs: number;
        recentEvents: EventSummary[];
        dispatchHistory: Array<{
          at: string;
          ruleName: string;
          idempotencyKey?: string;
          resumeAction?: string;
        }>;
      };

      console.log(
        `[stuck-in-stage] (wlsr.14 cutover) escalating ${match.epicId} to coherence: stage=${context.stage}, last event ${new Date(context.lastEventAt).toISOString()}, age=${Math.floor(context.ageMs / 60_000)}min`,
      );

      // Re-read snapshot just before dispatch so we have fresh labels +
      // title. Matches lfcf.4's pattern.
      const snapshot = await opts.readEpicSnapshot(match.epicId);
      if (!snapshot) {
        throw new Error(
          `[stuck-in-stage] snapshot read failed for ${match.epicId} at act-time; retrying next tick`,
        );
      }
      if (snapshot.hasAgentRunning) {
        // Race: an agent started between match and act. Abort quietly —
        // the idempotency window still records this attempt so we don't
        // re-fire immediately.
        console.log(
          `[stuck-in-stage] abort: ${match.epicId} now has agent:running`,
        );
        return;
      }

      // -----------------------------------------------------------------
      // beads_web-ehp.5: dispatch-precondition gate (Wave 3 integration).
      //
      // Architecture § Component Boundaries Contract 2: precondition check
      // runs AFTER the snapshot re-read and BEFORE the action-route fetch.
      // Stuck-in-stage is the most-frequent re-dispatcher and the top
      // source of phantom dispatches when stages have not actually
      // completed (niii phantom-wave-N reproduction).
      //
      // The action this rule dispatches post-wlsr.14 is `run-coherence-
      // agent`, but the gate evaluates against the rule's pre-wlsr.14
      // `resumeAction` (e.g., start-wave for development, review-plan for
      // plan-review). Rationale:
      //   - The phantom-dispatch failure mode the niii reproduction
      //     captures is "stuck-in-stage at development with no open
      //     wave-N beads" → pre-wlsr.14 would have fired `start-wave`
      //     against an empty wave set. The Class A NO_WAVE_BEADS
      //     predicate's `appliesTo` returns true ONLY for start-wave /
      //     review-wave / resume-build, NOT for run-coherence-agent.
      //     If we evaluated against run-coherence-agent the predicate
      //     wouldn't fire and the phantom would shift to coherence.
      //   - Using resumeAction encodes the rule's INTENT: "I want stage
      //     X to resume via action Y; refuse if action Y would be
      //     unsafe." Even though wlsr.14 routes through coherence first,
      //     coherence's typical decision for a stalled stage IS to
      //     re-fire the canned action — refusing here avoids the round-
      //     trip when the canned action is provably wrong.
      //   - This mirrors the bead description's risk flag warning:
      //     "Each rule has its own snapshot-re-read shape; do not
      //      blindly copy [ehp.4's pattern]." resumeAction is the
      //     stuck-in-stage-specific signal.
      //
      // The universal predicates (Class A.5 BD_STATUS_DEFERRED /
      // BD_STATUS_CLOSED, Class C OPERATOR_DECISION_PENDING /
      // REVIEW_NEEDS_HUMAN) ALWAYS fire — `appliesTo` returns true for
      // every action — so closed/deferred protection lands regardless of
      // which action name is passed.
      //
      // FOLLOW-ON (architecture ADR-006, mirrored from ehp.4): refusals
      // currently consume the `reconciler-action-taken` idempotency bucket
      // because reconciler.ts appends that event unconditionally after
      // act() returns. The proper bucketing key for refusals is
      // (epicId, ruleName, refusalCode, 15-min window). Implementing it
      // requires a reconciler.ts change and is tracked separately. The
      // existing 15-min idempotency window in this rule (matches() at
      // line ~282) is preserved unchanged per AC scope.
      // -----------------------------------------------------------------
      // Use resumeAction when present; fall back to run-coherence-agent
      // for the universal-class checks if a stage somehow lands here
      // without a resumeAction in context (defensive — matches() filters
      // STAGE_RESUME_ACTIONS membership at line 266 before accepting).
      const precondAction = context.resumeAction ?? "run-coherence-agent";
      if (opts.repoPath) {
        const precondCtx = await buildDispatchContext({
          epicId: match.epicId,
          repoPath: opts.repoPath,
          action: precondAction,
          waveNumber: snapshot.currentWave,
        });
        const precondResult = evaluatePreconditions(precondCtx);
        if (!precondResult.ok) {
          console.warn(
            `[stuck-in-stage] reconciler_dispatch_refused: rule=${STUCK_IN_STAGE_RULE_NAME} epicId=${match.epicId} action=${precondAction} stage=${context.stage} refusalCode=${precondResult.refusalCode} failedCheck=${precondResult.failedCheck} reason="${precondResult.reason}"`,
          );
          await appendEvent(opts.repoPath, {
            type: RECONCILER_ACTION_REFUSED,
            epicId: match.epicId,
            stage: context.stage,
            payload: {
              ruleName: STUCK_IN_STAGE_RULE_NAME,
              action: precondAction,
              refusalCode: precondResult.refusalCode,
              failedCheck: precondResult.failedCheck,
              reason: precondResult.reason,
            },
          });
          return;
        }
      } else {
        console.warn(
          `[stuck-in-stage] precondition gate skipped — no repoPath configured (rule built without ehp.5 wiring); proceeding with pre-ehp.5 dispatch`,
        );
      }

      // factory-core-wlsr.14: build EscalationContext per ADR-015 § 3.
      // - anomalyType: closed enum value "stuck-in-stage".
      // - epicId, ruleId: identification.
      // - recentEvents: last 10 epic-scoped events (snapshotted at match-time).
      // - marker: undefined — stuck-in-stage is event-log-triggered, not
      //   marker-triggered, so there is no marker to attach.
      // - ruleSpecificContext: { stage, lastEventAge, dispatchHistory } per
      //   ADR-015 § 2 audit-table row. (NOTE: marker is a top-level
      //   EscalationContext field per ADR-015 § 3; ruleSpecificContext does
      //   NOT include marker.)
      const lastEventAge = Math.floor(context.ageMs / 1000); // seconds
      const escalationContext: EscalationContext = {
        anomalyType: STUCK_IN_STAGE_ANOMALY_TYPE,
        epicId: match.epicId,
        ruleId: STUCK_IN_STAGE_RULE_NAME,
        recentEvents: context.recentEvents,
        // marker omitted — stuck-in-stage is not marker-triggered.
        ruleSpecificContext: {
          stage: context.stage,
          lastEventAge,
          dispatchHistory: context.dispatchHistory,
        },
      };

      // factory-core-wlsr.14: dispatch run-coherence-agent (NOT the
      // pre-cutover run-X-agent action derived from STAGE_RESUME_ACTIONS).
      // Mirrors the coherence-escalation rule's dispatch shape:
      //   { action, epicId, epicTitle, currentLabels, anomalyClass, ... }
      // and adds an `escalationContext` field carrying the structured
      // payload coherence consumes during diagnosis.
      //
      // Idempotency-key alignment with coherence-escalation:
      //   coherence-escalation uses (rule-name, epicId, stage). Here we
      //   use (rule-name, epicId, stage, anomalyType, windowStart). The
      //   shape differs because (a) ADR-015 § Consequences names
      //   anomalyType as a cross-rule de-dup discriminator (refines
      //   ADR-009), and (b) AC #1 forbids changing this rule's existing
      //   skip conditions, including the 15-min window bucketing that
      //   allows refire after a failed attempt. Divergence surfaced in
      //   the bead marker per AC #5.

      // zsjv hotfix 2026-04-21: fetch timeout (15s). The action endpoint
      // can hang if an upstream lock is held; without a timeout, act()
      // never returns and the reconciler tick stays wedged.
      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), 15_000);
      let res: Response;
      try {
        res = await fetch(actionUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "run-coherence-agent",
            epicId: match.epicId,
            epicTitle: snapshot.title,
            currentLabels: snapshot.labels,
            // anomalyClass: legacy field for downstream consumers
            // (dashboard CTA, journal entries). Set to the anomalyType
            // value so the legacy field carries the same signal as the
            // ADR-015 escalationContext.
            anomalyClass: STUCK_IN_STAGE_ANOMALY_TYPE,
            // ADR-015 structured handoff. Coherence reads this on launch.
            escalationContext,
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutHandle);
      }

      // -------------------------------------------------------------
      // beads_web-ehp.5: route-side precondition refusal (HTTP 412).
      //
      // Architecture § Seam 5 (defense-in-depth): both the rule AND the
      // action route validate preconditions. If the route refuses with
      // 412 (route-side check caught state the rule's own check missed —
      // race window, label mutated mid-flight, etc.), the rule must
      // distinguish that from a genuine HTTP failure. 412 is a refusal:
      // log a structured warn-line tagged `reconciler_dispatch_refused_
      // at_route`, emit a `reconciler-action-refused` event with a
      // ROUTE_REFUSED_412 marker code, and return WITHOUT throwing.
      // Throwing would propagate to the reconciler tick handler and
      // count as an act() failure (which dispatches a different recovery
      // path — wrong semantics for a refusal). Mirrors ehp.4's 412 handler
      // in marker-driven-routing.ts.
      // -------------------------------------------------------------
      if (res.status === 412) {
        const text = await res.text().catch(() => "<unreadable>");
        console.warn(
          `[stuck-in-stage] reconciler_dispatch_refused_at_route: rule=${STUCK_IN_STAGE_RULE_NAME} epicId=${match.epicId} action=run-coherence-agent stage=${context.stage} httpStatus=412 body="${text}"`,
        );
        if (opts.repoPath) {
          await appendEvent(opts.repoPath, {
            type: RECONCILER_ACTION_REFUSED,
            epicId: match.epicId,
            stage: context.stage,
            payload: {
              ruleName: STUCK_IN_STAGE_RULE_NAME,
              action: "run-coherence-agent",
              refusalCode: "ROUTE_REFUSED_412",
              failedCheck: "route-side-precondition",
              reason: text,
            },
          });
        }
        return;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => "<unreadable>");
        throw new Error(
          `[stuck-in-stage] coherence escalation for ${match.epicId} returned HTTP ${res.status}: ${text}`,
        );
      }

      console.log(
        `[stuck-in-stage] escalated ${match.epicId} to coherence (anomalyType=${STUCK_IN_STAGE_ANOMALY_TYPE}, stage=${context.stage})`,
      );
    },
  };
}
