/**
 * factory-core-lfcf.4 — First real reconciler rule.
 *
 * factory-core-wlsr.15 (Phase B cutover, ADR-015 § 4):
 *   The act() method NO LONGER chooses an action ("start-wave" /
 *   "run-smoke-test") from the inline `let action: ...` selection block.
 *   Per ADR-015 ("reconciler rules detect; coherence decides"), the rule's
 *   act() now constructs an EscalationContext and dispatches
 *   `run-coherence-agent` via the existing coherence-escalation pattern.
 *
 *   The pre-cutover hardcoded action-selection logic is RETAINED below as
 *   a clearly-marked unused helper (`legacyActionSelection`) per ADR-015 §
 *   4 step 3 — do NOT delete in this bead. The helper is unused by act()
 *   and exists only as a fallback during empirical verification of
 *   coherence's competence at the broader trigger surface. A follow-on bead
 *   will retire the helper once coherence's escalation decisions for the
 *   `missed-wave-review-dispatch` anomaly class show consistently positive
 *   outcomes over a calendar week per ADR-010 outcome attribution.
 *
 *   Detection (matches()) is preserved unchanged: candidate exits are still
 *   build-review with exitCode === 0, correlationId set, age past
 *   `pairingGraceMs`, age within `recoveryHorizonMs`, and no paired
 *   stage-dispatched (start-wave / run-smoke-test / review-wave) following
 *   the exit. Only the action authority moves to coherence.
 *
 * Detects: a `build-review` agent exited successfully (exitCode === 0)
 * more than N seconds ago but no matching `stage-dispatched` event
 * followed — the chain was dropped. This is the 8sz5-class failure in
 * practice: something between detectAgentDone and fetch-to-action
 * swallowed the decision.
 *
 * Recovers (post-wlsr.15): escalates to the coherence agent with structured
 * context about the missed exit. Coherence decides whether the wave was
 * actually complete (warranting smoke-test) or if review was skipped
 * intentionally (no recovery needed) or if a fresh review-wave dispatch is
 * appropriate.
 *
 * Idempotency key (post-wlsr.15):
 *   `missed-wave-review-dispatch::<epicId>::build-review::missed-wave-review-dispatch::<correlationId>`
 *   — the exit's tmuxSessionName (correlationId) preserves the per-exit
 *   recovery scope from the pre-cutover key (one recovery attempt per
 *   distinct exit per idempotency horizon, default 1h). The added
 *   `stage` + `anomalyType` components are the cross-rule de-dup
 *   discriminator named in ADR-015 § Consequences refinement of ADR-009.
 *   Diverges from coherence-escalation.ts's three-component shape
 *   `(rule-name, epicId, stage)`; divergence documented in the bead
 *   marker per AC #5.
 */

import type { PipelineEvent } from "../event-log";
import type { ReconcilerRule, ReconcilerMatch } from "../reconciler";
import { getDefaultActionUrl } from "../orchestrator-url";
import type { EscalationContext, EventSummary } from "../coherence-journal";
import {
  buildDispatchContext,
  evaluatePreconditions,
} from "../dispatch-preconditions";
import { appendEvent, RECONCILER_ACTION_REFUSED } from "../event-log";

export const MISSED_WAVE_REVIEW_DISPATCH_RULE_NAME =
  "missed-wave-review-dispatch";

/**
 * The action this rule actually dispatches over HTTP. Pinned as a constant so
 * the fetch body, the 412-refusal log, and the refusal-event payload always
 * agree on one literal (mirrors the wave-bead-mismatch / stuck-in-stage
 * pattern).
 */
const DISPATCH_ACTION = "run-coherence-agent";

/**
 * The LOGICAL action this rule is recovering — a missed `review-wave`
 * dispatch after a successful `build-review` exit. The dispatch-precondition
 * gate runs against THIS action (not DISPATCH_ACTION), because the predicates
 * we care about (PLAN_FILE_MISSING, NO_WAVE_BEADS / ALL_WAVE_BEADS_CLOSED)
 * are registered for `review-wave` in the EXTENDED_PRECONDITION_TABLE — they
 * are NOT registered for `run-coherence-agent` (other coherence escalations
 * like stuck-in-stage / repeated-qa-round target non-wave anomalies, so
 * extending those predicates to every coherence escalation would be wrong).
 *
 * Mirrors stuck-in-stage.ts's `precondAction` pattern (line ~430): the gate
 * runs against the action the rule INTENDS to recover, not the action it
 * actually dispatches.
 */
const PRECONDITION_ACTION = "review-wave";

/**
 * AnomalyType for this rule (closed enum value from ADR-015 § 3).
 * Hard-coded as a literal here so the value stays in lock-step with the
 * coherence-journal AnomalyType enum at the type level.
 */
const MISSED_WAVE_REVIEW_DISPATCH_ANOMALY_TYPE: EscalationContext["anomalyType"] =
  "missed-wave-review-dispatch";

/**
 * Stage for this rule (constant — matches() filters to build-review exits
 * only). Used as the `stage` component of the idempotency key per ADR-015
 * § Consequences and as the legacy `stage` field on EscalationContext's
 * ruleSpecificContext.
 */
const MISSED_WAVE_REVIEW_DISPATCH_STAGE = "build-review";

/**
 * How long we wait after a build-review exit before deciding "no
 * dispatch followed — this is a drop." Must be comfortably longer than
 * handleChainAction's typical synchronous run time (under a second) so
 * we don't race the normal path. Default 60s.
 */
export const DEFAULT_PAIRING_GRACE_MS = 60_000;

/**
 * How far back we look for candidate build-review exits. Beyond this
 * horizon the exit is considered "too old" to meaningfully recover —
 * the epic has either moved on through operator intervention or become
 * stale enough to need manual attention. Default 10 minutes (matches
 * the reconciler's DEFAULT_LOOKBACK_MS).
 */
export const DEFAULT_RECOVERY_HORIZON_MS = 10 * 60_000;

/**
 * How many recent epic-scoped events to attach to EscalationContext. Per
 * ADR-015 § 3 default ("last N events from events.jsonl scoped to epic
 * ... default 10").
 */
export const RECENT_EVENTS_CAP = 10;

export interface EpicSnapshot {
  waveStatus: {
    hasWaves: boolean;
    currentWave: number;
    allWavesComplete: boolean;
    error?: string;
  };
  /** -1 sentinel means bd failure ("assume bugs"). */
  openBugCount: number;
  labels: string[];
  /** Human-readable title for dispatch logging (epicId is an acceptable fallback). */
  title: string;
}

export interface MissedWaveReviewDispatchRuleOptions {
  /** Base URL for the action endpoint. Defaults to localhost:3000. */
  actionUrl?: string;
  /** Grace period after exit before declaring a drop. Default 60s. */
  pairingGraceMs?: number;
  /** Horizon for candidate exits. Default 10 min. */
  recoveryHorizonMs?: number;
  /**
   * Function that reads the epic's current state atomically. Injected so
   * tests can stub without hitting bd. Production wires this to
   * readEpicState from agent-launcher.ts.
   */
  readEpicSnapshot: (epicId: string) => Promise<EpicSnapshot>;
  /**
   * beads_web-ehp.7: bd repo path used by the dispatch-precondition gate.
   * Passed to `buildDispatchContext({ repoPath })` (which feeds
   * `readBeadStatus` / `readMarker` / `listOpenWaveBeads` / event-log reads
   * via the dispatch-preconditions library) AND to `appendEvent` for the
   * `reconciler-action-refused` records.
   *
   * Optional for backwards-compat with legacy tests that constructed the
   * rule before ehp.7 landed; when absent, the precondition gate falls open
   * (logged warn-line) and the rule preserves pre-ehp.7 behaviour. The
   * production wiring at reconciler-bootstrap.ts passes the production
   * repoPath unconditionally, so the production path is fully gated.
   */
  repoPath?: string;
}

/**
 * factory-core-wlsr.15: pre-cutover action-selection logic, RETAINED as a
 * clearly-marked unused helper per ADR-015 § 4 step 3.
 *
 * Pre-cutover act() chose between "start-wave" (with current wave number)
 * and "run-smoke-test" based on whether bugs were open or all waves were
 * complete. Post-cutover act() does NOT call this helper; the decision now
 * lives in coherence. The helper is preserved verbatim during the
 * empirical-verification window so a follow-on retirement bead can either
 * delete it cleanly or, if coherence proves unreliable for this anomaly
 * class, restore the call site.
 *
 * DO NOT call this from act() under any "fallback" condition — see
 * ADR-015 § 2 "Anti-pattern explicitly rejected": keeping a hardcoded
 * action-selection alongside coherence escalation re-introduces the
 * rule-table coupling P3 prohibits.
 */
function legacyActionSelection(snapshot: EpicSnapshot): {
  action: "start-wave" | "run-smoke-test";
  waveNumber: number | undefined;
} {
  // Branch: bugs or incomplete wave -> start-wave (current).
  // All waves complete and no bugs -> run-smoke-test.
  let action: "start-wave" | "run-smoke-test";
  let waveNumber: number | undefined;

  const hasBugs = snapshot.openBugCount === -1 || snapshot.openBugCount > 0;

  if (hasBugs || !snapshot.waveStatus.allWavesComplete) {
    action = "start-wave";
    waveNumber = snapshot.waveStatus.hasWaves
      ? snapshot.waveStatus.currentWave
      : 1;
  } else {
    action = "run-smoke-test";
  }

  return { action, waveNumber };
}
// Reference the helper so TypeScript / eslint don't flag it as dead while
// it sits dormant during the empirical-verification window. Exported as
// the legacy fallback handle a future retirement bead can find by name.
export const __legacyActionSelection_DO_NOT_USE = legacyActionSelection;

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

/**
 * Build the rule with its read-functions injected. Production call-site
 * in instrumentation.ts wires these to agent-launcher helpers; tests
 * pass stubs.
 */
export function buildMissedWaveReviewDispatchRule(
  opts: MissedWaveReviewDispatchRuleOptions,
): ReconcilerRule {
  const actionUrl = opts.actionUrl ?? getDefaultActionUrl();
  const pairingGraceMs = opts.pairingGraceMs ?? DEFAULT_PAIRING_GRACE_MS;
  const recoveryHorizonMs =
    opts.recoveryHorizonMs ?? DEFAULT_RECOVERY_HORIZON_MS;

  return {
    name: MISSED_WAVE_REVIEW_DISPATCH_RULE_NAME,

    async matches(events, now) {
      const nowMs = now.getTime();
      const matches: ReconcilerMatch[] = [];

      // Candidate exits: build-review, exitCode===0, correlationId set,
      // older than pairingGraceMs, younger than recoveryHorizonMs.
      // (factory-core-wlsr.15: detection predicate preserved unchanged.)
      const candidates = events.filter((e) => {
        if (e.type !== "agent-exited") return false;
        if (e.stage !== "build-review") return false;
        if (!e.correlationId) return false;
        const payload = e.payload as { exitCode?: number | null } | undefined;
        if (payload?.exitCode !== 0) return false;
        const ageMs = nowMs - Date.parse(e.timestamp);
        if (!Number.isFinite(ageMs)) return false;
        if (ageMs < pairingGraceMs) return false; // too recent — still in the sync window
        if (ageMs > recoveryHorizonMs) return false; // too old — don't try to recover
        return true;
      });

      for (const exitEvent of candidates) {
        // Look for a matching stage-dispatched event with the same
        // correlationId, AFTER the exit, dispatching one of the expected
        // downstream actions.
        // (factory-core-wlsr.15: pairing predicate preserved unchanged.)
        const paired = events.find(
          (e) =>
            e.type === "stage-dispatched" &&
            e.correlationId === exitEvent.correlationId &&
            Date.parse(e.timestamp) >= Date.parse(exitEvent.timestamp) &&
            (() => {
              const payload = e.payload as { toAction?: string } | undefined;
              return (
                payload?.toAction === "start-wave" ||
                payload?.toAction === "run-smoke-test" ||
                payload?.toAction === "review-wave"
              );
            })(),
        );

        if (paired) continue; // Chain dispatched normally — no recovery needed

        // factory-core-wlsr.15: capture rule-side context for coherence.
        // recentEvents (last N scoped to epic, newest-first) is derived
        // at match time so act() can build EscalationContext without
        // re-reading the event log. The original exit metadata is also
        // preserved on context for waveCompletionEvidence.
        const recentEvents = recentEpicEvents(
          events,
          exitEvent.epicId,
          RECENT_EVENTS_CAP,
        );

        // factory-core-wlsr.15: idempotency key gains stage + anomalyType
        // discriminators per ADR-015 § Consequences refinement of ADR-009.
        // The correlationId component is preserved (per-exit specificity is
        // part of the unchanged detection scope per AC #1) — diverges from
        // coherence-escalation.ts's three-component (rule-name, epicId,
        // stage) shape; divergence documented in the bead marker per AC #5.
        const idempotencyKey = `${MISSED_WAVE_REVIEW_DISPATCH_RULE_NAME}::${exitEvent.epicId}::${MISSED_WAVE_REVIEW_DISPATCH_STAGE}::${MISSED_WAVE_REVIEW_DISPATCH_ANOMALY_TYPE}::${exitEvent.correlationId}`;

        matches.push({
          idempotencyKey,
          epicId: exitEvent.epicId,
          context: {
            originalExitAt: exitEvent.timestamp,
            originalCorrelationId: exitEvent.correlationId,
            originalPayload: exitEvent.payload,
            recentEvents,
          },
        });
      }

      return matches;
    },

    async act(match) {
      const epicId = match.epicId;
      const ctx = match.context as
        | {
            originalExitAt?: string;
            originalCorrelationId?: string;
            originalPayload?: unknown;
            recentEvents?: EventSummary[];
          }
        | undefined;

      console.log(
        `[missed-wave-review-dispatch] (wlsr.15 cutover) escalating ${epicId} to coherence: missed dispatch after build-review exit (correlation: ${
          ctx?.originalCorrelationId ?? "<unknown>"
        })`,
      );

      const snapshot = await opts.readEpicSnapshot(epicId);

      if (snapshot.waveStatus.error) {
        // Pre-cutover threw on snapshot.waveStatus.error here so the
        // reconciler retried on the next tick. Post-cutover preserves
        // that contract — coherence cannot reason about wave completion
        // without a usable wave-status snapshot, so we throw and let
        // the reconciler's always-emit-action-taken safety consume the
        // idempotency bucket with an error payload (zsjv hotfix
        // 2026-04-21 in reconciler.ts) rather than dispatching a
        // partial EscalationContext.
        throw new Error(
          `[missed-wave-review-dispatch] cannot determine wave state for ${epicId}: ${snapshot.waveStatus.error}`,
        );
      }

      // factory-core-wlsr.15: build EscalationContext per ADR-015 § 3.
      // - anomalyType: closed enum value "missed-wave-review-dispatch".
      // - epicId, ruleId: identification.
      // - recentEvents: last 10 epic-scoped events (snapshotted at match-time).
      // - marker: undefined — missed-wave-review-dispatch is event-log-
      //   triggered (build-review agent-exited), not marker-triggered, so
      //   there is no marker to attach.
      // - ruleSpecificContext: { waveNumber, waveCompletionEvidence } per
      //   ADR-015 § 2 audit-table row. waveCompletionEvidence captures the
      //   snapshot's wave-status fields plus the original exit metadata so
      //   coherence can verify whether the wave was actually complete.
      //   (NOTE: marker is a top-level EscalationContext field per ADR-015
      //   § 3; ruleSpecificContext does NOT include marker.)
      const waveNumber: number | null = snapshot.waveStatus.hasWaves
        ? snapshot.waveStatus.currentWave
        : null;

      // waveCompletionEvidence: structured payload coherence reasons over to
      // decide whether the wave was actually complete or whether review was
      // skipped intentionally. Sources:
      //   - hasWaves / currentWave / allWavesComplete: from EpicSnapshot.waveStatus
      //     (the same wave-status surface readEpicState reads from bd via
      //     waveStatus aggregation in agent-launcher.ts).
      //   - openBugCount: from EpicSnapshot.openBugCount (-1 sentinel = bd
      //     failure → "assume bugs"; coherence treats sentinel as a
      //     don't-trust-this-evidence marker).
      //   - exitedAt / exitCorrelationId: the build-review exit that
      //     triggered the match (preserved from match.context). Lets
      //     coherence cross-reference the events.jsonl entry.
      const waveCompletionEvidence = {
        hasWaves: snapshot.waveStatus.hasWaves,
        currentWave: snapshot.waveStatus.currentWave,
        allWavesComplete: snapshot.waveStatus.allWavesComplete,
        openBugCount: snapshot.openBugCount,
        exitedAt: ctx?.originalExitAt ?? null,
        exitCorrelationId: ctx?.originalCorrelationId ?? null,
      };

      const escalationContext: EscalationContext = {
        anomalyType: MISSED_WAVE_REVIEW_DISPATCH_ANOMALY_TYPE,
        epicId,
        ruleId: MISSED_WAVE_REVIEW_DISPATCH_RULE_NAME,
        recentEvents: ctx?.recentEvents ?? [],
        // marker omitted — this rule is event-log triggered, not marker-triggered.
        ruleSpecificContext: {
          waveNumber,
          waveCompletionEvidence,
        },
      };

      // -----------------------------------------------------------------
      // beads_web-ehp.7: dispatch-precondition gate.
      //
      // Architecture § Seam 5 (defense-in-depth): the gate runs BEFORE the
      // action-route fetch so the rule never escalates to coherence (and
      // never pollutes the event log with a downstream agent dispatch)
      // when the LOGICAL recovery action — `review-wave` — would itself
      // be unsafe. The two load-bearing refusals this gate produces:
      //   - PLAN_FILE_MISSING — no plan file at .beads/plans/<epic>.md;
      //     coherence can't sensibly review a wave whose plan is absent.
      //   - NO_WAVE_BEADS / ALL_WAVE_BEADS_CLOSED — no open wave-N beads
      //     exist for the wave we'd recover; the niii reviewer-4-wave-4-
      //     redundant reproduction (epic at wave:4 but every wave:4 bead
      //     is closed) MUST refuse here so the redispatch loop stops.
      //
      // Per the ehp.7 risk flag: NO_WAVE_BEADS and ALL_WAVE_BEADS_CLOSED
      // are both registered against `review-wave` in the EXTENDED_
      // PRECONDITION_TABLE (per ehp.13's PRECOND_WAVE_BEADS_EXIST and
      // PRECOND_WAVE_BEADS_NOT_ALL_CLOSED — both have the same fire
      // condition: openWaveBeadIds.length === 0). The first predicate
      // to fire wins; v1 cannot disambiguate "no beads at all" from
      // "all closed" via openWaveBeadIds alone. Tests assert the refusal
      // code is in {NO_WAVE_BEADS, ALL_WAVE_BEADS_CLOSED} per the v1
      // limitation noted at dispatch-preconditions.ts § PRECOND_WAVE_BEADS_*.
      //
      // Why use PRECONDITION_ACTION (`review-wave`) and not DISPATCH_ACTION
      // (`run-coherence-agent`): the predicates we need (PLAN_FILE_MISSING,
      // NO_WAVE_BEADS) are registered for `review-wave` because that's the
      // canonical "wave-related" action; they are NOT registered for
      // `run-coherence-agent` because other coherence escalations target
      // non-wave anomalies. Mirrors stuck-in-stage.ts's `precondAction`
      // pattern (line ~430): the gate runs against the action the rule
      // INTENDS to recover, not the action it actually dispatches.
      //
      // Universal predicates (Class A.5 BD_STATUS_DEFERRED / BD_STATUS_CLOSED,
      // Class C OPERATOR_DECISION_PENDING / REVIEW_NEEDS_HUMAN) ALWAYS fire
      // — `appliesTo` returns true for every action — so closed/deferred
      // protection lands regardless of which action name is passed.
      //
      // On refusal: structured warn-line tagged `reconciler_dispatch_refused`
      // + appendEvent of type RECONCILER_ACTION_REFUSED to opts.repoPath
      // with payload.ruleName + action + refusalCode + failedCheck + reason
      // + stage='build-review' (the missed-dispatch stage); early return
      // WITHOUT dispatching.
      //
      // FOLLOW-ON (architecture ADR-006, mirrored from ehp.4 / .5 / .6):
      // refusals currently consume the `reconciler-action-taken` idempotency
      // bucket because reconciler.ts appends that event unconditionally
      // after act() returns. The proper bucketing key for refusals is
      // (epicId, ruleName, refusalCode, 15-min window). Implementing it
      // requires a reconciler.ts change tracked separately.
      // -----------------------------------------------------------------
      if (opts.repoPath) {
        const precondCtx = await buildDispatchContext({
          epicId,
          repoPath: opts.repoPath,
          action: PRECONDITION_ACTION,
          // waveNumber required for the wave-beads predicates (NO_WAVE_BEADS
          // / ALL_WAVE_BEADS_CLOSED). When the snapshot reports no waves,
          // skip passing it — those predicates only apply to wave actions
          // when waveNumber is meaningful.
          waveNumber: snapshot.waveStatus.hasWaves
            ? snapshot.waveStatus.currentWave
            : undefined,
        });
        const precondResult = evaluatePreconditions(precondCtx);
        if (!precondResult.ok) {
          console.warn(
            `[missed-wave-review-dispatch] reconciler_dispatch_refused: rule=${MISSED_WAVE_REVIEW_DISPATCH_RULE_NAME} epicId=${epicId} action=${PRECONDITION_ACTION} stage=${MISSED_WAVE_REVIEW_DISPATCH_STAGE} refusalCode=${precondResult.refusalCode} failedCheck=${precondResult.failedCheck} reason="${precondResult.reason}"`,
          );
          await appendEvent(opts.repoPath, {
            type: RECONCILER_ACTION_REFUSED,
            epicId,
            stage: MISSED_WAVE_REVIEW_DISPATCH_STAGE,
            payload: {
              ruleName: MISSED_WAVE_REVIEW_DISPATCH_RULE_NAME,
              action: PRECONDITION_ACTION,
              refusalCode: precondResult.refusalCode,
              failedCheck: precondResult.failedCheck,
              reason: precondResult.reason,
            },
          });
          return;
        }
      } else {
        console.warn(
          `[missed-wave-review-dispatch] precondition gate skipped — no repoPath configured (rule built without ehp.7 wiring); proceeding with pre-ehp.7 dispatch`,
        );
      }

      // factory-core-wlsr.15: dispatch run-coherence-agent (NOT the
      // pre-cutover start-wave / run-smoke-test action chosen by
      // legacyActionSelection). Mirrors the coherence-escalation rule's
      // dispatch shape:
      //   { action, epicId, epicTitle, currentLabels, anomalyClass,
      //     escalationContext }
      // and adds the structured `escalationContext` field carrying the
      // payload coherence consumes during diagnosis.
      //
      // anomalyClass: legacy field for downstream consumers (dashboard CTA,
      // journal entries). Set to the anomalyType value so the legacy field
      // carries the same signal as the ADR-015 escalationContext.
      //
      // zsjv hotfix 2026-04-21: fetch timeout — action endpoint can
      // hang under lock contention; without a cap, act() hangs forever.
      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), 15_000);
      let res: Response;
      try {
        res = await fetch(actionUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: DISPATCH_ACTION,
            epicId,
            epicTitle: snapshot.title,
            currentLabels: snapshot.labels,
            anomalyClass: MISSED_WAVE_REVIEW_DISPATCH_ANOMALY_TYPE,
            // ADR-015 structured handoff. Coherence reads this on launch.
            escalationContext,
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutHandle);
      }

      // -----------------------------------------------------------------
      // beads_web-ehp.7: route-side precondition refusal (HTTP 412).
      //
      // Architecture § Seam 5 defense-in-depth: both the rule AND the
      // action route validate preconditions. If the route refuses with
      // 412 (route-side check caught state the rule's own check missed —
      // race window, label mutated mid-flight, etc.), the rule must
      // distinguish that from a genuine HTTP failure. 412 is a refusal:
      // log a structured warn-line tagged `reconciler_dispatch_refused_
      // at_route`, emit a `reconciler-action-refused` event with the
      // ROUTE_REFUSED_412 marker code, and return WITHOUT throwing.
      // Throwing would propagate to the reconciler tick handler and
      // count as an act() failure (which dispatches a different recovery
      // path — wrong semantics for a refusal). Mirrors ehp.4 / .5 / .6
      // 412 handling verbatim.
      // -----------------------------------------------------------------
      if (res.status === 412) {
        const text = await res.text().catch(() => "<unreadable>");
        console.warn(
          `[missed-wave-review-dispatch] reconciler_dispatch_refused_at_route: rule=${MISSED_WAVE_REVIEW_DISPATCH_RULE_NAME} epicId=${epicId} action=${DISPATCH_ACTION} stage=${MISSED_WAVE_REVIEW_DISPATCH_STAGE} httpStatus=412 body="${text}"`,
        );
        if (opts.repoPath) {
          await appendEvent(opts.repoPath, {
            type: RECONCILER_ACTION_REFUSED,
            epicId,
            stage: MISSED_WAVE_REVIEW_DISPATCH_STAGE,
            payload: {
              ruleName: MISSED_WAVE_REVIEW_DISPATCH_RULE_NAME,
              action: DISPATCH_ACTION,
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
          `[missed-wave-review-dispatch] coherence escalation for ${epicId} returned HTTP ${res.status}: ${text}`,
        );
      }

      console.log(
        `[missed-wave-review-dispatch] escalated ${epicId} to coherence (anomalyType=${MISSED_WAVE_REVIEW_DISPATCH_ANOMALY_TYPE}, waveNumber=${waveNumber ?? "<none>"}, allWavesComplete=${snapshot.waveStatus.allWavesComplete})`,
      );
    },
  };
}
// Keep the type reference so a future consumer (status endpoint) can
// import PipelineEvent from here if convenient. Silences an otherwise
// unused-import warning while providing a legitimate re-export surface.
export type { PipelineEvent };
