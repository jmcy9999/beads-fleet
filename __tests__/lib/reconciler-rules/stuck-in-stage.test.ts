// =============================================================================
// Tests for src/lib/reconciler-rules/stuck-in-stage.ts (factory-core-wlsr.14)
// =============================================================================
//
// Phase B cutover (ADR-015): act() no longer dispatches a hardcoded
// run-X-agent action derived from STAGE_RESUME_ACTIONS; it now constructs
// an EscalationContext and dispatches run-coherence-agent via the existing
// coherence-escalation pattern.
//
// Coverage (per AC #6):
//   (a) detection still fires when stage stalled past threshold;
//   (b) detection does NOT fire when stage active or below threshold (regression);
//   (c) act() constructs EscalationContext with the six required fields;
//   (d) act() does NOT call fetch with run-X-agent; act() calls run-coherence-agent;
//   (e) idempotency key formed correctly per AC #5;
//   (f) repeat-dispatch safety — same key within idempotency horizon is no-op.
//
// Plus AC #3 / AC #7: STAGE_RESUME_ACTIONS export retained.
//
// Test fixture: tmpdir-backed real event log + Reconciler harness (matches
// the legacy stuck-in-stage.test.ts and coherence-escalation.test.ts shape).
// Mocks limited to fetch (orchestrator dispatch).
// =============================================================================

import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";

import { Reconciler } from "@/lib/reconciler";
import { appendEvent, readEvents } from "@/lib/event-log";
import {
  buildStuckInStageRule,
  STAGE_RESUME_ACTIONS,
  STUCK_IN_STAGE_RULE_NAME,
  type EpicSnapshot,
} from "@/lib/reconciler-rules/stuck-in-stage";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function makeRepo(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "wlsr14-test-"));
}

function snap(partial: Partial<EpicSnapshot> = {}): EpicSnapshot {
  return {
    currentStage: "qa",
    hasAgentRunning: false,
    labels: ["pipeline:qa", "ship-type:ios-app"],
    title: "wlsr.14 test epic",
    currentWave: 2,
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("stuck-in-stage rule (factory-core-wlsr.14 cutover)", () => {
  let fetchMock: jest.SpyInstance;
  let fetchCalls: Array<{ url: string; body: Record<string, unknown> }>;

  beforeEach(() => {
    fetchCalls = [];
    fetchMock = jest
      .spyOn(global, "fetch")
      .mockImplementation(
        async (url: RequestInfo | URL, init?: RequestInit) => {
          const body =
            init?.body && typeof init.body === "string"
              ? (JSON.parse(init.body) as Record<string, unknown>)
              : ({} as Record<string, unknown>);
          fetchCalls.push({ url: String(url), body });
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      );
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  // -------------------------------------------------------------------------
  // AC #3 / AC #7 — STAGE_RESUME_ACTIONS retained
  // -------------------------------------------------------------------------

  test("AC #3/#7: STAGE_RESUME_ACTIONS exported and unchanged (fallback retention)", () => {
    // Per ADR-015 § 4 step 3 the constant is RETAINED for empirical
    // verification of coherence's competence. Same stage map as pre-cutover.
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
    // Submission/terminal stages still excluded from the table.
    expect(STAGE_RESUME_ACTIONS["submission-prep"]).toBeUndefined();
    expect(STAGE_RESUME_ACTIONS["live"]).toBeUndefined();
    expect(STAGE_RESUME_ACTIONS["completed"]).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // AC #6 (a): detection still fires past the staleness threshold
  // -------------------------------------------------------------------------

  test("AC #6 (a): detection fires when stage stalled past threshold (16 min old at qa)", async () => {
    const repo = await makeRepo();
    const now = new Date("2026-04-21T10:00:00.000Z");
    const sixteenMinAgo = new Date(now.getTime() - 16 * 60_000).toISOString();
    await appendEvent(repo, {
      type: "agent-exited",
      epicId: "factory-core-stuck1",
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
    expect(fetchCalls[0].body.epicId).toBe("factory-core-stuck1");
  });

  // -------------------------------------------------------------------------
  // AC #6 (b): detection does NOT fire when active or below threshold
  // -------------------------------------------------------------------------

  test("AC #6 (b): detection does NOT fire when below staleness threshold", async () => {
    const repo = await makeRepo();
    const now = new Date("2026-04-21T10:00:00.000Z");
    await appendEvent(repo, {
      type: "agent-exited",
      epicId: "factory-core-fresh1",
      stage: "qa",
      timestamp: new Date(now.getTime() - 5 * 60_000).toISOString(), // 5 min — below 15-min threshold
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

  test("AC #6 (b): detection does NOT fire when agent:running label is present", async () => {
    const repo = await makeRepo();
    const now = new Date("2026-04-21T10:00:00.000Z");
    await appendEvent(repo, {
      type: "agent-exited",
      epicId: "factory-core-active1",
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

  test("AC #6 (b): stage NOT in STAGE_RESUME_ACTIONS does not fire (predicate preserved)", async () => {
    // submission-prep is intentionally excluded from STAGE_RESUME_ACTIONS;
    // detection-time predicate skips it. Preserves pre-wlsr.14 behaviour.
    const repo = await makeRepo();
    const now = new Date("2026-04-21T10:00:00.000Z");
    await appendEvent(repo, {
      type: "agent-exited",
      epicId: "factory-core-sub1",
      stage: "submission-prep",
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

  // -------------------------------------------------------------------------
  // AC #6 (c): act() constructs EscalationContext with required fields
  // -------------------------------------------------------------------------

  test("AC #6 (c): act() constructs EscalationContext with the six required fields", async () => {
    const repo = await makeRepo();
    const now = new Date("2026-04-21T10:00:00.000Z");
    // Seed two prior reconciler-action-taken events so dispatchHistory
    // is non-empty.
    await appendEvent(repo, {
      type: "agent-exited",
      epicId: "factory-core-ctx1",
      stage: "qa",
      timestamp: new Date(now.getTime() - 18 * 60_000).toISOString(),
      payload: { exitCode: 0 },
    });
    await appendEvent(repo, {
      type: "reconciler-action-taken",
      epicId: "factory-core-ctx1",
      timestamp: new Date(now.getTime() - 30 * 60_000).toISOString(),
      payload: {
        ruleName: "stuck-in-stage",
        idempotencyKey: "stuck-in-stage::factory-core-ctx1::qa::stuck-in-stage::1",
        context: { stage: "qa", resumeAction: "send-for-qa" },
      },
    });

    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildStuckInStageRule({
        readEpicSnapshot: async () => snap({ currentStage: "qa" }),
      }),
    );
    await rec.tick(now);

    expect(fetchCalls).toHaveLength(1);
    const body = fetchCalls[0].body;
    expect(body.action).toBe("run-coherence-agent");
    expect(body.epicId).toBe("factory-core-ctx1");
    expect(body.anomalyClass).toBe("stuck-in-stage");

    // EscalationContext shape (ADR-015 § 3) — six fields total: required
    // anomalyType/epicId/ruleId/recentEvents + optional marker/ruleSpecificContext.
    const ec = body.escalationContext as Record<string, unknown>;
    expect(ec).toBeDefined();
    expect(ec.anomalyType).toBe("stuck-in-stage");
    expect(ec.epicId).toBe("factory-core-ctx1");
    expect(ec.ruleId).toBe(STUCK_IN_STAGE_RULE_NAME);
    expect(Array.isArray(ec.recentEvents)).toBe(true);
    // marker is omitted (stuck-in-stage is event-log-triggered, not
    // marker-triggered).
    expect(ec.marker).toBeUndefined();
    // ruleSpecificContext per ADR-015 § 2 audit-table row:
    // { stage, lastEventAge, dispatchHistory } (NOT marker — that's a
    // top-level EscalationContext field).
    const rsc = ec.ruleSpecificContext as Record<string, unknown>;
    expect(rsc.stage).toBe("qa");
    expect(typeof rsc.lastEventAge).toBe("number");
    // lastEventAge in seconds; agent exited 18 min ago.
    expect(rsc.lastEventAge as number).toBeGreaterThanOrEqual(18 * 60 - 1);
    expect(Array.isArray(rsc.dispatchHistory)).toBe(true);
    const dispatchHistory = rsc.dispatchHistory as Array<Record<string, unknown>>;
    expect(dispatchHistory.length).toBeGreaterThan(0);
    expect(dispatchHistory[0].ruleName).toBe("stuck-in-stage");
  });

  test("AC #6 (c): EscalationContext.recentEvents capped at 10, newest-first", async () => {
    const repo = await makeRepo();
    const now = new Date("2026-04-21T10:00:00.000Z");
    // Seed 12 distinct events for the same epic.
    for (let i = 0; i < 12; i++) {
      await appendEvent(repo, {
        type: i === 11 ? "agent-exited" : "stage-dispatched",
        epicId: "factory-core-cap1",
        stage: "qa",
        timestamp: new Date(now.getTime() - (16 + i) * 60_000).toISOString(),
        payload: { i },
      });
    }

    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildStuckInStageRule({
        readEpicSnapshot: async () => snap({ currentStage: "qa" }),
      }),
    );
    await rec.tick(now);

    expect(fetchCalls).toHaveLength(1);
    const ec = fetchCalls[0].body.escalationContext as Record<string, unknown>;
    const recent = ec.recentEvents as Array<{ timestamp: string }>;
    expect(recent.length).toBe(10);
    // Newest-first: each subsequent timestamp is older.
    for (let i = 1; i < recent.length; i++) {
      expect(Date.parse(recent[i - 1].timestamp)).toBeGreaterThanOrEqual(
        Date.parse(recent[i].timestamp),
      );
    }
  });

  // -------------------------------------------------------------------------
  // AC #6 (d): act() does NOT call fetch with run-X-agent
  // -------------------------------------------------------------------------

  test("AC #6 (d): act() does NOT call fetch with run-X-agent action; calls run-coherence-agent", async () => {
    const repo = await makeRepo();
    const now = new Date("2026-04-21T10:00:00.000Z");
    await appendEvent(repo, {
      type: "agent-exited",
      epicId: "factory-core-not-x1",
      stage: "qa",
      timestamp: new Date(now.getTime() - 16 * 60_000).toISOString(),
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
    expect(fetchCalls[0].body.action).toBe("run-coherence-agent");
    // Pre-wlsr.14 the qa stage would have dispatched send-for-qa.
    // After the cutover act() must NOT use the resume action even
    // though resumeAction is still in match.context for audit/advisory.
    expect(fetchCalls[0].body.action).not.toBe("send-for-qa");
    expect(fetchCalls[0].body.action).not.toMatch(/^run-(architect|builder|reviewer|pm|test-spec|polish|smoke-test)-agent$/);
  });

  test("AC #6 (d): same check at the development stage (no start-wave dispatch)", async () => {
    const repo = await makeRepo();
    const now = new Date("2026-04-21T10:00:00.000Z");
    await appendEvent(repo, {
      type: "agent-exited",
      epicId: "factory-core-dev1",
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

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].body.action).toBe("run-coherence-agent");
    expect(fetchCalls[0].body.action).not.toBe("start-wave");
    // The pre-cutover dispatch had a top-level waveNumber field. The
    // post-cutover dispatch DOES NOT include waveNumber at the top
    // level — wave info, if needed, lives inside escalationContext.
    expect(fetchCalls[0].body.waveNumber).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // AC #6 (e): idempotency key shape includes (epicId, stage, anomalyType)
  // -------------------------------------------------------------------------

  test("AC #6 (e): idempotency key shape includes anomalyType per ADR-015", async () => {
    const repo = await makeRepo();
    const now = new Date("2026-04-21T10:00:00.000Z");
    await appendEvent(repo, {
      type: "agent-exited",
      epicId: "factory-core-key1",
      stage: "qa",
      timestamp: new Date(now.getTime() - 16 * 60_000).toISOString(),
      payload: { exitCode: 0 },
    });

    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildStuckInStageRule({
        readEpicSnapshot: async () => snap({ currentStage: "qa" }),
      }),
    );
    await rec.tick(now);

    // The reconciler emits a reconciler-action-taken event whose
    // payload.idempotencyKey is the rule's chosen key.
    const events = await readEvents(repo, { type: "reconciler-action-taken" });
    expect(events).toHaveLength(1);
    const payload = events[0].payload as { idempotencyKey?: string };
    expect(payload.idempotencyKey).toBeDefined();
    const key = payload.idempotencyKey as string;
    // Format: ${RULE_NAME}::${epicId}::${stage}::${anomalyType}::${windowStart}
    expect(key).toMatch(
      new RegExp(
        `^${STUCK_IN_STAGE_RULE_NAME}::factory-core-key1::qa::stuck-in-stage::\\d+$`,
      ),
    );
  });

  // -------------------------------------------------------------------------
  // AC #6 (f): repeat-dispatch safety within idempotency horizon
  // -------------------------------------------------------------------------

  test("AC #6 (f): repeat tick within same idempotency window — no second dispatch", async () => {
    const repo = await makeRepo();
    const now = new Date("2026-04-21T10:00:00.000Z");
    await appendEvent(repo, {
      type: "agent-exited",
      epicId: "factory-core-rep1",
      stage: "qa",
      timestamp: new Date(now.getTime() - 16 * 60_000).toISOString(),
      payload: { exitCode: 0 },
    });

    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildStuckInStageRule({
        readEpicSnapshot: async () => snap({ currentStage: "qa" }),
      }),
    );
    await rec.tick(now);
    // 5 seconds later — still inside the 15-min window bucket.
    await rec.tick(new Date(now.getTime() + 5_000));

    expect(fetchCalls).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Carry-over regression coverage from the pre-wlsr.14 test suite
  // (preserves "skip conditions / predicates unchanged" per AC #1)
  // -------------------------------------------------------------------------

  test("regression: reconciler-action-taken events excluded from freshness check", async () => {
    // If we counted reconciler-action-taken as 'recent activity', our own
    // recovery would permanently mask the stall. Test: a fresh
    // reconciler-action-taken must NOT reset the staleness clock.
    const repo = await makeRepo();
    const now = new Date("2026-04-21T10:00:00.000Z");
    await appendEvent(repo, {
      type: "agent-exited",
      epicId: "factory-core-clk1",
      stage: "qa",
      timestamp: new Date(now.getTime() - 20 * 60_000).toISOString(),
      payload: { exitCode: 0 },
    });
    // Recent action-taken (should NOT count as epic activity)
    await appendEvent(repo, {
      type: "reconciler-action-taken",
      epicId: "factory-core-clk1",
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
    // still triggers escalation.
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].body.action).toBe("run-coherence-agent");
  });

  test("regression: null snapshot (bd failure) skips epic without error", async () => {
    const repo = await makeRepo();
    const now = new Date("2026-04-21T10:00:00.000Z");
    await appendEvent(repo, {
      type: "agent-exited",
      epicId: "factory-core-null1",
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

  test("regression: agent starts running between match and act → abort cleanly", async () => {
    const repo = await makeRepo();
    const now = new Date("2026-04-21T10:00:00.000Z");
    await appendEvent(repo, {
      type: "agent-exited",
      epicId: "factory-core-race1",
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

    // Act aborted — no dispatch.
    expect(fetchCalls).toHaveLength(0);
    // But action-taken event WAS emitted (idempotency bucket consumed).
    const events = await readEvents(repo, {
      type: "reconciler-action-taken",
    });
    expect(events).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Cross-cutting: preserved 15-min window allows refire after bucket roll
  // -------------------------------------------------------------------------

  test("idempotency: window bucket roll allows refire (skip condition preserved)", async () => {
    const repo = await makeRepo();
    const t0 = new Date("2026-04-21T10:00:00.000Z");
    // First tick: stall observed at a 16-min event; bucket A.
    await appendEvent(repo, {
      type: "agent-exited",
      epicId: "factory-core-bkt1",
      stage: "qa",
      timestamp: new Date(t0.getTime() - 16 * 60_000).toISOString(),
      payload: { exitCode: 0 },
    });

    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildStuckInStageRule({
        readEpicSnapshot: async () => snap({ currentStage: "qa" }),
      }),
    );
    await rec.tick(t0);
    expect(fetchCalls).toHaveLength(1);

    // Tick 16 min later — windowStart bucket changes, refire allowed.
    // (The reconciler-action-taken event sits in a different bucket key.)
    const t1 = new Date(t0.getTime() + 16 * 60_000);
    await rec.tick(t1);
    expect(fetchCalls).toHaveLength(2);
  });
});
