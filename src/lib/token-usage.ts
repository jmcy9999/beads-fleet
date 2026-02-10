// =============================================================================
// Beads Web — Token Usage Reader
// =============================================================================
//
// Reads .beads/token-usage.jsonl from the active project path and provides
// both raw record access and aggregated summaries by issue.
// =============================================================================

import { promises as fs } from "fs";
import path from "path";

import { getActiveProjectPath } from "./repo-config";
import type { TokenUsageRecord, IssueTokenSummary } from "./types";

// -----------------------------------------------------------------------------
// Read raw token usage records from JSONL
// -----------------------------------------------------------------------------

export async function getTokenUsageRecords(
  projectPath?: string,
): Promise<TokenUsageRecord[]> {
  const resolvedPath = projectPath ?? (await getActiveProjectPath());
  const filePath = path.join(resolvedPath, ".beads", "token-usage.jsonl");

  let content: string;
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch {
    // File missing or unreadable — return empty list
    return [];
  }

  const records: TokenUsageRecord[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as TokenUsageRecord);
    } catch {
      // Skip malformed lines
    }
  }
  return records;
}

// -----------------------------------------------------------------------------
// Aggregate token usage into per-issue summaries
// -----------------------------------------------------------------------------

function createEmptySummary(issueId: string): IssueTokenSummary {
  return {
    issue_id: issueId,
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cache_read_tokens: 0,
    total_cache_creation_tokens: 0,
    total_tokens: 0,
    total_cost_usd: 0,
    session_count: 0,
    total_duration_ms: 0,
    total_turns: 0,
    first_session: "",
    last_session: "",
  };
}

function addRecordToSummary(
  summary: IssueTokenSummary,
  record: TokenUsageRecord,
): void {
  summary.total_input_tokens += record.input_tokens;
  summary.total_output_tokens += record.output_tokens;
  summary.total_cache_read_tokens += record.cache_read_tokens;
  summary.total_cache_creation_tokens += record.cache_creation_tokens;
  summary.total_tokens +=
    record.input_tokens +
    record.output_tokens +
    record.cache_read_tokens +
    record.cache_creation_tokens;
  summary.total_cost_usd += record.total_cost_usd;
  summary.session_count += 1;
  summary.total_duration_ms += record.duration_ms;
  summary.total_turns += record.num_turns;

  if (!summary.first_session || record.timestamp < summary.first_session) {
    summary.first_session = record.timestamp;
  }
  if (!summary.last_session || record.timestamp > summary.last_session) {
    summary.last_session = record.timestamp;
  }
}

export interface TokenUsageSummary {
  byIssue: Record<string, IssueTokenSummary>;
  totals: IssueTokenSummary;
}

export async function getTokenUsageSummary(
  projectPath?: string,
): Promise<TokenUsageSummary> {
  const records = await getTokenUsageRecords(projectPath);

  const byIssue: Record<string, IssueTokenSummary> = {};
  const totals = createEmptySummary("_totals");

  for (const record of records) {
    // Per-issue aggregation
    if (!byIssue[record.issue_id]) {
      byIssue[record.issue_id] = createEmptySummary(record.issue_id);
    }
    addRecordToSummary(byIssue[record.issue_id], record);

    // Grand totals
    addRecordToSummary(totals, record);
  }

  return { byIssue, totals };
}
