// =============================================================================
// Tests for src/lib/reconciler-rules/wave-bead-mismatch.ts (factory-core-zsjv.2)
// =============================================================================

import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";

import { Reconciler } from "@/lib/reconciler";
import { appendEvent } from "@/lib/event-log";
import {
  buildWaveBeadMismatchRule,
  type EpicSnapshot,
} from "@/lib/reconciler-rules/wave-bead-mismatch";

jest.mock("@/lib/pipeline-labels", () => ({
  addLabelsToEpic: jest.fn().mockResolvedValue(undefined),
  removeLabelsFromEpic: jest.fn().mockResolvedValue(undefined),
}));

async function makeRepo(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "zsjv2-test-"));
}

function snap(partial: Partial<EpicSnapshot>): EpicSnapshot {
  return {
    currentStage: "qa",
    lowestOpenWave: 2,
    allWavesComplete: false,
    hasWaves: true,
    labels: ["pipeline:qa", "ship-type:ios-app"],
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

describe("wave-bead-mismatch rule", () => {
  let fetchMock: jest.SpyInstance;
  let fetchCalls: Array<{ url: string; body: unknown }>;

  beforeEach(() => {
    fetchCalls = [];
    fetchMock = jest
      .spyOn(global, "fetch")
      .mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
        const body =
          init?.body && typeof init.body === "string"
            ? JSON.parse(init.body)
            : undefined;
        fetchCalls.push({ url: String(url), body });
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  test("pipeline:qa with open wave:2 → roll back + dispatch start-wave 2", async () => {
    const repo = await makeRepo();
    await seedEvent(repo, "factory-core-e1");
    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildWaveBeadMismatchRule({
        readEpicSnapshot: async () =>
          snap({ currentStage: "qa", lowestOpenWave: 2 }),
      }),
    );
    await rec.tick();

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].body).toMatchObject({
      action: "start-wave",
      epicId: "factory-core-e1",
      waveNumber: 2,
    });
  });

  test("post-development stages: ux-polish, submission-prep, submitted, deploying all trigger", async () => {
    const stages = [
      "ux-polish",
      "submission-prep",
      "submitted",
      "awaiting-review",
      "in-review",
      "package",
      "deploying",
    ];
    for (const stage of stages) {
      const repo = await makeRepo();
      await seedEvent(repo, "factory-core-e1");
      const rec = new Reconciler({ repoPath: repo });
      rec.registerRule(
        buildWaveBeadMismatchRule({
          readEpicSnapshot: async () =>
            snap({ currentStage: stage, lowestOpenWave: 3 }),
        }),
      );
      fetchCalls.length = 0;
      await rec.tick();
      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0].body).toMatchObject({
        action: "start-wave",
        waveNumber: 3,
      });
    }
  });

  test("pipeline:development or pipeline:build-review does NOT trigger", async () => {
    for (const stage of ["development", "build-review"]) {
      const repo = await makeRepo();
      await seedEvent(repo, "factory-core-e1");
      const rec = new Reconciler({ repoPath: repo });
      rec.registerRule(
        buildWaveBeadMismatchRule({
          readEpicSnapshot: async () =>
            snap({ currentStage: stage, lowestOpenWave: 2 }),
        }),
      );
      fetchCalls.length = 0;
      await rec.tick();
      expect(fetchCalls).toHaveLength(0);
    }
  });

  test("allWavesComplete=true does NOT trigger (invariant satisfied)", async () => {
    const repo = await makeRepo();
    await seedEvent(repo, "factory-core-e1");
    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildWaveBeadMismatchRule({
        readEpicSnapshot: async () =>
          snap({
            currentStage: "qa",
            allWavesComplete: true,
            lowestOpenWave: undefined,
          }),
      }),
    );
    await rec.tick();
    expect(fetchCalls).toHaveLength(0);
  });

  test("hasWaves=false (legacy) does NOT trigger", async () => {
    const repo = await makeRepo();
    await seedEvent(repo, "factory-core-e1");
    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildWaveBeadMismatchRule({
        readEpicSnapshot: async () =>
          snap({ currentStage: "qa", hasWaves: false }),
      }),
    );
    await rec.tick();
    expect(fetchCalls).toHaveLength(0);
  });

  test("waveStatusError fail-safe skips (does NOT advance)", async () => {
    const repo = await makeRepo();
    await seedEvent(repo, "factory-core-e1");
    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildWaveBeadMismatchRule({
        readEpicSnapshot: async () =>
          snap({
            currentStage: "qa",
            waveStatusError: "bd failed",
          }),
      }),
    );
    await rec.tick();
    expect(fetchCalls).toHaveLength(0);
  });

  test("null snapshot (bd failure) skips", async () => {
    const repo = await makeRepo();
    await seedEvent(repo, "factory-core-e1");
    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildWaveBeadMismatchRule({
        readEpicSnapshot: async () => null,
      }),
    );
    await rec.tick();
    expect(fetchCalls).toHaveLength(0);
  });

  test("idempotency: same (epic, stage, wave) does not re-fire", async () => {
    const repo = await makeRepo();
    await seedEvent(repo, "factory-core-e1");
    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildWaveBeadMismatchRule({
        readEpicSnapshot: async () =>
          snap({ currentStage: "qa", lowestOpenWave: 2 }),
      }),
    );
    await rec.tick();
    await rec.tick();
    expect(fetchCalls).toHaveLength(1);
  });
});
