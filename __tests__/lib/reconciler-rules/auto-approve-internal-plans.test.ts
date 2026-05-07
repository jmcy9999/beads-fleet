// =============================================================================
// beads_web-poh.13 Option A — Tests for auto-approve-internal-plans
// =============================================================================
// Covers the bead's three acceptance criteria:
//
//   AC1: GIVEN [ship-type:internal, pipeline:plan-review, plan:pending] AND a
//        test-spec marker with status=success exists, WHEN the reconciler
//        ticks, THEN action=approve-plan is dispatched.
//
//   AC2: GIVEN [ship-type:wordpress-plugin, pipeline:plan-review, plan:pending]
//        WHEN the reconciler ticks, THEN action=approve-plan is NOT dispatched
//        (gated to internal).
//
//   AC3: GIVEN approve-plan was already dispatched (plan:approved present)
//        WHEN the reconciler ticks, THEN no duplicate dispatch fires
//        (idempotency on per-epic basis — both via labels and via the
//        reconciler-core's reconciler-action-taken dedupe).
//
// Plus defensive cases: missing test-spec marker, marker with non-success
// status, getEpicLabels failure, no agent-exited event for the epic.
// =============================================================================

import {
  buildAutoApproveInternalPlansRule,
  AUTO_APPROVE_INTERNAL_PLANS_RULE_NAME,
} from "@/lib/reconciler-rules/auto-approve-internal-plans";
import type { MarkerData } from "@/lib/marker-reader";
import type { PipelineEvent } from "@/lib/event-log";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTestSpecExitEvent(epicId: string): PipelineEvent {
  return {
    type: "agent-exited",
    epicId,
    stage: "test-spec",
    correlationId: `test-${epicId}`,
    timestamp: new Date().toISOString(),
    payload: { exitCode: 0 },
  };
}

function makeTestSpecMarker(
  overrides: Partial<MarkerData> = {},
): MarkerData {
  return {
    version: "1",
    epic_id: "factory-core-test",
    status: "success",
    stage: "test-spec",
    started_at: new Date().toISOString(),
    exited_at: new Date().toISOString(),
    ...overrides,
  };
}

const REPO = "/tmp/auto-approve-tests";
const ACTION_URL = "http://localhost:3000/api/fleet/action";

describe("auto-approve-internal-plans (beads_web-poh.13 Option A)", () => {
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
          return new Response(JSON.stringify({ success: true }), {
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
  // AC1 — happy path: internal epic with plan:pending and successful
  // test-spec marker → approve-plan fires.
  // -------------------------------------------------------------------------

  test("AC1 — internal epic with plan:pending + test-spec success marker → approve-plan fires", async () => {
    const epicId = "factory-core-int";
    const rule = buildAutoApproveInternalPlansRule({
      repoPath: REPO,
      actionUrl: ACTION_URL,
      getEpicLabels: async () => [
        "ship-type:internal",
        "pipeline:plan-review",
        "plan:pending",
      ],
      readMarker: async () => makeTestSpecMarker({ epic_id: epicId }),
    });

    const matches = await rule.matches([makeTestSpecExitEvent(epicId)], new Date());
    expect(matches).toHaveLength(1);
    expect(matches[0].epicId).toBe(epicId);
    expect(matches[0].idempotencyKey).toBe(
      `${AUTO_APPROVE_INTERNAL_PLANS_RULE_NAME}::${epicId}`,
    );

    await rule.act(matches[0]);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].body.action).toBe("approve-plan");
    expect(fetchCalls[0].body.epicId).toBe(epicId);
  });

  // -------------------------------------------------------------------------
  // AC2 — non-internal ship types are NOT auto-approved.
  // -------------------------------------------------------------------------

  test("AC2 — wordpress-plugin epic with plan:pending → approve-plan NOT dispatched (gate to internal)", async () => {
    const epicId = "factory-core-wp";
    const rule = buildAutoApproveInternalPlansRule({
      repoPath: REPO,
      actionUrl: ACTION_URL,
      getEpicLabels: async () => [
        "ship-type:wordpress-plugin",
        "pipeline:plan-review",
        "plan:pending",
      ],
      readMarker: async () => makeTestSpecMarker({ epic_id: epicId }),
    });

    const matches = await rule.matches([makeTestSpecExitEvent(epicId)], new Date());
    expect(matches).toHaveLength(0);
  });

  test("AC2 — ios-app epic with plan:pending → approve-plan NOT dispatched", async () => {
    const epicId = "factory-core-ios";
    const rule = buildAutoApproveInternalPlansRule({
      repoPath: REPO,
      actionUrl: ACTION_URL,
      getEpicLabels: async () => [
        "ship-type:ios-app",
        "pipeline:plan-review",
        "plan:pending",
      ],
      readMarker: async () => makeTestSpecMarker({ epic_id: epicId }),
    });

    const matches = await rule.matches([makeTestSpecExitEvent(epicId)], new Date());
    expect(matches).toHaveLength(0);
  });

  test("AC2 — ship-type label entirely missing → approve-plan NOT dispatched (no implicit defaulting)", async () => {
    const epicId = "factory-core-noship";
    const rule = buildAutoApproveInternalPlansRule({
      repoPath: REPO,
      actionUrl: ACTION_URL,
      getEpicLabels: async () => ["pipeline:plan-review", "plan:pending"],
      readMarker: async () => makeTestSpecMarker({ epic_id: epicId }),
    });

    const matches = await rule.matches([makeTestSpecExitEvent(epicId)], new Date());
    expect(matches).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // AC3 — idempotency: don't double-fire after plan:approved lands.
  // -------------------------------------------------------------------------

  test("AC3 — plan:approved already present → approve-plan NOT re-dispatched", async () => {
    const epicId = "factory-core-already";
    const rule = buildAutoApproveInternalPlansRule({
      repoPath: REPO,
      actionUrl: ACTION_URL,
      getEpicLabels: async () => [
        "ship-type:internal",
        "pipeline:plan-review",
        "plan:pending", // somehow still here
        "plan:approved", // but already approved
      ],
      readMarker: async () => makeTestSpecMarker({ epic_id: epicId }),
    });

    const matches = await rule.matches([makeTestSpecExitEvent(epicId)], new Date());
    expect(matches).toHaveLength(0);
  });

  test("AC3 — plan:pending absent (already cleared) → approve-plan NOT re-dispatched", async () => {
    const epicId = "factory-core-cleared";
    const rule = buildAutoApproveInternalPlansRule({
      repoPath: REPO,
      actionUrl: ACTION_URL,
      getEpicLabels: async () => [
        "ship-type:internal",
        "pipeline:plan-review",
        "plan:approved",
      ],
      readMarker: async () => makeTestSpecMarker({ epic_id: epicId }),
    });

    const matches = await rule.matches([makeTestSpecExitEvent(epicId)], new Date());
    expect(matches).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Defensive cases.
  // -------------------------------------------------------------------------

  test("test-spec marker MISSING → no dispatch (rubber-stamp requires verified test-spec output)", async () => {
    const epicId = "factory-core-nomarker";
    const rule = buildAutoApproveInternalPlansRule({
      repoPath: REPO,
      actionUrl: ACTION_URL,
      getEpicLabels: async () => [
        "ship-type:internal",
        "pipeline:plan-review",
        "plan:pending",
      ],
      readMarker: async () => null, // no marker
    });

    const matches = await rule.matches([makeTestSpecExitEvent(epicId)], new Date());
    expect(matches).toHaveLength(0);
  });

  test("test-spec marker status != success → no dispatch (failed test-spec means the plan needs revision, not approval)", async () => {
    const epicId = "factory-core-failed";
    const rule = buildAutoApproveInternalPlansRule({
      repoPath: REPO,
      actionUrl: ACTION_URL,
      getEpicLabels: async () => [
        "ship-type:internal",
        "pipeline:plan-review",
        "plan:pending",
      ],
      readMarker: async () =>
        makeTestSpecMarker({ epic_id: epicId, status: "blocked" }),
    });

    const matches = await rule.matches([makeTestSpecExitEvent(epicId)], new Date());
    expect(matches).toHaveLength(0);
  });

  test("no agent-exited event for the epic → no dispatch (event-based discovery only)", async () => {
    const epicId = "factory-core-nopath";
    const rule = buildAutoApproveInternalPlansRule({
      repoPath: REPO,
      actionUrl: ACTION_URL,
      getEpicLabels: async () => [
        "ship-type:internal",
        "pipeline:plan-review",
        "plan:pending",
      ],
      readMarker: async () => makeTestSpecMarker({ epic_id: epicId }),
    });

    // Empty events array — even though the labels + marker would
    // qualify, no recent test-spec exit means no trigger.
    const matches = await rule.matches([], new Date());
    expect(matches).toHaveLength(0);
  });

  test("agent-exited event for a different stage (e.g. planner) → no dispatch", async () => {
    const epicId = "factory-core-wrongstage";
    const rule = buildAutoApproveInternalPlansRule({
      repoPath: REPO,
      actionUrl: ACTION_URL,
      getEpicLabels: async () => [
        "ship-type:internal",
        "pipeline:plan-review",
        "plan:pending",
      ],
      readMarker: async () => makeTestSpecMarker({ epic_id: epicId }),
    });

    const plannerExit: PipelineEvent = {
      type: "agent-exited",
      epicId,
      stage: "planner",
      correlationId: "wrong-stage",
      timestamp: new Date().toISOString(),
      payload: {},
    };
    const matches = await rule.matches([plannerExit], new Date());
    expect(matches).toHaveLength(0);
  });

  test("getEpicLabels throwing → epic skipped, no exception (tolerant per other rules)", async () => {
    const epicId = "factory-core-bdfail";
    const warnSpy = jest.spyOn(console, "warn").mockImplementation();

    const rule = buildAutoApproveInternalPlansRule({
      repoPath: REPO,
      actionUrl: ACTION_URL,
      getEpicLabels: async () => {
        throw new Error("bd subprocess timed out");
      },
      readMarker: async () => makeTestSpecMarker({ epic_id: epicId }),
    });

    const matches = await rule.matches(
      [makeTestSpecExitEvent(epicId)],
      new Date(),
    );
    expect(matches).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("getEpicLabels failed"),
      expect.any(String),
    );
    warnSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // act() tolerates HTTP failures gracefully (no throw — rule catches).
  // -------------------------------------------------------------------------

  test("act() tolerates a non-200 from /api/fleet/action — does not throw, logs the failure", async () => {
    fetchMock.mockRestore();
    fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(
      new Response("internal-error", { status: 500 }),
    );

    const epicId = "factory-core-500";
    const rule = buildAutoApproveInternalPlansRule({
      repoPath: REPO,
      actionUrl: ACTION_URL,
      getEpicLabels: async () => [
        "ship-type:internal",
        "pipeline:plan-review",
        "plan:pending",
      ],
      readMarker: async () => makeTestSpecMarker({ epic_id: epicId }),
    });

    const matches = await rule.matches([makeTestSpecExitEvent(epicId)], new Date());
    expect(matches).toHaveLength(1);
    // No throw on HTTP 500 — reconciler core would otherwise log
    // act() threw and not consume the idempotency bucket.
    await expect(rule.act(matches[0])).resolves.toBeUndefined();
  });
});
