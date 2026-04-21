// =============================================================================
// Tests for src/lib/reconciler-rules/repeat-dispatch-escalation.ts
// (factory-core-zsjv.6)
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
});
