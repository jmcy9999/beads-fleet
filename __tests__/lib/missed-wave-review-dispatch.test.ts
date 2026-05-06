// =============================================================================
// Tests for src/lib/reconciler-rules/missed-wave-review-dispatch.ts
// (factory-core-lfcf.4 — first real reconciler rule)
// =============================================================================
// Drives the rule with synthetic event sequences + stubbed bd reads. Exercises:
//   - match detection (exit without dispatch, within horizon, past grace)
//   - no-match when a matching stage-dispatched event exists
//   - idempotency via action-taken events in the log
//   - recovery branching (bugs / next-wave / run-smoke-test)
//   - fail-safe on snapshot errors (act throws → reconciler retries)
// =============================================================================

import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";

import { Reconciler } from "@/lib/reconciler";
import { appendEvent, readEvents } from "@/lib/event-log";
import {
  buildMissedWaveReviewDispatchRule,
  type EpicSnapshot,
} from "@/lib/reconciler-rules/missed-wave-review-dispatch";

async function makeRepo(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "lfcf4-test-"));
}

function waveStatus(
  hasWaves: boolean,
  currentWave: number,
  allWavesComplete: boolean,
  error?: string,
): EpicSnapshot["waveStatus"] {
  return { hasWaves, currentWave, allWavesComplete, error };
}

function makeSnapshot(partial: Partial<EpicSnapshot>): EpicSnapshot {
  return {
    waveStatus: waveStatus(true, 2, false),
    openBugCount: 0,
    labels: ["ship-type:ios-app"],
    title: "test-epic",
    ...partial,
  };
}

describe("missed-wave-review-dispatch rule", () => {
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

  test("match: exit past grace with no dispatch triggers recovery", async () => {
    // factory-core-wlsr.15 (Phase B cutover, ADR-015): pre-cutover this
    // dispatched action='start-wave' with the current wave number. Post-
    // cutover act() escalates to coherence; coherence decides whether
    // start-wave / run-smoke-test / something else is appropriate.
    const repo = await makeRepo();
    const now = new Date("2026-04-21T10:00:00.000Z");
    const exitAt = new Date(now.getTime() - 65_000).toISOString(); // 65s ago
    await appendEvent(repo, {
      type: "agent-exited",
      epicId: "factory-core-e1",
      stage: "build-review",
      correlationId: "tmux-test-1",
      timestamp: exitAt,
      payload: { exitCode: 0 },
    });

    const rec = new Reconciler({ repoPath: repo });
    const rule = buildMissedWaveReviewDispatchRule({
      readEpicSnapshot: async () =>
        makeSnapshot({ waveStatus: waveStatus(true, 2, false) }),
    });
    rec.registerRule(rule);
    await rec.tick(now);

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].body).toMatchObject({
      action: "run-coherence-agent",
      epicId: "factory-core-e1",
    });
    // Wave context surfaces inside escalationContext.ruleSpecificContext,
    // not at the top level of the dispatch body.
    const ec = (fetchCalls[0].body as { escalationContext?: { ruleSpecificContext?: { waveNumber?: number } } })
      .escalationContext;
    expect(ec?.ruleSpecificContext?.waveNumber).toBe(2);
  });

  test("no match: exit followed by stage-dispatched event", async () => {
    const repo = await makeRepo();
    const now = new Date("2026-04-21T10:00:00.000Z");
    const exitAt = new Date(now.getTime() - 65_000).toISOString();
    const dispatchAt = new Date(now.getTime() - 64_000).toISOString();

    await appendEvent(repo, {
      type: "agent-exited",
      epicId: "factory-core-e1",
      stage: "build-review",
      correlationId: "tmux-paired-1",
      timestamp: exitAt,
      payload: { exitCode: 0 },
    });
    await appendEvent(repo, {
      type: "stage-dispatched",
      epicId: "factory-core-e1",
      correlationId: "tmux-paired-1",
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

  test("no match: exit too recent (within grace period)", async () => {
    const repo = await makeRepo();
    const now = new Date("2026-04-21T10:00:00.000Z");
    const exitAt = new Date(now.getTime() - 30_000).toISOString(); // 30s ago (< 60s grace)

    await appendEvent(repo, {
      type: "agent-exited",
      epicId: "factory-core-e1",
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

  test("no match: exit too old (beyond recovery horizon)", async () => {
    const repo = await makeRepo();
    const now = new Date("2026-04-21T10:00:00.000Z");
    const exitAt = new Date(now.getTime() - 30 * 60_000).toISOString(); // 30 min ago

    await appendEvent(repo, {
      type: "agent-exited",
      epicId: "factory-core-e1",
      stage: "build-review",
      correlationId: "tmux-ancient",
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

  test("no match: exit with exitCode != 0 (failed agent)", async () => {
    const repo = await makeRepo();
    const now = new Date("2026-04-21T10:00:00.000Z");
    const exitAt = new Date(now.getTime() - 65_000).toISOString();

    await appendEvent(repo, {
      type: "agent-exited",
      epicId: "factory-core-e1",
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

  test("idempotency: second tick does not re-fire after action-taken event", async () => {
    const repo = await makeRepo();
    const now = new Date("2026-04-21T10:00:00.000Z");
    const exitAt = new Date(now.getTime() - 65_000).toISOString();

    await appendEvent(repo, {
      type: "agent-exited",
      epicId: "factory-core-e1",
      stage: "build-review",
      correlationId: "tmux-idem",
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
    await rec.tick(new Date(now.getTime() + 10_000)); // 10s later

    expect(fetchCalls).toHaveLength(1);
    // Verify the action-taken event was appended after the first tick
    const actionTaken = await readEvents(repo, {
      type: "reconciler-action-taken",
    });
    expect(actionTaken).toHaveLength(1);
  });

  test("branching: all waves complete + no bugs -> escalate to coherence (was: run-smoke-test)", async () => {
    // factory-core-wlsr.15 (Phase B cutover, ADR-015): pre-cutover this
    // dispatched action='run-smoke-test' when allWavesComplete && no bugs.
    // Post-cutover act() escalates regardless; coherence reasons over
    // waveCompletionEvidence (allWavesComplete=true, openBugCount=0) and
    // decides whether smoke-test is appropriate.
    const repo = await makeRepo();
    const now = new Date("2026-04-21T10:00:00.000Z");
    const exitAt = new Date(now.getTime() - 65_000).toISOString();

    await appendEvent(repo, {
      type: "agent-exited",
      epicId: "factory-core-e1",
      stage: "build-review",
      correlationId: "tmux-final",
      timestamp: exitAt,
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

    expect(fetchCalls[0].body).toMatchObject({
      action: "run-coherence-agent",
      epicId: "factory-core-e1",
    });
    // waveCompletionEvidence surfaces the input that pre-cutover
    // branching consumed; coherence reasons over it.
    const ec = (fetchCalls[0].body as {
      escalationContext?: {
        ruleSpecificContext?: {
          waveCompletionEvidence?: {
            allWavesComplete?: boolean;
            openBugCount?: number;
          };
        };
      };
    }).escalationContext;
    expect(ec?.ruleSpecificContext?.waveCompletionEvidence?.allWavesComplete).toBe(
      true,
    );
    expect(ec?.ruleSpecificContext?.waveCompletionEvidence?.openBugCount).toBe(0);
  });

  test("branching: open bugs -> escalate to coherence (was: start-wave with current wave)", async () => {
    // factory-core-wlsr.15 (Phase B cutover, ADR-015): pre-cutover this
    // dispatched action='start-wave' with the current wave number when
    // openBugCount > 0. Post-cutover act() escalates; waveCompletionEvidence
    // captures openBugCount so coherence can reason about whether to
    // re-run the wave or take a different action.
    const repo = await makeRepo();
    const now = new Date("2026-04-21T10:00:00.000Z");
    const exitAt = new Date(now.getTime() - 65_000).toISOString();

    await appendEvent(repo, {
      type: "agent-exited",
      epicId: "factory-core-e1",
      stage: "build-review",
      correlationId: "tmux-bugs",
      timestamp: exitAt,
      payload: { exitCode: 0 },
    });

    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildMissedWaveReviewDispatchRule({
        readEpicSnapshot: async () =>
          makeSnapshot({
            waveStatus: waveStatus(true, 2, false),
            openBugCount: 3,
          }),
      }),
    );
    await rec.tick(now);

    expect(fetchCalls[0].body).toMatchObject({
      action: "run-coherence-agent",
    });
    const ec = (fetchCalls[0].body as {
      escalationContext?: {
        ruleSpecificContext?: {
          waveNumber?: number;
          waveCompletionEvidence?: { openBugCount?: number };
        };
      };
    }).escalationContext;
    expect(ec?.ruleSpecificContext?.waveNumber).toBe(2);
    expect(ec?.ruleSpecificContext?.waveCompletionEvidence?.openBugCount).toBe(3);
  });

  test("fail-safe: snapshot read failure throws, action-taken emitted WITH error payload", async () => {
    // zsjv hotfix 2026-04-21: reconciler now always emits action-taken
    // even on act() throw, so idempotency is consumed (prevents hammer
    // loop on permanent failures). Error visible in payload.
    const repo = await makeRepo();
    const now = new Date("2026-04-21T10:00:00.000Z");
    const exitAt = new Date(now.getTime() - 65_000).toISOString();

    await appendEvent(repo, {
      type: "agent-exited",
      epicId: "factory-core-e1",
      stage: "build-review",
      correlationId: "tmux-err",
      timestamp: exitAt,
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

  test("only matches build-review exits (not other stages)", async () => {
    const repo = await makeRepo();
    const now = new Date("2026-04-21T10:00:00.000Z");
    const exitAt = new Date(now.getTime() - 65_000).toISOString();

    // Emit exits for various stages — only build-review should trigger.
    for (const stage of ["research", "qa", "development", "ux-polish"]) {
      await appendEvent(repo, {
        type: "agent-exited",
        epicId: "factory-core-e1",
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
});
