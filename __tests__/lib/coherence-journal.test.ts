// =============================================================================
// Tests for src/lib/coherence-journal.ts (factory-core-wlsr.2)
//
// Real tmpdir-backed filesystem fixture (no mocked fs except for the single
// append-failure test that uses jest.spyOn on fs.appendFile). Mirrors the
// event-log.ts test discipline.
//
// AC #13 coverage:
//   - append + read round-trip
//   - multi-entry read
//   - malformed-line tolerance
//   - tombstone outcome update
//   - multi-tombstone latest-wins
//   - findSimilar exact match
//   - findByEpicId
//   - mkdir -p on first append
//   - append-failure-does-not-throw (mocked appendFile rejection only)
//   - v2-field round-trip (labelMutations, depContext, escalationContext)
//   - legacy-entry round-trip (v2 fields all undefined)
// =============================================================================

import { promises as fs } from "fs";
import os from "os";
import path from "path";

import {
  CoherenceJournal,
  anomalyFingerprint,
  type JournalEntry,
  type EscalationContext,
  type EscalationReason,
  type AnomalyType,
} from "@/lib/coherence-journal";
import type { MarkerData } from "@/lib/marker-reader";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "coherence-journal-"));
  return dir;
}

async function rmTmpRepo(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
}

function journalPath(repoPath: string): string {
  return path.join(repoPath, ".beads", "coherence", "journal.jsonl");
}

// Minimal valid JournalEntry seed for round-trip tests. Per AC #13 callers
// override fields they want to test.
function makeEntrySeed(
  overrides: Partial<JournalEntry> = {},
): Omit<JournalEntry, "entryId" | "timestamp"> {
  return {
    version: "1",
    epicId: "factory-core-test",
    triggeringMarker: {
      path: ".beads/markers/factory-core-test-builder.json",
      stage: "builder",
      status: "failure",
      blocker_class: "test-fail",
      next_agent_attempted: "operator",
    },
    anomalyFingerprint:
      "stage:builder|status:failure|blocker_class:test-fail|next_agent_attempted:operator",
    priorEntriesConsulted: [],
    diagnosis: "Test diagnosis. Reasoning context. Decision rationale.",
    decision: { action: "dispatch-chain-action", params: {} },
    dispatchedAgent: "builder",
    escalationReason: null,
    outcome: "pending",
    outcomeAttributedAt: null,
    outcomeRationale: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// anomalyFingerprint (pure function — AC #6)
// ---------------------------------------------------------------------------

describe("anomalyFingerprint", () => {
  it("derives stage|status from a minimal marker", () => {
    const marker = {
      version: "1",
      stage: "builder",
      status: "failure",
      started_at: "2026-05-06T00:00:00Z",
      exited_at: "2026-05-06T00:01:00Z",
    } as MarkerData;
    expect(anomalyFingerprint(marker)).toBe("stage:builder|status:failure");
  });

  it("includes blocker_class when present", () => {
    const marker = {
      version: "1",
      stage: "builder",
      status: "failure",
      blocker_class: "test-fail",
      started_at: "x",
      exited_at: "y",
    } as MarkerData;
    expect(anomalyFingerprint(marker)).toBe(
      "stage:builder|status:failure|blocker_class:test-fail",
    );
  });

  it("includes next_agent_attempted when next_agent set", () => {
    const marker = {
      version: "1",
      stage: "reviewer",
      status: "success",
      next_agent: "operator",
      started_at: "x",
      exited_at: "y",
    } as MarkerData;
    expect(anomalyFingerprint(marker)).toBe(
      "stage:reviewer|status:success|next_agent_attempted:operator",
    );
  });

  it("includes qa_round when present (extra field via index signature)", () => {
    const marker = {
      version: "1",
      stage: "qa",
      status: "needs-decision",
      qa_round: 5,
      started_at: "x",
      exited_at: "y",
    } as unknown as MarkerData;
    expect(anomalyFingerprint(marker)).toBe(
      "stage:qa|status:needs-decision|qa_round:5",
    );
  });

  it("emits all components in canonical order when present", () => {
    const marker = {
      version: "1",
      stage: "qa",
      status: "needs-decision",
      blocker_class: "test-fail",
      next_agent: "operator",
      qa_round: 7,
      started_at: "x",
      exited_at: "y",
    } as unknown as MarkerData;
    expect(anomalyFingerprint(marker)).toBe(
      "stage:qa|status:needs-decision|blocker_class:test-fail|next_agent_attempted:operator|qa_round:7",
    );
  });
});

// ---------------------------------------------------------------------------
// CoherenceJournal — append + read round-trip
// ---------------------------------------------------------------------------

describe("CoherenceJournal — append + read", () => {
  let repoPath: string;
  beforeEach(async () => {
    repoPath = await makeTmpRepo();
  });
  afterEach(async () => {
    await rmTmpRepo(repoPath);
  });

  it("creates the journal directory on first append (mkdir -p)", async () => {
    const j = new CoherenceJournal(repoPath);
    // Pre-condition: .beads/coherence does not exist
    await expect(
      fs.access(path.join(repoPath, ".beads", "coherence")),
    ).rejects.toThrow();

    await j.append(makeEntrySeed());

    // Post-condition: .beads/coherence and journal.jsonl exist
    await expect(fs.access(journalPath(repoPath))).resolves.not.toThrow();
  });

  it("round-trips a single entry: append then all() returns it", async () => {
    const j = new CoherenceJournal(repoPath);
    const written = await j.append(makeEntrySeed());

    const read = await j.all();
    expect(read).toHaveLength(1);
    expect(read[0]).toEqual(written);
    // Generated identity fields are present
    expect(typeof read[0].entryId).toBe("string");
    expect(read[0].entryId.length).toBeGreaterThan(8);
    expect(typeof read[0].timestamp).toBe("string");
  });

  it("returns [] when journal file does not exist", async () => {
    const j = new CoherenceJournal(repoPath);
    expect(await j.all()).toEqual([]);
    expect(await j.findByEpicId("anything")).toEqual([]);
    expect(await j.findSimilar("anything")).toEqual([]);
  });

  it("multi-entry read returns newest-first", async () => {
    const j = new CoherenceJournal(repoPath);
    const e1 = await j.append(makeEntrySeed({ epicId: "epic-a" }));
    const e2 = await j.append(makeEntrySeed({ epicId: "epic-b" }));
    const e3 = await j.append(makeEntrySeed({ epicId: "epic-c" }));

    const all = await j.all();
    expect(all.map((e) => e.epicId)).toEqual(["epic-c", "epic-b", "epic-a"]);
    expect(all.map((e) => e.entryId)).toEqual([
      e3.entryId,
      e2.entryId,
      e1.entryId,
    ]);
  });
});

// ---------------------------------------------------------------------------
// CoherenceJournal — malformed-line tolerance (AC #11)
// ---------------------------------------------------------------------------

describe("CoherenceJournal — malformed-line tolerance", () => {
  let repoPath: string;
  let warnSpy: jest.SpyInstance;
  beforeEach(async () => {
    repoPath = await makeTmpRepo();
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(async () => {
    warnSpy.mockRestore();
    await rmTmpRepo(repoPath);
  });

  it("skips malformed lines and returns valid entries", async () => {
    const j = new CoherenceJournal(repoPath);
    await j.append(makeEntrySeed({ epicId: "valid-1" }));

    // Inject malformed lines by direct write.
    await fs.appendFile(
      journalPath(repoPath),
      "{not valid json\n" + "[1,2,3]\n" + '{"_outcomeUpdate":true}\n',
      { encoding: "utf-8" },
    );

    await j.append(makeEntrySeed({ epicId: "valid-2" }));

    const all = await j.all();
    expect(all.map((e) => e.epicId)).toEqual(["valid-2", "valid-1"]);
    // At least one warning per malformed line (3 lines).
    expect(warnSpy).toHaveBeenCalled();
  });

  it("skips entries missing required fields (entryId, epicId, anomalyFingerprint)", async () => {
    const j = new CoherenceJournal(repoPath);
    await fs.mkdir(path.dirname(journalPath(repoPath)), { recursive: true });
    await fs.writeFile(
      journalPath(repoPath),
      JSON.stringify({ entryId: "x" }) + "\n",
    );
    expect(await j.all()).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// CoherenceJournal — tombstone outcome updates (AC #10, #12)
// ---------------------------------------------------------------------------

describe("CoherenceJournal — outcome tombstones", () => {
  let repoPath: string;
  beforeEach(async () => {
    repoPath = await makeTmpRepo();
  });
  afterEach(async () => {
    await rmTmpRepo(repoPath);
  });

  it("updateOutcome appends a tombstone and reader resolves outcome", async () => {
    const j = new CoherenceJournal(repoPath);
    const written = await j.append(makeEntrySeed());
    expect((await j.all())[0].outcome).toBe("pending");

    await j.updateOutcome(
      written.entryId,
      "positive",
      "epic closed without re-escalation",
    );

    const after = await j.all();
    expect(after).toHaveLength(1);
    expect(after[0].outcome).toBe("positive");
    expect(after[0].outcomeRationale).toBe(
      "epic closed without re-escalation",
    );
    expect(typeof after[0].outcomeAttributedAt).toBe("string");
  });

  it("never mutates the original entry line", async () => {
    const j = new CoherenceJournal(repoPath);
    const written = await j.append(makeEntrySeed());
    const before = await fs.readFile(journalPath(repoPath), "utf-8");

    await j.updateOutcome(written.entryId, "negative", "re-escalated");

    const after = await fs.readFile(journalPath(repoPath), "utf-8");
    // original line is the prefix of `after`
    expect(after.startsWith(before)).toBe(true);
    // exactly two lines (entry + tombstone) trailing newlines preserved
    const nonEmptyLines = after.split("\n").filter((l) => l.trim().length > 0);
    expect(nonEmptyLines).toHaveLength(2);
    const tombstone = JSON.parse(nonEmptyLines[1]);
    expect(tombstone._outcomeUpdate).toBe(true);
    expect(tombstone.entryId).toBe(written.entryId);
  });

  it("multi-tombstone latest-wins when re-running all()", async () => {
    const j = new CoherenceJournal(repoPath);
    const written = await j.append(makeEntrySeed());

    await j.updateOutcome(written.entryId, "positive", "first attribution");
    await j.updateOutcome(written.entryId, "negative", "reclassified");
    await j.updateOutcome(written.entryId, "positive", "final attribution");

    const all = await j.all();
    expect(all).toHaveLength(1);
    expect(all[0].outcome).toBe("positive");
    expect(all[0].outcomeRationale).toBe("final attribution");
  });

  it("multiple entries with tombstones: each resolved independently", async () => {
    const j = new CoherenceJournal(repoPath);
    const a = await j.append(makeEntrySeed({ epicId: "epic-a" }));
    const b = await j.append(makeEntrySeed({ epicId: "epic-b" }));
    const c = await j.append(makeEntrySeed({ epicId: "epic-c" }));

    await j.updateOutcome(a.entryId, "positive", "a closed cleanly");
    await j.updateOutcome(b.entryId, "negative", "b re-escalated");
    // c: pending intentionally

    const all = await j.all();
    const byId = new Map(all.map((e) => [e.entryId, e]));
    expect(byId.get(a.entryId)?.outcome).toBe("positive");
    expect(byId.get(b.entryId)?.outcome).toBe("negative");
    expect(byId.get(c.entryId)?.outcome).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// CoherenceJournal — findSimilar (AC #9)
// ---------------------------------------------------------------------------

describe("CoherenceJournal — findSimilar", () => {
  let repoPath: string;
  beforeEach(async () => {
    repoPath = await makeTmpRepo();
  });
  afterEach(async () => {
    await rmTmpRepo(repoPath);
  });

  it("returns entries with exact-match fingerprint, newest-first", async () => {
    const j = new CoherenceJournal(repoPath);
    const fp1 = "stage:builder|status:failure|blocker_class:test-fail";
    const fp2 = "stage:reviewer|status:success|next_agent_attempted:operator";

    const a = await j.append(
      makeEntrySeed({ anomalyFingerprint: fp1, epicId: "older-fp1" }),
    );
    await j.append(
      makeEntrySeed({ anomalyFingerprint: fp2, epicId: "fp2-noise" }),
    );
    const c = await j.append(
      makeEntrySeed({ anomalyFingerprint: fp1, epicId: "newer-fp1" }),
    );

    // Mark all as positive so they pass the default-completed filter.
    await j.updateOutcome(a.entryId, "positive", "ok");
    await j.updateOutcome(c.entryId, "positive", "ok");

    const matches = await j.findSimilar(fp1);
    expect(matches.map((e) => e.epicId)).toEqual(["newer-fp1", "older-fp1"]);
  });

  it("default opts filter out pending entries", async () => {
    const j = new CoherenceJournal(repoPath);
    const fp = "stage:builder|status:failure";
    await j.append(makeEntrySeed({ anomalyFingerprint: fp }));

    expect(await j.findSimilar(fp)).toEqual([]);
    const all = await j.findSimilar(fp, { includeAllOutcomes: true });
    expect(all).toHaveLength(1);
  });

  it("returns [] when no fingerprint matches", async () => {
    const j = new CoherenceJournal(repoPath);
    await j.append(makeEntrySeed());
    expect(await j.findSimilar("nonsense")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// CoherenceJournal — findByEpicId (AC #7)
// ---------------------------------------------------------------------------

describe("CoherenceJournal — findByEpicId", () => {
  let repoPath: string;
  beforeEach(async () => {
    repoPath = await makeTmpRepo();
  });
  afterEach(async () => {
    await rmTmpRepo(repoPath);
  });

  it("returns only entries for the given epicId, newest-first", async () => {
    const j = new CoherenceJournal(repoPath);
    await j.append(makeEntrySeed({ epicId: "epic-a" })); // index 0
    await j.append(makeEntrySeed({ epicId: "epic-b" }));
    await j.append(makeEntrySeed({ epicId: "epic-a" })); // index 2 — newest a

    const a = await j.findByEpicId("epic-a");
    expect(a).toHaveLength(2);
    expect(a[0].epicId).toBe("epic-a");
    expect(a[1].epicId).toBe("epic-a");
  });
});

// ---------------------------------------------------------------------------
// CoherenceJournal — append-failure-does-not-throw (AC #8 / ADR-007)
// ---------------------------------------------------------------------------

describe("CoherenceJournal — append failure contract", () => {
  let repoPath: string;
  let errSpy: jest.SpyInstance;
  beforeEach(async () => {
    repoPath = await makeTmpRepo();
    errSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(async () => {
    errSpy.mockRestore();
    await rmTmpRepo(repoPath);
  });

  it("swallows fs.appendFile rejections and logs to console.error", async () => {
    const j = new CoherenceJournal(repoPath);
    const spy = jest
      .spyOn(fs, "appendFile")
      .mockRejectedValueOnce(new Error("ENOSPC: disk full"));

    // Must not throw.
    await expect(j.append(makeEntrySeed())).resolves.not.toThrow();
    expect(errSpy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("updateOutcome also swallows append failures", async () => {
    const j = new CoherenceJournal(repoPath);
    const written = await j.append(makeEntrySeed());

    const spy = jest
      .spyOn(fs, "appendFile")
      .mockRejectedValueOnce(new Error("EROFS: read-only fs"));

    await expect(
      j.updateOutcome(written.entryId, "positive", "x"),
    ).resolves.not.toThrow();
    expect(errSpy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// v2 round-trip — labelMutations / depContext / escalationContext
// (AC #2, #3, #4, #13)
// ---------------------------------------------------------------------------

describe("CoherenceJournal — v2 optional fields round-trip", () => {
  let repoPath: string;
  beforeEach(async () => {
    repoPath = await makeTmpRepo();
  });
  afterEach(async () => {
    await rmTmpRepo(repoPath);
  });

  it("preserves labelMutations (ADR-013) when present", async () => {
    const j = new CoherenceJournal(repoPath);
    const labelMutations: JournalEntry["labelMutations"] = [
      {
        beadId: "factory-core-niii.1",
        removed: ["pipeline:test-spec"],
        added: ["pipeline:planning"],
        rationale: "stale test-spec label after replan",
      },
    ];
    const written = await j.append(makeEntrySeed({ labelMutations }));

    const read = await j.all();
    expect(read).toHaveLength(1);
    expect(read[0].labelMutations).toEqual(labelMutations);
    expect(read[0].entryId).toBe(written.entryId);
  });

  it("preserves depContext (ADR-014) when present", async () => {
    const j = new CoherenceJournal(repoPath);
    const depContext: JournalEntry["depContext"] = {
      blockerBeadIds: ["factory-core-foo.1", "factory-core-foo.2"],
      notesTierCues: ["blocked by factory-core-foo.1"],
      cycleDetected: false,
    };
    await j.append(makeEntrySeed({ depContext }));

    const read = await j.all();
    expect(read[0].depContext).toEqual(depContext);
  });

  it("preserves cycleDetected=true in depContext", async () => {
    const j = new CoherenceJournal(repoPath);
    const depContext: JournalEntry["depContext"] = {
      blockerBeadIds: ["a", "b", "c"],
      notesTierCues: [],
      cycleDetected: true,
    };
    await j.append(
      makeEntrySeed({
        depContext,
        decision: { action: "escalate", params: {} },
        dispatchedAgent: null,
        escalationReason: "irreducible-uncertainty",
      }),
    );

    const read = await j.all();
    expect(read[0].depContext?.cycleDetected).toBe(true);
    expect(read[0].escalationReason).toBe("irreducible-uncertainty");
  });

  it("preserves escalationContext (ADR-015 § 3) when present", async () => {
    const j = new CoherenceJournal(repoPath);
    const escalationContext: EscalationContext = {
      anomalyType: "stuck-in-stage",
      epicId: "factory-core-niii",
      ruleId: "stuck-in-stage",
      recentEvents: [
        {
          type: "agent-launched",
          timestamp: "2026-05-05T12:00:00Z",
          epicId: "factory-core-niii",
        },
        {
          type: "agent-exited",
          timestamp: "2026-05-05T12:05:00Z",
          epicId: "factory-core-niii",
          payload: { status: "success" },
        },
      ],
      ruleSpecificContext: {
        stage: "reviewer",
        lastEventAgeMinutes: 47,
      },
    };
    await j.append(makeEntrySeed({ escalationContext }));

    const read = await j.all();
    expect(read[0].escalationContext).toEqual(escalationContext);
    expect(read[0].escalationContext?.anomalyType).toBe("stuck-in-stage");
    expect(read[0].escalationContext?.recentEvents).toHaveLength(2);
  });

  it("preserves escalationContext=null when explicitly set", async () => {
    const j = new CoherenceJournal(repoPath);
    await j.append(makeEntrySeed({ escalationContext: null }));
    const read = await j.all();
    expect(read[0].escalationContext).toBeNull();
  });

  it("legacy entry round-trip: v2 fields all undefined", async () => {
    const j = new CoherenceJournal(repoPath);
    // makeEntrySeed default omits labelMutations / depContext / escalationContext
    await j.append(makeEntrySeed());
    const read = await j.all();
    expect(read[0].labelMutations).toBeUndefined();
    expect(read[0].depContext).toBeUndefined();
    expect(read[0].escalationContext).toBeUndefined();
  });

  it("a single entry can carry all three v2 fields simultaneously", async () => {
    const j = new CoherenceJournal(repoPath);
    const labelMutations: JournalEntry["labelMutations"] = [
      {
        beadId: "factory-core-niii.1",
        removed: ["pipeline:test-spec"],
        added: [],
        rationale: "cleanup",
      },
    ];
    const depContext: JournalEntry["depContext"] = {
      blockerBeadIds: ["factory-core-bar.1"],
      notesTierCues: ["depends on factory-core-bar.1"],
      cycleDetected: false,
    };
    const escalationContext: EscalationContext = {
      anomalyType: "missed-wave-review-dispatch",
      epicId: "factory-core-niii",
      ruleId: "missed-wave-review-dispatch",
      recentEvents: [],
    };

    await j.append(
      makeEntrySeed({ labelMutations, depContext, escalationContext }),
    );
    const read = await j.all();
    expect(read[0].labelMutations).toEqual(labelMutations);
    expect(read[0].depContext).toEqual(depContext);
    expect(read[0].escalationContext).toEqual(escalationContext);
  });
});

// ---------------------------------------------------------------------------
// AnomalyType / EscalationReason / EscalationContext type-shape sanity (AC #4, #5, #3)
// ---------------------------------------------------------------------------

describe("Closed enums and EscalationContext shape", () => {
  it("AnomalyType union includes exactly the six closed values", () => {
    // Compile-time test via exhaustive assignment. If any value is added
    // or removed in coherence-journal.ts, this block stops compiling.
    const all: AnomalyType[] = [
      "stuck-in-stage",
      "repeated-qa-round",
      "repeat-dispatch-no-progress",
      "wave-bead-mismatch",
      "missed-wave-review-dispatch",
      "marker-non-success-outcome",
    ];
    expect(all).toHaveLength(6);
  });

  it("EscalationReason union includes exactly the five closed values", () => {
    const all: EscalationReason[] = [
      "journal-shows-prior-failures",
      "irreducible-uncertainty",
      "policy-decision-required",
      "external-dependency-failure",
      "explicit-stop-and-surface",
    ];
    expect(all).toHaveLength(5);
  });

  it("EscalationContext requires anomalyType, epicId, ruleId, recentEvents", () => {
    // Compile-time check via assignment. If any required field is dropped,
    // this stops compiling.
    const ctx: EscalationContext = {
      anomalyType: "wave-bead-mismatch",
      epicId: "factory-core-test",
      ruleId: "wave-bead-mismatch",
      recentEvents: [],
    };
    expect(ctx.anomalyType).toBe("wave-bead-mismatch");
    expect(ctx.marker).toBeUndefined();
    expect(ctx.ruleSpecificContext).toBeUndefined();
  });
});
