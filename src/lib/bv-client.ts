// =============================================================================
// Beads Fleet — bv CLI Client (Robot Protocol Command Wrapper)
// =============================================================================
//
// Executes `bv --robot-*` commands via child_process.execFile (not exec, for
// security) and parses the JSON output into typed structures.
//
// Fallback: when `bv` is not installed or BEADS_PROJECT_PATH is missing, reads
// .beads/issues.jsonl directly and builds simplified responses.
//
// All results are cached with a 10-second TTL to avoid redundant subprocess
// calls within rapid UI refresh cycles.
// =============================================================================

import { execFile as execFileCb, execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import path from "path";
import { promisify } from "util";

import { cache } from "./cache";
import { computeInsightsFromIssues } from "./graph-metrics";
import {
  readIssuesFromJSONL,
  issuesToPlan,
  emptyPriority,
} from "./jsonl-fallback";
import type {
  BeadsIssue,
  DiffIssueChange,
  IssueStatus,
  IssueType,
  PlanIssue,
  PlanSummary,
  PlanTrack,
  Priority,
  RobotDiff,
  RobotInsights,
  RobotPlan,
  RobotPriority,
} from "./types";

const execFile = promisify(execFileCb);

// -----------------------------------------------------------------------------
// Configuration helpers
// -----------------------------------------------------------------------------

function getBvPath(): string {
  // 1. Explicit override always wins
  if (process.env.BV_PATH) return process.env.BV_PATH;

  // 2. Local node_modules/.bin/bv (installed by our postinstall script)
  const localBv = path.join(process.cwd(), "node_modules", ".bin", "bv");
  if (existsSync(localBv)) return localBv;

  // 3. Global bv on PATH
  try {
    execFileSync("bv", ["--version"], { stdio: "ignore", timeout: 3_000 });
    return "bv";
  } catch {
    // bv not found globally, fall through
  }

  // 4. Local node_modules/.bin/bd (fallback for basic operations)
  const localBd = path.join(process.cwd(), "node_modules", ".bin", "bd");
  if (existsSync(localBd)) return localBd;

  // 5. Global bd
  return "bd";
}

function getProjectPath(): string {
  const p = process.env.BEADS_PROJECT_PATH;
  if (!p) throw new Error("BEADS_PROJECT_PATH environment variable is not set");
  return p;
}

/**
 * Resolve the project path to use. If an override is provided, use it.
 * Otherwise fall back to the env var.
 */
function resolveProjectPath(override?: string): string {
  if (override) return override;
  return getProjectPath();
}

// -----------------------------------------------------------------------------
// Low-level bv execution
// -----------------------------------------------------------------------------

async function execBv(args: string[], projectPath?: string): Promise<string> {
  const { stdout } = await execFile(getBvPath(), args, {
    cwd: resolveProjectPath(projectPath),
    timeout: 30_000,
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: "1" },
  });
  return stdout;
}

function isBvNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

// -----------------------------------------------------------------------------
// Normalization helpers — convert real bv CLI output to our TypeScript types
// -----------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Normalize the real `bv --robot-plan` response envelope into our RobotPlan type.
 *
 * Real bv output shape:
 *   { generated_at, data_hash, analysis_config, status, plan: { tracks, total_actionable, total_blocked, summary }, usage_hints }
 *
 * Each real track: { track_id, reason, items: [{ id, title, priority, status, unblocks }] }
 * Real summary: { highest_impact: "<issue-id>", impact_reason, unblocks_count }
 *
 * Our PlanTrack: { track_number, label?, issues: PlanIssue[] }
 * Our PlanIssue: { id, title, status, priority, issue_type, owner?, labels?, blocked_by, blocks, impact_score? }
 * Our PlanSummary: { open_count, in_progress_count, blocked_count, closed_count, highest_impact?: { issue_id, title, impact_score, unblocks_count? } }
 */
function normalizePlan(raw: any, projectPath: string): RobotPlan {
  // If the raw data already has our expected shape (e.g. from JSONL fallback),
  // return it as-is.
  if (raw.tracks && raw.summary && raw.all_issues) {
    return raw as RobotPlan;
  }

  // Extract the plan object from the envelope
  const plan = raw.plan;
  if (!plan) {
    // No plan key — unexpected shape, return minimal valid structure
    return {
      timestamp: raw.generated_at ?? new Date().toISOString(),
      project_path: projectPath,
      summary: { open_count: 0, in_progress_count: 0, blocked_count: 0, closed_count: 0 },
      tracks: [],
      all_issues: [],
    };
  }

  const rawTracks: any[] = plan.tracks ?? [];

  // Convert each track and its items
  const tracks: PlanTrack[] = rawTracks.map((t: any, idx: number) => ({
    track_number: idx + 1,
    label: t.reason ?? t.track_id ?? undefined,
    issues: (t.items ?? []).map((item: any) => normalizePlanItem(item)),
  }));

  // Flatten all issues from all tracks
  const allIssues: PlanIssue[] = tracks.flatMap((t) => t.issues);

  // Build summary counts from all issues
  const statusCounts: Record<string, number> = {
    open: 0,
    in_progress: 0,
    blocked: 0,
    closed: 0,
  };
  for (const issue of allIssues) {
    const s = issue.status as string;
    if (s in statusCounts) {
      statusCounts[s]++;
    }
  }

  // Build highest_impact object from the summary string ID
  let highestImpact: PlanSummary["highest_impact"] = undefined;
  const rawSummary = plan.summary;
  if (rawSummary?.highest_impact) {
    const impactId = typeof rawSummary.highest_impact === "string"
      ? rawSummary.highest_impact
      : rawSummary.highest_impact.issue_id;

    // Look up the title from the flattened issues
    const matchedIssue = allIssues.find((i) => i.id === impactId);
    highestImpact = {
      issue_id: impactId,
      title: matchedIssue?.title ?? impactId,
      impact_score: 0,
      unblocks_count: rawSummary.unblocks_count ?? 0,
    };
  }

  const summary: PlanSummary = {
    open_count: statusCounts.open,
    in_progress_count: statusCounts.in_progress,
    blocked_count: statusCounts.blocked,
    closed_count: statusCounts.closed,
    highest_impact: highestImpact,
  };

  return {
    timestamp: raw.generated_at ?? new Date().toISOString(),
    project_path: projectPath,
    summary,
    tracks,
    all_issues: allIssues,
  };
}

/**
 * Convert a single real bv plan item to our PlanIssue type.
 *
 * Real item: { id, title, priority, status, unblocks }
 * Our PlanIssue: { id, title, status, priority, issue_type, owner?, labels?, blocked_by, blocks, impact_score? }
 */
function normalizePlanItem(item: any): PlanIssue {
  return {
    id: item.id,
    title: item.title ?? item.id,
    status: (item.status ?? "open") as IssueStatus,
    priority: (item.priority ?? 2) as Priority,
    issue_type: (item.issue_type ?? "task") as IssueType,
    owner: item.owner ?? undefined,
    labels: item.labels ?? undefined,
    blocked_by: item.blocked_by ?? [],
    blocks: item.unblocks ?? item.blocks ?? [],
    impact_score: item.impact_score ?? undefined,
    created_at: item.created_at ?? undefined,
    updated_at: item.updated_at ?? undefined,
    closed_at: item.closed_at ?? undefined,
  };
}

/**
 * Normalize the real `bv --robot-insights` response into our RobotInsights type.
 *
 * Real bv output uses PascalCase keys: Bottlenecks, Keystones, Influencers,
 * Hubs, Authorities, Cycles, etc. Each metric entry has { ID, Value } instead
 * of { issue_id, title, score }.
 *
 * Top-level envelope: { generated_at, data_hash, analysis_config, status,
 *   Bottlenecks, Keystones, Influencers, Hubs, Authorities, Cores,
 *   Articulation, Slack, Orphans, Cycles, ClusterDensity, Velocity, Stats,
 *   full_stats, advanced_insights, usage_hints }
 */
function normalizeInsights(raw: any, projectPath: string): RobotInsights {
  // If the raw data already has our expected shape (e.g. from JSONL fallback),
  // return it as-is.
  if (
    raw.bottlenecks !== undefined &&
    raw.keystones !== undefined &&
    raw.total_issues !== undefined
  ) {
    return raw as RobotInsights;
  }

  // Map PascalCase metric arrays: { ID, Value } -> { issue_id, title, score }
  function mapMetricEntries(arr: any[] | undefined) {
    if (!Array.isArray(arr)) return [];
    return arr.map((entry: any) => ({
      issue_id: entry.ID ?? entry.id ?? entry.issue_id ?? "",
      title: entry.Title ?? entry.title ?? entry.ID ?? entry.id ?? "",
      score: entry.Value ?? entry.value ?? entry.score ?? 0,
    }));
  }

  // Map cycles: real format may differ; handle both array-of-arrays and
  // array-of-objects
  function mapCycles(arr: any[] | undefined) {
    if (!Array.isArray(arr)) return [];
    return arr.map((entry: any, idx: number) => {
      if (Array.isArray(entry)) {
        // Array of issue IDs
        return { cycle_id: idx + 1, issues: entry as string[], length: entry.length };
      }
      // Object form
      return {
        cycle_id: entry.cycle_id ?? entry.CycleID ?? idx + 1,
        issues: entry.issues ?? entry.Issues ?? [],
        length: entry.length ?? entry.Length ?? (entry.issues ?? entry.Issues ?? []).length,
      };
    });
  }

  // Extract total_issues from Stats or full_stats if available
  const stats = raw.Stats ?? raw.full_stats ?? {};
  const totalIssues = stats.total_issues ?? stats.TotalIssues ?? stats.Total ?? 0;
  const graphDensity = raw.ClusterDensity ?? stats.graph_density ?? stats.GraphDensity ?? 0;

  return {
    timestamp: raw.generated_at ?? new Date().toISOString(),
    project_path: projectPath,
    total_issues: totalIssues,
    graph_density: typeof graphDensity === "number" ? graphDensity : 0,
    bottlenecks: mapMetricEntries(raw.Bottlenecks ?? raw.bottlenecks),
    keystones: mapMetricEntries(raw.Keystones ?? raw.keystones),
    influencers: mapMetricEntries(raw.Influencers ?? raw.influencers),
    hubs: mapMetricEntries(raw.Hubs ?? raw.hubs),
    authorities: mapMetricEntries(raw.Authorities ?? raw.authorities),
    cycles: mapCycles(raw.Cycles ?? raw.cycles),
  };
}

/**
 * Normalize the real `bv --robot-priority` response into our RobotPriority type.
 *
 * The real bv priority data may come from `bv --robot-insights` (embedded in
 * advanced_insights) or from a separate `bv --robot-priority` command.
 * Handle both envelope-wrapped and direct formats.
 */
function normalizePriority(raw: any, projectPath: string): RobotPriority {
  // If the raw data already has our expected shape, return it as-is.
  if (
    raw.recommendations !== undefined &&
    raw.aligned_count !== undefined
  ) {
    return raw as RobotPriority;
  }

  // Try to extract priority recommendations from various possible locations
  const recommendations = raw.recommendations ?? raw.Recommendations ?? [];

  return {
    timestamp: raw.generated_at ?? raw.timestamp ?? new Date().toISOString(),
    project_path: projectPath,
    recommendations: Array.isArray(recommendations)
      ? recommendations.map((r: any) => ({
          issue_id: r.issue_id ?? r.ID ?? r.id ?? "",
          title: r.title ?? r.Title ?? "",
          current_priority: (r.current_priority ?? r.CurrentPriority ?? 2) as Priority,
          recommended_priority: (r.recommended_priority ?? r.RecommendedPriority ?? 2) as Priority,
          confidence: r.confidence ?? r.Confidence ?? 0,
          reason: r.reason ?? r.Reason ?? "",
          impact_score: r.impact_score ?? r.ImpactScore ?? undefined,
        }))
      : [],
    aligned_count: raw.aligned_count ?? raw.AlignedCount ?? 0,
    misaligned_count: raw.misaligned_count ?? raw.MisalignedCount ?? 0,
  };
}

/**
 * Normalize the real `bv --robot-diff` response into our RobotDiff type.
 *
 * Real bv output shape (envelope):
 *   { generated_at, resolved_revision, from_data_hash, to_data_hash,
 *     diff: { from_timestamp, to_timestamp, from_revision,
 *             new_issues, closed_issues, removed_issues, reopened_issues,
 *             modified_issues, new_cycles, resolved_cycles, metric_deltas } }
 *
 * Each issue entry has { id/ID, title/Title, ... }.
 *
 * Our RobotDiff expects a flat structure with a `changes: DiffIssueChange[]`
 * array and count fields.
 */
function normalizeDiff(raw: any, projectPath: string, sinceRef: string): RobotDiff {
  // If the raw data already has our expected shape (e.g. from JSONL fallback),
  // return it as-is.
  if (Array.isArray(raw.changes)) {
    return raw as RobotDiff;
  }

  // Extract the diff envelope from the raw response
  const diff = raw.diff;
  if (!diff) {
    // No diff key — unexpected shape, return minimal valid structure
    return {
      timestamp: raw.generated_at ?? new Date().toISOString(),
      project_path: projectPath,
      since_ref: sinceRef,
      new_count: 0,
      closed_count: 0,
      modified_count: 0,
      reopened_count: 0,
      changes: [],
    };
  }

  const newIssues: any[] = diff.new_issues ?? [];
  const closedIssues: any[] = diff.closed_issues ?? [];
  const modifiedIssues: any[] = diff.modified_issues ?? [];
  const reopenedIssues: any[] = diff.reopened_issues ?? [];

  // Helper to extract issue_id and title from real bv issue entries
  // which may use PascalCase (ID, Title) or snake_case (id, title)
  function mapIssue(entry: any, changeType: DiffIssueChange["change_type"]): DiffIssueChange {
    const result: DiffIssueChange = {
      issue_id: entry.id ?? entry.ID ?? entry.issue_id ?? "",
      title: entry.title ?? entry.Title ?? entry.id ?? entry.ID ?? "",
      change_type: changeType,
    };
    if (changeType === "modified") {
      if (entry.changed_fields) result.changed_fields = entry.changed_fields;
      if (entry.previous_values) result.previous_values = entry.previous_values;
      if (entry.new_values) result.new_values = entry.new_values;
    }
    return result;
  }

  const changes: DiffIssueChange[] = [
    ...newIssues.map((e: any) => mapIssue(e, "new")),
    ...closedIssues.map((e: any) => mapIssue(e, "closed")),
    ...modifiedIssues.map((e: any) => mapIssue(e, "modified")),
    ...reopenedIssues.map((e: any) => mapIssue(e, "reopened")),
  ];

  const newCycles: any[] = diff.new_cycles ?? [];
  const resolvedCycles: any[] = diff.resolved_cycles ?? [];

  // Extract density_delta from metric_deltas if available
  const metricDeltas = diff.metric_deltas;
  const densityDelta =
    metricDeltas?.graph_density ?? metricDeltas?.density_delta ?? undefined;

  return {
    timestamp: raw.generated_at ?? diff.to_timestamp ?? new Date().toISOString(),
    project_path: projectPath,
    since_ref: sinceRef,
    new_count: newIssues.length,
    closed_count: closedIssues.length,
    modified_count: modifiedIssues.length,
    reopened_count: reopenedIssues.length,
    changes,
    density_delta: densityDelta,
    cycles_resolved: resolvedCycles.length,
    cycles_introduced: newCycles.length,
  };
}

/* eslint-enable @typescript-eslint/no-explicit-any */

// -----------------------------------------------------------------------------
// Git-based JSONL diff fallback
// -----------------------------------------------------------------------------

/**
 * Count the number of non-empty lines in a file. Returns 0 if the file does
 * not exist or cannot be read.
 */
function countJsonlLines(filePath: string): number {
  try {
    const content = readFileSync(filePath, "utf-8");
    return content.split("\n").filter((l) => l.trim().length > 0).length;
  } catch {
    return 0;
  }
}

/**
 * Parse JSONL content (one JSON object per line) into BeadsIssue[].
 * Skips blank lines and malformed JSON.
 */
function parseJsonlContent(content: string): BeadsIssue[] {
  const issues: BeadsIssue[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      issues.push(JSON.parse(trimmed) as BeadsIssue);
    } catch {
      // Skip malformed lines
    }
  }
  return issues;
}

/** Fields to compare when detecting modifications between old and current issues. */
const DIFF_FIELDS: (keyof BeadsIssue)[] = [
  "title",
  "status",
  "priority",
  "issue_type",
  "owner",
  "updated_at",
];

/**
 * Compute a diff by reading the JSONL at an old git ref and comparing against
 * the current issue set (from SQLite). This replaces the previous timestamp-
 * heuristic approach with a true snapshot comparison.
 *
 * The JSONL may live in the main tree (.beads/issues.jsonl) or in a beads
 * worktree (.git/beads-worktrees/beads-sync/.beads/issues.jsonl). We detect
 * which location is active by picking the path with more content.
 */
async function computeDiffFromGit(
  projectPath: string,
  since: string,
): Promise<RobotDiff> {
  // ---- 1. Find the active JSONL path ----------------------------------------
  const mainJsonl = path.join(projectPath, ".beads", "issues.jsonl");
  const worktreeDir = path.join(
    projectPath,
    ".git",
    "beads-worktrees",
    "beads-sync",
  );
  const worktreeJsonl = path.join(worktreeDir, ".beads", "issues.jsonl");

  const mainCount = countJsonlLines(mainJsonl);
  const worktreeCount = countJsonlLines(worktreeJsonl);

  // Prefer the location with more issues. If the worktree exists and has more
  // content, that's the active sync branch. Otherwise default to main tree.
  const useWorktree = worktreeCount > 0 && worktreeCount >= mainCount;
  const gitCwd = useWorktree ? worktreeDir : projectPath;

  // ---- 2. Read old JSONL from git at the requested ref ----------------------
  let oldIssues: BeadsIssue[];
  try {
    const { stdout: oldContent } = await execFile(
      "git",
      ["show", `${since}:.beads/issues.jsonl`],
      {
        cwd: gitCwd,
        timeout: 15_000,
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    oldIssues = parseJsonlContent(oldContent);
  } catch {
    // Ref doesn't exist, JSONL wasn't committed at that ref, or git error.
    // Return an empty diff rather than crashing.
    return {
      timestamp: new Date().toISOString(),
      project_path: projectPath,
      since_ref: since,
      new_count: 0,
      closed_count: 0,
      modified_count: 0,
      reopened_count: 0,
      changes: [],
    };
  }

  // ---- 3. Read current issues from SQLite (source of truth) -----------------
  const currentIssues = await readIssuesFromJSONL(projectPath);

  // ---- 4. Diff the two sets -------------------------------------------------
  const oldMap = new Map<string, BeadsIssue>();
  for (const issue of oldIssues) {
    oldMap.set(issue.id, issue);
  }

  const currentMap = new Map<string, BeadsIssue>();
  for (const issue of currentIssues) {
    currentMap.set(issue.id, issue);
  }

  const changes: DiffIssueChange[] = [];

  // Detect new, modified, closed, and reopened issues
  for (const [id, current] of currentMap) {
    const old = oldMap.get(id);

    if (!old) {
      // Issue exists now but not in the old snapshot -> new
      changes.push({
        issue_id: id,
        title: current.title,
        change_type: "new",
      });
      continue;
    }

    // Issue exists in both snapshots — check for status transitions
    const wasActive =
      old.status === "open" || old.status === "in_progress" || old.status === "blocked";
    const isActive =
      current.status === "open" || current.status === "in_progress" || current.status === "blocked";
    const wasClosed = old.status === "closed";
    const isClosed = current.status === "closed";

    if (wasActive && isClosed) {
      changes.push({
        issue_id: id,
        title: current.title,
        change_type: "closed",
      });
      continue;
    }

    if (wasClosed && isActive) {
      changes.push({
        issue_id: id,
        title: current.title,
        change_type: "reopened",
      });
      continue;
    }

    // Check for field-level modifications
    const changedFields: string[] = [];
    const previousValues: Record<string, unknown> = {};
    const newValues: Record<string, unknown> = {};

    for (const field of DIFF_FIELDS) {
      const oldVal = old[field];
      const curVal = current[field];
      if (oldVal !== curVal) {
        changedFields.push(field);
        previousValues[field] = oldVal;
        newValues[field] = curVal;
      }
    }

    if (changedFields.length > 0) {
      changes.push({
        issue_id: id,
        title: current.title,
        change_type: "modified",
        changed_fields: changedFields,
        previous_values: previousValues,
        new_values: newValues,
      });
    }
  }

  // Note: issues in old but not in current are "deleted" — beads doesn't
  // really delete issues, so we skip them.

  // ---- 5. Build the RobotDiff return value ----------------------------------
  const newCount = changes.filter((c) => c.change_type === "new").length;
  const closedCount = changes.filter((c) => c.change_type === "closed").length;
  const modifiedCount = changes.filter((c) => c.change_type === "modified").length;
  const reopenedCount = changes.filter((c) => c.change_type === "reopened").length;

  return {
    timestamp: new Date().toISOString(),
    project_path: projectPath,
    since_ref: since,
    new_count: newCount,
    closed_count: closedCount,
    modified_count: modifiedCount,
    reopened_count: reopenedCount,
    changes,
  };
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

const CACHE_KEY_INSIGHTS = "bv:insights";
const CACHE_KEY_PLAN = "bv:plan";
const CACHE_KEY_PRIORITY = "bv:priority";

/**
 * Fetch graph-based insights from `bv --robot-insights`.
 * Falls back to an empty structure if bv is unavailable.
 */
export async function getInsights(projectPath?: string): Promise<RobotInsights> {
  const resolvedPath = resolveProjectPath(projectPath);
  const cacheKey = `${CACHE_KEY_INSIGHTS}:${resolvedPath}`;
  const cached = cache.get<RobotInsights>(cacheKey);
  if (cached) return cached;

  try {
    const stdout = await execBv(["--robot-insights"], resolvedPath);
    const raw = JSON.parse(stdout);
    const data = normalizeInsights(raw, resolvedPath);
    cache.set(cacheKey, data);
    return data;
  } catch (error) {
    if (isBvNotFoundError(error)) {
      const issues = await readIssuesFromJSONL(resolvedPath);
      const fallback = computeInsightsFromIssues(issues, resolvedPath);
      cache.set(cacheKey, fallback);
      return fallback;
    }
    const issues = await readIssuesFromJSONL(resolvedPath);
    const fallback = computeInsightsFromIssues(issues, resolvedPath);
    cache.set(cacheKey, fallback);
    return fallback;
  }
}

/**
 * Fetch the full plan from `bv --robot-plan`.
 * Falls back to JSONL-based plan if bv is unavailable.
 */
export async function getPlan(projectPath?: string): Promise<RobotPlan> {
  const resolvedPath = resolveProjectPath(projectPath);
  const cacheKey = `${CACHE_KEY_PLAN}:${resolvedPath}`;
  const cached = cache.get<RobotPlan>(cacheKey);
  if (cached) return cached;

  try {
    const stdout = await execBv(["--robot-plan"], resolvedPath);
    const raw = JSON.parse(stdout);
    const data = normalizePlan(raw, resolvedPath);

    // bv --robot-plan only returns actionable/triage items in tracks.
    // Supplement all_issues with the full issue list from SQLite so the
    // dashboard shows every issue, not just the 4-5 triage picks.
    const fullIssues = await readIssuesFromJSONL(resolvedPath);
    if (fullIssues.length > data.all_issues.length) {
      const fullPlan = issuesToPlan(fullIssues, resolvedPath);
      data.all_issues = fullPlan.all_issues;
      data.summary = {
        ...fullPlan.summary,
        highest_impact: data.summary.highest_impact ?? fullPlan.summary.highest_impact,
      };
    }

    cache.set(cacheKey, data);
    return data;
  } catch (error) {
    if (isBvNotFoundError(error)) {
      const issues = await readIssuesFromJSONL(resolvedPath);
      const fallback = issuesToPlan(issues, resolvedPath);
      cache.set(cacheKey, fallback);
      return fallback;
    }
    const issues = await readIssuesFromJSONL(resolvedPath);
    const fallback = issuesToPlan(issues, resolvedPath);
    cache.set(cacheKey, fallback);
    return fallback;
  }
}

/**
 * Fetch priority recommendations from `bv --robot-priority`.
 * Falls back to an empty structure if bv is unavailable.
 */
export async function getPriority(projectPath?: string): Promise<RobotPriority> {
  const resolvedPath = resolveProjectPath(projectPath);
  const cacheKey = `${CACHE_KEY_PRIORITY}:${resolvedPath}`;
  const cached = cache.get<RobotPriority>(cacheKey);
  if (cached) return cached;

  try {
    const stdout = await execBv(["--robot-priority"], resolvedPath);
    const raw = JSON.parse(stdout);
    const data = normalizePriority(raw, resolvedPath);
    cache.set(cacheKey, data);
    return data;
  } catch (error) {
    if (isBvNotFoundError(error)) {
      const fallback = emptyPriority(resolvedPath);
      cache.set(cacheKey, fallback);
      return fallback;
    }
    const fallback = emptyPriority(resolvedPath);
    cache.set(cacheKey, fallback);
    return fallback;
  }
}

/**
 * Fetch diff since a git reference from `bv --robot-diff --diff-since <since>`.
 * Falls back to a git-based JSONL snapshot diff when bv returns empty results
 * or is unavailable. Returns an empty changes list only as a last resort.
 */
export async function getDiff(since: string, projectPath?: string): Promise<RobotDiff> {
  const resolvedPath = resolveProjectPath(projectPath);
  const cacheKey = `bv:diff:${since}:${resolvedPath}`;
  const cached = cache.get<RobotDiff>(cacheKey);
  if (cached) return cached;

  try {
    const stdout = await execBv(["--robot-diff", "--diff-since", since], resolvedPath);
    const raw = JSON.parse(stdout);
    const data = normalizeDiff(raw, resolvedPath, since);

    // If bv returned empty diff, compute from git JSONL comparison
    if (data.changes.length === 0) {
      const gitDiff = await computeDiffFromGit(resolvedPath, since);
      if (gitDiff.changes.length > 0) {
        cache.set(cacheKey, gitDiff);
        return gitDiff;
      }
    }

    cache.set(cacheKey, data);
    return data;
  } catch {
    // bv failed entirely — try git-based JSONL diff before returning empty
    const gitDiff = await computeDiffFromGit(resolvedPath, since);
    if (gitDiff.changes.length > 0) {
      cache.set(cacheKey, gitDiff);
      return gitDiff;
    }

    const fallback: RobotDiff = {
      timestamp: new Date().toISOString(),
      project_path: resolvedPath,
      since_ref: since,
      new_count: 0,
      closed_count: 0,
      modified_count: 0,
      reopened_count: 0,
      changes: [],
    };
    cache.set(cacheKey, fallback);
    return fallback;
  }
}

/**
 * Fetch and aggregate plans from multiple project paths into a single RobotPlan.
 * Adds a `project:<repoName>` label to each issue for filtering.
 */
export async function getAllProjectsPlan(repoPaths: string[]): Promise<RobotPlan> {
  const plans = await Promise.all(repoPaths.map((p) => getPlan(p)));

  const allIssues: PlanIssue[] = [];
  const allTracks: PlanTrack[] = [];
  const summary: PlanSummary = {
    open_count: 0,
    in_progress_count: 0,
    blocked_count: 0,
    closed_count: 0,
  };

  let trackOffset = 0;
  for (const plan of plans) {
    const repoName = path.basename(plan.project_path);

    // Add project label to each issue
    for (const issue of plan.all_issues) {
      const projectLabel = `project:${repoName}`;
      const labels = issue.labels ? [...issue.labels] : [];
      if (!labels.includes(projectLabel)) {
        labels.push(projectLabel);
      }
      allIssues.push({ ...issue, labels });
    }

    // Renumber tracks to avoid collisions
    for (const track of plan.tracks) {
      allTracks.push({
        ...track,
        track_number: track.track_number + trackOffset,
        label: track.label ? `[${repoName}] ${track.label}` : `[${repoName}]`,
        issues: track.issues.map((issue) => {
          const projectLabel = `project:${repoName}`;
          const labels = issue.labels ? [...issue.labels] : [];
          if (!labels.includes(projectLabel)) labels.push(projectLabel);
          return { ...issue, labels };
        }),
      });
    }
    trackOffset += plan.tracks.length;

    // Sum summary counts
    summary.open_count += plan.summary.open_count;
    summary.in_progress_count += plan.summary.in_progress_count;
    summary.blocked_count += plan.summary.blocked_count;
    summary.closed_count += plan.summary.closed_count;
  }

  return {
    timestamp: new Date().toISOString(),
    project_path: "__all__",
    summary,
    tracks: allTracks,
    all_issues: allIssues,
  };
}

/**
 * Check whether the `bv` CLI is reachable by running `bv --version`.
 * Result is not cached since this is typically called once at startup.
 */
export async function checkBvAvailable(): Promise<boolean> {
  try {
    await execFile(getBvPath(), ["--version"], {
      timeout: 5_000,
      env: { ...process.env, NO_COLOR: "1" },
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get a single issue by ID. Reads from the plan data.
 */
export async function getIssueById(
  issueId: string,
  projectPath?: string,
): Promise<{ plan_issue: import("./types").PlanIssue; raw_issue: import("./types").BeadsIssue | null }> {
  const resolvedPath = resolveProjectPath(projectPath);
  const plan = await getPlan(resolvedPath);
  const planIssue = plan.all_issues.find((i) => i.id === issueId);
  if (!planIssue) throw new Error(`Issue not found: ${issueId}`);

  // Try to get the full raw issue from JSONL for description/comments
  let rawIssue: import("./types").BeadsIssue | null = null;
  try {
    const allRaw = await readIssuesFromJSONL(resolvedPath);
    rawIssue = allRaw.find((i) => i.id === issueId) ?? null;
  } catch {
    // JSONL read failed, that's OK
  }

  return { plan_issue: planIssue, raw_issue: rawIssue };
}

/**
 * Invalidate all cached bv responses. Call this after mutations
 * (e.g. issue creation, status change) to force fresh data.
 */
export function invalidateCache(): void {
  cache.invalidateAll();
}
