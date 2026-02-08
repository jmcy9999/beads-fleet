"use client";

import { KanbanBoard } from "@/components/board/KanbanBoard";
import { IssueDetailPanel } from "@/components/board/IssueDetailPanel";
import { ErrorState } from "@/components/ui/ErrorState";
import { CardSkeleton } from "@/components/ui/LoadingSkeleton";
import { useIssues } from "@/hooks/useIssues";
import { useState } from "react";

export default function BoardPage() {
  const { data, isLoading, error, refetch } = useIssues();
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);

  const allIssues = data?.all_issues ?? [];
  const selectedIssue = selectedIssueId
    ? allIssues.find((i) => i.id === selectedIssueId) ?? null
    : null;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold text-white">Board</h1>
        {data && (
          <span className="text-sm text-gray-400">
            {allIssues.length} issues
          </span>
        )}
      </div>

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
          issues={allIssues}
          onSelectIssue={setSelectedIssueId}
        />
      )}

      {selectedIssue && (
        <IssueDetailPanel
          issue={selectedIssue}
          allIssues={allIssues}
          onClose={() => setSelectedIssueId(null)}
        />
      )}
    </div>
  );
}
