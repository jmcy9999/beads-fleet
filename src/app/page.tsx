"use client";

import { SummaryCards } from "@/components/dashboard/SummaryCards";
import { WhatsNext } from "@/components/dashboard/WhatsNext";
import { IssueTable } from "@/components/dashboard/IssueTable";
import { PriorityAlerts } from "@/components/dashboard/PriorityAlerts";
import { ErrorState } from "@/components/ui/ErrorState";
import { SummaryCardSkeleton } from "@/components/ui/LoadingSkeleton";
import { useIssues } from "@/hooks/useIssues";
import { usePriority } from "@/hooks/usePriority";

export default function Home() {
  const {
    data: plan,
    isLoading: issuesLoading,
    error: issuesError,
    refetch: refetchIssues,
  } = useIssues();

  const {
    data: priority,
    isLoading: priorityLoading,
    error: priorityError,
    refetch: refetchPriority,
  } = usePriority();

  const isLoading = issuesLoading || priorityLoading;
  const error = issuesError || priorityError;

  if (error) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold text-white">Dashboard</h1>
        <ErrorState
          message="Failed to load dashboard data"
          detail={error.message}
          onRetry={() => {
            refetchIssues();
            refetchPriority();
          }}
        />
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold text-white">Dashboard</h1>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <SummaryCardSkeleton key={i} />
          ))}
        </div>
      </div>
    );
  }

  if (!plan) return null;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-white">Dashboard</h1>

      <SummaryCards summary={plan.summary} />

      {plan.summary.highest_impact && (
        <WhatsNext impact={plan.summary.highest_impact} />
      )}

      {priority && priority.misaligned_count > 0 && (
        <PriorityAlerts recommendations={priority.recommendations} />
      )}

      <IssueTable issues={plan.all_issues} />
    </div>
  );
}
