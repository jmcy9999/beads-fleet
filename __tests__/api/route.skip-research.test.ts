// =============================================================================
// Integration tests for the start-research + skip:research bypass branch
// (factory-core-3yqr.2 — F7 / ADR-004 / ADR-007)
// =============================================================================
//
// Covers the six F7 acceptance cases:
//   1. Happy path: skip:research + ship-type:internal + description ≥ 50 chars
//      → 200, run-pm dispatched, epic transitions from starting state to
//      pipeline:product-spec, research agent NOT invoked.
//   2. Short description: skip:research + description < 50 chars → 400 with
//      the specified error; no label mutations.
//   3. Venture rejection: skip:research + ship-type:venture → 400 with the
//      specified error; no label mutations (ADR-007).
//   4. No label (regression guard): start-research without skip:research →
//      existing research-agent launch fires unchanged (byte-for-byte).
//   5. Late-bind no-op: skip:research applied AFTER the epic transitions to
//      pipeline:research has no effect — handleChainAction's research branch
//      never reads the label (F7 AC bullet 6 / no code change needed — this
//      test documents the behaviour).
//   6. PM input context: on a successful skip dispatch, the PM agent prompt
//      string contains the epic description VERBATIM (asserted on the prompt
//      builder output, not on the live agent).
//
// Regression patterns referenced:
//   #7  Type Confusion on Enum Branching — the three skip:research branches
//        (venture reject / short-description reject / happy-path dispatch)
//        are distinct and tested independently.
//   #13 Silent Exception Swallowing — the reject paths MUST NOT mutate the
//        epic state; every reject test asserts no labels changed + no agent
//        launched.
// =============================================================================

// ---------------------------------------------------------------------------
// Mocks — declared BEFORE importing the route under test (jest hoists).
// Mirrors the pattern in fleet-action.test.ts so we can assert on label +
// launch calls without hitting real bd / agent processes.
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
const mockGroupBeadsByFileConflict = jest.fn(() => []);
const mockIsAgentActive = jest.fn().mockReturnValue(false);

jest.mock("@/lib/agent-launcher", () => ({
  launchAgent: (...args: unknown[]) => mockLaunchAgent(...args),
  stopAgent: () => mockStopAgent(),
  getWaveStatus: (...args: unknown[]) => mockGetWaveStatus(...args),
  listOpenWaveBeads: (...args: unknown[]) => mockListOpenWaveBeads(...args),
  groupBeadsByFileConflict: (..._args: unknown[]) => mockGroupBeadsByFileConflict(),
  isAgentActive: (...args: unknown[]) => mockIsAgentActive(...args),
}));

jest.mock("@/lib/repo-config", () => ({
  getRepos: jest.fn().mockResolvedValue({
    repos: [
      {
        name: "fleet-core",
        path: "/Users/janemckay/dev/fleet/fleet-core",
      },
    ],
  }),
}));

const mockInvalidateCache = jest.fn();
jest.mock("@/lib/bv-client", () => ({
  invalidateCache: (...args: unknown[]) => mockInvalidateCache(...args),
}));

// The skip:research branch reads the epic description via loadBeadDetail.
// Default stub returns a description long enough to pass the 50-char gate —
// tests that need to exercise the short-description branch override via
// mockImplementationOnce.
const mockLoadBeadDetail = jest.fn(
  (beadId: string, _repoPath: string) => ({
    id: beadId,
    title: "Test Epic",
    description:
      "This is a pre-written inline brief for the epic, long enough to satisfy the 50-character minimum requirement.",
    acceptanceCriteria: "",
    files: [],
    rawShow: "",
  }),
);
const mockLoadBeadTestScenarios = jest.fn().mockResolvedValue({
  status: "missing-doc",
});
const mockBuildPerBeadPrompt = jest.fn((_inputs: unknown) => "");

jest.mock("@/lib/bead-prompt", () => ({
  loadBeadDetail: (...args: unknown[]) =>
    mockLoadBeadDetail(...(args as [string, string])),
  loadBeadTestScenarios: (...args: unknown[]) =>
    mockLoadBeadTestScenarios(...args),
  buildPerBeadPrompt: (...args: unknown[]) =>
    mockBuildPerBeadPrompt(...(args as [unknown])),
}));

// ---------------------------------------------------------------------------
// Import AFTER mocks
// ---------------------------------------------------------------------------

import { POST } from "@/app/api/fleet/action/route";
import { NextRequest } from "next/server";
import { readFileSync } from "fs";
import path from "path";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost:3000/api/fleet/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  // Re-seed the default description mock each test (clearAllMocks wipes it).
  mockLoadBeadDetail.mockImplementation((beadId: string, _repoPath: string) => ({
    id: beadId,
    title: "Test Epic",
    description:
      "This is a pre-written inline brief for the epic, long enough to satisfy the 50-character minimum requirement.",
    acceptanceCriteria: "",
    files: [],
    rawShow: "",
  }));
});

// ---------------------------------------------------------------------------
// F7 AC bullet 1 — happy path
// ---------------------------------------------------------------------------

describe("start-research + skip:research (factory-core-3yqr.2)", () => {
  describe("F7 AC bullet 1 — happy path (skip:research + ship-type:internal + description ≥ 50)", () => {
    it("returns 200 with dispatched=run-pm when all preconditions hold", async () => {
      const req = makeRequest({
        epicId: "factory-core-demo",
        epicTitle: "Demo internal epic",
        action: "start-research",
        currentLabels: ["skip:research", "ship-type:internal"],
      });

      const res = await POST(req);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.dispatched).toBe("run-pm");
      expect(data.bypass).toBe("skip:research");
    });

    it("transitions the epic label to pipeline:product-spec (not pipeline:research)", async () => {
      const req = makeRequest({
        epicId: "factory-core-demo",
        epicTitle: "Demo internal epic",
        action: "start-research",
        currentLabels: ["skip:research", "ship-type:internal"],
      });

      await POST(req);

      // addLabelsToEpic MUST be called with pipeline:product-spec.
      const addCalls = mockAddLabels.mock.calls;
      const addedLabelLists = addCalls.map((c) => c[1] as string[]);
      const flatAdded = addedLabelLists.flat();
      expect(flatAdded).toContain("pipeline:product-spec");
      expect(flatAdded).toContain("agent:running");
      // Critically: the research label must NOT be added on the skip path.
      expect(flatAdded).not.toContain("pipeline:research");
    });

    it("does NOT launch the research agent (research skipped entirely)", async () => {
      const req = makeRequest({
        epicId: "factory-core-demo",
        epicTitle: "Demo internal epic",
        action: "start-research",
        currentLabels: ["skip:research", "ship-type:internal"],
      });

      await POST(req);

      // Exactly one agent launch (the PM agent), and it is NOT the research agent.
      expect(mockLaunchAgent).toHaveBeenCalledTimes(1);
      const launched = mockLaunchAgent.mock.calls[0][0];
      expect(launched.pipelineStage).toBe("product-spec");
      expect(launched.agentName).toBe("product-manager");
      expect(launched.agentName).not.toBe("research");
    });

    it("logs the bypass with the epic id (console.info audit trail)", async () => {
      const infoSpy = jest.spyOn(console, "info").mockImplementation(() => {});
      const req = makeRequest({
        epicId: "factory-core-demo",
        epicTitle: "Demo internal epic",
        action: "start-research",
        currentLabels: ["skip:research", "ship-type:internal"],
      });

      await POST(req);

      const infoCalls = infoSpy.mock.calls.map((c) => c.join(" "));
      const bypassLog = infoCalls.find(
        (msg) => msg.includes("skip:research") && msg.includes("factory-core-demo"),
      );
      expect(bypassLog).toBeDefined();
      infoSpy.mockRestore();
    });
  });

  // ---------------------------------------------------------------------------
  // F7 AC bullet 2 — short description (< 50 chars) rejected
  // ---------------------------------------------------------------------------

  describe("F7 AC bullet 2 — short description rejection", () => {
    it("returns 400 with the exact error when description is under 50 characters", async () => {
      mockLoadBeadDetail.mockImplementationOnce(() => ({
        id: "factory-core-short",
        title: "Short",
        description: "Too short.",
        acceptanceCriteria: "",
        files: [],
        rawShow: "",
      }));

      const req = makeRequest({
        epicId: "factory-core-short",
        epicTitle: "Short epic",
        action: "start-research",
        currentLabels: ["skip:research", "ship-type:internal"],
      });

      const res = await POST(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe(
        "skip:research requires a description of at least 50 characters",
      );
    });

    it("returns 400 when description is empty", async () => {
      mockLoadBeadDetail.mockImplementationOnce(() => ({
        id: "factory-core-empty",
        title: "Empty",
        description: "",
        acceptanceCriteria: "",
        files: [],
        rawShow: "",
      }));

      const req = makeRequest({
        epicId: "factory-core-empty",
        epicTitle: "Empty epic",
        action: "start-research",
        currentLabels: ["skip:research", "ship-type:internal"],
      });

      const res = await POST(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe(
        "skip:research requires a description of at least 50 characters",
      );
    });

    it("returns 400 when description is whitespace-only (trimmed length counts, not raw)", async () => {
      mockLoadBeadDetail.mockImplementationOnce(() => ({
        id: "factory-core-ws",
        title: "Whitespace",
        // 60 characters of whitespace — raw length passes but trimmed fails.
        description: "                                                            ",
        acceptanceCriteria: "",
        files: [],
        rawShow: "",
      }));

      const req = makeRequest({
        epicId: "factory-core-ws",
        epicTitle: "Whitespace epic",
        action: "start-research",
        currentLabels: ["skip:research", "ship-type:internal"],
      });

      const res = await POST(req);
      expect(res.status).toBe(400);
    });

    it("does NOT mutate epic labels when description is too short (F7 AC: epic remains at starting state)", async () => {
      mockLoadBeadDetail.mockImplementationOnce(() => ({
        id: "factory-core-short",
        title: "Short",
        description: "Too short.",
        acceptanceCriteria: "",
        files: [],
        rawShow: "",
      }));

      const req = makeRequest({
        epicId: "factory-core-short",
        epicTitle: "Short epic",
        action: "start-research",
        currentLabels: ["skip:research", "ship-type:internal"],
      });

      await POST(req);

      expect(mockAddLabels).not.toHaveBeenCalled();
      expect(mockRemoveLabels).not.toHaveBeenCalled();
      expect(mockRemoveLabelsStrict).not.toHaveBeenCalled();
      expect(mockRemoveAllPipeline).not.toHaveBeenCalled();
      expect(mockUpdateStatus).not.toHaveBeenCalled();
      expect(mockLaunchAgent).not.toHaveBeenCalled();
    });

    it("accepts a description at exactly the 50-char boundary (≥ 50 is inclusive)", async () => {
      mockLoadBeadDetail.mockImplementationOnce(() => ({
        id: "factory-core-boundary",
        title: "Boundary",
        // Exactly 50 characters after trim.
        description: "a".repeat(50),
        acceptanceCriteria: "",
        files: [],
        rawShow: "",
      }));

      const req = makeRequest({
        epicId: "factory-core-boundary",
        epicTitle: "Boundary epic",
        action: "start-research",
        currentLabels: ["skip:research", "ship-type:internal"],
      });

      const res = await POST(req);
      expect(res.status).toBe(200);
    });

    it("rejects a description at 49 characters (just below the boundary)", async () => {
      mockLoadBeadDetail.mockImplementationOnce(() => ({
        id: "factory-core-49",
        title: "49 chars",
        description: "a".repeat(49),
        acceptanceCriteria: "",
        files: [],
        rawShow: "",
      }));

      const req = makeRequest({
        epicId: "factory-core-49",
        epicTitle: "49-char epic",
        action: "start-research",
        currentLabels: ["skip:research", "ship-type:internal"],
      });

      const res = await POST(req);
      expect(res.status).toBe(400);
    });
  });

  // ---------------------------------------------------------------------------
  // Regression pattern #13 — loadBeadDetail throw path must surface and not
  // mutate epic state (factory-core-3yqr.6)
  // ---------------------------------------------------------------------------

  describe("regression pattern #13 — loadBeadDetail throw path", () => {
    it("returns 500 with the bd error context when loadBeadDetail throws", async () => {
      mockLoadBeadDetail.mockImplementationOnce(() => {
        throw new Error("bd show failed: bead not found");
      });
      // Silence the expected console.error noise.
      const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});

      const req = makeRequest({
        epicId: "factory-core-missing",
        epicTitle: "Missing epic",
        action: "start-research",
        currentLabels: ["skip:research", "ship-type:internal"],
      });

      const res = await POST(req);
      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error).toContain("skip:research requires reading the epic description");
      expect(data.error).toContain("bd show failed: bead not found");

      errSpy.mockRestore();
    });

    it("does NOT mutate epic labels when loadBeadDetail throws (regression pattern #13 — no silent swallow, no partial state)", async () => {
      mockLoadBeadDetail.mockImplementationOnce(() => {
        throw new Error("bd show failed");
      });
      jest.spyOn(console, "error").mockImplementation(() => {});

      const req = makeRequest({
        epicId: "factory-core-missing",
        epicTitle: "Missing epic",
        action: "start-research",
        currentLabels: ["skip:research", "ship-type:internal"],
      });

      await POST(req);

      expect(mockAddLabels).not.toHaveBeenCalled();
      expect(mockRemoveLabels).not.toHaveBeenCalled();
      expect(mockRemoveLabelsStrict).not.toHaveBeenCalled();
      expect(mockRemoveAllPipeline).not.toHaveBeenCalled();
      expect(mockUpdateStatus).not.toHaveBeenCalled();
      expect(mockLaunchAgent).not.toHaveBeenCalled();
    });

    it("logs the bd failure via console.error (audit trail for the 500 path)", async () => {
      mockLoadBeadDetail.mockImplementationOnce(() => {
        throw new Error("bd CLI unreachable");
      });
      const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});

      const req = makeRequest({
        epicId: "factory-core-dead",
        epicTitle: "Dead epic",
        action: "start-research",
        currentLabels: ["skip:research", "ship-type:internal"],
      });

      await POST(req);

      const errCalls = errSpy.mock.calls.map((c) => c.map(String).join(" "));
      const matched = errCalls.find(
        (msg) => msg.includes("skip:research") && msg.includes("factory-core-dead"),
      );
      expect(matched).toBeDefined();
      errSpy.mockRestore();
    });
  });

  // ---------------------------------------------------------------------------
  // F7 AC bullet 4 — ship-type:venture rejection (ADR-007)
  // ---------------------------------------------------------------------------

  describe("F7 AC bullet 4 — ship-type:venture rejection (ADR-007)", () => {
    it("returns 400 with the exact error when skip:research + ship-type:venture", async () => {
      const req = makeRequest({
        epicId: "factory-core-venture",
        epicTitle: "Venture epic",
        action: "start-research",
        currentLabels: ["skip:research", "ship-type:venture"],
      });

      const res = await POST(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe(
        "skip:research is not valid for ventures; ventures are research-only",
      );
    });

    it("does NOT mutate epic labels when ship-type:venture is rejected", async () => {
      const req = makeRequest({
        epicId: "factory-core-venture",
        epicTitle: "Venture epic",
        action: "start-research",
        currentLabels: ["skip:research", "ship-type:venture"],
      });

      await POST(req);

      expect(mockAddLabels).not.toHaveBeenCalled();
      expect(mockRemoveLabels).not.toHaveBeenCalled();
      expect(mockUpdateStatus).not.toHaveBeenCalled();
      expect(mockLaunchAgent).not.toHaveBeenCalled();
      // Must not even read the description — venture check happens first.
      expect(mockLoadBeadDetail).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // F7 AC bullet 3 — no skip label: regression guard (byte-for-byte unchanged)
  // ---------------------------------------------------------------------------

  describe("F7 AC bullet 3 — no skip:research label: existing research-agent launch preserved", () => {
    it("launches the research agent when skip:research is absent (byte-for-byte with fleet-action.test.ts)", async () => {
      const req = makeRequest({
        epicId: "epic-normal",
        epicTitle: "LensCycle: Contact lens tracker",
        action: "start-research",
        currentLabels: ["ship-type:ios-app"],
      });

      const res = await POST(req);
      expect(res.status).toBe(200);

      expect(mockAddLabels).toHaveBeenCalledWith(
        "epic-normal",
        ["pipeline:research", "agent:running"],
        expect.any(String),
      );
      expect(mockUpdateStatus).toHaveBeenCalledWith(
        "epic-normal",
        "in_progress",
        expect.any(String),
      );
      expect(mockLaunchAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "opus",
          maxTurns: 200,
          pipelineStage: "research",
          agentName: "research",
          allowedTools: expect.stringContaining("WebSearch"),
        }),
      );
      // The skip path's helper is NOT invoked when the label is absent.
      expect(mockLoadBeadDetail).not.toHaveBeenCalled();
    });

    it("launches the research agent for ventures (venture without skip:research is valid)", async () => {
      const req = makeRequest({
        epicId: "epic-venture",
        epicTitle: "Some venture",
        action: "start-research",
        currentLabels: ["ship-type:venture"],
      });

      const res = await POST(req);
      expect(res.status).toBe(200);

      expect(mockLaunchAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          pipelineStage: "research",
          agentName: "research",
        }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // F7 AC bullet 6 — late-bind no-op: handleChainAction does not read the label
  // ---------------------------------------------------------------------------

  describe("F7 AC bullet 6 — skip:research has no effect mid-research (handleChainAction does not read it)", () => {
    it("the handleChainAction research branch is inert to the skip:research label (source-level documentation test)", () => {
      // F7 AC: 'skip:research' only gates the ENTRY to research, not mid-research
      // behaviour. Implementation contract (ADR-004): the label is checked ONLY
      // inside `case "start-research"` in route.ts — NOT in handleChainAction.
      //
      // Rather than spin up a handleChainAction harness (it requires bd, locks,
      // and a real fleet-config), this test verifies the contract at the source
      // level: the `if (stage === "research")` branch in agent-launcher.ts
      // must NOT contain the string "skip:research". If a future change adds a
      // mid-research late-bind behaviour, this test fails loudly.
      const launcherSrc = readFileSync(
        path.join(__dirname, "../../src/lib/agent-launcher.ts"),
        "utf-8",
      );

      const branchStart = launcherSrc.indexOf('if (stage === "research")');
      expect(branchStart).toBeGreaterThan(-1);
      // The research branch body is short — closing brace within the next
      // ~400 chars. We compare the slice against the label literal.
      const branchSnippet = launcherSrc.slice(branchStart, branchStart + 400);
      expect(branchSnippet).not.toContain("skip:research");
    });
  });

  // ---------------------------------------------------------------------------
  // F7 AC bullet 5 — PM input context: description inlined verbatim
  // ---------------------------------------------------------------------------

  describe("F7 AC bullet 5 — PM prompt inlines the epic description verbatim", () => {
    it("the dispatched PM agent prompt contains the epic description as written (no URL/path interpretation)", async () => {
      const inlineBrief =
        "Rebuild the notifications pipeline. Replace SNS with EventBridge, migrate dead-letter handling to SQS FIFO, and preserve backward compatibility for legacy iOS clients through 2026 Q3.";
      mockLoadBeadDetail.mockImplementationOnce(() => ({
        id: "factory-core-inline",
        title: "Inline brief",
        description: inlineBrief,
        acceptanceCriteria: "",
        files: [],
        rawShow: "",
      }));

      const req = makeRequest({
        epicId: "factory-core-inline",
        epicTitle: "Notifications pipeline rebuild",
        action: "start-research",
        currentLabels: ["skip:research", "ship-type:internal"],
      });

      const res = await POST(req);
      expect(res.status).toBe(200);

      expect(mockLaunchAgent).toHaveBeenCalledTimes(1);
      const launched = mockLaunchAgent.mock.calls[0][0];
      // Verbatim inclusion — no interpretation, no substitution.
      expect(launched.prompt).toContain(inlineBrief);
      // And the research-report path placeholder is NOT used on the skip path.
      expect(launched.prompt).not.toMatch(/Research report:\s*\S+\.md/);
    });

    it("preserves a URL in the description verbatim (no interpretation, per ADR-004)", async () => {
      const inlineBrief =
        "See the full pre-written brief here: https://example.com/docs/brief.md — implement per that document.";
      mockLoadBeadDetail.mockImplementationOnce(() => ({
        id: "factory-core-url",
        title: "URL brief",
        description: inlineBrief,
        acceptanceCriteria: "",
        files: [],
        rawShow: "",
      }));

      const req = makeRequest({
        epicId: "factory-core-url",
        epicTitle: "URL brief epic",
        action: "start-research",
        currentLabels: ["skip:research", "ship-type:internal"],
      });

      await POST(req);

      const launched = mockLaunchAgent.mock.calls[0][0];
      // The URL lands in the prompt exactly as written — no fetching, no
      // resolving, no rewriting.
      expect(launched.prompt).toContain("https://example.com/docs/brief.md");
    });

    it("preserves a file path in the description verbatim (no interpretation, per ADR-004)", async () => {
      const inlineBrief =
        "Brief lives at /Users/janemckay/dev/fleet/fleet-core/docs/research/internal-rebuild.md — read it first.";
      mockLoadBeadDetail.mockImplementationOnce(() => ({
        id: "factory-core-path",
        title: "Path brief",
        description: inlineBrief,
        acceptanceCriteria: "",
        files: [],
        rawShow: "",
      }));

      const req = makeRequest({
        epicId: "factory-core-path",
        epicTitle: "Path brief epic",
        action: "start-research",
        currentLabels: ["skip:research", "ship-type:internal"],
      });

      await POST(req);

      const launched = mockLaunchAgent.mock.calls[0][0];
      expect(launched.prompt).toContain(
        "/Users/janemckay/dev/fleet/fleet-core/docs/research/internal-rebuild.md",
      );
    });

    it("run-pm dispatched DIRECTLY (not through skip) still gets the research-report path (byte-for-byte preserved)", async () => {
      const req = makeRequest({
        epicId: "factory-core-direct",
        epicTitle: "Direct run-pm",
        action: "run-pm",
        currentLabels: ["ship-type:internal"],
      });

      const res = await POST(req);
      expect(res.status).toBe(200);

      expect(mockLaunchAgent).toHaveBeenCalledTimes(1);
      const launched = mockLaunchAgent.mock.calls[0][0];
      // Direct run-pm MUST use the Research-report path template (ADR-003).
      expect(launched.prompt).toMatch(/Research report:\s*\S+/);
      expect(launched.pipelineStage).toBe("product-spec");
    });
  });
});
