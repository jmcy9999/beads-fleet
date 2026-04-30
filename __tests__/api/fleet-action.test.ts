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
  // Validation
  // -------------------------------------------------------------------------

  it("returns 400 for missing epicId", async () => {
    const req = makeRequest({ epicTitle: "TestApp", action: "start-research" });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("epicId");
  });

  it("returns 400 for missing epicTitle", async () => {
    const req = makeRequest({ epicId: "epic-1", action: "start-research" });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("epicTitle");
  });

  it("returns 400 for invalid action", async () => {
    const req = makeRequest({ epicId: "epic-1", epicTitle: "TestApp", action: "fly-to-moon" });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("Invalid action");
  });

  it("returns 400 for invalid JSON body", async () => {
    const req = new NextRequest("http://localhost:3000/api/fleet/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  // -------------------------------------------------------------------------
  // start-research
  // -------------------------------------------------------------------------

  describe("start-research", () => {
    it("adds pipeline:research and agent:running labels", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle: Contact lens tracker",
        action: "start-research",
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      expect(mockAddLabels).toHaveBeenCalledWith(
        "epic-1",
        ["pipeline:research", "agent:running"],
        expect.any(String),
      );
    });

    it("updates epic status to in_progress", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle",
        action: "start-research",
      });
      await POST(req);

      expect(mockUpdateStatus).toHaveBeenCalledWith(
        "epic-1",
        "in_progress",
        expect.any(String),
      );
    });

    it("launches agent with research configuration", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle",
        action: "start-research",
      });
      await POST(req);

      expect(mockLaunchAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "opus",
          maxTurns: 200,
          pipelineStage: "research",
          epicId: "epic-1",
          allowedTools: expect.stringContaining("WebSearch"),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // send-for-development
  // -------------------------------------------------------------------------

  describe("send-for-development", () => {
    it("removes research-complete and plan labels, adds development + agent:running", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle: Contact lens tracker",
        action: "send-for-development",
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      expect(mockRemoveLabels).toHaveBeenCalledWith(
        "epic-1",
        ["pipeline:research-complete", "pipeline:test-spec", "plan:pending", "plan:approved"],
        expect.any(String),
      );
      expect(mockAddLabels).toHaveBeenCalledWith(
        "epic-1",
        ["pipeline:development", "agent:running"],
        expect.any(String),
      );
    });

    it("launches development agent in the app repo", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle: Contact lens tracker",
        action: "send-for-development",
      });
      await POST(req);

      expect(mockLaunchAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          repoPath: "/Users/janemckay/dev/claude_projects/LensCycle",
          model: "opus",
          maxTurns: 500,
          pipelineStage: "development",
        }),
      );
    });

    // -----------------------------------------------------------------------
    // factory-core-z9h.4 — wave-routing from send-for-development
    // -----------------------------------------------------------------------

    it("z9h.4: routes to start-wave with lowest open wave when all children have wave labels", async () => {
      mockGetWaveStatus.mockResolvedValueOnce({
        hasWaves: true,
        waves: new Map([[1, { total: 2, closed: 0 }], [2, { total: 3, closed: 0 }]]),
        currentWave: 1,
        totalWaves: 2,
        currentWaveComplete: false,
        allWavesComplete: false,
        hasCheckpointRequired: false,
        totalChildren: 5,
        childrenWithWaveLabels: 5,
      });

      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle: Contact lens tracker",
        action: "send-for-development",
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.dispatched).toBe("start-wave");
      expect(data.waveNumber).toBe(1);

      expect(mockLaunchAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          pipelineStage: "development",
          agentName: "builder",
          waveNumber: 1,
        }),
      );
      const call = mockLaunchAgent.mock.calls.at(-1)![0];
      expect(call.prompt).toContain("Wave 1");
      expect(call.prompt).toContain("wave:1");
      expect(call.prompt).toContain("Do not advance");
    });

    it("z9h.4: dispatches to wave=2 when wave 1 is already fully closed (retry scenario)", async () => {
      mockGetWaveStatus.mockResolvedValueOnce({
        hasWaves: true,
        waves: new Map([[1, { total: 2, closed: 2 }], [2, { total: 3, closed: 0 }]]),
        currentWave: 2,
        totalWaves: 2,
        currentWaveComplete: false,
        allWavesComplete: false,
        hasCheckpointRequired: false,
        totalChildren: 5,
        childrenWithWaveLabels: 5,
      });

      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle",
        action: "send-for-development",
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.dispatched).toBe("start-wave");
      expect(data.waveNumber).toBe(2);

      expect(mockLaunchAgent).toHaveBeenCalledWith(
        expect.objectContaining({ waveNumber: 2 }),
      );
    });

    it("z9h.4: falls back to legacy single-session when no children have wave labels", async () => {
      // Default mock already returns hasWaves=false / totalChildren=0 — that
      // path preserves pre-z9h behaviour for epics planned before wave
      // assignment existed.
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle",
        action: "send-for-development",
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.dispatched).toBe("legacy");

      const call = mockLaunchAgent.mock.calls.at(-1)![0];
      expect(call.pipelineStage).toBe("development");
      expect(call.waveNumber).toBeUndefined();
      // Legacy prompt says "Build epic X" (all beads), not "Build Wave N"
      expect(call.prompt).toContain("Build epic");
      expect(call.prompt).not.toContain("Build Wave");
    });

    it("z9h.4: also falls back to legacy when there are children but none carry wave labels", async () => {
      mockGetWaveStatus.mockResolvedValueOnce({
        hasWaves: false,
        waves: new Map(),
        currentWave: 0,
        totalWaves: 0,
        currentWaveComplete: false,
        allWavesComplete: false,
        hasCheckpointRequired: false,
        totalChildren: 4,
        childrenWithWaveLabels: 0,
      });

      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle",
        action: "send-for-development",
      });
      const res = await POST(req);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.dispatched).toBe("legacy");
    });

    it("z9h.4: returns 400 when wave labelling is inconsistent (some children have labels, some don't)", async () => {
      mockGetWaveStatus.mockResolvedValueOnce({
        hasWaves: true,
        waves: new Map([[1, { total: 2, closed: 0 }]]),
        currentWave: 1,
        totalWaves: 1,
        currentWaveComplete: false,
        allWavesComplete: false,
        hasCheckpointRequired: false,
        totalChildren: 5,
        childrenWithWaveLabels: 2,
      });

      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle",
        action: "send-for-development",
      });
      const res = await POST(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("Inconsistent wave labelling");
      // Epic state must NOT have been mutated — no labels changed, no agent launched.
      expect(mockAddLabels).not.toHaveBeenCalled();
      expect(mockRemoveLabels).not.toHaveBeenCalled();
      expect(mockLaunchAgent).not.toHaveBeenCalled();
    });

    // -----------------------------------------------------------------------
    // factory-core-z9h.10 — bd failure must not advance the pipeline
    // -----------------------------------------------------------------------
    //
    // Before this guard, a `bd list` failure caused getWaveStatus to return
    // hasWaves=false + totalChildren=0 with no error flag. send-for-development
    // then silently fell through to the legacy single-session path — a
    // wave-labelled epic would bypass the whole z9h parallel-builder
    // mechanism because one bd call flaked. The fix surfaces `error` on
    // WaveStatus and rejects with 500 on unknown wave state.
    //
    // Regression patterns: #13 Silent Exception Swallowing, #7 Type Confusion.
    it("z9h.10: returns 500 and does NOT mutate epic state when getWaveStatus reports an error", async () => {
      mockGetWaveStatus.mockResolvedValueOnce({
        hasWaves: false,
        waves: new Map(),
        currentWave: 0,
        totalWaves: 0,
        currentWaveComplete: false,
        allWavesComplete: false,
        hasCheckpointRequired: false,
        totalChildren: 0,
        childrenWithWaveLabels: 0,
        error: "bd list failed for epic epic-1 (filter=--parent=epic-1) — cannot determine wave state",
      });

      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle",
        action: "send-for-development",
      });
      const res = await POST(req);

      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error).toContain("Cannot determine wave state");
      // CRITICAL: epic state must NOT have been mutated on the unknown
      // path — no labels changed, no agent launched, no fall-through to
      // the legacy single-session path.
      expect(mockAddLabels).not.toHaveBeenCalled();
      expect(mockRemoveLabels).not.toHaveBeenCalled();
      expect(mockLaunchAgent).not.toHaveBeenCalled();
    });

    it("z9h.4: returns 400 when every child is already closed (epic has no open beads)", async () => {
      mockGetWaveStatus.mockResolvedValueOnce({
        hasWaves: true,
        waves: new Map([[1, { total: 2, closed: 2 }], [2, { total: 3, closed: 3 }]]),
        currentWave: 2,
        totalWaves: 2,
        currentWaveComplete: true,
        allWavesComplete: true,
        hasCheckpointRequired: false,
        totalChildren: 5,
        childrenWithWaveLabels: 5,
      });

      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle",
        action: "send-for-development",
      });
      const res = await POST(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("no open beads");
      // No state mutation on the reject path.
      expect(mockAddLabels).not.toHaveBeenCalled();
      expect(mockLaunchAgent).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // more-research
  // -------------------------------------------------------------------------

  describe("more-research", () => {
    it("removes research-complete and plan labels, adds research + agent:running", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle",
        action: "more-research",
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      expect(mockRemoveLabels).toHaveBeenCalledWith("epic-1", ["pipeline:research-complete", "plan:pending", "plan:approved"], expect.any(String));
      expect(mockAddLabels).toHaveBeenCalledWith("epic-1", ["pipeline:research", "agent:running"], expect.any(String));
    });

    it("includes feedback in the prompt when provided", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle",
        action: "more-research",
        feedback: "Need more competitor analysis",
      });
      await POST(req);

      expect(mockLaunchAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining("Need more competitor analysis"),
        }),
      );
    });

    it("launches research agent with WebSearch tool", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle",
        action: "more-research",
      });
      await POST(req);

      expect(mockLaunchAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          pipelineStage: "research",
          allowedTools: expect.stringContaining("WebSearch"),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // deprioritise
  // -------------------------------------------------------------------------

  describe("deprioritise", () => {
    it("removes all pipeline labels and adds bad-idea", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "BadApp",
        action: "deprioritise",
        currentLabels: ["pipeline:research-complete"],
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      expect(mockRemoveAllPipeline).toHaveBeenCalledWith(
        "epic-1",
        ["pipeline:research-complete"],
        expect.any(String),
      );
      expect(mockAddLabels).toHaveBeenCalledWith("epic-1", ["pipeline:bad-idea"], expect.any(String));
    });

    it("closes the epic with reason", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "BadApp",
        action: "deprioritise",
        feedback: "Market too small",
        currentLabels: [],
      });
      await POST(req);

      expect(mockCloseEpic).toHaveBeenCalledWith("epic-1", "Market too small", expect.any(String));
    });

    it("uses default reason when no feedback provided", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "BadApp",
        action: "deprioritise",
        currentLabels: [],
      });
      await POST(req);

      expect(mockCloseEpic).toHaveBeenCalledWith(
        "epic-1",
        "Abandoned from fleet board",
        expect.any(String),
      );
    });

    it("does not launch an agent", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "BadApp",
        action: "deprioritise",
        currentLabels: [],
      });
      await POST(req);

      expect(mockLaunchAgent).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // approve-submission
  // -------------------------------------------------------------------------

  describe("approve-submission", () => {
    it("adds agent:running label", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle",
        action: "approve-submission",
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      expect(mockAddLabels).toHaveBeenCalledWith("epic-1", ["agent:running"], expect.any(String));
    });

    it("launches submitter agent with opus model", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle",
        action: "approve-submission",
      });
      await POST(req);

      expect(mockLaunchAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "opus",
          maxTurns: 100,
          pipelineStage: "submission-prep",
          agentName: "submitter",
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // send-back-to-dev
  // -------------------------------------------------------------------------

  describe("send-back-to-dev", () => {
    it("removes all pipeline labels and adds development + agent:running (hnv.24)", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle",
        action: "send-back-to-dev",
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      // Should use removeAllPipelineLabels to prevent orphan labels (hnv.24)
      expect(mockGetEpicLabels).toHaveBeenCalledWith("epic-1", expect.any(String));
      expect(mockRemoveAllPipeline).toHaveBeenCalledWith("epic-1", expect.any(Array), expect.any(String));
      expect(mockAddLabels).toHaveBeenCalledWith("epic-1", ["pipeline:development", "agent:running"], expect.any(String));
    });

    it("includes feedback in the development prompt when provided", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle",
        action: "send-back-to-dev",
        feedback: "Fix the dark mode colors",
      });
      await POST(req);

      expect(mockLaunchAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining("Fix the dark mode colors"),
          pipelineStage: "development",
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // mark-as-live
  // -------------------------------------------------------------------------

  describe("mark-as-live", () => {
    it("removes submitted and submission labels, adds kit-management + agent:running", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle",
        action: "mark-as-live",
        currentLabels: ["pipeline:submitted", "submission:approved"],
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      expect(mockRemoveLabels).toHaveBeenCalledWith(
        "epic-1",
        ["pipeline:submitted", "submission:approved"],
        expect.any(String),
      );
      expect(mockAddLabels).toHaveBeenCalledWith(
        "epic-1",
        ["pipeline:kit-management", "agent:running"],
        expect.any(String),
      );
    });

    it("launches kit analysis agent", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle",
        action: "mark-as-live",
        currentLabels: ["pipeline:submitted"],
      });
      await POST(req);

      expect(mockLaunchAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "opus",
          pipelineStage: "kit-management",
          allowedTools: expect.stringContaining("Task"),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // stop-agent
  // -------------------------------------------------------------------------

  describe("stop-agent", () => {
    it("removes agent:running label and stops the agent", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle",
        action: "stop-agent",
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      expect(mockRemoveLabels).toHaveBeenCalledWith("epic-1", ["agent:running"], expect.any(String));
      expect(mockStopAgent).toHaveBeenCalled();
    });

    it("does not launch a new agent", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle",
        action: "stop-agent",
      });
      await POST(req);

      expect(mockLaunchAgent).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // generate-plan
  // -------------------------------------------------------------------------

  describe("generate-plan", () => {
    it("transitions to plan-review and adds agent:running labels", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle: Contact lens tracker",
        action: "generate-plan",
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      // hnv.14 fix: generate-plan removes research-complete and plan-review
      // lxc.5: also removes pipeline:architecture (new pre-plan stage)
      expect(mockRemoveLabels).toHaveBeenCalledWith(
        "epic-1",
        ["pipeline:research-complete", "pipeline:architecture"],
        expect.any(String),
      );
      expect(mockAddLabels).toHaveBeenCalledWith(
        "epic-1",
        ["pipeline:plan-review", "agent:running"],
        expect.any(String),
      );
    });

    it("launches planning agent in the app repo with concise prompt and agentName", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle: Contact lens tracker",
        action: "generate-plan",
      });
      await POST(req);

      expect(mockLaunchAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          repoPath: "/Users/janemckay/dev/fleet/fleet-core",
          model: "opus",
          maxTurns: 200,
          pipelineStage: "planning",
          epicId: "epic-1",
          agentName: "planner",
          prompt: expect.stringContaining("Plan epic"),
        }),
      );
    });

    it("includes entry point and ship type in the prompt", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle: Contact lens tracker",
        action: "generate-plan",
      });
      await POST(req);

      expect(mockLaunchAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining("Entry point: from-research"),
        }),
      );
    });

    it("references the research report in the prompt", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle: Contact lens tracker",
        action: "generate-plan",
      });
      await POST(req);

      expect(mockLaunchAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining("Research report:"),
        }),
      );
    });

    it("includes specPath and architecturePath in the prompt for non-venture epics", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle: Contact lens tracker",
        action: "generate-plan",
      });
      await POST(req);

      const prompt = mockLaunchAgent.mock.calls[0][0].prompt;
      expect(prompt).toContain("Functional spec:");
      expect(prompt).toContain("functional-spec.md");
      expect(prompt).toContain("Architecture:");
      expect(prompt).toContain("architecture.md");
    });

    it("omits specPath and architecturePath for venture epics", async () => {
      mockGetEpicLabels.mockResolvedValueOnce(["ship-type:venture"]);
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle: Contact lens tracker",
        action: "generate-plan",
        currentLabels: ["ship-type:venture"],
      });
      await POST(req);

      const prompt = mockLaunchAgent.mock.calls[0][0].prompt;
      expect(prompt).not.toContain("Functional spec:");
      expect(prompt).not.toContain("Architecture:");
    });
  });

  // -------------------------------------------------------------------------
  // approve-plan
  // -------------------------------------------------------------------------

  describe("approve-plan", () => {
    it("removes plan:pending and adds plan:approved", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle",
        action: "approve-plan",
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      expect(mockRemoveLabels).toHaveBeenCalledWith("epic-1", ["plan:pending"], expect.any(String));
      expect(mockAddLabels).toHaveBeenCalledWith("epic-1", ["plan:approved"], expect.any(String));
    });

    it("does not launch an agent", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle",
        action: "approve-plan",
      });
      await POST(req);

      expect(mockLaunchAgent).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // revise-plan
  // -------------------------------------------------------------------------

  describe("revise-plan", () => {
    it("removes plan:approved and plan:pending, adds agent:running (plan:pending added on agent exit)", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle",
        action: "revise-plan",
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      expect(mockRemoveLabels).toHaveBeenCalledWith("epic-1", ["plan:approved", "plan:pending"], expect.any(String));
      expect(mockAddLabels).toHaveBeenCalledWith("epic-1", ["agent:running"], expect.any(String));
    });

    it("includes feedback in the prompt when provided", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle",
        action: "revise-plan",
        feedback: "Add more detail to the notifications bead",
      });
      await POST(req);

      expect(mockLaunchAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining("Add more detail to the notifications bead"),
          pipelineStage: "planning",
        }),
      );
    });

    it("launches planning agent in the app repo with revise-plan entry point and agentName", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle",
        action: "revise-plan",
      });
      await POST(req);

      expect(mockLaunchAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          repoPath: "/Users/janemckay/dev/fleet/fleet-core",
          pipelineStage: "planning",
          agentName: "planner",
          prompt: expect.stringContaining("Entry point: revise-plan"),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // skip-to-plan
  // -------------------------------------------------------------------------

  describe("skip-to-plan", () => {
    it("adds research-complete and agent:running labels (plan:pending added on agent exit)", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle: Contact lens tracker",
        action: "skip-to-plan",
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      expect(mockAddLabels).toHaveBeenCalledWith(
        "epic-1",
        ["pipeline:research-complete", "agent:running"],
        expect.any(String),
      );
    });

    it("updates epic status to in_progress", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle",
        action: "skip-to-plan",
      });
      await POST(req);

      expect(mockUpdateStatus).toHaveBeenCalledWith(
        "epic-1",
        "in_progress",
        expect.any(String),
      );
    });

    it("launches planning agent with from-candidates entry point and agentName", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle",
        action: "skip-to-plan",
      });
      await POST(req);

      expect(mockLaunchAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          repoPath: "/Users/janemckay/dev/claude_projects/LensCycle",
          model: "opus",
          pipelineStage: "planning",
          agentName: "planner",
          prompt: expect.stringContaining("Entry point: from-candidates"),
        }),
      );
    });

    it("prompt mentions no recon brief", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle",
        action: "skip-to-plan",
      });
      await POST(req);

      expect(mockLaunchAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining("No recon brief"),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // revise-plan-from-launch
  // -------------------------------------------------------------------------

  describe("revise-plan-from-launch", () => {
    it("removes submission-prep and adds research-complete + agent:running (plan:pending added on agent exit)", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle",
        action: "revise-plan-from-launch",
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      expect(mockRemoveLabels).toHaveBeenCalledWith("epic-1", ["pipeline:submission-prep"], expect.any(String));
      expect(mockAddLabels).toHaveBeenCalledWith(
        "epic-1",
        ["pipeline:research-complete", "agent:running"],
        expect.any(String),
      );
    });

    it("includes feedback in the prompt when provided", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle",
        action: "revise-plan-from-launch",
        feedback: "Need to restructure the data layer",
      });
      await POST(req);

      expect(mockLaunchAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining("Need to restructure the data layer"),
          pipelineStage: "planning",
        }),
      );
    });

    it("launches planning agent in the app repo with revise-plan entry point and agentName", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle",
        action: "revise-plan-from-launch",
      });
      await POST(req);

      expect(mockLaunchAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          repoPath: "/Users/janemckay/dev/fleet/fleet-core",
          pipelineStage: "planning",
          agentName: "planner",
          prompt: expect.stringContaining("Entry point: revise-plan"),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // send-for-qa
  // -------------------------------------------------------------------------

  describe("send-for-qa", () => {
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
  // approve-and-build
  // -------------------------------------------------------------------------

  describe("approve-and-build", () => {
    // Mock fs.readFile for approval file tests
    const originalReadFile = jest.requireActual("fs").promises.readFile;
    let mockReadFile: jest.SpyInstance;

    beforeEach(() => {
      mockReadFile = jest.spyOn(require("fs").promises, "readFile");
    });

    afterEach(() => {
      mockReadFile.mockRestore();
    });

    it("applies correct labels", async () => {
      mockReadFile.mockRejectedValue(new Error("File not found"));

      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle",
        action: "approve-and-build",
        currentLabels: ["pipeline:research-complete", "plan:pending"],
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      expect(mockRemoveLabels).toHaveBeenCalledWith(
        "epic-1",
        ["pipeline:research-complete", "plan:pending"],
        expect.any(String),
      );
      expect(mockAddLabels).toHaveBeenCalledWith(
        "epic-1",
        ["plan:approved", "pipeline:test-spec", "agent:running"],
        expect.any(String),
      );
    });

    it("launches test-spec agent with 200 maxTurns", async () => {
      mockReadFile.mockRejectedValue(new Error("File not found"));

      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle",
        action: "approve-and-build",
        currentLabels: ["pipeline:research-complete", "plan:pending"],
      });
      await POST(req);

      expect(mockLaunchAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          pipelineStage: "test-spec",
          agentName: "test-spec",
          maxTurns: 200,
        }),
      );
    });

    it("launches test-spec agent (feature approval file is ignored for test-spec)", async () => {
      const approvalData = {
        features: [
          { name: "Feature A", status: "approved" },
          { name: "Feature B", status: "rejected" },
          { name: "Feature C", status: "deferred" },
        ],
      };
      mockReadFile.mockResolvedValue(JSON.stringify(approvalData));

      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle",
        action: "approve-and-build",
        currentLabels: ["pipeline:research-complete", "plan:pending"],
      });
      await POST(req);

      expect(mockLaunchAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          pipelineStage: "test-spec",
          agentName: "test-spec",
        }),
      );
    });

    it("handles missing approval file gracefully", async () => {
      mockReadFile.mockRejectedValue(new Error("ENOENT"));

      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle",
        action: "approve-and-build",
        currentLabels: ["pipeline:research-complete", "plan:pending"],
      });
      const res = await POST(req);

      expect(res.status).toBe(200);
      expect(mockLaunchAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.not.stringContaining("Feature scope"),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // send-for-review (factory-core-hnv.10)
  // -------------------------------------------------------------------------

  describe("send-for-review", () => {
    it("transitions from development to build-review", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle: Contact lens tracker",
        action: "send-for-review",
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      expect(mockRemoveLabels).toHaveBeenCalledWith(
        "epic-1",
        ["pipeline:development"],
        expect.any(String),
      );
      expect(mockAddLabels).toHaveBeenCalledWith(
        "epic-1",
        ["pipeline:build-review", "agent:running"],
        expect.any(String),
      );
    });

    it("launches reviewer agent with opus model", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle: Contact lens tracker",
        action: "send-for-review",
        currentLabels: ["ship-type:web-app"],
      });
      await POST(req);

      expect(mockLaunchAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "opus",
          pipelineStage: "build-review",
          agentName: "reviewer",
        }),
      );
    });

    it("uses platform-specific reviewer for iOS", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle: Contact lens tracker",
        action: "send-for-review",
        currentLabels: ["ship-type:ios-app"],
      });
      await POST(req);

      expect(mockLaunchAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          agentName: "platforms/ios/reviewer",
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // send-for-polish (factory-core-hnv.11)
  // -------------------------------------------------------------------------

  describe("send-for-polish", () => {
    it("transitions from qa to ux-polish for UI ship types", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle: Contact lens tracker",
        action: "send-for-polish",
        currentLabels: ["ship-type:ios-app"],
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
  });

  // -------------------------------------------------------------------------
  // run-pm (factory-core-lxc.5)
  // -------------------------------------------------------------------------

  describe("run-pm", () => {
    it("removes pipeline:research-complete and adds pipeline:product-spec + agent:running", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle: Contact lens tracker",
        action: "run-pm",
        currentLabels: ["pipeline:research-complete", "ship-type:ios-app"],
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      expect(mockRemoveLabels).toHaveBeenCalledWith(
        "epic-1",
        ["pipeline:research-complete"],
        expect.any(String),
      );
      expect(mockAddLabels).toHaveBeenCalledWith(
        "epic-1",
        ["pipeline:product-spec", "agent:running"],
        expect.any(String),
      );
    });

    it("launches PM agent with sonnet model and product-manager agentName", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle: Contact lens tracker",
        action: "run-pm",
        currentLabels: ["ship-type:ios-app"],
      });
      await POST(req);

      expect(mockLaunchAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "opus",
          maxTurns: 150,
          pipelineStage: "product-spec",
          agentName: "product-manager",
          epicId: "epic-1",
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // run-architect (factory-core-lxc.5)
  // -------------------------------------------------------------------------

  describe("run-architect", () => {
    it("removes pipeline:product-spec and adds pipeline:architecture + agent:running", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle: Contact lens tracker",
        action: "run-architect",
        currentLabels: ["pipeline:product-spec", "ship-type:ios-app"],
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      expect(mockRemoveLabels).toHaveBeenCalledWith(
        "epic-1",
        ["pipeline:product-spec"],
        expect.any(String),
      );
      expect(mockAddLabels).toHaveBeenCalledWith(
        "epic-1",
        ["pipeline:architecture", "agent:running"],
        expect.any(String),
      );
    });

    it("launches Architect agent with sonnet model and architect agentName", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle: Contact lens tracker",
        action: "run-architect",
        currentLabels: ["ship-type:ios-app"],
      });
      await POST(req);

      expect(mockLaunchAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "opus",
          maxTurns: 150,
          pipelineStage: "architecture",
          agentName: "architect",
          epicId: "epic-1",
        }),
      );
    });

    it("includes specPath in the architect agent prompt", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle: Contact lens tracker",
        action: "run-architect",
        currentLabels: ["ship-type:ios-app"],
      });
      await POST(req);

      expect(mockLaunchAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining("Functional spec:"),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // revise-spec (factory-core-lxc.5)
  // -------------------------------------------------------------------------

  describe("revise-spec", () => {
    it("adds agent:running (stays in product-spec stage)", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle: Contact lens tracker",
        action: "revise-spec",
        feedback: "Add analytics section",
        currentLabels: ["pipeline:product-spec", "ship-type:ios-app"],
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      expect(mockAddLabels).toHaveBeenCalledWith(
        "epic-1",
        ["agent:running"],
        expect.any(String),
      );
    });

    it("includes feedback in the PM agent prompt", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle: Contact lens tracker",
        action: "revise-spec",
        feedback: "Add analytics section",
        currentLabels: ["ship-type:ios-app"],
      });
      await POST(req);

      expect(mockLaunchAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining('Add analytics section'),
          agentName: "product-manager",
          pipelineStage: "product-spec",
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // revise-architecture (factory-core-lxc.5)
  // -------------------------------------------------------------------------

  describe("revise-architecture", () => {
    it("adds agent:running (stays in architecture stage)", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle: Contact lens tracker",
        action: "revise-architecture",
        feedback: "Simplify layer count",
        currentLabels: ["pipeline:architecture", "ship-type:ios-app"],
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      expect(mockAddLabels).toHaveBeenCalledWith(
        "epic-1",
        ["agent:running"],
        expect.any(String),
      );
    });

    it("includes feedback in the Architect agent prompt", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle: Contact lens tracker",
        action: "revise-architecture",
        feedback: "Simplify layer count",
        currentLabels: ["ship-type:ios-app"],
      });
      await POST(req);

      expect(mockLaunchAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining('Simplify layer count'),
          agentName: "architect",
          pipelineStage: "architecture",
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // human-approve (factory-core-509.2)
  // -------------------------------------------------------------------------

  describe("human-approve", () => {
    it("removes the target label from the epic (strict variant, factory-core-509.9)", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle: Contact lens tracker",
        action: "human-approve",
        targetLabel: "checkpoint:human-verify",
        currentLabels: ["pipeline:development", "checkpoint:human-verify"],
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      // Uses the strict variant so bd failures surface as 500 + error toast
      // instead of lying "approve completed" while the label remains.
      expect(mockRemoveLabelsStrict).toHaveBeenCalledWith(
        "epic-1",
        ["checkpoint:human-verify"],
        expect.any(String),
      );
      expect(mockRemoveLabels).not.toHaveBeenCalled();
    });

    it("propagates bd CLI errors as 500 with no silent swallow (factory-core-509.9)", async () => {
      mockRemoveLabelsStrict.mockRejectedValueOnce(
        new Error('Failed to remove label "checkpoint:human-verify" from epic-1: bd: connection refused'),
      );
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "App",
        action: "human-approve",
        targetLabel: "checkpoint:human-verify",
      });
      const res = await POST(req);
      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error).toContain("human-approve");
      expect(data.error).toContain("connection refused");
    });

    it("does NOT launch any agent", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "App",
        action: "human-approve",
        targetLabel: "checkpoint:human-verify",
      });
      await POST(req);
      expect(mockLaunchAgent).not.toHaveBeenCalled();
    });

    it("does NOT close the epic or change pipeline labels", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "App",
        action: "human-approve",
        targetLabel: "checkpoint:human-verify",
      });
      await POST(req);
      expect(mockCloseEpic).not.toHaveBeenCalled();
      expect(mockAddLabels).not.toHaveBeenCalled();
      expect(mockRemoveAllPipeline).not.toHaveBeenCalled();
    });

    it("returns success payload with targetLabel", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "App",
        action: "human-approve",
        targetLabel: "checkpoint:human-verify",
      });
      const res = await POST(req);
      const data = await res.json();
      expect(data).toMatchObject({
        success: true,
        action: "human-approve",
        epicId: "epic-1",
        targetLabel: "checkpoint:human-verify",
      });
    });

    it("returns 400 when targetLabel is missing", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "App",
        action: "human-approve",
      });
      const res = await POST(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("targetLabel");
      expect(mockRemoveLabels).not.toHaveBeenCalled();
      expect(mockRemoveLabelsStrict).not.toHaveBeenCalled();
    });

    it("returns 400 when targetLabel is not a string", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "App",
        action: "human-approve",
        targetLabel: 123,
      });
      const res = await POST(req);
      expect(res.status).toBe(400);
      expect(mockRemoveLabels).not.toHaveBeenCalled();
      expect(mockRemoveLabelsStrict).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // human-dismiss (factory-core-509.2)
  // -------------------------------------------------------------------------

  describe("human-dismiss", () => {
    it("removes the target label when targetLabel is provided (strict variant, factory-core-509.9)", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "App",
        action: "human-dismiss",
        targetLabel: "qa:needs-review",
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      // Uses the strict variant so bd failures surface as 500 + error toast.
      expect(mockRemoveLabelsStrict).toHaveBeenCalledWith(
        "epic-1",
        ["qa:needs-review"],
        expect.any(String),
      );
      expect(mockRemoveLabels).not.toHaveBeenCalled();
      expect(mockDismissHumanItem).not.toHaveBeenCalled();
    });

    it("calls dismissHumanItem when targetBeadId is provided", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle: Contact lens tracker",
        action: "human-dismiss",
        targetBeadId: "epic-1.3",
        currentLabels: ["ship-type:ios-app"],
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      expect(mockDismissHumanItem).toHaveBeenCalledWith(
        "epic-1.3",
        expect.any(String),
      );
      expect(mockRemoveLabels).not.toHaveBeenCalled();
      expect(mockRemoveLabelsStrict).not.toHaveBeenCalled();
    });

    it("prefers targetLabel over targetBeadId when both are provided", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "App",
        action: "human-dismiss",
        targetLabel: "checkpoint:decision",
        targetBeadId: "epic-1.3",
      });
      await POST(req);

      expect(mockRemoveLabelsStrict).toHaveBeenCalledWith(
        "epic-1",
        ["checkpoint:decision"],
        expect.any(String),
      );
      expect(mockRemoveLabels).not.toHaveBeenCalled();
      expect(mockDismissHumanItem).not.toHaveBeenCalled();
    });

    it("does NOT launch any agent", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "App",
        action: "human-dismiss",
        targetLabel: "checkpoint:human-action",
      });
      await POST(req);
      expect(mockLaunchAgent).not.toHaveBeenCalled();
    });

    it("returns success payload with targetLabel", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "App",
        action: "human-dismiss",
        targetLabel: "checkpoint:decision",
      });
      const res = await POST(req);
      const data = await res.json();
      expect(data).toMatchObject({
        success: true,
        action: "human-dismiss",
        epicId: "epic-1",
        targetLabel: "checkpoint:decision",
      });
    });

    it("returns success payload with targetBeadId", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle: Contact lens tracker",
        action: "human-dismiss",
        targetBeadId: "epic-1.3",
        currentLabels: ["ship-type:ios-app"],
      });
      const res = await POST(req);
      const data = await res.json();
      expect(data).toMatchObject({
        success: true,
        action: "human-dismiss",
        epicId: "epic-1",
        targetBeadId: "epic-1.3",
      });
    });

    it("returns 400 when neither targetLabel nor targetBeadId provided", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "App",
        action: "human-dismiss",
      });
      const res = await POST(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("targetLabel");
      expect(data.error).toContain("targetBeadId");
      expect(mockRemoveLabels).not.toHaveBeenCalled();
      expect(mockRemoveLabelsStrict).not.toHaveBeenCalled();
      expect(mockDismissHumanItem).not.toHaveBeenCalled();
    });

    it("returns 400 when both targetLabel and targetBeadId are empty strings", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "App",
        action: "human-dismiss",
        targetLabel: "",
        targetBeadId: "",
      });
      const res = await POST(req);
      expect(res.status).toBe(400);
      expect(mockRemoveLabels).not.toHaveBeenCalled();
      expect(mockRemoveLabelsStrict).not.toHaveBeenCalled();
      expect(mockDismissHumanItem).not.toHaveBeenCalled();
    });

    it("propagates errors from bd CLI as 500 with no silent swallow (label path, factory-core-509.9)", async () => {
      mockRemoveLabelsStrict.mockRejectedValueOnce(
        new Error('Failed to remove label "checkpoint:decision" from epic-1: bd: connection refused'),
      );
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "App",
        action: "human-dismiss",
        targetLabel: "checkpoint:decision",
      });
      const res = await POST(req);
      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error).toContain("human-dismiss");
      expect(data.error).toContain("connection refused");
    });

    it("propagates errors from bd CLI as 500 when dismissing a child bead (bead path, factory-core-509.9)", async () => {
      mockDismissHumanItem.mockRejectedValueOnce(new Error("bd: timeout after 15s"));
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle: Contact lens tracker",
        action: "human-dismiss",
        targetBeadId: "epic-1.3",
        currentLabels: ["ship-type:ios-app"],
      });
      const res = await POST(req);
      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error).toContain("human-dismiss");
      expect(data.error).toContain("timeout");
    });
  });

  // -------------------------------------------------------------------------
  // start-wave (factory-core-z9h.2 — fresh builder session per wave)
  // -------------------------------------------------------------------------
  //
  // These tests cover the z9h.2 AC: when the auto-chain fires wave N+1, the
  // new builder session must be visibly distinct from wave N's — i.e. the
  // waveNumber flows through to launchAgent so the tmux session name / disk
  // file names can include the wave suffix and not collide with the previous
  // wave's state.

  describe("start-wave", () => {
    it("returns 400 for a missing waveNumber", async () => {
      const req = makeRequest({
        epicId: "factory-core-z9h",
        epicTitle: "Fully autonomous pipeline",
        action: "start-wave",
        currentLabels: ["ship-type:internal"],
      });
      const res = await POST(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("waveNumber");
    });

    it("returns 400 for waveNumber < 1", async () => {
      const req = makeRequest({
        epicId: "factory-core-z9h",
        epicTitle: "Fully autonomous pipeline",
        action: "start-wave",
        waveNumber: 0,
        currentLabels: ["ship-type:internal"],
      });
      const res = await POST(req);
      expect(res.status).toBe(400);
    });

    it("launches a builder agent with waveNumber passed through to launchAgent (z9h.2)", async () => {
      const req = makeRequest({
        epicId: "factory-core-z9h",
        epicTitle: "Fully autonomous pipeline",
        action: "start-wave",
        waveNumber: 1,
        currentLabels: ["ship-type:internal"],
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      expect(mockLaunchAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          epicId: "factory-core-z9h",
          pipelineStage: "development",
          agentName: "builder",
          waveNumber: 1,
        }),
      );
    });

    it("passes a distinct waveNumber per call so successive waves don't collide (z9h.2)", async () => {
      // Wave 1
      await POST(makeRequest({
        epicId: "factory-core-z9h",
        epicTitle: "Fully autonomous pipeline",
        action: "start-wave",
        waveNumber: 1,
        currentLabels: ["ship-type:internal"],
      }));
      // Wave 2
      await POST(makeRequest({
        epicId: "factory-core-z9h",
        epicTitle: "Fully autonomous pipeline",
        action: "start-wave",
        waveNumber: 2,
        currentLabels: ["ship-type:internal"],
      }));

      expect(mockLaunchAgent).toHaveBeenCalledTimes(2);
      const call1 = mockLaunchAgent.mock.calls[0][0];
      const call2 = mockLaunchAgent.mock.calls[1][0];
      expect(call1.waveNumber).toBe(1);
      expect(call2.waveNumber).toBe(2);
      // Both calls target the same epic but the wave scope differs — this is
      // the hook launchAgent uses to produce distinct tmux session names.
      expect(call1.epicId).toBe(call2.epicId);
      expect(call1.waveNumber).not.toBe(call2.waveNumber);
    });

    it("scopes the prompt to the specific wave — builder is told 'ONLY work beads with wave:N label'", async () => {
      const req = makeRequest({
        epicId: "factory-core-z9h",
        epicTitle: "Fully autonomous pipeline",
        action: "start-wave",
        waveNumber: 2,
        currentLabels: ["ship-type:internal"],
      });
      await POST(req);

      const call = mockLaunchAgent.mock.calls.at(-1)![0];
      expect(call.prompt).toContain("Wave 2");
      expect(call.prompt).toContain("wave:2");
      expect(call.prompt).toContain("Do not advance to the next wave");
    });

    // -----------------------------------------------------------------------
    // factory-core-z9h.3 — per-bead parallel builders within a wave
    // -----------------------------------------------------------------------

    it("z9h.3: launches N agents (one per bead) when every bead has disjoint files", async () => {
      mockListOpenWaveBeads.mockResolvedValueOnce([
        { id: "z9h.A", title: "Alpha", files: ["src/alpha.ts"] },
        { id: "z9h.B", title: "Beta", files: ["src/beta.ts"] },
        { id: "z9h.C", title: "Gamma", files: ["src/gamma.ts"] },
        { id: "z9h.D", title: "Delta", files: ["src/delta.ts"] },
      ]);

      const req = makeRequest({
        epicId: "factory-core-z9h",
        epicTitle: "Fully autonomous pipeline",
        action: "start-wave",
        waveNumber: 2,
        currentLabels: ["ship-type:internal"],
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.dispatched).toBe("per-bead");
      expect(data.totalBeads).toBe(4);
      expect(data.totalGroups).toBe(4); // four disjoint groups
      expect(data.launched).toHaveLength(4);
      expect(data.deferred).toHaveLength(0);

      // launchAgent called once per bead, each with a distinct beadId
      expect(mockLaunchAgent).toHaveBeenCalledTimes(4);
      const beadIds = mockLaunchAgent.mock.calls.map(c => c[0].beadId).sort();
      expect(beadIds).toEqual(["z9h.A", "z9h.B", "z9h.C", "z9h.D"]);
      // Every call carries the same wave number
      for (const c of mockLaunchAgent.mock.calls) {
        expect(c[0].waveNumber).toBe(2);
        expect(c[0].epicId).toBe("factory-core-z9h");
      }
    });

    it("z9h.3: puts beads sharing a file into the same group and defers tail beads", async () => {
      mockListOpenWaveBeads.mockResolvedValueOnce([
        { id: "z9h.A", title: "Alpha", files: ["src/shared.ts", "src/a.ts"] },
        { id: "z9h.B", title: "Beta", files: ["src/shared.ts", "src/b.ts"] },
        { id: "z9h.C", title: "Gamma", files: ["src/c.ts"] },
      ]);

      const req = makeRequest({
        epicId: "factory-core-z9h",
        epicTitle: "Fully autonomous pipeline",
        action: "start-wave",
        waveNumber: 3,
        currentLabels: ["ship-type:internal"],
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.dispatched).toBe("per-bead");
      expect(data.totalBeads).toBe(3);
      expect(data.totalGroups).toBe(2);
      // Group A+B must run sequentially → head launches now, tail deferred.
      // Group C runs in parallel → head launches now, no deferred members.
      expect(data.launched).toHaveLength(2);
      expect(data.deferred).toHaveLength(1);

      // The two launched agents are the heads of their groups. The deferred
      // one is whichever of {A, B} was second in the shared-file group.
      const launchedIds = data.launched.map((l: { beadId: string }) => l.beadId).sort();
      const deferredIds = data.deferred.map((d: { beadId: string }) => d.beadId);
      expect(launchedIds).toContain("z9h.C");
      expect(deferredIds).toHaveLength(1);
      // Conservative: exactly one of A/B launched, the other deferred.
      const abLaunched = launchedIds.filter((id: string) => id === "z9h.A" || id === "z9h.B");
      const abDeferred = deferredIds.filter((id: string) => id === "z9h.A" || id === "z9h.B");
      expect(abLaunched.length + abDeferred.length).toBe(2);
      expect(abLaunched.length).toBe(1);
      expect(abDeferred.length).toBe(1);
    });

    it("z9h.3: falls back to single wave-session launch when no open beads are enumerable", async () => {
      // Default mockListOpenWaveBeads returns [] — simulates pre-z9h.7
      // epics (no Files: manifests) and empty waves.
      const req = makeRequest({
        epicId: "factory-core-z9h",
        epicTitle: "Fully autonomous pipeline",
        action: "start-wave",
        waveNumber: 1,
        currentLabels: ["ship-type:internal"],
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.dispatched).toBe("wave-session");

      expect(mockLaunchAgent).toHaveBeenCalledTimes(1);
      const call = mockLaunchAgent.mock.calls[0][0];
      expect(call.waveNumber).toBe(1);
      expect(call.beadId).toBeUndefined();
      expect(call.prompt).toContain("Wave 1");
    });

    it("z9h.3: per-bead prompt names the specific bead and forbids starting others", async () => {
      mockListOpenWaveBeads.mockResolvedValueOnce([
        { id: "z9h.X", title: "Refactor foo", files: ["src/foo.ts"] },
      ]);

      const req = makeRequest({
        epicId: "factory-core-z9h",
        epicTitle: "Fully autonomous pipeline",
        action: "start-wave",
        waveNumber: 2,
        currentLabels: ["ship-type:internal"],
      });
      await POST(req);

      const call = mockLaunchAgent.mock.calls.at(-1)![0];
      expect(call.beadId).toBe("z9h.X");
      expect(call.prompt).toContain("bead z9h.X");
      // z9h.5: the per-bead prompt says "Work ONLY bead X" rather than
      // the earlier placeholder "ONLY work bead X".
      expect(call.prompt).toContain("Work ONLY bead z9h.X");
      expect(call.prompt).toContain("Refactor foo");
      expect(call.prompt).not.toContain("all beads in the wave");
    });

    it("z9h.3: all unknown-manifest beads collapse into a single sequential group (safe default)", async () => {
      // Pre-z9h.7 scenario: none of the beads have a Files: manifest yet.
      // Conservative: treat them as potentially-conflicting → one big group.
      mockListOpenWaveBeads.mockResolvedValueOnce([
        { id: "z9h.P", title: "Plumb 1", files: [] },
        { id: "z9h.Q", title: "Plumb 2", files: [] },
        { id: "z9h.R", title: "Plumb 3", files: [] },
      ]);

      const req = makeRequest({
        epicId: "factory-core-z9h",
        epicTitle: "Fully autonomous pipeline",
        action: "start-wave",
        waveNumber: 1,
        currentLabels: ["ship-type:internal"],
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.dispatched).toBe("per-bead");
      expect(data.totalBeads).toBe(3);
      expect(data.totalGroups).toBe(1); // all three collapsed into one sequential chain
      expect(data.launched).toHaveLength(1);
      expect(data.deferred).toHaveLength(2);
    });

    // ---------------------------------------------------------------------
    // factory-core-z9h.6 — start-wave skips heads with active agents
    // (tail-bead launch idempotency)
    // ---------------------------------------------------------------------

    it("z9h.6: skips heads that already have an active agent (idempotent re-invocation)", async () => {
      // Scenario: start-wave is re-invoked by the auto-chain after a
      // per-bead agent closes. Three open beads: z9h.A already has an
      // active agent; z9h.B and z9h.C do not. Only B and C should launch.
      mockListOpenWaveBeads.mockResolvedValueOnce([
        { id: "z9h.A", title: "Alpha", files: ["a.ts"] },
        { id: "z9h.B", title: "Beta", files: ["b.ts"] },
        { id: "z9h.C", title: "Gamma", files: ["c.ts"] },
      ]);
      mockIsAgentActive.mockImplementation((_repo: string, beadId?: string) => {
        return beadId === "z9h.A";
      });

      const req = makeRequest({
        epicId: "factory-core-z9h",
        epicTitle: "Fully autonomous pipeline",
        action: "start-wave",
        waveNumber: 2,
        currentLabels: ["ship-type:internal"],
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.dispatched).toBe("per-bead");
      expect(data.totalBeads).toBe(3);
      expect(data.totalGroups).toBe(3);
      // Only B and C launch. A is skipped because it's already active.
      expect(data.launched).toHaveLength(2);
      expect(data.skipped).toHaveLength(1);
      expect(data.skipped[0].beadId).toBe("z9h.A");
      expect(data.skipped[0].reason).toMatch(/agent already active/i);

      const launchedIds = data.launched.map((l: { beadId: string }) => l.beadId).sort();
      expect(launchedIds).toEqual(["z9h.B", "z9h.C"]);

      // Reset mock for next test
      mockIsAgentActive.mockImplementation(() => false);
    });

    it("z9h.6: skipped heads don't count against deferred — a skipped head is neither launched nor queued", async () => {
      mockListOpenWaveBeads.mockResolvedValueOnce([
        { id: "z9h.A", title: "Alpha", files: ["shared.ts", "a.ts"] },
        { id: "z9h.B", title: "Beta", files: ["shared.ts", "b.ts"] },
      ]);
      mockIsAgentActive.mockImplementation((_repo: string, beadId?: string) => {
        return beadId === "z9h.A";
      });

      const req = makeRequest({
        epicId: "factory-core-z9h",
        epicTitle: "Fully autonomous pipeline",
        action: "start-wave",
        waveNumber: 2,
        currentLabels: ["ship-type:internal"],
      });
      const res = await POST(req);
      const data = await res.json();

      expect(data.totalBeads).toBe(2);
      expect(data.totalGroups).toBe(1); // A and B share a file
      // A (head) is active → skipped. B is the tail and stays deferred.
      expect(data.skipped.map((s: { beadId: string }) => s.beadId)).toEqual([
        "z9h.A",
      ]);
      expect(data.deferred.map((d: { beadId: string }) => d.beadId)).toEqual([
        "z9h.B",
      ]);
      expect(data.launched).toHaveLength(0);

      mockIsAgentActive.mockImplementation(() => false);
    });

    // ---------------------------------------------------------------------
    // factory-core-z9h.9 — start-wave returns 500 when listOpenWaveBeads
    // throws (bd outage) instead of silently falling through to the
    // legacy wave-session branch with an incomplete bead set.
    // ---------------------------------------------------------------------

    it("z9h.9: returns 500 when listOpenWaveBeads throws (bd outage)", async () => {
      // Reproduce the silent-skip regression: listOpenWaveBeads used to
      // return [] on bd failure, which tripped the legacy wave-session
      // fallback and silently launched a wave-scoped agent while work
      // was unknown. The fix throws; start-wave must now surface a 500.
      mockListOpenWaveBeads.mockRejectedValueOnce(
        new Error(
          "listOpenWaveBeads: bd show failed for child factory-core-z9h.9 of epic factory-core-z9h",
        ),
      );

      const req = makeRequest({
        epicId: "factory-core-z9h",
        epicTitle: "Fully autonomous pipeline",
        action: "start-wave",
        waveNumber: 4,
        currentLabels: ["ship-type:internal"],
      });
      const res = await POST(req);
      expect(res.status).toBe(500);

      const data = await res.json();
      expect(data.error).toContain("Failed to enumerate open wave beads");
      expect(data.error).toContain("bd show failed");
      expect(data.epicId).toBe("factory-core-z9h");
      expect(data.waveNumber).toBe(4);

      // CRITICAL: on a bd outage we must NOT fall through to the legacy
      // wave-session launch. Otherwise a wave-scoped builder spins up
      // against an unknown bead set, potentially deadlocking the wave
      // or advancing the epic with work undone.
      expect(mockLaunchAgent).not.toHaveBeenCalled();
    });

    it("z9h.9: returns 500 when the outer bd list fails (cannot enumerate wave beads)", async () => {
      // The outer `bd list` failure has a distinct error message so ops
      // can tell which bd call broke. start-wave treats both the same way:
      // surface the error, don't launch any agents.
      mockListOpenWaveBeads.mockRejectedValueOnce(
        new Error(
          "listOpenWaveBeads: bd list failed for epic factory-core-z9h (filter=--status=all --parent=factory-core-z9h) — cannot enumerate wave beads",
        ),
      );

      const req = makeRequest({
        epicId: "factory-core-z9h",
        epicTitle: "Fully autonomous pipeline",
        action: "start-wave",
        waveNumber: 2,
        currentLabels: ["ship-type:internal"],
      });
      const res = await POST(req);
      expect(res.status).toBe(500);

      const data = await res.json();
      expect(data.error).toContain("bd list failed");
      expect(mockLaunchAgent).not.toHaveBeenCalled();
    });

    // ---------------------------------------------------------------------
    // beads_web-4jb — cross-repo dispatch with bounding rule
    //
    // AC 1: Bounding-rule gate (isCrossRepoEpic = basename === "fleet-core-improved")
    // AC 2: Cross-repo epics call listOpenWaveBeadsAllRepos
    // AC 3: Product epics call single-repo listOpenWaveBeads (zero change)
    // AC 4: Cache pre-populate via parallel findRepoForIssue
    // AC 5: Per-bead dispatch uses cached repo for loadBeadDetail + launchAgent
    // AC 6: Bounding-rule assertion throws for product epic with cross-repo child
    // AC 7: Structured logging (3 emission points)
    // AC 8: z9h.9 throwing contract preserved for listOpenWaveBeadsAllRepos
    // AC 9: Kill-switch passthrough (A.1 internal, no route.ts logic needed)
    // AC 10: Integration test scaffolded for A.8
    // ---------------------------------------------------------------------

    it("4jb AC 1+3: product epic (basename !== fleet-core-improved) uses single-repo listOpenWaveBeads", async () => {
      // Default getRepos returns fleet-core (basename "fleet-core"), so
      // isCrossRepoEpic = false. The handler should call single-repo
      // listOpenWaveBeads, NOT listOpenWaveBeadsAllRepos.
      mockListOpenWaveBeads.mockResolvedValueOnce([
        { id: "z9h.A", title: "Alpha", files: ["src/a.ts"] },
      ]);
      mockFindRepoForIssue.mockResolvedValueOnce(
        "/Users/janemckay/dev/fleet/fleet-core",
      );

      const req = makeRequest({
        epicId: "factory-core-z9h",
        epicTitle: "Fully autonomous pipeline",
        action: "start-wave",
        waveNumber: 1,
        currentLabels: ["ship-type:internal"],
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      // Single-repo path called, not all-repos.
      expect(mockListOpenWaveBeads).toHaveBeenCalled();
      expect(mockListOpenWaveBeadsAllRepos).not.toHaveBeenCalled();
    });

    it("4jb AC 1+2: cross-repo epic (basename === fleet-core-improved) uses listOpenWaveBeadsAllRepos", async () => {
      // Override getRepos to return fleet-core-improved path so basename
      // matches the bounding-rule gate.
      mockGetRepos.mockResolvedValueOnce({
        repos: [
          {
            name: "fleet-core-improved",
            path: "/Users/janemckay/dev/fleet/fleet-core-improved",
          },
        ],
      });
      mockListOpenWaveBeadsAllRepos.mockResolvedValueOnce([
        { id: "so74.A", title: "Cross-repo bead A", files: ["src/a.ts"] },
      ]);
      mockFindRepoForIssue.mockResolvedValueOnce(
        "/Users/janemckay/dev/fleet/fleet-core-improved",
      );

      const req = makeRequest({
        epicId: "factory-core-so74",
        epicTitle: "Aspirational Pipeline Phase 2",
        action: "start-wave",
        waveNumber: 2,
        currentLabels: ["ship-type:internal"],
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      // All-repos path called, not single-repo.
      expect(mockListOpenWaveBeadsAllRepos).toHaveBeenCalledWith(
        "factory-core-so74",
        2,
      );
      expect(mockListOpenWaveBeads).not.toHaveBeenCalled();
    });

    it("4jb AC 4: cache pre-populates via parallel findRepoForIssue before dispatch", async () => {
      mockGetRepos.mockResolvedValueOnce({
        repos: [
          {
            name: "fleet-core-improved",
            path: "/Users/janemckay/dev/fleet/fleet-core-improved",
          },
        ],
      });
      mockListOpenWaveBeadsAllRepos.mockResolvedValueOnce([
        { id: "so74.A", title: "Fleet bead", files: ["src/a.ts"] },
        { id: "so74.B", title: "Beads web bead", files: ["src/b.ts"] },
      ]);
      // Bead A lives in fleet-core-improved, bead B lives in beads_web-improved
      mockFindRepoForIssue
        .mockResolvedValueOnce("/Users/janemckay/dev/fleet/fleet-core-improved")
        .mockResolvedValueOnce("/Users/janemckay/dev/claude_projects/beads_web-improved");

      const req = makeRequest({
        epicId: "factory-core-so74",
        epicTitle: "Aspirational Pipeline Phase 2",
        action: "start-wave",
        waveNumber: 2,
        currentLabels: ["ship-type:internal"],
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      // findRepoForIssue called once per bead.
      expect(mockFindRepoForIssue).toHaveBeenCalledTimes(2);
      expect(mockFindRepoForIssue).toHaveBeenCalledWith("so74.A");
      expect(mockFindRepoForIssue).toHaveBeenCalledWith("so74.B");
    });

    it("4jb AC 5: per-bead dispatch uses cached repo for loadBeadDetail and launchAgent", async () => {
      const fleetCorePath = "/Users/janemckay/dev/fleet/fleet-core-improved";
      const beadsWebPath = "/Users/janemckay/dev/claude_projects/beads_web-improved";

      mockGetRepos.mockResolvedValueOnce({
        repos: [{ name: "fleet-core-improved", path: fleetCorePath }],
      });
      mockListOpenWaveBeadsAllRepos.mockResolvedValueOnce([
        { id: "so74.A", title: "Fleet bead", files: ["src/a.ts"] },
        { id: "so74.B", title: "Beads web bead", files: ["src/b.ts"] },
      ]);
      mockFindRepoForIssue
        .mockResolvedValueOnce(fleetCorePath)
        .mockResolvedValueOnce(beadsWebPath);

      const req = makeRequest({
        epicId: "factory-core-so74",
        epicTitle: "Aspirational Pipeline Phase 2",
        action: "start-wave",
        waveNumber: 2,
        currentLabels: ["ship-type:internal"],
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.dispatched).toBe("per-bead");
      expect(data.launched).toHaveLength(2);

      // loadBeadDetail called with each bead's resolved repo path
      expect(mockLoadBeadDetail).toHaveBeenCalledWith("so74.A", fleetCorePath);
      expect(mockLoadBeadDetail).toHaveBeenCalledWith("so74.B", beadsWebPath);

      // launchAgent called with each bead's resolved repo path
      const launchCalls = mockLaunchAgent.mock.calls;
      const callA = launchCalls.find(
        (c: unknown[]) => (c[0] as { beadId: string }).beadId === "so74.A",
      );
      const callB = launchCalls.find(
        (c: unknown[]) => (c[0] as { beadId: string }).beadId === "so74.B",
      );
      expect(callA).toBeDefined();
      expect(callB).toBeDefined();
      expect((callA![0] as { repoPath: string }).repoPath).toBe(fleetCorePath);
      expect((callB![0] as { repoPath: string }).repoPath).toBe(beadsWebPath);
    });

    it("4jb AC 6: bounding-rule assertion throws for product epic with cross-repo child", async () => {
      // Product epic (basename "fleet-core", NOT "fleet-core-improved")
      // has a bead that findRepoForIssue resolves to a different repo.
      mockListOpenWaveBeads.mockResolvedValueOnce([
        { id: "z9h.X", title: "Misplaced bead", files: ["src/x.ts"] },
      ]);
      // The bead resolves to a different repo — bounding-rule violation!
      mockFindRepoForIssue.mockResolvedValueOnce(
        "/Users/janemckay/dev/claude_projects/beads_web-improved",
      );

      const req = makeRequest({
        epicId: "factory-core-z9h",
        epicTitle: "Fully autonomous pipeline",
        action: "start-wave",
        waveNumber: 1,
        currentLabels: ["ship-type:internal"],
      });
      const res = await POST(req);
      expect(res.status).toBe(500);

      const data = await res.json();
      expect(data.error).toContain("Bounding-rule violation");
      expect(data.error).toContain("z9h.X");
      expect(data.error).toContain("beads_web-improved");
      expect(data.error).toContain("fleet-core");

      // No agent launched — the handler returned 500 before dispatch.
      expect(mockLaunchAgent).not.toHaveBeenCalled();
    });

    it("4jb AC 7: structured logging emits at three points", async () => {
      const infoSpy = jest.spyOn(console, "info").mockImplementation();

      mockGetRepos.mockResolvedValueOnce({
        repos: [
          {
            name: "fleet-core-improved",
            path: "/Users/janemckay/dev/fleet/fleet-core-improved",
          },
        ],
      });
      mockListOpenWaveBeadsAllRepos.mockResolvedValueOnce([
        { id: "so74.A", title: "Bead A", files: ["src/a.ts"] },
      ]);
      mockFindRepoForIssue.mockResolvedValueOnce(
        "/Users/janemckay/dev/fleet/fleet-core-improved",
      );

      const req = makeRequest({
        epicId: "factory-core-so74",
        epicTitle: "Aspirational Pipeline Phase 2",
        action: "start-wave",
        waveNumber: 2,
        currentLabels: ["ship-type:internal"],
      });
      await POST(req);

      const infoMessages = infoSpy.mock.calls.map((c) => c[0] as string);

      // Emission point 1: bounding-rule decision
      expect(infoMessages).toContainEqual(
        expect.stringContaining("[cross-repo] Epic factory-core-so74 resolved to"),
      );
      expect(infoMessages).toContainEqual(
        expect.stringContaining("isCrossRepoEpic: true"),
      );

      // Emission point 2: cache entry
      expect(infoMessages).toContainEqual(
        expect.stringContaining("[cross-repo] Bead so74.A resolved to"),
      );

      // Emission point 3: bounding rule check passed
      expect(infoMessages).toContainEqual(
        expect.stringContaining("[cross-repo] Bounding rule check passed for epic factory-core-so74"),
      );

      infoSpy.mockRestore();
    });

    it("4jb AC 8: listOpenWaveBeadsAllRepos failure returns 500 (z9h.9 contract preserved)", async () => {
      mockGetRepos.mockResolvedValueOnce({
        repos: [
          {
            name: "fleet-core-improved",
            path: "/Users/janemckay/dev/fleet/fleet-core-improved",
          },
        ],
      });
      mockListOpenWaveBeadsAllRepos.mockRejectedValueOnce(
        new Error(
          "listOpenWaveBeadsAllRepos: bd failed in 1 repo(s) for epic factory-core-so74 wave 2: /bad/repo",
        ),
      );

      const req = makeRequest({
        epicId: "factory-core-so74",
        epicTitle: "Aspirational Pipeline Phase 2",
        action: "start-wave",
        waveNumber: 2,
        currentLabels: ["ship-type:internal"],
      });
      const res = await POST(req);
      expect(res.status).toBe(500);

      const data = await res.json();
      expect(data.error).toContain("Failed to enumerate open wave beads");
      expect(data.error).toContain("bd failed in 1 repo(s)");
      expect(mockLaunchAgent).not.toHaveBeenCalled();
    });

    it("4jb AC 4 risk: cache pre-populate failure returns 500 (no silent fallback)", async () => {
      // If findRepoForIssue rejects during the parallel fanout, the handler
      // must return 500 — NOT silently fall back to waveRepoPath.
      mockGetRepos.mockResolvedValueOnce({
        repos: [
          {
            name: "fleet-core-improved",
            path: "/Users/janemckay/dev/fleet/fleet-core-improved",
          },
        ],
      });
      mockListOpenWaveBeadsAllRepos.mockResolvedValueOnce([
        { id: "so74.A", title: "Bead A", files: ["src/a.ts"] },
      ]);
      mockFindRepoForIssue.mockRejectedValueOnce(
        new Error("findRepoForIssue: dolt connection refused"),
      );

      const req = makeRequest({
        epicId: "factory-core-so74",
        epicTitle: "Aspirational Pipeline Phase 2",
        action: "start-wave",
        waveNumber: 2,
        currentLabels: ["ship-type:internal"],
      });
      const res = await POST(req);
      expect(res.status).toBe(500);

      const data = await res.json();
      expect(data.error).toContain("cache pre-populate");
      expect(mockLaunchAgent).not.toHaveBeenCalled();
    });

    it("4jb AC 9: kill-switch passthrough — no special-case logic in route.ts", async () => {
      // When CROSS_REPO_DISPATCH_ENABLED=false, listOpenWaveBeadsAllRepos
      // internally falls through to single-repo behaviour. The route
      // handler calls it without checking the kill-switch — the gate is
      // entirely inside A.1's implementation. This test verifies that the
      // cross-repo code path in route.ts does NOT check the env var
      // itself — it delegates to listOpenWaveBeadsAllRepos unconditionally
      // when isCrossRepoEpic is true.
      mockGetRepos.mockResolvedValueOnce({
        repos: [
          {
            name: "fleet-core-improved",
            path: "/Users/janemckay/dev/fleet/fleet-core-improved",
          },
        ],
      });
      mockListOpenWaveBeadsAllRepos.mockResolvedValueOnce([]);

      const req = makeRequest({
        epicId: "factory-core-so74",
        epicTitle: "Aspirational Pipeline Phase 2",
        action: "start-wave",
        waveNumber: 2,
        currentLabels: ["ship-type:internal"],
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      // listOpenWaveBeadsAllRepos called (not listOpenWaveBeads) —
      // the kill-switch is handled inside listOpenWaveBeadsAllRepos.
      expect(mockListOpenWaveBeadsAllRepos).toHaveBeenCalledWith(
        "factory-core-so74",
        2,
      );
    });

    it("4jb AC 6: bounding rule passes when all product-epic beads resolve to the same repo", async () => {
      // Product epic (basename "fleet-core") where all beads resolve to
      // fleet-core. The bounding-rule assertion should NOT fire.
      mockListOpenWaveBeads.mockResolvedValueOnce([
        { id: "z9h.A", title: "Alpha", files: ["src/a.ts"] },
        { id: "z9h.B", title: "Beta", files: ["src/b.ts"] },
      ]);
      mockFindRepoForIssue
        .mockResolvedValueOnce("/Users/janemckay/dev/fleet/fleet-core")
        .mockResolvedValueOnce("/Users/janemckay/dev/fleet/fleet-core");

      const req = makeRequest({
        epicId: "factory-core-z9h",
        epicTitle: "Fully autonomous pipeline",
        action: "start-wave",
        waveNumber: 1,
        currentLabels: ["ship-type:internal"],
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      // Agents launched — bounding rule passed.
      const data = await res.json();
      expect(data.dispatched).toBe("per-bead");
      expect(data.launched).toHaveLength(2);
    });

    it("4jb AC 5: isAgentActive uses cached repo path (cross-repo bead-ID check)", async () => {
      const fleetCorePath = "/Users/janemckay/dev/fleet/fleet-core-improved";
      const beadsWebPath = "/Users/janemckay/dev/claude_projects/beads_web-improved";

      mockGetRepos.mockResolvedValueOnce({
        repos: [{ name: "fleet-core-improved", path: fleetCorePath }],
      });
      mockListOpenWaveBeadsAllRepos.mockResolvedValueOnce([
        { id: "so74.A", title: "Fleet bead", files: ["src/a.ts"] },
        { id: "so74.B", title: "Beads web bead", files: ["src/b.ts"] },
      ]);
      mockFindRepoForIssue
        .mockResolvedValueOnce(fleetCorePath)
        .mockResolvedValueOnce(beadsWebPath);
      // so74.A is already active at its resolved repo; so74.B is not.
      mockIsAgentActive.mockImplementation(
        (repo: string, beadId?: string) => {
          return repo === fleetCorePath && beadId === "so74.A";
        },
      );

      const req = makeRequest({
        epicId: "factory-core-so74",
        epicTitle: "Aspirational Pipeline Phase 2",
        action: "start-wave",
        waveNumber: 2,
        currentLabels: ["ship-type:internal"],
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      const data = await res.json();
      // so74.A skipped (active), so74.B launched.
      expect(data.skipped).toHaveLength(1);
      expect(data.skipped[0].beadId).toBe("so74.A");
      expect(data.launched).toHaveLength(1);
      expect(data.launched[0].beadId).toBe("so74.B");

      // isAgentActive was called with the CACHED repo path, not waveRepoPath.
      expect(mockIsAgentActive).toHaveBeenCalledWith(fleetCorePath, "so74.A");
      expect(mockIsAgentActive).toHaveBeenCalledWith(beadsWebPath, "so74.B");

      mockIsAgentActive.mockImplementation(() => false);
    });

    // AC 10: integration test scaffold for A.8 — the structure is ready
    // (listOpenWaveBeadsAllRepos, beadRepoCache, per-bead repo dispatch)
    // for A.8 to exercise end-to-end. This test documents the intended
    // integration scenario.
    it("4jb AC 10: integration test scaffold — cross-repo epic dispatches beads to correct cwds", async () => {
      const fleetCorePath = "/Users/janemckay/dev/fleet/fleet-core-improved";
      const beadsWebPath = "/Users/janemckay/dev/claude_projects/beads_web-improved";

      mockGetRepos.mockResolvedValueOnce({
        repos: [{ name: "fleet-core-improved", path: fleetCorePath }],
      });
      mockListOpenWaveBeadsAllRepos.mockResolvedValueOnce([
        { id: "so74.fleet", title: "Fleet-core bead", files: ["src/fleet.ts"] },
        { id: "so74.web", title: "Beads-web bead", files: ["src/web.ts"] },
      ]);
      mockFindRepoForIssue
        .mockResolvedValueOnce(fleetCorePath)
        .mockResolvedValueOnce(beadsWebPath);

      const req = makeRequest({
        epicId: "factory-core-so74",
        epicTitle: "Aspirational Pipeline Phase 2",
        action: "start-wave",
        waveNumber: 2,
        currentLabels: ["ship-type:internal"],
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.dispatched).toBe("per-bead");
      expect(data.launched).toHaveLength(2);

      // Both beads dispatched to their correct cwd.
      const launchCalls = mockLaunchAgent.mock.calls;
      const fleetCall = launchCalls.find(
        (c: unknown[]) => (c[0] as { beadId: string }).beadId === "so74.fleet",
      );
      const webCall = launchCalls.find(
        (c: unknown[]) => (c[0] as { beadId: string }).beadId === "so74.web",
      );
      expect((fleetCall![0] as { repoPath: string }).repoPath).toBe(fleetCorePath);
      expect((webCall![0] as { repoPath: string }).repoPath).toBe(beadsWebPath);

      // This is the scaffold for A.8's integration test — A.8 will add
      // real bd/agent lifecycle assertions on top of this dispatch shape.
    });
  });

  // -------------------------------------------------------------------------
  // factory-core-ppx.8: cache scope sweep — every action handler passes a
  // scoped CacheScope to `invalidateCache`. The call used to be bare
  // (`invalidateCache()`), which wiped every cache entry. Post-sweep each
  // call site passes `{type:"epic",epicId}` so sibling epics' cache entries
  // survive the mutation (Feature 5 AC — per-epic invalidation).
  //
  // We cover a representative sample across the full set of pipeline stages:
  //   - start-research              (candidates → research)
  //   - generate-plan               (research-complete → plan-review)
  //   - approve-and-build           (plan-review → test-spec)
  //   - start-wave                  (development — per-wave launch)
  //   - send-for-qa                 (development → qa)
  //   - stop-agent                  (any → remove agent:running)
  //   - human-approve               (label-only mutation)
  //
  // The lint-style guard in __tests__/lib/bv-client.scope-sweep.test.ts
  // owns the complete file-level sweep assertion (zero bare calls). This
  // block owns the behavioural assertion — the scope argument is actually
  // derived from the request's epicId.
  // -------------------------------------------------------------------------

  describe("invalidateCache scope (factory-core-ppx.8)", () => {
    it("start-research passes {type:'epic',epicId}", async () => {
      const req = makeRequest({
        epicId: "epic-sweep-1",
        epicTitle: "LensCycle",
        action: "start-research",
      });
      await POST(req);
      expect(mockInvalidateCache).toHaveBeenCalledWith({
        type: "epic",
        epicId: "epic-sweep-1",
      });
    });

    it("generate-plan passes {type:'epic',epicId}", async () => {
      const req = makeRequest({
        epicId: "epic-sweep-2",
        epicTitle: "LensCycle",
        action: "generate-plan",
        currentLabels: ["ship-type:ios-app"],
      });
      await POST(req);
      expect(mockInvalidateCache).toHaveBeenCalledWith({
        type: "epic",
        epicId: "epic-sweep-2",
      });
    });

    it("approve-and-build passes {type:'epic',epicId}", async () => {
      const req = makeRequest({
        epicId: "epic-sweep-3",
        epicTitle: "LensCycle",
        action: "approve-and-build",
        currentLabels: ["ship-type:ios-app"],
      });
      await POST(req);
      expect(mockInvalidateCache).toHaveBeenCalledWith({
        type: "epic",
        epicId: "epic-sweep-3",
      });
    });

    it("start-wave passes {type:'epic',epicId}", async () => {
      const req = makeRequest({
        epicId: "epic-sweep-4",
        epicTitle: "LensCycle",
        action: "start-wave",
        waveNumber: 1,
        currentLabels: ["ship-type:ios-app"],
      });
      await POST(req);
      expect(mockInvalidateCache).toHaveBeenCalledWith({
        type: "epic",
        epicId: "epic-sweep-4",
      });
    });

    it("send-for-qa passes {type:'epic',epicId}", async () => {
      const req = makeRequest({
        epicId: "epic-sweep-5",
        epicTitle: "LensCycle",
        action: "send-for-qa",
        currentLabels: ["ship-type:ios-app"],
      });
      await POST(req);
      expect(mockInvalidateCache).toHaveBeenCalledWith({
        type: "epic",
        epicId: "epic-sweep-5",
      });
    });

    it("stop-agent passes {type:'epic',epicId}", async () => {
      const req = makeRequest({
        epicId: "epic-sweep-6",
        epicTitle: "LensCycle",
        action: "stop-agent",
      });
      await POST(req);
      expect(mockInvalidateCache).toHaveBeenCalledWith({
        type: "epic",
        epicId: "epic-sweep-6",
      });
    });

    it("human-approve passes {type:'epic',epicId}", async () => {
      const req = makeRequest({
        epicId: "epic-sweep-7",
        epicTitle: "LensCycle",
        action: "human-approve",
        targetLabel: "checkpoint:human-verify",
      });
      await POST(req);
      expect(mockInvalidateCache).toHaveBeenCalledWith({
        type: "epic",
        epicId: "epic-sweep-7",
      });
    });

    it("human-dismiss (label path) passes {type:'epic',epicId}", async () => {
      const req = makeRequest({
        epicId: "epic-sweep-8",
        epicTitle: "LensCycle",
        action: "human-dismiss",
        targetLabel: "checkpoint:decision",
      });
      await POST(req);
      expect(mockInvalidateCache).toHaveBeenCalledWith({
        type: "epic",
        epicId: "epic-sweep-8",
      });
    });

    it("deprioritise passes {type:'epic',epicId} even though it closes the epic", async () => {
      // Regression check: closeEpic + invalidateCache — scope must still be
      // epic-bound. A bulk-action regression would pass {type:"global"} here
      // and needlessly wipe sibling epics' caches.
      const req = makeRequest({
        epicId: "epic-sweep-9",
        epicTitle: "LensCycle",
        action: "deprioritise",
      });
      await POST(req);
      expect(mockInvalidateCache).toHaveBeenCalledWith({
        type: "epic",
        epicId: "epic-sweep-9",
      });
    });

    it("isolates epics: invalidating epic A never passes epic B's id", async () => {
      // Feature 5 AC verbatim: per-epic invalidation must not leak between
      // epics. We fire two actions back-to-back and assert the spy captured
      // the right epic scope each time.
      await POST(
        makeRequest({
          epicId: "epic-A",
          epicTitle: "LensCycle",
          action: "start-research",
        }),
      );
      await POST(
        makeRequest({
          epicId: "epic-B",
          epicTitle: "MindStack",
          action: "start-research",
        }),
      );
      const calls = mockInvalidateCache.mock.calls;
      expect(calls).toContainEqual([{ type: "epic", epicId: "epic-A" }]);
      expect(calls).toContainEqual([{ type: "epic", epicId: "epic-B" }]);
      // Sanity: neither call cross-contaminates the other.
      const epicIds = calls
        .map((args) => (args[0] as { epicId?: string })?.epicId)
        .filter(Boolean);
      expect(epicIds).toEqual(expect.arrayContaining(["epic-A", "epic-B"]));
    });

    it("never invokes invalidateCache with a bare / undefined scope", async () => {
      // This is the behaviour half of the lint guard. Every recorded call
      // must carry a non-undefined first argument. The lint test ensures the
      // source file has no bare calls; THIS test ensures that even if the
      // route handler hits a code path we haven't enumerated above, the
      // scope argument is still present.
      await POST(
        makeRequest({
          epicId: "epic-never-bare",
          epicTitle: "LensCycle",
          action: "approve-plan",
        }),
      );
      expect(mockInvalidateCache).toHaveBeenCalled();
      for (const args of mockInvalidateCache.mock.calls) {
        expect(args[0]).toBeDefined();
        expect((args[0] as { type?: string }).type).toBeDefined();
      }
    });
  });

  // -------------------------------------------------------------------------
  // factory-core-k7gy.5 — plan-review auto-chain actions
  // -------------------------------------------------------------------------

  describe("review-plan (k7gy.5 F5)", () => {
    it("applies plan:reviewing + pipeline:plan-review + agent:running and removes plan:pending", async () => {
      const req = makeRequest({
        epicId: "epic-rp-1",
        epicTitle: "Internal: k7gy",
        action: "review-plan",
        fromChain: true,
        currentLabels: ["ship-type:internal", "pipeline:plan-review", "plan:pending"],
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      expect(mockRemoveLabels).toHaveBeenCalledWith(
        "epic-rp-1",
        ["plan:pending"],
        expect.any(String),
      );
      expect(mockAddLabels).toHaveBeenCalledWith(
        "epic-rp-1",
        ["plan:reviewing", "pipeline:plan-review", "agent:running"],
        expect.any(String),
      );
    });

    it("launches reviewer with pipelineStage=plan-review + model=opus", async () => {
      const req = makeRequest({
        epicId: "epic-rp-2",
        epicTitle: "Internal: k7gy",
        action: "review-plan",
        fromChain: true,
        currentLabels: ["ship-type:internal"],
      });
      await POST(req);

      expect(mockLaunchAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          pipelineStage: "plan-review",
          agentName: "reviewer",
          model: "opus",
          maxTurns: 200,
        }),
      );
    });

    it("prompt references the epic title, spec, and Stage 3 reviewer instructions", async () => {
      const req = makeRequest({
        epicId: "epic-rp-3",
        epicTitle: "LensCycle: tracker",
        action: "review-plan",
        currentLabels: ["ship-type:ios-app"],
      });
      await POST(req);

      const call = mockLaunchAgent.mock.calls.at(-1);
      const args = call?.[0] as { prompt?: string };
      expect(args?.prompt).toMatch(/LensCycle: tracker/);
      expect(args?.prompt).toMatch(/stage: plan/);
      expect(args?.prompt).toMatch(/reviewer\.md/);
      // All placeholders must be substituted — no raw {{...}} leaks.
      expect(args?.prompt).not.toMatch(/\{\{[^}]+\}\}/);
    });

    it("rolls back plan:reviewing and restores plan:pending on launch failure", async () => {
      mockLaunchAgent.mockRejectedValueOnce(new Error("launch failed"));
      const req = makeRequest({
        epicId: "epic-rp-4",
        epicTitle: "Internal: k7gy",
        action: "review-plan",
        currentLabels: ["ship-type:internal", "plan:pending"],
      });
      const res = await POST(req);
      expect(res.status).toBe(500);

      // Provisional labels added first, then rolled back.
      expect(mockAddLabels).toHaveBeenCalledWith(
        "epic-rp-4",
        ["plan:reviewing", "pipeline:plan-review", "agent:running"],
        expect.any(String),
      );
      // Rollback path.
      expect(mockRemoveLabels).toHaveBeenCalledWith(
        "epic-rp-4",
        ["plan:reviewing", "agent:running"],
        expect.any(String),
      );
      expect(mockAddLabels).toHaveBeenCalledWith(
        "epic-rp-4",
        ["plan:pending"],
        expect.any(String),
      );
    });
  });

  describe("revise-plan-from-review (k7gy.5 F7)", () => {
    it("applies plan:needs-revision + plan:revise-round-N and removes plan:reviewing", async () => {
      const req = makeRequest({
        epicId: "epic-rr-1",
        epicTitle: "Internal: k7gy",
        action: "revise-plan-from-review",
        fromChain: true,
        currentRound: 1,
        reviewFilePath: ".beads/plans/epic-rr-1-review.md",
        currentLabels: ["plan:reviewing"],
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      expect(mockRemoveLabels).toHaveBeenCalledWith(
        "epic-rr-1",
        ["plan:reviewing", "plan:reviewed"],
        expect.any(String),
      );
      expect(mockAddLabels).toHaveBeenCalledWith(
        "epic-rr-1",
        [
          "plan:needs-revision",
          "plan:revise-round-1",
          "pipeline:plan-review",
          "agent:running",
        ],
        expect.any(String),
      );
    });

    it("accepts currentRound 1, 2, 3 and picks the correct round label", async () => {
      for (const round of [1, 2, 3]) {
        jest.clearAllMocks();
        const req = makeRequest({
          epicId: `epic-rr-${round}`,
          epicTitle: "Internal: k7gy",
          action: "revise-plan-from-review",
          currentRound: round,
          reviewFilePath: ".beads/plans/x-review.md",
          currentLabels: ["plan:reviewing"],
        });
        const res = await POST(req);
        expect(res.status).toBe(200);
        expect(mockAddLabels).toHaveBeenCalledWith(
          `epic-rr-${round}`,
          expect.arrayContaining([`plan:revise-round-${round}`]),
          expect.any(String),
        );
      }
    });

    it("returns 400 when reviewFilePath is missing", async () => {
      const req = makeRequest({
        epicId: "epic-rr-bad",
        epicTitle: "Internal: k7gy",
        action: "revise-plan-from-review",
        currentRound: 1,
        currentLabels: [],
      });
      const res = await POST(req);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/reviewFilePath/);
      expect(mockLaunchAgent).not.toHaveBeenCalled();
    });

    it("returns 400 for currentRound outside 1..3 (boundary: 0, 4, 99)", async () => {
      for (const bad of [0, 4, 99, -1]) {
        jest.clearAllMocks();
        const req = makeRequest({
          epicId: "epic-rr-bad",
          epicTitle: "Internal: k7gy",
          action: "revise-plan-from-review",
          currentRound: bad,
          reviewFilePath: ".beads/plans/x-review.md",
          currentLabels: [],
        });
        const res = await POST(req);
        expect(res.status).toBe(400);
        expect(mockLaunchAgent).not.toHaveBeenCalled();
      }
    });

    it("re-launches planner with --feedback=<path> in the prompt args", async () => {
      const req = makeRequest({
        epicId: "epic-rr-prompt",
        epicTitle: "Internal: k7gy",
        action: "revise-plan-from-review",
        currentRound: 2,
        reviewFilePath: ".beads/plans/epic-rr-prompt-review.md",
        currentLabels: ["plan:reviewing", "plan:revise-round-1"],
      });
      await POST(req);
      const call = mockLaunchAgent.mock.calls.at(-1);
      const args = call?.[0] as { prompt?: string; agentName?: string; pipelineStage?: string };
      expect(args?.agentName).toBe("planner");
      expect(args?.pipelineStage).toBe("planning");
      expect(args?.prompt).toMatch(/--feedback=\.beads\/plans\/epic-rr-prompt-review\.md/);
    });

    it("rolls back on launch failure — plan:needs-revision cleared", async () => {
      mockLaunchAgent.mockRejectedValueOnce(new Error("boom"));
      const req = makeRequest({
        epicId: "epic-rr-fail",
        epicTitle: "Internal: k7gy",
        action: "revise-plan-from-review",
        currentRound: 1,
        reviewFilePath: ".beads/plans/epic-rr-fail-review.md",
        currentLabels: ["plan:reviewing"],
      });
      const res = await POST(req);
      expect(res.status).toBe(500);

      // Expect rollback removal.
      expect(mockRemoveLabels).toHaveBeenCalledWith(
        "epic-rr-fail",
        ["plan:needs-revision", "plan:revise-round-1", "agent:running"],
        expect.any(String),
      );
    });
  });

  describe("approve-and-build fromChain: true (k7gy.5 F6)", () => {
    it("removes plan:reviewing and NOT plan:pending when fromChain is true", async () => {
      const req = makeRequest({
        epicId: "epic-ab-chain",
        epicTitle: "Internal: k7gy",
        action: "approve-and-build",
        fromChain: true,
        currentLabels: ["plan:reviewing"],
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      // Chain path strips reviewing + reviewed + needs-revision — not pending.
      expect(mockRemoveLabels).toHaveBeenCalledWith(
        "epic-ab-chain",
        [
          "pipeline:research-complete",
          "plan:reviewing",
          "plan:reviewed",
          "plan:needs-revision",
        ],
        expect.any(String),
      );
    });

    it("owner-click path (no fromChain) still removes plan:pending — byte-identical to pre-k7gy", async () => {
      const req = makeRequest({
        epicId: "epic-ab-owner",
        epicTitle: "Internal: k7gy",
        action: "approve-and-build",
        currentLabels: ["plan:pending"],
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      expect(mockRemoveLabels).toHaveBeenCalledWith(
        "epic-ab-owner",
        ["pipeline:research-complete", "plan:pending"],
        expect.any(String),
      );
    });

    it("fromChain: false (explicit) behaves identically to absent — owner-click path", async () => {
      const req = makeRequest({
        epicId: "epic-ab-false",
        epicTitle: "Internal: k7gy",
        action: "approve-and-build",
        fromChain: false,
        currentLabels: ["plan:pending"],
      });
      await POST(req);

      expect(mockRemoveLabels).toHaveBeenCalledWith(
        "epic-ab-false",
        ["pipeline:research-complete", "plan:pending"],
        expect.any(String),
      );
    });
  });
});
