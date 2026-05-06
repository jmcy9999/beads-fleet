// =============================================================================
// Tests for src/lib/coherence-outcome-classifier.ts (factory-core-wlsr.6).
//
// Pure-function tests — no fixture filesystem, no mocks of the classifier
// itself. Inputs are real JournalEntry + PipelineEvent objects matching the
// shapes from coherence-journal.ts and event-log.ts.
//
// AC #10 coverage:
//   - negative within 5 events
//   - positive on closure
//   - positive after 24h
//   - pending if no signal
//   - already-attributed entries skipped
//   - threshold-boundary cases (4 events vs 5; 23h vs 24h)
// =============================================================================

import {
  classifyPendingEntries,
  NEGATIVE_EVENT_HORIZON,
  POSITIVE_TIME_HORIZON_MS,
  type OutcomeAttribution,
} from "@/lib/coherence-outcome-classifier";
import type { JournalEntry } from "@/lib/coherence-journal";
import type { PipelineEvent } from "@/lib/event-log";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const FINGERPRINT =
  "stage:builder|status:failure|blocker_class:test-fail|next_agent_attempted:operator";
const EPIC = "factory-core-test";

function makeEntry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    version: "1",
    entryId: overrides.entryId ?? "entry-1",
    timestamp: overrides.timestamp ?? "2026-05-06T00:00:00.000Z",
    epicId: overrides.epicId ?? EPIC,
    triggeringMarker: {
      path: ".beads/markers/factory-core-test-builder.json",
      stage: "builder",
      status: "failure",
      blocker_class: "test-fail",
      next_agent_attempted: "operator",
    },
    anomalyFingerprint: overrides.anomalyFingerprint ?? FINGERPRINT,
    priorEntriesConsulted: [],
    diagnosis: "Test diagnosis.",
    decision: { action: "dispatch-chain-action", params: {} },
    dispatchedAgent: "builder",
    escalationReason: null,
    outcome: overrides.outcome ?? "pending",
    outcomeAttributedAt: overrides.outcomeAttributedAt ?? null,
    outcomeRationale: overrides.outcomeRationale ?? null,
    ...overrides,
  };
}

function makeEvent(overrides: Partial<PipelineEvent> = {}): PipelineEvent {
  return {
    type: overrides.type ?? "agent-exited",
    timestamp: overrides.timestamp ?? "2026-05-06T00:00:01.000Z",
    epicId: overrides.epicId ?? EPIC,
    payload: overrides.payload,
    stage: overrides.stage,
    correlationId: overrides.correlationId,
  };
}

function reEscalationEvent(at: string, epicId = EPIC): PipelineEvent {
  return makeEvent({
    type: "stage-dispatched",
    timestamp: at,
    epicId,
    payload: { toAction: "run-coherence-agent" },
  });
}

function closureEvent(at: string, epicId = EPIC): PipelineEvent {
  return makeEvent({
    type: "bead-status-changed",
    timestamp: at,
    epicId,
    payload: { beadId: epicId, newStatus: "closed" },
  });
}

function unrelatedEvent(at: string, epicId = EPIC): PipelineEvent {
  return makeEvent({
    type: "agent-exited",
    timestamp: at,
    epicId,
    payload: { exitCode: 0 },
  });
}

// Helper: build N events between t0 and tN at evenly-spaced intervals.
// Useful for boundary tests.
function buildSequence(
  startMs: number,
  count: number,
  type = "agent-exited",
  epicId = EPIC,
): PipelineEvent[] {
  const out: PipelineEvent[] = [];
  for (let i = 0; i < count; i++) {
    out.push(
      makeEvent({
        type,
        epicId,
        timestamp: new Date(startMs + (i + 1) * 60_000).toISOString(),
      }),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Constants sanity check (AC #6)
// ---------------------------------------------------------------------------

describe("classifier constants", () => {
  test("NEGATIVE_EVENT_HORIZON is 5 (ADR-010)", () => {
    expect(NEGATIVE_EVENT_HORIZON).toBe(5);
  });

  test("POSITIVE_TIME_HORIZON_MS is 24h (ADR-010)", () => {
    expect(POSITIVE_TIME_HORIZON_MS).toBe(24 * 60 * 60 * 1000);
  });
});

// ---------------------------------------------------------------------------
// Already-attributed entries skipped (AC #5, #10)
// ---------------------------------------------------------------------------

describe("already-attributed entries", () => {
  test("outcome=positive entry is not re-attributed", () => {
    const entry = makeEntry({
      outcome: "positive",
      outcomeAttributedAt: "2026-05-06T01:00:00.000Z",
      outcomeRationale: "epic closed without re-escalation",
    });
    const attributions = classifyPendingEntries(
      [entry],
      [],
      new Date("2026-05-30T00:00:00.000Z"),
    );
    expect(attributions).toEqual([]);
  });

  test("outcome=negative entry is not re-attributed", () => {
    const entry = makeEntry({
      outcome: "negative",
      outcomeAttributedAt: "2026-05-06T01:00:00.000Z",
      outcomeRationale: "epic re-escalated to coherence on same fingerprint within 5 events",
    });
    const attributions = classifyPendingEntries(
      [entry],
      [reEscalationEvent("2026-05-06T00:01:00.000Z")],
      new Date("2026-05-30T00:00:00.000Z"),
    );
    expect(attributions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Negative attribution rule (AC #3, #10)
// ---------------------------------------------------------------------------

describe("negative attribution — same epic + same fingerprint within 5 events", () => {
  test("re-escalation as 1st epic-scoped event after entry → negative", () => {
    const entry = makeEntry({
      entryId: "e1",
      timestamp: "2026-05-06T00:00:00.000Z",
    });
    const reEntry = makeEntry({
      entryId: "e2",
      timestamp: "2026-05-06T00:01:00.000Z",
    });
    const events = [reEscalationEvent("2026-05-06T00:01:00.000Z")];
    const out = classifyPendingEntries(
      [entry, reEntry],
      events,
      new Date("2026-05-06T00:02:00.000Z"),
    );
    expect(out).toContainEqual<OutcomeAttribution>({
      entryId: "e1",
      outcome: "negative",
      rationale:
        "epic re-escalated to coherence on same fingerprint within 5 events",
    });
  });

  test("BOUNDARY: re-escalation as 4th epic-scoped event → negative (within horizon)", () => {
    const entryTime = "2026-05-06T00:00:00.000Z";
    const entry = makeEntry({ entryId: "e1", timestamp: entryTime });
    const reEntry = makeEntry({
      entryId: "e2",
      timestamp: "2026-05-06T00:04:00.000Z",
    });
    // 3 unrelated epic-scoped events, then re-escalation as 4th
    const events: PipelineEvent[] = [
      unrelatedEvent("2026-05-06T00:01:00.000Z"),
      unrelatedEvent("2026-05-06T00:02:00.000Z"),
      unrelatedEvent("2026-05-06T00:03:00.000Z"),
      reEscalationEvent("2026-05-06T00:04:00.000Z"), // 4th
    ];
    const out = classifyPendingEntries(
      [entry, reEntry],
      events,
      new Date("2026-05-06T00:05:00.000Z"),
    );
    expect(out.find((a) => a.entryId === "e1")?.outcome).toBe("negative");
  });

  test("BOUNDARY: re-escalation as 5th epic-scoped event → negative (at horizon)", () => {
    const entryTime = "2026-05-06T00:00:00.000Z";
    const entry = makeEntry({ entryId: "e1", timestamp: entryTime });
    const reEntry = makeEntry({
      entryId: "e2",
      timestamp: "2026-05-06T00:05:00.000Z",
    });
    const events: PipelineEvent[] = [
      unrelatedEvent("2026-05-06T00:01:00.000Z"),
      unrelatedEvent("2026-05-06T00:02:00.000Z"),
      unrelatedEvent("2026-05-06T00:03:00.000Z"),
      unrelatedEvent("2026-05-06T00:04:00.000Z"),
      reEscalationEvent("2026-05-06T00:05:00.000Z"), // 5th
    ];
    const out = classifyPendingEntries(
      [entry, reEntry],
      events,
      new Date("2026-05-06T00:06:00.000Z"),
    );
    expect(out.find((a) => a.entryId === "e1")?.outcome).toBe("negative");
  });

  test("BOUNDARY: re-escalation as 6th epic-scoped event → NOT negative (outside horizon)", () => {
    const entryTime = "2026-05-06T00:00:00.000Z";
    const entry = makeEntry({ entryId: "e1", timestamp: entryTime });
    const reEntry = makeEntry({
      entryId: "e2",
      timestamp: "2026-05-06T00:06:00.000Z",
    });
    const events: PipelineEvent[] = [
      unrelatedEvent("2026-05-06T00:01:00.000Z"),
      unrelatedEvent("2026-05-06T00:02:00.000Z"),
      unrelatedEvent("2026-05-06T00:03:00.000Z"),
      unrelatedEvent("2026-05-06T00:04:00.000Z"),
      unrelatedEvent("2026-05-06T00:05:00.000Z"),
      reEscalationEvent("2026-05-06T00:06:00.000Z"), // 6th
    ];
    const out = classifyPendingEntries(
      [entry, reEntry],
      events,
      new Date("2026-05-06T00:07:00.000Z"),
    );
    // entry stays pending (outside horizon for negative; <24h elapsed for positive-horizon; no closure)
    expect(out.find((a) => a.entryId === "e1")).toBeUndefined();
  });

  test("re-escalation for DIFFERENT epic does not negative-attribute", () => {
    const entry = makeEntry({
      entryId: "e1",
      epicId: "factory-core-A",
      timestamp: "2026-05-06T00:00:00.000Z",
    });
    const reEntry = makeEntry({
      entryId: "e2",
      epicId: "factory-core-B",
      timestamp: "2026-05-06T00:01:00.000Z",
    });
    const events = [
      reEscalationEvent("2026-05-06T00:01:00.000Z", "factory-core-B"),
    ];
    const out = classifyPendingEntries(
      [entry, reEntry],
      events,
      new Date("2026-05-06T00:02:00.000Z"),
    );
    expect(out.find((a) => a.entryId === "e1")).toBeUndefined();
  });

  test("re-escalation with DIFFERENT fingerprint does not negative-attribute", () => {
    const entry = makeEntry({
      entryId: "e1",
      timestamp: "2026-05-06T00:00:00.000Z",
    });
    const reEntry = makeEntry({
      entryId: "e2",
      timestamp: "2026-05-06T00:01:00.000Z",
      anomalyFingerprint: "stage:reviewer|status:success",
    });
    const events = [reEscalationEvent("2026-05-06T00:01:00.000Z")];
    const out = classifyPendingEntries(
      [entry, reEntry],
      events,
      new Date("2026-05-06T00:02:00.000Z"),
    );
    expect(out.find((a) => a.entryId === "e1")).toBeUndefined();
  });

  test("re-escalation BEFORE entry timestamp does not negative-attribute", () => {
    const entry = makeEntry({
      entryId: "e1",
      timestamp: "2026-05-06T00:05:00.000Z",
    });
    // Earlier journal entry exists with same fingerprint, but the dispatch
    // event happened before this entry — so it's not a "re-escalation OF
    // this entry", it's the dispatch that produced it.
    const earlierEntry = makeEntry({
      entryId: "e0",
      timestamp: "2026-05-05T23:00:00.000Z",
    });
    const events = [reEscalationEvent("2026-05-05T23:00:00.000Z")];
    const out = classifyPendingEntries(
      [entry, earlierEntry],
      events,
      new Date("2026-05-06T00:06:00.000Z"),
    );
    expect(out.find((a) => a.entryId === "e1")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Positive-closure rule (AC #4, #10)
// ---------------------------------------------------------------------------

describe("positive attribution — closure", () => {
  test("epic closure event AFTER entry → positive (closure)", () => {
    const entry = makeEntry({
      entryId: "e1",
      timestamp: "2026-05-06T00:00:00.000Z",
    });
    const events = [closureEvent("2026-05-06T00:30:00.000Z")];
    const out = classifyPendingEntries(
      [entry],
      events,
      new Date("2026-05-06T00:31:00.000Z"),
    );
    expect(out).toContainEqual<OutcomeAttribution>({
      entryId: "e1",
      outcome: "positive",
      rationale: "epic closed without re-escalation",
    });
  });

  test("closure event for DIFFERENT epic does not attribute", () => {
    const entry = makeEntry({
      entryId: "e1",
      epicId: "factory-core-A",
      timestamp: "2026-05-06T00:00:00.000Z",
    });
    const events = [
      closureEvent("2026-05-06T00:30:00.000Z", "factory-core-B"),
    ];
    const out = classifyPendingEntries(
      [entry],
      events,
      new Date("2026-05-06T00:31:00.000Z"),
    );
    expect(out.find((a) => a.entryId === "e1")).toBeUndefined();
  });

  test("closure BEFORE entry does not attribute", () => {
    const entry = makeEntry({
      entryId: "e1",
      timestamp: "2026-05-06T01:00:00.000Z",
    });
    // closure event 30 min BEFORE the entry timestamp
    const events = [closureEvent("2026-05-06T00:30:00.000Z")];
    const out = classifyPendingEntries(
      [entry],
      events,
      new Date("2026-05-06T01:01:00.000Z"),
    );
    expect(out.find((a) => a.entryId === "e1")).toBeUndefined();
  });

  test("negative trumps closure when both apply (rule order)", () => {
    // Both a re-escalation within horizon AND a later closure exist.
    // ADR-010 evaluates negative first.
    const entry = makeEntry({
      entryId: "e1",
      timestamp: "2026-05-06T00:00:00.000Z",
    });
    const reEntry = makeEntry({
      entryId: "e2",
      timestamp: "2026-05-06T00:01:00.000Z",
    });
    const events = [
      reEscalationEvent("2026-05-06T00:01:00.000Z"),
      closureEvent("2026-05-06T00:10:00.000Z"),
    ];
    const out = classifyPendingEntries(
      [entry, reEntry],
      events,
      new Date("2026-05-06T00:11:00.000Z"),
    );
    expect(out.find((a) => a.entryId === "e1")?.outcome).toBe("negative");
  });
});

// ---------------------------------------------------------------------------
// Positive-horizon rule (AC #5, #10)
// ---------------------------------------------------------------------------

describe("positive attribution — 24h time horizon", () => {
  test("BOUNDARY: 23h elapsed without re-escalation → still pending", () => {
    const entry = makeEntry({
      entryId: "e1",
      timestamp: "2026-05-06T00:00:00.000Z",
    });
    const now = new Date("2026-05-06T23:00:00.000Z"); // 23h elapsed
    const out = classifyPendingEntries([entry], [], now);
    expect(out.find((a) => a.entryId === "e1")).toBeUndefined();
  });

  test("BOUNDARY: exactly 24h elapsed without re-escalation → positive (horizon)", () => {
    const entry = makeEntry({
      entryId: "e1",
      timestamp: "2026-05-06T00:00:00.000Z",
    });
    const now = new Date("2026-05-07T00:00:00.000Z"); // 24h elapsed exactly
    const out = classifyPendingEntries([entry], [], now);
    expect(out).toContainEqual<OutcomeAttribution>({
      entryId: "e1",
      outcome: "positive",
      rationale: "24h elapsed without re-escalation",
    });
  });

  test("25h elapsed without re-escalation → positive (horizon)", () => {
    const entry = makeEntry({
      entryId: "e1",
      timestamp: "2026-05-06T00:00:00.000Z",
    });
    const now = new Date("2026-05-07T01:00:00.000Z");
    const out = classifyPendingEntries([entry], [], now);
    expect(out.find((a) => a.entryId === "e1")?.outcome).toBe("positive");
  });

  test("re-escalation BEYOND negative horizon (e.g. 7th event) but BEFORE 24h → suppresses positive-horizon", () => {
    const entry = makeEntry({
      entryId: "e1",
      timestamp: "2026-05-06T00:00:00.000Z",
    });
    const reEntry = makeEntry({
      entryId: "e2",
      timestamp: "2026-05-06T05:00:00.000Z",
      anomalyFingerprint: "different-fingerprint", // not a negative trigger
    });
    // 6 unrelated events + re-escalation at 7th
    const events: PipelineEvent[] = [
      ...buildSequence(Date.parse("2026-05-06T00:00:00.000Z"), 6),
      reEscalationEvent("2026-05-06T05:00:00.000Z"),
    ];
    const now = new Date("2026-05-07T01:00:00.000Z"); // 25h after entry
    const out = classifyPendingEntries([entry, reEntry], events, now);
    // Re-escalation (any) suppresses positive-horizon per ADR-010 step 3.
    // Negative didn't fire because re-escalation is at 7th event AND
    // fingerprint differs (defensive — but the count alone is enough).
    expect(out.find((a) => a.entryId === "e1")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Pending — no signal (AC #10)
// ---------------------------------------------------------------------------

describe("pending — no rule fires", () => {
  test("no events, fresh entry → pending", () => {
    const entry = makeEntry({
      entryId: "e1",
      timestamp: "2026-05-06T00:00:00.000Z",
    });
    const out = classifyPendingEntries(
      [entry],
      [],
      new Date("2026-05-06T01:00:00.000Z"),
    );
    expect(out).toEqual([]);
  });

  test("only unrelated events, < 24h elapsed → pending", () => {
    const entry = makeEntry({
      entryId: "e1",
      timestamp: "2026-05-06T00:00:00.000Z",
    });
    const events = [
      unrelatedEvent("2026-05-06T00:01:00.000Z"),
      unrelatedEvent("2026-05-06T00:02:00.000Z"),
    ];
    const out = classifyPendingEntries(
      [entry],
      events,
      new Date("2026-05-06T01:00:00.000Z"),
    );
    expect(out).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Multi-entry attribution
// ---------------------------------------------------------------------------

describe("multi-entry classification", () => {
  test("classifier returns one attribution per qualifying entry", () => {
    const entryA = makeEntry({
      entryId: "ea",
      epicId: "factory-core-A",
      timestamp: "2026-05-05T00:00:00.000Z", // > 24h ago, no events
    });
    const entryB = makeEntry({
      entryId: "eb",
      epicId: "factory-core-B",
      timestamp: "2026-05-06T00:00:00.000Z",
    });
    const events = [
      // closure for B
      closureEvent("2026-05-06T00:30:00.000Z", "factory-core-B"),
    ];
    const now = new Date("2026-05-07T00:00:00.000Z");
    const out = classifyPendingEntries([entryA, entryB], events, now);
    expect(out).toHaveLength(2);
    expect(out.find((a) => a.entryId === "ea")).toMatchObject({
      outcome: "positive",
      rationale: "24h elapsed without re-escalation",
    });
    expect(out.find((a) => a.entryId === "eb")).toMatchObject({
      outcome: "positive",
      rationale: "epic closed without re-escalation",
    });
  });
});

// ---------------------------------------------------------------------------
// Defensive — malformed input
// ---------------------------------------------------------------------------

describe("defensive — malformed input", () => {
  test("entry with NaN timestamp is skipped", () => {
    const entry = makeEntry({
      entryId: "e1",
      timestamp: "not-a-real-iso-timestamp",
    });
    const out = classifyPendingEntries(
      [entry],
      [],
      new Date("2026-05-30T00:00:00.000Z"),
    );
    expect(out).toEqual([]);
  });

  test("event with NaN timestamp is ignored (no negative)", () => {
    const entry = makeEntry({
      entryId: "e1",
      timestamp: "2026-05-06T00:00:00.000Z",
    });
    const reEntry = makeEntry({
      entryId: "e2",
      timestamp: "2026-05-06T00:01:00.000Z",
    });
    const events = [
      makeEvent({
        type: "stage-dispatched",
        timestamp: "garbage-timestamp",
        epicId: EPIC,
        payload: { toAction: "run-coherence-agent" },
      }),
    ];
    const out = classifyPendingEntries(
      [entry, reEntry],
      events,
      new Date("2026-05-06T00:02:00.000Z"),
    );
    // Negative would have fired with valid timestamp; with NaN, classifier skips.
    expect(out.find((a) => a.entryId === "e1")).toBeUndefined();
  });
});
