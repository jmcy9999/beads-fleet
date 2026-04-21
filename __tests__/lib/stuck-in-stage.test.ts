// =============================================================================
// Tests for src/lib/reconciler-rules/stuck-in-stage.ts (factory-core-zsjv.1)
// =============================================================================

import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";

import { Reconciler } from "@/lib/reconciler";
import { appendEvent, readEvents } from "@/lib/event-log";
import {
  buildStuckInStageRule,
  STAGE_RESUME_ACTIONS,
  type EpicSnapshot,
} from "@/lib/reconciler-rules/stuck-in-stage";

async function makeRepo(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "zsjv1-test-"));
}

function snap(partial: Partial<EpicSnapshot>): EpicSnapshot {
  return {
    currentStage: "qa",
    hasAgentRunning: false,
    labels: ["pipeline:qa", "ship-type:ios-app"],
    title: "test-epic",
    currentWave: 2,
    ...partial,
  };
}

describe("stuck-in-stage rule", () => {
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

  test("stage mapping covers all documented stages", () => {
    const expected = [
      "research",
      "research-complete",
      "product-spec",
      "architecture",
      "plan-review",
      "test-spec",
      "development",
      "build-review",
      "smoke-test",
      "qa",
      "ux-polish",
    ];
    for (const stage of expected) {
      expect(STAGE_RESUME_ACTIONS[stage]).toBeDefined();
      expect(STAGE_RESUME_ACTIONS[stage].action).toBeDefined();
    }
  });

  test("submission-prep and terminal stages are intentionally omitted", () => {
    expect(STAGE_RESUME_ACTIONS["submission-prep"]).toBeUndefined();
    expect(STAGE_RESUME_ACTIONS["live"]).toBeUndefined();
    expect(STAGE_RESUME_ACTIONS["completed"]).toBeUndefined();
  });

  test("stuck epic at qa (16 min old) dispatches send-for-qa", async () => {
    const repo = await makeRepo();
    const now = new Date("2026-04-21T10:00:00.000Z");
    const sixteenMinAgo = new Date(
      now.getTime() - 16 * 60_000,
    ).toISOString();
    await appendEvent(repo, {
      type: "agent-exited",
      epicId: "factory-core-e1",
      stage: "qa",
      timestamp: sixteenMinAgo,
      payload: { exitCode: 0 },
    });

    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildStuckInStageRule({
        readEpicSnapshot: async () => snap({ currentStage: "qa" }),
      }),
    );
    await rec.tick(now);

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].body).toMatchObject({
      action: "send-for-qa",
      epicId: "factory-core-e1",
    });
  });

  test("stuck epic at development dispatches start-wave with waveNumber", async () => {
    const repo = await makeRepo();
    const now = new Date("2026-04-21T10:00:00.000Z");
    await appendEvent(repo, {
      type: "agent-exited",
      epicId: "factory-core-e1",
      stage: "development",
      timestamp: new Date(now.getTime() - 16 * 60_000).toISOString(),
      payload: { exitCode: 0 },
    });

    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildStuckInStageRule({
        readEpicSnapshot: async () =>
          snap({ currentStage: "development", currentWave: 3 }),
      }),
    );
    await rec.tick(now);

    expect(fetchCalls[0].body).toMatchObject({
      action: "start-wave",
      waveNumber: 3,
    });
  });

  test("agent:running label blocks recovery", async () => {
    const repo = await makeRepo();
    const now = new Date("2026-04-21T10:00:00.000Z");
    await appendEvent(repo, {
      type: "agent-exited",
      epicId: "factory-core-e1",
      stage: "qa",
      timestamp: new Date(now.getTime() - 16 * 60_000).toISOString(),
      payload: { exitCode: 0 },
    });

    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildStuckInStageRule({
        readEpicSnapshot: async () => snap({ hasAgentRunning: true }),
      }),
    );
    await rec.tick(now);

    expect(fetchCalls).toHaveLength(0);
  });

  test("recent events (under staleness window) do not trigger", async () => {
    const repo = await makeRepo();
    const now = new Date("2026-04-21T10:00:00.000Z");
    await appendEvent(repo, {
      type: "agent-exited",
      epicId: "factory-core-e1",
      stage: "qa",
      timestamp: new Date(now.getTime() - 5 * 60_000).toISOString(), // 5 min ago
      payload: { exitCode: 0 },
    });

    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildStuckInStageRule({
        readEpicSnapshot: async () => snap({}),
      }),
    );
    await rec.tick(now);

    expect(fetchCalls).toHaveLength(0);
  });

  test("reconciler-action-taken events are excluded from freshness check", async () => {
    // If we counted reconciler-action-taken as 'recent activity', our own
    // recovery would permanently mask the stall. Test: a fresh
    // reconciler-action-taken must NOT reset the staleness clock.
    const repo = await makeRepo();
    const now = new Date("2026-04-21T10:00:00.000Z");
    await appendEvent(repo, {
      type: "agent-exited",
      epicId: "factory-core-e1",
      stage: "qa",
      timestamp: new Date(now.getTime() - 20 * 60_000).toISOString(),
      payload: { exitCode: 0 },
    });
    // Recent action-taken (should NOT count as epic activity)
    await appendEvent(repo, {
      type: "reconciler-action-taken",
      epicId: "factory-core-e1",
      timestamp: new Date(now.getTime() - 2 * 60_000).toISOString(),
      payload: { ruleName: "some-other-rule", idempotencyKey: "x" },
    });

    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildStuckInStageRule({
        readEpicSnapshot: async () => snap({}),
      }),
    );
    await rec.tick(now);

    // The stall is 20min old; action-taken doesn't reset the clock —
    // still triggers recovery.
    expect(fetchCalls).toHaveLength(1);
  });

  test("stage with no canned resume action is skipped", async () => {
    const repo = await makeRepo();
    const now = new Date("2026-04-21T10:00:00.000Z");
    await appendEvent(repo, {
      type: "agent-exited",
      epicId: "factory-core-e1",
      stage: "qa",
      timestamp: new Date(now.getTime() - 16 * 60_000).toISOString(),
      payload: { exitCode: 0 },
    });

    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildStuckInStageRule({
        readEpicSnapshot: async () =>
          snap({ currentStage: "submission-prep" }),
      }),
    );
    await rec.tick(now);

    expect(fetchCalls).toHaveLength(0);
  });

  test("null snapshot (bd failure) skips the epic without error", async () => {
    const repo = await makeRepo();
    const now = new Date("2026-04-21T10:00:00.000Z");
    await appendEvent(repo, {
      type: "agent-exited",
      epicId: "factory-core-e1",
      stage: "qa",
      timestamp: new Date(now.getTime() - 16 * 60_000).toISOString(),
      payload: { exitCode: 0 },
    });

    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildStuckInStageRule({
        readEpicSnapshot: async () => null,
      }),
    );
    await rec.tick(now);

    expect(fetchCalls).toHaveLength(0);
  });

  test("idempotency: same 15-min bucket does not re-fire", async () => {
    const repo = await makeRepo();
    const now = new Date("2026-04-21T10:00:00.000Z");
    await appendEvent(repo, {
      type: "agent-exited",
      epicId: "factory-core-e1",
      stage: "qa",
      timestamp: new Date(now.getTime() - 16 * 60_000).toISOString(),
      payload: { exitCode: 0 },
    });

    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildStuckInStageRule({
        readEpicSnapshot: async () => snap({}),
      }),
    );
    await rec.tick(now);
    await rec.tick(new Date(now.getTime() + 5_000)); // 5s later, same bucket

    expect(fetchCalls).toHaveLength(1);
  });

  test("agent starts running between match and act: abort cleanly", async () => {
    const repo = await makeRepo();
    const now = new Date("2026-04-21T10:00:00.000Z");
    await appendEvent(repo, {
      type: "agent-exited",
      epicId: "factory-core-e1",
      stage: "qa",
      timestamp: new Date(now.getTime() - 16 * 60_000).toISOString(),
      payload: { exitCode: 0 },
    });

    const rec = new Reconciler({ repoPath: repo });
    let callCount = 0;
    rec.registerRule(
      buildStuckInStageRule({
        readEpicSnapshot: async () => {
          callCount += 1;
          // First call (from matches) sees no agent; second (from act) sees one.
          return snap({ hasAgentRunning: callCount > 1 });
        },
      }),
    );
    await rec.tick(now);

    // Act aborted — no dispatch
    expect(fetchCalls).toHaveLength(0);
    // But action-taken event WAS emitted (idempotency bucket consumed)
    const events = await readEvents(repo, {
      type: "reconciler-action-taken",
    });
    expect(events).toHaveLength(1);
  });
});
