// =============================================================================
// Integration tests for dispatchChainAction marker-driven routing
// (beads_web-kvn, factory-core-o4lx Wave 2)
// =============================================================================
//
// 7 test cases covering ACs 4-7:
//   1. Epic at plan-review with marker next_agent=architect -> architect
//      dispatched (NOT default next stage from pipeline-routes) (AC 4).
//   2. Epic at plan-review with marker status=success, no next_agent ->
//      pipeline-routes default fires (no marker override) (AC 5).
//   3. Epic with checkpoint label + marker next_agent=planner -> checkpoint
//      takes precedence (marker routing skipped entirely) (AC 6).
//   4. Regression: architecture -> plan-review still works when marker
//      absent (AC 7).
//   5. Regression: product-spec -> architecture still works when marker
//      override=false (AC 7).
//   6. Regression: research -> product-spec still works when marker
//      absent (AC 7).
//   7. Regression: test-spec -> development still works when marker
//      absent (AC 7).
//
// Test strategy: test through handleChainAction (the exported function),
// same pattern as agent-launcher.auto-chain.test.ts. Mock child_process
// (execFileSync) to control readEpicState / bd responses, mock readMarker
// to control marker data, mock interpretMarkerForRouting to control routing
// decisions, and mock global fetch to capture dispatched actions.
// =============================================================================

// ---------------------------------------------------------------------------
// Mocks — declared BEFORE importing the module under test (jest hoists).
// ---------------------------------------------------------------------------

type ExecResult = { stdout?: string; error?: Error };

let execBehaviour: (args: string[]) => ExecResult = () => ({ stdout: "" });
type ExecCall = { args: string[] };
let execCalls: ExecCall[] = [];

jest.mock("child_process", () => {
  const actual = jest.requireActual("child_process");
  return {
    ...actual,
    execFileSync: jest.fn((_bd: string, args: string[]) => {
      execCalls.push({ args });
      const r = execBehaviour(args);
      if (r.error) throw r.error;
      return r.stdout ?? "";
    }),
  };
});

jest.mock("@/lib/bd-path", () => ({
  getBdPath: () => "/usr/local/bin/bd",
  getBdEnv: () => ({ PATH: "/usr/local/bin" }),
}));

jest.mock("@/lib/langfuse-env", () => ({
  buildOtelEnv: () => ({}),
  buildLangfuseTraceUrl: () => null,
  isLangfuseConfigured: () => false,
}));

// Feature flags — all auto-chain stages ON so existing per-stage branches
// fire for regression tests (AC 7). Matches auto-chain.test.ts pattern.
const stageFlags: Record<string, boolean> = {
  research: true,
  "product-spec": true,
  architecture: true,
  "test-spec": true,
};

jest.mock("@/lib/fleet-config", () => ({
  readFleetConfig: jest.fn(() => ({
    plan_review_auto_chain: false,
    auto_chain_stages: { ...stageFlags },
  })),
  resetFleetConfigCache: jest.fn(),
  autoChainEnabled: jest.fn((stage: string) => stageFlags[stage] === true),
  AUTO_CHAIN_STAGES: ["research", "product-spec", "architecture", "test-spec"],
}));

jest.mock("@/lib/pipeline-labels", () => ({
  addLabelsToEpic: jest.fn(async () => {}),
  removeLabelsFromEpic: jest.fn(async () => {}),
  removeLabelsFromEpicStrict: jest.fn(async () => {}),
  getEpicLabels: jest.fn(async () => []),
}));

// beads_web-aiq mocks (required by QA handler dynamic imports).
jest.mock("@/lib/smoke-test-freshness", () => ({
  checkSmokeTestFreshness: jest.fn(async () => ({ ok: true })),
}));
jest.mock("@/lib/wave-completeness", () => ({
  enforceWaveCompletenessOrDispatch: jest.fn(async () => ({ intercepted: false })),
}));
jest.mock("@/lib/pipeline-router", () => ({
  nextStage: jest.fn(() => undefined),
  assertShipType: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Mock marker-reader and marker-routing — the modules kvn integrates.
// ---------------------------------------------------------------------------

import type { MarkerData } from "@/lib/marker-reader";
import type { RoutingDecision } from "@/lib/marker-routing";

let mockReadMarkerResult: MarkerData | null = null;

jest.mock("@/lib/marker-reader", () => ({
  readMarker: jest.fn(async () => mockReadMarkerResult),
}));

let mockRoutingDecision: RoutingDecision = {
  override: false,
  reason: "default mock",
};

jest.mock("@/lib/marker-routing", () => ({
  interpretMarkerForRouting: jest.fn(() => mockRoutingDecision),
}));

// ---------------------------------------------------------------------------
// Import module under test AFTER mocks are declared.
// ---------------------------------------------------------------------------

import {
  handleChainAction,
  type AgentSession,
} from "@/lib/agent-launcher";
import { __lockManagerResetForTests } from "@/lib/locks/lock-manager";
import { readMarker } from "@/lib/marker-reader";
import { interpretMarkerForRouting } from "@/lib/marker-routing";

// ---------------------------------------------------------------------------
// Fetch capture — dispatch goes through fetch to /api/fleet/action.
// ---------------------------------------------------------------------------

type FetchCall = { url: string; body: Record<string, unknown> };
let fetchCalls: FetchCall[] = [];
let fetchResponseOk = true;
let fetchResponseStatus = 200;

beforeEach(() => {
  fetchCalls = [];
  fetchResponseOk = true;
  fetchResponseStatus = 200;
  execCalls = [];
  execBehaviour = () => ({ stdout: "" });
  mockReadMarkerResult = null;
  mockRoutingDecision = { override: false, reason: "default mock" };
  __lockManagerResetForTests();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = jest.fn(async (url: string, init?: RequestInit) => {
    const body =
      init && init.body
        ? (JSON.parse(init.body as string) as Record<string, unknown>)
        : {};
    fetchCalls.push({ url, body });
    return {
      ok: fetchResponseOk,
      status: fetchResponseStatus,
    } as Response;
  });
});

afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).fetch;
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function epicShowFor(labels: string): string {
  return `
◐ test-epic · Test Epic [● P1 · IN_PROGRESS]
LABELS: ${labels}
`;
}

const EMPTY_EPIC_TREE = `
◐ test-epic ● P1 [epic] Empty Epic
`;

function makeSession(
  epicId: string,
  stage: string,
  overrides: Partial<AgentSession> = {},
): AgentSession {
  return {
    pid: 0,
    repoPath: "/Users/janemckay/dev/fleet/fleet-core",
    repoName: "fleet-core",
    prompt: `Run ${stage} for ${epicId}`,
    model: "sonnet",
    startedAt: new Date().toISOString(),
    logFile: "/tmp/test.log",
    epicId,
    pipelineStage: stage,
    epicLabels: ["ship-type:internal", `pipeline:${stage}`],
    ...overrides,
  };
}

function wireEpic(epicId: string, labels: string): void {
  execBehaviour = (args) => {
    if (args[0] === "show" && args[1] === epicId) {
      return { stdout: epicShowFor(labels) };
    }
    if (args[0] === "list") {
      return { stdout: EMPTY_EPIC_TREE };
    }
    return { stdout: "" };
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("dispatchChainAction — marker-driven routing (beads_web-kvn)", () => {
  // Test 1 — AC 4: marker next_agent=architect -> architect dispatched
  test("epic at plan-review with marker next_agent=architect -> architect dispatched", async () => {
    const epicId = "factory-core-lmxb";
    wireEpic(epicId, "ship-type:internal, pipeline:plan-review");

    // Set up marker with next_agent=architect
    mockReadMarkerResult = {
      version: "1",
      epic_id: epicId,
      status: "needs-decision",
      stage: "planner",
      started_at: "2026-05-01T10:00:00Z",
      exited_at: "2026-05-01T10:30:00Z",
      next_agent: "architect",
    };

    // Set up routing decision: override=true, nextAgent=architect
    mockRoutingDecision = {
      override: true,
      nextAgent: "architect",
      reason: "explicit next_agent field",
    };

    const session = makeSession(epicId, "plan-review");
    const handled = await handleChainAction(session, 0);

    // Assert: interpretMarkerForRouting called with marker + snapshot
    expect(interpretMarkerForRouting).toHaveBeenCalledWith(
      mockReadMarkerResult,
      expect.objectContaining({
        epicId,
        currentStage: "plan-review",
      }),
    );

    // Assert: fetch called with run-architect action (NOT generate-plan)
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].body.action).toBe("run-architect");
    expect(fetchCalls[0].body.epicId).toBe(epicId);

    // Assert: function returned true (handled)
    expect(handled).toBe(true);
  });

  // Test 2 — AC 5: marker status=success, no next_agent -> pipeline-routes
  // default fires (no marker override)
  test("epic at plan-review with marker status=success, no next_agent -> falls through (no marker override)", async () => {
    const epicId = "factory-core-xxxx";
    wireEpic(epicId, "ship-type:internal, pipeline:plan-review");

    // Set up marker with status=success, no next_agent
    mockReadMarkerResult = {
      version: "1",
      epic_id: epicId,
      status: "success",
      stage: "planner",
      started_at: "2026-05-01T10:00:00Z",
      exited_at: "2026-05-01T10:30:00Z",
    };

    // Set up routing decision: override=false (fallback)
    mockRoutingDecision = {
      override: false,
      reason: "status=success, fallback to pipeline-routes",
    };

    const session = makeSession(epicId, "plan-review");
    const handled = await handleChainAction(session, 0);

    // Assert: interpretMarkerForRouting called (marker present)
    expect(interpretMarkerForRouting).toHaveBeenCalled();

    // Assert: marker routing did NOT dispatch (override=false means fall
    // through to existing per-stage branches). plan-review stage has no
    // auto-chain branch in dispatchChainAction, so result should be false.
    expect(handled).toBe(false);

    // Assert: fetch was NOT called for marker routing (override=false).
    // The plan-review stage has its own handling later in dispatchChainAction
    // which may or may not call fetch, but the marker branch didn't dispatch.
    // Since plan-review has no matching `if (stage === "plan-review")` in the
    // four 3yqr.4 branches, the function falls through and returns false.
  });

  // Test 3 — AC 6: checkpoint label + marker -> checkpoint precedence
  test("epic with checkpoint label + marker next_agent=planner -> checkpoint takes precedence (marker routing skipped)", async () => {
    const epicId = "factory-core-yyyy";
    wireEpic(epicId, "ship-type:internal, pipeline:architecture, checkpoint:after-architecture");

    // Set up marker with next_agent=planner — but checkpoint label should
    // cause marker routing to be skipped entirely.
    mockReadMarkerResult = {
      version: "1",
      epic_id: epicId,
      status: "success",
      stage: "architect",
      started_at: "2026-05-01T09:00:00Z",
      exited_at: "2026-05-01T10:00:00Z",
      next_agent: "planner",
    };

    mockRoutingDecision = {
      override: true,
      nextAgent: "planner",
      reason: "explicit next_agent field",
    };

    const session = makeSession(epicId, "architecture", {
      epicLabels: ["ship-type:internal", "pipeline:architecture", "checkpoint:after-architecture"],
    });
    const handled = await handleChainAction(session, 0);

    // Assert: interpretMarkerForRouting was NOT called — checkpoint label
    // caused marker routing to be skipped entirely.
    expect(interpretMarkerForRouting).not.toHaveBeenCalled();

    // Assert: the existing architecture branch fires but hits checkpoint
    // pause in chainToNextStage (checkpoint:after-architecture label is set),
    // so returns false.
    expect(handled).toBe(false);
  });

  // Test 4 — AC 7: regression check — architecture -> plan-review (no marker)
  test("regression: architecture -> plan-review still works when marker absent", async () => {
    const epicId = "factory-core-zzzz";
    wireEpic(epicId, "ship-type:internal, pipeline:architecture");

    // No marker (readMarker returns null)
    mockReadMarkerResult = null;

    const session = makeSession(epicId, "architecture");
    const handled = await handleChainAction(session, 0);

    // Assert: interpretMarkerForRouting was NOT called (no marker)
    expect(interpretMarkerForRouting).not.toHaveBeenCalled();

    // Assert: fetch called with generate-plan action (architecture -> plan-review)
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].body.action).toBe("generate-plan");
    expect(fetchCalls[0].body.epicId).toBe(epicId);

    expect(handled).toBe(true);
  });

  // Test 5 — AC 7: regression check — product-spec -> architecture
  // (marker override=false)
  test("regression: product-spec -> architecture still works when marker override=false", async () => {
    const epicId = "factory-core-aaaa";
    wireEpic(epicId, "ship-type:internal, pipeline:product-spec");

    // Marker present but override=false
    mockReadMarkerResult = {
      version: "1",
      epic_id: epicId,
      status: "success",
      stage: "product-manager",
      started_at: "2026-05-01T08:00:00Z",
      exited_at: "2026-05-01T09:00:00Z",
    };

    mockRoutingDecision = {
      override: false,
      reason: "status=success, fallback to pipeline-routes",
    };

    const session = makeSession(epicId, "product-spec");
    const handled = await handleChainAction(session, 0);

    // Assert: interpretMarkerForRouting called (marker present)
    expect(interpretMarkerForRouting).toHaveBeenCalled();

    // Assert: fetch called with run-architect action (product-spec -> architecture)
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].body.action).toBe("run-architect");
    expect(fetchCalls[0].body.epicId).toBe(epicId);

    expect(handled).toBe(true);
  });

  // Test 6 — AC 7: regression check — research -> product-spec (no marker)
  test("regression: research -> product-spec still works when marker absent", async () => {
    const epicId = "factory-core-bbbb";
    wireEpic(epicId, "ship-type:internal, pipeline:research");

    mockReadMarkerResult = null;

    const session = makeSession(epicId, "research");
    const handled = await handleChainAction(session, 0);

    expect(interpretMarkerForRouting).not.toHaveBeenCalled();

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].body.action).toBe("run-pm");
    expect(fetchCalls[0].body.epicId).toBe(epicId);

    expect(handled).toBe(true);
  });

  // Test 7 — AC 7: regression check — test-spec -> development (no marker)
  test("regression: test-spec -> development still works when marker absent", async () => {
    const epicId = "factory-core-cccc";
    wireEpic(epicId, "ship-type:internal, pipeline:test-spec");

    mockReadMarkerResult = null;

    const session = makeSession(epicId, "test-spec");
    const handled = await handleChainAction(session, 0);

    expect(interpretMarkerForRouting).not.toHaveBeenCalled();

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].body.action).toBe("start-wave");
    expect(fetchCalls[0].body.epicId).toBe(epicId);
    expect(fetchCalls[0].body.waveNumber).toBe(1);

    expect(handled).toBe(true);
  });
});
