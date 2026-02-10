// =============================================================================
// Tests for src/app/api/token-usage/route.ts — GET /api/token-usage
// =============================================================================

import type { TokenUsageRecord } from "@/lib/types";
import type { TokenUsageSummary } from "@/lib/token-usage";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock("@/lib/repo-config", () => ({
  getActiveProjectPath: jest.fn(),
}));

jest.mock("@/lib/token-usage", () => ({
  getTokenUsageRecords: jest.fn(),
  getTokenUsageSummary: jest.fn(),
}));

import { GET } from "@/app/api/token-usage/route";
import { getActiveProjectPath } from "@/lib/repo-config";
import { getTokenUsageRecords, getTokenUsageSummary } from "@/lib/token-usage";
import { NextRequest } from "next/server";

const mockGetActiveProjectPath = getActiveProjectPath as jest.MockedFunction<
  typeof getActiveProjectPath
>;
const mockGetTokenUsageRecords = getTokenUsageRecords as jest.MockedFunction<
  typeof getTokenUsageRecords
>;
const mockGetTokenUsageSummary = getTokenUsageSummary as jest.MockedFunction<
  typeof getTokenUsageSummary
>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(params: Record<string, string> = {}): NextRequest {
  const url = new URL("http://localhost:3000/api/token-usage");
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return new NextRequest(url);
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const TEST_PROJECT_PATH = "/tmp/test-project";

const MOCK_RECORDS: TokenUsageRecord[] = [
  {
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
  },
  {
    timestamp: "2026-01-15T11:00:00Z",
    session_id: "sess-002",
    issue_id: "ISSUE-2",
    project: "test-project",
    model: "claude-opus-4-6",
    input_tokens: 2000,
    output_tokens: 800,
    cache_read_tokens: 300,
    cache_creation_tokens: 150,
    total_cost_usd: 0.10,
    duration_ms: 45000,
    num_turns: 8,
  },
];

const MOCK_SUMMARY: TokenUsageSummary = {
  byIssue: {
    "ISSUE-1": {
      issue_id: "ISSUE-1",
      total_input_tokens: 1000,
      total_output_tokens: 500,
      total_cache_read_tokens: 200,
      total_cache_creation_tokens: 100,
      total_tokens: 1800,
      total_cost_usd: 0.05,
      session_count: 1,
      total_duration_ms: 30000,
      total_turns: 5,
      first_session: "2026-01-15T10:00:00Z",
      last_session: "2026-01-15T10:00:00Z",
    },
  },
  totals: {
    issue_id: "_totals",
    total_input_tokens: 3000,
    total_output_tokens: 1300,
    total_cache_read_tokens: 500,
    total_cache_creation_tokens: 250,
    total_tokens: 5050,
    total_cost_usd: 0.15,
    session_count: 2,
    total_duration_ms: 75000,
    total_turns: 13,
    first_session: "2026-01-15T10:00:00Z",
    last_session: "2026-01-15T11:00:00Z",
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/token-usage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Default mode — return all records
  // -------------------------------------------------------------------------

  it("returns 200 with all token usage records", async () => {
    mockGetActiveProjectPath.mockResolvedValue(TEST_PROJECT_PATH);
    mockGetTokenUsageRecords.mockResolvedValue(MOCK_RECORDS);

    const response = await GET(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual(MOCK_RECORDS);
    expect(mockGetTokenUsageRecords).toHaveBeenCalledWith(TEST_PROJECT_PATH);
  });

  it("returns empty array when no records exist", async () => {
    mockGetActiveProjectPath.mockResolvedValue(TEST_PROJECT_PATH);
    mockGetTokenUsageRecords.mockResolvedValue([]);

    const response = await GET(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Filtering by issue_id
  // -------------------------------------------------------------------------

  it("filters records by issue_id query param", async () => {
    mockGetActiveProjectPath.mockResolvedValue(TEST_PROJECT_PATH);
    mockGetTokenUsageRecords.mockResolvedValue(MOCK_RECORDS);

    const response = await GET(makeRequest({ issue_id: "ISSUE-1" }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0].issue_id).toBe("ISSUE-1");
  });

  it("returns empty array when filtering by non-existent issue_id", async () => {
    mockGetActiveProjectPath.mockResolvedValue(TEST_PROJECT_PATH);
    mockGetTokenUsageRecords.mockResolvedValue(MOCK_RECORDS);

    const response = await GET(makeRequest({ issue_id: "ISSUE-999" }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Summary mode
  // -------------------------------------------------------------------------

  it("returns summary data when summary=true", async () => {
    mockGetActiveProjectPath.mockResolvedValue(TEST_PROJECT_PATH);
    mockGetTokenUsageSummary.mockResolvedValue(MOCK_SUMMARY);

    const response = await GET(makeRequest({ summary: "true" }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual(MOCK_SUMMARY);
    expect(mockGetTokenUsageSummary).toHaveBeenCalledWith(TEST_PROJECT_PATH);
    // Should not call getTokenUsageRecords in summary mode
    expect(mockGetTokenUsageRecords).not.toHaveBeenCalled();
  });

  it("returns records (not summary) when summary param is not 'true'", async () => {
    mockGetActiveProjectPath.mockResolvedValue(TEST_PROJECT_PATH);
    mockGetTokenUsageRecords.mockResolvedValue(MOCK_RECORDS);

    const response = await GET(makeRequest({ summary: "false" }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual(MOCK_RECORDS);
    expect(mockGetTokenUsageSummary).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  it("returns 503 when BEADS_PROJECT_PATH is not configured", async () => {
    mockGetActiveProjectPath.mockRejectedValue(
      new Error(
        "No repository configured. Set BEADS_PROJECT_PATH or add a repo via Settings.",
      ),
    );

    const response = await GET(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error).toBe("BEADS_PROJECT_PATH not configured");
    expect(body.detail).toContain("BEADS_PROJECT_PATH");
  });

  it("returns 500 on generic errors", async () => {
    mockGetActiveProjectPath.mockResolvedValue(TEST_PROJECT_PATH);
    mockGetTokenUsageRecords.mockRejectedValue(new Error("Disk failure"));

    const response = await GET(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe("Failed to fetch token usage");
    expect(body.detail).toBe("Disk failure");
  });

  it("handles non-Error thrown objects gracefully", async () => {
    mockGetActiveProjectPath.mockResolvedValue(TEST_PROJECT_PATH);
    mockGetTokenUsageRecords.mockRejectedValue("string error");

    const response = await GET(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe("Failed to fetch token usage");
    expect(body.detail).toBe("Unknown error");
  });
});
