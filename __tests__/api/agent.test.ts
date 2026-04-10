// =============================================================================
// Tests for src/app/api/agent/route.ts — GET & POST /api/agent
// =============================================================================

import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockLaunchAgent = jest.fn();
const mockGetAgentStatus = jest.fn();
const mockStopAgent = jest.fn();

const mockGetFleetAgentStatus = jest.fn();

jest.mock("@/lib/agent-launcher", () => ({
  launchAgent: (...args: unknown[]) => mockLaunchAgent(...args),
  getAgentStatus: (...args: unknown[]) => mockGetAgentStatus(...args),
  getFleetAgentStatus: () => mockGetFleetAgentStatus(),
  stopAgent: (...args: unknown[]) => mockStopAgent(...args),
}));

jest.mock("@/lib/repo-config", () => ({
  getAllRepoPaths: jest.fn().mockResolvedValue(["/tmp/test-project", "/tmp/fleet-core"]),
  getRepos: jest.fn().mockResolvedValue({
    repos: [
      { name: "test-project", path: "/tmp/test-project" },
      { name: "fleet-core", path: "/tmp/fleet-core" },
    ],
  }),
}));

import { GET, POST } from "@/app/api/agent/route";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePostRequest(body: object): NextRequest {
  return new NextRequest("http://localhost:3000/api/agent", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

function makeGetRequest(params?: Record<string, string>): NextRequest {
  const url = new URL("http://localhost:3000/api/agent");
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  }
  return new NextRequest(url);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/agent", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns agent status when no agent running", async () => {
    mockGetAgentStatus.mockResolvedValue({ running: false, session: null });

    const response = await GET(makeGetRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ running: false, session: null });
  });

  it("returns agent status with session when running", async () => {
    const session = {
      pid: 12345,
      repoPath: "/tmp/fleet-core",
      repoName: "fleet-core",
      prompt: "Research LensCycle",
      model: "sonnet",
      startedAt: "2026-02-15T10:00:00Z",
      logFile: "/tmp/logs/agent.log",
    };
    mockGetAgentStatus.mockResolvedValue({
      running: true,
      session,
      recentLog: "Working...",
    });

    const response = await GET(makeGetRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.running).toBe(true);
    expect(body.session.pid).toBe(12345);
    expect(body.recentLog).toBe("Working...");
  });

  it("returns fleet status when fleet=true", async () => {
    mockGetFleetAgentStatus.mockResolvedValue({
      agents: [],
      totalRunning: 0,
    });

    const response = await GET(makeGetRequest({ fleet: "true" }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.totalRunning).toBe(0);
    expect(body.agents).toEqual([]);
  });

  it("returns 500 when getAgentStatus throws", async () => {
    mockGetAgentStatus.mockRejectedValue(new Error("disk error"));

    const response = await GET(makeGetRequest());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toContain("disk error");
  });
});

describe("POST /api/agent — launch", () => {
  beforeEach(() => jest.clearAllMocks());

  it("launches agent with valid params", async () => {
    const session = {
      pid: 99999,
      repoPath: "/tmp/fleet-core",
      repoName: "fleet-core",
      prompt: "Research app",
      model: "sonnet",
      startedAt: "2026-02-15T10:00:00Z",
      logFile: "/tmp/logs/agent.log",
    };
    mockLaunchAgent.mockResolvedValue(session);

    const response = await POST(
      makePostRequest({
        action: "launch",
        repoPath: "/tmp/fleet-core",
        prompt: "Research app",
        model: "sonnet",
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.launched).toBe(true);
    expect(body.session.pid).toBe(99999);
    expect(mockLaunchAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        repoPath: "/tmp/fleet-core",
        repoName: "fleet-core",
        prompt: "Research app",
        model: "sonnet",
      }),
    );
  });

  it("returns 400 when repoPath is missing", async () => {
    const response = await POST(
      makePostRequest({ action: "launch", prompt: "Do work" }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain("Missing repoPath");
  });

  it("returns 400 when prompt is missing", async () => {
    const response = await POST(
      makePostRequest({ action: "launch", repoPath: "/tmp/fleet-core" }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain("Missing prompt");
  });

  it("returns 400 when repo is not configured", async () => {
    const response = await POST(
      makePostRequest({
        action: "launch",
        repoPath: "/tmp/unknown-repo",
        prompt: "Do work",
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain("Repository not configured");
  });

  it("returns 409 when agent already running", async () => {
    mockLaunchAgent.mockRejectedValue(
      new Error("Agent already running (PID 1234)"),
    );

    const response = await POST(
      makePostRequest({
        action: "launch",
        repoPath: "/tmp/fleet-core",
        prompt: "Research app",
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toContain("Agent already running");
  });
});

describe("POST /api/agent — stop", () => {
  beforeEach(() => jest.clearAllMocks());

  it("stops running agent", async () => {
    mockStopAgent.mockResolvedValue({ stopped: true, pid: 12345 });

    const response = await POST(
      makePostRequest({ action: "stop" }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.stopped).toBe(true);
    expect(body.pid).toBe(12345);
  });

  it("returns stopped=false when no agent running", async () => {
    mockStopAgent.mockResolvedValue({ stopped: false });

    const response = await POST(
      makePostRequest({ action: "stop" }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.stopped).toBe(false);
  });

  it("returns 500 when stop fails", async () => {
    mockStopAgent.mockRejectedValue(new Error("kill failed"));

    const response = await POST(
      makePostRequest({ action: "stop" }),
    );
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toContain("kill failed");
  });
});

describe("POST /api/agent — validation", () => {
  it("returns 400 for invalid JSON body", async () => {
    const request = new NextRequest("http://localhost:3000/api/agent", {
      method: "POST",
      body: "not json",
    });
    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain("Invalid JSON");
  });

  it("returns 400 for unknown action", async () => {
    const response = await POST(
      makePostRequest({ action: "restart" }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain("Unknown action");
  });
});
