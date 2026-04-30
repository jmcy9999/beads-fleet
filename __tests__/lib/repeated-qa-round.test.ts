// =============================================================================
// Tests for src/lib/reconciler-rules/repeated-qa-round.ts (factory-core-zsjv.3)
// =============================================================================

import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";

import { Reconciler } from "@/lib/reconciler";
import { appendEvent } from "@/lib/event-log";
import {
  buildRepeatedQaRoundRule,
  type EpicSnapshot,
  type QaRoundMarkerData,
} from "@/lib/reconciler-rules/repeated-qa-round";

const addLabelsMock = jest.fn();

jest.mock("@/lib/pipeline-labels", () => ({
  addLabelsToEpic: (id: string, labels: string[]) => addLabelsMock(id, labels),
  removeLabelsFromEpic: jest.fn().mockResolvedValue(undefined),
}));

async function makeRepo(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "zsjv3-test-"));
}

function snap(partial: Partial<EpicSnapshot>): EpicSnapshot {
  return {
    currentStage: "qa",
    highestQaRound: 5,
    openBugCount: 3,
    hasNeedsHuman: false,
    labels: ["pipeline:qa", "qa:round-5"],
    title: "test-epic",
    ...partial,
  };
}

async function seedEvent(repo: string, epicId: string): Promise<void> {
  await appendEvent(repo, {
    type: "agent-exited",
    epicId,
    stage: "qa",
    payload: { exitCode: 0 },
  });
}

describe("repeated-qa-round rule", () => {
  beforeEach(() => {
    addLabelsMock.mockReset();
    addLabelsMock.mockResolvedValue(undefined);
  });

  test("round 5 with open bugs -> flag review:needs-human", async () => {
    const repo = await makeRepo();
    await seedEvent(repo, "factory-core-e1");
    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildRepeatedQaRoundRule({
        readEpicSnapshot: async () =>
          snap({ highestQaRound: 5, openBugCount: 3 }),
      }),
    );
    await rec.tick();
    expect(addLabelsMock).toHaveBeenCalledWith("factory-core-e1", [
      "review:needs-human",
    ]);
  });

  test("round < 5 does not trigger", async () => {
    const repo = await makeRepo();
    await seedEvent(repo, "factory-core-e1");
    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildRepeatedQaRoundRule({
        readEpicSnapshot: async () =>
          snap({ highestQaRound: 4, openBugCount: 3 }),
      }),
    );
    await rec.tick();
    expect(addLabelsMock).not.toHaveBeenCalled();
  });

  test("zero open bugs does not trigger (QA passing)", async () => {
    const repo = await makeRepo();
    await seedEvent(repo, "factory-core-e1");
    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildRepeatedQaRoundRule({
        readEpicSnapshot: async () =>
          snap({ highestQaRound: 7, openBugCount: 0 }),
      }),
    );
    await rec.tick();
    expect(addLabelsMock).not.toHaveBeenCalled();
  });

  test("bd failure (openBugCount=-1) fail-safe skips", async () => {
    const repo = await makeRepo();
    await seedEvent(repo, "factory-core-e1");
    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildRepeatedQaRoundRule({
        readEpicSnapshot: async () =>
          snap({ highestQaRound: 7, openBugCount: -1 }),
      }),
    );
    await rec.tick();
    expect(addLabelsMock).not.toHaveBeenCalled();
  });

  test("already flagged (hasNeedsHuman=true) does not re-fire", async () => {
    const repo = await makeRepo();
    await seedEvent(repo, "factory-core-e1");
    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildRepeatedQaRoundRule({
        readEpicSnapshot: async () =>
          snap({ highestQaRound: 6, hasNeedsHuman: true }),
      }),
    );
    await rec.tick();
    expect(addLabelsMock).not.toHaveBeenCalled();
  });

  test("non-qa stage is ignored", async () => {
    const repo = await makeRepo();
    await seedEvent(repo, "factory-core-e1");
    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildRepeatedQaRoundRule({
        readEpicSnapshot: async () =>
          snap({ currentStage: "development", highestQaRound: 7 }),
      }),
    );
    await rec.tick();
    expect(addLabelsMock).not.toHaveBeenCalled();
  });

  test("custom threshold respected", async () => {
    const repo = await makeRepo();
    await seedEvent(repo, "factory-core-e1");
    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildRepeatedQaRoundRule({
        roundThreshold: 3,
        readEpicSnapshot: async () =>
          snap({ highestQaRound: 3, openBugCount: 2 }),
      }),
    );
    await rec.tick();
    expect(addLabelsMock).toHaveBeenCalled();
  });

  test("idempotency: repeat tick at same round does not re-fire", async () => {
    const repo = await makeRepo();
    await seedEvent(repo, "factory-core-e1");
    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildRepeatedQaRoundRule({
        readEpicSnapshot: async () => snap({ highestQaRound: 6 }),
      }),
    );
    await rec.tick();
    await rec.tick();
    expect(addLabelsMock).toHaveBeenCalledTimes(1);
  });

  test("null snapshot (bd failure) skips cleanly", async () => {
    const repo = await makeRepo();
    await seedEvent(repo, "factory-core-e1");
    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildRepeatedQaRoundRule({
        readEpicSnapshot: async () => null,
      }),
    );
    await rec.tick();
    expect(addLabelsMock).not.toHaveBeenCalled();
  });

  // =============================================================================
  // beads_web-b98: Branch 2 — PASS-with-no-progress tests
  // =============================================================================

  /**
   * Helper: build a readQaRoundMarker mock from a map of round → marker data.
   * Returns null for rounds not in the map (simulating missing markers).
   */
  function makeMarkerReader(
    markers: Record<number, QaRoundMarkerData>,
  ): (epicId: string, round: number) => Promise<QaRoundMarkerData | null> {
    return async (_epicId: string, round: number) => markers[round] ?? null;
  }

  describe("Branch 2: PASS-with-no-progress (beads_web-b98)", () => {
    // AC 5(a): PASS-with-no-progress at K=3 (rounds 1/2/3 all PASS-no-delta) → fires at round 3
    test("K=3 consecutive PASS rounds with unchanged openBugs → fires at round 3", async () => {
      const repo = await makeRepo();
      await seedEvent(repo, "factory-core-e1");
      const rec = new Reconciler({ repoPath: repo });
      rec.registerRule(
        buildRepeatedQaRoundRule({
          readEpicSnapshot: async () =>
            snap({ highestQaRound: 3, openBugCount: 0 }),
          readQaRoundMarker: makeMarkerReader({
            1: { verdict: "PASS", openBugs: 0 },
            2: { verdict: "PASS", openBugs: 0 },
            3: { verdict: "PASS", openBugs: 0 },
          }),
        }),
      );
      await rec.tick();
      expect(addLabelsMock).toHaveBeenCalledWith("factory-core-e1", [
        "review:needs-human",
      ]);
    });

    // AC 5(a) variant: also fires when all K rounds have the same non-zero bug count
    test("K=3 consecutive PASS rounds with unchanged non-zero openBugs → fires", async () => {
      const repo = await makeRepo();
      await seedEvent(repo, "factory-core-e1");
      const rec = new Reconciler({ repoPath: repo });
      rec.registerRule(
        buildRepeatedQaRoundRule({
          readEpicSnapshot: async () =>
            snap({ highestQaRound: 5, openBugCount: 2 }),
          readQaRoundMarker: makeMarkerReader({
            3: { verdict: "PASS", openBugs: 2 },
            4: { verdict: "PASS", openBugs: 2 },
            5: { verdict: "PASS", openBugs: 2 },
          }),
        }),
      );
      await rec.tick();
      expect(addLabelsMock).toHaveBeenCalledWith("factory-core-e1", [
        "review:needs-human",
      ]);
    });

    // AC 5(b): at K-1=2 → doesn't fire
    test("only 2 consecutive PASS rounds (K-1) → does NOT fire", async () => {
      const repo = await makeRepo();
      await seedEvent(repo, "factory-core-e1");
      const rec = new Reconciler({ repoPath: repo });
      rec.registerRule(
        buildRepeatedQaRoundRule({
          readEpicSnapshot: async () =>
            snap({ highestQaRound: 2, openBugCount: 0 }),
          readQaRoundMarker: makeMarkerReader({
            1: { verdict: "PASS", openBugs: 0 },
            2: { verdict: "PASS", openBugs: 0 },
          }),
        }),
      );
      await rec.tick();
      expect(addLabelsMock).not.toHaveBeenCalled();
    });

    // AC 5(c): bug count decreasing across K rounds → doesn't fire (progress is being made)
    test("bug count decreasing across K rounds → does NOT fire", async () => {
      const repo = await makeRepo();
      await seedEvent(repo, "factory-core-e1");
      const rec = new Reconciler({ repoPath: repo });
      rec.registerRule(
        buildRepeatedQaRoundRule({
          readEpicSnapshot: async () =>
            snap({ highestQaRound: 3, openBugCount: 1 }),
          readQaRoundMarker: makeMarkerReader({
            1: { verdict: "PASS", openBugs: 3 },
            2: { verdict: "PASS", openBugs: 2 },
            3: { verdict: "PASS", openBugs: 1 },
          }),
        }),
      );
      await rec.tick();
      expect(addLabelsMock).not.toHaveBeenCalled();
    });

    // AC 5(d): FAIL verdict → doesn't fire on the new branch
    test("FAIL verdict in one of K rounds → does NOT fire on new branch", async () => {
      const repo = await makeRepo();
      await seedEvent(repo, "factory-core-e1");
      const rec = new Reconciler({ repoPath: repo });
      rec.registerRule(
        buildRepeatedQaRoundRule({
          readEpicSnapshot: async () =>
            snap({ highestQaRound: 3, openBugCount: 0 }),
          readQaRoundMarker: makeMarkerReader({
            1: { verdict: "PASS", openBugs: 0 },
            2: { verdict: "FAIL", openBugs: 0 },
            3: { verdict: "PASS", openBugs: 0 },
          }),
        }),
      );
      await rec.tick();
      expect(addLabelsMock).not.toHaveBeenCalled();
    });

    // AC 5(e): idempotency on new branch (one match per (epic, round))
    test("idempotency: repeat tick at same round does not re-fire new branch", async () => {
      const repo = await makeRepo();
      await seedEvent(repo, "factory-core-e1");
      const rec = new Reconciler({ repoPath: repo });
      rec.registerRule(
        buildRepeatedQaRoundRule({
          readEpicSnapshot: async () =>
            snap({ highestQaRound: 3, openBugCount: 0 }),
          readQaRoundMarker: makeMarkerReader({
            1: { verdict: "PASS", openBugs: 0 },
            2: { verdict: "PASS", openBugs: 0 },
            3: { verdict: "PASS", openBugs: 0 },
          }),
        }),
      );
      await rec.tick();
      await rec.tick();
      expect(addLabelsMock).toHaveBeenCalledTimes(1);
    });

    // Additional: verify distinct idempotency key format (::no-progress:: infix)
    test("idempotency key uses ::no-progress:: infix", async () => {
      const repo = await makeRepo();
      await seedEvent(repo, "factory-core-e1");
      const rec = new Reconciler({ repoPath: repo });
      const rule = buildRepeatedQaRoundRule({
        readEpicSnapshot: async () =>
          snap({ highestQaRound: 3, openBugCount: 0 }),
        readQaRoundMarker: makeMarkerReader({
          1: { verdict: "PASS", openBugs: 0 },
          2: { verdict: "PASS", openBugs: 0 },
          3: { verdict: "PASS", openBugs: 0 },
        }),
      });
      // Call matches directly to inspect the idempotency key
      const events = await (await import("@/lib/event-log")).readEvents(repo);
      const matches = await rule.matches(events, new Date());
      const noProgressMatch = matches.find((m) =>
        m.idempotencyKey.includes("::no-progress::"),
      );
      expect(noProgressMatch).toBeDefined();
      expect(noProgressMatch!.idempotencyKey).toBe(
        "repeated-qa-round::factory-core-e1::no-progress::round-3",
      );
    });

    // Additional: no readQaRoundMarker provided → Branch 2 is inactive
    test("no readQaRoundMarker provided → Branch 2 is inactive (backward compat)", async () => {
      const repo = await makeRepo();
      await seedEvent(repo, "factory-core-e1");
      const rec = new Reconciler({ repoPath: repo });
      rec.registerRule(
        buildRepeatedQaRoundRule({
          readEpicSnapshot: async () =>
            snap({ highestQaRound: 3, openBugCount: 0 }),
          // NO readQaRoundMarker — Branch 2 should not activate
        }),
      );
      await rec.tick();
      expect(addLabelsMock).not.toHaveBeenCalled();
    });

    // Additional: missing marker for one round → does not fire
    test("missing marker for one of K rounds → does NOT fire", async () => {
      const repo = await makeRepo();
      await seedEvent(repo, "factory-core-e1");
      const rec = new Reconciler({ repoPath: repo });
      rec.registerRule(
        buildRepeatedQaRoundRule({
          readEpicSnapshot: async () =>
            snap({ highestQaRound: 3, openBugCount: 0 }),
          readQaRoundMarker: makeMarkerReader({
            1: { verdict: "PASS", openBugs: 0 },
            // round 2 marker missing
            3: { verdict: "PASS", openBugs: 0 },
          }),
        }),
      );
      await rec.tick();
      expect(addLabelsMock).not.toHaveBeenCalled();
    });

    // Additional: custom noProgressThreshold respected
    test("custom noProgressThreshold=2 fires at round 2", async () => {
      const repo = await makeRepo();
      await seedEvent(repo, "factory-core-e1");
      const rec = new Reconciler({ repoPath: repo });
      rec.registerRule(
        buildRepeatedQaRoundRule({
          noProgressThreshold: 2,
          readEpicSnapshot: async () =>
            snap({ highestQaRound: 2, openBugCount: 0 }),
          readQaRoundMarker: makeMarkerReader({
            1: { verdict: "PASS", openBugs: 0 },
            2: { verdict: "PASS", openBugs: 0 },
          }),
        }),
      );
      await rec.tick();
      expect(addLabelsMock).toHaveBeenCalledWith("factory-core-e1", [
        "review:needs-human",
      ]);
    });

    // Additional: both branches can fire independently for the same epic
    test("both branches fire independently when their conditions are met", async () => {
      const repo = await makeRepo();
      await seedEvent(repo, "factory-core-e1");
      const rec = new Reconciler({ repoPath: repo });
      // Epic at round 5 with 3 open bugs → Branch 1 fires.
      // Rounds 3/4/5 all PASS with openBugs=3 → Branch 2 also fires.
      rec.registerRule(
        buildRepeatedQaRoundRule({
          readEpicSnapshot: async () =>
            snap({ highestQaRound: 5, openBugCount: 3 }),
          readQaRoundMarker: makeMarkerReader({
            3: { verdict: "PASS", openBugs: 3 },
            4: { verdict: "PASS", openBugs: 3 },
            5: { verdict: "PASS", openBugs: 3 },
          }),
        }),
      );
      await rec.tick();
      // Both branches should have fired → 2 addLabels calls
      expect(addLabelsMock).toHaveBeenCalledTimes(2);
    });

    // Additional: hasNeedsHuman=true suppresses new branch too
    test("hasNeedsHuman=true suppresses new branch", async () => {
      const repo = await makeRepo();
      await seedEvent(repo, "factory-core-e1");
      const rec = new Reconciler({ repoPath: repo });
      rec.registerRule(
        buildRepeatedQaRoundRule({
          readEpicSnapshot: async () =>
            snap({ highestQaRound: 3, openBugCount: 0, hasNeedsHuman: true }),
          readQaRoundMarker: makeMarkerReader({
            1: { verdict: "PASS", openBugs: 0 },
            2: { verdict: "PASS", openBugs: 0 },
            3: { verdict: "PASS", openBugs: 0 },
          }),
        }),
      );
      await rec.tick();
      expect(addLabelsMock).not.toHaveBeenCalled();
    });
  });
});
