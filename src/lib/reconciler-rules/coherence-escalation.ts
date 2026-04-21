/**
 * factory-core-zsjv.4 — Coherence escalation rule.
 *
 * Watches for epics that have been flagged `review:needs-human` (by
 * zsjv.3's repeated-qa-round detector, or manually) but have not yet
 * had the coherence agent dispatched. Fires `run-coherence-agent` so
 * the Shipyard gets LLM judgment on the stuck state before requiring
 * Jane's attention.
 *
 * Sequence in practice:
 *   1. zsjv.3 detects qa:round-5+ with open bugs → adds
 *      `review:needs-human` to the epic.
 *   2. On the next reconciler tick, THIS rule matches on the presence
 *      of `review:needs-human` and the absence of a recent
 *      stage-dispatched(run-coherence-agent) event.
 *   3. Dispatches run-coherence-agent, which launches the coherence
 *      agent per `.claude/agents/coherence.md`.
 *   4. Coherence agent diagnoses + dispatches exactly one of:
 *      dispatch-chain-action / file-bug / re-plan / escalate.
 *   5. If the agent chooses `escalate`, the epic stays flagged for
 *      human attention and this rule does NOT re-fire (idempotency).
 *
 * Zero human touchpoints: `review:needs-human` now gets coherence-agent
 * diagnosis automatically before Jane even sees it. Only if coherence
 * itself escalates does the human actually need to act.
 */

import type { ReconcilerRule, ReconcilerMatch } from "../reconciler";

export const COHERENCE_ESCALATION_RULE_NAME = "coherence-escalation";

export interface EpicSnapshot {
  /** True if review:needs-human is present. */
  hasNeedsHuman: boolean;
  /** Labels for dispatch. */
  labels: string[];
  /** Title for dispatch. */
  title: string;
}

export interface CoherenceEscalationRuleOptions {
  actionUrl?: string;
  /**
   * Reads epic labels. Null = bd failure → skip.
   */
  readEpicSnapshot: (epicId: string) => Promise<EpicSnapshot | null>;
}

export function buildCoherenceEscalationRule(
  opts: CoherenceEscalationRuleOptions,
): ReconcilerRule {
  const actionUrl = opts.actionUrl ?? "http://localhost:3000/api/fleet/action";

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
        if (!snap.hasNeedsHuman) continue;

        // Has coherence already been dispatched recently? Check event
        // log for a stage-dispatched event with toAction="run-coherence-agent".
        const recentCoherenceDispatch = events.find((e) => {
          if (e.type !== "stage-dispatched") return false;
          if (e.epicId !== epicId) return false;
          const payload = e.payload as { toAction?: string } | undefined;
          return payload?.toAction === "run-coherence-agent";
        });
        if (recentCoherenceDispatch) continue; // already escalated

        // Idempotency key: epicId alone. Only one coherence dispatch per
        // epic per horizon; if coherence's action itself fails to resolve
        // the issue, a future tick after the idempotency horizon can
        // re-fire.
        matches.push({
          idempotencyKey: `${COHERENCE_ESCALATION_RULE_NAME}::${epicId}`,
          epicId,
        });
      }

      return matches;
    },

    async act(match) {
      const snap = await opts.readEpicSnapshot(match.epicId);
      if (!snap) {
        throw new Error(
          `[zsjv.4] snapshot read failed for ${match.epicId}; retry next tick`,
        );
      }

      console.log(
        `[zsjv.4] dispatching coherence agent for ${match.epicId} (review:needs-human present, no prior coherence dispatch)`,
      );

      const res = await fetch(actionUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "run-coherence-agent",
          epicId: match.epicId,
          epicTitle: snap.title,
          currentLabels: snap.labels,
          anomalyClass: "review-needs-human",
        }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "<unreadable>");
        throw new Error(
          `[zsjv.4] run-coherence-agent dispatch for ${match.epicId} returned HTTP ${res.status}: ${text}`,
        );
      }
    },
  };
}
