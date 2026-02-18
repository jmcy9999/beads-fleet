import type { PlanIssue, IssueTokenSummary } from "@/lib/types";

/** Pipeline stages for the factory fleet view. */
export type FleetStage =
  | "idea"
  | "research"
  | "research-complete"
  | "plan-review"
  | "development"
  | "qa"
  | "submission-prep"
  | "submitted"
  | "kit-management"
  | "completed"
  | "bad-idea";

export const FLEET_STAGES: FleetStage[] = [
  "idea",
  "research",
  "research-complete",
  "plan-review",
  "development",
  "qa",
  "submission-prep",
  "submitted",
  "kit-management",
  "completed",
  "bad-idea",
];

export const FLEET_STAGE_CONFIG: Record<
  FleetStage,
  { label: string; color: string; dotColor: string }
> = {
  idea: { label: "Candidates", color: "text-gray-400", dotColor: "bg-gray-400" },
  research: {
    label: "In Research",
    color: "text-blue-400",
    dotColor: "bg-blue-400",
  },
  "research-complete": {
    label: "Research Complete",
    color: "text-cyan-400",
    dotColor: "bg-cyan-400",
  },
  "plan-review": {
    label: "Plan Review",
    color: "text-violet-400",
    dotColor: "bg-violet-400",
  },
  development: {
    label: "Building",
    color: "text-amber-400",
    dotColor: "bg-amber-400",
  },
  qa: {
    label: "QA",
    color: "text-emerald-400",
    dotColor: "bg-emerald-400",
  },
  "submission-prep": {
    label: "Prepare for Launch",
    color: "text-orange-400",
    dotColor: "bg-orange-400",
  },
  submitted: {
    label: "Launched",
    color: "text-purple-400",
    dotColor: "bg-purple-400",
  },
  "kit-management": {
    label: "Refit",
    color: "text-indigo-400",
    dotColor: "bg-indigo-400",
  },
  completed: {
    label: "Deployed",
    color: "text-green-400",
    dotColor: "bg-green-400",
  },
  "bad-idea": {
    label: "Abandoned",
    color: "text-red-400",
    dotColor: "bg-red-400",
  },
};

export interface FleetApp {
  epic: PlanIssue;
  children: PlanIssue[];
  stage: FleetStage;
  progress: { closed: number; total: number };
}

/**
 * Check whether an epic has the `agent:running` label.
 */
export function isAgentRunning(epic: PlanIssue): boolean {
  return epic.labels?.includes("agent:running") ?? false;
}

/**
 * Linear pipeline stages in order (excludes "bad-idea" which is terminal/separate).
 */
export const PIPELINE_ORDER: FleetStage[] = [
  "idea",
  "research",
  "research-complete",
  "plan-review",
  "development",
  "qa",
  "submission-prep",
  "submitted",
  "kit-management",
  "completed",
];

export type PhaseStatus = "past" | "current" | "future";

export interface PhaseHistoryEntry {
  stage: FleetStage;
  status: PhaseStatus;
}

/**
 * Derive phase history from the current pipeline stage.
 *
 * For stages in the linear pipeline (idea -> completed), any stage before
 * the current one is "past", the current one is "current", and stages
 * after are "future".
 *
 * For "bad-idea" (terminal), only the "idea" stage is shown as "past"
 * and "bad-idea" itself is "current". The rest are "future".
 */
export function getPhaseHistory(currentStage: FleetStage): PhaseHistoryEntry[] {
  if (currentStage === "bad-idea") {
    return PIPELINE_ORDER.map((stage) => ({
      stage,
      status: stage === "idea" ? ("past" as const) : ("future" as const),
    }));
  }

  const currentIndex = PIPELINE_ORDER.indexOf(currentStage);
  // If stage not found in pipeline order (shouldn't happen), treat everything as future
  if (currentIndex === -1) {
    return PIPELINE_ORDER.map((stage) => ({
      stage,
      status: "future" as const,
    }));
  }

  return PIPELINE_ORDER.map((stage, index) => ({
    stage,
    status:
      index < currentIndex
        ? ("past" as const)
        : index === currentIndex
          ? ("current" as const)
          : ("future" as const),
  }));
}

/**
 * Determine which pipeline stage an epic is in.
 *
 * Primary detection: reads `pipeline:*` labels on the epic itself.
 * Priority order ensures the most advanced stage wins if multiple labels
 * are present (which should not happen, but provides a safe fallback).
 *
 * Fallback: if no `pipeline:*` labels exist, uses the legacy child-based
 * detection for backward compatibility with existing epics that predate
 * the pipeline label convention.
 */
export function detectStage(
  epic: PlanIssue,
  children: PlanIssue[],
): FleetStage {
  const labels = epic.labels ?? [];

  // --- Primary: pipeline labels on the epic ---
  const hasPipelineLabel = labels.some((l) => l.startsWith("pipeline:"));

  if (hasPipelineLabel) {
    if (labels.includes("pipeline:bad-idea")) return "bad-idea";
    if (labels.includes("pipeline:completed")) return "completed";
    if (labels.includes("pipeline:kit-management")) return "kit-management";
    if (labels.includes("pipeline:submitted")) return "submitted";
    if (labels.includes("pipeline:submission-prep")) return "submission-prep";
    if (labels.includes("pipeline:qa")) return "qa";
    if (labels.includes("pipeline:development")) return "development";
    if (labels.includes("pipeline:research-complete")) {
      // Split into plan-review sub-column when plan labels are present
      if (labels.includes("plan:pending") || labels.includes("plan:approved")) {
        return "plan-review";
      }
      return "research-complete";
    }
    if (labels.includes("pipeline:research")) return "research";
  }

  // --- Fallback: closed epic without pipeline label ---
  if (epic.status === "closed") return "completed";

  // --- Fallback: legacy child-based detection ---
  const activeChildren = children.filter((c) => c.status !== "closed");

  const hasSubmission = activeChildren.some(
    (c) => c.labels?.some((l) => l.startsWith("submission:")) ?? false,
  );
  if (hasSubmission) return "submitted";

  const hasDevelopment = activeChildren.some(
    (c) => c.labels?.includes("development") ?? false,
  );
  if (hasDevelopment) return "development";

  const hasResearch = activeChildren.some(
    (c) => c.labels?.includes("research") ?? false,
  );
  if (hasResearch) return "research";

  return "idea";
}

/**
 * Extract fleet apps from the full issue list.
 * An "app" is any epic-type issue.
 */
// ---------------------------------------------------------------------------
// Cost per app — aggregate token usage by epic with phase breakdown
// ---------------------------------------------------------------------------

export interface PhaseCost {
  phase: string;
  cost: number;
  sessions: number;
}

export interface EpicCost {
  epicId: string;
  totalCost: number;
  totalSessions: number;
  phases: PhaseCost[];
}

/**
 * Determine the phase of an issue based on its labels.
 * Returns "research", "development", "submission", "kit-management", or "other".
 */
function classifyPhase(issue: PlanIssue): string {
  if (issue.labels?.some((l) => l.startsWith("submission:") || l === "pipeline:submitted" || l === "pipeline:submission-prep")) return "submission";
  if (issue.labels?.includes("development") || issue.labels?.includes("pipeline:development")) return "development";
  if (issue.labels?.includes("research") || issue.labels?.some((l) => l.startsWith("pipeline:research"))) return "research";
  if (issue.labels?.includes("pipeline:kit-management")) return "kit-management";
  return "other";
}

/**
 * Compute per-epic cost breakdowns from token usage summaries.
 *
 * For each epic, sums up token costs from:
 * - The epic issue itself (work attributed directly to the epic)
 * - All child issues, grouped by phase (research/development/submission/other)
 */
export function computeEpicCosts(
  apps: FleetApp[],
  byIssue: Record<string, IssueTokenSummary>,
): Map<string, EpicCost> {
  const result = new Map<string, EpicCost>();

  for (const app of apps) {
    const phaseMap = new Map<string, PhaseCost>();
    let totalCost = 0;
    let totalSessions = 0;

    // Cost attributed directly to the epic
    const epicUsage = byIssue[app.epic.id];
    if (epicUsage) {
      totalCost += epicUsage.total_cost_usd;
      totalSessions += epicUsage.session_count;
      const phase = "other";
      const existing = phaseMap.get(phase);
      if (existing) {
        existing.cost += epicUsage.total_cost_usd;
        existing.sessions += epicUsage.session_count;
      } else {
        phaseMap.set(phase, { phase, cost: epicUsage.total_cost_usd, sessions: epicUsage.session_count });
      }
    }

    // Cost from children, grouped by phase
    for (const child of app.children) {
      const childUsage = byIssue[child.id];
      if (!childUsage) continue;

      totalCost += childUsage.total_cost_usd;
      totalSessions += childUsage.session_count;

      const phase = classifyPhase(child);
      const existing = phaseMap.get(phase);
      if (existing) {
        existing.cost += childUsage.total_cost_usd;
        existing.sessions += childUsage.session_count;
      } else {
        phaseMap.set(phase, { phase, cost: childUsage.total_cost_usd, sessions: childUsage.session_count });
      }
    }

    if (totalCost > 0 || totalSessions > 0) {
      // Sort phases in pipeline order
      const phaseOrder = ["research", "development", "submission", "kit-management", "other"];
      const phases = phaseOrder
        .filter((p) => phaseMap.has(p))
        .map((p) => phaseMap.get(p)!);

      result.set(app.epic.id, { epicId: app.epic.id, totalCost, totalSessions, phases });
    }
  }

  return result;
}

export function buildFleetApps(allIssues: PlanIssue[]): FleetApp[] {
  const epics = allIssues.filter((i) => i.issue_type === "epic");

  return epics.map((epic) => {
    const children = allIssues.filter((i) => i.epic === epic.id);
    const stage = detectStage(epic, children);
    const closed = children.filter((c) => c.status === "closed").length;
    return {
      epic,
      children,
      stage,
      progress: { closed, total: children.length },
    };
  });
}
