// =============================================================================
// Tests for src/lib/reconciler-rules/liveness-check.ts (factory-core-vy74.1)
// =============================================================================

import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";

import { Reconciler } from "@/lib/reconciler";
import { appendEvent, readEvents } from "@/lib/event-log";
import {
  buildLivenessCheckRule,
  type EpicSnapshot,
} from "@/lib/reconciler-rules/liveness-check";

async function makeRepo(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "vy74-test-"));
}

function snap(partial: Partial<EpicSnapshot>): EpicSnapshot {
  return {
    hasAgentRunning: true,
    tmuxSessionAlive: false,
    currentStage: "ux-polish",
    ...partial,
  };
}

async function seedAgentExitedEvent(
  repo: string,
  epicId: string,
): Promise<void> {
  await appendEvent(repo, {
    type: "agent-exited",
    epicId,
    payload: { exitCode: 0 },
  });
}

describe("liveness-check rule", () => {
  let clearCalls: string[];
  let syntheticCalls: Array<{ epicId: string; reason: string }>;

  beforeEach(() => {
    clearCalls = [];
    syntheticCalls = [];
  });

  function buildRule(snapshotFn: () => Promise<EpicSnapshot | null>) {
    return buildLivenessCheckRule({
      readEpicSnapshot: snapshotFn,
      clearAgentRunning: async (epicId) => {
        clearCalls.push(epicId);
      },
      appendSyntheticExit: async (e) => {
        syntheticCalls.push({ epicId: e.epicId, reason: e.reason });
      },
    });
  }

  test("agent:running + tmux dead → clears label + emits synthetic exit", async () => {
    const repo = await makeRepo();
    await seedAgentExitedEvent(repo, "factory-core-e1");
    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildRule(async () =>
        snap({ hasAgentRunning: true, tmuxSessionAlive: false }),
      ),
    );
    await rec.tick();

    expect(clearCalls).toEqual(["factory-core-e1"]);
    expect(syntheticCalls).toEqual([
      {
        epicId: "factory-core-e1",
        reason: "liveness-check-cleared-stale-label",
      },
    ]);
  });

  test("tmux alive → no-op (never clears label for a live agent)", async () => {
    const repo = await makeRepo();
    await seedAgentExitedEvent(repo, "factory-core-e1");
    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildRule(async () =>
        snap({ hasAgentRunning: true, tmuxSessionAlive: true }),
      ),
    );
    await rec.tick();

    expect(clearCalls).toEqual([]);
    expect(syntheticCalls).toEqual([]);
  });

  test("no agent:running label → no-op (nothing to clear)", async () => {
    const repo = await makeRepo();
    await seedAgentExitedEvent(repo, "factory-core-e1");
    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildRule(async () =>
        snap({ hasAgentRunning: false, tmuxSessionAlive: false }),
      ),
    );
    await rec.tick();

    expect(clearCalls).toEqual([]);
  });

  test("null snapshot (bd failure) → skips cleanly", async () => {
    const repo = await makeRepo();
    await seedAgentExitedEvent(repo, "factory-core-e1");
    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(buildRule(async () => null));
    await rec.tick();

    expect(clearCalls).toEqual([]);
  });

  test("idempotency: same bucket doesn't re-clear", async () => {
    const repo = await makeRepo();
    await seedAgentExitedEvent(repo, "factory-core-e1");
    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildRule(async () =>
        snap({ hasAgentRunning: true, tmuxSessionAlive: false }),
      ),
    );
    await rec.tick();
    await rec.tick(); // same 15-min bucket
    expect(clearCalls).toHaveLength(1);
  });

  test("emits synthetic agent-exited event to the event log", async () => {
    // Verify the synthetic exit event is actually written to the log via
    // a real appendSyntheticExit binding (not a stub).
    const repo = await makeRepo();
    await seedAgentExitedEvent(repo, "factory-core-e1");
    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildLivenessCheckRule({
        readEpicSnapshot: async () =>
          snap({ hasAgentRunning: true, tmuxSessionAlive: false }),
        clearAgentRunning: async () => {},
        appendSyntheticExit: async (e) => {
          await appendEvent(repo, {
            type: "agent-exited",
            epicId: e.epicId,
            stage: e.stage ?? undefined,
            correlationId: `liveness-check-${e.epicId}`,
            payload: {
              exitCode: null,
              synthetic: true,
              reason: e.reason,
            },
          });
        },
      }),
    );
    await rec.tick();

    const events = await readEvents(repo, { type: "agent-exited" });
    const synthetic = events.filter(
      (e) =>
        e.correlationId?.startsWith("liveness-check-") &&
        (e.payload as { reason?: string } | undefined)?.reason ===
          "liveness-check-cleared-stale-label",
    );
    expect(synthetic).toHaveLength(1);
    expect(synthetic[0].epicId).toBe("factory-core-e1");
  });

  test("respects custom bucket size for idempotency", async () => {
    const repo = await makeRepo();
    await seedAgentExitedEvent(repo, "factory-core-e1");
    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildLivenessCheckRule({
        bucketMs: 1_000, // 1s buckets
        readEpicSnapshot: async () =>
          snap({ hasAgentRunning: true, tmuxSessionAlive: false }),
        clearAgentRunning: async (epicId) => {
          clearCalls.push(epicId);
        },
        appendSyntheticExit: async () => {},
      }),
    );
    const t0 = new Date("2026-04-21T10:00:00.000Z");
    const t1 = new Date("2026-04-21T10:00:01.500Z");
    await rec.tick(t0);
    await rec.tick(t1); // different 1s bucket → fires again
    expect(clearCalls).toHaveLength(2);
  });
});
