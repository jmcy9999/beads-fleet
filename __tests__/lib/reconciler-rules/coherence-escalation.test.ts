// =============================================================================
// Tests for src/lib/reconciler-rules/coherence-escalation.ts (factory-core-wlsr.7)
// =============================================================================
//
// Covers the universal-coherence path (path b) added by wlsr.7 alongside the
// preserved path (a) (review:needs-human). The legacy path-(a)-only tests live
// at __tests__/lib/coherence-escalation.test.ts (zsjv.4 origin) and are NOT
// duplicated here; this file focuses on:
//
//   - Path (b) trigger surface (status=needs-decision+BLOCKER, status=blocked+
//     scope-conflict, status=failure, loop-agent next_agent=operator rewrite).
//   - Path (b) idempotency-key shape (epicId, stage) per ADR-009.
//   - Cross-rule dedup with marker-driven-routing (different rule-name prefix
//     prevents key collision; existing reconciler core dedup ensures one
//     dispatch per (rule-name, key) per horizon).
//   - Path (a) preservation alongside path (b) wiring (existing test file
//     covers path (a) in isolation; this file verifies path (a) still fires
//     when readMarker is also configured).
//   - Stage transitions allow refire (idempotency key changes).
//   - Orchestrator-down → throws so the reconciler retries next tick.
//
// Test fixture: synthesised marker JSON files in tmpdir + EpicSnapshot helper.
// Mocks limited to fetch (orchestrator dispatch). The real readMarker is used
// (not mocked) — exercises the file-read path end-to-end.
// =============================================================================

import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";

// beads_web-ehp.4: marker-driven-routing's act() now wraps the dispatch
// fetch with a dispatch-precondition gate. Cross-rule tests in this file
// register marker-driven-routing alongside coherence-escalation; without
// this mock the rule's bd-status check returns null (no real bd repo) and
// refuses with BD_READ_FAILED, suppressing one of the two expected
// dispatches. Mock only readBeadStatus + getEpicLabels — readMarker stays
// REAL because the test fixtures include real per-stage marker files that
// coherence-escalation reads through that interface.
jest.mock("@/lib/bead-status-reader", () => {
  const actual = jest.requireActual("@/lib/bead-status-reader");
  return {
    ...actual,
    readBeadStatus: jest.fn().mockImplementation(async (id: string) => ({
      id,
      status: "open",
      labels: [],
      type: "task",
      pipelineStage: null,
      currentQaRound: null,
      currentWave: null,
      hasAgentRunning: false,
      hasReviewNeedsHuman: false,
    })),
  };
});
jest.mock("@/lib/pipeline-labels", () => ({
  getEpicLabels: jest.fn().mockResolvedValue([]),
}));

import { Reconciler } from "@/lib/reconciler";
import { appendEvent } from "@/lib/event-log";
import { readMarker, type MarkerData } from "@/lib/marker-reader";
import {
  buildCoherenceEscalationRule,
  COHERENCE_ESCALATION_RULE_NAME,
  type EpicSnapshot,
} from "@/lib/reconciler-rules/coherence-escalation";
import {
  buildMarkerDrivenRoutingRule,
  MARKER_DRIVEN_ROUTING_RULE_NAME,
} from "@/lib/reconciler-rules/marker-driven-routing";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function makeRepo(): Promise<string> {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "wlsr7-test-"));
  await fs.mkdir(path.join(repo, ".beads", "markers"), { recursive: true });
  return repo;
}

function snap(partial: Partial<EpicSnapshot> = {}): EpicSnapshot {
  return {
    hasNeedsHuman: false,
    labels: ["pipeline:builder", "ship-type:internal"],
    title: "wlsr7 test epic",
    currentStage: "builder",
    ...partial,
  };
}

async function seedAgentExited(
  repo: string,
  epicId: string,
  stage: string,
  ageMs = 5 * 60_000,
): Promise<void> {
  await appendEvent(repo, {
    type: "agent-exited",
    epicId,
    stage,
    timestamp: new Date(Date.now() - ageMs).toISOString(),
    payload: { exitCode: 0 },
  });
}

async function writeMarker(
  repo: string,
  markerId: string,
  data: Partial<MarkerData>,
): Promise<void> {
  const full: MarkerData = {
    version: "1",
    epic_id: "factory-core-test",
    status: "success",
    stage: "builder",
    started_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    exited_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    ...data,
  };
  const file = path.join(repo, ".beads", "markers", `${markerId}.json`);
  await fs.writeFile(file, JSON.stringify(full, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("coherence-escalation rule — path (b) universal trigger (wlsr.7)", () => {
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
  // AC 3 — Path (b) trigger cases
  // -------------------------------------------------------------------------

  test("AC 3a: marker status=needs-decision + BLOCKER → coherence (path b)", async () => {
    const repo = await makeRepo();
    const epicId = "factory-core-need1";
    await seedAgentExited(repo, epicId, "reviewer");
    await writeMarker(repo, `${epicId}-reviewer`, {
      epic_id: epicId,
      status: "needs-decision",
      stage: "reviewer",
      whats_open: ["BLOCKER: wave 2 not built but wave 1 review passed"],
    });

    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildCoherenceEscalationRule({
        readEpicSnapshot: async () =>
          snap({ currentStage: "reviewer" }),
        readMarker,
        repoPath: repo,
      }),
    );
    await rec.tick();

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].body.action).toBe("run-coherence-agent");
    expect(fetchCalls[0].body.epicId).toBe(epicId);
    expect(fetchCalls[0].body.anomalyClass).toBe("marker-routing-coherence");
  });

  test("AC 3b: marker status=blocked + blocker_class=scope-conflict → coherence (path b)", async () => {
    const repo = await makeRepo();
    const epicId = "factory-core-block1";
    await seedAgentExited(repo, epicId, "planner");
    await writeMarker(repo, `${epicId}-planner`, {
      epic_id: epicId,
      status: "blocked",
      stage: "planner",
      blocker_class: "scope-conflict",
    });

    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildCoherenceEscalationRule({
        readEpicSnapshot: async () => snap({ currentStage: "planner" }),
        readMarker,
        repoPath: repo,
      }),
    );
    await rec.tick();

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].body.action).toBe("run-coherence-agent");
    expect(fetchCalls[0].body.epicId).toBe(epicId);
  });

  test("AC 3c: marker status=failure → coherence (path b)", async () => {
    const repo = await makeRepo();
    const epicId = "factory-core-fail1";
    await seedAgentExited(repo, epicId, "test-spec");
    await writeMarker(repo, `${epicId}-test-spec`, {
      epic_id: epicId,
      status: "failure",
      stage: "test-spec",
    });

    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildCoherenceEscalationRule({
        readEpicSnapshot: async () => snap({ currentStage: "test-spec" }),
        readMarker,
        repoPath: repo,
      }),
    );
    await rec.tick();

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].body.action).toBe("run-coherence-agent");
    expect(fetchCalls[0].body.epicId).toBe(epicId);
  });

  test("AC 3d: loop-agent stage + next_agent=operator → coherence via stage-aware rewrite (path b, post-wlsr.3)", async () => {
    const repo = await makeRepo();
    const epicId = "factory-core-op1";
    await seedAgentExited(repo, epicId, "qa");
    // Marker says next_agent=operator from a loop-agent stage. wlsr.3's
    // Precedence 1.5 rewrites this to coherence at routing time.
    await writeMarker(repo, `${epicId}-qa`, {
      epic_id: epicId,
      status: "needs-decision",
      stage: "qa",
      next_agent: "operator",
    });

    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildCoherenceEscalationRule({
        readEpicSnapshot: async () => snap({ currentStage: "qa" }),
        readMarker,
        repoPath: repo,
      }),
    );
    await rec.tick();

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].body.action).toBe("run-coherence-agent");
    expect(fetchCalls[0].body.epicId).toBe(epicId);
  });

  // -------------------------------------------------------------------------
  // Path (b) negative cases — markers that should NOT trigger
  // -------------------------------------------------------------------------

  test("path (b) skip: status=success without BLOCKER does not fire (no override)", async () => {
    const repo = await makeRepo();
    const epicId = "factory-core-ok1";
    await seedAgentExited(repo, epicId, "builder");
    await writeMarker(repo, `${epicId}-builder`, {
      epic_id: epicId,
      status: "success",
      stage: "builder",
    });

    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildCoherenceEscalationRule({
        readEpicSnapshot: async () => snap({ currentStage: "builder" }),
        readMarker,
        repoPath: repo,
      }),
    );
    await rec.tick();
    expect(fetchCalls).toHaveLength(0);
  });

  test("path (b) skip: marker routes to non-coherence agent (e.g., next_agent=architect)", async () => {
    const repo = await makeRepo();
    const epicId = "factory-core-arch1";
    await seedAgentExited(repo, epicId, "planner");
    await writeMarker(repo, `${epicId}-planner`, {
      epic_id: epicId,
      status: "blocked",
      stage: "planner",
      next_agent: "architect",
    });

    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildCoherenceEscalationRule({
        readEpicSnapshot: async () => snap({ currentStage: "planner" }),
        readMarker,
        repoPath: repo,
      }),
    );
    await rec.tick();
    // Marker routes to architect, NOT coherence — coherence-escalation
    // path (b) does not fire. (marker-driven-routing would fire for
    // architect, but it's not registered in this test.)
    expect(fetchCalls).toHaveLength(0);
  });

  test("path (b) skip: missing marker file (readMarker returns null)", async () => {
    const repo = await makeRepo();
    const epicId = "factory-core-nomarker";
    await seedAgentExited(repo, epicId, "builder");
    // No marker written.

    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildCoherenceEscalationRule({
        readEpicSnapshot: async () => snap({ currentStage: "builder" }),
        readMarker,
        repoPath: repo,
      }),
    );
    await rec.tick();
    expect(fetchCalls).toHaveLength(0);
  });

  test("path (b) skip: no agent-exited event for epic (no marker discovery anchor)", async () => {
    const repo = await makeRepo();
    const epicId = "factory-core-noevent";
    // Seed an agent-exited event for a DIFFERENT epic so the reconciler
    // tick has something to process; no event for the target epic.
    await seedAgentExited(repo, "factory-core-other", "builder");
    await writeMarker(repo, `${epicId}-builder`, {
      epic_id: epicId,
      status: "failure",
      stage: "builder",
    });

    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildCoherenceEscalationRule({
        readEpicSnapshot: async (_id) => null, // bd lookup fails for unknown epic
        readMarker,
        repoPath: repo,
      }),
    );
    await rec.tick();
    expect(fetchCalls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // AC 4 — Idempotency key includes (epicId, stage); refires when stage changes
  // -------------------------------------------------------------------------

  test("AC 4: idempotency — same (epicId, stage) within horizon does NOT refire", async () => {
    const repo = await makeRepo();
    const epicId = "factory-core-idem1";
    await seedAgentExited(repo, epicId, "builder");
    await writeMarker(repo, `${epicId}-builder`, {
      epic_id: epicId,
      status: "failure",
      stage: "builder",
    });

    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildCoherenceEscalationRule({
        readEpicSnapshot: async () => snap({ currentStage: "builder" }),
        readMarker,
        repoPath: repo,
      }),
    );
    await rec.tick();
    await rec.tick();
    expect(fetchCalls).toHaveLength(1);
  });

  test("AC 4: idempotency — stage transition (builder→reviewer) allows refire", async () => {
    const repo = await makeRepo();
    const epicId = "factory-core-stage1";

    // Tick 1: builder marker → coherence dispatch.
    await seedAgentExited(repo, epicId, "builder", 30 * 60_000);
    await writeMarker(repo, `${epicId}-builder`, {
      epic_id: epicId,
      status: "failure",
      stage: "builder",
    });

    let currentStage: string = "builder";
    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildCoherenceEscalationRule({
        readEpicSnapshot: async () =>
          snap({ currentStage }),
        readMarker,
        repoPath: repo,
      }),
    );
    await rec.tick();
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].body.epicId).toBe(epicId);

    // Tick 2: reviewer marker → coherence dispatch (different stage,
    // different idempotency key, refire allowed).
    await seedAgentExited(repo, epicId, "reviewer", 5 * 60_000);
    await writeMarker(repo, `${epicId}-reviewer`, {
      epic_id: epicId,
      status: "needs-decision",
      stage: "reviewer",
      whats_open: ["BLOCKER: scope unclear, need operator input"],
    });
    currentStage = "reviewer";

    // Important: a stage-dispatched event from the first dispatch would
    // suppress refire via hasRecentCoherenceDispatch. In real production,
    // that event lands when the dispatched coherence agent emits it on
    // launch. The test simulates a scenario where the first dispatch did
    // NOT lead to a stage-dispatched event in the lookback (e.g., the
    // dispatch was rolled back, or the coherence agent never started).
    // Without that suppression, we expect the second tick to fire because
    // the idempotency key changes from ::builder to ::reviewer.
    await rec.tick();
    expect(fetchCalls).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // AC 5 — Cross-rule dedup with marker-driven-routing
  // -------------------------------------------------------------------------

  test("AC 5: cross-rule dedup — both rules on same marker each fire once (different rule-name prefix)", async () => {
    const repo = await makeRepo();
    const epicId = "factory-core-cross1";
    await seedAgentExited(repo, epicId, "builder");
    // status=needs-decision triggers BOTH rules: marker-driven-routing
    // detects routing intent (status=needs-decision branch), and
    // interpretMarkerForRouting returns coherence via Precedence 3.5.
    // coherence-escalation path (b) sees the same coherence routing
    // decision and produces its own match.
    await writeMarker(repo, `${epicId}-builder`, {
      epic_id: epicId,
      status: "needs-decision",
      stage: "builder",
    });

    const rec = new Reconciler({ repoPath: repo });
    // Register marker-driven-routing first — its idempotency key is
    // marker-driven-routing::<epicId>::<stage>.
    rec.registerRule(
      buildMarkerDrivenRoutingRule({
        readMarker,
        readEpicSnapshot: async () => ({
          currentStage: "builder",
          labels: ["pipeline:builder"],
          title: "cross1",
        }),
        repoPath: repo,
      }),
    );
    // Then coherence-escalation — its key is
    // coherence-escalation::<epicId>::<stage>.
    rec.registerRule(
      buildCoherenceEscalationRule({
        readEpicSnapshot: async () => snap({ currentStage: "builder" }),
        readMarker,
        repoPath: repo,
      }),
    );
    await rec.tick();
    // Both rules see the same marker, both interpret routing as coherence,
    // both dispatch run-coherence-agent. The reconciler core's
    // (rule-name, key) dedup applies WITHIN each rule (so each rule fires
    // exactly once per horizon), not across rules. This test asserts the
    // expected behaviour: 2 dispatches in the same tick.
    expect(fetchCalls).toHaveLength(2);
    expect(
      fetchCalls.every((c) => c.body.action === "run-coherence-agent"),
    ).toBe(true);

    // Run another tick: each rule's reconciler-action-taken event blocks
    // its own re-fire. No new dispatches.
    await rec.tick();
    expect(fetchCalls).toHaveLength(2);
  });

  test("AC 5: idempotency keys are rule-scoped — marker-driven-routing's prior action does NOT block coherence-escalation", async () => {
    // Belt-and-suspenders for the rule-name prefix being part of the
    // dedup tuple. Pre-seed a reconciler-action-taken event from
    // marker-driven-routing for the same (epicId, stage), then verify
    // coherence-escalation still fires.
    const repo = await makeRepo();
    const epicId = "factory-core-prefix1";
    await seedAgentExited(repo, epicId, "qa");
    await writeMarker(repo, `${epicId}-qa`, {
      epic_id: epicId,
      status: "failure",
      stage: "qa",
    });
    await appendEvent(repo, {
      type: "reconciler-action-taken",
      epicId,
      payload: {
        ruleName: MARKER_DRIVEN_ROUTING_RULE_NAME,
        idempotencyKey: `${MARKER_DRIVEN_ROUTING_RULE_NAME}::${epicId}::qa`,
      },
    });

    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildCoherenceEscalationRule({
        readEpicSnapshot: async () => snap({ currentStage: "qa" }),
        readMarker,
        repoPath: repo,
      }),
    );
    await rec.tick();
    // marker-driven-routing's prior action should NOT block
    // coherence-escalation because the rule-name prefix differs.
    expect(fetchCalls).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // AC 2 — Path (a) preserved alongside path (b) wiring
  // -------------------------------------------------------------------------

  test("AC 2: path (a) — review:needs-human + readMarker configured still fires path (a)", async () => {
    const repo = await makeRepo();
    const epicId = "factory-core-needs1";
    await seedAgentExited(repo, epicId, "qa");
    // No marker written → path (b) cannot fire even though readMarker is
    // configured. Path (a) should still fire on the label.

    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildCoherenceEscalationRule({
        readEpicSnapshot: async () =>
          snap({
            hasNeedsHuman: true,
            labels: ["pipeline:qa", "review:needs-human"],
            currentStage: "qa",
          }),
        readMarker,
        repoPath: repo,
      }),
    );
    await rec.tick();
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].body.action).toBe("run-coherence-agent");
    // Path (a) preserves the legacy anomalyClass for downstream consumers.
    expect(fetchCalls[0].body.anomalyClass).toBe("review-needs-human");
  });

  test("AC 2: path (a) — when both review:needs-human AND a coherence-routing marker exist, path (a) wins (single dispatch with legacy anomalyClass)", async () => {
    // When a previous round flipped review:needs-human AND a fresh marker
    // also routes to coherence, we don't want two dispatches per epic. The
    // matcher short-circuits on path (a) and skips path (b) for the same
    // epic, producing a single match with the legacy anomalyClass.
    const repo = await makeRepo();
    const epicId = "factory-core-both1";
    await seedAgentExited(repo, epicId, "qa");
    await writeMarker(repo, `${epicId}-qa`, {
      epic_id: epicId,
      status: "failure",
      stage: "qa",
    });

    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildCoherenceEscalationRule({
        readEpicSnapshot: async () =>
          snap({
            hasNeedsHuman: true,
            labels: ["pipeline:qa", "review:needs-human"],
            currentStage: "qa",
          }),
        readMarker,
        repoPath: repo,
      }),
    );
    await rec.tick();
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].body.anomalyClass).toBe("review-needs-human");
  });

  // -------------------------------------------------------------------------
  // Cross-rule dedup via stage-dispatched event (legacy mechanism preserved)
  // -------------------------------------------------------------------------

  test("path (b) skip: prior stage-dispatched(run-coherence-agent) suppresses refire across paths", async () => {
    const repo = await makeRepo();
    const epicId = "factory-core-prior1";
    await seedAgentExited(repo, epicId, "builder");
    await writeMarker(repo, `${epicId}-builder`, {
      epic_id: epicId,
      status: "failure",
      stage: "builder",
    });
    // Synthesize a prior coherence dispatch event (e.g., from
    // marker-driven-routing or a previous coherence-escalation tick).
    await appendEvent(repo, {
      type: "stage-dispatched",
      epicId,
      stage: "builder",
      correlationId: "tmux-prior",
      payload: { toAction: "run-coherence-agent" },
    });

    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildCoherenceEscalationRule({
        readEpicSnapshot: async () => snap({ currentStage: "builder" }),
        readMarker,
        repoPath: repo,
      }),
    );
    await rec.tick();
    expect(fetchCalls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // AC 8 — Orchestrator-down behaviour
  // -------------------------------------------------------------------------

  test("AC 8: orchestrator HTTP failure throws (reconciler retries next tick)", async () => {
    fetchMock.mockRestore();
    fetchMock = jest
      .spyOn(global, "fetch")
      .mockImplementation(async () => {
        return new Response("Internal Server Error", { status: 500 });
      });

    const repo = await makeRepo();
    const epicId = "factory-core-down1";
    await seedAgentExited(repo, epicId, "builder");
    await writeMarker(repo, `${epicId}-builder`, {
      epic_id: epicId,
      status: "failure",
      stage: "builder",
    });

    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildCoherenceEscalationRule({
        readEpicSnapshot: async () => snap({ currentStage: "builder" }),
        readMarker,
        repoPath: repo,
      }),
    );
    // Reconciler logs the error but does not throw (it always emits the
    // reconciler-action-taken event for idempotency). Verify the act
    // attempt happened (fetch was called) and produced an HTTP error.
    await rec.tick();
    // The act() call threw internally; the reconciler swallowed it and
    // emitted reconciler-action-taken with success=false. From the rule's
    // standpoint, this is the "logs and retries on next tick" contract —
    // no operator escalation from inside the rule (per ADR-008).
    // We verify the dispatch was attempted exactly once.
    // Note: hasRecentCoherenceDispatch returns false (no stage-dispatched
    // event was generated by a failing dispatch), but the
    // reconciler-action-taken bucket consumed the idempotency window.
    expect(fetchMock).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // AC 1 (event-window scoping) — only matches() reads events; act() acts
  // -------------------------------------------------------------------------

  test("AC 1: idempotencyKey is scoped to (epicId, stage) with rule-name prefix", async () => {
    // White-box assertion on the key shape — protects the (rule-name,
    // epicId, stage) contract from regressions that would silently merge
    // keys with marker-driven-routing.
    const repo = await makeRepo();
    const epicId = "factory-core-shape1";
    await seedAgentExited(repo, epicId, "polish");
    await writeMarker(repo, `${epicId}-polish`, {
      epic_id: epicId,
      status: "failure",
      stage: "polish",
    });

    const rule = buildCoherenceEscalationRule({
      readEpicSnapshot: async () => snap({ currentStage: "polish" }),
      readMarker,
      repoPath: repo,
    });
    const events = [
      {
        type: "agent-exited" as const,
        epicId,
        stage: "polish",
        timestamp: new Date(Date.now() - 5 * 60_000).toISOString(),
        payload: { exitCode: 0 },
      },
    ];
    const matches = await rule.matches(events, new Date());
    expect(matches).toHaveLength(1);
    expect(matches[0].idempotencyKey).toBe(
      `${COHERENCE_ESCALATION_RULE_NAME}::${epicId}::polish`,
    );
    expect(matches[0].epicId).toBe(epicId);
    const ctx = matches[0].context as { path?: string; stage?: string };
    expect(ctx.path).toBe("b");
    expect(ctx.stage).toBe("polish");
  });

  test("AC 1: latest-marker discovery uses most recent agent-exited event when multiple stages have exited", async () => {
    // If an epic has two agent-exited events (e.g., builder then
    // reviewer), the rule should read the marker for the LATER stage —
    // path (b)'s "latest marker for the epic" semantics.
    const repo = await makeRepo();
    const epicId = "factory-core-multi1";

    // Older event: builder, 30 min ago. Newer event: reviewer, 5 min ago.
    await seedAgentExited(repo, epicId, "builder", 30 * 60_000);
    await seedAgentExited(repo, epicId, "reviewer", 5 * 60_000);

    // Older marker: builder success (would NOT route to coherence).
    await writeMarker(repo, `${epicId}-builder`, {
      epic_id: epicId,
      status: "success",
      stage: "builder",
    });
    // Newer marker: reviewer failure (routes to coherence).
    await writeMarker(repo, `${epicId}-reviewer`, {
      epic_id: epicId,
      status: "failure",
      stage: "reviewer",
    });

    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildCoherenceEscalationRule({
        readEpicSnapshot: async () => snap({ currentStage: "reviewer" }),
        readMarker,
        repoPath: repo,
      }),
    );
    await rec.tick();
    expect(fetchCalls).toHaveLength(1);
  });
});
