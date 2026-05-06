// =============================================================================
// Coherence outcome classifier — cascade-implicit positive/negative attribution
// (factory-core-wlsr.6).
//
// Architecture:
//   docs/research/universal-coherence-routing-agents-never-architecture.md
//   § ADR-010 — "Outcome attribution horizon — hybrid (event count OR time,
//                default-positive)".
//
// Purpose:
//   Pure function over (journal entries, pipeline events, now) returning a list
//   of outcome attributions for entries whose outcome is still "pending". The
//   reconciler rule (`reconciler-rules/coherence-outcome-attribution.ts`)
//   persists the returned attributions via CoherenceJournal.updateOutcome on
//   each tick.
//
// Rules — evaluated in this order per ADR-010 (first match wins per entry):
//
//   1. NEGATIVE: same epic + same anomalyFingerprint + new coherence dispatch
//      within NEGATIVE_EVENT_HORIZON (5) events of the original entry's
//      timestamp → outcome=negative, rationale "epic re-escalated to coherence
//      on same fingerprint within 5 events".
//
//   2. POSITIVE — closure: entry's epic transitioned to status=closed (via
//      event-log signal) → outcome=positive, rationale "epic closed without
//      re-escalation".
//
//   3. POSITIVE — horizon: now - entry.timestamp >= POSITIVE_TIME_HORIZON_MS
//      (24h) AND no re-escalation event for entry's epic AND no closure event
//      → outcome=positive, rationale "24h elapsed without re-escalation".
//
// Pure-function discipline:
//   No fs/network/bd I/O. The reconciler rule does the I/O (reads journal,
//   reads events, calls updateOutcome). The classifier is deterministic over
//   its inputs — re-running with adjusted thresholds produces a re-attributed
//   journal in simulation.
//
// Signal choices (ADR-010 left these open; documented per the bead's
// surprises_or_findings):
//   - "Re-escalation event": a stage-dispatched event with
//     payload.toAction === "run-coherence-agent" AND epicId === entry.epicId
//     AND timestamp > entry.timestamp. This matches what the existing
//     coherence-escalation rule fires.
//   - "Closure event": a bead-status-changed event with
//     payload.beadId === entry.epicId AND payload.newStatus === "closed".
//     This event type is NOT emitted by any current code path; the contract
//     is defined here and future emitters (e.g., a follow-up bead that wraps
//     `bd close`) can produce it. Until then the closure rule never fires and
//     the time-horizon rule provides default-positive attribution after 24h —
//     which matches ADR-010's "tolerance for wrong calls is high" stance.
// =============================================================================

import type { JournalEntry } from "./coherence-journal";
import type { PipelineEvent } from "./event-log";

// ---------------------------------------------------------------------------
// Tunable constants (ADR-010)
// ---------------------------------------------------------------------------

/**
 * How many *epic-scoped* events the negative-attribution rule looks ahead.
 *
 * Per ADR-010 step 1: same epic + same anomalyFingerprint + new coherence
 * dispatch within 5 events of the original entry → outcome=negative.
 *
 * Boundary semantics: a re-escalation that lands as the 5th epic-scoped
 * event after the entry IS within the horizon (4 events between original
 * and re-escalation, inclusive count of 5 epic-scoped events whose
 * timestamp > entry.timestamp AND <= re-escalation event timestamp). A
 * re-escalation that lands as the 6th epic-scoped event is OUTSIDE.
 */
export const NEGATIVE_EVENT_HORIZON = 5;

/**
 * Milliseconds elapsed since the entry's timestamp before the
 * positive-horizon rule fires (24 hours).
 *
 * Per ADR-010 step 3: 24h elapsed without re-escalation AND epic still
 * open → outcome=positive. v1 thresholds chosen conservatively per the
 * "tolerance for wrong calls is high" stance.
 */
export const POSITIVE_TIME_HORIZON_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * One outcome attribution decision produced by the classifier.
 *
 * Consumed by the reconciler rule which calls
 * `CoherenceJournal.updateOutcome(entryId, outcome, rationale)` per item.
 */
export interface OutcomeAttribution {
  /** Journal entry being attributed. */
  entryId: string;
  /** Resolved outcome — "pending" is never produced by the classifier. */
  outcome: "positive" | "negative";
  /** Single-sentence rationale, persisted as outcomeRationale. */
  rationale: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Parse an ISO-8601 timestamp to ms-since-epoch. Returns NaN on bad input;
 * callers should treat NaN as "skip this comparison" rather than throw.
 */
function ms(iso: string): number {
  return Date.parse(iso);
}

/**
 * Predicate: event represents a fresh coherence dispatch for the given epic
 * AFTER the entry's timestamp.
 *
 * Signal: stage-dispatched + payload.toAction === "run-coherence-agent". This
 * matches what coherence-escalation.ts (and the post-wlsr.7 generalised rule)
 * fires when escalating to coherence.
 */
function isReEscalation(
  e: PipelineEvent,
  epicId: string,
  afterMs: number,
): boolean {
  if (e.type !== "stage-dispatched") return false;
  if (e.epicId !== epicId) return false;
  const eMs = ms(e.timestamp);
  if (Number.isNaN(eMs) || eMs <= afterMs) return false;
  const payload = e.payload as { toAction?: string } | undefined;
  return payload?.toAction === "run-coherence-agent";
}

/**
 * Predicate: event represents a status=closed transition for the given epic.
 *
 * Signal: bead-status-changed + payload.beadId === epicId + payload.newStatus
 * === "closed". See module header for why this contract is forward-looking.
 */
function isClosureEvent(e: PipelineEvent, epicId: string): boolean {
  if (e.type !== "bead-status-changed") return false;
  const payload = e.payload as
    | { beadId?: string; newStatus?: string }
    | undefined;
  if (!payload) return false;
  return payload.beadId === epicId && payload.newStatus === "closed";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify all pending journal entries against the current event stream.
 *
 * Pure function — no side effects, no I/O. Already-attributed entries
 * (outcome !== "pending") are skipped to avoid wasted disk traffic in the
 * reconciler rule's tight loop. Entries with malformed timestamps are also
 * skipped (they cannot be reasoned about safely).
 *
 * Order of evaluation per entry (first match wins):
 *   1. negative (re-escalation within NEGATIVE_EVENT_HORIZON events)
 *   2. positive — closure
 *   3. positive — time horizon (>= POSITIVE_TIME_HORIZON_MS elapsed AND no
 *      re-escalation AND no closure)
 *
 * If no rule matches the entry stays pending — the next reconciler tick
 * will reconsider with a possibly-extended event window or a later `now`.
 */
export function classifyPendingEntries(
  journal: JournalEntry[],
  events: PipelineEvent[],
  now: Date,
): OutcomeAttribution[] {
  const nowMs = now.getTime();
  const attributions: OutcomeAttribution[] = [];

  for (const entry of journal) {
    // ADR-010 idempotency: classifier never re-attributes a non-pending
    // entry. The reconciler rule relies on this filter to keep its tick
    // cheap (no updateOutcome calls for entries already at terminal
    // outcome).
    if (entry.outcome !== "pending") continue;

    const entryMs = ms(entry.timestamp);
    if (Number.isNaN(entryMs)) continue;

    // ---- Rule 1: NEGATIVE — same fingerprint within NEGATIVE_EVENT_HORIZON --
    //
    // "within 5 events" is defined as: count of epic-scoped events whose
    // timestamp > entry.timestamp AND <= candidate-re-escalation.timestamp,
    // counting the candidate itself. The first re-escalation whose count is
    // <= NEGATIVE_EVENT_HORIZON triggers negative attribution.
    //
    // We must consult the JOURNAL (not the events) to confirm "same
    // anomalyFingerprint". A new coherence dispatch produces a new journal
    // entry for the same epic; we treat any dispatch event as a candidate
    // re-escalation but only mark NEGATIVE when an entry exists with the
    // matching fingerprint and a timestamp in the same window.
    //
    // Strategy: find re-escalation events for this epic, then for each
    // check whether (a) it is within the event-count horizon and (b) a
    // separate journal entry with the same fingerprint exists at or near
    // the dispatch timestamp.
    const epicEventsAfter = events
      .filter((e) => e.epicId === entry.epicId)
      .map((e) => ({ e, t: ms(e.timestamp) }))
      .filter((p) => !Number.isNaN(p.t) && p.t > entryMs)
      .sort((a, b) => a.t - b.t); // chronological after entry

    let negativeMatched = false;
    for (let i = 0; i < epicEventsAfter.length; i++) {
      const { e } = epicEventsAfter[i];
      // Event-count position (1-based). The candidate itself counts.
      const positionFromEntry = i + 1;
      if (positionFromEntry > NEGATIVE_EVENT_HORIZON) break;

      if (!isReEscalation(e, entry.epicId, entryMs)) continue;

      // Confirm same fingerprint via journal lookup. An entry corresponds
      // to a dispatch when it matches the epic, has the same fingerprint,
      // and was created after the original (and at or before the dispatch
      // event's timestamp + a generous skew window). We use a strict
      // "later journal entry, same epic, same fingerprint" check.
      const reJournalEntry = journal.find(
        (other) =>
          other.entryId !== entry.entryId &&
          other.epicId === entry.epicId &&
          other.anomalyFingerprint === entry.anomalyFingerprint &&
          ms(other.timestamp) > entryMs,
      );
      if (!reJournalEntry) continue;

      attributions.push({
        entryId: entry.entryId,
        outcome: "negative",
        rationale:
          "epic re-escalated to coherence on same fingerprint within 5 events",
      });
      negativeMatched = true;
      break;
    }
    if (negativeMatched) continue;

    // ---- Rule 2: POSITIVE — closure --------------------------------------
    const closureEvent = events.find(
      (e) =>
        isClosureEvent(e, entry.epicId) &&
        !Number.isNaN(ms(e.timestamp)) &&
        ms(e.timestamp) > entryMs,
    );

    if (closureEvent) {
      // Per ADR-010 step 2, closure trumps time-horizon when both apply.
      // The negative rule already short-circuited above when relevant.
      attributions.push({
        entryId: entry.entryId,
        outcome: "positive",
        rationale: "epic closed without re-escalation",
      });
      continue;
    }

    // ---- Rule 3: POSITIVE — time horizon ---------------------------------
    const elapsed = nowMs - entryMs;
    if (elapsed < POSITIVE_TIME_HORIZON_MS) continue;

    // Per ADR-010 step 3 the predicate is "no re-escalation event for
    // entry's epic AND no closure event for entry's epic". We checked
    // closure already (rule 2 short-circuits when closure exists). For
    // re-escalation we must look across the FULL window after entry,
    // not just the first NEGATIVE_EVENT_HORIZON events — a re-escalation
    // at event 6 still suppresses the time-horizon positive (it just
    // doesn't get the negative tag).
    const anyReEscalation = events.some((e) =>
      isReEscalation(e, entry.epicId, entryMs),
    );
    if (anyReEscalation) continue;

    attributions.push({
      entryId: entry.entryId,
      outcome: "positive",
      rationale: "24h elapsed without re-escalation",
    });
  }

  return attributions;
}
