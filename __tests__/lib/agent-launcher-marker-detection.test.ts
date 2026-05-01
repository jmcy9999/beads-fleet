// =============================================================================
// Integration tests for detectAgentDone marker-first completion detection
// (beads_web-dvm, factory-core-o4lx Wave 1)
// =============================================================================
//
// 6 test cases covering ACs 5 and 6:
//   1. Marker present with terminal status -> return true (AC 5)
//   2. Marker too fresh (<5s) -> fallback to transcript (AC 6 variant)
//   3. Marker missing -> fallback to transcript (AC 6)
//   4. Marker present but non-terminal status -> fallback to transcript
//   5. Marker malformed (readMarker returns null) -> fallback to transcript
//   6. Session missing repoPath/beadId -> skip marker, use transcript
//
// Mock strategy:
//   - jest.mock("fs") to control fs.stat() + fs.open() + fs.read()
//   - jest.mock("../../src/lib/marker-reader") to control readMarker()
//
// The test imports detectAgentDone via the _testOnlyDetectAgentDone export.
// =============================================================================

import { _testOnlyDetectAgentDone, type AgentSession } from "@/lib/agent-launcher";
import { readMarker } from "@/lib/marker-reader";
import { promises as fs } from "fs";

jest.mock("fs", () => {
  const actual = jest.requireActual("fs");
  return {
    ...actual,
    promises: {
      ...actual.promises,
      stat: jest.fn(),
      open: jest.fn(),
    },
  };
});

jest.mock("../../src/lib/marker-reader", () => ({
  readMarker: jest.fn(),
}));

const mockedStat = fs.stat as jest.MockedFunction<typeof fs.stat>;
const mockedOpen = fs.open as jest.MockedFunction<typeof fs.open>;
const mockedReadMarker = readMarker as jest.MockedFunction<typeof readMarker>;

/**
 * Build a minimal AgentSession for testing.
 */
function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    pid: 0,
    repoPath: "/fake/repo",
    repoName: "test-repo",
    prompt: "test prompt",
    model: "opus",
    startedAt: new Date().toISOString(),
    logFile: "/fake/log",
    beadId: "test-bead-123",
    transcriptFile: "/fake/repo/.claude/projects/transcript.jsonl",
    ...overrides,
  };
}

/**
 * Create a mock file handle that returns transcript data with end_turn.
 */
function mockTranscriptWithEndTurn(): void {
  const transcriptLine = JSON.stringify({
    type: "assistant",
    message: { role: "assistant", stop_reason: "end_turn" },
  });
  const buf = Buffer.from(transcriptLine + "\n");

  mockedOpen.mockResolvedValue({
    read: jest.fn().mockImplementation(
      (buffer: Buffer, _offset: number, length: number, _position: number) => {
        buf.copy(buffer, 0, 0, Math.min(length, buf.length));
        return Promise.resolve({ bytesRead: Math.min(length, buf.length), buffer });
      },
    ),
    close: jest.fn().mockResolvedValue(undefined),
  } as unknown as fs.FileHandle);
}

/**
 * Create a mock stat that returns an mtime in the past (>5s old).
 */
function staleStatResult(size = 200): fs.Stats {
  return {
    mtimeMs: Date.now() - 10000, // 10 seconds ago
    size,
  } as fs.Stats;
}

/**
 * Create a mock stat that returns a fresh mtime (<5s old).
 */
function freshStatResult(size = 200): fs.Stats {
  return {
    mtimeMs: Date.now() - 1000, // 1 second ago
    size,
  } as fs.Stats;
}

describe("detectAgentDone — marker-first completion detection (beads_web-dvm)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ---- AC 5: Marker present with terminal status ----
  test("marker present with terminal status -> returns true via marker (not transcript)", async () => {
    const session = makeSession();

    // fs.stat for marker path: stale (>5s old) — eligible for reading
    // fs.stat for transcript path: should NOT be called (marker short-circuits)
    mockedStat.mockResolvedValueOnce(staleStatResult());

    // readMarker returns a valid marker with terminal status
    mockedReadMarker.mockResolvedValue({
      version: "1",
      bead_id: "test-bead-123",
      status: "success",
      stage: "builder",
      started_at: "2026-05-01T14:00:00Z",
      exited_at: "2026-05-01T15:00:00Z",
    });

    const result = await _testOnlyDetectAgentDone(session);

    expect(result).toBe(true);
    // Verify readMarker was called
    expect(mockedReadMarker).toHaveBeenCalledWith("/fake/repo", "test-bead-123");
    // Verify transcript was NOT opened (marker short-circuited)
    expect(mockedOpen).not.toHaveBeenCalled();
  });

  // ---- AC 6 variant: Marker too fresh (<5s) -> fallback to transcript ----
  test("marker too fresh (<5s) -> skips marker, falls back to transcript", async () => {
    const session = makeSession();

    // First stat call: marker path — fresh (<5s), should skip marker
    mockedStat.mockResolvedValueOnce(freshStatResult());
    // Second stat call: transcript path — stale (>5s), eligible for reading
    mockedStat.mockResolvedValueOnce(staleStatResult());

    // readMarker should NOT be called (marker too fresh)
    mockTranscriptWithEndTurn();

    const result = await _testOnlyDetectAgentDone(session);

    expect(result).toBe(true);
    // Verify readMarker was NOT called (marker too fresh)
    expect(mockedReadMarker).not.toHaveBeenCalled();
    // Verify transcript WAS read (fallback path)
    expect(mockedOpen).toHaveBeenCalled();
  });

  // ---- AC 6: Marker missing -> fallback to transcript ----
  test("marker missing (ENOENT) -> falls back to transcript", async () => {
    const session = makeSession();

    // First stat call: marker path — throws ENOENT
    const enoent = new Error("ENOENT") as NodeJS.ErrnoException;
    enoent.code = "ENOENT";
    mockedStat.mockRejectedValueOnce(enoent);
    // Second stat call: transcript path — stale (>5s)
    mockedStat.mockResolvedValueOnce(staleStatResult());

    mockTranscriptWithEndTurn();

    const result = await _testOnlyDetectAgentDone(session);

    expect(result).toBe(true);
    // Verify readMarker was NOT called (marker file doesn't exist)
    expect(mockedReadMarker).not.toHaveBeenCalled();
    // Verify transcript WAS read (fallback path)
    expect(mockedOpen).toHaveBeenCalled();
  });

  // ---- Marker present but non-terminal status -> fallback to transcript ----
  test("marker present with non-terminal status -> falls back to transcript", async () => {
    const session = makeSession();

    // First stat call: marker path — stale (>5s)
    mockedStat.mockResolvedValueOnce(staleStatResult());
    // Second stat call: transcript path — stale (>5s)
    mockedStat.mockResolvedValueOnce(staleStatResult());

    // readMarker returns a marker with non-terminal status
    mockedReadMarker.mockResolvedValue({
      version: "1",
      bead_id: "test-bead-123",
      status: "in-progress" as "success", // Force non-terminal value
      stage: "builder",
      started_at: "2026-05-01T14:00:00Z",
      exited_at: "2026-05-01T15:00:00Z",
    });

    mockTranscriptWithEndTurn();

    const result = await _testOnlyDetectAgentDone(session);

    expect(result).toBe(true);
    // Verify readMarker WAS called (marker file exists and is stable)
    expect(mockedReadMarker).toHaveBeenCalledWith("/fake/repo", "test-bead-123");
    // Verify transcript WAS read (non-terminal status triggered fallback)
    expect(mockedOpen).toHaveBeenCalled();
  });

  // ---- Marker malformed (readMarker returns null) -> fallback to transcript ----
  test("marker malformed (readMarker returns null) -> falls back to transcript", async () => {
    const session = makeSession();

    // First stat call: marker path — stale (>5s)
    mockedStat.mockResolvedValueOnce(staleStatResult());
    // Second stat call: transcript path — stale (>5s)
    mockedStat.mockResolvedValueOnce(staleStatResult());

    // readMarker returns null (malformed file)
    mockedReadMarker.mockResolvedValue(null);

    mockTranscriptWithEndTurn();

    const result = await _testOnlyDetectAgentDone(session);

    expect(result).toBe(true);
    // Verify readMarker WAS called
    expect(mockedReadMarker).toHaveBeenCalledWith("/fake/repo", "test-bead-123");
    // Verify transcript WAS read (malformed marker triggered fallback)
    expect(mockedOpen).toHaveBeenCalled();
  });

  // ---- Session missing beadId/epicId -> skip marker, use transcript ----
  test("session missing beadId and epicId -> skips marker check, uses transcript", async () => {
    const session = makeSession({
      beadId: undefined,
      epicId: undefined,
      pipelineStage: undefined,
    });

    // Only stat call: transcript path — stale (>5s)
    mockedStat.mockResolvedValueOnce(staleStatResult());

    mockTranscriptWithEndTurn();

    const result = await _testOnlyDetectAgentDone(session);

    expect(result).toBe(true);
    // Verify readMarker was NOT called (no markerId derivable)
    expect(mockedReadMarker).not.toHaveBeenCalled();
    // Verify transcript WAS read (marker check skipped entirely)
    expect(mockedOpen).toHaveBeenCalled();
  });
});
