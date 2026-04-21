/**
 * factory-core-zsjv.3 — Repeated-QA-round detector.
 *
 * Catches QA loops that aren't converging. When an epic reaches
 * qa:round-N with N >= 5 and still has open bugs under it, flag for
 * human attention by adding `review:needs-human`. v1 is a threshold
 * flag only — v2 (zsjv.4) escalates to the coherence agent for
 * LLM-judgment on whether to re-plan, file a shaped bug set, or
 * escalate further.
 *
 * Why a flag rather than another auto-dispatch: a mechanical
 * re-dispatch (e.g. "run another QA round") would just produce
 * qa:round-N+1 with the same bugs. If QA hasn't converged after 5
 * rounds, the problem is judgmental — missing acceptance criteria,
 * mis-scoped architecture, actual novel defects — not mechanical. The
 * right response is human (or coherence-agent) diagnosis.
 */

import type { ReconcilerRule, ReconcilerMatch } from "../reconciler";

export const REPEATED_QA_ROUND_RULE_NAME = "repeated-qa-round";

/** Round threshold. 5 rounds of QA without resolution indicates the
 *  loop is stuck. Below this, give normal QA a chance to converge. */
export const DEFAULT_ROUND_THRESHOLD = 5;

export interface EpicSnapshot {
  /** Current pipeline stage. */
  currentStage: string | null;
  /** Highest qa:round-N label value found on the epic. 0 if none. */
  highestQaRound: number;
  /** Open bug count under the epic. -1 = bd failure (fail-safe skip). */
  openBugCount: number;
  /** True if review:needs-human already present. */
  hasNeedsHuman: boolean;
  /** Labels for the epic. */
  labels: string[];
  /** Title for dispatch. */
  title: string;
}

export interface RepeatedQaRoundRuleOptions {
  /** Minimum round count before flagging. Default 5. */
  roundThreshold?: number;
  /** Injected bd reader. Null result = skip (bd failure). */
  readEpicSnapshot: (epicId: string) => Promise<EpicSnapshot | null>;
}

export function buildRepeatedQaRoundRule(
  opts: RepeatedQaRoundRuleOptions,
): ReconcilerRule {
  const roundThreshold = opts.roundThreshold ?? DEFAULT_ROUND_THRESHOLD;

  return {
    name: REPEATED_QA_ROUND_RULE_NAME,

    async matches(events, _now) {
      const epicIds = new Set<string>();
      for (const e of events) {
        if (e.epicId) epicIds.add(e.epicId);
      }

      const matches: ReconcilerMatch[] = [];

      for (const epicId of epicIds) {
        const snap = await opts.readEpicSnapshot(epicId);
        if (!snap) continue;
        if (snap.currentStage !== "qa") continue;
        if (snap.openBugCount === -1) continue; // bd failure — skip
        if (snap.openBugCount === 0) continue; // no open bugs — QA passing
        if (snap.highestQaRound < roundThreshold) continue;
        if (snap.hasNeedsHuman) continue; // already flagged

        // Idempotency: one match per (epic, round). If QA advances to a
        // higher round and still has bugs, a fresh match fires at that
        // new round number.
        matches.push({
          idempotencyKey: `${REPEATED_QA_ROUND_RULE_NAME}::${epicId}::round-${snap.highestQaRound}`,
          epicId,
          context: {
            round: snap.highestQaRound,
            openBugCount: snap.openBugCount,
          },
        });
      }

      return matches;
    },

    async act(match) {
      const context = match.context as {
        round: number;
        openBugCount: number;
      };

      console.log(
        `[zsjv.3] repeated-qa-round for ${match.epicId}: round ${context.round} with ${context.openBugCount} open bugs — flagging review:needs-human`,
      );

      try {
        const { addLabelsToEpic } = await import("../pipeline-labels");
        await addLabelsToEpic(match.epicId, ["review:needs-human"]);
      } catch (err) {
        throw new Error(
          `[zsjv.3] addLabelsToEpic(review:needs-human) failed for ${match.epicId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };
}
