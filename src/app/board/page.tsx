"use client";

import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { KanbanBoard, type KanbanSortOrder } from "@/components/board/KanbanBoard";
import { FilterBar } from "@/components/filters/FilterBar";
import { ErrorState } from "@/components/ui/ErrorState";
import { CardSkeleton } from "@/components/ui/LoadingSkeleton";
import { useIssues } from "@/hooks/useIssues";
import type { FilterCriteria } from "@/lib/recipes";
import { applyFilter } from "@/lib/recipes";

const SORT_STORAGE_KEY = "beads-web-kanban-sort";

function loadSortOrder(): KanbanSortOrder {
  if (typeof window === "undefined") return "date";
  return (localStorage.getItem(SORT_STORAGE_KEY) as KanbanSortOrder) ?? "date";
}

export default function BoardPage() {
  const { data, isLoading, error, refetch } = useIssues();
  const router = useRouter();
  const [filter, setFilter] = useState<FilterCriteria>({});
  const [activeViewId, setActiveViewId] = useState<string>("");
  const [sortOrder, setSortOrder] = useState<KanbanSortOrder>(loadSortOrder);

  const toggleSort = () => {
    const next = sortOrder === "date" ? "priority" : "date";
    setSortOrder(next);
    localStorage.setItem(SORT_STORAGE_KEY, next);
  };

  const allIssues = useMemo(() => data?.all_issues ?? [], [data]);

  const filteredIssues = useMemo(
    () => applyFilter(allIssues, filter),
    [allIssues, filter],
  );

  // Collect all issues that have children (are parents) for the parent filter
  const availableParents = useMemo(() => {
    const parentIds = new Set<string>();
    for (const issue of allIssues) {
      if (issue.epic) parentIds.add(issue.epic);
    }
    const parents = new Map<string, string>();
    for (const issue of allIssues) {
      if (parentIds.has(issue.id) && issue.status !== "closed") {
        parents.set(issue.id, `[${issue.issue_type}] ${issue.title}`);
      }
    }
    return parents;
  }, [allIssues]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold text-white">Board</h1>
        <div className="flex items-center gap-3">
          {data && (
            <span className="text-sm text-gray-400">
              {filteredIssues.length} of {allIssues.length} issues
            </span>
          )}
          <button
            type="button"
            onClick={toggleSort}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-surface-2 border border-border-default rounded-md text-gray-300 hover:text-white hover:border-gray-500 transition-colors"
            title={`Sorting by ${sortOrder === "date" ? "date" : "priority"} — click to toggle`}
          >
            <svg
              className="w-3.5 h-3.5 text-gray-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 4h13M3 8h9m-9 4h6m4 0l4-4m0 0l4 4m-4-4v12" />
            </svg>
            {sortOrder === "priority" ? "Priority" : "Date"}
          </button>
        </div>
      </div>

      {data && (
        <FilterBar
          filter={filter}
          onFilterChange={setFilter}
          activeViewId={activeViewId}
          onViewChange={setActiveViewId}
          availableEpics={availableParents}
        />
      )}

      {error && (
        <ErrorState
          message="Failed to load issues"
          detail={error instanceof Error ? error.message : String(error)}
          onRetry={() => refetch()}
        />
      )}

      {isLoading && (
        <div className="flex gap-4 overflow-x-auto flex-1 pb-4">
          {Array.from({ length: 3 }).map((_, col) => (
            <div key={col} className="min-w-[280px] max-w-[320px] flex-shrink-0 space-y-2">
              <div className="h-8 w-32 animate-pulse bg-surface-2 rounded mb-3" />
              {Array.from({ length: 3 }).map((_, row) => (
                <CardSkeleton key={row} />
              ))}
            </div>
          ))}
        </div>
      )}

      {data && (
        <KanbanBoard
          issues={filteredIssues}
          onSelectIssue={(id) => router.push(`/issue/${id}`)}
          sortOrder={sortOrder}
        />
      )}
    </div>
  );
}
