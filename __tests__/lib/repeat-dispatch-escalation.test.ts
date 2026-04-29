// =============================================================================
// Tests for src/lib/reconciler-rules/repeat-dispatch-escalation.ts
// (factory-core-zsjv.6 + factory-core-3p1e.10 active-progress suppression)
// =============================================================================

import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";

import { Reconciler } from "@/lib/reconciler";
import { appendEvent } from "@/lib/event-log";
import {
  buildRepeatDispatchEscalationRule,
  type EpicSnapshot,
} from "@/lib/reconciler-rules/repeat-dispatch-escalation";
import {
  probeActiveDispatch,
  ACTIVE_PROGRESS_WINDOW_MS,
  type ActiveDispatchProbeDeps,
  type ActiveDispatchProbeResult,
} from "@/lib/reconciler-rules/active-dispatch-probe";

async function makeRepo(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "zsjv6-test-"));
}

function snap(partial: Partial<EpicSnapshot>): EpicSnapshot {
  return {
    currentStage: "plan-review",
    labels: ["pipeline:plan-review", "ship-type:internal"],
    title: "test-epic",
    ...partial,
  };
}

/** Seed N fake stuck-in-stage action-taken events for a given epic+stage,
 *  spaced by the given interval (default 20 min so each falls in a
 *  separate 15-min bucket). */
async function seedStuckInStageActions(
  repo: string,
  epicId: string,
  stage: string,
  count: number,
  spacingMs = 20 * 60_000,
  baseNow: number = Date.now(),
): Promise<void> {
  for (let i = 0; i < count; i++) {
    const ts = new Date(baseNow - (count - 1 - i) * spacingMs).toISOString();
    await appendEvent(repo, {
      type: "reconciler-action-taken",
      epicId,
      timestamp: ts,
      payload: {
        ruleName: "stuck-in-stage",
        idempotencyKey: `stuck-in-stage::${epicId}::${stage}::bucket-${i}`,
        context: {
          stage,
          resumeAction: "review-plan",
          lastEventAt: ts,
          ageMs: 1000,
        },
      },
    });
  }
}

describe("repeat-dispatch-escalation rule", () => {
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

  test("3 stuck-in-stage events for same (epic, stage) → dispatches coherence", async () => {
    const repo = await makeRepo();
    const now = new Date();
    await seedStuckInStageActions(
      repo,
      "factory-core-e1",
      "plan-review",
      3,
      20 * 60_000,
      now.getTime(),
    );
    // Reconciler lookback defaults to 60 min — the events (40m, 20m, now) are visible.
    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildRepeatDispatchEscalationRule({
        readEpicSnapshot: async () =>
          snap({ currentStage: "plan-review" }),
      }),
    );
    await rec.tick(now);

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].body).toMatchObject({
      action: "run-coherence-agent",
      epicId: "factory-core-e1",
      anomalyClass: "repeat-dispatch-no-progress",
    });
    // coherenceContext passed through with the count
    const ctx = (fetchCalls[0].body as Record<string, unknown>).coherenceContext;
    expect(ctx).toMatchObject({
      stuckStage: "plan-review",
      attemptCount: 3,
    });
  });

  test("2 stuck-in-stage events (below threshold) → does NOT fire", async () => {
    const repo = await makeRepo();
    const now = new Date();
    await seedStuckInStageActions(
      repo,
      "factory-core-e1",
      "plan-review",
      2,
      20 * 60_000,
      now.getTime(),
    );
    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildRepeatDispatchEscalationRule({
        readEpicSnapshot: async () => snap({ currentStage: "plan-review" }),
      }),
    );
    await rec.tick(now);
    expect(fetchCalls).toHaveLength(0);
  });

  test("epic advanced past the stuck stage → does NOT fire (self-resolved)", async () => {
    const repo = await makeRepo();
    const now = new Date();
    await seedStuckInStageActions(
      repo,
      "factory-core-e1",
      "plan-review",
      3,
      20 * 60_000,
      now.getTime(),
    );
    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildRepeatDispatchEscalationRule({
        // Current stage is different from the stuck stage — epic moved on
        readEpicSnapshot: async () => snap({ currentStage: "test-spec" }),
      }),
    );
    await rec.tick(now);
    expect(fetchCalls).toHaveLength(0);
  });

  test("idempotency: second tick does not re-dispatch coherence for same (epic, stage)", async () => {
    const repo = await makeRepo();
    const now = new Date();
    await seedStuckInStageActions(
      repo,
      "factory-core-e1",
      "plan-review",
      3,
      20 * 60_000,
      now.getTime(),
    );
    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildRepeatDispatchEscalationRule({
        readEpicSnapshot: async () => snap({ currentStage: "plan-review" }),
      }),
    );
    await rec.tick(now);
    await rec.tick(new Date(now.getTime() + 5_000));
    expect(fetchCalls).toHaveLength(1);
  });

  test("groups by (epic, stage) — different stages don't count together", async () => {
    const repo = await makeRepo();
    const now = new Date();
    await seedStuckInStageActions(
      repo,
      "factory-core-e1",
      "plan-review",
      2,
      20 * 60_000,
      now.getTime(),
    );
    await seedStuckInStageActions(
      repo,
      "factory-core-e1",
      "build-review",
      2,
      20 * 60_000,
      now.getTime(),
    );
    // 2 + 2 = 4 total events, but each group is only 2, below threshold 3.
    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildRepeatDispatchEscalationRule({
        readEpicSnapshot: async () => snap({ currentStage: "plan-review" }),
      }),
    );
    await rec.tick(now);
    expect(fetchCalls).toHaveLength(0);
  });

  test("events outside the 1h window are ignored", async () => {
    const repo = await makeRepo();
    const now = new Date();
    // 3 events spaced 35 min apart → oldest is 70 min ago → outside 60m window.
    await seedStuckInStageActions(
      repo,
      "factory-core-e1",
      "plan-review",
      3,
      35 * 60_000,
      now.getTime(),
    );
    const rec = new Reconciler({
      repoPath: repo,
      lookbackMs: 24 * 60 * 60_000, // wide lookback so all events visible
    });
    rec.registerRule(
      buildRepeatDispatchEscalationRule({
        readEpicSnapshot: async () => snap({ currentStage: "plan-review" }),
        // Custom 1h window
        windowMs: 60 * 60_000,
      }),
    );
    await rec.tick(now);
    // Oldest is 60min+ back — outside the rule's window, count drops to 2.
    expect(fetchCalls).toHaveLength(0);
  });

  test("non-stuck-in-stage action-taken events are ignored", async () => {
    const repo = await makeRepo();
    const now = new Date();
    // 3 action-taken events but from a different rule
    for (let i = 0; i < 3; i++) {
      await appendEvent(repo, {
        type: "reconciler-action-taken",
        epicId: "factory-core-e1",
        timestamp: new Date(now.getTime() - i * 20 * 60_000).toISOString(),
        payload: {
          ruleName: "some-other-rule",
          idempotencyKey: `x::${i}`,
          context: { stage: "plan-review" },
        },
      });
    }
    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildRepeatDispatchEscalationRule({
        readEpicSnapshot: async () => snap({ currentStage: "plan-review" }),
      }),
    );
    await rec.tick(now);
    expect(fetchCalls).toHaveLength(0);
  });

  test("null snapshot (bd failure) skips cleanly", async () => {
    const repo = await makeRepo();
    const now = new Date();
    await seedStuckInStageActions(
      repo,
      "factory-core-e1",
      "plan-review",
      3,
      20 * 60_000,
      now.getTime(),
    );
    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildRepeatDispatchEscalationRule({
        readEpicSnapshot: async () => null,
      }),
    );
    await rec.tick(now);
    expect(fetchCalls).toHaveLength(0);
  });

  test("custom threshold respected", async () => {
    const repo = await makeRepo();
    const now = new Date();
    await seedStuckInStageActions(
      repo,
      "factory-core-e1",
      "plan-review",
      2,
      20 * 60_000,
      now.getTime(),
    );
    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildRepeatDispatchEscalationRule({
        readEpicSnapshot: async () => snap({ currentStage: "plan-review" }),
        threshold: 2, // lower threshold
      }),
    );
    await rec.tick(now);
    expect(fetchCalls).toHaveLength(1);
  });

  // --------------------------------------------------------------------------
  // factory-core-3p1e.10 — active-progress suppression
  // --------------------------------------------------------------------------

  test("3p1e.10: active probe (true) suppresses escalation; emits suppressed event", async () => {
    const repo = await makeRepo();
    const now = new Date();
    await seedStuckInStageActions(
      repo,
      "factory-core-e1",
      "plan-review",
      3,
      20 * 60_000,
      now.getTime(),
    );

    const suppressedEvents: Array<Record<string, unknown>> = [];
    const probeCalls: Array<{ epicId: string; stage: string }> = [];

    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildRepeatDispatchEscalationRule({
        readEpicSnapshot: async () => snap({ currentStage: "plan-review" }),
        probeActiveDispatch: async (epicId, stage) => {
          probeCalls.push({ epicId, stage });
          return {
            active: true,
            sessionName: "shipyard-factory-core-e1-plan-review-wave1",
            jsonlMtime: new Date(now.getTime() - 60_000).toISOString(),
            lastActivityAt: new Date(now.getTime() - 5_000).toISOString(),
          };
        },
        appendSuppressedEvent: async (ev) => {
          suppressedEvents.push(ev as unknown as Record<string, unknown>);
        },
      }),
    );

    await rec.tick(now);

    // Probe was consulted exactly once (one (epic, stage) group)
    expect(probeCalls).toEqual([
      { epicId: "factory-core-e1", stage: "plan-review" },
    ]);
    // No coherence dispatch fired
    expect(fetchCalls).toHaveLength(0);
    // Audit event emitted with the canonical fields
    expect(suppressedEvents).toHaveLength(1);
    expect(suppressedEvents[0]).toMatchObject({
      epicId: "factory-core-e1",
      stage: "plan-review",
      attemptCount: 3,
      sessionName: "shipyard-factory-core-e1-plan-review-wave1",
    });
    expect(suppressedEvents[0].jsonlMtime).toBeTruthy();
  });

  test("3p1e.10: active probe (false) lets escalation proceed", async () => {
    const repo = await makeRepo();
    const now = new Date();
    await seedStuckInStageActions(
      repo,
      "factory-core-e1",
      "plan-review",
      3,
      20 * 60_000,
      now.getTime(),
    );

    const suppressedEvents: Array<Record<string, unknown>> = [];
    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildRepeatDispatchEscalationRule({
        readEpicSnapshot: async () => snap({ currentStage: "plan-review" }),
        probeActiveDispatch: async () => ({ active: false }),
        appendSuppressedEvent: async (ev) => {
          suppressedEvents.push(ev as unknown as Record<string, unknown>);
        },
      }),
    );

    await rec.tick(now);

    // Coherence dispatch fires as before
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].body).toMatchObject({
      action: "run-coherence-agent",
      epicId: "factory-core-e1",
      anomalyClass: "repeat-dispatch-no-progress",
    });
    // No suppression event
    expect(suppressedEvents).toHaveLength(0);
  });

  test("3p1e.10: probe throwing degrades to escalate (probe failure cannot mask real escalation)", async () => {
    const repo = await makeRepo();
    const now = new Date();
    await seedStuckInStageActions(
      repo,
      "factory-core-e1",
      "plan-review",
      3,
      20 * 60_000,
      now.getTime(),
    );
    // Silence the warn we expect
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildRepeatDispatchEscalationRule({
        readEpicSnapshot: async () => snap({ currentStage: "plan-review" }),
        probeActiveDispatch: async () => {
          throw new Error("probe boom");
        },
      }),
    );

    await rec.tick(now);
    expect(fetchCalls).toHaveLength(1); // escalation still fired
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("active-dispatch probe threw"),
    );
    warnSpy.mockRestore();
  });

  test("3p1e.10: appendSuppressedEvent throwing does not block suppression itself", async () => {
    const repo = await makeRepo();
    const now = new Date();
    await seedStuckInStageActions(
      repo,
      "factory-core-e1",
      "plan-review",
      3,
      20 * 60_000,
      now.getTime(),
    );
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildRepeatDispatchEscalationRule({
        readEpicSnapshot: async () => snap({ currentStage: "plan-review" }),
        probeActiveDispatch: async () => ({
          active: true,
          sessionName: "shipyard-factory-core-e1-plan-review-wave1",
        }),
        appendSuppressedEvent: async () => {
          throw new Error("append boom");
        },
      }),
    );
    await rec.tick(now);
    // Suppression still occurred — no coherence dispatch
    expect(fetchCalls).toHaveLength(0);
    // Error logged but tick didn't throw
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("appendSuppressedEvent threw"),
    );
    errSpy.mockRestore();
  });

  test("3p1e.10: probe omitted preserves pre-3p1e.10 behaviour (escalate on count)", async () => {
    const repo = await makeRepo();
    const now = new Date();
    await seedStuckInStageActions(
      repo,
      "factory-core-e1",
      "plan-review",
      3,
      20 * 60_000,
      now.getTime(),
    );
    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildRepeatDispatchEscalationRule({
        readEpicSnapshot: async () => snap({ currentStage: "plan-review" }),
        // No probeActiveDispatch
      }),
    );
    await rec.tick(now);
    expect(fetchCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// factory-core-3p1e.10 — active-dispatch probe unit tests
// ---------------------------------------------------------------------------

describe("probeActiveDispatch (factory-core-3p1e.10)", () => {
  function makeDeps(
    overrides: Partial<ActiveDispatchProbeDeps>,
  ): ActiveDispatchProbeDeps {
    return {
      listTmuxSessions: () => [],
      getTmuxSessionActivitySec: () => null,
      findLatestJsonlMtimeMs: () => null,
      now: () => 1_700_000_000_000,
      ...overrides,
    };
  }

  test("no matching tmux session → active=false", () => {
    const result = probeActiveDispatch(
      "factory-core-e1",
      "plan-review",
      makeDeps({
        listTmuxSessions: () => [
          "shipyard-factory-core-OTHER-plan-review-wave1",
          "unrelated-session",
        ],
      }),
    );
    expect(result.active).toBe(false);
    expect(result.sessionName).toBeUndefined();
  });

  test("matching session + JSONL mtime within 5min window → active=true (jsonlMtime path)", () => {
    const nowMs = 1_700_000_000_000;
    const result = probeActiveDispatch(
      "factory-core-e1",
      "plan-review",
      makeDeps({
        listTmuxSessions: () => [
          "shipyard-factory-core-e1-plan-review-wave2",
        ],
        findLatestJsonlMtimeMs: () => nowMs - 60_000, // 1 min ago
        now: () => nowMs,
      }),
    );
    expect(result.active).toBe(true);
    expect(result.sessionName).toBe(
      "shipyard-factory-core-e1-plan-review-wave2",
    );
    expect(result.jsonlMtime).toBe(new Date(nowMs - 60_000).toISOString());
  });

  test("matching session + JSONL mtime older than 5min + tmux activity recent → active=true (tmux path)", () => {
    const nowMs = 1_700_000_000_000;
    const result = probeActiveDispatch(
      "factory-core-e1",
      "plan-review",
      makeDeps({
        listTmuxSessions: () => [
          "shipyard-factory-core-e1-plan-review-wave1",
        ],
        // JSONL is 10 min old — outside window
        findLatestJsonlMtimeMs: () => nowMs - 10 * 60_000,
        // tmux activity is 30s ago — inside window
        getTmuxSessionActivitySec: () => Math.floor((nowMs - 30_000) / 1000),
        now: () => nowMs,
      }),
    );
    expect(result.active).toBe(true);
    expect(result.jsonlMtime).toBeUndefined();
    expect(result.lastActivityAt).toBeTruthy();
  });

  test("matching session + both signals stale → active=false", () => {
    const nowMs = 1_700_000_000_000;
    const result = probeActiveDispatch(
      "factory-core-e1",
      "plan-review",
      makeDeps({
        listTmuxSessions: () => [
          "shipyard-factory-core-e1-plan-review-wave1",
        ],
        findLatestJsonlMtimeMs: () => nowMs - 10 * 60_000,
        getTmuxSessionActivitySec: () => Math.floor((nowMs - 10 * 60_000) / 1000),
        now: () => nowMs,
      }),
    );
    expect(result.active).toBe(false);
    expect(result.sessionName).toBe(
      "shipyard-factory-core-e1-plan-review-wave1",
    );
    expect(result.lastActivityAt).toBeTruthy();
  });

  test("multiple matching sessions: picks the one with most recent activity", () => {
    const nowMs = 1_700_000_000_000;
    const result = probeActiveDispatch(
      "factory-core-e1",
      "plan-review",
      makeDeps({
        listTmuxSessions: () => [
          "shipyard-factory-core-e1-plan-review-wave1",
          "shipyard-factory-core-e1-plan-review-wave2",
          "shipyard-factory-core-e1-plan-review-wave3",
        ],
        getTmuxSessionActivitySec: (name) => {
          if (name.endsWith("wave1")) return Math.floor((nowMs - 10 * 60_000) / 1000);
          if (name.endsWith("wave2")) return Math.floor((nowMs - 30_000) / 1000); // most recent
          if (name.endsWith("wave3")) return Math.floor((nowMs - 5 * 60_000) / 1000);
          return null;
        },
        findLatestJsonlMtimeMs: () => null,
        now: () => nowMs,
      }),
    );
    expect(result.active).toBe(true);
    expect(result.sessionName).toBe(
      "shipyard-factory-core-e1-plan-review-wave2",
    );
  });

  test("session prefix matches stage exactly (does not bleed across stages)", () => {
    const nowMs = 1_700_000_000_000;
    const result = probeActiveDispatch(
      "factory-core-e1",
      "plan-review",
      makeDeps({
        listTmuxSessions: () => [
          // Different stage (development) — must NOT match plan-review probe
          "shipyard-factory-core-e1-development-wave1",
        ],
        getTmuxSessionActivitySec: () => Math.floor((nowMs - 30_000) / 1000),
        findLatestJsonlMtimeMs: () => nowMs - 60_000,
        now: () => nowMs,
      }),
    );
    expect(result.active).toBe(false);
    expect(result.sessionName).toBeUndefined();
  });

  test("epicId matches by exact prefix only (does not match epic-id substrings)", () => {
    const nowMs = 1_700_000_000_000;
    const result = probeActiveDispatch(
      "factory-core-e1",
      "plan-review",
      makeDeps({
        listTmuxSessions: () => [
          // Different epic with similar id (e1 vs e10) — prefix is
          // `shipyard-factory-core-e1-plan-review-` so e10 sessions
          // start with `shipyard-factory-core-e10-` and DON'T match.
          "shipyard-factory-core-e10-plan-review-wave1",
        ],
        getTmuxSessionActivitySec: () => Math.floor((nowMs - 30_000) / 1000),
        findLatestJsonlMtimeMs: () => nowMs - 60_000,
        now: () => nowMs,
      }),
    );
    expect(result.active).toBe(false);
  });

  test("ACTIVE_PROGRESS_WINDOW_MS is exactly 5 minutes (AC requirement)", () => {
    expect(ACTIVE_PROGRESS_WINDOW_MS).toBe(5 * 60_000);
  });
});
