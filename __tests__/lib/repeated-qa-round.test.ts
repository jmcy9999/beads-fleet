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
});
