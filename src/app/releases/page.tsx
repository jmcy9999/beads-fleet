"use client";

import { useMemo } from "react";
import { useIssues } from "@/hooks/useIssues";
import { useRepos } from "@/hooks/useRepos";
import { ProjectReleases, getReleaseLabel } from "@/components/releases";
import type { PlanIssue } from "@/lib/types";

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
      const hasRelease = issues.some((i) => getReleaseLabel(i) !== undefined);
      if (hasRelease) {
        result.push([project, issues]);
      }
    }
    return result.sort(([a], [b]) => a.localeCompare(b));
  }, [projectGroups]);

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
