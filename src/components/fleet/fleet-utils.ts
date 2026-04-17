import type { PlanIssue, IssueTokenSummary } from "@/lib/types";

/** Pipeline stages for the fleet board view. */
export type FleetStage =
  | "idea"
  | "research"
  | "research-complete"
  | "product-spec"
  | "architecture"
  | "plan-review"
  | "development"
  | "qa"
  | "submission-prep"
  | "submitted"
  | "kit-management"
  | "deploying"
  | "live"
  | "completed"
  | "bad-idea";

export const FLEET_STAGES: FleetStage[] = [
  "idea",
  "research",
  "research-complete",
  "product-spec",
  "architecture",
  "plan-review",
  "development",
  "qa",
  "submission-prep",
  "submitted",
  "kit-management",
  "deploying",
  "live",
  "completed",
  "bad-idea",
];

/** Ship types supported by the shipyard. */
export type ShipType =
  | "ios-app"
  | "macos-app"
  | "web-app"
  | "wordpress-plugin"
  | "python-tool"
  | "game"
  | "internal"
  | "venture";

const VALID_SHIP_TYPES: Set<string> = new Set([
  "ios-app", "macos-app", "web-app", "wordpress-plugin",
  "python-tool", "game", "internal", "venture",
]);

/** Detect ship type from epic labels. Defaults to "ios-app" if no valid ship-type label. */
export function getShipType(epic: PlanIssue): ShipType {
  const labels = epic.labels ?? [];
  const shipLabel = labels.find((l) => l.startsWith("ship-type:"));
  if (shipLabel) {
    const type = shipLabel.replace("ship-type:", "");
    if (VALID_SHIP_TYPES.has(type)) return type as ShipType;
  }
  return "ios-app";
}

/** iOS-only stages that ventures skip. */
export const IOS_ONLY_STAGES: FleetStage[] = ["qa", "submission-prep", "submitted", "kit-management"];

/** Venture-only stages that iOS apps skip. */
export const VENTURE_ONLY_STAGES: FleetStage[] = ["deploying", "live"];

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
  "product-spec": {
    label: "Product Spec",
    color: "text-rose-400",
    dotColor: "bg-rose-400",
  },
  architecture: {
    label: "Architecture",
    color: "text-sky-400",
    dotColor: "bg-sky-400",
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
  deploying: {
    label: "Deploying",
    color: "text-teal-400",
    dotColor: "bg-teal-400",
  },
  live: {
    label: "Live",
    color: "text-emerald-400",
    dotColor: "bg-emerald-400",
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
  shipType: ShipType;
  progress: { closed: number; total: number };
}

/**
 * Check whether an epic has the `agent:running` label.
 */
export function isAgentRunning(epic: PlanIssue): boolean {
  return epic.labels?.includes("agent:running") ?? false;
}

/**
 * iOS app pipeline stages in order (excludes "bad-idea" which is terminal/separate).
 */
export const IOS_PIPELINE_ORDER: FleetStage[] = [
  "idea",
  "research",
  "research-complete",
  "product-spec",
  "architecture",
  "plan-review",
  "development",
  "qa",
  "submission-prep",
  "submitted",
  "kit-management",
  "completed",
];

/**
 * Venture pipeline stages in order (no QA, submission, or kit-management).
 */
export const VENTURE_PIPELINE_ORDER: FleetStage[] = [
  "idea",
  "research",
  "research-complete",
  "plan-review",
  "development",
  "deploying",
  "live",
  "completed",
];

/** Backward-compatible alias. */
export const PIPELINE_ORDER = IOS_PIPELINE_ORDER;

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
export function getPhaseHistory(currentStage: FleetStage, shipType: ShipType = "ios-app"): PhaseHistoryEntry[] {
  const order = shipType === "venture" ? VENTURE_PIPELINE_ORDER : IOS_PIPELINE_ORDER;

  if (currentStage === "bad-idea") {
    return order.map((stage) => ({
      stage,
      status: stage === "idea" ? ("past" as const) : ("future" as const),
    }));
  }

  const currentIndex = order.indexOf(currentStage);
  if (currentIndex === -1) {
    return order.map((stage) => ({
      stage,
      status: "future" as const,
    }));
  }

  return order.map((stage, index) => ({
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
    if (labels.includes("pipeline:live")) return "live";
    if (labels.includes("pipeline:deploying")) return "deploying";
    if (labels.includes("pipeline:kit-management")) return "kit-management";
    // Map platform review stages to the "submitted" column
    // CLAUDE.md documents pipeline:awaiting-review and pipeline:in-review
    // as valid pipeline labels for store review states. (factory-core-cur.1.19)
    if (labels.includes("pipeline:submitted") ||
        labels.includes("pipeline:awaiting-review") ||
        labels.includes("pipeline:in-review")) return "submitted";
    // Map compliance-check and package to submission-prep column
    // (pre-submission stages from CLAUDE.md). (factory-core-cur.1.19)
    if (labels.includes("pipeline:submission-prep") ||
        labels.includes("pipeline:compliance-check") ||
        labels.includes("pipeline:package")) return "submission-prep";
    // Map all QA-related pipeline labels to the "qa" column.
    // CLAUDE.md documents pipeline:qa-round-1, pipeline:qa-round-2,
    // pipeline:ux-polish, pipeline:qa-review, pipeline:security-review
    // as valid pipeline labels. beads_web collapses these into one QA column.
    // (factory-core-cur.1.19)
    if (labels.includes("pipeline:qa") ||
        labels.some((l) => l.startsWith("pipeline:qa-round-")) ||
        labels.includes("pipeline:ux-polish") ||
        labels.includes("pipeline:qa-review") ||
        labels.includes("pipeline:security-review")) return "qa";
    // Build review is part of the development cycle (between waves),
    // so map it to the development column
    if (labels.includes("pipeline:build-review")) return "development";
    if (labels.includes("pipeline:development")) return "development";
    // pipeline:plan-review is the explicit label; pipeline:research-complete
    // with plan:* labels is the legacy detection. (factory-core-cur.1.19)
    if (labels.includes("pipeline:plan-review")) return "plan-review";
    // Product spec and architecture stages (factory-core-lxc.2)
    // Checked after plan-review (which is more advanced in the pipeline),
    // architecture before product-spec (architecture is more advanced).
    if (labels.includes("pipeline:architecture")) return "architecture";
    if (labels.includes("pipeline:product-spec")) return "product-spec";
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
    const children = allIssues.filter((i) =>
      i.epic === epic.id || i.labels?.includes(`epic:${epic.id}`),
    );
    const stage = detectStage(epic, children);
    const shipType = getShipType(epic);
    const closed = children.filter((c) => c.status === "closed").length;
    return {
      epic,
      children,
      stage,
      shipType,
      progress: { closed, total: children.length },
    };
  });
}

/** Per-wave progress entry. */
export interface WaveProgress {
  wave: number;
  total: number;
  closed: number;
}

/**
 * Extract wave information from an app's children.
 * Returns null if no children have wave:N labels.
 */
export function getWaveInfo(children: PlanIssue[]): WaveProgress[] | null {
  const waveMap = new Map<number, { total: number; closed: number }>();
  for (const child of children) {
    const waveLabel = child.labels?.find((l) => l.startsWith("wave:"));
    if (!waveLabel) continue;
    const waveNum = parseInt(waveLabel.slice(5), 10);
    if (isNaN(waveNum)) continue;
    const entry = waveMap.get(waveNum) ?? { total: 0, closed: 0 };
    entry.total += 1;
    if (child.status === "closed") entry.closed += 1;
    waveMap.set(waveNum, entry);
  }
  if (waveMap.size === 0) return null;

  return Array.from(waveMap.entries())
    .sort(([a], [b]) => a - b)
    .map(([wave, { total, closed }]) => ({ wave, total, closed }));
}

/**
 * Collect all unique wave numbers present across a set of apps.
 * Returns sorted array of wave numbers, or empty array if no waves found.
 */
export function collectWaveNumbers(apps: FleetApp[]): number[] {
  const waves = new Set<number>();
  for (const app of apps) {
    for (const child of app.children) {
      const waveLabel = child.labels?.find((l) => l.startsWith("wave:"));
      if (!waveLabel) continue;
      const waveNum = parseInt(waveLabel.slice(5), 10);
      if (!isNaN(waveNum)) waves.add(waveNum);
    }
  }
  return Array.from(waves).sort((a, b) => a - b);
}

/**
 * Check if an app has any children in a specific wave.
 */
export function appHasWave(app: FleetApp, wave: number): boolean {
  return app.children.some((c) =>
    c.labels?.includes(`wave:${wave}`) ?? false,
  );
}

// ---------------------------------------------------------------------------
// Attention items — surface human review gates (factory-core-509)
// ---------------------------------------------------------------------------

/**
 * Categories of attention an epic (or one of its children) can flag.
 *
 * - "verification-needed": checkpoint:human-verify on the epic
 * - "decision-required":   checkpoint:decision on the epic
 * - "human-action":        checkpoint:human-action on the epic
 * - "qa-review":           qa:needs-review on the epic (QA reached max rounds)
 * - "human-flagged":       a child bead carries the "human" label (set by `bd human`)
 */
export type AttentionType =
  | "verification-needed"
  | "decision-required"
  | "human-action"
  | "qa-review"
  | "human-flagged";

/** A response action available on an attention item (e.g. Approve / Dismiss). */
export interface AttentionAction {
  /** Server-side action name dispatched via POST /api/fleet/action. */
  name: "human-approve" | "human-dismiss";
  /** Display label shown on the button. */
  label: string;
}

/** A single attention item rendered as an amber banner / counted in the badge. */
export interface AttentionItem {
  /** Stable id unique within a page render (epic + label or epic + bead). */
  id: string;
  /** Parent epic id this attention belongs to (used for grouping and dispatch). */
  epicId: string;
  /** For human-flagged child beads only: the originating child bead id. */
  beadId?: string;
  /** For human-flagged child beads only: the child bead title for context. */
  beadTitle?: string;
  /** Category of attention. */
  type: AttentionType;
  /** Display reason text (e.g. "Human Verification Required"). */
  reason: string;
  /** Response actions (Approve / Dismiss). */
  actions: AttentionAction[];
  /** For label-driven items: the source label to remove on action. */
  targetLabel?: string;
}

/**
 * Configuration table mapping each AttentionType to its source label,
 * display reason, and available actions. Single source of truth for
 * detection (fleet-utils.ts) and rendering (AttentionBanner.tsx).
 */
export const ATTENTION_CONFIG: Record<
  AttentionType,
  {
    /** Label that triggers this attention type; absent for "human-flagged" (driven by child label). */
    sourceLabel?: string;
    /** Display text shown in the banner. */
    reason: string;
    /** Available actions (typically a single Approve or Dismiss). */
    actions: AttentionAction[];
  }
> = {
  "verification-needed": {
    sourceLabel: "checkpoint:human-verify",
    reason: "Human Verification Required",
    actions: [{ name: "human-approve", label: "Approve" }],
  },
  "decision-required": {
    sourceLabel: "checkpoint:decision",
    reason: "Decision Required",
    actions: [{ name: "human-dismiss", label: "Dismiss" }],
  },
  "human-action": {
    sourceLabel: "checkpoint:human-action",
    reason: "Human Action Required",
    actions: [{ name: "human-dismiss", label: "Dismiss" }],
  },
  "qa-review": {
    sourceLabel: "qa:needs-review",
    reason: "QA Review Needed",
    actions: [{ name: "human-dismiss", label: "Dismiss" }],
  },
  "human-flagged": {
    reason: "Flagged for Human Decision",
    actions: [{ name: "human-dismiss", label: "Dismiss" }],
  },
};

/** Internal: the order epic-label-driven attention types are checked. */
const EPIC_LABEL_ATTENTION_TYPES: AttentionType[] = [
  "verification-needed",
  "decision-required",
  "human-action",
  "qa-review",
];

/**
 * Detect attention items on a fleet app.
 *
 * Pure function. Does not poll, hit any API, or spawn a process. It scans
 * labels already loaded by useIssues and returns the items that need human
 * review.
 *
 * Closed epics (terminal status) are excluded so stale labels on completed
 * or abandoned work do not generate phantom attention items.
 *
 * Children with null/undefined labels are safely skipped.
 */
export function getAttentionItems(app: FleetApp): AttentionItem[] {
  const items: AttentionItem[] = [];

  // Exclude closed epics — stale checkpoint labels on terminal work
  // should not produce attention items.
  if (app.epic.status === "closed") return items;

  const epicLabels = app.epic.labels ?? [];

  // Epic-level label-driven attention types
  for (const type of EPIC_LABEL_ATTENTION_TYPES) {
    const config = ATTENTION_CONFIG[type];
    const sourceLabel = config.sourceLabel;
    if (!sourceLabel) continue;
    if (epicLabels.includes(sourceLabel)) {
      items.push({
        id: `${app.epic.id}:${sourceLabel}`,
        epicId: app.epic.id,
        type,
        reason: config.reason,
        actions: config.actions,
        targetLabel: sourceLabel,
      });
    }
  }

  // Child-level "human" label → human-flagged item per child bead
  for (const child of app.children) {
    const childLabels = child.labels ?? [];
    if (childLabels.includes("human")) {
      const config = ATTENTION_CONFIG["human-flagged"];
      items.push({
        id: `${app.epic.id}:human:${child.id}`,
        epicId: app.epic.id,
        beadId: child.id,
        beadTitle: child.title,
        type: "human-flagged",
        reason: config.reason,
        actions: config.actions,
      });
    }
  }

  return items;
}
