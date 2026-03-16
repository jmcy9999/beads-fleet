"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useIssues } from "@/hooks/useIssues";
import { useRepos } from "@/hooks/useRepos";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { PriorityIndicator } from "@/components/ui/PriorityIndicator";
import { IssueTypeIcon } from "@/components/ui/IssueTypeIcon";
import type { PlanIssue } from "@/lib/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ReleaseGroup {
  version: string;         // e.g. "2.1"
  label: string;           // e.g. "release:2.1"
  status: string | null;   // e.g. "live", "in-progress", or null
  open: number;
  closed: number;
  total: number;
  issues: PlanIssue[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractReleaseVersion(label: string): string {
  return label.replace("release:", "");
}

function extractReleaseStatus(issues: PlanIssue[]): string | null {
  // Find any release-status:* label among the issues in this release
  for (const issue of issues) {
    for (const label of issue.labels ?? []) {
      if (label.startsWith("release-status:")) {
        return label.replace("release-status:", "");
      }
    }
  }
  return null;
}

function getStatusColor(status: string | null): string {
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

function getStatusLabel(status: string | null): string {
  if (!status) return "No status";
  return status.charAt(0).toUpperCase() + status.slice(1).replace("-", " ");
}

// ---------------------------------------------------------------------------
// Release Issue List (expanded view)
// ---------------------------------------------------------------------------

function ReleaseIssueList({ issues }: { issues: PlanIssue[] }) {
  // Show open/in-progress first, then closed
  const sorted = useMemo(() => {
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
  }, [issues]);

  return (
    <div className="mt-2 border-t border-surface-2 pt-2">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-gray-500 border-b border-surface-2">
            <th className="text-left px-2 py-1 font-medium w-8"></th>
            <th className="text-left px-2 py-1 font-medium">Title</th>
            <th className="text-left px-2 py-1 font-medium w-24">Status</th>
            <th className="text-left px-2 py-1 font-medium w-16">Priority</th>
            <th className="text-left px-2 py-1 font-medium w-20">Type</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((issue) => (
            <tr
              key={issue.id}
              className="hover:bg-surface-2/50 transition-colors"
            >
              <td className="px-2 py-1.5">
                <IssueTypeIcon type={issue.issue_type} />
              </td>
              <td className="px-2 py-1.5">
                <Link
                  href={`/issue/${issue.id}`}
                  className="text-gray-200 hover:text-white hover:underline transition-colors"
                >
                  {issue.title}
                </Link>
                <span className="ml-2 text-xs text-gray-500 font-mono">{issue.id}</span>
              </td>
              <td className="px-2 py-1.5">
                <StatusBadge status={issue.status} />
              </td>
              <td className="px-2 py-1.5">
                <PriorityIndicator priority={issue.priority} />
              </td>
              <td className="px-2 py-1.5 text-xs text-gray-400 capitalize">
                {issue.issue_type}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Project Release Card
// ---------------------------------------------------------------------------

function ProjectReleases({ projectName, issues }: { projectName: string; issues: PlanIssue[] }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggleExpand = (version: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(version)) {
        next.delete(version);
      } else {
        next.add(version);
      }
      return next;
    });
  };

  const releases = useMemo(() => {
    const groups = new Map<string, PlanIssue[]>();
    const unassigned: PlanIssue[] = [];

    for (const issue of issues) {
      const releaseLabel = (issue.labels ?? []).find(
        (l) => l.startsWith("release:") && !l.startsWith("release-status:")
      );
      if (releaseLabel) {
        const existing = groups.get(releaseLabel) ?? [];
        existing.push(issue);
        groups.set(releaseLabel, existing);
      } else {
        unassigned.push(issue);
      }
    }

    const result: ReleaseGroup[] = [];

    // Sort releases by version descending
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

    // Add unassigned group if any
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
  }, [issues]);

  if (releases.length === 0) {
    return null;
  }

  return (
    <div className="card p-5">
      <h2 className="text-lg font-semibold text-white mb-4">{projectName}</h2>
      <div className="space-y-2">
        {releases.map((release) => {
          const pct = release.total > 0 ? Math.round((release.closed / release.total) * 100) : 0;
          const isExpanded = expanded.has(release.version);
          return (
            <div
              key={release.version}
              className="rounded-lg bg-surface-2/50 transition-colors"
            >
              <div
                className="flex items-center gap-4 p-3 cursor-pointer hover:bg-surface-2 rounded-lg transition-colors"
                onClick={() => toggleExpand(release.version)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === "Enter") toggleExpand(release.version); }}
              >
                {/* Expand chevron */}
                <svg
                  className={`w-4 h-4 text-gray-400 transition-transform shrink-0 ${isExpanded ? "rotate-90" : ""}`}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                </svg>

                {/* Version */}
                <div className="w-16 shrink-0">
                  {release.label ? (
                    <span className="text-sm font-mono font-semibold text-blue-400">
                      v{release.version}
                    </span>
                  ) : (
                    <span className="text-sm font-mono text-gray-500">{release.version}</span>
                  )}
                </div>

                {/* Status badge */}
                <span
                  className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium border ${getStatusColor(release.status)}`}
                >
                  {getStatusLabel(release.status)}
                </span>

                {/* Progress bar */}
                <div className="flex-1 min-w-0">
                  <div className="h-2 rounded-full bg-surface-0 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-green-500 to-emerald-400 transition-all duration-300"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>

                {/* Counts */}
                <div className="text-xs text-gray-400 whitespace-nowrap w-28 text-right">
                  <span className="text-green-400">{release.closed}</span>
                  {" / "}
                  <span>{release.total}</span>
                  {" closed"}
                  {release.open > 0 && (
                    <span className="text-gray-500 ml-1">({release.open} open)</span>
                  )}
                </div>
              </div>

              {/* Expanded issue list */}
              {isExpanded && (
                <div className="px-3 pb-3">
                  <ReleaseIssueList issues={release.issues} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Releases Page
// ---------------------------------------------------------------------------

export default function ReleasesPage() {
  const { data: issuesData, isLoading, error } = useIssues();
  const { data: reposData } = useRepos();

  // Group issues by project
  const projectGroups = useMemo(() => {
    if (!issuesData?.all_issues) return new Map<string, PlanIssue[]>();

    const groups = new Map<string, PlanIssue[]>();
    for (const issue of issuesData.all_issues) {
      const projectLabel = (issue.labels ?? []).find((l) => l.startsWith("project:"));
      const project = projectLabel ? projectLabel.slice(8) : "Unknown";
      const existing = groups.get(project) ?? [];
      existing.push(issue);
      groups.set(project, existing);
    }
    return groups;
  }, [issuesData]);

  // Only show projects that have at least one release:* label
  const projectsWithReleases = useMemo(() => {
    const result: [string, PlanIssue[]][] = [];
    for (const [project, issues] of projectGroups) {
      const hasRelease = issues.some((i) =>
        (i.labels ?? []).some((l) => l.startsWith("release:") && !l.startsWith("release-status:"))
      );
      if (hasRelease) {
        result.push([project, issues]);
      }
    }
    // Sort alphabetically
    return result.sort(([a], [b]) => a.localeCompare(b));
  }, [projectGroups]);

  // Use project name from active repo if single project showing as "Unknown"
  const displayName = (name: string) => {
    if (name === "Unknown" && reposData?.repos) {
      const active = reposData.activeRepo;
      const match = reposData.repos.find((r) => r.path === active);
      if (match) return match.name;
    }
    return name;
  };

  if (isLoading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-8 w-32 rounded bg-surface-2" />
        <div className="card p-5 space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-12 rounded bg-surface-2" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-red-400 p-4">
        Failed to load issues: {error.message}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">Releases</h1>
        <span className="text-sm text-gray-400">
          {projectsWithReleases.length} project{projectsWithReleases.length !== 1 ? "s" : ""} with releases
        </span>
      </div>

      {projectsWithReleases.length === 0 ? (
        <div className="card p-8 text-center">
          <p className="text-gray-400 mb-2">No releases found.</p>
          <p className="text-sm text-gray-500">
            Add <code className="bg-surface-2 px-1.5 py-0.5 rounded text-xs">release:X.Y</code> labels to beads to track releases.
          </p>
        </div>
      ) : (
        projectsWithReleases.map(([project, issues]) => (
          <ProjectReleases key={project} projectName={displayName(project)} issues={issues} />
        ))
      )}
    </div>
  );
}
