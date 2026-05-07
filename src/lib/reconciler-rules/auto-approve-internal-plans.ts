/**
 * beads_web-poh.13 (Option A) — Auto-approve internal plans.
 *
 * Floor for autonomous-mode plan-review on `ship-type:internal` epics.
 * The empirical block from factory-core-jcit (2026-05-07): after
 * test-spec wrote a status=success marker, the epic stalled at
 * `pipeline:plan-review + plan:pending` because nothing in the chain
 * fired `approve-plan`. start-wave was correctly refused with PLAN_PENDING,
 * the operator had to manually curl approve-plan to unblock.
 *
 * For ship-type:internal there is no policy gate at plan-review (the
 * operator IS the policy authority for internal work; planner + architect
 * + test-spec are sufficient). This rule fires `approve-plan` whenever
 * an internal epic carries plan:pending AND a test-spec marker reports
 * success. It is the rubber-stamp floor; quality judgement (Option C
 * "coherence as plan-reviewer") layers on top as a separate follow-on.
 *
 * Discovery: event-based — triggered by agent-exited events with
 * stage=test-spec. That keeps the rule scoped to epics whose test-spec
 * just completed in the reconciler's lookback window. Filesystem-walk
 * is intentionally NOT added here (the trigger event is reliable; an
 * orphaned plan:pending state is poh.18's territory, not ours).
 *
 * Match conditions:
 *   - Recent agent-exited event with stage=test-spec for the epic.
 *   - Epic carries ship-type:internal (via injected getEpicLabels).
 *   - Epic carries plan:pending.
 *   - Epic does NOT carry plan:approved (defends against double-fire).
 *   - test-spec marker exists for the epic with status=success.
 *
 * Idempotency: marker-driven-routing::<epicId>::test-spec is the
 * marker-driven-routing key already consumed when test-spec exits.
 * For this rule we use a distinct key shape:
 *   auto-approve-internal-plans::<epicId>
 * — one approval per epic until the conditions reset (plan:approved
 * lands, label gets removed for some reason, etc.). The reconciler
 * core's 60-min event-log dedupe protects against rapid re-fires;
 * approve-plan is also idempotent at the route layer.
 *
 * Non-internal ship types (wordpress-plugin, ios-app, etc.) are
 * untouched — the appliesTo gate filters them out at matches() time.
 * This is the bead's explicit AC2 ("auto-approve rule is gated to
 * internal").
 */

import type { ReconcilerRule, ReconcilerMatch } from "../reconciler";
import type { MarkerData } from "../marker-reader";
import { getDefaultActionUrl } from "../orchestrator-url";

export const AUTO_APPROVE_INTERNAL_PLANS_RULE_NAME =
  "auto-approve-internal-plans";

const TEST_SPEC_STAGE = "test-spec";
const SHIP_TYPE_INTERNAL_LABEL = "ship-type:internal";
const PLAN_PENDING_LABEL = "plan:pending";
const PLAN_APPROVED_LABEL = "plan:approved";

export interface AutoApproveInternalPlansRuleOptions {
  /** Read the epic's labels live (not from a stale cache). */
  getEpicLabels: (epicId: string) => Promise<string[]>;

  /** Read the test-spec marker for the epic. Null if missing. */
  readMarker: (
    repoPath: string,
    markerId: string,
  ) => Promise<MarkerData | null>;

  /** Read the epic's title for the dispatch payload. */
  readEpicTitle?: (epicId: string) => string;

  /** Repo path used for the marker read. */
  repoPath: string;

  /** Override the action URL for testing. */
  actionUrl?: string;
}

export function buildAutoApproveInternalPlansRule(
  opts: AutoApproveInternalPlansRuleOptions,
): ReconcilerRule {
  const actionUrl = opts.actionUrl ?? getDefaultActionUrl();

  return {
    name: AUTO_APPROVE_INTERNAL_PLANS_RULE_NAME,

    async matches(events) {
      const matches: ReconcilerMatch[] = [];

      // Collect epics that just had a test-spec agent exit. One per
      // epicId; later events overwrite earlier (we want the latest
      // signal in the lookback window).
      const epicIds = new Set<string>();
      for (const e of events) {
        if (
          e.type === "agent-exited" &&
          e.stage === TEST_SPEC_STAGE &&
          e.epicId
        ) {
          epicIds.add(e.epicId);
        }
      }

      for (const epicId of epicIds) {
        // Live label read — must not trust a stale snapshot. The label
        // set determines whether this rule applies to this epic at
        // all (ship-type:internal gating).
        let labels: string[];
        try {
          labels = await opts.getEpicLabels(epicId);
        } catch (err) {
          console.warn(
            `[auto-approve-internal-plans] getEpicLabels failed for ${epicId} — skip`,
            err instanceof Error ? err.message : err,
          );
          continue;
        }

        if (!labels.includes(SHIP_TYPE_INTERNAL_LABEL)) continue;
        if (!labels.includes(PLAN_PENDING_LABEL)) continue;
        if (labels.includes(PLAN_APPROVED_LABEL)) continue;

        // Verify the test-spec marker reports success — we only
        // rubber-stamp when the test-spec stage produced something. A
        // failed/aborted test-spec marker means the plan needs revision,
        // not approval; coherence (Option C) handles those cases.
        const markerId = `${epicId}-${TEST_SPEC_STAGE}`;
        let marker: MarkerData | null;
        try {
          marker = await opts.readMarker(opts.repoPath, markerId);
        } catch (err) {
          console.warn(
            `[auto-approve-internal-plans] readMarker failed for ${markerId} — skip`,
            err instanceof Error ? err.message : err,
          );
          continue;
        }
        if (!marker) continue;
        if (marker.status !== "success") continue;

        matches.push({
          idempotencyKey: `${AUTO_APPROVE_INTERNAL_PLANS_RULE_NAME}::${epicId}`,
          epicId,
          context: {
            labels,
            markerId,
          },
        });
      }

      return matches;
    },

    async act(match) {
      const context = match.context as {
        labels: string[];
        markerId: string;
      };

      const epicTitle = opts.readEpicTitle
        ? opts.readEpicTitle(match.epicId)
        : "";

      console.log(
        `[auto-approve-internal-plans] dispatching approve-plan for ${match.epicId} (test-spec marker=${context.markerId} success, ship-type:internal, plan:pending)`,
      );

      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), 15_000);
      try {
        const res = await fetch(actionUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "approve-plan",
            epicId: match.epicId,
            epicTitle,
            currentLabels: context.labels,
          }),
          signal: controller.signal,
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "<unreadable>");
          console.warn(
            `[auto-approve-internal-plans] approve-plan dispatch for ${match.epicId} returned HTTP ${res.status}: ${text}`,
          );
          return;
        }
        console.log(
          `[auto-approve-internal-plans] approve-plan succeeded for ${match.epicId}`,
        );
      } finally {
        clearTimeout(timeoutHandle);
      }
    },
  };
}
