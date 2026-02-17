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
const mockRemoveAllPipeline = jest.fn().mockResolvedValue(undefined);
const mockCloseEpic = jest.fn().mockResolvedValue(undefined);
const mockUpdateStatus = jest.fn().mockResolvedValue(undefined);

jest.mock("@/lib/pipeline-labels", () => ({
  addLabelsToEpic: (...args: unknown[]) => mockAddLabels(...args),
  removeLabelsFromEpic: (...args: unknown[]) => mockRemoveLabels(...args),
  removeAllPipelineLabels: (...args: unknown[]) => mockRemoveAllPipeline(...args),
  closeEpic: (...args: unknown[]) => mockCloseEpic(...args),
  updateEpicStatus: (...args: unknown[]) => mockUpdateStatus(...args),
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

jest.mock("@/lib/agent-launcher", () => ({
  launchAgent: (...args: unknown[]) => mockLaunchAgent(...args),
  stopAgent: () => mockStopAgent(),
}));

// Mock repo-config module
jest.mock("@/lib/repo-config", () => ({
  getRepos: jest.fn().mockResolvedValue({
    repos: [
      {
        name: "cycle-apps-factory",
        path: "/Users/janemckay/dev/claude_projects/cycle-apps-factory",
      },
    ],
  }),
}));

// Mock bv-client invalidateCache
jest.mock("@/lib/bv-client", () => ({
  invalidateCache: jest.fn(),
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
        ["pipeline:research-complete", "plan:pending", "plan:approved"],
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
        "Deprioritised from fleet board",
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

    it("launches submission prep agent with sonnet model", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle",
        action: "approve-submission",
      });
      await POST(req);

      expect(mockLaunchAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "sonnet",
          maxTurns: 100,
          pipelineStage: "submission-prep",
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // send-back-to-dev
  // -------------------------------------------------------------------------

  describe("send-back-to-dev", () => {
    it("removes submission-prep and adds development + agent:running", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle",
        action: "send-back-to-dev",
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      expect(mockRemoveLabels).toHaveBeenCalledWith("epic-1", ["pipeline:submission-prep"], expect.any(String));
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
    it("adds plan:pending and agent:running labels", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle: Contact lens tracker",
        action: "generate-plan",
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      expect(mockAddLabels).toHaveBeenCalledWith(
        "epic-1",
        ["pipeline:research-complete", "plan:pending", "agent:running"],
        expect.any(String),
      );
    });

    it("launches planning agent in the app repo", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle: Contact lens tracker",
        action: "generate-plan",
      });
      await POST(req);

      expect(mockLaunchAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          repoPath: "/Users/janemckay/dev/claude_projects/LensCycle",
          model: "opus",
          maxTurns: 200,
          pipelineStage: "planning",
          epicId: "epic-1",
          prompt: expect.stringContaining("Plan the app"),
        }),
      );
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
    it("removes plan:approved and adds plan:pending + agent:running", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle",
        action: "revise-plan",
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      expect(mockRemoveLabels).toHaveBeenCalledWith("epic-1", ["plan:approved"], expect.any(String));
      expect(mockAddLabels).toHaveBeenCalledWith("epic-1", ["plan:pending", "agent:running"], expect.any(String));
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

    it("launches planning agent in the app repo", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle",
        action: "revise-plan",
      });
      await POST(req);

      expect(mockLaunchAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          repoPath: "/Users/janemckay/dev/claude_projects/LensCycle",
          pipelineStage: "planning",
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // skip-to-plan
  // -------------------------------------------------------------------------

  describe("skip-to-plan", () => {
    it("adds research-complete, plan:pending, agent:running labels", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle: Contact lens tracker",
        action: "skip-to-plan",
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      expect(mockAddLabels).toHaveBeenCalledWith(
        "epic-1",
        ["pipeline:research-complete", "plan:pending", "agent:running"],
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

    it("launches planning agent with no-research prompt", async () => {
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
          prompt: expect.stringContaining("no research report"),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // revise-plan-from-launch
  // -------------------------------------------------------------------------

  describe("revise-plan-from-launch", () => {
    it("removes submission-prep and adds research-complete + plan:pending + agent:running", async () => {
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
        ["pipeline:research-complete", "plan:pending", "agent:running"],
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

    it("launches planning agent in the app repo", async () => {
      const req = makeRequest({
        epicId: "epic-1",
        epicTitle: "LensCycle",
        action: "revise-plan-from-launch",
      });
      await POST(req);

      expect(mockLaunchAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          repoPath: "/Users/janemckay/dev/claude_projects/LensCycle",
          pipelineStage: "planning",
        }),
      );
    });
  });
});
