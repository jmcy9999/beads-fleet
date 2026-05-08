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

  test("factory-core-3akh.1: concurrency cap defers excess dispatches without consuming idempotency", async () => {
    const repo = await makeRepo();
    const rec = new Reconciler({ repoPath: repo, maxConcurrentDispatches: 2 });
    const acted: string[] = [];
    rec.registerRule({
      name: "gen",
      matches: async () => [
        { idempotencyKey: "k1", epicId: "e1" },
        { idempotencyKey: "k2", epicId: "e2" },
        { idempotencyKey: "k3", epicId: "e3" },
        { idempotencyKey: "k4", epicId: "e4" },
      ],
      act: async (m) => {
        acted.push(m.idempotencyKey);
      },
    });
    await rec.tick();
    // Cap = 2 → only first two fire this tick
    expect(acted).toEqual(["k1", "k2"]);
    // Verify action-taken was only emitted for the two that fired,
    // NOT for the deferred k3 and k4 (idempotency bucket intact).
    const taken = await readEvents(repo, { type: "reconciler-action-taken" });
    const keys = taken.map(
      (e) => (e.payload as { idempotencyKey?: string }).idempotencyKey,
    );
    expect(keys.sort()).toEqual(["k1", "k2"]);
  });

  test("factory-core-3akh.1: deferred matches fire on next tick", async () => {
    const repo = await makeRepo();
    const rec = new Reconciler({ repoPath: repo, maxConcurrentDispatches: 2 });
    const acted: string[] = [];
    rec.registerRule({
      name: "gen",
      matches: async () => {
        const remaining = ["k1", "k2", "k3", "k4"].filter(
          (k) => !acted.includes(k),
        );
        return remaining.map((k) => ({ idempotencyKey: k, epicId: k }));
      },
      act: async (m) => {
        acted.push(m.idempotencyKey);
      },
    });
    await rec.tick();
    expect(acted).toEqual(["k1", "k2"]);
    await rec.tick();
    expect(acted).toEqual(["k1", "k2", "k3", "k4"]);
  });

  test("factory-core-3akh.2: minTickIntervalMs throttles rule execution", async () => {
    const repo = await makeRepo();
    const rec = new Reconciler({ repoPath: repo });
    let matchCalls = 0;
    rec.registerRule({
      name: "throttled",
      minTickIntervalMs: 30_000,
      matches: async () => {
        matchCalls += 1;
        return [];
      },
      act: async () => {},
    });
    const t0 = new Date("2026-04-21T10:00:00.000Z");
    const t1 = new Date("2026-04-21T10:00:10.000Z"); // +10s — throttled
    const t2 = new Date("2026-04-21T10:00:20.000Z"); // +20s — throttled
    const t3 = new Date("2026-04-21T10:00:30.000Z"); // +30s — runs again
    await rec.tick(t0);
    await rec.tick(t1);
    await rec.tick(t2);
    await rec.tick(t3);
    expect(matchCalls).toBe(2); // t0 + t3
  });

  test("factory-core-3akh.2: rule without minTickIntervalMs runs every tick", async () => {
    const repo = await makeRepo();
    const rec = new Reconciler({ repoPath: repo });
    let matchCalls = 0;
    rec.registerRule({
      name: "unthrottled",
      // no minTickIntervalMs — default behaviour
      matches: async () => {
        matchCalls += 1;
        return [];
      },
      act: async () => {},
    });
    await rec.tick();
    await rec.tick();
    await rec.tick();
    expect(matchCalls).toBe(3);
  });

  // ---------------------------------------------------------------------
  // beads_web-3e6 (2026-05-08): refusal-aware idempotency.
  //
  // When act() returns { refused: true, refusalCode }, the reconciler
  // does NOT emit a `reconciler-action-taken` event so the idempotency
  // bucket stays open and the rule re-fires next tick. This closes the
  // cascade where a first-attempt refusal (e.g. start-wave called BEFORE
  // auto-approve-internal-plans flipped plan:pending → plan:approved)
  // would block all subsequent attempts even after the refusal-reason
  // was gone. Empirical reproducer: factory-core-r4im (C2 attempt-6
  // T2) at 19:49-20:00 BST 2026-05-08.
  //
  // Compare against the "act that throws" test above: throws STILL emit
  // action-taken (zsjv hotfix invariant — permanent failures consume
  // the bucket so we don't infinite-retry on bad params / 4xx). Only
  // EXPLICIT refusal sentinels skip the action-taken event.
  // ---------------------------------------------------------------------

  test("3e6: refused act() does NOT emit action-taken (idempotency bucket NOT consumed)", async () => {
    const repo = await makeRepo();
    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule({
      name: "refusing-rule",
      matches: async () => [{ idempotencyKey: "k1", epicId: "e1" }],
      act: async () => ({ refused: true, refusalCode: "PLAN_PENDING" }),
    });
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    await rec.tick();
    logSpy.mockRestore();
    const events = await readEvents(repo, {
      type: "reconciler-action-taken",
    });
    expect(events).toHaveLength(0);
  });

  test("3e6: refused match re-fires on next tick (idempotency bucket open)", async () => {
    const repo = await makeRepo();
    const rec = new Reconciler({ repoPath: repo });
    let attempt = 0;
    const actCalls: string[] = [];
    rec.registerRule({
      name: "conditional-refuser",
      matches: async () => [{ idempotencyKey: "k1", epicId: "e1" }],
      act: async (m) => {
        actCalls.push(m.idempotencyKey);
        attempt += 1;
        // Tick 1: refuse (plan-pending). Tick 2: succeed.
        if (attempt === 1) {
          return { refused: true, refusalCode: "PLAN_PENDING" };
        }
        // Tick 2: void = success path
      },
    });
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    await rec.tick(); // tick 1: refused → bucket open
    await rec.tick(); // tick 2: succeeds → bucket consumed
    await rec.tick(); // tick 3: dedup blocks → no new attempt
    logSpy.mockRestore();
    expect(actCalls).toEqual(["k1", "k1"]); // tick 1 + tick 2; tick 3 is dedup-blocked
    const taken = await readEvents(repo, { type: "reconciler-action-taken" });
    expect(taken).toHaveLength(1); // only tick 2 emitted
  });

  test("3e6: refusal does NOT count toward totalActionsDispatched / actionsDispatchedLastTick", async () => {
    const repo = await makeRepo();
    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule({
      name: "refusing-rule",
      matches: async () => [{ idempotencyKey: "k1", epicId: "e1" }],
      act: async () => ({ refused: true, refusalCode: "AGENT_RUNNING_NO_SESSION" }),
    });
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    await rec.tick();
    logSpy.mockRestore();
    const status = rec.getStatus();
    expect(status.actionsDispatchedLastTick).toBe(0);
    expect(status.rulesRegistered[0].totalActionsDispatched).toBe(0);
    // recentActions should NOT include the refused match
    expect(status.recentActions).toHaveLength(0);
  });

  test("3e6: refusal does NOT pollute action-taken events recorded by other rules in the same tick", async () => {
    const repo = await makeRepo();
    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule({
      name: "refuser",
      matches: async () => [{ idempotencyKey: "kr", epicId: "er" }],
      act: async () => ({ refused: true, refusalCode: "REVIEW_NEEDS_HUMAN" }),
    });
    rec.registerRule({
      name: "succeeder",
      matches: async () => [{ idempotencyKey: "ks", epicId: "es" }],
      act: async () => {},
    });
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    await rec.tick();
    logSpy.mockRestore();
    const taken = await readEvents(repo, { type: "reconciler-action-taken" });
    expect(taken).toHaveLength(1);
    expect((taken[0].payload as { ruleName?: string }).ruleName).toBe(
      "succeeder",
    );
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
