// =============================================================================
// Tests for src/lib/reconciler-rules/missed-wave-review-dispatch.ts
// (factory-core-wlsr.15 — Phase B cutover per ADR-015)
// =============================================================================
//
// Phase B cutover (ADR-015): act() no longer dispatches start-wave /
// run-smoke-test from a hardcoded inline selection block; it now constructs
// an EscalationContext and dispatches run-coherence-agent via the existing
// coherence-escalation pattern.
//
// Coverage (per AC #6):
//   (a) detection still fires under the current trigger conditions;
//   (b) detection does NOT fire when wave incomplete or review already happened (regression);
//   (c) act() constructs an EscalationContext with the six required fields;
//   (d) act() does NOT call fetch with start-wave / run-smoke-test / run-reviewer-agent;
//   (e) idempotency key formed correctly per AC #5;
//   (f) repeat-dispatch safety — same key within idempotency horizon is no-op.
//
// Plus AC #3: legacy action-selection retained as unused helper.
//
// Test fixture: tmpdir-backed real event log + Reconciler harness (matches
// the legacy missed-wave-review-dispatch.test.ts and stuck-in-stage.test.ts
// shape). Mocks limited to fetch (orchestrator dispatch).
// =============================================================================

import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";

import { Reconciler } from "@/lib/reconciler";
import { appendEvent, readEvents } from "@/lib/event-log";
import {
  buildMissedWaveReviewDispatchRule,
  MISSED_WAVE_REVIEW_DISPATCH_RULE_NAME,
  __legacyActionSelection_DO_NOT_USE,
  type EpicSnapshot,
} from "@/lib/reconciler-rules/missed-wave-review-dispatch";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function makeRepo(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "wlsr15-test-"));
}

function waveStatus(
  hasWaves: boolean,
  currentWave: number,
  allWavesComplete: boolean,
  error?: string,
): EpicSnapshot["waveStatus"] {
  return { hasWaves, currentWave, allWavesComplete, error };
}

function makeSnapshot(partial: Partial<EpicSnapshot> = {}): EpicSnapshot {
  return {
    waveStatus: waveStatus(true, 2, false),
    openBugCount: 0,
    labels: ["pipeline:build-review", "ship-type:ios-app"],
    title: "wlsr.15 test epic",
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("missed-wave-review-dispatch rule (factory-core-wlsr.15 cutover)", () => {
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
  // AC #3 — legacy action-selection retained as unused helper
  // -------------------------------------------------------------------------

  test("AC #3: __legacyActionSelection_DO_NOT_USE export retained (Phase B fallback retention)", () => {
    // Per ADR-015 § 4 step 3 the action-selection logic is RETAINED as a
    // clearly-marked unused helper for empirical verification. Verify the
    // helper exists, is callable, and produces the pre-cutover branching.
    expect(typeof __legacyActionSelection_DO_NOT_USE).toBe("function");

    // Branch 1: bugs → start-wave with current wave number.
    const bugs = __legacyActionSelection_DO_NOT_USE(
      makeSnapshot({
        waveStatus: waveStatus(true, 2, false),
        openBugCount: 3,
      }),
    );
    expect(bugs.action).toBe("start-wave");
    expect(bugs.waveNumber).toBe(2);

    // Branch 2: incomplete wave (no bugs) → start-wave.
    const incomplete = __legacyActionSelection_DO_NOT_USE(
      makeSnapshot({
        waveStatus: waveStatus(true, 3, false),
        openBugCount: 0,
      }),
    );
    expect(incomplete.action).toBe("start-wave");
    expect(incomplete.waveNumber).toBe(3);

    // Branch 3: complete + no bugs → run-smoke-test (no waveNumber).
    const complete = __legacyActionSelection_DO_NOT_USE(
      makeSnapshot({
        waveStatus: waveStatus(true, 4, true),
        openBugCount: 0,
      }),
    );
    expect(complete.action).toBe("run-smoke-test");
    expect(complete.waveNumber).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // AC #6 (a): detection still fires under the current trigger conditions
  // -------------------------------------------------------------------------

  test("AC #6 (a): exit past grace with no dispatch triggers escalation", async () => {
    const repo = await makeRepo();
    const now = new Date("2026-04-21T10:00:00.000Z");
    const exitAt = new Date(now.getTime() - 65_000).toISOString(); // 65s ago — past 60s grace
    await appendEvent(repo, {
      type: "agent-exited",
      epicId: "factory-core-mwd1",
      stage: "build-review",
      correlationId: "tmux-mwd-1",
      timestamp: exitAt,
      payload: { exitCode: 0 },
    });

    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildMissedWaveReviewDispatchRule({
        readEpicSnapshot: async () => makeSnapshot({}),
      }),
    );
    await rec.tick(now);

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].body.epicId).toBe("factory-core-mwd1");
  });

  // -------------------------------------------------------------------------
  // AC #6 (b): detection does NOT fire when review already happened or
  //            other trigger conditions don't hold (regression)
  // -------------------------------------------------------------------------

  test("AC #6 (b): exit followed by stage-dispatched event — no escalation", async () => {
    const repo = await makeRepo();
    const now = new Date("2026-04-21T10:00:00.000Z");
    const exitAt = new Date(now.getTime() - 65_000).toISOString();
    const dispatchAt = new Date(now.getTime() - 64_000).toISOString();

    await appendEvent(repo, {
      type: "agent-exited",
      epicId: "factory-core-mwd-paired",
      stage: "build-review",
      correlationId: "tmux-paired",
      timestamp: exitAt,
      payload: { exitCode: 0 },
    });
    await appendEvent(repo, {
      type: "stage-dispatched",
      epicId: "factory-core-mwd-paired",
      correlationId: "tmux-paired",
      timestamp: dispatchAt,
      payload: { toAction: "start-wave" },
    });

    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildMissedWaveReviewDispatchRule({
        readEpicSnapshot: async () => makeSnapshot({}),
      }),
    );
    await rec.tick(now);

    expect(fetchCalls).toHaveLength(0);
  });

  test("AC #6 (b): exit too recent (within grace) — no escalation", async () => {
    const repo = await makeRepo();
    const now = new Date("2026-04-21T10:00:00.000Z");
    const exitAt = new Date(now.getTime() - 30_000).toISOString(); // 30s — below 60s grace

    await appendEvent(repo, {
      type: "agent-exited",
      epicId: "factory-core-mwd-fresh",
      stage: "build-review",
      correlationId: "tmux-fresh",
      timestamp: exitAt,
      payload: { exitCode: 0 },
    });

    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildMissedWaveReviewDispatchRule({
        readEpicSnapshot: async () => makeSnapshot({}),
      }),
    );
    await rec.tick(now);

    expect(fetchCalls).toHaveLength(0);
  });

  test("AC #6 (b): exit too old (beyond recovery horizon) — no escalation", async () => {
    const repo = await makeRepo();
    const now = new Date("2026-04-21T10:00:00.000Z");
    const exitAt = new Date(now.getTime() - 30 * 60_000).toISOString(); // 30 min ago

    await appendEvent(repo, {
      type: "agent-exited",
      epicId: "factory-core-mwd-old",
      stage: "build-review",
      correlationId: "tmux-old",
      timestamp: exitAt,
      payload: { exitCode: 0 },
    });

    const rec = new Reconciler({
      repoPath: repo,
      lookbackMs: 60 * 60_000, // wide enough to see the event
    });
    rec.registerRule(
      buildMissedWaveReviewDispatchRule({
        readEpicSnapshot: async () => makeSnapshot({}),
      }),
    );
    await rec.tick(now);

    expect(fetchCalls).toHaveLength(0);
  });

  test("AC #6 (b): non-zero exit code (failed agent) — no escalation", async () => {
    const repo = await makeRepo();
    const now = new Date("2026-04-21T10:00:00.000Z");
    const exitAt = new Date(now.getTime() - 65_000).toISOString();

    await appendEvent(repo, {
      type: "agent-exited",
      epicId: "factory-core-mwd-failed",
      stage: "build-review",
      correlationId: "tmux-failed",
      timestamp: exitAt,
      payload: { exitCode: 1 },
    });

    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildMissedWaveReviewDispatchRule({
        readEpicSnapshot: async () => makeSnapshot({}),
      }),
    );
    await rec.tick(now);

    expect(fetchCalls).toHaveLength(0);
  });

  test("AC #6 (b): non-build-review stage exits do not fire", async () => {
    const repo = await makeRepo();
    const now = new Date("2026-04-21T10:00:00.000Z");
    const exitAt = new Date(now.getTime() - 65_000).toISOString();

    for (const stage of ["research", "qa", "development", "ux-polish"]) {
      await appendEvent(repo, {
        type: "agent-exited",
        epicId: "factory-core-mwd-other",
        stage,
        correlationId: `tmux-${stage}`,
        timestamp: exitAt,
        payload: { exitCode: 0 },
      });
    }

    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildMissedWaveReviewDispatchRule({
        readEpicSnapshot: async () => makeSnapshot({}),
      }),
    );
    await rec.tick(now);

    expect(fetchCalls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // AC #6 (c): act() constructs EscalationContext with the six required fields
  // -------------------------------------------------------------------------

  test("AC #6 (c): act() constructs EscalationContext with the six required fields", async () => {
    const repo = await makeRepo();
    const now = new Date("2026-04-21T10:00:00.000Z");
    // Seed two earlier events for the same epic so recentEvents is non-empty.
    await appendEvent(repo, {
      type: "stage-dispatched",
      epicId: "factory-core-mwd-ctx",
      correlationId: "tmux-ctx-prev",
      timestamp: new Date(now.getTime() - 10 * 60_000).toISOString(),
      payload: { toAction: "review-wave" },
    });
    const exitAt = new Date(now.getTime() - 65_000).toISOString();
    await appendEvent(repo, {
      type: "agent-exited",
      epicId: "factory-core-mwd-ctx",
      stage: "build-review",
      correlationId: "tmux-ctx",
      timestamp: exitAt,
      payload: { exitCode: 0 },
    });

    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildMissedWaveReviewDispatchRule({
        readEpicSnapshot: async () =>
          makeSnapshot({
            waveStatus: waveStatus(true, 2, false),
            openBugCount: 1,
          }),
      }),
    );
    await rec.tick(now);

    expect(fetchCalls).toHaveLength(1);
    const body = fetchCalls[0].body;
    expect(body.action).toBe("run-coherence-agent");
    expect(body.epicId).toBe("factory-core-mwd-ctx");
    expect(body.anomalyClass).toBe("missed-wave-review-dispatch");

    // EscalationContext shape (ADR-015 § 3) — six fields total: required
    // anomalyType/epicId/ruleId/recentEvents + optional marker/ruleSpecificContext.
    const ec = body.escalationContext as Record<string, unknown>;
    expect(ec).toBeDefined();
    expect(ec.anomalyType).toBe("missed-wave-review-dispatch");
    expect(ec.epicId).toBe("factory-core-mwd-ctx");
    expect(ec.ruleId).toBe(MISSED_WAVE_REVIEW_DISPATCH_RULE_NAME);
    expect(Array.isArray(ec.recentEvents)).toBe(true);
    // recentEvents includes the agent-exited and stage-dispatched events
    // we seeded for this epic.
    expect((ec.recentEvents as unknown[]).length).toBeGreaterThan(0);
    // marker is omitted (event-log triggered, not marker-triggered).
    expect(ec.marker).toBeUndefined();
    // ruleSpecificContext per ADR-015 § 2 audit-table row:
    // { waveNumber, waveCompletionEvidence } (NOT marker — that's a
    // top-level EscalationContext field).
    const rsc = ec.ruleSpecificContext as Record<string, unknown>;
    expect(rsc.waveNumber).toBe(2);
    const wce = rsc.waveCompletionEvidence as Record<string, unknown>;
    expect(wce).toBeDefined();
    expect(wce.hasWaves).toBe(true);
    expect(wce.currentWave).toBe(2);
    expect(wce.allWavesComplete).toBe(false);
    expect(wce.openBugCount).toBe(1);
    expect(wce.exitedAt).toBe(exitAt);
    expect(wce.exitCorrelationId).toBe("tmux-ctx");
  });

  test("AC #6 (c): EscalationContext.recentEvents capped at 10, newest-first", async () => {
    const repo = await makeRepo();
    const now = new Date("2026-04-21T10:00:00.000Z");
    // Seed 11 earlier events for the epic (1 .. 11 minutes ago) plus the
    // qualifying build-review exit at 65s.
    for (let i = 0; i < 11; i++) {
      await appendEvent(repo, {
        type: "stage-dispatched",
        epicId: "factory-core-mwd-cap",
        correlationId: `tmux-cap-${i}`,
        timestamp: new Date(now.getTime() - (5 + i) * 60_000).toISOString(),
        payload: { toAction: "noop", i },
      });
    }
    await appendEvent(repo, {
      type: "agent-exited",
      epicId: "factory-core-mwd-cap",
      stage: "build-review",
      correlationId: "tmux-cap",
      timestamp: new Date(now.getTime() - 65_000).toISOString(),
      payload: { exitCode: 0 },
    });

    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildMissedWaveReviewDispatchRule({
        readEpicSnapshot: async () => makeSnapshot({}),
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

  test("AC #6 (c): all-waves-complete branch supplies waveCompletionEvidence", async () => {
    // When pre-cutover would have dispatched run-smoke-test, post-cutover
    // still escalates — the decision is coherence's. Verify the snapshot's
    // wave-complete state surfaces in waveCompletionEvidence so coherence
    // can reason about it.
    const repo = await makeRepo();
    const now = new Date("2026-04-21T10:00:00.000Z");
    await appendEvent(repo, {
      type: "agent-exited",
      epicId: "factory-core-mwd-final",
      stage: "build-review",
      correlationId: "tmux-final",
      timestamp: new Date(now.getTime() - 65_000).toISOString(),
      payload: { exitCode: 0 },
    });

    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildMissedWaveReviewDispatchRule({
        readEpicSnapshot: async () =>
          makeSnapshot({
            waveStatus: waveStatus(true, 3, true),
            openBugCount: 0,
          }),
      }),
    );
    await rec.tick(now);

    expect(fetchCalls).toHaveLength(1);
    const ec = fetchCalls[0].body.escalationContext as Record<string, unknown>;
    const rsc = ec.ruleSpecificContext as Record<string, unknown>;
    const wce = rsc.waveCompletionEvidence as Record<string, unknown>;
    expect(wce.allWavesComplete).toBe(true);
    expect(wce.currentWave).toBe(3);
    expect(wce.openBugCount).toBe(0);
    expect(rsc.waveNumber).toBe(3);
  });

  test("AC #6 (c): hasWaves=false → waveNumber is null", async () => {
    // For epics with no wave structure (legacy / non-decomposed), the rule
    // still escalates but waveNumber is null. waveCompletionEvidence
    // captures hasWaves=false so coherence knows to interpret accordingly.
    const repo = await makeRepo();
    const now = new Date("2026-04-21T10:00:00.000Z");
    await appendEvent(repo, {
      type: "agent-exited",
      epicId: "factory-core-mwd-nowave",
      stage: "build-review",
      correlationId: "tmux-nowave",
      timestamp: new Date(now.getTime() - 65_000).toISOString(),
      payload: { exitCode: 0 },
    });

    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildMissedWaveReviewDispatchRule({
        readEpicSnapshot: async () =>
          makeSnapshot({
            waveStatus: waveStatus(false, 0, false),
          }),
      }),
    );
    await rec.tick(now);

    expect(fetchCalls).toHaveLength(1);
    const ec = fetchCalls[0].body.escalationContext as Record<string, unknown>;
    const rsc = ec.ruleSpecificContext as Record<string, unknown>;
    expect(rsc.waveNumber).toBeNull();
    const wce = rsc.waveCompletionEvidence as Record<string, unknown>;
    expect(wce.hasWaves).toBe(false);
  });

  // -------------------------------------------------------------------------
  // AC #6 (d): act() does NOT call fetch with run-X-agent / start-wave /
  //            run-smoke-test
  // -------------------------------------------------------------------------

  test("AC #6 (d): act() does NOT call fetch with start-wave / run-smoke-test / run-reviewer-agent", async () => {
    const repo = await makeRepo();
    const now = new Date("2026-04-21T10:00:00.000Z");
    await appendEvent(repo, {
      type: "agent-exited",
      epicId: "factory-core-mwd-not-x",
      stage: "build-review",
      correlationId: "tmux-not-x",
      timestamp: new Date(now.getTime() - 65_000).toISOString(),
      payload: { exitCode: 0 },
    });

    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildMissedWaveReviewDispatchRule({
        readEpicSnapshot: async () =>
          makeSnapshot({
            waveStatus: waveStatus(true, 2, false),
            openBugCount: 0,
          }),
      }),
    );
    await rec.tick(now);

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].body.action).toBe("run-coherence-agent");
    // Pre-wlsr.15 would have dispatched start-wave or run-smoke-test.
    // After the cutover act() must NOT use either.
    expect(fetchCalls[0].body.action).not.toBe("start-wave");
    expect(fetchCalls[0].body.action).not.toBe("run-smoke-test");
    expect(fetchCalls[0].body.action).not.toBe("run-reviewer-agent");
    // The pre-cutover dispatch had a top-level waveNumber field. The
    // post-cutover dispatch DOES NOT include waveNumber at the top
    // level — wave info, if needed, lives inside
    // escalationContext.ruleSpecificContext.waveNumber.
    expect(fetchCalls[0].body.waveNumber).toBeUndefined();
  });

  test("AC #6 (d): all-waves-complete still escalates (no run-smoke-test fast path)", async () => {
    // Pre-cutover: complete + no bugs → run-smoke-test. Post-cutover:
    // escalate; coherence decides whether smoke-test is appropriate.
    const repo = await makeRepo();
    const now = new Date("2026-04-21T10:00:00.000Z");
    await appendEvent(repo, {
      type: "agent-exited",
      epicId: "factory-core-mwd-smoke",
      stage: "build-review",
      correlationId: "tmux-smoke",
      timestamp: new Date(now.getTime() - 65_000).toISOString(),
      payload: { exitCode: 0 },
    });

    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildMissedWaveReviewDispatchRule({
        readEpicSnapshot: async () =>
          makeSnapshot({
            waveStatus: waveStatus(true, 4, true),
            openBugCount: 0,
          }),
      }),
    );
    await rec.tick(now);

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].body.action).toBe("run-coherence-agent");
    expect(fetchCalls[0].body.action).not.toBe("run-smoke-test");
  });

  // -------------------------------------------------------------------------
  // AC #6 (e): idempotency key shape per AC #5
  // -------------------------------------------------------------------------

  test("AC #6 (e): idempotency key shape includes stage + anomalyType + correlationId per ADR-015", async () => {
    const repo = await makeRepo();
    const now = new Date("2026-04-21T10:00:00.000Z");
    await appendEvent(repo, {
      type: "agent-exited",
      epicId: "factory-core-mwd-key",
      stage: "build-review",
      correlationId: "tmux-key",
      timestamp: new Date(now.getTime() - 65_000).toISOString(),
      payload: { exitCode: 0 },
    });

    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildMissedWaveReviewDispatchRule({
        readEpicSnapshot: async () => makeSnapshot({}),
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
    // Format: ${RULE_NAME}::${epicId}::${stage}::${anomalyType}::${correlationId}
    expect(key).toBe(
      `${MISSED_WAVE_REVIEW_DISPATCH_RULE_NAME}::factory-core-mwd-key::build-review::missed-wave-review-dispatch::tmux-key`,
    );
  });

  // -------------------------------------------------------------------------
  // AC #6 (f): repeat-dispatch safety within idempotency horizon
  // -------------------------------------------------------------------------

  test("AC #6 (f): repeat tick on same exit — no second dispatch", async () => {
    const repo = await makeRepo();
    const now = new Date("2026-04-21T10:00:00.000Z");
    await appendEvent(repo, {
      type: "agent-exited",
      epicId: "factory-core-mwd-rep",
      stage: "build-review",
      correlationId: "tmux-rep",
      timestamp: new Date(now.getTime() - 65_000).toISOString(),
      payload: { exitCode: 0 },
    });

    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildMissedWaveReviewDispatchRule({
        readEpicSnapshot: async () => makeSnapshot({}),
      }),
    );
    await rec.tick(now);
    // 10 seconds later — same key, idempotency must short-circuit.
    await rec.tick(new Date(now.getTime() + 10_000));

    expect(fetchCalls).toHaveLength(1);
    const actionTaken = await readEvents(repo, {
      type: "reconciler-action-taken",
    });
    expect(actionTaken).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Carry-over regression coverage from the pre-wlsr.15 test suite
  // (preserves "skip conditions / predicates unchanged" per AC #1)
  // -------------------------------------------------------------------------

  test("regression: snapshot.waveStatus.error throws — action-taken emitted with error payload", async () => {
    // Pre-cutover behaviour preserved: act() throws when wave state is
    // unreadable, reconciler's always-emit-action-taken safety (zsjv
    // hotfix 2026-04-21) consumes the idempotency bucket with an error
    // payload rather than dispatching a partial EscalationContext.
    const repo = await makeRepo();
    const now = new Date("2026-04-21T10:00:00.000Z");
    await appendEvent(repo, {
      type: "agent-exited",
      epicId: "factory-core-mwd-err",
      stage: "build-review",
      correlationId: "tmux-err",
      timestamp: new Date(now.getTime() - 65_000).toISOString(),
      payload: { exitCode: 0 },
    });

    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildMissedWaveReviewDispatchRule({
        readEpicSnapshot: async () =>
          makeSnapshot({
            waveStatus: waveStatus(false, 0, false, "bd failed"),
          }),
      }),
    );
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    await rec.tick(now);
    errSpy.mockRestore();

    expect(fetchCalls).toHaveLength(0);
    const actionTaken = await readEvents(repo, {
      type: "reconciler-action-taken",
    });
    expect(actionTaken).toHaveLength(1);
    const payload = actionTaken[0].payload as {
      success?: boolean;
      error?: string;
    };
    expect(payload.success).toBe(false);
    expect(payload.error).toMatch(/bd failed/);
  });

  test("regression: distinct exits get distinct idempotency keys (refire allowed)", async () => {
    // Two distinct missed exits for the same epic should both produce
    // escalations — the per-exit specificity is preserved by carrying
    // correlationId in the idempotency key.
    const repo = await makeRepo();
    const now = new Date("2026-04-21T10:00:00.000Z");
    await appendEvent(repo, {
      type: "agent-exited",
      epicId: "factory-core-mwd-dist",
      stage: "build-review",
      correlationId: "tmux-dist-1",
      timestamp: new Date(now.getTime() - 65_000).toISOString(),
      payload: { exitCode: 0 },
    });
    await appendEvent(repo, {
      type: "agent-exited",
      epicId: "factory-core-mwd-dist",
      stage: "build-review",
      correlationId: "tmux-dist-2",
      timestamp: new Date(now.getTime() - 70_000).toISOString(),
      payload: { exitCode: 0 },
    });

    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildMissedWaveReviewDispatchRule({
        readEpicSnapshot: async () => makeSnapshot({}),
      }),
    );
    await rec.tick(now);

    expect(fetchCalls).toHaveLength(2);
    const actionTaken = await readEvents(repo, {
      type: "reconciler-action-taken",
    });
    expect(actionTaken).toHaveLength(2);
    const keys = (actionTaken
      .map((e) => (e.payload as { idempotencyKey?: string }).idempotencyKey)
      .filter(Boolean) as string[]).sort();
    expect(keys).toEqual([
      `${MISSED_WAVE_REVIEW_DISPATCH_RULE_NAME}::factory-core-mwd-dist::build-review::missed-wave-review-dispatch::tmux-dist-1`,
      `${MISSED_WAVE_REVIEW_DISPATCH_RULE_NAME}::factory-core-mwd-dist::build-review::missed-wave-review-dispatch::tmux-dist-2`,
    ]);
  });
});
