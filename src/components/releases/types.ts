import type { PlanIssue } from "@/lib/types";

export interface ReleaseGroup {
  version: string;       // e.g. "2.1"
  label: string;         // e.g. "release:2.1"
  status: string | null; // e.g. "live", "in-progress", or null
  open: number;
  closed: number;
  total: number;
  issues: PlanIssue[];
}

export function extractReleaseVersion(label: string): string {
  return label.replace("release:", "");
}

export function extractReleaseStatus(issues: PlanIssue[]): string | null {
  for (const issue of issues) {
    for (const label of issue.labels ?? []) {
      if (label.startsWith("release-status:")) {
        return label.replace("release-status:", "");
      }
    }
  }
  return null;
}

export function getReleaseLabel(issue: PlanIssue): string | undefined {
  return (issue.labels ?? []).find(
    (l) => l.startsWith("release:") && !l.startsWith("release-status:")
  );
}

export function getStatusColor(status: string | null): string {
  switch (status) {
    case "live":
      return "text-green-400 bg-green-400/10 border-green-400/20";
    case "in-progress":
      return "text-blue-400 bg-blue-400/10 border-blue-400/20";
    case "in-review":
      return "text-yellow-400 bg-yellow-400/10 border-yellow-400/20";
    case "planning":
      return "text-purple-400 bg-purple-400/10 border-purple-400/20";
    default:
      return "text-gray-400 bg-gray-400/10 border-gray-400/20";
  }
}

export function getStatusLabel(status: string | null): string {
  if (!status) return "No status";
  return status.charAt(0).toUpperCase() + status.slice(1).replace("-", " ");
}

/** Sort issues: in_progress first, then blocked, open, closed. Within same status, by priority. */
export function sortIssuesForRelease(issues: PlanIssue[]): PlanIssue[] {
  const order: Record<string, number> = {
    in_progress: 0,
    blocked: 1,
    open: 2,
    closed: 3,
  };
  return [...issues].sort((a, b) => {
    const oa = order[a.status] ?? 2;
    const ob = order[b.status] ?? 2;
    if (oa !== ob) return oa - ob;
    return a.priority - b.priority;
  });
}

/** Build ReleaseGroup[] from a flat list of issues. */
export function buildReleaseGroups(issues: PlanIssue[]): ReleaseGroup[] {
  const groups = new Map<string, PlanIssue[]>();
  const unassigned: PlanIssue[] = [];

  for (const issue of issues) {
    const releaseLabel = getReleaseLabel(issue);
    if (releaseLabel) {
      const existing = groups.get(releaseLabel) ?? [];
      existing.push(issue);
      groups.set(releaseLabel, existing);
    } else {
      unassigned.push(issue);
    }
  }

  const result: ReleaseGroup[] = [];

  const sorted = Array.from(groups.entries()).sort(([a], [b]) => {
    const va = extractReleaseVersion(a);
    const vb = extractReleaseVersion(b);
    return vb.localeCompare(va, undefined, { numeric: true });
  });

  for (const [label, groupIssues] of sorted) {
    const open = groupIssues.filter((i) => i.status !== "closed").length;
    const closed = groupIssues.filter((i) => i.status === "closed").length;
    result.push({
      version: extractReleaseVersion(label),
      label,
      status: extractReleaseStatus(groupIssues),
      open,
      closed,
      total: groupIssues.length,
      issues: groupIssues,
    });
  }

  if (unassigned.length > 0) {
    const open = unassigned.filter((i) => i.status !== "closed").length;
    const closed = unassigned.filter((i) => i.status === "closed").length;
    result.push({
      version: "Unassigned",
      label: "",
      status: null,
      open,
      closed,
      total: unassigned.length,
      issues: unassigned,
    });
  }

  return result;
}
