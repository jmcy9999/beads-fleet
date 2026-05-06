// =============================================================================
// Coherence Journal — append-only persistent learning store for the coherence
// agent (factory-core-wlsr.2).
//
// Architecture: docs/research/universal-coherence-routing-agents-never-architecture.md
//   § Data Model, § Persistence Strategy
//   v1 ADRs: 002 (tombstone-style outcome updates), 005 (closed EscalationReason
//            enum), 006 (exact-match AnomalyFingerprint), 007 (write failures
//            do NOT block dispatch).
//   v2 ADRs: 013 (labelMutations audit), 014 (depContext for dep-aware
//            reasoning), 015 (EscalationContext + closed AnomalyType enum).
//
// Storage model:
//   - One JSONL file per repo at <repoPath>/.beads/coherence/journal.jsonl
//   - Append-only. One entry per line. Line terminator: "\n" (single char,
//     not os.EOL — cross-platform JSONL discipline mirrors event-log.ts).
//   - mkdir -p semantics on first append (idempotent).
//   - Reader tolerates malformed lines (skip + console.warn, do not throw).
//   - Outcome attribution is a logical mutation expressed as a tombstone-
//     style append: {_outcomeUpdate: true, entryId, outcome, ...}. Reader
//     reduces over the file; latest tombstone per entryId wins (ADR-002).
//
// Failure contract (mirrors event-log.ts ADR-007 discipline):
//   append() swallows errors and logs to console.error. Coherence's
//   PRIMARY job is unsticking the pipeline; the journal is a learning aid,
//   not a prerequisite.
//
// v2 amendment (ADRs 013/014/015): JournalEntry gains three optional fields
// (labelMutations, depContext, escalationContext). All optional, all
// backward-compatible — legacy entries deserialise correctly with each new
// field as undefined. version stays "1" because the schema is additive.
// `EscalationContext` and the closed `AnomalyType` enum are co-located in
// this file per ADR-015 § 3 ("co-located in coherence-journal.ts — no new
// file"). EventSummary is aliased from PipelineEvent (event-log.ts) per
// AC #15 — no redefinition.
// =============================================================================

import { promises as fs } from "fs";
import * as path from "path";
import { randomUUID } from "crypto";

import type { PipelineEvent } from "./event-log";
import type { MarkerData } from "./marker-reader";

// ---------------------------------------------------------------------------
// EventSummary (AC #15)
// ---------------------------------------------------------------------------

/**
 * Summary shape passed to coherence as part of EscalationContext.
 *
 * Aliased from PipelineEvent (the canonical events.jsonl shape — see
 * event-log.ts) per AC #15 — no redefinition. Downstream consumers
 * (wlsr.14/15/16) should import EventSummary from coherence-journal.ts.
 *
 * Per ADR-015 § 3 the field is `recentEvents: EventSummary[]` — last N
 * events from events.jsonl scoped to the epic; default N=10 per
 * Phase B's TBD.
 */
export type EventSummary = PipelineEvent;

// ---------------------------------------------------------------------------
// Closed enums (ADR-005, ADR-015)
// ---------------------------------------------------------------------------

/**
 * Closed enum captured when coherence chooses `decision.action === "escalate"`.
 *
 * Per ADR-005 — closed for modification at v1. Adding a category requires a
 * coordinated edit to the enum, the prompt, the journal schema, and the tests.
 */
export type EscalationReason =
  | "journal-shows-prior-failures"
  | "irreducible-uncertainty"
  | "policy-decision-required"
  | "external-dependency-failure"
  | "explicit-stop-and-surface";

/**
 * Closed enum identifying the kind of anomaly a reconciler rule detected.
 *
 * Per ADR-015 § 3 — closed enum at v2 for the same reasons EscalationReason
 * is closed at v1 (closed vocabulary aids journal similarity search and
 * prompt discipline). Adding a value requires an ADR amendment.
 *
 * NOTE: distinct from EscalationReason. AnomalyType is the rule's input to
 * coherence's reasoning ("what did the rule see?"); EscalationReason is the
 * output of coherence's reasoning ("why am I escalating to operator?").
 */
export type AnomalyType =
  | "stuck-in-stage"
  | "repeated-qa-round"
  | "repeat-dispatch-no-progress"
  | "wave-bead-mismatch"
  | "missed-wave-review-dispatch"
  | "marker-non-success-outcome";

// ---------------------------------------------------------------------------
// EscalationContext (ADR-015 § 3)
// ---------------------------------------------------------------------------

/**
 * Structured handoff from a reconciler rule to the coherence agent.
 *
 * Per ADR-015 § 3 — co-located in coherence-journal.ts alongside JournalEntry.
 * NO new file. Built by a rule's act() method when it escalates to coherence;
 * captured on JournalEntry.escalationContext for audit.
 *
 * `ruleSpecificContext` is intentionally free-form — each rule embeds its own
 * domain context (e.g., stuck-in-stage includes stage and last-event age;
 * wave-bead-mismatch includes wave number and bead lists). Coherence reads
 * this as advisory context, not as a contract.
 */
export interface EscalationContext {
  /** Closed enum; see AnomalyType. */
  anomalyType: AnomalyType;
  /** Epic the escalation is about. */
  epicId: string;
  /** Which rule originated the escalation (for audit). */
  ruleId: string;
  /**
   * Last N events from events.jsonl scoped to the epic. Default N=10
   * (Phase B may tune). EventSummary is aliased from PipelineEvent.
   */
  recentEvents: EventSummary[];
  /** Present when escalation was marker-triggered. */
  marker?: MarkerData;
  /** Free-form rule-specific context. Coherence consumes as advisory. */
  ruleSpecificContext?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// JournalEntry (Data Model + ADR-013/014/015)
// ---------------------------------------------------------------------------

/**
 * A single coherence decision and its later-attributed outcome.
 *
 * v1 fields (14): version, entryId, timestamp, epicId, triggeringMarker,
 * anomalyFingerprint, priorEntriesConsulted, diagnosis, decision,
 * dispatchedAgent, escalationReason, outcome, outcomeAttributedAt,
 * outcomeRationale.
 *
 * v2 optional additions (3): labelMutations (ADR-013), depContext (ADR-014),
 * escalationContext (ADR-015 § 3). All optional; absent on legacy entries.
 *
 * Identity: entryId is a UUID generated at append time. The journal is
 * append-only for INSERT operations; UPDATE operations (outcome
 * attribution) are a logical mutation expressed as a separate
 * tombstone-style line (see updateOutcome).
 */
export interface JournalEntry {
  /** Schema version — matches marker-schema convention. v2 stays "1"
   * because the v2 amendment is additive-only (legacy readers continue
   * to deserialise correctly). */
  version: "1";
  /** UUID v4 generated at append time. */
  entryId: string;
  /** ISO-8601 UTC timestamp — when the decision was made. */
  timestamp: string;
  /** Epic the decision is about (e.g., "factory-core-niii"). */
  epicId: string;
  /** Frozen-at-write-time marker context. */
  triggeringMarker: {
    path: string;
    stage: string;
    status: string;
    blocker_class?: string;
    next_agent_attempted?: string;
  };
  /** Derived key for similarity search (see anomalyFingerprint). */
  anomalyFingerprint: string;
  /** Which prior journal entries the agent consulted. May be empty. */
  priorEntriesConsulted: string[];
  /** Coherence's reasoning, ≤3 sentences. */
  diagnosis: string;
  /** Dispatched action and its parameters. */
  decision: {
    action: "dispatch-chain-action" | "file-bug" | "re-plan" | "escalate";
    params: Record<string, unknown>;
  };
  /** Agent dispatched (e.g., "builder"). null if action was file-bug or escalate. */
  dispatchedAgent: string | null;
  /** Set IFF decision.action === "escalate". */
  escalationReason: EscalationReason | null;
  /** Initially "pending"; updated by the outcome classifier (wlsr.6). */
  outcome: "pending" | "positive" | "negative";
  /** ISO-8601 timestamp when outcome was set. null while pending. */
  outcomeAttributedAt: string | null;
  /** One sentence explaining the ✓/✗ attribution. null while pending. */
  outcomeRationale: string | null;

  // ---- v2 additions (ADRs 013/014/015) — all optional, backward-compatible ----

  /**
   * v2 (ADR-013): label mutations performed during this coherence
   * invocation, for audit. Empty/absent when no labels were touched.
   * Frozen at write time.
   */
  labelMutations?: Array<{
    beadId: string;
    removed: string[];
    added: string[];
    rationale: string;
  }>;

  /**
   * v2 (ADR-014): dependency-graph context that informed the decision.
   * Empty/absent when dep-awareness was not invoked (e.g., epic-scope
   * agent input). Frozen at write time.
   *
   * `cycleDetected=true` triggers ADR-014's escalate-with-irreducible-
   * uncertainty rule.
   */
  depContext?: {
    blockerBeadIds: string[];
    notesTierCues: string[];
    cycleDetected: boolean;
  };

  /**
   * v2 (ADR-015 § 3): rule-side escalation context when the coherence
   * invocation was triggered by a reconciler rule's escalation. null when
   * triggered by a marker-driven path (no rule context to capture).
   */
  escalationContext?: EscalationContext | null;
}

// ---------------------------------------------------------------------------
// AnomalyFingerprint (ADR-006)
// ---------------------------------------------------------------------------

/**
 * Pure derivation of the similarity-search key from a marker.
 *
 * Per ADR-006 — exact-match strategy. Components, in order:
 * stage, status, blocker_class (if present), next_agent_attempted (if
 * present), qa_round (if present). Components joined with "|".
 *
 * v2 NOTE: the fingerprint is UNCHANGED at v2. ADR-014's depContext is
 * journal-level enrichment, NOT fingerprint-level enrichment. A
 * dep-aware fingerprint would be a separate amendment.
 *
 * Example output:
 *   "stage:reviewer|status:success|next_agent_attempted:operator"
 */
export function anomalyFingerprint(marker: MarkerData): string {
  // qa_round may be present as an extra field via MarkerData's index
  // signature ([key: string]: unknown). Coerce to string when truthy.
  const qaRound = (marker as { qa_round?: unknown }).qa_round;
  const qaRoundStr =
    qaRound === undefined || qaRound === null || qaRound === ""
      ? null
      : `qa_round:${String(qaRound)}`;

  return [
    `stage:${marker.stage}`,
    `status:${marker.status}`,
    marker.blocker_class ? `blocker_class:${marker.blocker_class}` : null,
    marker.next_agent ? `next_agent_attempted:${marker.next_agent}` : null,
    qaRoundStr,
  ]
    .filter((s): s is string => s !== null)
    .join("|");
}

// ---------------------------------------------------------------------------
// CoherenceJournal repository
// ---------------------------------------------------------------------------

/**
 * Tombstone marker line shape (NOT exported — internal to the reader).
 * Per ADR-002 — outcome updates expressed as separate append, not
 * mutate-in-place.
 */
interface OutcomeUpdate {
  _outcomeUpdate: true;
  entryId: string;
  outcome: JournalEntry["outcome"];
  outcomeAttributedAt: string;
  outcomeRationale: string;
}

/**
 * Options accepted by findSimilar.
 */
export interface FindSimilarOptions {
  /**
   * If true, include entries whose outcome is still "pending". Default:
   * false (only "positive"/"negative" entries returned — i.e., completed
   * cases coherence can learn from).
   */
  includeAllOutcomes?: boolean;
}

/**
 * Append-only coherence journal repository.
 *
 * Constructor takes a repo path; storage lives at
 * `<repoPath>/.beads/coherence/journal.jsonl`. The directory is created
 * on first append (mkdir -p semantics).
 */
export class CoherenceJournal {
  private readonly journalPath: string;

  constructor(repoPath: string) {
    this.journalPath = path.join(
      repoPath,
      ".beads",
      "coherence",
      "journal.jsonl",
    );
  }

  /**
   * Append a single decision entry to the journal.
   *
   * The caller provides everything except `entryId` and `timestamp`,
   * which are generated here so all entries share a uniform identity
   * model. Returns the materialised JournalEntry on success.
   *
   * **Failure contract (ADR-007):** errors are logged to stderr but
   * never thrown. Coherence's PRIMARY job is unsticking the pipeline;
   * the journal is a learning aid, not a prerequisite. On failure
   * returns the entry that would have been written (still useful for
   * the caller's own audit) — but the file is unchanged.
   */
  async append(
    entry: Omit<JournalEntry, "entryId" | "timestamp"> & {
      entryId?: string;
      timestamp?: string;
    },
  ): Promise<JournalEntry> {
    const fullEntry: JournalEntry = {
      ...entry,
      entryId: entry.entryId ?? randomUUID(),
      timestamp: entry.timestamp ?? new Date().toISOString(),
    } as JournalEntry;

    try {
      const line = JSON.stringify(fullEntry) + "\n";
      await fs.mkdir(path.dirname(this.journalPath), { recursive: true });
      await fs.appendFile(this.journalPath, line, { encoding: "utf-8" });
    } catch (err) {
      console.error(
        `[coherence-journal] append failed for path=${this.journalPath} entryId=${fullEntry.entryId} epic=${fullEntry.epicId}:`,
        err instanceof Error ? err.message : err,
      );
      // Swallow — see failure contract above.
    }

    return fullEntry;
  }

  /**
   * Append a tombstone-style outcome update (ADR-002).
   *
   * NEVER mutates a prior line. The reader (`all()` and the find* methods)
   * reduces over tombstones taking the latest update per entryId — see
   * `loadAll()` below.
   *
   * Per ADR-007, errors are logged but not thrown.
   */
  async updateOutcome(
    entryId: string,
    outcome: "positive" | "negative",
    rationale: string,
  ): Promise<void> {
    const tombstone: OutcomeUpdate = {
      _outcomeUpdate: true,
      entryId,
      outcome,
      outcomeAttributedAt: new Date().toISOString(),
      outcomeRationale: rationale,
    };

    try {
      const line = JSON.stringify(tombstone) + "\n";
      await fs.mkdir(path.dirname(this.journalPath), { recursive: true });
      await fs.appendFile(this.journalPath, line, { encoding: "utf-8" });
    } catch (err) {
      console.error(
        `[coherence-journal] updateOutcome failed for entryId=${entryId}:`,
        err instanceof Error ? err.message : err,
      );
      // Swallow.
    }
  }

  /**
   * Read all entries with outcomes resolved (latest tombstone per
   * entryId wins). Newest-first.
   *
   * File-not-found is not an error — returns []. Malformed lines are
   * skipped with a single-line warning, never thrown.
   */
  async all(): Promise<JournalEntry[]> {
    return await this.loadAll();
  }

  /**
   * Find entries matching exactly the given AnomalyFingerprint string,
   * sorted newest-first. Per ADR-006.
   *
   * `opts.includeAllOutcomes` (default false): if false, filters out
   * pending entries — coherence learns from completed cases.
   */
  async findSimilar(
    fingerprint: string,
    opts: FindSimilarOptions = {},
  ): Promise<JournalEntry[]> {
    const { includeAllOutcomes = false } = opts;
    const entries = await this.loadAll();
    return entries.filter((e) => {
      if (e.anomalyFingerprint !== fingerprint) return false;
      if (!includeAllOutcomes && e.outcome === "pending") return false;
      return true;
    });
    // loadAll already returns newest-first; filter preserves order.
  }

  /**
   * All entries for the given epic, newest-first. Outcomes resolved.
   */
  async findByEpicId(epicId: string): Promise<JournalEntry[]> {
    const entries = await this.loadAll();
    return entries.filter((e) => e.epicId === epicId);
  }

  // -------------------------------------------------------------------------
  // Internal: read entire file, reduce tombstones, return newest-first
  // -------------------------------------------------------------------------
  private async loadAll(): Promise<JournalEntry[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.journalPath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      // Other read errors (permission, IO) — log and return []
      console.warn(
        `[coherence-journal] readFile failed for ${this.journalPath}:`,
        err instanceof Error ? err.message : err,
      );
      return [];
    }

    // First pass: collect entries (in append order) and the latest
    // tombstone per entryId. We must preserve append order so that two
    // entries written sequentially can be sorted newest-first by their
    // appearance in the file (timestamp ties are resolved by
    // file-position).
    const entries: JournalEntry[] = [];
    const latestTombstone = new Map<string, OutcomeUpdate>();

    const lines = raw.split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        console.warn(
          `[coherence-journal] skipping unparseable line in ${this.journalPath}`,
        );
        continue;
      }

      if (
        !parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      ) {
        console.warn(
          `[coherence-journal] skipping malformed line in ${this.journalPath}`,
        );
        continue;
      }

      const obj = parsed as Record<string, unknown>;

      // Tombstone? Track latest per entryId.
      if (obj._outcomeUpdate === true) {
        if (typeof obj.entryId !== "string") {
          console.warn(
            `[coherence-journal] skipping tombstone with missing entryId in ${this.journalPath}`,
          );
          continue;
        }
        // Latest-wins: subsequent appends overwrite earlier tombstones.
        latestTombstone.set(obj.entryId, obj as unknown as OutcomeUpdate);
        continue;
      }

      // Regular entry — minimal shape check.
      if (
        typeof obj.entryId !== "string" ||
        typeof obj.epicId !== "string" ||
        typeof obj.anomalyFingerprint !== "string"
      ) {
        console.warn(
          `[coherence-journal] skipping entry with missing required fields in ${this.journalPath}`,
        );
        continue;
      }

      entries.push(obj as unknown as JournalEntry);
    }

    // Apply tombstones to entries (latest wins per entryId).
    const resolved: JournalEntry[] = entries.map((e) => {
      const t = latestTombstone.get(e.entryId);
      if (!t) return e;
      return {
        ...e,
        outcome: t.outcome,
        outcomeAttributedAt: t.outcomeAttributedAt,
        outcomeRationale: t.outcomeRationale,
      };
    });

    // Newest-first by appearance order (later in file = newer). Reverse.
    resolved.reverse();
    return resolved;
  }
}
