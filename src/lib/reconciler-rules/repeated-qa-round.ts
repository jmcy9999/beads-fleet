/**
 * factory-core-zsjv.3 — Repeated-QA-round detector.
 *
 * Catches QA loops that aren't converging. Two independent branches:
 *
 * Branch 1 (bugs-not-decreasing, zsjv.3 v1):
 *   When an epic reaches qa:round-N with N >= 5 and still has open bugs
 *   under it, flag for human attention by adding `review:needs-human`.
 *
 * Branch 2 (PASS-with-no-progress, beads_web-b98):
 *   When K consecutive rounds (default K=3) all show verdict=PASS AND
 *   openBugCount unchanged between rounds, flag review:needs-human.
 *   Defense-in-depth that fires earlier than 2r2m's maxRounds ceiling
 *   AND earlier than Branch 1's roundThreshold=5.
 *
 *   Data source: marker-read (post-mejh). Each QA round writes a marker
 *   at <repo>/.beads/markers/<epicId>-qa-round-<N>.json containing
 *   `verdict` and `open_bugs` fields. The reconciler reads round-1..N
 *   markers to compute progression. Chosen over event-log extension
 *   because openBugCountAtExit (per zsjv.3 design intent) never landed
 *   in agent-launcher.ts, and marker-read stays within the 2-file
 *   manifest baseline without modifying agent-launcher.ts.
 *
 * v2 (zsjv.4) escalates to the coherence agent for LLM-judgment on
 * whether to re-plan, file a shaped bug set, or escalate further.
 *
 * Why a flag rather than another auto-dispatch: a mechanical
 * re-dispatch (e.g. "run another QA round") would just produce
 * qa:round-N+1 with the same bugs. If QA hasn't converged after 5
 * rounds (Branch 1) or K consecutive PASS-with-no-delta rounds
 * (Branch 2), the problem is judgmental — missing acceptance criteria,
 * mis-scoped architecture, actual novel defects — not mechanical. The
 * right response is human (or coherence-agent) diagnosis.
 */

import type { ReconcilerRule, ReconcilerMatch } from "../reconciler";

export const REPEATED_QA_ROUND_RULE_NAME = "repeated-qa-round";

/** Round threshold for Branch 1 (bugs-not-decreasing). 5 rounds of
 *  QA without resolution indicates the loop is stuck. Below this, give
 *  normal QA a chance to converge. */
export const DEFAULT_ROUND_THRESHOLD = 5;

/**
 * beads_web-b98: K-consecutive threshold for Branch 2 (PASS-with-no-progress).
 * When K consecutive rounds all show verdict=PASS AND openBugCount unchanged,
 * the loop is stuck in a no-progress cycle. K=3 fires at round 3 (after
 * rounds 1/2/3 all show PASS-with-no-delta) — earlier than Branch 1's
 * roundThreshold=5 AND earlier than 2r2m's maxRounds=20 ceiling.
 *
 * Independent of DEFAULT_ROUND_THRESHOLD: the two branches detect orthogonal
 * patterns (Branch 1 needs openBugCount > 0; Branch 2 needs PASS-with-no-delta).
 */
export const DEFAULT_NO_PROGRESS_THRESHOLD = 3;

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

/**
 * beads_web-b98: Cross-round marker data for the no-progress branch.
 * Sourced from QA round markers at <repo>/.beads/markers/<epicId>-qa-round-<N>.json
 * (post-mejh marker-read scaffolding, commit 931d8e2).
 */
export interface QaRoundMarkerData {
  /** QA verdict for this round. "PASS" | "FAIL" | "SKIP" | "UNKNOWN" | undefined. */
  verdict?: string;
  /** Open bug count at end of this round. undefined = field not present in marker. */
  openBugs?: number;
}

export interface RepeatedQaRoundRuleOptions {
  /** Minimum round count before flagging (Branch 1: bugs-not-decreasing). Default 5. */
  roundThreshold?: number;
  /**
   * beads_web-b98: K-consecutive threshold for Branch 2 (PASS-with-no-progress).
   * Default 3. Fires when K consecutive rounds all show verdict=PASS AND
   * openBugCount unchanged between rounds. Independent of roundThreshold.
   */
  noProgressThreshold?: number;
  /** Injected bd reader. Null result = skip (bd failure). */
  readEpicSnapshot: (epicId: string) => Promise<EpicSnapshot | null>;
  /**
   * beads_web-b98: Injected marker reader for cross-round data.
   * Returns marker data for a specific QA round, or null if marker
   * is missing/unreadable. Used by Branch 2 (PASS-with-no-progress)
   * to read verdict + openBugs across K consecutive rounds.
   *
   * Data source: marker-read (post-mejh, commit 931d8e2). Each round's
   * marker lives at <repo>/.beads/markers/<epicId>-qa-round-<N>.json.
   */
  readQaRoundMarker?: (epicId: string, round: number) => Promise<QaRoundMarkerData | null>;
}

export function buildRepeatedQaRoundRule(
  opts: RepeatedQaRoundRuleOptions,
): ReconcilerRule {
  const roundThreshold = opts.roundThreshold ?? DEFAULT_ROUND_THRESHOLD;
  const noProgressThreshold = opts.noProgressThreshold ?? DEFAULT_NO_PROGRESS_THRESHOLD;

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

      // ---------------------------------------------------------------
      // beads_web-b98: Branch 2 — PASS-with-no-progress detection.
      //
      // Second pass through epicIds, independent of Branch 1. Detects
      // K consecutive rounds where verdict=PASS AND openBugCount is
      // unchanged (no delta). Fires at round K (K=3 default) — earlier
      // than Branch 1's roundThreshold=5 and 2r2m's maxRounds=20 ceiling.
      //
      // Empirical grounding: factory-core-3p1e had 21 rounds, 19 with
      // 0 bugs and PASS verdict. Branch 1 never matched because of the
      // openBugCount === 0 early-exit at line 70. This branch catches
      // that case.
      //
      // PASS-only: new branch MUST NOT fire on FAIL verdict. FAIL is
      // handled by Branch 1 (bugs > 0 path). This branch detects the
      // orthogonal pattern: QA says PASS but nothing changes.
      //
      // Data source: marker-read (post-mejh, commit 931d8e2). Each
      // round's marker at <repo>/.beads/markers/<epicId>-qa-round-<N>.json
      // contains `verdict` and `open_bugs` fields.
      // ---------------------------------------------------------------
      if (opts.readQaRoundMarker) {
        for (const epicId of epicIds) {
          const snap = await opts.readEpicSnapshot(epicId);
          if (!snap) continue;
          if (snap.currentStage !== "qa") continue;
          if (snap.openBugCount === -1) continue; // bd failure — skip
          if (snap.hasNeedsHuman) continue; // already flagged
          if (snap.highestQaRound < noProgressThreshold) continue;

          // Read markers for the last K rounds (highestQaRound down to
          // highestQaRound - K + 1). All K must exist and show
          // verdict=PASS with identical openBugs.
          const startRound = snap.highestQaRound - noProgressThreshold + 1;
          let allPassNoProgress = true;
          let referenceOpenBugs: number | undefined;

          for (let r = startRound; r <= snap.highestQaRound; r++) {
            const markerData = await opts.readQaRoundMarker(epicId, r);
            if (!markerData) {
              // Marker missing for this round — can't confirm no-progress
              allPassNoProgress = false;
              break;
            }
            if (markerData.verdict !== "PASS") {
              // Non-PASS verdict — this branch only fires on PASS
              allPassNoProgress = false;
              break;
            }
            if (markerData.openBugs === undefined) {
              // openBugs field missing — can't compute delta
              allPassNoProgress = false;
              break;
            }
            if (referenceOpenBugs === undefined) {
              referenceOpenBugs = markerData.openBugs;
            } else if (markerData.openBugs !== referenceOpenBugs) {
              // Bug count changed between rounds — progress is being made
              allPassNoProgress = false;
              break;
            }
          }

          if (!allPassNoProgress) continue;

          // K consecutive rounds with verdict=PASS and unchanged openBugs.
          // Distinct idempotency key with ::no-progress:: infix so both
          // branches can fire independently for the same epic.
          matches.push({
            idempotencyKey: `${REPEATED_QA_ROUND_RULE_NAME}::${epicId}::no-progress::round-${snap.highestQaRound}`,
            epicId,
            context: {
              round: snap.highestQaRound,
              openBugCount: snap.openBugCount,
              branch: "no-progress",
              consecutivePassRounds: noProgressThreshold,
            },
          });
        }
      }

      return matches;
    },

    async act(match) {
      const context = match.context as {
        round: number;
        openBugCount: number;
        branch?: string;
        consecutivePassRounds?: number;
      };

      // beads_web-b98: distinct log messages for the two branches.
      if (context.branch === "no-progress") {
        console.log(
          `[b98] repeated-qa-round (no-progress) for ${match.epicId}: ${context.consecutivePassRounds} consecutive PASS rounds with no bug-count change at round ${context.round} (openBugCount=${context.openBugCount}) — flagging review:needs-human`,
        );
      } else {
        console.log(
          `[zsjv.3] repeated-qa-round for ${match.epicId}: round ${context.round} with ${context.openBugCount} open bugs — flagging review:needs-human`,
        );
      }

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
