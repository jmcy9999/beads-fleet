// =============================================================================
// beads_web-ehp.11 — Tests for the precondition gate at /api/fleet/action.
// =============================================================================
// Verifies the 412 refusal path for FIVE representative cases (covering
// Class A / A.5 / B / C / D / E refusal codes the operator memo singled out):
//   1. start-wave with no wave beads          → NO_WAVE_BEADS or
//                                                 ALL_WAVE_BEADS_CLOSED
//   2. review-plan with no plan file          → PLAN_FILE_MISSING
//   3. run-architect with success marker      → ARCHITECT_MARKER_SUCCESS
//   4. send-for-qa with operator-decision-pending → OPERATOR_DECISION_PENDING
//   5. qa-fix-and-retest with QA round out of order → QA_ROUND_OUT_OF_ORDER
//
// Each test asserts:
//   - HTTP 412 status
//   - body contains { refused: true, action, epicId, refusalCode,
//     failedCheck, reason, observedState }
//   - NO labels mutated (mockAddLabels / mockRemoveLabels never called)
//   - NO agent launched (mockLaunchAgent never called)
//
// All 34 DISPATCHING cases share the same gate — testing 5 representative
// cases is sufficient per the bead. The PRECONDITION_TABLE coverage is
// asserted by the dispatch-preconditions library's own tests; this file
// is the route-handler integration check.
// =============================================================================

// ---------------------------------------------------------------------------
// Mocks (mirrored from fleet-action.test.ts so existing handlers keep working)
// ---------------------------------------------------------------------------

const mockAddLabels = jest.fn().mockResolvedValue(undefined);
const mockRemoveLabels = jest.fn().mockResolvedValue(undefined);
const mockRemoveLabelsStrict = jest.fn().mockResolvedValue(undefined);
const mockRemoveAllPipeline = jest.fn().mockResolvedValue(undefined);
const mockCloseEpic = jest.fn().mockResolvedValue(undefined);
const mockUpdateStatus = jest.fn().mockResolvedValue(undefined);
const mockGetEpicLabels = jest.fn().mockResolvedValue([]);
const mockDismissHumanItem = jest.fn().mockResolvedValue(undefined);

jest.mock("@/lib/pipeline-labels", () => ({
  addLabelsToEpic: (...args: unknown[]) => mockAddLabels(...args),
  removeLabelsFromEpic: (...args: unknown[]) => mockRemoveLabels(...args),
  removeLabelsFromEpicStrict: (...args: unknown[]) => mockRemoveLabelsStrict(...args),
  removeAllPipelineLabels: (...args: unknown[]) => mockRemoveAllPipeline(...args),
  closeEpic: (...args: unknown[]) => mockCloseEpic(...args),
  updateEpicStatus: (...args: unknown[]) => mockUpdateStatus(...args),
  getEpicLabels: (...args: unknown[]) => mockGetEpicLabels(...args),
  dismissHumanItem: (...args: unknown[]) => mockDismissHumanItem(...args),
}));

const mockLaunchAgent = jest.fn().mockResolvedValue({
  pid: 12345,
  repoPath: "/mock/path",
  repoName: "test",
  prompt: "test",
  model: "opus",
  startedAt: "2026-01-01T00:00:00Z",
  logFile: "/tmp/test.log",
});
const mockStopAgent = jest.fn().mockResolvedValue({ stopped: true, pid: 12345 });
const mockGetWaveStatus = jest.fn().mockResolvedValue({
  hasWaves: false,
  waves: new Map(),
  currentWave: 0,
  totalWaves: 0,
  currentWaveComplete: false,
  allWavesComplete: false,
  hasCheckpointRequired: false,
  totalChildren: 0,
  childrenWithWaveLabels: 0,
});
const mockListOpenWaveBeads = jest.fn().mockResolvedValue([]);
const mockListOpenWaveBeadsAllRepos = jest.fn().mockResolvedValue([]);
const mockGroupBeadsByFileConflict = jest.fn(() => []);
const mockIsAgentActive = jest.fn().mockReturnValue(false);

jest.mock("@/lib/agent-launcher", () => ({
  launchAgent: (...args: unknown[]) => mockLaunchAgent(...args),
  stopAgent: () => mockStopAgent(),
  getWaveStatus: (...args: unknown[]) => mockGetWaveStatus(...args),
  listOpenWaveBeads: (...args: unknown[]) => mockListOpenWaveBeads(...args),
  listOpenWaveBeadsAllRepos: (...args: unknown[]) => mockListOpenWaveBeadsAllRepos(...args),
  groupBeadsByFileConflict: (...args: unknown[]) => mockGroupBeadsByFileConflict(...args),
  isAgentActive: (...args: unknown[]) => mockIsAgentActive(...args),
}));

const mockFindRepoForIssue = jest.fn().mockResolvedValue(
  "/Users/janemckay/dev/fleet/fleet-core",
);
const mockGetRepos = jest.fn().mockResolvedValue({
  repos: [
    {
      name: "fleet-core",
      path: "/Users/janemckay/dev/fleet/fleet-core",
    },
  ],
});

jest.mock("@/lib/repo-config", () => ({
  getRepos: (...args: unknown[]) => mockGetRepos(...args),
  findRepoForIssue: (...args: unknown[]) => mockFindRepoForIssue(...args),
}));

const mockInvalidateCache = jest.fn();
jest.mock("@/lib/bv-client", () => ({
  invalidateCache: (...args: unknown[]) => mockInvalidateCache(...args),
}));

const mockLoadBeadDetail = jest.fn(() => ({
  id: "bead",
  title: "",
  description: "",
  acceptanceCriteria: "",
  files: [],
  rawShow: "",
}));
const mockLoadBeadTestScenarios = jest.fn().mockResolvedValue({ status: "missing-doc" });
const mockBuildPerBeadPrompt = jest.fn(() => "prompt");
const mockLoadCheckpointEntries = jest.fn().mockResolvedValue(null);
const mockLoadBuildPromptOverride = jest.fn().mockResolvedValue(null);
const mockFormatBuilderStandingOrders = jest.fn().mockReturnValue("orders");
const mockFormatAgentStandingOrders = jest.fn().mockReturnValue("orders");

jest.mock("@/lib/bead-prompt", () => ({
  loadBeadDetail: (...args: unknown[]) => mockLoadBeadDetail(...args),
  loadBeadTestScenarios: (...args: unknown[]) => mockLoadBeadTestScenarios(...args),
  loadCheckpointEntries: (...args: unknown[]) => mockLoadCheckpointEntries(...args),
  loadBuildPromptOverride: (...args: unknown[]) => mockLoadBuildPromptOverride(...args),
  buildPerBeadPrompt: (...args: unknown[]) => mockBuildPerBeadPrompt(...args),
  formatBuilderStandingOrdersDirective: (...args: unknown[]) => mockFormatBuilderStandingOrders(...args),
  formatAgentStandingOrdersDirective: (...args: unknown[]) => mockFormatAgentStandingOrders(...args),
}));

// ---------------------------------------------------------------------------
// dispatch-preconditions mock — overridden per test to return refusal verdicts
// ---------------------------------------------------------------------------

interface RefusalShape {
  ok: false;
  refusalCode: string;
  failedCheck: string;
  reason: string;
}
interface OkShape {
  ok: true;
}
type PreconditionResultShape = RefusalShape | OkShape;

interface BeadShape {
  id: string;
  status: string;
  pipelineStage: string | null;
  currentWave: number | null;
  currentQaRound: number | null;
  hasAgentRunning: boolean;
  hasReviewNeedsHuman: boolean;
}

const baseBead: BeadShape = {
  id: "test-epic-1",
  status: "open",
  pipelineStage: "development",
  currentWave: 1,
  currentQaRound: 0,
  hasAgentRunning: false,
  hasReviewNeedsHuman: false,
};

const mockBuildDispatchContext = jest.fn().mockResolvedValue({
  action: "test",
  bead: baseBead,
  marker: null,
  epicLabels: [],
  planFileExists: true,
  openWaveBeadIds: [],
  stageEnteredAt: null,
  planFileMtime: undefined,
});
const mockEvaluatePreconditions = jest.fn<PreconditionResultShape, [unknown]>().mockReturnValue({ ok: true });
const mockBuildPreconditionRefusalResponse = jest.fn().mockImplementation(
  (result: RefusalShape, bead: BeadShape | null) => ({
    refused: true,
    refusalCode: result.refusalCode,
    failedCheck: result.failedCheck,
    reason: result.reason,
    observedState: {
      beadId: bead?.id ?? null,
      status: bead?.status ?? null,
      pipelineStage: bead?.pipelineStage ?? null,
      currentWave: bead?.currentWave ?? null,
      currentQaRound: bead?.currentQaRound ?? null,
      hasAgentRunning: bead?.hasAgentRunning ?? false,
      hasReviewNeedsHuman: bead?.hasReviewNeedsHuman ?? false,
    },
  }),
);

jest.mock("@/lib/dispatch-preconditions", () => ({
  buildDispatchContext: (...args: unknown[]) => mockBuildDispatchContext(...args),
  evaluatePreconditions: (...args: unknown[]) => mockEvaluatePreconditions(...args),
  buildPreconditionRefusalResponse: (...args: unknown[]) => mockBuildPreconditionRefusalResponse(...args),
}));

// ---------------------------------------------------------------------------
// Import the route handler AFTER mocks are wired
// ---------------------------------------------------------------------------

import { POST } from "@/app/api/fleet/action/route";
import { NextRequest } from "next/server";

function makeRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost:3000/api/fleet/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  // Re-arm default ok=true so each test starts from a clean slate.
  mockEvaluatePreconditions.mockReturnValue({ ok: true });
  mockBuildDispatchContext.mockResolvedValue({
    action: "test",
    bead: baseBead,
    marker: null,
    epicLabels: [],
    planFileExists: true,
    openWaveBeadIds: [],
    stageEnteredAt: null,
    planFileMtime: undefined,
  });
});

// ---------------------------------------------------------------------------
// Per-AC: shared assertions used across all 5 cases.
// ---------------------------------------------------------------------------

function assertNoMutationOrLaunch() {
  expect(mockAddLabels).not.toHaveBeenCalled();
  expect(mockRemoveLabels).not.toHaveBeenCalled();
  expect(mockRemoveAllPipeline).not.toHaveBeenCalled();
  expect(mockUpdateStatus).not.toHaveBeenCalled();
  expect(mockCloseEpic).not.toHaveBeenCalled();
  expect(mockLaunchAgent).not.toHaveBeenCalled();
}

function assert412Body(
  data: Record<string, unknown>,
  expected: { action: string; epicId: string; refusalCode: string },
) {
  expect(data.refused).toBe(true);
  expect(data.action).toBe(expected.action);
  expect(data.epicId).toBe(expected.epicId);
  expect(data.refusalCode).toBe(expected.refusalCode);
  expect(typeof data.failedCheck).toBe("string");
  expect((data.failedCheck as string).length).toBeGreaterThan(0);
  expect(typeof data.reason).toBe("string");
  expect((data.reason as string).length).toBeGreaterThan(0);
  expect(data.observedState).toBeDefined();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/fleet/action — beads_web-ehp.11 precondition refusal (412)", () => {
  it("(1) start-wave with no wave beads → NO_WAVE_BEADS, no labels mutated, no agent launched", async () => {
    mockEvaluatePreconditions.mockReturnValue({
      ok: false,
      refusalCode: "NO_WAVE_BEADS",
      failedCheck: "wave-beads-exist",
      reason:
        "no open wave beads found for action=start-wave (openWaveBeadIds is empty — either no wave-N beads exist or all are closed)",
    });

    const req = makeRequest({
      epicId: "epic-no-wave-beads",
      epicTitle: "TestEpic",
      action: "start-wave",
      waveNumber: 1,
    });
    const res = await POST(req);

    expect(res.status).toBe(412);
    const data = await res.json();
    assert412Body(data, {
      action: "start-wave",
      epicId: "epic-no-wave-beads",
      refusalCode: "NO_WAVE_BEADS",
    });
    assertNoMutationOrLaunch();
  });

  it("(2) review-plan with no plan file → PLAN_FILE_MISSING, no labels mutated, no agent launched", async () => {
    mockEvaluatePreconditions.mockReturnValue({
      ok: false,
      refusalCode: "PLAN_FILE_MISSING",
      failedCheck: "plan-file-exists",
      reason:
        "no plan file at .beads/plans/<epicId>.md (action=review-plan requires the plan file to exist)",
    });

    const req = makeRequest({
      epicId: "epic-no-plan-file",
      epicTitle: "TestEpic",
      action: "review-plan",
    });
    const res = await POST(req);

    expect(res.status).toBe(412);
    const data = await res.json();
    assert412Body(data, {
      action: "review-plan",
      epicId: "epic-no-plan-file",
      refusalCode: "PLAN_FILE_MISSING",
    });
    assertNoMutationOrLaunch();
  });

  it("(3) run-architect with success marker → ARCHITECT_MARKER_SUCCESS, no labels mutated, no agent launched", async () => {
    mockEvaluatePreconditions.mockReturnValue({
      ok: false,
      refusalCode: "ARCHITECT_MARKER_SUCCESS",
      failedCheck: "architect-marker-not-success",
      reason:
        "prior architect marker has status=success — re-dispatching run-architect would re-do completed work",
    });

    const req = makeRequest({
      epicId: "epic-architect-done",
      epicTitle: "TestEpic",
      action: "run-architect",
    });
    const res = await POST(req);

    expect(res.status).toBe(412);
    const data = await res.json();
    assert412Body(data, {
      action: "run-architect",
      epicId: "epic-architect-done",
      refusalCode: "ARCHITECT_MARKER_SUCCESS",
    });
    assertNoMutationOrLaunch();
  });

  it("(4) send-for-qa with operator-decision-pending → OPERATOR_DECISION_PENDING, no labels mutated, no agent launched", async () => {
    mockEvaluatePreconditions.mockReturnValue({
      ok: false,
      refusalCode: "OPERATOR_DECISION_PENDING",
      failedCheck: "operator-decision-not-pending",
      reason:
        'marker.next_agent="operator" and blocker_class="ambiguity" — operator decision required before further dispatch',
    });

    const req = makeRequest({
      epicId: "epic-operator-blocker",
      epicTitle: "TestEpic",
      action: "send-for-qa",
    });
    const res = await POST(req);

    expect(res.status).toBe(412);
    const data = await res.json();
    assert412Body(data, {
      action: "send-for-qa",
      epicId: "epic-operator-blocker",
      refusalCode: "OPERATOR_DECISION_PENDING",
    });
    assertNoMutationOrLaunch();
  });

  it("(5) qa-fix-and-retest with QA round out of order → QA_ROUND_OUT_OF_ORDER, no labels mutated, no agent launched", async () => {
    mockEvaluatePreconditions.mockReturnValue({
      ok: false,
      refusalCode: "QA_ROUND_OUT_OF_ORDER",
      failedCheck: "qa-round-monotonic",
      reason:
        "QA round marker (stage=qa, status=fail) does not report success — round-2 dispatch refused until current round resolves",
    });

    const req = makeRequest({
      epicId: "epic-qa-round-mismatch",
      epicTitle: "TestEpic",
      action: "qa-fix-and-retest",
    });
    const res = await POST(req);

    expect(res.status).toBe(412);
    const data = await res.json();
    assert412Body(data, {
      action: "qa-fix-and-retest",
      epicId: "epic-qa-round-mismatch",
      refusalCode: "QA_ROUND_OUT_OF_ORDER",
    });
    assertNoMutationOrLaunch();
  });

  // -------------------------------------------------------------------------
  // Sanity: when preconditions pass (default mock), the existing handler runs.
  // This guards against a future regression where the helper accidentally
  // returns the refusal NextResponse even on ok=true.
  // -------------------------------------------------------------------------
  it("preconditions pass (ok=true) → handler proceeds with mutations + launch (start-research happy path)", async () => {
    // Default mockEvaluatePreconditions = { ok: true }; no override needed.
    const req = makeRequest({
      epicId: "epic-happy",
      epicTitle: "TestEpic",
      action: "start-research",
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mockAddLabels).toHaveBeenCalled();
    expect(mockLaunchAgent).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // EXEMPT cases: stop-agent / human-approve / human-dismiss MUST NOT call
  // the precondition gate. We assert evaluatePreconditions was NOT invoked
  // for these — proves the per-case `EXEMPT per beads_web-ehp.11` comment is
  // load-bearing (no helper invocation upstream of the case body).
  // -------------------------------------------------------------------------
  it("EXEMPT: stop-agent does NOT invoke the precondition gate", async () => {
    const req = makeRequest({
      epicId: "epic-stop",
      epicTitle: "TestEpic",
      action: "stop-agent",
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mockEvaluatePreconditions).not.toHaveBeenCalled();
    expect(mockBuildDispatchContext).not.toHaveBeenCalled();
  });

  it("EXEMPT: human-approve does NOT invoke the precondition gate", async () => {
    const req = makeRequest({
      epicId: "epic-approve",
      epicTitle: "TestEpic",
      action: "human-approve",
      targetLabel: "human-decision:required",
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mockEvaluatePreconditions).not.toHaveBeenCalled();
    expect(mockBuildDispatchContext).not.toHaveBeenCalled();
  });

  it("EXEMPT: human-dismiss does NOT invoke the precondition gate", async () => {
    const req = makeRequest({
      epicId: "epic-dismiss",
      epicTitle: "TestEpic",
      action: "human-dismiss",
      targetLabel: "qa:needs-review",
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mockEvaluatePreconditions).not.toHaveBeenCalled();
    expect(mockBuildDispatchContext).not.toHaveBeenCalled();
  });
});
