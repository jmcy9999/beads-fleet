/**
 * factory-core-zsjv.1 — Stuck-in-stage detector.
 *
 * Generalises factory-core-lfcf.4 (which only caught missed
 * build-review dispatches) to every pipeline stage. When an epic has
 * been at pipeline:X for longer than the staleness window, has no
 * agent:running label, and has had no recent events, the reconciler
 * dispatches the canned resume action for stage X. This closes the
 * 8sz5-class failure at every stage, not just after review.
 *
 * Design notes:
 *   - Epics are discovered via recent agent-exited events rather than a
 *     bd query. This keeps the rule scoped to epics the reconciler has
 *     observed in its lifetime. Pre-existing stalls from before the
 *     event log existed are invisible (acceptable for MVP — owner
 *     resolves historical debt manually).
 *   - Stage → action mapping is a finite table. Unknown stages (e.g.
 *     submission-prep, live) are intentionally NOT in the table because
 *     their resume actions are owner/platform-owned rather than
 *     automatic.
 *   - Idempotency window ties a match to a (epic, stage, 15-min
 *     window-start) triple so successive ticks inside the same stall
 *     don't re-fire. Next stall window gets a fresh idempotency key.
 */

import type { PipelineEvent } from "../event-log";
import type { ReconcilerRule, ReconcilerMatch } from "../reconciler";

export const STUCK_IN_STAGE_RULE_NAME = "stuck-in-stage";

/** 15 min default — short enough to recover from typical drops, long
 *  enough that normal agent runs (which can take 5-10 min) don't trigger
 *  premature re-dispatches. */
export const DEFAULT_STALENESS_MS = 15 * 60_000;

/** How far back in the event log to look for candidate epics. */
export const DEFAULT_DISCOVERY_HORIZON_MS = 60 * 60_000; // 1 hour

/**
 * Canonical stage → resume-action mapping. Each entry describes the
 * exact /api/fleet/action to fire when the stage is stuck.
 *
 * Stages NOT in this table are intentionally left alone (submission-
 * related stages, terminal states, and stages whose recovery involves
 * owner decision rather than mechanical re-fire).
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
}

export function buildStuckInStageRule(
  opts: StuckInStageRuleOptions,
): ReconcilerRule {
  const actionUrl = opts.actionUrl ?? "http://localhost:3000/api/fleet/action";
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

        const resume = STAGE_RESUME_ACTIONS[snapshot.currentStage];
        if (!resume) continue; // stage has no canned recovery

        if (resume.needsWaveNumber && !snapshot.currentWave) continue; // can't act without it

        // Bucket the idempotency key by 15-minute windows so that if the
        // rule fires once and the dispatch itself fails (or we fail to
        // detect recovery), the NEXT stall window gets a fresh key and
        // can retry. Without bucketing, one failed attempt would mark
        // the stall permanently-attempted for the idempotency horizon.
        const windowStart = Math.floor(nowMs / stalenessMs) * stalenessMs;
        const idempotencyKey = `${STUCK_IN_STAGE_RULE_NAME}::${epicId}::${snapshot.currentStage}::${windowStart}`;

        matches.push({
          idempotencyKey,
          epicId,
          context: {
            stage: snapshot.currentStage,
            resumeAction: resume.action,
            currentWave: snapshot.currentWave,
            lastEventAt: lastEvent.timestamp,
            ageMs,
          },
        });
      }

      return matches;
    },

    async act(match) {
      const context = match.context as {
        stage: string;
        resumeAction: string;
        currentWave?: number;
        lastEventAt: string;
        ageMs: number;
      };

      console.log(
        `[zsjv.1] stuck-in-stage recovery for ${match.epicId}: stage=${context.stage}, last event ${new Date(context.lastEventAt).toISOString()}, age=${Math.floor(context.ageMs / 60_000)}min, dispatching ${context.resumeAction}`,
      );

      // Re-read snapshot just before dispatch so we have fresh labels +
      // title. Matches lfcf.4's pattern.
      const snapshot = await opts.readEpicSnapshot(match.epicId);
      if (!snapshot) {
        throw new Error(
          `[zsjv.1] snapshot read failed for ${match.epicId} at act-time; retrying next tick`,
        );
      }
      if (snapshot.hasAgentRunning) {
        // Race: an agent started between match and act. Abort quietly —
        // the idempotency window still records this attempt so we don't
        // re-fire immediately.
        console.log(
          `[zsjv.1] abort: ${match.epicId} now has agent:running`,
        );
        return;
      }

      const body: Record<string, unknown> = {
        action: context.resumeAction,
        epicId: match.epicId,
        epicTitle: snapshot.title,
        currentLabels: snapshot.labels,
      };
      if (context.currentWave !== undefined) {
        body.waveNumber = context.currentWave;
      }

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
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutHandle);
      }

      if (!res.ok) {
        const text = await res.text().catch(() => "<unreadable>");
        throw new Error(
          `[zsjv.1] recovery dispatch for ${match.epicId} returned HTTP ${res.status}: ${text}`,
        );
      }

      console.log(
        `[zsjv.1] recovered ${match.epicId}: dispatched ${context.resumeAction}`,
      );
    },
  };
}
