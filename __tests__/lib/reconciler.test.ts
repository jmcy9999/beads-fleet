// =============================================================================
// Tests for src/lib/reconciler.ts (factory-core-lfcf.2)
// =============================================================================
// Scaffold tests — exercise the loop mechanics (tick, idempotency, rule
// isolation, failure handling) using synthetic rules. The first real rule
// arrives in lfcf.4 and has its own integration tests.
// =============================================================================

import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";

import {
  Reconciler,
  type ReconcilerRule,
  type ReconcilerMatch,
} from "@/lib/reconciler";
import { appendEvent, readEvents } from "@/lib/event-log";

async function makeRepo(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "reconciler-test-"));
}

/** Test rule that returns a fixed set of matches and records act calls. */
function makeRule(
  name: string,
  matches: ReconcilerMatch[],
): ReconcilerRule & { actedKeys: string[] } {
  const actedKeys: string[] = [];
  return {
    name,
    matches: async () => matches,
    act: async (match) => {
      actedKeys.push(match.idempotencyKey);
    },
    actedKeys,
  } as ReconcilerRule & { actedKeys: string[] };
}

describe("Reconciler", () => {
  test("registerRule rejects duplicate names", () => {
    const rec = new Reconciler({ repoPath: "/tmp" });
    rec.registerRule({
      name: "dup",
      matches: async () => [],
      act: async () => {},
    });
    expect(() =>
      rec.registerRule({
        name: "dup",
        matches: async () => [],
        act: async () => {},
      }),
    ).toThrow(/already registered/);
  });

  test("tick calls matches() and invokes act() for each match", async () => {
    const repo = await makeRepo();
    const rec = new Reconciler({ repoPath: repo });
    const rule = makeRule("test-rule", [
      { idempotencyKey: "k1", epicId: "e1" },
      { idempotencyKey: "k2", epicId: "e2" },
    ]);
    rec.registerRule(rule);
    await rec.tick();
    expect(rule.actedKeys).toEqual(["k1", "k2"]);
  });

  test("idempotency short-circuits when prior action-taken event exists", async () => {
    const repo = await makeRepo();
    // Pre-populate the event log with a prior action-taken event matching
    // the match's idempotencyKey + rule name.
    await appendEvent(repo, {
      type: "reconciler-action-taken",
      epicId: "e1",
      payload: { ruleName: "test-rule", idempotencyKey: "k1" },
    });
    const rec = new Reconciler({ repoPath: repo });
    const rule = makeRule("test-rule", [
      { idempotencyKey: "k1", epicId: "e1" },
      { idempotencyKey: "k2", epicId: "e2" },
    ]);
    rec.registerRule(rule);
    await rec.tick();
    // k1 is idempotency-blocked; only k2 fires.
    expect(rule.actedKeys).toEqual(["k2"]);
  });

  test("successful act emits reconciler-action-taken event", async () => {
    const repo = await makeRepo();
    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule({
      name: "test",
      matches: async () => [{ idempotencyKey: "k1", epicId: "e1" }],
      act: async () => {},
    });
    await rec.tick();
    const events = await readEvents(repo, {
      type: "reconciler-action-taken",
    });
    expect(events).toHaveLength(1);
    expect(events[0].payload).toEqual({
      ruleName: "test",
      idempotencyKey: "k1",
      context: undefined,
    });
  });

  test("act that throws STILL emits action-taken with error payload (idempotency consumed)", async () => {
    // factory-core-zsjv hotfix 2026-04-21: previous behaviour (no
    // action-taken on throw) hammered the same dispatch every tick for
    // the entire idempotency horizon when act() had a permanent failure
    // (e.g. 4xx from action endpoint). Fix: always emit action-taken so
    // the idempotency bucket is consumed. Failures are visible in the
    // payload; transient failures get retried when the bucket rotates.
    const repo = await makeRepo();
    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule({
      name: "throwing",
      matches: async () => [{ idempotencyKey: "k1", epicId: "e1" }],
      act: async () => {
        throw new Error("boom");
      },
    });
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    await rec.tick();
    errSpy.mockRestore();
    const events = await readEvents(repo, {
      type: "reconciler-action-taken",
    });
    expect(events).toHaveLength(1);
    const payload = events[0].payload as {
      success?: boolean;
      error?: string;
    };
    expect(payload.success).toBe(false);
    expect(payload.error).toMatch(/boom/);
  });

  test("rule-matches throwing does NOT kill other rules in the same tick", async () => {
    const repo = await makeRepo();
    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule({
      name: "broken",
      matches: async () => {
        throw new Error("broken matcher");
      },
      act: async () => {},
    });
    const healthy = makeRule("healthy", [
      { idempotencyKey: "k1", epicId: "e1" },
    ]);
    rec.registerRule(healthy);
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    await rec.tick();
    errSpy.mockRestore();
    expect(healthy.actedKeys).toEqual(["k1"]);
  });

  test("getStatus reflects lastTickAt + rule stats", async () => {
    const repo = await makeRepo();
    const rec = new Reconciler({ repoPath: repo });
    const rule = makeRule("test", [{ idempotencyKey: "k1", epicId: "e1" }]);
    rec.registerRule(rule);
    const before = rec.getStatus();
    expect(before.lastTickAt).toBeUndefined();
    expect(before.rulesRegistered).toHaveLength(1);
    expect(before.rulesRegistered[0].totalActionsDispatched).toBe(0);

    await rec.tick();
    const after = rec.getStatus();
    expect(after.lastTickAt).toBeDefined();
    expect(after.rulesRegistered[0].totalActionsDispatched).toBe(1);
    expect(after.recentActions).toHaveLength(1);
    expect(after.recentActions[0].ruleName).toBe("test");
  });

  test("start/stop lifecycle toggles running state", async () => {
    const repo = await makeRepo();
    const rec = new Reconciler({ repoPath: repo, tickIntervalMs: 100_000 });
    expect(rec.getStatus().running).toBe(false);
    rec.start();
    expect(rec.getStatus().running).toBe(true);
    rec.stop();
    expect(rec.getStatus().running).toBe(false);
  });

  test("start is idempotent — calling twice does not double-fire intervals", async () => {
    const repo = await makeRepo();
    const rec = new Reconciler({ repoPath: repo, tickIntervalMs: 100_000 });
    rec.start();
    rec.start(); // should no-op
    expect(rec.getStatus().running).toBe(true);
    rec.stop();
  });

  test("idempotency horizon: ancient action-taken does NOT block current match", async () => {
    const repo = await makeRepo();
    // Pre-populate an action-taken event from 2 hours ago (beyond 1h horizon).
    const ancient = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    await appendEvent(repo, {
      type: "reconciler-action-taken",
      epicId: "e1",
      timestamp: ancient,
      payload: { ruleName: "test-rule", idempotencyKey: "k1" },
    });
    const rec = new Reconciler({
      repoPath: repo,
      lookbackMs: 10 * 60 * 60_000, // wide enough to include the ancient event
      idempotencyHorizonMs: 60 * 60 * 1000, // 1h horizon
    });
    const rule = makeRule("test-rule", [
      { idempotencyKey: "k1", epicId: "e1" },
    ]);
    rec.registerRule(rule);
    await rec.tick();
    // Ancient event is outside the horizon, so the rule fires.
    expect(rule.actedKeys).toEqual(["k1"]);
  });
});
