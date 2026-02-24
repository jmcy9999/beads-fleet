"use client";

import { useState, useMemo } from "react";
import type { PlanIssue } from "@/lib/types";
import type { FilterCriteria } from "@/lib/recipes";
import { applyFilter, BUILT_IN_VIEWS } from "@/lib/recipes";
import { IssueCard } from "@/components/ui/IssueCard";
import { FilterBar } from "@/components/filters/FilterBar";
import { useTokenUsageSummary } from "@/hooks/useTokenUsage";

type SortKey = "id" | "project" | "title" | "status" | "priority" | "owner" | "epic" | "blocked_by" | "cost" | "created";
type SortDir = "asc" | "desc";

interface IssueTableProps {
  issues: PlanIssue[];
}

function getProject(issue: PlanIssue): string {
  const label = issue.labels?.find((l) => l.startsWith("project:"));
  return label ? label.slice(8) : "";
}

const COLUMN_HEADERS: { key: SortKey; label: string }[] = [
  { key: "id", label: "ID" },
  { key: "project", label: "Project" },
  { key: "title", label: "Title" },
  { key: "status", label: "Status" },
  { key: "priority", label: "Priority" },
  { key: "owner", label: "Owner" },
  { key: "epic", label: "Epic" },
  { key: "blocked_by", label: "Blocked By" },
  { key: "cost", label: "Cost" },
  { key: "created", label: "Created" },
];

function comparePlanIssues(
  a: PlanIssue,
  b: PlanIssue,
  key: SortKey,
  tokenSummary?: Record<string, { total_cost_usd: number }>,
): number {
  switch (key) {
    case "id":
      return a.id.localeCompare(b.id);
    case "project":
      return getProject(a).localeCompare(getProject(b));
    case "title":
      return a.title.localeCompare(b.title);
    case "status":
      return a.status.localeCompare(b.status);
    case "priority":
      return (a.priority as number) - (b.priority as number);
    case "owner":
      return (a.owner ?? "").localeCompare(b.owner ?? "");
    case "epic":
      return (a.epic ?? "").localeCompare(b.epic ?? "");
    case "blocked_by":
      return a.blocked_by.length - b.blocked_by.length;
    case "cost": {
      const aCost = tokenSummary?.[a.id]?.total_cost_usd ?? 0;
      const bCost = tokenSummary?.[b.id]?.total_cost_usd ?? 0;
      return aCost - bCost;
    }
    case "created":
      return (a.created_at ?? "").localeCompare(b.created_at ?? "");
    default:
      return 0;
  }
}

// Default view: "All Issues" built-in view
const DEFAULT_VIEW = BUILT_IN_VIEWS[0];

export function IssueTable({ issues }: IssueTableProps) {
  const { data: tokenSummary } = useTokenUsageSummary();
  const [sortKey, setSortKey] = useState<SortKey>("priority");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [filter, setFilter] = useState<FilterCriteria>(
    DEFAULT_VIEW.filter,
  );
  const [activeViewId, setActiveViewId] = useState<string>(DEFAULT_VIEW.id);

  const handleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const availableProjects = useMemo(() => {
    const projects = new Set<string>();
    for (const issue of issues) {
      const label = issue.labels?.find((l) => l.startsWith("project:"));
      if (label) projects.add(label.slice(8));
    }
    return Array.from(projects).sort();
  }, [issues]);

  const availableEpics = useMemo(() => {
    const epics = new Map<string, string>();
    for (const issue of issues) {
      if (issue.epic) {
        epics.set(issue.epic, issue.epic_title ?? issue.epic);
      }
    }
    return epics;
  }, [issues]);

  const sortedIssues = useMemo(() => {
    const filtered = applyFilter(issues, filter);

    return [...filtered].sort((a, b) => {
      const cmp = comparePlanIssues(a, b, sortKey, tokenSummary?.byIssue);
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [issues, filter, sortKey, sortDir, tokenSummary]);

  const sortIndicator = (key: SortKey) => {
    if (key !== sortKey) return null;
    return (
      <span className="ml-1 text-gray-400">
        {sortDir === "asc" ? "\u2191" : "\u2193"}
      </span>
    );
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-white">Issues</h2>
        <span className="text-sm text-gray-400">
          {sortedIssues.length} of {issues.length} issues
        </span>
      </div>

      <FilterBar
        filter={filter}
        onFilterChange={setFilter}
        activeViewId={activeViewId}
        onViewChange={setActiveViewId}
        availableProjects={availableProjects}
        availableEpics={availableEpics}
      />

      {/* Desktop table */}
      <div className="hidden md:block overflow-x-auto">
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-surface-2">
              {COLUMN_HEADERS.map((col) => (
                <th
                  key={col.key}
                  className="px-3 py-2 text-xs font-medium uppercase tracking-wider text-gray-400 cursor-pointer hover:text-white transition-colors select-none"
                  onClick={() => handleSort(col.key)}
                >
                  {col.label}
                  {sortIndicator(col.key)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-2">
            {sortedIssues.map((issue) => (
              <IssueCard
                key={issue.id}
                issue={issue}
                variant="row"
                tokenCost={tokenSummary?.byIssue?.[issue.id]?.total_cost_usd}
                allIssues={issues}
              />
            ))}
          </tbody>
        </table>
        {sortedIssues.length === 0 && (
          <p className="text-center text-gray-500 py-8 text-sm">
            No issues match the current filters.
          </p>
        )}
      </div>

      {/* Mobile cards */}
      <div className="md:hidden grid gap-3">
        {sortedIssues.map((issue) => (
          <IssueCard
            key={issue.id}
            issue={issue}
            variant="card"
            tokenCost={tokenSummary?.byIssue?.[issue.id]?.total_cost_usd}
            allIssues={issues}
          />
        ))}
        {sortedIssues.length === 0 && (
          <p className="text-center text-gray-500 py-8 text-sm">
            No issues match the current filters.
          </p>
        )}
      </div>
    </div>
  );
}
