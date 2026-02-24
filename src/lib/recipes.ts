// =============================================================================
// Beads Fleet — Saved Views / Recipes
// =============================================================================
//
// Defines built-in filter presets and the shape for custom saved views.
// Persistence is handled client-side via localStorage.
// =============================================================================

import type { IssueStatus, IssueType, Priority, PlanIssue } from "./types";

export interface FilterCriteria {
  statuses?: IssueStatus[];
  priorities?: Priority[];
  types?: IssueType[];
  owner?: string;
  labels?: string[];
  projects?: string[];
  epic?: string;       // filter to specific epic, or "__none__" for no epic
  hasBlockers?: boolean;
  isStale?: boolean; // updated > 30 days ago
  isRecent?: boolean; // updated < 7 days ago
  createdAfter?: string;   // ISO date string — only show issues created on/after this date
  createdBefore?: string;  // ISO date string — only show issues created on/before this date
  labelPrefix?: string;  // match issues having any label starting with this prefix
  search?: string;
}

export interface SavedView {
  id: string;
  name: string;
  description?: string;
  filter: FilterCriteria;
  isBuiltIn: boolean;
}

// ---------------------------------------------------------------------------
// Built-in recipes
// ---------------------------------------------------------------------------

export const BUILT_IN_VIEWS: SavedView[] = [
  {
    id: "all",
    name: "All Issues",
    description: "Show all non-closed issues",
    filter: {
      statuses: ["open", "in_progress", "blocked", "deferred", "pinned"],
    },
    isBuiltIn: true,
  },
  {
    id: "actionable",
    name: "Actionable",
    description: "Open issues with no blockers",
    filter: {
      statuses: ["open"],
      hasBlockers: false,
    },
    isBuiltIn: true,
  },
  {
    id: "in-progress",
    name: "In Progress",
    description: "Issues currently being worked on",
    filter: {
      statuses: ["in_progress"],
    },
    isBuiltIn: true,
  },
  {
    id: "blocked",
    name: "Blocked",
    description: "Issues waiting on dependencies",
    filter: {
      statuses: ["blocked"],
      hasBlockers: true,
    },
    isBuiltIn: true,
  },
  {
    id: "high-priority",
    name: "High Priority",
    description: "Critical and high priority issues",
    filter: {
      priorities: [0, 1],
      statuses: ["open", "in_progress", "blocked"],
    },
    isBuiltIn: true,
  },
  {
    id: "bugs",
    name: "Bugs",
    description: "All open bugs",
    filter: {
      types: ["bug"],
      statuses: ["open", "in_progress", "blocked"],
    },
    isBuiltIn: true,
  },
  {
    id: "recent",
    name: "Recent",
    description: "Issues updated in the last 7 days",
    filter: {
      isRecent: true,
    },
    isBuiltIn: true,
  },
  {
    id: "stale",
    name: "Stale",
    description: "Issues not updated in 30+ days",
    filter: {
      isStale: true,
      statuses: ["open", "in_progress", "blocked"],
    },
    isBuiltIn: true,
  },
  {
    id: "submissions",
    name: "Submissions",
    description: "App Store submission tracking",
    filter: {
      labelPrefix: "submission:",
    },
    isBuiltIn: true,
  },
];

// ---------------------------------------------------------------------------
// Filter engine
// ---------------------------------------------------------------------------

export function applyFilter(
  issues: PlanIssue[],
  filter: FilterCriteria,
): PlanIssue[] {
  return issues.filter((issue) => {
    // Status filter
    if (filter.statuses && filter.statuses.length > 0) {
      if (!filter.statuses.includes(issue.status)) return false;
    }

    // Priority filter
    if (filter.priorities && filter.priorities.length > 0) {
      if (!filter.priorities.includes(issue.priority)) return false;
    }

    // Type filter
    if (filter.types && filter.types.length > 0) {
      if (!filter.types.includes(issue.issue_type)) return false;
    }

    // Owner filter
    if (filter.owner) {
      if (!issue.owner || !issue.owner.toLowerCase().includes(filter.owner.toLowerCase())) {
        return false;
      }
    }

    // Labels filter
    if (filter.labels && filter.labels.length > 0) {
      if (!issue.labels || !filter.labels.some((l) => issue.labels!.includes(l))) {
        return false;
      }
    }

    // Project filter (matches project:* labels)
    if (filter.projects && filter.projects.length > 0) {
      const projectLabels = filter.projects.map((p) => `project:${p}`);
      if (!issue.labels || !projectLabels.some((pl) => issue.labels!.includes(pl))) {
        return false;
      }
    }

    // Epic filter
    if (filter.epic) {
      if (filter.epic === "__none__") {
        if (issue.epic) return false;
      } else {
        if (issue.epic !== filter.epic) return false;
      }
    }

    // Label prefix filter (e.g. "submission:" matches submission:ready, submission:approved)
    if (filter.labelPrefix) {
      if (!issue.labels || !issue.labels.some((l) => l.startsWith(filter.labelPrefix!))) {
        return false;
      }
    }

    // Blocker filter
    if (filter.hasBlockers === true && issue.blocked_by.length === 0) return false;
    if (filter.hasBlockers === false && issue.blocked_by.length > 0) return false;

    // Date created filter
    if (filter.createdAfter) {
      if (!issue.created_at || issue.created_at < filter.createdAfter) return false;
    }
    if (filter.createdBefore) {
      // Compare against end-of-day by appending T23:59:59 if only a date string
      const cutoff = filter.createdBefore.length === 10
        ? filter.createdBefore + "T23:59:59"
        : filter.createdBefore;
      if (!issue.created_at || issue.created_at > cutoff) return false;
    }

    // Staleness / recency filters (based on updated_at)
    if (filter.isStale === true) {
      if (!issue.updated_at) return false;
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      if (issue.updated_at > thirtyDaysAgo) return false;
    }
    if (filter.isRecent === true) {
      if (!issue.updated_at) return false;
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      if (issue.updated_at < sevenDaysAgo) return false;
    }

    // Search filter
    if (filter.search) {
      const q = filter.search.toLowerCase();
      const matches =
        issue.id.toLowerCase().includes(q) ||
        issue.title.toLowerCase().includes(q) ||
        (issue.owner?.toLowerCase().includes(q) ?? false);
      if (!matches) return false;
    }

    return true;
  });
}

// ---------------------------------------------------------------------------
// localStorage helpers (client-side only)
// ---------------------------------------------------------------------------

const STORAGE_KEY = "beads-web-saved-views";

export function loadCustomViews(): SavedView[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as SavedView[];
  } catch {
    return [];
  }
}

export function saveCustomViews(views: SavedView[]): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(views));
}

export function getAllViews(): SavedView[] {
  return [...BUILT_IN_VIEWS, ...loadCustomViews()];
}
