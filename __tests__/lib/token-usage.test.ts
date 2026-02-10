// =============================================================================
// Tests for src/lib/token-usage.ts — Token Usage Reader & Aggregator
// =============================================================================

import type { TokenUsageRecord } from "@/lib/types";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock("@/lib/repo-config", () => ({
  getActiveProjectPath: jest.fn(),
}));

jest.mock("fs", () => ({
  promises: {
    readFile: jest.fn(),
  },
}));

import { getTokenUsageRecords, getTokenUsageSummary } from "@/lib/token-usage";
import { getActiveProjectPath } from "@/lib/repo-config";
import { promises as fs } from "fs";

const mockGetActiveProjectPath = getActiveProjectPath as jest.MockedFunction<
  typeof getActiveProjectPath
>;
const mockReadFile = fs.readFile as jest.MockedFunction<typeof fs.readFile>;

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const TEST_PROJECT_PATH = "/tmp/test-project";

const RECORD_A: TokenUsageRecord = {
  timestamp: "2026-01-15T10:00:00Z",
  session_id: "sess-001",
  issue_id: "ISSUE-1",
  project: "test-project",
  model: "claude-opus-4-6",
  input_tokens: 1000,
  output_tokens: 500,
  cache_read_tokens: 200,
  cache_creation_tokens: 100,
  total_cost_usd: 0.05,
  duration_ms: 30000,
  num_turns: 5,
};

const RECORD_B: TokenUsageRecord = {
  timestamp: "2026-01-15T11:00:00Z",
  session_id: "sess-002",
  issue_id: "ISSUE-1",
  project: "test-project",
  model: "claude-opus-4-6",
  input_tokens: 2000,
  output_tokens: 800,
  cache_read_tokens: 300,
  cache_creation_tokens: 150,
  total_cost_usd: 0.10,
  duration_ms: 45000,
  num_turns: 8,
};

const RECORD_C: TokenUsageRecord = {
  timestamp: "2026-01-15T12:00:00Z",
  session_id: "sess-003",
  issue_id: "ISSUE-2",
  project: "test-project",
  model: "claude-sonnet-4",
  input_tokens: 500,
  output_tokens: 250,
  cache_read_tokens: 50,
  cache_creation_tokens: 25,
  total_cost_usd: 0.02,
  duration_ms: 15000,
  num_turns: 3,
};

function makeJsonl(records: TokenUsageRecord[]): string {
  return records.map((r) => JSON.stringify(r)).join("\n");
}

// ---------------------------------------------------------------------------
// Tests — getTokenUsageRecords
// ---------------------------------------------------------------------------

describe("getTokenUsageRecords", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns parsed records from a valid JSONL file", async () => {
    mockGetActiveProjectPath.mockResolvedValue(TEST_PROJECT_PATH);
    mockReadFile.mockResolvedValue(makeJsonl([RECORD_A, RECORD_B]));

    const records = await getTokenUsageRecords();

    expect(records).toHaveLength(2);
    expect(records[0]).toEqual(RECORD_A);
    expect(records[1]).toEqual(RECORD_B);
    expect(mockReadFile).toHaveBeenCalledWith(
      "/tmp/test-project/.beads/token-usage.jsonl",
      "utf-8",
    );
  });

  it("uses the provided projectPath instead of getActiveProjectPath", async () => {
    mockReadFile.mockResolvedValue(makeJsonl([RECORD_A]));

    const records = await getTokenUsageRecords("/custom/path");

    expect(records).toHaveLength(1);
    expect(mockReadFile).toHaveBeenCalledWith(
      "/custom/path/.beads/token-usage.jsonl",
      "utf-8",
    );
    expect(mockGetActiveProjectPath).not.toHaveBeenCalled();
  });

  it("returns empty array when the file does not exist", async () => {
    mockGetActiveProjectPath.mockResolvedValue(TEST_PROJECT_PATH);
    mockReadFile.mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );

    const records = await getTokenUsageRecords();

    expect(records).toEqual([]);
  });

  it("returns empty array when the file is unreadable", async () => {
    mockGetActiveProjectPath.mockResolvedValue(TEST_PROJECT_PATH);
    mockReadFile.mockRejectedValue(
      Object.assign(new Error("EACCES"), { code: "EACCES" }),
    );

    const records = await getTokenUsageRecords();

    expect(records).toEqual([]);
  });

  it("returns empty array for an empty file", async () => {
    mockGetActiveProjectPath.mockResolvedValue(TEST_PROJECT_PATH);
    mockReadFile.mockResolvedValue("");

    const records = await getTokenUsageRecords();

    expect(records).toEqual([]);
  });

  it("skips blank lines in the JSONL", async () => {
    mockGetActiveProjectPath.mockResolvedValue(TEST_PROJECT_PATH);
    const content = JSON.stringify(RECORD_A) + "\n\n\n" + JSON.stringify(RECORD_B) + "\n";
    mockReadFile.mockResolvedValue(content);

    const records = await getTokenUsageRecords();

    expect(records).toHaveLength(2);
  });

  it("skips malformed JSON lines gracefully", async () => {
    mockGetActiveProjectPath.mockResolvedValue(TEST_PROJECT_PATH);
    const content =
      JSON.stringify(RECORD_A) + "\n{invalid json}\n" + JSON.stringify(RECORD_C);
    mockReadFile.mockResolvedValue(content);

    const records = await getTokenUsageRecords();

    expect(records).toHaveLength(2);
    expect(records[0]).toEqual(RECORD_A);
    expect(records[1]).toEqual(RECORD_C);
  });

  it("handles a file with only malformed lines", async () => {
    mockGetActiveProjectPath.mockResolvedValue(TEST_PROJECT_PATH);
    mockReadFile.mockResolvedValue("{bad}\n{also bad}\n");

    const records = await getTokenUsageRecords();

    expect(records).toEqual([]);
  });

  it("handles a single record without trailing newline", async () => {
    mockGetActiveProjectPath.mockResolvedValue(TEST_PROJECT_PATH);
    mockReadFile.mockResolvedValue(JSON.stringify(RECORD_A));

    const records = await getTokenUsageRecords();

    expect(records).toHaveLength(1);
    expect(records[0]).toEqual(RECORD_A);
  });

  it("handles lines with leading/trailing whitespace", async () => {
    mockGetActiveProjectPath.mockResolvedValue(TEST_PROJECT_PATH);
    const content = "  " + JSON.stringify(RECORD_A) + "  \n";
    mockReadFile.mockResolvedValue(content);

    const records = await getTokenUsageRecords();

    expect(records).toHaveLength(1);
    expect(records[0]).toEqual(RECORD_A);
  });
});

// ---------------------------------------------------------------------------
// Tests — getTokenUsageSummary
// ---------------------------------------------------------------------------

describe("getTokenUsageSummary", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns correct per-issue aggregation for a single issue", async () => {
    mockGetActiveProjectPath.mockResolvedValue(TEST_PROJECT_PATH);
    mockReadFile.mockResolvedValue(makeJsonl([RECORD_A, RECORD_B]));

    const summary = await getTokenUsageSummary();

    expect(Object.keys(summary.byIssue)).toEqual(["ISSUE-1"]);
    const issue1 = summary.byIssue["ISSUE-1"];
    expect(issue1.issue_id).toBe("ISSUE-1");
    expect(issue1.total_input_tokens).toBe(3000);
    expect(issue1.total_output_tokens).toBe(1300);
    expect(issue1.total_cache_read_tokens).toBe(500);
    expect(issue1.total_cache_creation_tokens).toBe(250);
    expect(issue1.total_tokens).toBe(3000 + 1300 + 500 + 250);
    expect(issue1.total_cost_usd).toBeCloseTo(0.15, 5);
    expect(issue1.session_count).toBe(2);
    expect(issue1.total_duration_ms).toBe(75000);
    expect(issue1.total_turns).toBe(13);
    expect(issue1.first_session).toBe("2026-01-15T10:00:00Z");
    expect(issue1.last_session).toBe("2026-01-15T11:00:00Z");
  });

  it("aggregates across multiple issues", async () => {
    mockGetActiveProjectPath.mockResolvedValue(TEST_PROJECT_PATH);
    mockReadFile.mockResolvedValue(makeJsonl([RECORD_A, RECORD_B, RECORD_C]));

    const summary = await getTokenUsageSummary();

    expect(Object.keys(summary.byIssue).sort()).toEqual(["ISSUE-1", "ISSUE-2"]);
    expect(summary.byIssue["ISSUE-1"].session_count).toBe(2);
    expect(summary.byIssue["ISSUE-2"].session_count).toBe(1);
    expect(summary.byIssue["ISSUE-2"].total_input_tokens).toBe(500);
    expect(summary.byIssue["ISSUE-2"].total_output_tokens).toBe(250);
  });

  it("computes grand totals across all issues", async () => {
    mockGetActiveProjectPath.mockResolvedValue(TEST_PROJECT_PATH);
    mockReadFile.mockResolvedValue(makeJsonl([RECORD_A, RECORD_B, RECORD_C]));

    const summary = await getTokenUsageSummary();

    const totals = summary.totals;
    expect(totals.issue_id).toBe("_totals");
    expect(totals.total_input_tokens).toBe(3500);
    expect(totals.total_output_tokens).toBe(1550);
    expect(totals.total_cache_read_tokens).toBe(550);
    expect(totals.total_cache_creation_tokens).toBe(275);
    expect(totals.total_tokens).toBe(3500 + 1550 + 550 + 275);
    expect(totals.total_cost_usd).toBeCloseTo(0.17, 5);
    expect(totals.session_count).toBe(3);
    expect(totals.total_duration_ms).toBe(90000);
    expect(totals.total_turns).toBe(16);
    expect(totals.first_session).toBe("2026-01-15T10:00:00Z");
    expect(totals.last_session).toBe("2026-01-15T12:00:00Z");
  });

  it("returns empty summary when there are no records", async () => {
    mockGetActiveProjectPath.mockResolvedValue(TEST_PROJECT_PATH);
    mockReadFile.mockRejectedValue(new Error("ENOENT"));

    const summary = await getTokenUsageSummary();

    expect(Object.keys(summary.byIssue)).toHaveLength(0);
    expect(summary.totals.session_count).toBe(0);
    expect(summary.totals.total_input_tokens).toBe(0);
    expect(summary.totals.total_output_tokens).toBe(0);
    expect(summary.totals.total_cost_usd).toBe(0);
    expect(summary.totals.first_session).toBe("");
    expect(summary.totals.last_session).toBe("");
  });

  it("passes projectPath through to getTokenUsageRecords", async () => {
    mockReadFile.mockResolvedValue(makeJsonl([RECORD_C]));

    const summary = await getTokenUsageSummary("/custom/path");

    expect(mockReadFile).toHaveBeenCalledWith(
      "/custom/path/.beads/token-usage.jsonl",
      "utf-8",
    );
    expect(mockGetActiveProjectPath).not.toHaveBeenCalled();
    expect(summary.byIssue["ISSUE-2"].total_input_tokens).toBe(500);
  });

  it("tracks first_session and last_session correctly when records are out of order", async () => {
    mockGetActiveProjectPath.mockResolvedValue(TEST_PROJECT_PATH);
    // Feed records in reverse chronological order
    mockReadFile.mockResolvedValue(makeJsonl([RECORD_C, RECORD_B, RECORD_A]));

    const summary = await getTokenUsageSummary();

    expect(summary.totals.first_session).toBe("2026-01-15T10:00:00Z");
    expect(summary.totals.last_session).toBe("2026-01-15T12:00:00Z");

    const issue1 = summary.byIssue["ISSUE-1"];
    expect(issue1.first_session).toBe("2026-01-15T10:00:00Z");
    expect(issue1.last_session).toBe("2026-01-15T11:00:00Z");
  });

  it("handles a single record correctly", async () => {
    mockGetActiveProjectPath.mockResolvedValue(TEST_PROJECT_PATH);
    mockReadFile.mockResolvedValue(makeJsonl([RECORD_A]));

    const summary = await getTokenUsageSummary();

    expect(summary.totals.session_count).toBe(1);
    expect(summary.totals.total_input_tokens).toBe(1000);
    expect(summary.byIssue["ISSUE-1"].first_session).toBe("2026-01-15T10:00:00Z");
    expect(summary.byIssue["ISSUE-1"].last_session).toBe("2026-01-15T10:00:00Z");
  });
});
