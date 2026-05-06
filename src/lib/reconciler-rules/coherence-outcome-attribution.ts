// =============================================================================
// Coherence outcome attribution reconciler rule (factory-core-wlsr.6).
//
// Architecture:
//   docs/research/universal-coherence-routing-agents-never-architecture.md
//   § ADR-010 — outcome attribution horizon (hybrid: 5 events, 24h,
//   default-positive).
//
// Behaviour per tick:
//   1. Read the coherence journal (`CoherenceJournal.all()`).
//   2. Run the pure classifier (`classifyPendingEntries`) over the journal,
//      the recent events the reconciler already gathered, and the current
//      time.
//   3. For each returned attribution call `CoherenceJournal.updateOutcome` —
//      the journal records the outcome via tombstone-style append (ADR-002).
//
// Idempotency:
//   The classifier already filters out entries whose outcome !== "pending"
//   (see classifyPendingEntries). updateOutcome is itself an append-only
//   operation; calling it twice for the same entryId is acceptable
//   (latest-wins on read per ADR-002), but the classifier filter avoids
//   that disk traffic in the steady state.
//
// Failure contract:
//   Per-entry errors are caught and logged; the next tick retries. Journal
//   read failures abort the tick gracefully (return zero matches). Both
//   paths follow the resilience discipline that powers the rest of the
//   reconciler — one journal entry's persistence failure must not stall
//   attribution for the rest.
//
// Rule shape:
//   The classifier already encodes the matching logic. This rule's
//   `matches()` returns one ReconcilerMatch per attribution; `act()` is the
//   `updateOutcome` call. We surface the rule via `matches`/`act` instead
//   of a single sweep so the reconciler's stats + recentActions surface
//   exposes attribution activity to the dashboard.
// =============================================================================

import type { ReconcilerRule, ReconcilerMatch } from "../reconciler";
import { CoherenceJournal } from "../coherence-journal";
import {
  classifyPendingEntries,
  type OutcomeAttribution,
} from "../coherence-outcome-classifier";

export const COHERENCE_OUTCOME_ATTRIBUTION_RULE_NAME =
  "coherence-outcome-attribution";

export interface CoherenceOutcomeAttributionRuleOptions {
  /** Repo path used to construct the CoherenceJournal. */
  repoPath: string;
  /**
   * Optional minimum tick interval (ms). Outcome attribution is cheap
   * (JSONL load + in-memory walk + appends) but non-urgent — the
   * reconciler doesn't need to re-classify every 10s. Default: undefined
   * (run every tick) so tests stay deterministic; production callers may
   * override.
   */
  minTickIntervalMs?: number;
  /**
   * Test seam: override the journal repository. Production callers omit
   * this and the rule constructs CoherenceJournal(repoPath) on each tick
   * — fresh reads on every cycle, matching the rest of the reconciler.
   */
  journalFactory?: () => CoherenceJournal;
}

interface AttributionContext extends Record<string, unknown> {
  attribution: OutcomeAttribution;
}

export function buildCoherenceOutcomeAttributionRule(
  opts: CoherenceOutcomeAttributionRuleOptions,
): ReconcilerRule {
  const journalFactory =
    opts.journalFactory ?? (() => new CoherenceJournal(opts.repoPath));

  return {
    name: COHERENCE_OUTCOME_ATTRIBUTION_RULE_NAME,
    minTickIntervalMs: opts.minTickIntervalMs,

    async matches(events, now) {
      let entries;
      try {
        entries = await journalFactory().all();
      } catch (err) {
        console.error(
          `[${COHERENCE_OUTCOME_ATTRIBUTION_RULE_NAME}] journal read failed — skipping tick:`,
          err instanceof Error ? err.message : err,
        );
        return [];
      }

      const attributions = classifyPendingEntries(entries, events, now);

      const matches: ReconcilerMatch[] = attributions.map((a) => {
        const context: AttributionContext = { attribution: a };
        return {
          // Per-entry idempotency key. updateOutcome is logically
          // idempotent (latest-wins via tombstone) but the reconciler's
          // own idempotency layer prevents re-firing inside the
          // idempotency horizon. We embed the outcome in the key so a
          // re-classification (e.g., a negative supersedes an earlier
          // positive in a contrived test) gets its own bucket and the
          // appended tombstone reflects the latest reasoning.
          idempotencyKey: `${COHERENCE_OUTCOME_ATTRIBUTION_RULE_NAME}::${a.entryId}::${a.outcome}`,
          epicId: extractEpicIdForEntry(a.entryId, entries),
          context,
        };
      });

      return matches;
    },

    async act(match) {
      const ctx = match.context as AttributionContext | undefined;
      const a = ctx?.attribution;
      if (!a) {
        // Defensive: matches() always populates context. A missing
        // attribution would mean the reconciler invoked act() with
        // unrelated state — log and bail rather than silently no-op.
        throw new Error(
          `[${COHERENCE_OUTCOME_ATTRIBUTION_RULE_NAME}] act() called without attribution context for key="${match.idempotencyKey}"`,
        );
      }

      try {
        await journalFactory().updateOutcome(a.entryId, a.outcome, a.rationale);
      } catch (err) {
        // updateOutcome itself swallows errors per ADR-007, but a
        // future implementation might propagate; in either case we log
        // and let the reconciler emit the action-taken event so the
        // idempotency bucket consumes (matching the broader reconciler
        // always-emit discipline). Throwing here would force a retry
        // every tick and risk the same persistent failure burning the
        // log; per-entry errors are best-effort.
        console.error(
          `[${COHERENCE_OUTCOME_ATTRIBUTION_RULE_NAME}] updateOutcome failed for entryId=${a.entryId}:`,
          err instanceof Error ? err.message : err,
        );
      }
    },
  };
}

/**
 * Best-effort extraction of the epicId that the attribution belongs to —
 * used for the ReconcilerMatch.epicId field which the reconciler exposes
 * in its action-taken stats. Falls back to "unknown" if the entry is
 * absent (shouldn't happen — the classifier was called with `entries`
 * that contained this entryId moments ago — but defensive nonetheless).
 */
function extractEpicIdForEntry(
  entryId: string,
  entries: ReadonlyArray<{ entryId: string; epicId: string }>,
): string {
  const match = entries.find((e) => e.entryId === entryId);
  return match?.epicId ?? "unknown";
}
