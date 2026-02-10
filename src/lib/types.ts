// =============================================================================
// Beads Web — TypeScript Type Definitions
// =============================================================================
//
// A. Beads core issue model (matches real .beads/issues.jsonl schema)
// B. Robot protocol response schemas (bv --robot-* commands)
// C. UI display configuration constants
//
// IMPORTANT: Real JSONL uses `issue_type` (not `type`), `owner` (not
// `assignee`), and `dependencies[]` (not `blocked_by: string[]`).
// =============================================================================

// -----------------------------------------------------------------------------
// Category A: Beads Core Issue Model
// -----------------------------------------------------------------------------

export type IssueStatus =
  | "open"
  | "in_progress"
  | "blocked"
  | "deferred"
  | "closed"
  | "pinned";

export type IssueType = "bug" | "feature" | "task" | "epic" | "chore";

export type Priority = 0 | 1 | 2 | 3 | 4;

export interface IssueDependency {
  issue_id: string;
  depends_on_id: string;
  type: "blocks" | "parent-child" | string;
  created_at: string;
  created_by: string;
}

export interface BeadsIssue {
  id: string;
  title: string;
  description?: string;
  status: IssueStatus;
  priority: Priority;
  issue_type: IssueType;
  owner?: string;
  parent?: string;
  labels?: string[];
  dependencies?: IssueDependency[];
  created_at: string;
  created_by?: string;
  updated_at: string;
  closed_at?: string;
  close_reason?: string;
}

// -----------------------------------------------------------------------------
// Category B: Robot Protocol Response Schemas
// -----------------------------------------------------------------------------

export interface GraphMetricEntry {
  issue_id: string;
  title: string;
  score: number;
}

export interface CycleInfo {
  cycle_id: number;
  issues: string[];
  length: number;
}

// --- bv --robot-insights ---

export interface RobotInsights {
  timestamp: string;
  project_path: string;
  total_issues: number;
  graph_density: number;
  bottlenecks: GraphMetricEntry[];
  keystones: GraphMetricEntry[];
  influencers: GraphMetricEntry[];
  hubs: GraphMetricEntry[];
  authorities: GraphMetricEntry[];
  cycles: CycleInfo[];
  topological_order?: string[];
}

// --- bv --robot-plan ---

export interface PlanSummary {
  open_count: number;
  in_progress_count: number;
  blocked_count: number;
  closed_count: number;
  highest_impact?: {
    issue_id: string;
    title: string;
    impact_score: number;
    unblocks_count?: number;
  };
}

export interface PlanIssue {
  id: string;
  title: string;
  status: IssueStatus;
  priority: Priority;
  issue_type: IssueType;
  owner?: string;
  labels?: string[];
  blocked_by: string[];
  blocks: string[];
  impact_score?: number;
}

export interface PlanTrack {
  track_number: number;
  label?: string;
  issues: PlanIssue[];
}

export interface RobotPlan {
  timestamp: string;
  project_path: string;
  summary: PlanSummary;
  tracks: PlanTrack[];
  all_issues: PlanIssue[];
}

// --- bv --robot-priority ---

export interface PriorityRecommendation {
  issue_id: string;
  title: string;
  current_priority: Priority;
  recommended_priority: Priority;
  confidence: number;
  reason: string;
  impact_score?: number;
}

export interface RobotPriority {
  timestamp: string;
  project_path: string;
  recommendations: PriorityRecommendation[];
  aligned_count: number;
  misaligned_count: number;
}

// --- bv --robot-diff ---

export interface DiffIssueChange {
  issue_id: string;
  title: string;
  change_type: "new" | "closed" | "modified" | "reopened";
  changed_fields?: string[];
  previous_values?: Record<string, unknown>;
  new_values?: Record<string, unknown>;
}

export interface RobotDiff {
  timestamp: string;
  project_path: string;
  since_ref: string;
  new_count: number;
  closed_count: number;
  modified_count: number;
  reopened_count: number;
  changes: DiffIssueChange[];
  density_delta?: number;
  cycles_resolved?: number;
  cycles_introduced?: number;
}

// --- bv --robot-recipes ---

export interface Recipe {
  name: string;
  description: string;
  filter: string;
}

export interface RobotRecipes {
  timestamp: string;
  recipes: Recipe[];
}

// -----------------------------------------------------------------------------
// Category C: UI Display Configuration Constants
// -----------------------------------------------------------------------------

export interface StatusConfig {
  label: string;
  color: string;
  bgColor: string;
  icon: string;
}

export interface PriorityConfig {
  label: string;
  color: string;
  flames: number;
}

export const STATUS_CONFIG: Record<IssueStatus, StatusConfig> = {
  open: {
    label: "Open",
    color: "text-status-open",
    bgColor: "bg-status-open/10",
    icon: "circle",
  },
  in_progress: {
    label: "In Progress",
    color: "text-status-progress",
    bgColor: "bg-status-progress/10",
    icon: "play",
  },
  blocked: {
    label: "Blocked",
    color: "text-status-blocked",
    bgColor: "bg-status-blocked/10",
    icon: "octagon",
  },
  deferred: {
    label: "Deferred",
    color: "text-status-deferred",
    bgColor: "bg-status-deferred/10",
    icon: "pause",
  },
  closed: {
    label: "Closed",
    color: "text-status-closed",
    bgColor: "bg-status-closed/10",
    icon: "check",
  },
  pinned: {
    label: "Pinned",
    color: "text-status-pinned",
    bgColor: "bg-status-pinned/10",
    icon: "pin",
  },
};

export const PRIORITY_CONFIG: Record<Priority, PriorityConfig> = {
  0: { label: "Critical", color: "text-priority-critical", flames: 4 },
  1: { label: "High", color: "text-priority-high", flames: 3 },
  2: { label: "Medium", color: "text-priority-medium", flames: 2 },
  3: { label: "Low", color: "text-priority-low", flames: 1 },
  4: { label: "Minimal", color: "text-priority-minimal", flames: 0 },
};

export const KANBAN_COLUMNS: IssueStatus[] = [
  "open",
  "in_progress",
  "blocked",
  "closed",
];

// -----------------------------------------------------------------------------
// Category D: Token Usage Types
// -----------------------------------------------------------------------------

export interface TokenUsageRecord {
  timestamp: string;
  session_id: string;
  issue_id: string;
  project: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  total_cost_usd: number;
  duration_ms: number;
  num_turns: number;
}

export interface IssueTokenSummary {
  issue_id: string;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_creation_tokens: number;
  total_tokens: number;
  total_cost_usd: number;
  session_count: number;
  total_duration_ms: number;
  total_turns: number;
  first_session: string;
  last_session: string;
}
