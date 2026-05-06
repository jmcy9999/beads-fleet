// =============================================================================
// Tests for src/lib/reconciler-rules/wave-bead-mismatch.ts (factory-core-wlsr.16
// Phase B cutover — ADR-015 detector/decider separation)
// =============================================================================
//
// Audit outcome (factory-core-wlsr.16): NON-COMPLIANT pre-cutover. Pre-wlsr.16
// the rule's act() method (a) called fetch(actionUrl) with hardcoded
// action="start-wave" AND (b) mutated pipeline:<wrongStage> → pipeline:
// development labels. Both were rule-side decisions ADR-015 § 1 prohibits.
//
// Post-wlsr.16 cutover, this suite exercises:
//
//   AC 1 (audit recorded — see marker; this file's existence demonstrates
//         the cutover branch was taken).
//   AC 2 (act() NO LONGER calls fetch with action="start-wave"; instead
//         dispatches run-coherence-agent with anomalyClass and
//         escalationContext).
//   AC 3 (prior decision-logic code retained as commented-out fallback —
//         covered by the file-level review; not test-asserted).
//   AC 5a (detection still fires under current trigger conditions —
//         POST_DEVELOPMENT_STAGES with open wave).
//   AC 5b (detection does NOT fire under non-trigger conditions:
//         pipeline:development, allWavesComplete, hasWaves=false,
//         waveStatusError, null snapshot).
//   AC 5c (act() builds an EscalationContext with the six required fields:
//         anomalyType, epicId, ruleId, recentEvents, [marker optional],
//         ruleSpecificContext).
//   AC 5d (act() does NOT call fetch with the previous hardcoded action;
//         specifically: no "start-wave" body, no addLabelsToEpic /
//         removeLabelsFromEpic calls).
//   AC 5e (idempotency key formed correctly — (epicId, stage) per
//         ADR-009/015; anomalyType implicit in rule-name prefix).
//   AC 6 (idempotency horizon — same (epicId, stage) within horizon does
//        NOT refire; stage transition allows refire — covered by AC 5e
//        + behavioural test).
//
// Test fixture: synthesised PipelineEvents + EpicSnapshot helper. Mocks
// limited to fetch (orchestrator dispatch) and pipeline-labels (defensive —
// asserts the cutover does NOT call them). Real Reconciler core is used.
// =============================================================================

import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";

import { Reconciler } from "@/lib/reconciler";
import { appendEvent } from "@/lib/event-log";
import {
  buildWaveBeadMismatchRule,
  WAVE_BEAD_MISMATCH_RULE_NAME,
  type EpicSnapshot,
} from "@/lib/reconciler-rules/wave-bead-mismatch";

// Defensive mock — these MUST NOT be invoked by the cutover act(). The
// mock fails the test if either call lands.
const mockAddLabels = jest.fn();
const mockRemoveLabels = jest.fn();
jest.mock("@/lib/pipeline-labels", () => ({
  addLabelsToEpic: (...args: unknown[]) => mockAddLabels(...args),
  removeLabelsFromEpic: (...args: unknown[]) => mockRemoveLabels(...args),
}));

async function makeRepo(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "wlsr16-test-"));
}

function snap(partial: Partial<EpicSnapshot> = {}): EpicSnapshot {
  return {
    currentStage: "qa",
    lowestOpenWave: 2,
    allWavesComplete: false,
    hasWaves: true,
    labels: ["pipeline:qa", "ship-type:ios-app"],
    title: "wlsr16 test epic",
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

describe("wave-bead-mismatch rule — Phase B cutover (factory-core-wlsr.16)", () => {
  let fetchMock: jest.SpyInstance;
  let fetchCalls: Array<{ url: string; body: Record<string, unknown> }>;

  beforeEach(() => {
    fetchCalls = [];
    mockAddLabels.mockReset();
    mockRemoveLabels.mockReset();
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
  // AC 5a — detection preserved under current trigger conditions
  // -------------------------------------------------------------------------

  test("AC 5a: pipeline:qa with open wave:2 → escalates to coherence (run-coherence-agent dispatch)", async () => {
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
    expect(fetchCalls[0].body.action).toBe("run-coherence-agent");
    expect(fetchCalls[0].body.epicId).toBe("factory-core-e1");
    expect(fetchCalls[0].body.anomalyClass).toBe("wave-bead-mismatch");
  });

  test("AC 5a: post-development stages all trigger escalation (ux-polish, submission-prep, submitted, awaiting-review, in-review, package, deploying)", async () => {
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
      expect(fetchCalls[0].body.action).toBe("run-coherence-agent");
      expect(fetchCalls[0].body.anomalyClass).toBe("wave-bead-mismatch");
    }
  });

  // -------------------------------------------------------------------------
  // AC 5b — detection does NOT fire under non-trigger conditions
  // -------------------------------------------------------------------------

  test("AC 5b: pipeline:development or pipeline:build-review does NOT trigger", async () => {
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

  test("AC 5b: allWavesComplete=true does NOT trigger (invariant satisfied)", async () => {
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

  test("AC 5b: hasWaves=false (legacy no-wave epic) does NOT trigger", async () => {
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

  test("AC 5b: waveStatusError fail-safe skips (does NOT escalate)", async () => {
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

  test("AC 5b: null snapshot (bd failure) skips", async () => {
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

  // -------------------------------------------------------------------------
  // AC 5c — act() constructs EscalationContext with required fields
  // -------------------------------------------------------------------------

  test("AC 5c: dispatch body includes escalationContext with required fields (anomalyType, epicId, ruleId, recentEvents, ruleSpecificContext)", async () => {
    const repo = await makeRepo();
    await seedEvent(repo, "factory-core-e1");
    // Add a stage-dispatched event so dispatchedBuilders captures it.
    await appendEvent(repo, {
      type: "stage-dispatched",
      epicId: "factory-core-e1",
      stage: "builder",
      correlationId: "tmux-builder-1",
      payload: { toAction: "run-builder-agent" },
    });
    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildWaveBeadMismatchRule({
        readEpicSnapshot: async () =>
          snap({ currentStage: "qa", lowestOpenWave: 2 }),
      }),
    );
    await rec.tick();

    expect(fetchCalls).toHaveLength(1);
    const body = fetchCalls[0].body as {
      escalationContext?: {
        anomalyType: string;
        epicId: string;
        ruleId: string;
        recentEvents: unknown[];
        ruleSpecificContext: {
          waveNumber: number;
          wrongStage: string;
          eligibleBeads: unknown[];
          dispatchedBuilders: Array<{ timestamp: string; action: string }>;
        };
      };
    };
    expect(body.escalationContext).toBeDefined();
    const ec = body.escalationContext!;
    expect(ec.anomalyType).toBe("wave-bead-mismatch");
    expect(ec.epicId).toBe("factory-core-e1");
    expect(ec.ruleId).toBe(WAVE_BEAD_MISMATCH_RULE_NAME);
    expect(Array.isArray(ec.recentEvents)).toBe(true);
    // Should include the seeded agent-exited and stage-dispatched events.
    expect(ec.recentEvents.length).toBeGreaterThan(0);
    expect(ec.ruleSpecificContext.waveNumber).toBe(2);
    expect(ec.ruleSpecificContext.wrongStage).toBe("qa");
    expect(Array.isArray(ec.ruleSpecificContext.eligibleBeads)).toBe(true);
    // dispatchedBuilders should include the run-builder-agent dispatch.
    expect(ec.ruleSpecificContext.dispatchedBuilders.length).toBe(1);
    expect(ec.ruleSpecificContext.dispatchedBuilders[0].action).toBe(
      "run-builder-agent",
    );
  });

  // -------------------------------------------------------------------------
  // factory-core-wlsr.21: recentEvents ordering is newest-first
  //
  // ADR-015 § 3 + wlsr.14/15 markers contract: "cap 10, newest-first".
  // Sibling rules (stuck-in-stage.ts, missed-wave-review-dispatch.ts) sort
  // newest-first by explicit timestamp. This rule was previously returning
  // append (oldest-first) order; wlsr.21 aligned the convention.
  // -------------------------------------------------------------------------

  test("wlsr.21: recentEvents in escalation context is newest-first (matches sibling rules' convention)", async () => {
    const repo = await makeRepo();
    // Seed three events at different timestamps; appendEvent stamps them
    // in monotonically-increasing order, so events.jsonl natural order is
    // oldest-first. The rule must invert that for recentEvents.
    await appendEvent(repo, {
      type: "agent-exited",
      epicId: "factory-core-wlsr21",
      stage: "qa",
      payload: { exitCode: 0, marker: "first" },
    });
    await appendEvent(repo, {
      type: "stage-dispatched",
      epicId: "factory-core-wlsr21",
      stage: "builder",
      correlationId: "tmux-builder-1",
      payload: { toAction: "run-builder-agent", marker: "second" },
    });
    await appendEvent(repo, {
      type: "agent-exited",
      epicId: "factory-core-wlsr21",
      stage: "builder",
      payload: { exitCode: 0, marker: "third" },
    });

    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildWaveBeadMismatchRule({
        readEpicSnapshot: async () =>
          snap({ currentStage: "qa", lowestOpenWave: 2 }),
      }),
    );
    await rec.tick();

    expect(fetchCalls).toHaveLength(1);
    const body = fetchCalls[0].body as {
      escalationContext: {
        recentEvents: Array<{
          timestamp: string;
          payload?: { marker?: string };
        }>;
      };
    };
    const recent = body.escalationContext.recentEvents;
    expect(recent.length).toBe(3);
    // Newest-first: marker="third" must be at index 0, "first" at index 2.
    expect(recent[0].payload?.marker).toBe("third");
    expect(recent[1].payload?.marker).toBe("second");
    expect(recent[2].payload?.marker).toBe("first");
    // Timestamps strictly non-increasing.
    for (let i = 0; i < recent.length - 1; i++) {
      expect(Date.parse(recent[i].timestamp)).toBeGreaterThanOrEqual(
        Date.parse(recent[i + 1].timestamp),
      );
    }
  });

  // -------------------------------------------------------------------------
  // AC 5d — act() does NOT call fetch with previous hardcoded action,
  //         AND does NOT mutate pipeline labels
  // -------------------------------------------------------------------------

  test("AC 5d: act() does NOT dispatch action='start-wave' (pre-cutover behaviour fully removed)", async () => {
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

    // Across all fetch calls in this tick, none should be start-wave.
    for (const call of fetchCalls) {
      expect(call.body.action).not.toBe("start-wave");
    }
    // Body should not include waveNumber as a top-level dispatch param
    // (waveNumber lives inside escalationContext.ruleSpecificContext now).
    for (const call of fetchCalls) {
      expect(call.body.waveNumber).toBeUndefined();
    }
  });

  test("AC 5d: act() does NOT call addLabelsToEpic / removeLabelsFromEpic (label rollback is a decision, not pure hygiene)", async () => {
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

    // Dispatch should have happened.
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].body.action).toBe("run-coherence-agent");
    // But pipeline-labels mutations should NOT have been called.
    expect(mockAddLabels).not.toHaveBeenCalled();
    expect(mockRemoveLabels).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // AC 5e — idempotency key shape (epicId, stage) per ADR-009/015
  // -------------------------------------------------------------------------

  test("AC 5e: idempotencyKey has shape `wave-bead-mismatch::<epicId>::<stage>` (anomalyType implicit in rule-name prefix; no longer scoped by wave number)", async () => {
    const rule = buildWaveBeadMismatchRule({
      readEpicSnapshot: async () =>
        snap({ currentStage: "qa", lowestOpenWave: 2 }),
    });
    const events = [
      {
        type: "agent-exited" as const,
        epicId: "factory-core-shape1",
        stage: "qa",
        timestamp: new Date().toISOString(),
        payload: { exitCode: 0 },
      },
    ];
    const matches = await rule.matches(events, new Date());
    expect(matches).toHaveLength(1);
    expect(matches[0].idempotencyKey).toBe(
      `${WAVE_BEAD_MISMATCH_RULE_NAME}::factory-core-shape1::qa`,
    );
    // The key does NOT include the wave number — same epic re-stuck at
    // same stage with a different open wave should not refire.
    expect(matches[0].idempotencyKey).not.toContain("wave-2");
  });

  // -------------------------------------------------------------------------
  // AC 6 — idempotency: same (epicId, stage) within horizon does NOT refire
  // -------------------------------------------------------------------------

  test("AC 6: idempotency — same (epicId, stage) within horizon does NOT refire", async () => {
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

  test("AC 6: idempotency — stage transition (qa → ux-polish) allows refire", async () => {
    const repo = await makeRepo();
    await seedEvent(repo, "factory-core-e1");
    let stage = "qa";
    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildWaveBeadMismatchRule({
        readEpicSnapshot: async () =>
          snap({ currentStage: stage, lowestOpenWave: 2 }),
      }),
    );
    await rec.tick();
    expect(fetchCalls).toHaveLength(1);
    // Stage transitions to a different post-development stage (e.g., a
    // bad regression that re-advances). The (epicId, stage) idempotency
    // key changes, so refire is allowed.
    stage = "ux-polish";
    await rec.tick();
    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[1].body.anomalyClass).toBe("wave-bead-mismatch");
  });

  // -------------------------------------------------------------------------
  // Orchestrator-down behaviour (parallel to coherence-escalation pattern)
  // -------------------------------------------------------------------------

  test("orchestrator HTTP failure: act() throws so reconciler logs + retries (no operator escalation from inside the rule per ADR-008)", async () => {
    fetchMock.mockRestore();
    fetchMock = jest
      .spyOn(global, "fetch")
      .mockImplementation(async () => {
        return new Response("Internal Server Error", { status: 500 });
      });

    const repo = await makeRepo();
    await seedEvent(repo, "factory-core-down1");
    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildWaveBeadMismatchRule({
        readEpicSnapshot: async () =>
          snap({ currentStage: "qa", lowestOpenWave: 2 }),
      }),
    );
    // The reconciler logs the act() throw and emits reconciler-action-taken
    // with success=false. We assert the dispatch was attempted.
    await rec.tick();
    expect(fetchMock).toHaveBeenCalled();
  });
});
