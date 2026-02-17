// =============================================================================
// Beads Fleet — JSONL Fallback Parser
// =============================================================================
//
// When the `bv` CLI is not available, read .beads/issues.jsonl directly and
// build simplified robot-protocol responses. Graph-derived fields (impact
// scores, bottlenecks, cycles, etc.) are unavailable in this mode.
// =============================================================================

import { promises as fs } from "fs";
import path from "path";

import { readIssuesFromDB } from "./sqlite-reader";
import type {
  BeadsIssue,
  IssueStatus,
  PlanIssue,
  PlanSummary,
  PlanTrack,
  RobotInsights,
  RobotPlan,
  RobotPriority,
} from "./types";

// -----------------------------------------------------------------------------
// Read raw issues — tries SQLite DB first, falls back to JSONL
// -----------------------------------------------------------------------------

export async function readIssuesFromJSONL(
  projectPath: string,
): Promise<BeadsIssue[]> {
  // Try SQLite first (source of truth)
  const dbIssues = readIssuesFromDB(projectPath);
  if (dbIssues !== null) return dbIssues;

  // Fall back to JSONL if no database
  const filePath = path.join(projectPath, ".beads", "issues.jsonl");
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch {
    // File missing or unreadable — return empty list
    return [];
  }

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

// -----------------------------------------------------------------------------
// Convert BeadsIssue[] -> RobotPlan (simplified, no graph metrics)
// -----------------------------------------------------------------------------

export function issuesToPlan(
  issues: BeadsIssue[],
  projectPath: string,
): RobotPlan {
  // Build cross-reference maps from the dependency arrays.
  //
  // IssueDependency shape:
  //   { issue_id, depends_on_id, type: "blocks" }
  //
  // Semantics: `issue_id` depends on `depends_on_id`.
  // So `depends_on_id` blocks `issue_id`.
  //
  // For a given issue X:
  //   blocked_by = all depends_on_id where issue_id === X.id
  //   blocks     = all issue_id where depends_on_id === X.id

  const blockedByMap = new Map<string, Set<string>>();
  const blocksMap = new Map<string, Set<string>>();
  const parentMap = new Map<string, string>(); // child -> parent (epic)

  for (const issue of issues) {
    if (!issue.dependencies) continue;
    for (const dep of issue.dependencies) {
      if (dep.type === "parent-child") {
        // dep.issue_id is child of dep.depends_on_id (the epic)
        parentMap.set(dep.issue_id, dep.depends_on_id);
      } else {
        // dep.issue_id depends on dep.depends_on_id
        // => dep.depends_on_id blocks dep.issue_id
        if (!blockedByMap.has(dep.issue_id)) {
          blockedByMap.set(dep.issue_id, new Set());
        }
        blockedByMap.get(dep.issue_id)!.add(dep.depends_on_id);

        if (!blocksMap.has(dep.depends_on_id)) {
          blocksMap.set(dep.depends_on_id, new Set());
        }
        blocksMap.get(dep.depends_on_id)!.add(dep.issue_id);
      }
    }
  }

  // Build title lookup for epic display
  const titleMap = new Map<string, string>();
  for (const issue of issues) {
    titleMap.set(issue.id, issue.title);
  }

  // Convert each BeadsIssue to PlanIssue
  const allIssues: PlanIssue[] = issues.map((issue) => ({
    id: issue.id,
    title: issue.title,
    status: issue.status,
    priority: issue.priority,
    issue_type: issue.issue_type,
    owner: issue.owner,
    labels: issue.labels,
    blocked_by: Array.from(blockedByMap.get(issue.id) ?? []),
    blocks: Array.from(blocksMap.get(issue.id) ?? []),
    story_points: issue.story_points,
    epic: parentMap.get(issue.id),
    epic_title: parentMap.has(issue.id) ? titleMap.get(parentMap.get(issue.id)!) : undefined,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
    // impact_score not available without bv
  }));

  // Build summary by counting statuses
  const statusCounts: Record<string, number> = {
    open: 0,
    in_progress: 0,
    blocked: 0,
    closed: 0,
  };
  for (const issue of issues) {
    const s = issue.status as string;
    if (s in statusCounts) {
      statusCounts[s]++;
    }
  }

  const summary: PlanSummary = {
    open_count: statusCounts.open,
    in_progress_count: statusCounts.in_progress,
    blocked_count: statusCounts.blocked,
    closed_count: statusCounts.closed,
  };

  // Group into a single unsorted track (no graph-based track assignment)
  const activeIssues = allIssues.filter(
    (i) => i.status !== "closed" && i.status !== "deferred",
  );

  const tracks: PlanTrack[] = [];
  if (activeIssues.length > 0) {
    tracks.push({
      track_number: 1,
      label: "All Issues",
      issues: activeIssues,
    });
  }

  return {
    timestamp: new Date().toISOString(),
    project_path: projectPath,
    summary,
    tracks,
    all_issues: allIssues,
  };
}

// -----------------------------------------------------------------------------
// Empty stubs for insights and priority (no data without bv)
// -----------------------------------------------------------------------------

export function emptyInsights(projectPath: string, totalIssues = 0): RobotInsights {
  return {
    timestamp: new Date().toISOString(),
    project_path: projectPath,
    total_issues: totalIssues,
    graph_density: 0,
    bottlenecks: [],
    keystones: [],
    influencers: [],
    hubs: [],
    authorities: [],
    cycles: [],
  };
}

export function emptyPriority(projectPath: string): RobotPriority {
  return {
    timestamp: new Date().toISOString(),
    project_path: projectPath,
    recommendations: [],
    aligned_count: 0,
    misaligned_count: 0,
  };
}

// Re-export the status type for use in filtering
export type { IssueStatus };
