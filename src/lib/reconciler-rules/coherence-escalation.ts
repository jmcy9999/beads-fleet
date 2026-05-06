/**
 * factory-core-zsjv.4 — Coherence escalation rule.
 *
 * Watches for epics that need coherence-agent reasoning and dispatches it
 * before the operator has to act. The rule fires on TWO trigger surfaces:
 *
 *   Path (a) — narrow: epic has `review:needs-human` label (originally added
 *     by zsjv.3's repeated-qa-round detector, or set manually).
 *
 *   Path (b) — universal (factory-core-wlsr.7): the epic's latest marker, when
 *     interpreted via interpretMarkerForRouting, returns nextAgent=coherence.
 *     This includes status=needs-decision + BLOCKER, status=blocked +
 *     scope-conflict, status=failure, status=success + BLOCKER: in
 *     whats_open, and the operator→coherence stage-aware rewrite (per ADR-001
 *     and operator-set principle P2).
 *
 * Operator-set principle (factory-core-wlsr): coherence is the universal
 * off-ramp for ANY non-success outcome. Loop agents never route directly to
 * operator. The narrow path (a) and universal path (b) are unioned so
 * existing behaviour (review:needs-human) is preserved while the new
 * marker-driven trigger expands coverage.
 *
 * Sequence in practice (path a):
 *   1. zsjv.3 detects qa:round-5+ with open bugs → adds
 *      `review:needs-human` to the epic.
 *   2. On the next reconciler tick, this rule matches on the presence
 *      of `review:needs-human` and the absence of a recent
 *      stage-dispatched(run-coherence-agent) event.
 *   3. Dispatches run-coherence-agent.
 *
 * Sequence in practice (path b):
 *   1. A loop agent writes a marker with status=blocked / needs-decision /
 *      failure / success-with-BLOCKER, or with next_agent=operator from a
 *      LOOP_AGENT_STAGES caller (rewritten by interpretMarkerForRouting).
 *   2. interpretMarkerForRouting returns nextAgent=coherence.
 *   3. This rule (or marker-driven-routing — see "Cross-rule dedup" below)
 *      dispatches run-coherence-agent.
 *
 * Idempotency (factory-core-wlsr.7, ADR-009):
 *   The idempotency key is scoped to (epicId, stage). Same epic stuck in
 *   the same stage produces ONE dispatch per idempotency horizon; same epic
 *   transitioning through stages and getting re-stuck is allowed to refire
 *   because the stage component changes. The rule name prefix
 *   `coherence-escalation::` keeps these keys distinct from
 *   marker-driven-routing's `marker-driven-routing::<epicId>::<stage>` keys.
 *
 * Cross-rule dedup with marker-driven-routing (factory-core-wlsr.7 AC 5):
 *   Both rules can interpret the same marker as "→ coherence". The reconciler
 *   core dedups on (rule-name, idempotencyKey), so each rule fires at most
 *   once per (epicId, stage). Across rules, the existing stage-dispatched
 *   check below catches the case where one rule's dispatch produced a
 *   `stage-dispatched(run-coherence-agent)` event before the other rule's
 *   tick: subsequent ticks see the event and short-circuit. Within a single
 *   tick both rules may fire — accepted behaviour per the architecture
 *   (operator-set: rely on existing dedup + downstream agent-launcher
 *   protections rather than introducing cross-rule coupling).
 */

import type { ReconcilerRule, ReconcilerMatch } from "../reconciler";
import type { PipelineEvent } from "../event-log";
import type { MarkerData } from "../marker-reader";
import { interpretMarkerForRouting, type EpicStateSnapshot } from "../marker-routing";
import { getDefaultActionUrl } from "../orchestrator-url";

export const COHERENCE_ESCALATION_RULE_NAME = "coherence-escalation";

export interface EpicSnapshot {
  /** True if review:needs-human is present (path a trigger). */
  hasNeedsHuman: boolean;
  /** Labels for dispatch. */
  labels: string[];
  /** Title for dispatch. */
  title: string;
  /**
   * Current pipeline stage derived from the `pipeline:<stage>` label, or
   * null/undefined if no such label is present. Optional for backwards
   * compatibility with the pre-wlsr.7 EpicSnapshot shape — when absent,
   * path (a)'s idempotency key falls back to a synthetic stage marker
   * ("needs-human") so the key remains well-defined per ADR-009.
   */
  currentStage?: string | null;
}

export interface CoherenceEscalationRuleOptions {
  actionUrl?: string;
  /**
   * Reads epic labels. Null = bd failure → skip.
   */
  readEpicSnapshot: (epicId: string) => Promise<EpicSnapshot | null>;
  /**
   * Path (b) marker reader (factory-core-wlsr.7). Reads the marker file at
   * `<repoPath>/.beads/markers/<markerId>.json`. Null = file missing /
   * malformed / invalid → skip path (b) for that epic. Optional — when
   * undefined, only path (a) (review:needs-human) is exercised, preserving
   * the pre-wlsr.7 behaviour bit-for-bit.
   */
  readMarker?: (
    repoPath: string,
    markerId: string,
  ) => Promise<MarkerData | null>;
  /**
   * Path (b) repo path for marker reads. Required when readMarker is
   * provided.
   */
  repoPath?: string;
}

/**
 * Detect a recent `stage-dispatched(run-coherence-agent)` event for the
 * given epic. Used by both paths to short-circuit when coherence has
 * already been dispatched within the lookback window. This is the
 * cross-rule dedup mechanism (path-(a)/(b) within this rule, plus
 * dispatches from marker-driven-routing or any other source).
 */
function hasRecentCoherenceDispatch(
  events: PipelineEvent[],
  epicId: string,
): boolean {
  return events.some((e) => {
    if (e.type !== "stage-dispatched") return false;
    if (e.epicId !== epicId) return false;
    const payload = e.payload as { toAction?: string } | undefined;
    return payload?.toAction === "run-coherence-agent";
  });
}

/**
 * Find the latest agent-exited event for an epic. Used by path (b) to
 * derive the markerId — marker filenames for epic-scope agents follow the
 * convention `<epicId>-<stage>.json`, so we need the most recent stage.
 *
 * Returns null when no agent-exited event exists for the epic.
 */
function latestAgentExitedFor(
  events: PipelineEvent[],
  epicId: string,
): PipelineEvent | null {
  let latest: PipelineEvent | null = null;
  let latestMs = -Infinity;
  for (const e of events) {
    if (e.type !== "agent-exited") continue;
    if (e.epicId !== epicId) continue;
    if (!e.stage) continue;
    const ms = Date.parse(e.timestamp);
    if (Number.isNaN(ms)) continue;
    if (ms > latestMs) {
      latest = e;
      latestMs = ms;
    }
  }
  return latest;
}

export function buildCoherenceEscalationRule(
  opts: CoherenceEscalationRuleOptions,
): ReconcilerRule {
  const actionUrl = opts.actionUrl ?? getDefaultActionUrl();

  return {
    name: COHERENCE_ESCALATION_RULE_NAME,

    async matches(events, _now) {
      const epicIds = new Set<string>();
      for (const e of events) {
        if (e.epicId) epicIds.add(e.epicId);
      }

      const matches: ReconcilerMatch[] = [];

      for (const epicId of epicIds) {
        const snap = await opts.readEpicSnapshot(epicId);
        if (!snap) continue;

        // Cross-rule dedup: any rule (path a, path b, marker-driven-
        // routing) that has dispatched run-coherence-agent recently
        // should suppress further coherence dispatches. Computed once
        // per epic.
        const alreadyDispatched = hasRecentCoherenceDispatch(events, epicId);
        if (alreadyDispatched) continue;

        // -----------------------------------------------------------
        // Path (a) — narrow: review:needs-human label (preserved behaviour)
        // -----------------------------------------------------------
        if (snap.hasNeedsHuman) {
          // Per-rule idempotency key includes (epicId, stage) per ADR-009.
          // For path (a) we use snapshot.currentStage (the pipeline:<stage>
          // label); when absent, fall back to "needs-human" so the key
          // is still well-defined.
          const stageScope = snap.currentStage ?? "needs-human";
          const key = `${COHERENCE_ESCALATION_RULE_NAME}::${epicId}::${stageScope}`;

          matches.push({
            idempotencyKey: key,
            epicId,
            context: {
              path: "a",
              trigger: "review:needs-human",
              stage: stageScope,
            },
          });
          // Path (a) and path (b) are not mutually exclusive in principle,
          // but each produces a separate match. We continue to evaluate
          // path (b) only if readMarker is configured AND path (a) didn't
          // already produce a match for the same stage scope. Avoiding a
          // duplicate match on the same key keeps the matcher tidy; the
          // reconciler core would dedup downstream regardless.
          continue;
        }

        // -----------------------------------------------------------
        // Path (b) — universal (factory-core-wlsr.7): marker → coherence
        // -----------------------------------------------------------
        if (!opts.readMarker || !opts.repoPath) continue;

        const latestExit = latestAgentExitedFor(events, epicId);
        if (!latestExit || !latestExit.stage) continue;

        const markerId = `${epicId}-${latestExit.stage}`;
        let marker: MarkerData | null = null;
        try {
          marker = await opts.readMarker(opts.repoPath, markerId);
        } catch (err) {
          console.warn(
            `[coherence-escalation] readMarker(${markerId}) threw — skip:`,
            err instanceof Error ? err.message : err,
          );
          continue;
        }
        if (!marker) continue;

        // Build a routing snapshot for interpretMarkerForRouting. The
        // function ignores the snapshot today (per marker-routing.ts) but
        // we supply it for type compatibility.
        const routingSnapshot: EpicStateSnapshot = {
          epicId,
          currentStage: snap.currentStage ?? latestExit.stage,
          labels: snap.labels,
        };

        const decision = interpretMarkerForRouting(marker, routingSnapshot);
        if (!decision.override) continue;
        if (decision.nextAgent !== "coherence") continue;

        // Idempotency key for path (b) uses the marker's stage. ADR-009:
        // stage-scope means same (epicId, stage) does NOT refire within
        // horizon, but a stage transition (epic moves builder→reviewer)
        // changes the key and allows refire if the epic gets re-stuck.
        const stage =
          (typeof marker.stage === "string" && marker.stage.trim()) ||
          latestExit.stage;
        const key = `${COHERENCE_ESCALATION_RULE_NAME}::${epicId}::${stage}`;

        matches.push({
          idempotencyKey: key,
          epicId,
          context: {
            path: "b",
            trigger: "marker-routing",
            stage,
            markerId,
            markerStatus: marker.status,
            markerNextAgent: marker.next_agent,
            decisionReason: decision.reason,
          },
        });
      }

      return matches;
    },

    async act(match) {
      const snap = await opts.readEpicSnapshot(match.epicId);
      if (!snap) {
        throw new Error(
          `[coherence-escalation] snapshot read failed for ${match.epicId}; retry next tick`,
        );
      }

      const ctx = (match.context ?? {}) as {
        path?: "a" | "b";
        trigger?: string;
        stage?: string;
        decisionReason?: string;
      };
      const path = ctx.path ?? "a";
      const trigger = ctx.trigger ?? "review:needs-human";
      const reasonSuffix =
        path === "b"
          ? `decision=${ctx.decisionReason ?? "marker-routing"}`
          : "review:needs-human present";

      console.log(
        `[coherence-escalation] dispatching coherence agent for ${match.epicId} (path=${path}, trigger=${trigger}, ${reasonSuffix})`,
      );

      // Path (a): preserve the legacy anomalyClass "review-needs-human"
      // for backwards-compat with downstream consumers that key off it
      // (e.g., dashboard CTA, journal entries). Path (b): use a generic
      // anomalyClass that signals marker-driven escalation; coherence
      // reads the marker context itself, so a fine-grained taxonomy is
      // not required (per operator-set principle P3).
      const anomalyClass =
        path === "b" ? "marker-routing-coherence" : "review-needs-human";

      // zsjv hotfix 2026-04-21: fetch timeout.
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
            epicTitle: snap.title,
            currentLabels: snap.labels,
            anomalyClass,
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutHandle);
      }

      if (!res.ok) {
        const text = await res.text().catch(() => "<unreadable>");
        throw new Error(
          `[coherence-escalation] run-coherence-agent dispatch for ${match.epicId} returned HTTP ${res.status}: ${text}`,
        );
      }
    },
  };
}
