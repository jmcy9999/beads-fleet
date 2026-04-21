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
 * zszt.2 guards this invariant at the QA-PASS and polish-PASS
 * boundaries in the synchronous handleChainAction. This reconciler rule
 * is the reconciler-side safety net: any epic that finds itself in an
 * inconsistent state gets rolled back to development and start-wave is
 * re-dispatched for the lowest open wave. Both mechanisms together
 * cover both "advance just happened" and "advance happened earlier and
 * is now visible as state".
 */

import type { ReconcilerRule, ReconcilerMatch } from "../reconciler";

export const WAVE_BEAD_MISMATCH_RULE_NAME = "wave-bead-mismatch";

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
}

export function buildWaveBeadMismatchRule(
  opts: WaveBeadMismatchRuleOptions,
): ReconcilerRule {
  const actionUrl = opts.actionUrl ?? "http://localhost:3000/api/fleet/action";

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

        // Idempotency: one action per (epic, incorrect-stage, open-wave).
        // If the rule rolls the epic back to development and another
        // upstream bug re-advances to the same stage with the same open
        // wave, this key collides and the action is suppressed inside the
        // horizon — but the next time the open wave differs (or epic
        // advances to a new wrong stage), a fresh key allows the action.
        matches.push({
          idempotencyKey: `${WAVE_BEAD_MISMATCH_RULE_NAME}::${epicId}::${snap.currentStage}::wave-${snap.lowestOpenWave}`,
          epicId,
          context: {
            wrongStage: snap.currentStage,
            dispatchWave: snap.lowestOpenWave,
          },
        });
      }

      return matches;
    },

    async act(match) {
      const context = match.context as {
        wrongStage: string;
        dispatchWave: number;
      };

      console.log(
        `[zsjv.2] wave-bead-mismatch for ${match.epicId}: pipeline=${context.wrongStage} but wave:${context.dispatchWave} open. Rolling back to development + dispatching start-wave ${context.dispatchWave}.`,
      );

      // Re-read snapshot at act-time for labels + title freshness.
      const snap = await opts.readEpicSnapshot(match.epicId);
      if (!snap) {
        throw new Error(
          `[zsjv.2] snapshot read failed for ${match.epicId} at act-time; retrying next tick`,
        );
      }

      // Roll pipeline label back to development. Uses addLabelsToEpic +
      // removeLabelsFromEpic via dynamic import so the rule module stays
      // portable (pipeline-labels.ts is server-only).
      try {
        const { addLabelsToEpic, removeLabelsFromEpic } = await import(
          "../pipeline-labels"
        );
        await removeLabelsFromEpic(match.epicId, [
          `pipeline:${context.wrongStage}`,
        ]);
        await addLabelsToEpic(match.epicId, ["pipeline:development"]);
      } catch (err) {
        console.error(
          `[zsjv.2] label rollback failed for ${match.epicId} — dispatching start-wave anyway:`,
          err instanceof Error ? err.message : err,
        );
      }

      const res = await fetch(actionUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "start-wave",
          epicId: match.epicId,
          epicTitle: snap.title,
          currentLabels: snap.labels,
          waveNumber: context.dispatchWave,
        }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "<unreadable>");
        throw new Error(
          `[zsjv.2] start-wave dispatch for ${match.epicId} wave:${context.dispatchWave} returned HTTP ${res.status}: ${text}`,
        );
      }

      console.log(
        `[zsjv.2] rolled back ${match.epicId} to development + dispatched start-wave ${context.dispatchWave}`,
      );
    },
  };
}
