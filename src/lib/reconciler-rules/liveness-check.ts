/**
 * factory-core-vy74.1 — Liveness-check rule.
 *
 * Detects stale `agent:running` labels — labels that remain on an epic
 * even though the actual tmux session has exited. Every other reconciler
 * rule (stuck-in-stage, wave-bead-mismatch, etc.) checks
 * hasAgentRunning and skips the epic if true; a stale label therefore
 * blocks ALL recovery for that epic.
 *
 * Root cause observed 2026-04-21: handleAgentExit clears
 * `agent:running` only if `!hasActiveAgentForEpic(epicId)`. The
 * in-process activeAgents Map can hold stale entries from dev-server
 * hot-reloads, duplicate exit firings, or process crashes. Any of
 * those lets the label survive after the real agent is gone.
 *
 * This rule closes the gap structurally. It doesn't trust the
 * activeAgents Map; it trusts `tmux list-sessions` (the OS's view of
 * what's actually running) and reconciles the bd label to match.
 *
 * Match conditions:
 *   - epic has `agent:running` label
 *   - no tmux session matching `shipyard-<epicId>-*` exists
 *
 * Act:
 *   - remove `agent:running` label
 *   - emit a synthetic `agent-exited` event with
 *     payload.reason='liveness-check-cleared-stale-label' so subsequent
 *     stuck-in-stage rules can engage with the epic on the next tick.
 *
 * Idempotency key: `liveness-check::<epicId>::<15-min-bucket>` —
 * one clearance per epic per 15-min window. If a real agent later
 * starts and exits, a fresh bucket opens a retry.
 */

import type { ReconcilerRule, ReconcilerMatch } from "../reconciler";

export const LIVENESS_CHECK_RULE_NAME = "liveness-check";

/** Bucket size for idempotency. Matches stuck-in-stage's 15-min window. */
export const DEFAULT_BUCKET_MS = 15 * 60_000;

export interface EpicSnapshot {
  /** True if the epic has agent:running on bd. */
  hasAgentRunning: boolean;
  /** True if a tmux session matching shipyard-<epicId>-* exists. */
  tmuxSessionAlive: boolean;
  /** Current pipeline stage (for the synthetic agent-exited event). */
  currentStage: string | null;
}

export interface LivenessCheckRuleOptions {
  /** Injected bd reader. Null = bd failure → skip. */
  readEpicSnapshot: (epicId: string) => Promise<EpicSnapshot | null>;
  /** Injected label mutator. */
  clearAgentRunning: (epicId: string) => Promise<void>;
  /** Injected event appender. Defaults to appendEvent in production. */
  appendSyntheticExit: (event: {
    epicId: string;
    stage: string | null;
    reason: string;
  }) => Promise<void>;
  /** Bucket size for idempotency keys. */
  bucketMs?: number;
}

export function buildLivenessCheckRule(
  opts: LivenessCheckRuleOptions,
): ReconcilerRule {
  const bucketMs = opts.bucketMs ?? DEFAULT_BUCKET_MS;

  return {
    name: LIVENESS_CHECK_RULE_NAME,

    async matches(events, now) {
      // Collect candidate epic ids from recent events. Same discovery
      // pattern as stuck-in-stage — avoids a global bd sweep on every
      // tick; the bootstrap seed + periodic re-seed keep the horizon
      // populated.
      const epicIds = new Set<string>();
      for (const e of events) {
        if (e.epicId) epicIds.add(e.epicId);
      }

      const matches: ReconcilerMatch[] = [];
      const windowStart = Math.floor(now.getTime() / bucketMs) * bucketMs;

      for (const epicId of epicIds) {
        const snap = await opts.readEpicSnapshot(epicId);
        if (!snap) continue; // bd failure — skip
        if (!snap.hasAgentRunning) continue; // label not set; nothing to clear
        if (snap.tmuxSessionAlive) continue; // real agent running; don't interfere

        matches.push({
          idempotencyKey: `${LIVENESS_CHECK_RULE_NAME}::${epicId}::${windowStart}`,
          epicId,
          context: {
            stage: snap.currentStage,
            windowStart,
          },
        });
      }

      return matches;
    },

    async act(match) {
      const context = match.context as {
        stage: string | null;
        windowStart: number;
      };

      console.log(
        `[liveness-check] clearing stale agent:running for ${match.epicId} (no matching tmux session; previous stage=${context.stage ?? "unknown"})`,
      );

      // Clear the label first so the stuck-in-stage rule can engage
      // immediately. If the label-clear fails the action-taken event
      // will still be emitted with success=false (reconciler does that
      // unconditionally) so idempotency blocks re-fire; next bucket
      // retries.
      await opts.clearAgentRunning(match.epicId);

      // Synthetic exit event lets downstream rules see a recent exit
      // timestamp for this epic, anchoring stuck-in-stage's staleness
      // window. Without this, the epic's "last event" could be very
      // old and stuck-in-stage would match immediately rather than
      // giving a fresh recovery cycle a chance.
      await opts.appendSyntheticExit({
        epicId: match.epicId,
        stage: context.stage,
        reason: "liveness-check-cleared-stale-label",
      });
    },
  };
}
