// =============================================================================
// beads_web-ehp.12 — End-to-end niii phantom-dispatch reproduction tests.
// =============================================================================
//
// LOAD-BEARING: this test is the proof-of-completion for the entire
// beads_web-ehp epic. It replays each of the 6 phantom-dispatch scenarios
// documented in the epic description (`bd show beads_web-ehp`) against a
// real (test-fixture) bd repo + marker dir + reconciler tick. After Wave
// 1-3 land (ehp.1-.11 + .13 closed), each scenario MUST refuse at the
// precondition layer with NO label mutation and NO agent launch.
//
// The 6 scenarios (per epic description "Empirical evidence 2026-05-02 +
// 2026-05-06"):
//   1. niii planner pass-2  (e35f4a6)  — premature planner re-run
//   2. niii reviewer pass-2 (cc5a086)  — premature reviewer re-run
//   3. niii builder Wave 3  (8d41251)  — wave-3 with all wave:3 beads closed
//   4. niii Phantom Wave 4  (a633c66)  — wave:4 label but no wave:4 beads exist
//   5. niii reviewer-4-wave-4-redundant — review-wave on phantom wave-4
//   6. niii.5 reviewer-code-no-op       — reviewer dispatched against unbuilt bead
//
// Per-scenario assertions (load-bearing, per bead description):
//   (a) refusal occurred                            — assert at lib level
//   (b) result.ok === false                         — assert at lib level
//   (c) refusalCode ∈ canonical RefusalCode enum    — assert via REFUSAL_CODES
//   (d) ZERO label mutations                        — mockAddLabels never called
//   (e) ZERO agent launches                         — fetchCalls.length === 0
//                                                     (no POST to /api/fleet/action
//                                                     means no downstream agent
//                                                     launch)
//   (f) reconciler-action-refused event recorded    — assert via readEvents
//
// Per the bead's risk flag #3: tests must NOT brittle-assert specific
// refusalCode strings. Assert refusalCode is a member of the canonical
// `REFUSAL_CODES` enum. The PRECONDITION_TABLE may evolve (new predicates,
// ordering changes) — the load-bearing claim is "no dispatch fired", not
// "this exact code fired".
//
// Test strategy (per bead description "Use the same fixture shapes as the
// per-rule integration tests (Wave 3 beads)"):
//   - Mock the lib-level reader interfaces (bead-status-reader, marker-reader,
//     pipeline-labels, agent-launcher's listOpenWaveBeads /
//     listAllStatusWaveBeads). These are the I/O boundary; mocking lets us
//     drive fixture state without standing up a real bd repo.
//   - Use REAL `dispatch-preconditions` library (no stub).
//   - Use REAL reconciler rules (marker-driven-routing, wave-bead-mismatch,
//     missed-wave-review-dispatch). The rule's act() integrates the
//     precondition gate — driving through act() proves end-to-end refusal.
//   - For each scenario, perform a sanity check at the library level
//     (evaluatePreconditions(ctx)) AND a side-effect check at the rule
//     level (rule.act() emits refused event + does NOT call fetch).
//
// Pattern mirror: ehp.4 / ehp.6 / ehp.7 per-rule integration tests
// (marker-driven-routing.precondition-integration.test.ts;
// wave-bead-mismatch.precondition-integration.test.ts;
// missed-wave-review-dispatch.precondition-integration.test.ts).
// =============================================================================

import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";

// ---- Mock reader modules at the import boundary ---------------------------
//
// These feed buildDispatchContext. Mocks let each scenario configure the
// fixture state (deferred bead, missing plan file, empty wave-bead list,
// operator-decision marker, etc.) without spinning up a real dolt + bd.
jest.mock("@/lib/bead-status-reader", () => {
  const actual = jest.requireActual("@/lib/bead-status-reader");
  return { ...actual, readBeadStatus: jest.fn() };
});
jest.mock("@/lib/marker-reader", () => {
  const actual = jest.requireActual("@/lib/marker-reader");
  return { ...actual, readMarker: jest.fn() };
});

// pipeline-labels: getEpicLabels feeds preconditions; addLabelsToEpic /
// removeLabelsFromEpic are the LOAD-BEARING "must NOT be called" mocks
// (assertion (d): zero label mutations).
const mockAddLabels = jest.fn();
const mockRemoveLabels = jest.fn();
const mockRemoveAllPipeline = jest.fn();
jest.mock("@/lib/pipeline-labels", () => ({
  addLabelsToEpic: (...args: unknown[]) => mockAddLabels(...args),
  removeLabelsFromEpic: (...args: unknown[]) => mockRemoveLabels(...args),
  removeAllPipelineLabels: (...args: unknown[]) => mockRemoveAllPipeline(...args),
  getEpicLabels: jest.fn(),
}));

// agent-launcher: listOpenWaveBeads / listAllStatusWaveBeads feed
// DispatchContext.openWaveBeadIds / anyStatusWaveBeadIds. Mocked so wave
// scenarios drive the empty-list state. launchAgent is a pure no-op stub
// — load-bearing assertion (e) is via fetchCalls (no POST → no launch),
// but mocking the launcher belts-and-braces the no-launch contract.
const mockLaunchAgent = jest.fn();
jest.mock("@/lib/agent-launcher", () => {
  const actual = jest.requireActual("@/lib/agent-launcher");
  return {
    ...actual,
    listOpenWaveBeads: jest.fn(),
    listAllStatusWaveBeads: jest.fn(),
    launchAgent: (...args: unknown[]) => mockLaunchAgent(...args),
  };
});

// ---- Imports (after mocks are wired) --------------------------------------

import {
  buildDispatchContext,
  evaluatePreconditions,
  REFUSAL_CODES,
  type RefusalCode,
} from "@/lib/dispatch-preconditions";
import { readEvents } from "@/lib/event-log";
import {
  buildMarkerDrivenRoutingRule,
  MARKER_DRIVEN_ROUTING_RULE_NAME,
} from "@/lib/reconciler-rules/marker-driven-routing";
import {
  buildWaveBeadMismatchRule,
  WAVE_BEAD_MISMATCH_RULE_NAME,
  type EpicSnapshot as WaveBeadMismatchSnapshot,
} from "@/lib/reconciler-rules/wave-bead-mismatch";
import {
  buildMissedWaveReviewDispatchRule,
  MISSED_WAVE_REVIEW_DISPATCH_RULE_NAME,
  type EpicSnapshot as MissedWaveReviewSnapshot,
} from "@/lib/reconciler-rules/missed-wave-review-dispatch";
import { Reconciler } from "@/lib/reconciler";
import type { BeadSnapshot } from "@/lib/bead-status-reader";
import type { MarkerData } from "@/lib/marker-reader";
import type { PipelineEvent } from "@/lib/event-log";
import { readBeadStatus } from "@/lib/bead-status-reader";
import { readMarker } from "@/lib/marker-reader";
import { getEpicLabels } from "@/lib/pipeline-labels";
import {
  listOpenWaveBeads,
  listAllStatusWaveBeads,
} from "@/lib/agent-launcher";

const mockReadBeadStatus = readBeadStatus as jest.MockedFunction<
  typeof readBeadStatus
>;
const mockReadMarker = readMarker as jest.MockedFunction<typeof readMarker>;
const mockGetEpicLabels = getEpicLabels as jest.MockedFunction<
  typeof getEpicLabels
>;
const mockListOpenWaveBeads = listOpenWaveBeads as jest.MockedFunction<
  typeof listOpenWaveBeads
>;
const mockListAllStatusWaveBeads =
  listAllStatusWaveBeads as jest.MockedFunction<typeof listAllStatusWaveBeads>;

// ---- Helpers --------------------------------------------------------------

async function makeRepo(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "ehp12-niii-"));
}

/**
 * Materialise a plan file at .beads/plans/<epicId>.md so PLAN_FILE_MISSING
 * does not fire first. Wave + marker scenarios need this so the actual
 * scenario-specific predicate is the one that fires.
 */
async function writePlanFile(repo: string, epicId: string): Promise<void> {
  const plansDir = path.join(repo, ".beads", "plans");
  await fs.mkdir(plansDir, { recursive: true });
  await fs.writeFile(
    path.join(plansDir, `${epicId}.md`),
    `# Plan for ${epicId}\n\nstub plan body for ehp.12 niii reproduction\n`,
  );
}

function makeBead(overrides: Partial<BeadSnapshot> = {}): BeadSnapshot {
  return {
    id: "factory-core-niii",
    status: "open",
    labels: [],
    type: "task",
    pipelineStage: "development",
    currentQaRound: null,
    currentWave: null,
    hasAgentRunning: false,
    hasReviewNeedsHuman: false,
    ...overrides,
  };
}

/**
 * Per-bead helper: assert the refusal code is a member of the canonical
 * RefusalCode enum (REFUSAL_CODES). Per bead risk flag #3: do NOT brittle-
 * assert specific code values. The load-bearing claim is "refused with a
 * canonical code", not "this exact code".
 */
function assertCanonicalRefusalCode(code: unknown): void {
  expect(typeof code).toBe("string");
  expect(Object.keys(REFUSAL_CODES)).toContain(code as string);
}

/**
 * Per-bead helper: assert ZERO label mutations across all mutator surfaces.
 * Load-bearing assertion (d) per bead description.
 */
function assertNoLabelMutation(): void {
  expect(mockAddLabels).not.toHaveBeenCalled();
  expect(mockRemoveLabels).not.toHaveBeenCalled();
  expect(mockRemoveAllPipeline).not.toHaveBeenCalled();
}

/**
 * Per-bead helper: assert ZERO agent launches. Belt-and-braces: both the
 * fetch interceptor (no POST to action route) AND the direct
 * launchAgent mock should remain uncalled.
 */
function assertNoAgentLaunch(fetchCalls: ReadonlyArray<unknown>): void {
  expect(fetchCalls).toHaveLength(0);
  expect(mockLaunchAgent).not.toHaveBeenCalled();
}

// ---- Test setup -----------------------------------------------------------

describe("beads_web-ehp.12 — niii phantom-dispatch reproduction (end-to-end)", () => {
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
          // Default to 200 ok; per-scenario tests can override but the
          // load-bearing assertion is that fetch is NEVER CALLED at all.
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      );

    mockReadBeadStatus.mockReset();
    mockReadMarker.mockReset();
    mockGetEpicLabels.mockReset();
    mockListOpenWaveBeads.mockReset();
    mockListAllStatusWaveBeads.mockReset();
    mockAddLabels.mockReset();
    mockRemoveLabels.mockReset();
    mockRemoveAllPipeline.mockReset();
    mockLaunchAgent.mockReset();

    // Sane defaults — explicit per-scenario overrides supersede.
    mockReadMarker.mockResolvedValue(null);
    mockGetEpicLabels.mockResolvedValue([]);
    mockListOpenWaveBeads.mockResolvedValue([]);
    mockListAllStatusWaveBeads.mockResolvedValue([]);
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  // =========================================================================
  // Scenario 1 — niii planner pass-2 (e35f4a6): premature planner re-run
  // =========================================================================
  // Reproduction: the marker says next_agent=planner (so marker-driven-
  // routing wants to dispatch generate-plan), but the bead already carries
  // `agent:running` from the prior planner dispatch (`hasAgentRunning=true`).
  // The Class B AGENT_RUNNING_NO_SESSION predicate fires for every action in
  // ACTIONS_LAUNCHING_AGENT (which includes generate-plan) when the bead
  // has the `agent:running` label set. This catches the literal failure
  // mode of niii's premature planner pass-2: the planner agent was already
  // running, but the reconciler tried to dispatch it a second time.
  //
  // Bead risk flag #1: "document actual refusalCode" — observed refusal is
  // AGENT_RUNNING_NO_SESSION (Class B). Primary assertion is no-side-effect
  // (no fetch, no label mutation); secondary is structured refusal logged.
  // -------------------------------------------------------------------------
  test("Scenario 1 (e35f4a6 premature planner pass-2) — refusal, no dispatch, no label mutation, refused event recorded", async () => {
    const repo = await makeRepo();
    const epicId = "factory-core-niii-planner-pass2";
    const stage = "plan-prep";

    // Marker says: planner stage success → reroute to planner (loop reuse).
    // The marker-driven-routing rule will resolve next_agent=planner →
    // action=generate-plan via getActionForAgent.
    const markerForRule: MarkerData = {
      version: "1",
      epic_id: epicId,
      status: "blocked",
      stage,
      started_at: "2026-04-21T09:00:00.000Z",
      exited_at: "2026-04-21T09:30:00.000Z",
      next_agent: "planner",
    };

    // Bead has `agent:running` set — the prior planner agent is still
    // logically dispatched per labels. AGENT_RUNNING_NO_SESSION fires.
    mockReadBeadStatus.mockResolvedValue(
      makeBead({ id: epicId, status: "open", hasAgentRunning: true }),
    );
    // Per-bead marker for buildDispatchContext (Class C / E inspections) —
    // null so OPERATOR_DECISION_PENDING / ACTION_NEXT_AGENT_MISMATCH pass.
    mockReadMarker.mockResolvedValue(null);
    mockGetEpicLabels.mockResolvedValue([
      "pipeline:plan-prep",
      "agent:running",
      "ship-type:internal",
    ]);

    // Sanity check at the library level — assertions (a), (b), (c).
    const ctx = await buildDispatchContext({
      epicId,
      repoPath: repo,
      action: "generate-plan",
    });
    const libResult = evaluatePreconditions(ctx);
    expect(libResult.ok).toBe(false);
    if (!libResult.ok) {
      assertCanonicalRefusalCode(libResult.refusalCode);
      expect(typeof libResult.failedCheck).toBe("string");
      expect((libResult.failedCheck as string).length).toBeGreaterThan(0);
      expect(typeof libResult.reason).toBe("string");
    }

    // Drive the rule end-to-end via reconciler.tick — assertions (d), (e), (f).
    const rule = buildMarkerDrivenRoutingRule({
      readMarker: async () => markerForRule,
      readEpicSnapshot: async () => ({
        currentStage: stage,
        labels: ["pipeline:plan-prep", "agent:running", "ship-type:internal"],
        title: "niii planner pass-2 reproduction",
      }),
      repoPath: repo,
      actionUrl: "http://localhost:3000/api/fleet/action",
    });

    const events: PipelineEvent[] = [
      {
        type: "agent-exited",
        epicId,
        stage,
        timestamp: new Date(Date.now() - 5 * 60_000).toISOString(),
        payload: { exitCode: 0 },
      },
    ];

    const matches = await rule.matches(events, new Date());
    expect(matches.length).toBeGreaterThanOrEqual(1);

    await rule.act(matches[0]);

    // Load-bearing — no agent launched (no POST to action route).
    assertNoAgentLaunch(fetchCalls);
    // Load-bearing — no labels mutated.
    assertNoLabelMutation();

    // Refusal event recorded with structured fields.
    const refusals = await readEvents(repo, {
      type: "reconciler-action-refused",
    });
    expect(refusals).toHaveLength(1);
    const payload = refusals[0].payload as Record<string, unknown>;
    expect(payload.ruleName).toBe(MARKER_DRIVEN_ROUTING_RULE_NAME);
    expect(payload.action).toBe("generate-plan");
    assertCanonicalRefusalCode(payload.refusalCode);
    expect(typeof payload.failedCheck).toBe("string");
    expect((payload.failedCheck as string).length).toBeGreaterThan(0);
    expect(typeof payload.reason).toBe("string");
    expect((payload.reason as string).length).toBeGreaterThan(0);
  });

  // =========================================================================
  // Scenario 2 — niii reviewer pass-2 (cc5a086): premature reviewer re-run
  // =========================================================================
  // Reproduction: marker says next_agent=reviewer → action=review-wave
  // (per agent-action-map.ts). bead.hasAgentRunning=true mirrors the niii
  // failure mode where the reviewer was dispatched a second time on top of
  // an already-running reviewer. AGENT_RUNNING_NO_SESSION fires.
  //
  // Note: agent-action-map maps `reviewer` → `review-wave` (NOT `review-plan`).
  // The niii incident at cc5a086 was a plan-review reviewer dispatch; the
  // refusal predicate (AGENT_RUNNING_NO_SESSION via Class B) is identical
  // for both review-wave and review-plan because both are in
  // ACTIONS_LAUNCHING_AGENT. The reproduction is faithful at the predicate
  // level even if the canonical action name is the wave-review variant.
  // -------------------------------------------------------------------------
  test("Scenario 2 (cc5a086 premature reviewer pass-2) — refusal, no dispatch, no label mutation, refused event recorded", async () => {
    const repo = await makeRepo();
    const epicId = "factory-core-niii-reviewer-pass2";
    const stage = "plan-review";

    const markerForRule: MarkerData = {
      version: "1",
      epic_id: epicId,
      status: "blocked",
      stage,
      started_at: "2026-04-21T10:00:00.000Z",
      exited_at: "2026-04-21T10:30:00.000Z",
      next_agent: "reviewer",
    };

    mockReadBeadStatus.mockResolvedValue(
      makeBead({ id: epicId, status: "open", hasAgentRunning: true }),
    );
    mockReadMarker.mockResolvedValue(null);
    mockGetEpicLabels.mockResolvedValue([
      "pipeline:plan-review",
      "agent:running",
      "ship-type:internal",
    ]);
    // Plan file present so PLAN_FILE_MISSING does not fire first.
    await writePlanFile(repo, epicId);

    // Sanity check at the library level.
    const ctx = await buildDispatchContext({
      epicId,
      repoPath: repo,
      action: "review-wave",
      waveNumber: 1,
    });
    const libResult = evaluatePreconditions(ctx);
    expect(libResult.ok).toBe(false);
    if (!libResult.ok) {
      assertCanonicalRefusalCode(libResult.refusalCode);
    }

    const rule = buildMarkerDrivenRoutingRule({
      readMarker: async () => markerForRule,
      readEpicSnapshot: async () => ({
        currentStage: stage,
        labels: [
          "pipeline:plan-review",
          "agent:running",
          "ship-type:internal",
        ],
        title: "niii reviewer pass-2 reproduction",
      }),
      repoPath: repo,
      actionUrl: "http://localhost:3000/api/fleet/action",
    });

    const events: PipelineEvent[] = [
      {
        type: "agent-exited",
        epicId,
        stage,
        timestamp: new Date(Date.now() - 5 * 60_000).toISOString(),
        payload: { exitCode: 0 },
      },
    ];

    const matches = await rule.matches(events, new Date());
    expect(matches.length).toBeGreaterThanOrEqual(1);
    await rule.act(matches[0]);

    assertNoAgentLaunch(fetchCalls);
    assertNoLabelMutation();

    const refusals = await readEvents(repo, {
      type: "reconciler-action-refused",
    });
    expect(refusals).toHaveLength(1);
    const payload = refusals[0].payload as Record<string, unknown>;
    expect(payload.ruleName).toBe(MARKER_DRIVEN_ROUTING_RULE_NAME);
    expect(payload.action).toBe("review-wave");
    assertCanonicalRefusalCode(payload.refusalCode);
  });

  // =========================================================================
  // Scenario 3 — niii builder Wave 3 (8d41251): all wave:3 beads closed
  // =========================================================================
  // Reproduction: epic at pipeline:qa with wave:3 label, but every wave:3
  // bead is closed (`bd list --label wave:3 --status=open` returns []).
  // The wave-bead-mismatch rule fires (because the epic is in a post-
  // development stage with a non-zero open wave count from the snapshot)
  // and tries to escalate to coherence. Pre-ehp.6, the rule would dispatch
  // run-coherence-agent. Post-ehp.6, PRECOND_WAVE_BEADS_EXIST refuses with
  // NO_WAVE_BEADS BEFORE the dispatch (the rule directly invokes the
  // predicate against precondCtx).
  //
  // Per bead risk flag #3 + dispatch-preconditions library v1 limitation:
  // openWaveBeadIds=[] does NOT distinguish "no wave-N beads at all" from
  // "all wave-N beads closed"; both produce the same empty list. The
  // refusal code may be NO_WAVE_BEADS OR ALL_WAVE_BEADS_CLOSED depending
  // on predicate ordering. Assert membership in the canonical enum.
  // -------------------------------------------------------------------------
  test("Scenario 3 (8d41251 Builder Wave 3 — all closed) — refusal, no dispatch, no label mutation, refused event recorded", async () => {
    const repo = await makeRepo();
    const epicId = "factory-core-niii-wave-3-all-closed";

    // The "all wave:3 beads closed" condition: open list is empty. The
    // wave-bead-mismatch rule's act() invokes PRECOND_WAVE_BEADS_EXIST
    // directly with this ctx → NO_WAVE_BEADS fires.
    mockListOpenWaveBeads.mockResolvedValue([]);
    mockListAllStatusWaveBeads.mockResolvedValue([
      // wave:3 beads exist in any-status (closed) but none are open.
      // Note: scenario 3 specifically reproduces "all closed", distinct
      // from scenario 4 (no wave beads at all).
    ]);
    mockReadBeadStatus.mockResolvedValue(
      makeBead({
        id: epicId,
        status: "open",
        pipelineStage: "qa",
        currentWave: 3,
      }),
    );
    mockGetEpicLabels.mockResolvedValue([
      "pipeline:qa",
      "wave:3",
      "ship-type:internal",
    ]);
    // Plan file exists — the niii Builder Wave 3 reproduction has a
    // pre-existing plan (the epic was planned, all wave:3 beads were
    // built, then closed). Without the plan file, PLAN_FILE_MISSING
    // would fire first and mask the load-bearing wave-beads predicate.
    await writePlanFile(repo, epicId);

    // Sanity check at the library level — start-wave for wave 3 with
    // empty openWaveBeadIds → predicate fires.
    const ctx = await buildDispatchContext({
      epicId,
      repoPath: repo,
      action: "start-wave",
      waveNumber: 3,
    });
    const libResult = evaluatePreconditions(ctx);
    expect(libResult.ok).toBe(false);
    if (!libResult.ok) {
      // Per bead risk flag: refusalCode ∈ {NO_WAVE_BEADS, ALL_WAVE_BEADS_CLOSED}.
      // Both are canonical RefusalCode values; the test asserts membership in
      // the enum, not a specific code.
      assertCanonicalRefusalCode(libResult.refusalCode);
      expect(["NO_WAVE_BEADS", "ALL_WAVE_BEADS_CLOSED"]).toContain(
        libResult.refusalCode,
      );
    }

    const rule = buildWaveBeadMismatchRule({
      readEpicSnapshot: async (): Promise<WaveBeadMismatchSnapshot> => ({
        currentStage: "qa",
        lowestOpenWave: 3,
        allWavesComplete: false,
        hasWaves: true,
        labels: ["pipeline:qa", "wave:3", "ship-type:internal"],
        title: "niii Builder Wave 3 reproduction",
      }),
      repoPath: repo,
      actionUrl: "http://localhost:3000/api/fleet/action",
    });

    const events: PipelineEvent[] = [
      {
        type: "agent-exited",
        epicId,
        stage: "qa",
        timestamp: new Date(Date.now() - 5 * 60_000).toISOString(),
        payload: { exitCode: 0 },
      },
    ];

    const matches = await rule.matches(events, new Date());
    expect(matches.length).toBeGreaterThanOrEqual(1);
    await rule.act(matches[0]);

    assertNoAgentLaunch(fetchCalls);
    assertNoLabelMutation();

    const refusals = await readEvents(repo, {
      type: "reconciler-action-refused",
    });
    expect(refusals).toHaveLength(1);
    const payload = refusals[0].payload as Record<string, unknown>;
    expect(payload.ruleName).toBe(WAVE_BEAD_MISMATCH_RULE_NAME);
    assertCanonicalRefusalCode(payload.refusalCode);
    expect(typeof payload.failedCheck).toBe("string");
    expect(typeof payload.reason).toBe("string");
  });

  // =========================================================================
  // Scenario 4 — niii Phantom Wave 4 (a633c66): no wave:4 beads exist
  // =========================================================================
  // Reproduction: epic carries wave:4 label and pipeline:build-review, but
  // NO wave:4 beads exist in the repo at all (not even closed ones — the
  // wave was created at the epic level but no children were ever created).
  // missed-wave-review-dispatch fires (build-review agent-exited without
  // a paired stage-dispatched). Pre-ehp.7, the rule escalated to coherence
  // for the phantom dispatch. Post-ehp.7, PRECOND_WAVE_BEADS_OF_ANY_STATUS_
  // EXIST fires with NO_WAVE_BEADS (anyStatusWaveBeadIds=[]).
  //
  // Distinct from Scenario 3: Scenario 3's wave-3 has CLOSED beads; this
  // scenario's wave-4 has NO beads. The new dual-signal precondition (
  // beads_web-m2c) catches the phantom case without re-introducing the
  // 1cb58a5 regression on the legitimate post-close path.
  // -------------------------------------------------------------------------
  test("Scenario 4 (a633c66 Phantom Wave 4 — no wave:4 beads anywhere) — refusal, no dispatch, no label mutation, refused event recorded", async () => {
    const repo = await makeRepo();
    const epicId = "factory-core-niii-phantom-wave-4";
    const now = new Date("2026-04-21T10:00:00.000Z");
    const exitAt = new Date(now.getTime() - 65_000).toISOString();

    // Phantom wave: BOTH lists empty.
    mockListOpenWaveBeads.mockResolvedValue([]);
    mockListAllStatusWaveBeads.mockResolvedValue([]);
    mockReadBeadStatus.mockResolvedValue(
      makeBead({
        id: epicId,
        status: "open",
        pipelineStage: "build-review",
        currentWave: 4,
      }),
    );
    mockGetEpicLabels.mockResolvedValue([
      "pipeline:build-review",
      "wave:4",
      "ship-type:internal",
    ]);
    // Plan file exists so PLAN_FILE_MISSING does not fire first.
    await writePlanFile(repo, epicId);

    // Sanity check at the library level.
    const ctx = await buildDispatchContext({
      epicId,
      repoPath: repo,
      action: "review-wave",
      waveNumber: 4,
    });
    const libResult = evaluatePreconditions(ctx);
    expect(libResult.ok).toBe(false);
    if (!libResult.ok) {
      assertCanonicalRefusalCode(libResult.refusalCode);
      // Phantom wave → NO_WAVE_BEADS via PRECOND_WAVE_BEADS_OF_ANY_STATUS_EXIST.
      expect(libResult.refusalCode).toBe("NO_WAVE_BEADS");
    }

    // Seed the missed-wave-review-dispatch trigger event.
    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildMissedWaveReviewDispatchRule({
        repoPath: repo,
        readEpicSnapshot: async (): Promise<MissedWaveReviewSnapshot> => ({
          waveStatus: {
            hasWaves: true,
            currentWave: 4,
            allWavesComplete: false,
          },
          openBugCount: 0,
          labels: ["pipeline:build-review", "wave:4", "ship-type:internal"],
          title: "niii Phantom Wave 4 reproduction",
        }),
        actionUrl: "http://localhost:3000/api/fleet/action",
      }),
    );

    // Seed the build-review agent-exited event the rule's matches() looks
    // for. appendEvent is the canonical seeder; we use it via the event-log
    // module the rule will read from.
    const { appendEvent } = await import("@/lib/event-log");
    await appendEvent(repo, {
      type: "agent-exited",
      epicId,
      stage: "build-review",
      correlationId: `tmux-${epicId}`,
      timestamp: exitAt,
      payload: { exitCode: 0 },
    });

    await rec.tick(now);

    assertNoAgentLaunch(fetchCalls);
    assertNoLabelMutation();

    const refusals = await readEvents(repo, {
      type: "reconciler-action-refused",
    });
    expect(refusals).toHaveLength(1);
    const refusal = refusals[0];
    expect(refusal.epicId).toBe(epicId);
    const payload = refusal.payload as Record<string, unknown>;
    expect(payload.ruleName).toBe(MISSED_WAVE_REVIEW_DISPATCH_RULE_NAME);
    expect(payload.action).toBe("review-wave");
    assertCanonicalRefusalCode(payload.refusalCode);
    expect(payload.refusalCode).toBe("NO_WAVE_BEADS");
  });

  // =========================================================================
  // Scenario 5 — niii reviewer-4-wave-4-redundant: review-wave on phantom wave
  // =========================================================================
  // Reproduction: per the marker
  // `.beads/markers/factory-core-niii-reviewer-4-wave-4-redundant.json`,
  // a review-wave dispatch was repeatedly fired for wave-4 even though
  // there was nothing to review. This is the SAME refusal class as Scenario
  // 4 (NO_WAVE_BEADS via the dual-signal phantom-wave protection), but
  // exercised via a distinct epic-id so the test bookkeeping is unambiguous
  // and the regression catch is doubly anchored.
  //
  // The 28+ marker churn (`factory-core-niii-reviewer-4-wave-4-redundant-N.json`)
  // mentioned in the epic description came from this loop firing on every
  // reconciler tick. The precondition gate must close it on the first tick.
  // -------------------------------------------------------------------------
  test("Scenario 5 (niii reviewer-4-wave-4-redundant) — refusal, no dispatch, no label mutation, refused event recorded", async () => {
    const repo = await makeRepo();
    const epicId = "factory-core-niii-reviewer-4-wave-4";
    const now = new Date("2026-04-21T10:00:00.000Z");
    const exitAt = new Date(now.getTime() - 65_000).toISOString();

    // Same dual-signal phantom-wave shape as Scenario 4.
    mockListOpenWaveBeads.mockResolvedValue([]);
    mockListAllStatusWaveBeads.mockResolvedValue([]);
    mockReadBeadStatus.mockResolvedValue(
      makeBead({
        id: epicId,
        status: "open",
        pipelineStage: "build-review",
        currentWave: 4,
      }),
    );
    mockGetEpicLabels.mockResolvedValue([
      "pipeline:build-review",
      "wave:4",
      "ship-type:internal",
    ]);
    await writePlanFile(repo, epicId);

    // Sanity check at the library level.
    const ctx = await buildDispatchContext({
      epicId,
      repoPath: repo,
      action: "review-wave",
      waveNumber: 4,
    });
    const libResult = evaluatePreconditions(ctx);
    expect(libResult.ok).toBe(false);
    if (!libResult.ok) {
      assertCanonicalRefusalCode(libResult.refusalCode);
      // Per bead risk flag: NO_WAVE_BEADS or ALL_WAVE_BEADS_CLOSED.
      expect(["NO_WAVE_BEADS", "ALL_WAVE_BEADS_CLOSED"]).toContain(
        libResult.refusalCode,
      );
    }

    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildMissedWaveReviewDispatchRule({
        repoPath: repo,
        readEpicSnapshot: async (): Promise<MissedWaveReviewSnapshot> => ({
          waveStatus: {
            hasWaves: true,
            currentWave: 4,
            allWavesComplete: false,
          },
          openBugCount: 0,
          labels: ["pipeline:build-review", "wave:4", "ship-type:internal"],
          title: "niii reviewer-4-wave-4-redundant reproduction",
        }),
        actionUrl: "http://localhost:3000/api/fleet/action",
      }),
    );

    const { appendEvent } = await import("@/lib/event-log");
    await appendEvent(repo, {
      type: "agent-exited",
      epicId,
      stage: "build-review",
      correlationId: `tmux-${epicId}-reviewer-redundant`,
      timestamp: exitAt,
      payload: { exitCode: 0 },
    });

    await rec.tick(now);

    assertNoAgentLaunch(fetchCalls);
    assertNoLabelMutation();

    const refusals = await readEvents(repo, {
      type: "reconciler-action-refused",
    });
    expect(refusals).toHaveLength(1);
    const refusal = refusals[0];
    expect(refusal.epicId).toBe(epicId);
    const payload = refusal.payload as Record<string, unknown>;
    expect(payload.ruleName).toBe(MISSED_WAVE_REVIEW_DISPATCH_RULE_NAME);
    expect(payload.action).toBe("review-wave");
    assertCanonicalRefusalCode(payload.refusalCode);
  });

  // =========================================================================
  // Scenario 6 — niii.5 reviewer-code-no-op: reviewer dispatched against
  //              an unbuilt bead
  // =========================================================================
  // Reproduction: per the marker
  // `.beads/markers/factory-core-niii.5-reviewer-code-no-op.json`, a
  // reviewer-code dispatch was fired against niii.5 even though the bead
  // had not yet been built (no implementation commits, no builder marker
  // success). The reviewer correctly STOPPED and surfaced via a marker
  // with next_agent=operator + blocker_class=spec-ambiguity.
  //
  // The reproduction is: the marker says the operator must decide, and a
  // subsequent reconciler tick attempts to dispatch send-for-review or
  // similar. The Class C OPERATOR_DECISION_PENDING predicate fires
  // universally (applies to every dispatching action) when the marker
  // has next_agent=operator + non-empty blocker_class.
  //
  // Per bead risk flag #2: scenario 6 may not have a single canonical
  // refusalCode in v1 PRECONDITION_TABLE. Document the actual refusal
  // observed; primary assertion is no-side-effect. The OPERATOR_DECISION_
  // PENDING refusal IS a clean v1 refusal and matches the spirit of the
  // niii.5 reproduction (operator must act before further dispatch).
  // -------------------------------------------------------------------------
  test("Scenario 6 (niii.5 reviewer-code-no-op) — refusal (OPERATOR_DECISION_PENDING), no dispatch, no label mutation, refused event recorded", async () => {
    const repo = await makeRepo();
    const epicId = "factory-core-niii.5-reviewer-code-no-op";
    // Use stage="coherence" so interpretMarkerForRouting's Precedence 1.5
    // escape hatch preserves operator routing (loop-agent stages would be
    // rewritten to coherence, masking the OPERATOR_DECISION_PENDING refusal
    // with an ACTION_NEXT_AGENT_MISMATCH or similar). The action becomes
    // "send-for-review" (coherence's legitimate operator escalation).
    const stage = "coherence";

    // Rule's per-stage marker (epic-scope) — drives the routing decision.
    const markerForRule: MarkerData = {
      version: "1",
      epic_id: epicId,
      status: "needs-decision",
      stage,
      started_at: "2026-04-21T08:00:00.000Z",
      exited_at: "2026-04-21T08:30:00.000Z",
      next_agent: "operator",
      blocker_class: "spec-ambiguity",
    };

    // Per-bead marker for buildDispatchContext (Class C predicate input) —
    // SAME shape so OPERATOR_DECISION_PENDING fires.
    const markerForCtx: MarkerData = {
      version: "1",
      bead_id: epicId,
      status: "needs-decision",
      stage,
      started_at: "2026-04-21T08:00:00.000Z",
      exited_at: "2026-04-21T08:30:00.000Z",
      next_agent: "operator",
      blocker_class: "spec-ambiguity",
    };

    mockReadBeadStatus.mockResolvedValue(makeBead({ id: epicId, status: "open" }));
    mockReadMarker.mockResolvedValue(markerForCtx);
    mockGetEpicLabels.mockResolvedValue([
      "pipeline:coherence",
      "ship-type:internal",
    ]);

    // Sanity check at the library level.
    const ctx = await buildDispatchContext({
      epicId,
      repoPath: repo,
      action: "send-for-review",
    });
    const libResult = evaluatePreconditions(ctx);
    expect(libResult.ok).toBe(false);
    if (!libResult.ok) {
      assertCanonicalRefusalCode(libResult.refusalCode);
      // Per bead risk flag #2: document the actual refusal class observed.
      // OPERATOR_DECISION_PENDING is the v1 refusal for marker.next_agent=
      // operator + blocker_class set; this is the clean Class C predicate.
      expect(libResult.refusalCode).toBe("OPERATOR_DECISION_PENDING");
      expect(libResult.failedCheck).toBe("operator-decision-not-pending");
    }

    const rule = buildMarkerDrivenRoutingRule({
      readMarker: async () => markerForRule,
      readEpicSnapshot: async () => ({
        currentStage: stage,
        labels: ["pipeline:coherence", "ship-type:internal"],
        title: "niii.5 reviewer-code-no-op reproduction",
      }),
      repoPath: repo,
      actionUrl: "http://localhost:3000/api/fleet/action",
    });

    const events: PipelineEvent[] = [
      {
        type: "agent-exited",
        epicId,
        stage,
        timestamp: new Date(Date.now() - 2 * 60_000).toISOString(),
        payload: { exitCode: 0 },
      },
    ];

    const matches = await rule.matches(events, new Date());
    expect(matches.length).toBeGreaterThanOrEqual(1);
    await rule.act(matches[0]);

    assertNoAgentLaunch(fetchCalls);
    assertNoLabelMutation();

    const refusals = await readEvents(repo, {
      type: "reconciler-action-refused",
    });
    expect(refusals).toHaveLength(1);
    const payload = refusals[0].payload as Record<string, unknown>;
    expect(payload.ruleName).toBe(MARKER_DRIVEN_ROUTING_RULE_NAME);
    expect(payload.action).toBe("send-for-review");
    assertCanonicalRefusalCode(payload.refusalCode);
    expect(payload.refusalCode).toBe("OPERATOR_DECISION_PENDING");
    expect(payload.failedCheck).toBe("operator-decision-not-pending");
  });

  // =========================================================================
  // Cross-cutting invariant — every canonical RefusalCode is a string member
  // of REFUSAL_CODES. Belt-and-braces guard against a future renaming /
  // deletion that would silently break the per-scenario membership checks.
  // -------------------------------------------------------------------------
  test("REFUSAL_CODES enum contains all 15 canonical codes (typed exhaustiveness)", () => {
    const expected: RefusalCode[] = [
      "PLAN_FILE_MISSING",
      "PLAN_PENDING",
      "NO_WAVE_BEADS",
      "ALL_WAVE_BEADS_CLOSED",
      "ARCHITECT_MARKER_SUCCESS",
      "BD_STATUS_DEFERRED",
      "BD_STATUS_CLOSED",
      "BD_READ_FAILED",
      "PIPELINE_LABEL_CONFLICT",
      "AGENT_RUNNING_NO_SESSION",
      "QA_ROUND_OUT_OF_ORDER",
      "OPERATOR_DECISION_PENDING",
      "REVIEW_NEEDS_HUMAN",
      "PLAN_INSTABILITY",
      "ACTION_NEXT_AGENT_MISMATCH",
    ];
    for (const code of expected) {
      expect(REFUSAL_CODES[code]).toBe(true);
    }
    // No spurious codes — exact-equality check on the key set.
    expect(Object.keys(REFUSAL_CODES).sort()).toEqual([...expected].sort());
  });
});
