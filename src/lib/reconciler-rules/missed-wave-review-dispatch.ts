/**
 * factory-core-lfcf.4 — First real reconciler rule.
 *
 * Detects: a `build-review` agent exited successfully (exitCode === 0)
 * more than N seconds ago but no matching `stage-dispatched` event
 * followed — the chain was dropped. This is the 8sz5-class failure in
 * practice: something between detectAgentDone and fetch-to-action
 * swallowed the decision.
 *
 * Recovers: re-reads the epic's current wave state and dispatches the
 * same action that handleChainAction would have. For MVP:
 *   - openBugCount > 0 or current wave incomplete → start-wave (current)
 *   - all waves complete → run-smoke-test
 *
 * Idempotency key: `missed-wave-review-dispatch::<epicId>::<correlationId>`
 * — the exit's tmuxSessionName. If the reconciler has already recovered
 * this specific exit (or a human did manually), the action-taken event
 * blocks re-dispatch. Each distinct exit gets one recovery attempt per
 * idempotency horizon (default 1h).
 */

import type {
  PipelineEvent,
  /* intentionally unused in types below */
} from "../event-log";
import type { ReconcilerRule, ReconcilerMatch } from "../reconciler";

export const MISSED_WAVE_REVIEW_DISPATCH_RULE_NAME =
  "missed-wave-review-dispatch";

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
}

/**
 * Build the rule with its read-functions injected. Production call-site
 * in instrumentation.ts wires these to agent-launcher helpers; tests
 * pass stubs.
 */
export function buildMissedWaveReviewDispatchRule(
  opts: MissedWaveReviewDispatchRuleOptions,
): ReconcilerRule {
  const actionUrl = opts.actionUrl ?? "http://localhost:3000/api/fleet/action";
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

        matches.push({
          idempotencyKey: `${MISSED_WAVE_REVIEW_DISPATCH_RULE_NAME}::${exitEvent.epicId}::${exitEvent.correlationId}`,
          epicId: exitEvent.epicId,
          context: {
            originalExitAt: exitEvent.timestamp,
            originalCorrelationId: exitEvent.correlationId,
            originalPayload: exitEvent.payload,
          },
        });
      }

      return matches;
    },

    async act(match) {
      const epicId = match.epicId;
      console.log(
        `[lfcf.4] recovering missed wave-review dispatch for ${epicId} (exit correlation: ${
          (match.context as { originalCorrelationId?: string } | undefined)
            ?.originalCorrelationId ?? "<unknown>"
        })`,
      );

      const snapshot = await opts.readEpicSnapshot(epicId);

      if (snapshot.waveStatus.error) {
        throw new Error(
          `[lfcf.4] cannot determine wave state for ${epicId}: ${snapshot.waveStatus.error}`,
        );
      }

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

      const body: Record<string, unknown> = {
        action,
        epicId,
        epicTitle: snapshot.title,
        currentLabels: snapshot.labels,
      };
      if (waveNumber !== undefined) body.waveNumber = waveNumber;

      const res = await fetch(actionUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "<unreadable>");
        throw new Error(
          `[lfcf.4] recovery dispatch for ${epicId} returned HTTP ${res.status}: ${text}`,
        );
      }

      console.log(
        `[lfcf.4] recovered ${epicId}: dispatched ${action}${
          waveNumber ? ` (wave:${waveNumber})` : ""
        }`,
      );
    },
  };
}
// Keep the type reference so a future consumer (status endpoint) can
// import PipelineEvent from here if convenient. Silences an otherwise
// unused-import warning while providing a legitimate re-export surface.
export type { PipelineEvent };
