// =============================================================================
// Tests for src/app/api/fleet/action/route.ts
// =============================================================================
// These tests verify the fleet action API handles each pipeline action
// correctly. We mock the external dependencies (bd CLI, agent launcher)
// so the tests are fast and deterministic.
// =============================================================================

// Mock pipeline-labels module
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

// Mock agent-launcher module
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
// factory-core-z9h.4: send-for-development queries wave labels to decide
// between wave-routing and legacy single-session. Default mock reports
// "no children / no wave labels" — exercises the legacy branch unless a
// test overrides via mockResolvedValueOnce.
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

// factory-core-z9h.3: start-wave lists open wave beads and groups them by
// file conflict to decide parallel vs sequential launches. Default mock
// returns an empty array — that exercises the "no enumerable beads →
// legacy single-session wave launch" fallback. Tests that need per-bead
// orchestration override with mockResolvedValueOnce.
const mockListOpenWaveBeads = jest.fn().mockResolvedValue([]);
const mockGroupBeadsByFileConflict = jest.fn((beads: Array<{ id: string; files: string[] }>) => {
  // Passthrough implementation: import the real helper only when needed.
  // Groups beads that share files sequentially; non-overlapping beads go
  // into their own group. Mirrors the real algorithm closely enough for
  // test assertions to remain meaningful.
  if (beads.length === 0) return [];
  const parent = beads.map((_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  const fileToIdx = new Map<string, number[]>();
  const unknown: number[] = [];
  for (let i = 0; i < beads.length; i++) {
    if (beads[i].files.length === 0) {
      unknown.push(i);
      continue;
    }
    for (const f of beads[i].files) {
      const list = fileToIdx.get(f) ?? [];
      list.push(i);
      fileToIdx.set(f, list);
    }
  }
  for (const list of fileToIdx.values()) {
    for (let k = 1; k < list.length; k++) union(list[0], list[k]);
  }
  for (let k = 1; k < unknown.length; k++) union(unknown[0], unknown[k]);
  const groups = new Map<number, typeof beads>();
  for (let i = 0; i < beads.length; i++) {
    const r = find(i);
    const arr = groups.get(r) ?? [];
    arr.push(beads[i]);
    groups.set(r, arr);
  }
  return Array.from(groups.values());
});

// factory-core-z9h.6: start-wave now checks isAgentActive to skip heads
// that already have a live agent (tail-bead launch idempotency).
const mockIsAgentActive = jest.fn().mockReturnValue(false);

// beads_web-4jb (AC 2): cross-repo enumeration via listOpenWaveBeadsAllRepos.
// Default mock returns empty array (same as single-repo default).
const mockListOpenWaveBeadsAllRepos = jest.fn().mockResolvedValue([]);

jest.mock("@/lib/agent-launcher", () => ({
  launchAgent: (...args: unknown[]) => mockLaunchAgent(...args),
  stopAgent: () => mockStopAgent(),
  getWaveStatus: (...args: unknown[]) => mockGetWaveStatus(...args),
  listOpenWaveBeads: (...args: unknown[]) => mockListOpenWaveBeads(...args),
  listOpenWaveBeadsAllRepos: (...args: unknown[]) => mockListOpenWaveBeadsAllRepos(...args),
  groupBeadsByFileConflict: (...args: unknown[]) => mockGroupBeadsByFileConflict(...(args as [Array<{ id: string; files: string[] }>])),
  isAgentActive: (...args: unknown[]) => mockIsAgentActive(...args),
}));

// beads_web-4jb (AC 4): mock findRepoForIssue for cache pre-populate.
// Default: returns the fleet-core path (matching the default resolveRepoPath
// return for internal ship-type). Tests override per-call via
// mockResolvedValueOnce or mockImplementation.
const mockFindRepoForIssue = jest.fn().mockResolvedValue(
  "/Users/janemckay/dev/fleet/fleet-core",
);

// Mock repo-config module
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

// Mock bv-client invalidateCache (factory-core-ppx.8: the sweep migrated
// every route-handler call from bare `invalidateCache()` to a scoped call
// like `invalidateCache({type:"epic",epicId})`. We name the spy so tests
// can assert the scope argument is passed through.)
const mockInvalidateCache = jest.fn();
jest.mock("@/lib/bv-client", () => ({
  invalidateCache: (...args: unknown[]) => mockInvalidateCache(...args),
}));

// factory-core-z9h.5: mock bead-prompt so start-wave tests don't invoke
// `bd show` (which would try to spawn the real bd binary and hit a Dolt
// daemon that isn't available in CI). Default loader returns an empty
// but valid BeadDetail; default test-scenarios loader reports missing-doc.
// Default prompt builder mirrors the post-z9h.5 prompt shape so the
// existing z9h.3 assertions ("ONLY work bead X", "bead X" present) keep
// passing.
const mockLoadBeadDetail = jest.fn(
  (beadId: string) => ({
    id: beadId,
    // Empty title forces the route's `detail.title || head.title` fallback
    // to pick up the title from listOpenWaveBeads — so test assertions on
    // the prompt containing bead titles stay meaningful.
    title: "",
    description: "",
    acceptanceCriteria: "",
    files: [],
    rawShow: "",
  }),
);
const mockLoadBeadTestScenarios = jest.fn().mockResolvedValue({
  status: "missing-doc",
});
const mockBuildPerBeadPrompt = jest.fn((inputs: {
  beadId: string;
  beadTitle: string;
  epicId: string;
  epicTitle: string;
  waveNumber: number;
}) => {
  return [
    `Build bead ${inputs.beadId} — ${inputs.beadTitle}.`,
    `You are ONE of multiple parallel builders working epic ${inputs.epicId} (${inputs.epicTitle}), wave ${inputs.waveNumber}.`,
    `Work ONLY bead ${inputs.beadId}. Do not start, claim, or close any other bead.`,
  ].join("\n");
});

// beads_web-4jb: mock loadCheckpointEntries + loadBuildPromptOverride +
// formatBuilderStandingOrdersDirective + formatAgentStandingOrdersDirective
// (previously missing from mock factory, causing per-bead dispatch tests
// to fall into the catch branch).
const mockLoadCheckpointEntries = jest.fn().mockResolvedValue(null);
const mockLoadBuildPromptOverride = jest.fn().mockResolvedValue(null);
const mockFormatBuilderStandingOrders = jest.fn().mockReturnValue(
  "Read and follow the standing orders at /mock/fleet-core/standards.",
);
const mockFormatAgentStandingOrders = jest.fn().mockReturnValue(
  "Read and follow the agent standing orders.",
);

jest.mock("@/lib/bead-prompt", () => ({
  loadBeadDetail: (...args: unknown[]) =>
    mockLoadBeadDetail(...(args as [string, string])),
  loadBeadTestScenarios: (...args: unknown[]) =>
    mockLoadBeadTestScenarios(...args),
  loadCheckpointEntries: (...args: unknown[]) =>
    mockLoadCheckpointEntries(...args),
  loadBuildPromptOverride: (...args: unknown[]) =>
    mockLoadBuildPromptOverride(...args),
  buildPerBeadPrompt: (...args: unknown[]) =>
    mockBuildPerBeadPrompt(...(args as [{ beadId: string; beadTitle: string; epicId: string; epicTitle: string; waveNumber: number }])),
  formatBuilderStandingOrdersDirective: (...args: unknown[]) =>
    mockFormatBuilderStandingOrders(...args),
  formatAgentStandingOrdersDirective: (...args: unknown[]) =>
    mockFormatAgentStandingOrders(...args),
}));

// ---------------------------------------------------------------------------
// Import the route handler (AFTER mocks are set up)
// ---------------------------------------------------------------------------

import { POST } from "@/app/api/fleet/action/route";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// Helper: create a NextRequest with JSON body
// ---------------------------------------------------------------------------

function makeRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost:3000/api/fleet/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
});

describe("POST /api/fleet/action", () => {
  // -------------------------------------------------------------------------
  // send-for-qa
  // -------------------------------------------------------------------------

  describe("send-for-qa", () => {
    // factory-core-mejh: marker-read gate requires fs.readFile for rounds > 1.
    // Mock it per-describe so tests that trigger round > 1 provide a valid
    // marker (happy path) unless specifically testing halt behaviour.
    let mockReadFile: jest.SpyInstance;
    const validPassMarker = JSON.stringify({
      version: "1",
      epic_id: "epic-1",
      status: "success",
      stage: "qa",
      started_at: "2026-01-01T00:00:00Z",
      exited_at: "2026-01-01T01:00:00Z",
    });

    beforeEach(() => {
      mockReadFile = jest.spyOn(require("fs").promises, "readFile");
      // Default: return a valid PASS marker (no BLOCKERs) so round > 1
      // tests pass the marker gate. Tests that verify halt behaviour
      // override with mockRejectedValueOnce or mockResolvedValueOnce.
      mockReadFile.mockResolvedValue(validPassMarker);
    });

    afterEach(() => {
      mockReadFile.mockRestore();
    });

    it("starts first QA round when no prior QA labels exist", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle",
        action: "send-for-qa",
        currentLabels: ["pipeline:development"],
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.qaRound).toBe(1);
    });

    it("applies correct labels for first QA round (hnv.24)", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle",
        action: "send-for-qa",
        currentLabels: ["pipeline:development"],
      });
      await POST(req);

      // Should use removeAllPipelineLabels to prevent orphan labels (hnv.24)
      expect(mockRemoveAllPipeline).toHaveBeenCalledWith(
        "epic-1",
        expect.any(Array),
        expect.any(String),
      );
      // Round labels removed separately (none for first round)
      expect(mockRemoveLabels).toHaveBeenCalledWith(
        "epic-1",
        [],
        expect.any(String),
      );
      expect(mockAddLabels).toHaveBeenCalledWith(
        "epic-1",
        ["pipeline:qa", "qa:round-1", "agent:running"],
        expect.any(String),
      );
    });

    it("launches platform-specific QA agent for ios-app", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle",
        action: "send-for-qa",
        currentLabels: ["pipeline:development", "ship-type:ios-app"],
      });
      await POST(req);

      expect(mockLaunchAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          pipelineStage: "qa",
          agentName: "platforms/ios/qa",
        }),
      );
    });

    it("launches generic QA agent for web-app", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "TaskFlow",
        action: "send-for-qa",
        currentLabels: ["pipeline:development", "ship-type:web-app"],
      });
      await POST(req);

      expect(mockLaunchAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          pipelineStage: "qa",
          agentName: "qa",
        }),
      );
    });

    it("includes qaRound in response", async () => {
      // Mock getEpicLabels to return actual epic labels with qa:round-1
      // (factory-core-hnv.19: handler reads actual labels, not stale request body)
      mockGetEpicLabels.mockResolvedValueOnce(["pipeline:development", "qa:round-1"]);
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle",
        action: "send-for-qa",
        currentLabels: ["pipeline:development", "qa:round-1"],
      });
      const res = await POST(req);
      const data = await res.json();

      expect(data.qaRound).toBe(2);
    });

    it("reads actual labels (not stale request body) for round calculation (hnv.19, hnv.24)", async () => {
      // Simulate auto-chain: request body has stale labels (no qa:round-*)
      // but the epic actually has qa:round-2 from a previous QA cycle
      mockGetEpicLabels.mockResolvedValueOnce(["pipeline:development", "qa:round-2"]);
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle",
        action: "send-for-qa",
        currentLabels: ["pipeline:development"], // stale — no qa:round-*
      });
      const res = await POST(req);
      const data = await res.json();

      // Should be round 3 (based on actual labels), not round 1 (based on stale body)
      expect(data.qaRound).toBe(3);
      // Should use removeAllPipelineLabels for pipeline labels (hnv.24)
      expect(mockRemoveAllPipeline).toHaveBeenCalledWith(
        "epic-1",
        ["pipeline:development", "qa:round-2"],
        expect.any(String),
      );
      // Should remove round labels separately
      expect(mockRemoveLabels).toHaveBeenCalledWith(
        "epic-1",
        ["qa:round-2"],
        expect.any(String),
      );
    });

    // -----------------------------------------------------------------
    // factory-core-mejh: Marker-read gate tests for send-for-qa
    // -----------------------------------------------------------------

    it("mejh: halts dispatch when epic has review:needs-human label (round 2+)", async () => {
      // Epic is at round 1 → dispatcher would fire round 2
      // but review:needs-human is present
      mockGetEpicLabels.mockResolvedValueOnce([
        "pipeline:development",
        "qa:round-1",
        "review:needs-human",
      ]);
      const consoleSpy = jest.spyOn(console, "error").mockImplementation();

      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle",
        action: "send-for-qa",
        currentLabels: ["pipeline:development", "qa:round-1", "review:needs-human"],
      });
      const res = await POST(req);
      expect(res.status).toBe(500);

      const data = await res.json();
      expect(data.error).toBe("QA dispatch halted");
      expect(data.reason).toContain("review:needs-human");
      expect(data.epicId).toBe("epic-1");
      expect(data.round).toBe(2);

      // Structured log emitted
      expect(consoleSpy).toHaveBeenCalled();
      const logArg = consoleSpy.mock.calls[0][0];
      const parsed = JSON.parse(logArg);
      expect(parsed.event).toBe("qa_dispatch_halted");
      expect(parsed.epicId).toBe("epic-1");
      expect(parsed.round).toBe(2);
      expect(parsed.reason).toBe("review:needs-human present");

      // launchAgent must NOT have been called
      expect(mockLaunchAgent).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it("mejh: does NOT halt on review:needs-human for first QA round", async () => {
      // First round (currentRound === 1): no previous marker to check,
      // and the review:needs-human check is inside the currentRound > 1 block.
      // First round should proceed normally even with review:needs-human.
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle",
        action: "send-for-qa",
        currentLabels: ["pipeline:development"],
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.qaRound).toBe(1);
      expect(mockLaunchAgent).toHaveBeenCalled();
    });

    it("mejh: happy path — PASS marker with no BLOCKERs allows dispatch (round 2+)", async () => {
      // Epic at round 1, dispatcher fires round 2, marker has no BLOCKERs
      mockGetEpicLabels.mockResolvedValueOnce(["pipeline:development", "qa:round-1"]);
      // fs.readFile returns valid pass marker (default mock above)

      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle",
        action: "send-for-qa",
        currentLabels: ["pipeline:development", "qa:round-1"],
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.qaRound).toBe(2);
      expect(mockLaunchAgent).toHaveBeenCalled();
    });

    it("mejh: halts dispatch when marker file is missing (round 2+)", async () => {
      mockGetEpicLabels.mockResolvedValueOnce(["pipeline:development", "qa:round-1"]);
      mockReadFile.mockRejectedValueOnce(new Error("ENOENT: no such file or directory"));
      const consoleSpy = jest.spyOn(console, "error").mockImplementation();

      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle",
        action: "send-for-qa",
        currentLabels: ["pipeline:development", "qa:round-1"],
      });
      const res = await POST(req);
      expect(res.status).toBe(500);

      const data = await res.json();
      expect(data.error).toContain("marker file missing");
      expect(data.epicId).toBe("epic-1");
      expect(data.round).toBe(2);
      expect(data.previousRound).toBe(1);

      // Structured log emitted with specific error
      expect(consoleSpy).toHaveBeenCalled();
      const logArg = consoleSpy.mock.calls[0][0];
      const parsed = JSON.parse(logArg);
      expect(parsed.event).toBe("qa_marker_read_failure");
      expect(parsed.epicId).toBe("epic-1");
      expect(parsed.error).toContain("ENOENT");

      expect(mockLaunchAgent).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it("mejh: halts dispatch when marker JSON is malformed (round 2+)", async () => {
      mockGetEpicLabels.mockResolvedValueOnce(["pipeline:development", "qa:round-1"]);
      mockReadFile.mockResolvedValueOnce("this is not valid JSON {{{");
      const consoleSpy = jest.spyOn(console, "error").mockImplementation();

      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle",
        action: "send-for-qa",
        currentLabels: ["pipeline:development", "qa:round-1"],
      });
      const res = await POST(req);
      expect(res.status).toBe(500);

      const data = await res.json();
      expect(data.error).toContain("malformed marker JSON");
      expect(data.epicId).toBe("epic-1");
      expect(data.round).toBe(2);
      expect(data.previousRound).toBe(1);

      expect(consoleSpy).toHaveBeenCalled();
      const logArg = consoleSpy.mock.calls[0][0];
      const parsed = JSON.parse(logArg);
      expect(parsed.event).toBe("qa_marker_parse_failure");

      expect(mockLaunchAgent).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it("mejh: halts dispatch when marker contains BLOCKER directive (round 2+)", async () => {
      mockGetEpicLabels.mockResolvedValueOnce(["pipeline:development", "qa:round-1"]);
      mockReadFile.mockResolvedValueOnce(JSON.stringify({
        version: "1",
        epic_id: "epic-1",
        status: "needs-decision",
        stage: "qa",
        started_at: "2026-01-01T00:00:00Z",
        exited_at: "2026-01-01T01:00:00Z",
        whats_open: [
          "BLOCKER: marker-consumption path not functional",
          "FOLLOW-ON: minor style issue",
        ],
      }));
      const consoleSpy = jest.spyOn(console, "error").mockImplementation();

      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle",
        action: "send-for-qa",
        currentLabels: ["pipeline:development", "qa:round-1"],
      });
      const res = await POST(req);
      expect(res.status).toBe(500);

      const data = await res.json();
      expect(data.error).toContain("BLOCKER directive");
      expect(data.epicId).toBe("epic-1");
      expect(data.round).toBe(2);
      expect(data.blockers).toEqual(["BLOCKER: marker-consumption path not functional"]);

      expect(consoleSpy).toHaveBeenCalled();
      const logArg = consoleSpy.mock.calls[0][0];
      const parsed = JSON.parse(logArg);
      expect(parsed.event).toBe("qa_dispatch_halted_blocker");
      expect(parsed.blockers).toEqual(["BLOCKER: marker-consumption path not functional"]);

      expect(mockLaunchAgent).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it("mejh: allows dispatch when marker has FOLLOW-ON but no BLOCKER", async () => {
      mockGetEpicLabels.mockResolvedValueOnce(["pipeline:development", "qa:round-1"]);
      mockReadFile.mockResolvedValueOnce(JSON.stringify({
        version: "1",
        epic_id: "epic-1",
        status: "success",
        stage: "qa",
        started_at: "2026-01-01T00:00:00Z",
        exited_at: "2026-01-01T01:00:00Z",
        whats_open: ["FOLLOW-ON: performance regression for separate bead"],
      }));

      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle",
        action: "send-for-qa",
        currentLabels: ["pipeline:development", "qa:round-1"],
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.qaRound).toBe(2);
      expect(mockLaunchAgent).toHaveBeenCalled();
    });

    // -----------------------------------------------------------------
    // factory-core-0kkt: Verdict + open-bugs transition predicate tests
    // for send-for-qa dispatch site. Tests all (PASS/FAIL/SKIP/UNKNOWN)
    // × (openBugs=0, >0) combinations.
    // -----------------------------------------------------------------

    it("0kkt: terminates QA loop when verdict=PASS and open_bugs=0 (round 2+)", async () => {
      mockGetEpicLabels.mockResolvedValueOnce(["pipeline:development", "qa:round-1"]);
      mockReadFile.mockResolvedValueOnce(JSON.stringify({
        version: "1",
        epic_id: "epic-1",
        status: "success",
        stage: "qa",
        started_at: "2026-01-01T00:00:00Z",
        exited_at: "2026-01-01T01:00:00Z",
        verdict: "PASS",
        open_bugs: 0,
      }));
      const consoleSpy = jest.spyOn(console, "log").mockImplementation();

      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle",
        action: "send-for-qa",
        currentLabels: ["pipeline:development", "qa:round-1"],
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.terminated).toBe(true);
      expect(data.reason).toBe("QA loop terminated: PASS verdict, 0 open bugs");
      expect(data.lastRound).toBe(1);

      // Termination removes the labels that were already added at the
      // start of send-for-qa (pipeline:qa, qa:round-2, agent:running).
      // The second removeLabels call is the 0kkt termination cleanup.
      // (First removeLabels was the initial round-label cleanup at line ~1584.)
      const removeCallArgs = mockRemoveLabels.mock.calls;
      const terminationCall = removeCallArgs.find(
        (args: unknown[]) =>
          Array.isArray(args[1]) &&
          (args[1] as string[]).includes("pipeline:qa") &&
          (args[1] as string[]).includes("qa:round-2") &&
          (args[1] as string[]).includes("agent:running")
      );
      expect(terminationCall).toBeDefined();

      // launchAgent must NOT have been called
      expect(mockLaunchAgent).not.toHaveBeenCalled();

      // Structured log emitted
      expect(consoleSpy).toHaveBeenCalled();
      const logArg = consoleSpy.mock.calls.find(
        c => typeof c[0] === "string" && c[0].includes("qa_loop_terminated")
      );
      expect(logArg).toBeDefined();
      const parsed = JSON.parse(logArg![0]);
      expect(parsed.event).toBe("qa_loop_terminated");
      expect(parsed.verdict).toBe("PASS");
      expect(parsed.openBugs).toBe(0);

      consoleSpy.mockRestore();
    });

    it("0kkt: advances to next round when verdict=FAIL and open_bugs=0", async () => {
      mockGetEpicLabels.mockResolvedValueOnce(["pipeline:development", "qa:round-1"]);
      mockReadFile.mockResolvedValueOnce(JSON.stringify({
        version: "1",
        epic_id: "epic-1",
        status: "failure",
        stage: "qa",
        started_at: "2026-01-01T00:00:00Z",
        exited_at: "2026-01-01T01:00:00Z",
        verdict: "FAIL",
        open_bugs: 0,
      }));

      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle",
        action: "send-for-qa",
        currentLabels: ["pipeline:development", "qa:round-1"],
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.qaRound).toBe(2);
      expect(data.terminated).toBeUndefined();
      expect(mockLaunchAgent).toHaveBeenCalled();
    });

    it("0kkt: advances to next round when verdict=PASS but open_bugs>0", async () => {
      mockGetEpicLabels.mockResolvedValueOnce(["pipeline:development", "qa:round-1"]);
      mockReadFile.mockResolvedValueOnce(JSON.stringify({
        version: "1",
        epic_id: "epic-1",
        status: "success",
        stage: "qa",
        started_at: "2026-01-01T00:00:00Z",
        exited_at: "2026-01-01T01:00:00Z",
        verdict: "PASS",
        open_bugs: 3,
      }));

      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle",
        action: "send-for-qa",
        currentLabels: ["pipeline:development", "qa:round-1"],
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.qaRound).toBe(2);
      expect(data.terminated).toBeUndefined();
      expect(mockLaunchAgent).toHaveBeenCalled();
    });

    it("0kkt: advances to next round when verdict=SKIP and open_bugs=0", async () => {
      mockGetEpicLabels.mockResolvedValueOnce(["pipeline:development", "qa:round-1"]);
      mockReadFile.mockResolvedValueOnce(JSON.stringify({
        version: "1",
        epic_id: "epic-1",
        status: "success",
        stage: "qa",
        started_at: "2026-01-01T00:00:00Z",
        exited_at: "2026-01-01T01:00:00Z",
        verdict: "SKIP",
        open_bugs: 0,
      }));

      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle",
        action: "send-for-qa",
        currentLabels: ["pipeline:development", "qa:round-1"],
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.qaRound).toBe(2);
      expect(data.terminated).toBeUndefined();
      expect(mockLaunchAgent).toHaveBeenCalled();
    });

    it("0kkt: advances to next round when verdict=UNKNOWN and open_bugs=0", async () => {
      mockGetEpicLabels.mockResolvedValueOnce(["pipeline:development", "qa:round-1"]);
      mockReadFile.mockResolvedValueOnce(JSON.stringify({
        version: "1",
        epic_id: "epic-1",
        status: "success",
        stage: "qa",
        started_at: "2026-01-01T00:00:00Z",
        exited_at: "2026-01-01T01:00:00Z",
        verdict: "UNKNOWN",
        open_bugs: 0,
      }));

      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle",
        action: "send-for-qa",
        currentLabels: ["pipeline:development", "qa:round-1"],
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.qaRound).toBe(2);
      expect(data.terminated).toBeUndefined();
      expect(mockLaunchAgent).toHaveBeenCalled();
    });

    it("0kkt: advances to next round when verdict=FAIL and open_bugs>0", async () => {
      mockGetEpicLabels.mockResolvedValueOnce(["pipeline:development", "qa:round-1"]);
      mockReadFile.mockResolvedValueOnce(JSON.stringify({
        version: "1",
        epic_id: "epic-1",
        status: "failure",
        stage: "qa",
        started_at: "2026-01-01T00:00:00Z",
        exited_at: "2026-01-01T01:00:00Z",
        verdict: "FAIL",
        open_bugs: 5,
      }));

      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle",
        action: "send-for-qa",
        currentLabels: ["pipeline:development", "qa:round-1"],
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.qaRound).toBe(2);
      expect(data.terminated).toBeUndefined();
      expect(mockLaunchAgent).toHaveBeenCalled();
    });

    it("0kkt: advances to next round when verdict=SKIP and open_bugs>0", async () => {
      mockGetEpicLabels.mockResolvedValueOnce(["pipeline:development", "qa:round-1"]);
      mockReadFile.mockResolvedValueOnce(JSON.stringify({
        version: "1",
        epic_id: "epic-1",
        status: "success",
        stage: "qa",
        started_at: "2026-01-01T00:00:00Z",
        exited_at: "2026-01-01T01:00:00Z",
        verdict: "SKIP",
        open_bugs: 2,
      }));

      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle",
        action: "send-for-qa",
        currentLabels: ["pipeline:development", "qa:round-1"],
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.qaRound).toBe(2);
      expect(data.terminated).toBeUndefined();
      expect(mockLaunchAgent).toHaveBeenCalled();
    });

    it("0kkt: advances to next round when verdict=UNKNOWN and open_bugs>0", async () => {
      mockGetEpicLabels.mockResolvedValueOnce(["pipeline:development", "qa:round-1"]);
      mockReadFile.mockResolvedValueOnce(JSON.stringify({
        version: "1",
        epic_id: "epic-1",
        status: "success",
        stage: "qa",
        started_at: "2026-01-01T00:00:00Z",
        exited_at: "2026-01-01T01:00:00Z",
        verdict: "UNKNOWN",
        open_bugs: 1,
      }));

      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle",
        action: "send-for-qa",
        currentLabels: ["pipeline:development", "qa:round-1"],
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.qaRound).toBe(2);
      expect(data.terminated).toBeUndefined();
      expect(mockLaunchAgent).toHaveBeenCalled();
    });

    it("0kkt: round-1 happy path unchanged (no marker exists for round 0)", async () => {
      // First QA round — no previous round, no marker to check.
      // Should dispatch normally without checking verdict.
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle",
        action: "send-for-qa",
        currentLabels: ["pipeline:development"],
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.qaRound).toBe(1);
      expect(data.terminated).toBeUndefined();
      expect(mockLaunchAgent).toHaveBeenCalled();
    });

    // -----------------------------------------------------------------
    // factory-core-2r2m: QA ceiling check tests for send-for-qa site.
    // The ceiling is defence-in-depth: even when 0kkt says "advance"
    // (verdict=FAIL), halt if nextRound > maxRounds from qa.md.
    // -----------------------------------------------------------------

    it("2r2m: blocks round 21 when maxRounds=20 and verdict=FAIL (ceiling breach)", async () => {
      // Epic is at round 20 (qa:round-20 label). currentRound = 21 (next to dispatch).
      // Marker verdict=FAIL → 0kkt says advance. But 21 > 20 → ceiling blocks.
      mockGetEpicLabels.mockResolvedValueOnce(["pipeline:development", "qa:round-20"]);
      // First readFile: marker for round 20 (FAIL verdict, 0kkt advances)
      mockReadFile.mockResolvedValueOnce(JSON.stringify({
        version: "1",
        epic_id: "epic-1",
        status: "failure",
        stage: "qa",
        started_at: "2026-01-01T00:00:00Z",
        exited_at: "2026-01-01T01:00:00Z",
        verdict: "FAIL",
        open_bugs: 2,
      }));
      // Second readFile: qa.md content with maxRounds: 20
      mockReadFile.mockResolvedValueOnce(
        "---\nname: qa\ndescription: QA agent\nmodel: claude-opus-4-6\ntools:\n  - Read\n  - Bash\nmaxRounds: 20\n---\n\nYou are a QA agent."
      );
      const consoleSpy = jest.spyOn(console, "error").mockImplementation();

      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle",
        action: "send-for-qa",
        currentLabels: ["pipeline:development", "qa:round-20"],
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.reason).toBe("QA ceiling breached");
      expect(data.attemptedRound).toBe(21);
      expect(data.maxRounds).toBe(20);

      // review:needs-human label set
      expect(mockAddLabels).toHaveBeenCalledWith(
        "epic-1",
        expect.arrayContaining(["review:needs-human"]),
        expect.any(String),
      );

      // launchAgent NOT called
      expect(mockLaunchAgent).not.toHaveBeenCalled();

      // Structured log emitted
      const logArg = consoleSpy.mock.calls.find(
        c => typeof c[0] === "string" && c[0].includes("qa_ceiling_breached")
      );
      expect(logArg).toBeDefined();
      const parsed = JSON.parse(logArg![0]);
      expect(parsed.event).toBe("qa_ceiling_breached");
      expect(parsed.attemptedRound).toBe(21);
      expect(parsed.maxRounds).toBe(20);

      consoleSpy.mockRestore();
    });

    it("2r2m: allows round 21 when maxRounds=25 (config override)", async () => {
      // Epic is at round 20 (qa:round-20 label). currentRound = 21 (next to dispatch).
      // maxRounds=25 → 21 <= 25, so dispatch proceeds normally.
      mockGetEpicLabels.mockResolvedValueOnce(["pipeline:development", "qa:round-20"]);
      // First readFile: marker for round 20 (FAIL verdict → 0kkt advances)
      mockReadFile.mockResolvedValueOnce(JSON.stringify({
        version: "1",
        epic_id: "epic-1",
        status: "failure",
        stage: "qa",
        started_at: "2026-01-01T00:00:00Z",
        exited_at: "2026-01-01T01:00:00Z",
        verdict: "FAIL",
        open_bugs: 1,
      }));
      // Second readFile: qa.md with maxRounds: 25
      mockReadFile.mockResolvedValueOnce(
        "---\nname: qa\ndescription: QA agent\nmodel: claude-opus-4-6\nmaxRounds: 25\n---\n\nYou are a QA agent."
      );

      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle",
        action: "send-for-qa",
        currentLabels: ["pipeline:development", "qa:round-20"],
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.qaRound).toBe(21);
      // Normal dispatch — qaRound present, no ceiling-breach fields
      expect(data.reason).toBeUndefined();
      expect(mockLaunchAgent).toHaveBeenCalled();
    });

    it("2r2m: allows round 20 when maxRounds=20 (at ceiling, not past it)", async () => {
      // Epic is at round 19 (qa:round-19 label). currentRound = 20 (next to dispatch).
      // maxRounds=20 → 20 > 20 is FALSE → dispatch proceeds. Strict >, not >=.
      mockGetEpicLabels.mockResolvedValueOnce(["pipeline:development", "qa:round-19"]);
      // First readFile: marker for round 19 (FAIL verdict → 0kkt advances)
      mockReadFile.mockResolvedValueOnce(JSON.stringify({
        version: "1",
        epic_id: "epic-1",
        status: "failure",
        stage: "qa",
        started_at: "2026-01-01T00:00:00Z",
        exited_at: "2026-01-01T01:00:00Z",
        verdict: "FAIL",
        open_bugs: 1,
      }));
      // Second readFile: qa.md with maxRounds: 20
      mockReadFile.mockResolvedValueOnce(
        "---\nname: qa\ndescription: QA agent\nmodel: claude-opus-4-6\nmaxRounds: 20\n---\n\nYou are a QA agent."
      );

      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle",
        action: "send-for-qa",
        currentLabels: ["pipeline:development", "qa:round-19"],
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.qaRound).toBe(20);
      expect(mockLaunchAgent).toHaveBeenCalled();
    });

    it("2r2m: uses default maxRounds=20 when qa.md frontmatter has no maxRounds key", async () => {
      // Epic at round 20, trying to dispatch round 21. qa.md has no maxRounds key.
      // Default fallback = 20 → 21 > 20 → ceiling blocks.
      mockGetEpicLabels.mockResolvedValueOnce(["pipeline:development", "qa:round-20"]);
      // First readFile: marker for round 20 (FAIL verdict → 0kkt advances)
      mockReadFile.mockResolvedValueOnce(JSON.stringify({
        version: "1",
        epic_id: "epic-1",
        status: "failure",
        stage: "qa",
        started_at: "2026-01-01T00:00:00Z",
        exited_at: "2026-01-01T01:00:00Z",
        verdict: "FAIL",
        open_bugs: 1,
      }));
      // Second readFile: qa.md WITHOUT maxRounds key
      mockReadFile.mockResolvedValueOnce(
        "---\nname: qa\ndescription: QA agent\nmodel: claude-opus-4-6\n---\n\nYou are a QA agent."
      );
      const warnSpy = jest.spyOn(console, "warn").mockImplementation();
      const errorSpy = jest.spyOn(console, "error").mockImplementation();

      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle",
        action: "send-for-qa",
        currentLabels: ["pipeline:development", "qa:round-20"],
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.reason).toBe("QA ceiling breached");
      expect(data.maxRounds).toBe(20); // default fallback

      // Warning logged about missing maxRounds key
      const warnArg = warnSpy.mock.calls.find(
        c => typeof c[0] === "string" && c[0].includes("qa_maxrounds_key_missing")
      );
      expect(warnArg).toBeDefined();
      const warnParsed = JSON.parse(warnArg![0]);
      expect(warnParsed.fallback).toBe(20);

      expect(mockLaunchAgent).not.toHaveBeenCalled();

      warnSpy.mockRestore();
      errorSpy.mockRestore();
    });
  });


  // -------------------------------------------------------------------------
  // qa-fix-and-retest
  // -------------------------------------------------------------------------

  describe("qa-fix-and-retest", () => {
    it("removes pipeline:qa and adds pipeline:development + agent:running", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle",
        action: "qa-fix-and-retest",
        currentLabels: ["pipeline:qa", "qa:round-1"],
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      expect(mockRemoveLabels).toHaveBeenCalledWith(
        "epic-1",
        ["pipeline:qa"],
        expect.any(String),
      );
      expect(mockAddLabels).toHaveBeenCalledWith(
        "epic-1",
        ["pipeline:development", "agent:running"],
        expect.any(String),
      );
    });

    it("sets pipelineStage to qa-fixes", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle",
        action: "qa-fix-and-retest",
        currentLabels: ["pipeline:qa"],
      });
      await POST(req);

      expect(mockLaunchAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          pipelineStage: "qa-fixes",
        }),
      );
    });

    it("uses 300 maxTurns for QA fixes", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle",
        action: "qa-fix-and-retest",
        currentLabels: ["pipeline:qa"],
      });
      await POST(req);

      expect(mockLaunchAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          maxTurns: 300,
        }),
      );
    });
  });


  // -------------------------------------------------------------------------
  // send-for-polish (factory-core-hnv.11)
  // -------------------------------------------------------------------------

  describe("send-for-polish", () => {
    // factory-core-mejh: marker-read gate for skip-polish-advance path
    // requires fs.readFile. Mock it per-describe.
    let mockReadFile: jest.SpyInstance;
    const validPassMarker = JSON.stringify({
      version: "1",
      epic_id: "epic-1",
      status: "success",
      stage: "qa",
      started_at: "2026-01-01T00:00:00Z",
      exited_at: "2026-01-01T01:00:00Z",
    });

    beforeEach(() => {
      mockReadFile = jest.spyOn(require("fs").promises, "readFile");
      // Default: return a valid PASS marker (no BLOCKERs) so skip-polish
      // tests pass the marker gate. Tests that verify halt behaviour
      // override with mockRejectedValueOnce or mockResolvedValueOnce.
      mockReadFile.mockResolvedValue(validPassMarker);
    });

    afterEach(() => {
      mockReadFile.mockRestore();
    });

    it("transitions from qa to ux-polish for UI ship types", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle: Contact lens tracker",
        action: "send-for-polish",
        currentLabels: ["ship-type:ios-app"],
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      // zsjv.4 fix: pipeline:* labels cleared via removeAllPipelineLabels.
      expect(mockRemoveAllPipeline).toHaveBeenCalledWith("epic-1", expect.any(Array), expect.any(String));
      expect(mockAddLabels).toHaveBeenCalledWith(
        "epic-1",
        ["pipeline:ux-polish", "agent:running"],
        expect.any(String),
      );
    });

    it("skips polish for python-tool ship type", async () => {
      // Mock getEpicLabels to return actual labels with qa:round-1 (factory-core-hnv.22)
      mockGetEpicLabels.mockResolvedValueOnce(["pipeline:qa", "qa:round-1", "ship-type:python-tool"]);

      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "ToolName: Python utility",
        action: "send-for-polish",
        currentLabels: ["ship-type:python-tool"],
      });
      const res = await POST(req);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.skipped).toBe(true);

      // Should dynamically read labels and remove actual round label (factory-core-hnv.22)
      expect(mockRemoveLabels).toHaveBeenCalledWith(
        "epic-1",
        ["pipeline:qa", "qa:round-1"],
        expect.any(String),
      );

      // Should advance directly to QA Round 2 using standard label convention (factory-core-hnv.21)
      expect(mockAddLabels).toHaveBeenCalledWith(
        "epic-1",
        ["pipeline:qa", "qa:round-2"],
        expect.any(String),
      );
    });

    it("skips polish for non-UI type in round 2+ using dynamic round reading", async () => {
      // Mock getEpicLabels to return qa:round-2 — skip path must read this dynamically (factory-core-hnv.22)
      mockGetEpicLabels.mockResolvedValueOnce(["pipeline:qa", "qa:round-2", "ship-type:python-tool"]);

      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "ToolName: Python utility",
        action: "send-for-polish",
        currentLabels: ["ship-type:python-tool"],
      });
      const res = await POST(req);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.skipped).toBe(true);

      // Should remove the actual qa:round-2 label (not hard-coded qa:round-1)
      expect(mockRemoveLabels).toHaveBeenCalledWith(
        "epic-1",
        ["pipeline:qa", "qa:round-2"],
        expect.any(String),
      );

      // Should advance to QA Round 3
      expect(mockAddLabels).toHaveBeenCalledWith(
        "epic-1",
        ["pipeline:qa", "qa:round-3"],
        expect.any(String),
      );
    });

    it("launches polish agent with opus model for UI types", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle: Contact lens tracker",
        action: "send-for-polish",
        currentLabels: ["ship-type:web-app"],
      });
      await POST(req);

      expect(mockLaunchAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "opus",
          pipelineStage: "ux-polish",
          agentName: "polish",
        }),
      );
    });

    // -----------------------------------------------------------------
    // factory-core-mejh: Marker-read gate tests for send-for-polish
    // (skip-polish-advance path — non-UI ship types)
    // -----------------------------------------------------------------

    it("mejh: halts skip-polish-advance when epic has review:needs-human label", async () => {
      mockGetEpicLabels.mockResolvedValueOnce([
        "pipeline:qa",
        "qa:round-1",
        "ship-type:python-tool",
        "review:needs-human",
      ]);
      const consoleSpy = jest.spyOn(console, "error").mockImplementation();

      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "ToolName: Python utility",
        action: "send-for-polish",
        currentLabels: ["ship-type:python-tool", "review:needs-human"],
      });
      const res = await POST(req);
      expect(res.status).toBe(500);

      const data = await res.json();
      expect(data.error).toBe("QA dispatch halted");
      expect(data.reason).toContain("review:needs-human");
      expect(data.epicId).toBe("epic-1");
      expect(data.round).toBe(2); // currentRound=1, fires round 2

      // Structured log emitted
      expect(consoleSpy).toHaveBeenCalled();
      const logArg = consoleSpy.mock.calls[0][0];
      const parsed = JSON.parse(logArg);
      expect(parsed.event).toBe("qa_dispatch_halted");
      expect(parsed.epicId).toBe("epic-1");
      expect(parsed.round).toBe(2);

      // Labels must NOT have been mutated (no removeLabels/addLabels after halt)
      expect(mockRemoveLabels).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it("mejh: halts skip-polish-advance when marker file is missing", async () => {
      mockGetEpicLabels.mockResolvedValueOnce([
        "pipeline:qa",
        "qa:round-1",
        "ship-type:python-tool",
      ]);
      mockReadFile.mockRejectedValueOnce(new Error("ENOENT: no such file or directory"));
      const consoleSpy = jest.spyOn(console, "error").mockImplementation();

      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "ToolName: Python utility",
        action: "send-for-polish",
        currentLabels: ["ship-type:python-tool"],
      });
      const res = await POST(req);
      expect(res.status).toBe(500);

      const data = await res.json();
      expect(data.error).toContain("marker file missing");
      expect(data.epicId).toBe("epic-1");
      expect(data.round).toBe(2);
      expect(data.previousRound).toBe(1);

      expect(consoleSpy).toHaveBeenCalled();
      const logArg = consoleSpy.mock.calls[0][0];
      const parsed = JSON.parse(logArg);
      expect(parsed.event).toBe("qa_marker_read_failure");

      expect(mockRemoveLabels).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it("mejh: halts skip-polish-advance when marker JSON is malformed", async () => {
      mockGetEpicLabels.mockResolvedValueOnce([
        "pipeline:qa",
        "qa:round-1",
        "ship-type:python-tool",
      ]);
      mockReadFile.mockResolvedValueOnce("not valid json!!!");
      const consoleSpy = jest.spyOn(console, "error").mockImplementation();

      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "ToolName: Python utility",
        action: "send-for-polish",
        currentLabels: ["ship-type:python-tool"],
      });
      const res = await POST(req);
      expect(res.status).toBe(500);

      const data = await res.json();
      expect(data.error).toContain("malformed marker JSON");
      expect(data.epicId).toBe("epic-1");

      expect(consoleSpy).toHaveBeenCalled();
      const logArg = consoleSpy.mock.calls[0][0];
      const parsed = JSON.parse(logArg);
      expect(parsed.event).toBe("qa_marker_parse_failure");

      expect(mockRemoveLabels).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it("mejh: halts skip-polish-advance when marker contains BLOCKER directive", async () => {
      mockGetEpicLabels.mockResolvedValueOnce([
        "pipeline:qa",
        "qa:round-2",
        "ship-type:python-tool",
      ]);
      mockReadFile.mockResolvedValueOnce(JSON.stringify({
        version: "1",
        epic_id: "epic-1",
        status: "needs-decision",
        stage: "qa",
        started_at: "2026-01-01T00:00:00Z",
        exited_at: "2026-01-01T01:00:00Z",
        whats_open: [
          "BLOCKER: dispatch-loop defect — 18 consecutive rounds fired after termination recommendation",
        ],
      }));
      const consoleSpy = jest.spyOn(console, "error").mockImplementation();

      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "ToolName: Python utility",
        action: "send-for-polish",
        currentLabels: ["ship-type:python-tool"],
      });
      const res = await POST(req);
      expect(res.status).toBe(500);

      const data = await res.json();
      expect(data.error).toContain("BLOCKER directive");
      expect(data.epicId).toBe("epic-1");
      expect(data.round).toBe(3); // currentRound=2, fires round 3
      expect(data.previousRound).toBe(2);
      expect(data.blockers).toEqual([
        "BLOCKER: dispatch-loop defect — 18 consecutive rounds fired after termination recommendation",
      ]);

      expect(consoleSpy).toHaveBeenCalled();
      const logArg = consoleSpy.mock.calls[0][0];
      const parsed = JSON.parse(logArg);
      expect(parsed.event).toBe("qa_dispatch_halted_blocker");

      expect(mockRemoveLabels).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it("mejh: skip-polish-advance proceeds when marker has FOLLOW-ON but no BLOCKER", async () => {
      mockGetEpicLabels.mockResolvedValueOnce([
        "pipeline:qa",
        "qa:round-1",
        "ship-type:python-tool",
      ]);
      mockReadFile.mockResolvedValueOnce(JSON.stringify({
        version: "1",
        epic_id: "epic-1",
        status: "success",
        stage: "qa",
        started_at: "2026-01-01T00:00:00Z",
        exited_at: "2026-01-01T01:00:00Z",
        whats_open: ["FOLLOW-ON: minor UI consistency issue"],
      }));

      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "ToolName: Python utility",
        action: "send-for-polish",
        currentLabels: ["ship-type:python-tool"],
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.skipped).toBe(true);
      // Labels were advanced
      expect(mockAddLabels).toHaveBeenCalledWith(
        "epic-1",
        ["pipeline:qa", "qa:round-2"],
        expect.any(String),
      );
    });

    // -----------------------------------------------------------------
    // factory-core-0kkt: Verdict + open-bugs transition predicate tests
    // for skip-polish-advance dispatch site. Tests all (PASS/FAIL/SKIP/
    // UNKNOWN) × (openBugs=0, >0) combinations.
    // -----------------------------------------------------------------

    it("0kkt: terminates QA loop via skip-polish when verdict=PASS and open_bugs=0", async () => {
      mockGetEpicLabels.mockResolvedValueOnce([
        "pipeline:qa",
        "qa:round-1",
        "ship-type:python-tool",
      ]);
      mockReadFile.mockResolvedValueOnce(JSON.stringify({
        version: "1",
        epic_id: "epic-1",
        status: "success",
        stage: "qa",
        started_at: "2026-01-01T00:00:00Z",
        exited_at: "2026-01-01T01:00:00Z",
        verdict: "PASS",
        open_bugs: 0,
      }));
      const consoleSpy = jest.spyOn(console, "log").mockImplementation();

      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "ToolName: Python utility",
        action: "send-for-polish",
        currentLabels: ["ship-type:python-tool"],
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.terminated).toBe(true);
      expect(data.reason).toBe("QA loop terminated: PASS verdict, 0 open bugs");
      expect(data.lastRound).toBe(1);
      expect(data.skipped).toBe(true);

      // pipeline:qa and round labels cleared
      expect(mockRemoveLabels).toHaveBeenCalledWith(
        "epic-1",
        ["pipeline:qa", "qa:round-1"],
        expect.any(String),
      );
      // No qa:round-2 label added
      expect(mockAddLabels).not.toHaveBeenCalledWith(
        "epic-1",
        expect.arrayContaining(["qa:round-2"]),
        expect.any(String),
      );

      // Structured log emitted
      expect(consoleSpy).toHaveBeenCalled();
      const logArg = consoleSpy.mock.calls.find(
        c => typeof c[0] === "string" && c[0].includes("qa_loop_terminated")
      );
      expect(logArg).toBeDefined();
      const parsed = JSON.parse(logArg![0]);
      expect(parsed.event).toBe("qa_loop_terminated");
      expect(parsed.verdict).toBe("PASS");
      expect(parsed.openBugs).toBe(0);

      consoleSpy.mockRestore();
    });

    it("0kkt: advances skip-polish when verdict=FAIL and open_bugs=0", async () => {
      mockGetEpicLabels.mockResolvedValueOnce([
        "pipeline:qa",
        "qa:round-1",
        "ship-type:python-tool",
      ]);
      mockReadFile.mockResolvedValueOnce(JSON.stringify({
        version: "1",
        epic_id: "epic-1",
        status: "failure",
        stage: "qa",
        started_at: "2026-01-01T00:00:00Z",
        exited_at: "2026-01-01T01:00:00Z",
        verdict: "FAIL",
        open_bugs: 0,
      }));

      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "ToolName: Python utility",
        action: "send-for-polish",
        currentLabels: ["ship-type:python-tool"],
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.skipped).toBe(true);
      expect(data.terminated).toBeUndefined();
      expect(mockAddLabels).toHaveBeenCalledWith(
        "epic-1",
        ["pipeline:qa", "qa:round-2"],
        expect.any(String),
      );
    });

    it("0kkt: advances skip-polish when verdict=PASS but open_bugs>0", async () => {
      mockGetEpicLabels.mockResolvedValueOnce([
        "pipeline:qa",
        "qa:round-1",
        "ship-type:python-tool",
      ]);
      mockReadFile.mockResolvedValueOnce(JSON.stringify({
        version: "1",
        epic_id: "epic-1",
        status: "success",
        stage: "qa",
        started_at: "2026-01-01T00:00:00Z",
        exited_at: "2026-01-01T01:00:00Z",
        verdict: "PASS",
        open_bugs: 3,
      }));

      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "ToolName: Python utility",
        action: "send-for-polish",
        currentLabels: ["ship-type:python-tool"],
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.skipped).toBe(true);
      expect(data.terminated).toBeUndefined();
      expect(mockAddLabels).toHaveBeenCalledWith(
        "epic-1",
        ["pipeline:qa", "qa:round-2"],
        expect.any(String),
      );
    });

    it("0kkt: advances skip-polish when verdict=SKIP and open_bugs=0", async () => {
      mockGetEpicLabels.mockResolvedValueOnce([
        "pipeline:qa",
        "qa:round-1",
        "ship-type:python-tool",
      ]);
      mockReadFile.mockResolvedValueOnce(JSON.stringify({
        version: "1",
        epic_id: "epic-1",
        status: "success",
        stage: "qa",
        started_at: "2026-01-01T00:00:00Z",
        exited_at: "2026-01-01T01:00:00Z",
        verdict: "SKIP",
        open_bugs: 0,
      }));

      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "ToolName: Python utility",
        action: "send-for-polish",
        currentLabels: ["ship-type:python-tool"],
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.skipped).toBe(true);
      expect(data.terminated).toBeUndefined();
      expect(mockAddLabels).toHaveBeenCalledWith(
        "epic-1",
        ["pipeline:qa", "qa:round-2"],
        expect.any(String),
      );
    });

    it("0kkt: advances skip-polish when verdict=UNKNOWN and open_bugs=0", async () => {
      mockGetEpicLabels.mockResolvedValueOnce([
        "pipeline:qa",
        "qa:round-1",
        "ship-type:python-tool",
      ]);
      mockReadFile.mockResolvedValueOnce(JSON.stringify({
        version: "1",
        epic_id: "epic-1",
        status: "success",
        stage: "qa",
        started_at: "2026-01-01T00:00:00Z",
        exited_at: "2026-01-01T01:00:00Z",
        verdict: "UNKNOWN",
        open_bugs: 0,
      }));

      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "ToolName: Python utility",
        action: "send-for-polish",
        currentLabels: ["ship-type:python-tool"],
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.skipped).toBe(true);
      expect(data.terminated).toBeUndefined();
      expect(mockAddLabels).toHaveBeenCalledWith(
        "epic-1",
        ["pipeline:qa", "qa:round-2"],
        expect.any(String),
      );
    });

    it("0kkt: advances skip-polish when verdict=FAIL and open_bugs>0", async () => {
      mockGetEpicLabels.mockResolvedValueOnce([
        "pipeline:qa",
        "qa:round-1",
        "ship-type:python-tool",
      ]);
      mockReadFile.mockResolvedValueOnce(JSON.stringify({
        version: "1",
        epic_id: "epic-1",
        status: "failure",
        stage: "qa",
        started_at: "2026-01-01T00:00:00Z",
        exited_at: "2026-01-01T01:00:00Z",
        verdict: "FAIL",
        open_bugs: 5,
      }));

      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "ToolName: Python utility",
        action: "send-for-polish",
        currentLabels: ["ship-type:python-tool"],
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.skipped).toBe(true);
      expect(data.terminated).toBeUndefined();
      expect(mockAddLabels).toHaveBeenCalledWith(
        "epic-1",
        ["pipeline:qa", "qa:round-2"],
        expect.any(String),
      );
    });

    it("0kkt: advances skip-polish when verdict=SKIP and open_bugs>0", async () => {
      mockGetEpicLabels.mockResolvedValueOnce([
        "pipeline:qa",
        "qa:round-1",
        "ship-type:python-tool",
      ]);
      mockReadFile.mockResolvedValueOnce(JSON.stringify({
        version: "1",
        epic_id: "epic-1",
        status: "success",
        stage: "qa",
        started_at: "2026-01-01T00:00:00Z",
        exited_at: "2026-01-01T01:00:00Z",
        verdict: "SKIP",
        open_bugs: 2,
      }));

      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "ToolName: Python utility",
        action: "send-for-polish",
        currentLabels: ["ship-type:python-tool"],
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.skipped).toBe(true);
      expect(data.terminated).toBeUndefined();
      expect(mockAddLabels).toHaveBeenCalledWith(
        "epic-1",
        ["pipeline:qa", "qa:round-2"],
        expect.any(String),
      );
    });

    it("0kkt: advances skip-polish when verdict=UNKNOWN and open_bugs>0", async () => {
      mockGetEpicLabels.mockResolvedValueOnce([
        "pipeline:qa",
        "qa:round-1",
        "ship-type:python-tool",
      ]);
      mockReadFile.mockResolvedValueOnce(JSON.stringify({
        version: "1",
        epic_id: "epic-1",
        status: "success",
        stage: "qa",
        started_at: "2026-01-01T00:00:00Z",
        exited_at: "2026-01-01T01:00:00Z",
        verdict: "UNKNOWN",
        open_bugs: 1,
      }));

      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "ToolName: Python utility",
        action: "send-for-polish",
        currentLabels: ["ship-type:python-tool"],
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.skipped).toBe(true);
      expect(data.terminated).toBeUndefined();
      expect(mockAddLabels).toHaveBeenCalledWith(
        "epic-1",
        ["pipeline:qa", "qa:round-2"],
        expect.any(String),
      );
    });

    // -----------------------------------------------------------------
    // factory-core-2r2m: QA ceiling check tests for skip-polish-advance
    // dispatch site. The ceiling is defence-in-depth: even when 0kkt
    // says "advance" (verdict=FAIL), halt if nextRound > maxRounds.
    // -----------------------------------------------------------------

    it("2r2m: blocks round 21 via skip-polish when maxRounds=20 and verdict=FAIL (ceiling breach)", async () => {
      // currentRound = 20 (qa:round-20 label). Next would be round 21.
      // verdict=FAIL → 0kkt advances. But 21 > 20 → ceiling blocks.
      mockGetEpicLabels.mockResolvedValueOnce([
        "pipeline:qa",
        "qa:round-20",
        "ship-type:python-tool",
      ]);
      // First readFile: marker for round 20 (FAIL verdict)
      mockReadFile.mockResolvedValueOnce(JSON.stringify({
        version: "1",
        epic_id: "epic-1",
        status: "failure",
        stage: "qa",
        started_at: "2026-01-01T00:00:00Z",
        exited_at: "2026-01-01T01:00:00Z",
        verdict: "FAIL",
        open_bugs: 2,
      }));
      // Second readFile: qa.md with maxRounds: 20
      mockReadFile.mockResolvedValueOnce(
        "---\nname: qa\ndescription: QA agent\nmodel: claude-opus-4-6\nmaxRounds: 20\n---\n\nYou are a QA agent."
      );
      const consoleSpy = jest.spyOn(console, "error").mockImplementation();

      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "ToolName: Python utility",
        action: "send-for-polish",
        currentLabels: ["ship-type:python-tool"],
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.reason).toBe("QA ceiling breached");
      expect(data.attemptedRound).toBe(21);
      expect(data.maxRounds).toBe(20);
      expect(data.skipped).toBe(true);

      // review:needs-human label set
      expect(mockAddLabels).toHaveBeenCalledWith(
        "epic-1",
        expect.arrayContaining(["review:needs-human"]),
        expect.any(String),
      );

      // Structured log
      const logArg = consoleSpy.mock.calls.find(
        c => typeof c[0] === "string" && c[0].includes("qa_ceiling_breached")
      );
      expect(logArg).toBeDefined();
      const parsed = JSON.parse(logArg![0]);
      expect(parsed.event).toBe("qa_ceiling_breached");
      expect(parsed.attemptedRound).toBe(21);
      expect(parsed.maxRounds).toBe(20);

      // Label swap to round-21 must NOT have happened
      expect(mockAddLabels).not.toHaveBeenCalledWith(
        "epic-1",
        ["pipeline:qa", "qa:round-21"],
        expect.any(String),
      );

      consoleSpy.mockRestore();
    });

    it("2r2m: allows round 21 via skip-polish when maxRounds=25 (config override)", async () => {
      // currentRound = 20. Next = 21. maxRounds = 25 → 21 <= 25 → advance.
      mockGetEpicLabels.mockResolvedValueOnce([
        "pipeline:qa",
        "qa:round-20",
        "ship-type:python-tool",
      ]);
      // First readFile: marker for round 20 (FAIL verdict)
      mockReadFile.mockResolvedValueOnce(JSON.stringify({
        version: "1",
        epic_id: "epic-1",
        status: "failure",
        stage: "qa",
        started_at: "2026-01-01T00:00:00Z",
        exited_at: "2026-01-01T01:00:00Z",
        verdict: "FAIL",
        open_bugs: 1,
      }));
      // Second readFile: qa.md with maxRounds: 25
      mockReadFile.mockResolvedValueOnce(
        "---\nname: qa\ndescription: QA agent\nmodel: claude-opus-4-6\nmaxRounds: 25\n---\n\nYou are a QA agent."
      );

      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "ToolName: Python utility",
        action: "send-for-polish",
        currentLabels: ["ship-type:python-tool"],
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.skipped).toBe(true);
      expect(data.reason).toBe("Non-UI ship type -- no polish needed");
      // Label swap to round-21 happened
      expect(mockAddLabels).toHaveBeenCalledWith(
        "epic-1",
        ["pipeline:qa", "qa:round-21"],
        expect.any(String),
      );
    });

    it("2r2m: allows round 20 via skip-polish when maxRounds=20 (at ceiling, not past it)", async () => {
      // currentRound = 19. Next = 20. maxRounds = 20 → 20 > 20 is FALSE → advance.
      mockGetEpicLabels.mockResolvedValueOnce([
        "pipeline:qa",
        "qa:round-19",
        "ship-type:python-tool",
      ]);
      // First readFile: marker for round 19 (FAIL verdict)
      mockReadFile.mockResolvedValueOnce(JSON.stringify({
        version: "1",
        epic_id: "epic-1",
        status: "failure",
        stage: "qa",
        started_at: "2026-01-01T00:00:00Z",
        exited_at: "2026-01-01T01:00:00Z",
        verdict: "FAIL",
        open_bugs: 1,
      }));
      // Second readFile: qa.md with maxRounds: 20
      mockReadFile.mockResolvedValueOnce(
        "---\nname: qa\ndescription: QA agent\nmodel: claude-opus-4-6\nmaxRounds: 20\n---\n\nYou are a QA agent."
      );

      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "ToolName: Python utility",
        action: "send-for-polish",
        currentLabels: ["ship-type:python-tool"],
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.skipped).toBe(true);
      expect(data.reason).toBe("Non-UI ship type -- no polish needed");
      // Label swap to round-20 happened
      expect(mockAddLabels).toHaveBeenCalledWith(
        "epic-1",
        ["pipeline:qa", "qa:round-20"],
        expect.any(String),
      );
    });
  });

});
