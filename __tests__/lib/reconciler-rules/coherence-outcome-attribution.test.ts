// =============================================================================
// Tests for src/lib/reconciler-rules/coherence-outcome-attribution.ts
// (factory-core-wlsr.6).
//
// Integration tests against a real CoherenceJournal repository (tmpdir-backed
// JSONL — same discipline as coherence-journal.test.ts and event-log tests).
// We register the rule on a real Reconciler instance and drive ticks with
// real event-log appends. The classifier itself is also exercised through
// these tests; its dedicated unit tests live in coherence-outcome-classifier.test.ts.
//
// AC #11 coverage:
//   - rule integrates with ReconcilerRule (matches/act);
//   - reads journal via CoherenceJournal repository;
//   - persists outcomes via updateOutcome;
//   - per-entry errors logged & skipped (next tick retries).
// =============================================================================

import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";

import { Reconciler } from "@/lib/reconciler";
import { appendEvent } from "@/lib/event-log";
import { CoherenceJournal, type JournalEntry } from "@/lib/coherence-journal";
import {
  buildCoherenceOutcomeAttributionRule,
  COHERENCE_OUTCOME_ATTRIBUTION_RULE_NAME,
} from "@/lib/reconciler-rules/coherence-outcome-attribution";

const FINGERPRINT =
  "stage:builder|status:failure|blocker_class:test-fail|next_agent_attempted:operator";
const EPIC = "factory-core-test";

async function makeRepo(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "wlsr6-rule-"));
}

async function rmRepo(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

function makeEntrySeed(
  overrides: Partial<JournalEntry> = {},
): Omit<JournalEntry, "entryId" | "timestamp"> & {
  entryId?: string;
  timestamp?: string;
} {
  return {
    version: "1",
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

describe("coherence-outcome-attribution rule", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await makeRepo();
  });

  afterEach(async () => {
    await rmRepo(repo);
  });

  test("ReconcilerRule shape: matches() + act() defined; correct name", () => {
    const rule = buildCoherenceOutcomeAttributionRule({ repoPath: repo });
    expect(rule.name).toBe(COHERENCE_OUTCOME_ATTRIBUTION_RULE_NAME);
    expect(typeof rule.matches).toBe("function");
    expect(typeof rule.act).toBe("function");
  });

  test("integrates with Reconciler: positive-horizon entry attributed via real journal", async () => {
    // Seed: a pending entry, written 25h before the tick.
    const journal = new CoherenceJournal(repo);
    const entry = await journal.append(
      makeEntrySeed({ timestamp: "2026-05-06T00:00:00.000Z" }),
    );

    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(buildCoherenceOutcomeAttributionRule({ repoPath: repo }));

    // Drive a tick at 25h elapsed.
    await rec.tick(new Date("2026-05-07T01:00:00.000Z"));

    // Read journal back — outcome should now be positive.
    const after = await journal.all();
    const updated = after.find((e) => e.entryId === entry.entryId);
    expect(updated?.outcome).toBe("positive");
    expect(updated?.outcomeRationale).toBe(
      "24h elapsed without re-escalation",
    );
    expect(updated?.outcomeAttributedAt).not.toBeNull();
  });

  test("integrates with Reconciler: negative attribution from re-escalation event", async () => {
    const journal = new CoherenceJournal(repo);
    const original = await journal.append(
      makeEntrySeed({ timestamp: "2026-05-06T00:00:00.000Z" }),
    );
    // Re-escalation entry — same epic + same fingerprint, later timestamp.
    await journal.append(
      makeEntrySeed({ timestamp: "2026-05-06T00:01:30.000Z" }),
    );

    // Emit a stage-dispatched event for the re-escalation.
    await appendEvent(repo, {
      type: "stage-dispatched",
      epicId: EPIC,
      timestamp: "2026-05-06T00:01:30.000Z",
      payload: { toAction: "run-coherence-agent" },
    });

    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(buildCoherenceOutcomeAttributionRule({ repoPath: repo }));

    await rec.tick(new Date("2026-05-06T00:02:00.000Z"));

    const after = await journal.all();
    const updated = after.find((e) => e.entryId === original.entryId);
    expect(updated?.outcome).toBe("negative");
    expect(updated?.outcomeRationale).toBe(
      "epic re-escalated to coherence on same fingerprint within 5 events",
    );
  });

  test("integrates with Reconciler: closure event attributes positive", async () => {
    const journal = new CoherenceJournal(repo);
    const entry = await journal.append(
      makeEntrySeed({ timestamp: "2026-05-06T00:00:00.000Z" }),
    );

    await appendEvent(repo, {
      type: "bead-status-changed",
      epicId: EPIC,
      timestamp: "2026-05-06T00:30:00.000Z",
      payload: { beadId: EPIC, newStatus: "closed" },
    });

    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(buildCoherenceOutcomeAttributionRule({ repoPath: repo }));

    await rec.tick(new Date("2026-05-06T00:31:00.000Z"));

    const after = await journal.all();
    const updated = after.find((e) => e.entryId === entry.entryId);
    expect(updated?.outcome).toBe("positive");
    expect(updated?.outcomeRationale).toBe("epic closed without re-escalation");
  });

  test("idempotency: pending entry stays pending if no signal; subsequent tick attributes when signal arrives", async () => {
    const journal = new CoherenceJournal(repo);
    const entry = await journal.append(
      makeEntrySeed({ timestamp: "2026-05-06T00:00:00.000Z" }),
    );

    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(buildCoherenceOutcomeAttributionRule({ repoPath: repo }));

    // Tick #1 — < 24h elapsed, no events. Should NOT attribute.
    await rec.tick(new Date("2026-05-06T01:00:00.000Z"));
    let after = await journal.all();
    expect(after.find((e) => e.entryId === entry.entryId)?.outcome).toBe(
      "pending",
    );

    // Closure event arrives.
    await appendEvent(repo, {
      type: "bead-status-changed",
      epicId: EPIC,
      timestamp: "2026-05-06T02:00:00.000Z",
      payload: { beadId: EPIC, newStatus: "closed" },
    });

    // Tick #2 — should attribute positive.
    await rec.tick(new Date("2026-05-06T02:01:00.000Z"));
    after = await journal.all();
    expect(after.find((e) => e.entryId === entry.entryId)?.outcome).toBe(
      "positive",
    );
  });

  test("idempotency: classifier filters non-pending entries — second tick is a no-op", async () => {
    const journal = new CoherenceJournal(repo);
    const entry = await journal.append(
      makeEntrySeed({ timestamp: "2026-05-06T00:00:00.000Z" }),
    );

    await appendEvent(repo, {
      type: "bead-status-changed",
      epicId: EPIC,
      timestamp: "2026-05-06T00:30:00.000Z",
      payload: { beadId: EPIC, newStatus: "closed" },
    });

    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(buildCoherenceOutcomeAttributionRule({ repoPath: repo }));

    await rec.tick(new Date("2026-05-06T00:31:00.000Z"));
    const after1 = await journal.all();
    const t1 = after1.find((e) => e.entryId === entry.entryId)
      ?.outcomeAttributedAt;
    expect(t1).not.toBeNull();

    // Re-tick. Classifier sees outcome !== "pending" → no attribution returned.
    // The reconciler's idempotency layer also blocks because the
    // action-taken event was emitted on tick 1.
    await rec.tick(new Date("2026-05-06T00:32:00.000Z"));
    const after2 = await journal.all();
    const t2 = after2.find((e) => e.entryId === entry.entryId)
      ?.outcomeAttributedAt;
    // outcomeAttributedAt unchanged proves no new tombstone was appended.
    expect(t2).toBe(t1);
  });

  test("per-entry act error is logged and does not abort subsequent rule fires", async () => {
    const journal = new CoherenceJournal(repo);
    const entryA = await journal.append(
      makeEntrySeed({
        epicId: "factory-core-A",
        timestamp: "2026-05-06T00:00:00.000Z",
      }),
    );
    const entryB = await journal.append(
      makeEntrySeed({
        epicId: "factory-core-B",
        timestamp: "2026-05-06T00:00:00.000Z",
      }),
    );

    // Drive both into positive-horizon territory.
    const now = new Date("2026-05-07T01:00:00.000Z");

    // First call to journalFactory()'s updateOutcome throws; subsequent
    // calls succeed. We do this by spying on CoherenceJournal.prototype.
    const realUpdate = CoherenceJournal.prototype.updateOutcome;
    let callCount = 0;
    const spy = jest
      .spyOn(CoherenceJournal.prototype, "updateOutcome")
      .mockImplementation(async function (
        this: CoherenceJournal,
        entryId,
        outcome,
        rationale,
      ) {
        callCount += 1;
        if (callCount === 1) {
          throw new Error("simulated disk failure for first attribution");
        }
        return realUpdate.call(this, entryId, outcome, rationale);
      });

    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    try {
      const rec = new Reconciler({ repoPath: repo });
      rec.registerRule(
        buildCoherenceOutcomeAttributionRule({ repoPath: repo }),
      );
      await rec.tick(now);
    } finally {
      spy.mockRestore();
      errSpy.mockRestore();
    }

    // Second entry's updateOutcome ran successfully (call #2 reached real impl).
    const after = await journal.all();
    const persistedOutcomes = [entryA, entryB].map(
      (e) => after.find((x) => x.entryId === e.entryId)?.outcome,
    );
    // At least one of the two should be "positive" — the rule didn't abort
    // the loop after the first failure.
    expect(persistedOutcomes.filter((o) => o === "positive").length).toBe(1);
  });

  test("journal read failure: rule skips tick gracefully, returns no matches", async () => {
    // Spy CoherenceJournal.prototype.all to throw on first call.
    const spy = jest
      .spyOn(CoherenceJournal.prototype, "all")
      .mockImplementationOnce(async () => {
        throw new Error("simulated journal read failure");
      });
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    try {
      const rule = buildCoherenceOutcomeAttributionRule({ repoPath: repo });
      const matches = await rule.matches([], new Date());
      expect(matches).toEqual([]);
    } finally {
      spy.mockRestore();
      errSpy.mockRestore();
    }
  });

  test("multi-entry tick: returns one ReconcilerMatch per attribution", async () => {
    const journal = new CoherenceJournal(repo);
    const entryA = await journal.append(
      makeEntrySeed({
        epicId: "factory-core-A",
        timestamp: "2026-05-06T00:00:00.000Z",
      }),
    );
    const entryB = await journal.append(
      makeEntrySeed({
        epicId: "factory-core-B",
        timestamp: "2026-05-06T00:00:00.000Z",
      }),
    );

    const now = new Date("2026-05-07T01:00:00.000Z");
    const rule = buildCoherenceOutcomeAttributionRule({ repoPath: repo });
    const matches = await rule.matches([], now);

    expect(matches).toHaveLength(2);
    const ids = matches.map((m) => m.epicId).sort();
    expect(ids).toEqual(["factory-core-A", "factory-core-B"]);
    // Idempotency keys embed the entryId AND outcome.
    for (const m of matches) {
      expect(m.idempotencyKey).toMatch(
        new RegExp(`^${COHERENCE_OUTCOME_ATTRIBUTION_RULE_NAME}::.*::positive$`),
      );
    }
    // entryA + entryB both get attributions
    const entryIds = new Set(
      matches.map((m) => {
        const ctx = m.context as { attribution: { entryId: string } };
        return ctx.attribution.entryId;
      }),
    );
    expect(entryIds.has(entryA.entryId)).toBe(true);
    expect(entryIds.has(entryB.entryId)).toBe(true);
  });

  // ===========================================================================
  // Round-trip integration test (factory-core-wlsr.19 AC#5)
  // ===========================================================================
  //
  // Per AC#5: "append a journal entry via CoherenceJournal.append, simulate
  // a bd close (synthetic bead-status-changed event), tick reconciler twice,
  // verify the entry's outcome transitions from pending → positive with
  // rationale 'epic closed without re-escalation'."
  //
  // This is the end-to-end signal that wlsr.19's wiring closes the loop —
  // the rule (factory-core-wlsr.6) consumes the event closeEpic emits
  // (factory-core-wlsr.19 closeEpic helper change in pipeline-labels.ts)
  // and produces a positive attribution.
  // ===========================================================================
  test("AC#5 round-trip: pending → positive on synthetic bd-close event after two ticks", async () => {
    // Step 1: append a pending journal entry (CoherenceJournal.append).
    const journal = new CoherenceJournal(repo);
    const entry = await journal.append(
      makeEntrySeed({ timestamp: "2026-05-06T00:00:00.000Z" }),
    );

    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(buildCoherenceOutcomeAttributionRule({ repoPath: repo }));

    // Tick #1 — BEFORE the synthetic bd-close event lands. No closure
    // event in the log yet, time-horizon (24h) not reached. Expect the
    // entry to remain pending; the rule attributes nothing.
    await rec.tick(new Date("2026-05-06T00:01:00.000Z"));
    let after = await journal.all();
    expect(after.find((e) => e.entryId === entry.entryId)?.outcome).toBe(
      "pending",
    );

    // Step 2: simulate a `bd close` by appending the bead-status-changed
    // event in the exact shape closeEpic (pipeline-labels.ts) emits after
    // bd reports success. The match contract is documented in
    // coherence-outcome-classifier.ts § "Closure event":
    //   { type: "bead-status-changed",
    //     epicId: <issueId>,
    //     payload: { beadId: <issueId>, newStatus: "closed" } }
    await appendEvent(repo, {
      type: "bead-status-changed",
      epicId: entry.epicId,
      timestamp: "2026-05-06T00:02:00.000Z",
      payload: { beadId: entry.epicId, newStatus: "closed" },
    });

    // Tick #2 — AFTER the closure event. Rule should attribute positive
    // with rationale "epic closed without re-escalation".
    await rec.tick(new Date("2026-05-06T00:03:00.000Z"));

    after = await journal.all();
    const updated = after.find((e) => e.entryId === entry.entryId);
    expect(updated?.outcome).toBe("positive");
    expect(updated?.outcomeRationale).toBe("epic closed without re-escalation");
    expect(updated?.outcomeAttributedAt).not.toBeNull();
  });
});
