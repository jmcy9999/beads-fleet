"use client";

import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { KanbanBoard } from "@/components/board/KanbanBoard";
import { FilterBar } from "@/components/filters/FilterBar";
import { ErrorState } from "@/components/ui/ErrorState";
import { CardSkeleton } from "@/components/ui/LoadingSkeleton";
import { useIssues } from "@/hooks/useIssues";
import type { FilterCriteria } from "@/lib/recipes";
import { applyFilter } from "@/lib/recipes";

export default function BoardPage() {
  const { data, isLoading, error, refetch } = useIssues();
  const router = useRouter();
  const [filter, setFilter] = useState<FilterCriteria>({});
  const [activeViewId, setActiveViewId] = useState<string>("");

  const allIssues = useMemo(() => data?.all_issues ?? [], [data]);

  const filteredIssues = useMemo(
    () => applyFilter(allIssues, filter),
    [allIssues, filter],
  );

  const availableEpics = useMemo(() => {
    const epics = new Map<string, string>();
    for (const issue of allIssues) {
      if (issue.issue_type === "epic" && issue.status !== "closed") {
        epics.set(issue.id, issue.title);
      }
    }
    return epics;
  }, [allIssues]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold text-white">Board</h1>
        {data && (
          <span className="text-sm text-gray-400">
            {filteredIssues.length} of {allIssues.length} issues
          </span>
        )}
      </div>

      {data && (
        <FilterBar
          filter={filter}
          onFilterChange={setFilter}
          activeViewId={activeViewId}
          onViewChange={setActiveViewId}
          availableEpics={availableEpics}
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
        />
      )}
    </div>
  );
}
