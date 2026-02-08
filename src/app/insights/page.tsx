"use client";

import { useInsights } from "@/hooks/useInsights";
import { useIssues } from "@/hooks/useIssues";
import { MetricPanel } from "@/components/insights/MetricPanel";
import { CyclesPanel } from "@/components/insights/CyclesPanel";
import { GraphDensityBadge } from "@/components/insights/GraphDensityBadge";
import { DependencyGraph } from "@/components/insights/DependencyGraph";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";

function MetricPanelSkeleton() {
  return (
    <div className="card p-5 space-y-4">
      <div className="space-y-1">
        <div className="h-3 w-32 animate-pulse rounded bg-surface-2" />
        <div className="h-2 w-48 animate-pulse rounded bg-surface-2" />
      </div>
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <div className="h-3 w-5 animate-pulse rounded bg-surface-2" />
          <div className="h-3 w-14 animate-pulse rounded bg-surface-2" />
          <div className="h-3 flex-1 animate-pulse rounded bg-surface-2" />
          <div className="h-2 w-24 animate-pulse rounded bg-surface-2" />
        </div>
      ))}
    </div>
  );
}

export default function InsightsPage() {
  const { data, isLoading, isError, error, refetch } = useInsights();
  const { data: issuesData, isLoading: issuesLoading } = useIssues();

  if (isError) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold text-white">Insights</h1>
        <ErrorState
          message="Failed to load insights"
          detail={error?.message}
          onRetry={() => refetch()}
        />
      </div>
    );
  }

  if (isLoading || !data) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-white">Insights</h1>
          <div className="h-5 w-24 animate-pulse rounded-full bg-surface-2" />
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <MetricPanelSkeleton key={i} />
          ))}
        </div>
      </div>
    );
  }

  const allMetricsEmpty =
    data.bottlenecks.length === 0 &&
    data.keystones.length === 0 &&
    data.influencers.length === 0 &&
    data.hubs.length === 0 &&
    data.authorities.length === 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-bold text-white">Insights</h1>
        <GraphDensityBadge density={data.graph_density} />
        <span className="text-xs text-gray-500">
          {data.total_issues} issue{data.total_issues !== 1 ? "s" : ""} analyzed
        </span>
      </div>

      {allMetricsEmpty && (
        <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-3">
          <p className="text-sm text-amber-400">
            <span className="font-medium">Metrics require bv.</span>{" "}
            Install and configure{" "}
            <code className="rounded bg-surface-2 px-1 py-0.5 text-xs font-mono">
              bv
            </code>{" "}
            to compute graph-based insights for your project.
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <MetricPanel
          title="Bottlenecks"
          description="Betweenness Centrality -- issues that bridge many dependency paths"
          entries={data.bottlenecks}
          colorScheme="red"
        />
        <MetricPanel
          title="Keystones"
          description="Critical Path Impact -- issues whose resolution unblocks the most work"
          entries={data.keystones}
          colorScheme="purple"
        />
        <MetricPanel
          title="Influencers"
          description="Eigenvector Centrality -- issues connected to other highly-connected issues"
          entries={data.influencers}
          colorScheme="blue"
        />
        <MetricPanel
          title="Hubs"
          description="HITS Hub Score -- issues that depend on many important issues"
          entries={data.hubs}
          colorScheme="amber"
        />
        <MetricPanel
          title="Authorities"
          description="HITS Authority Score -- issues depended on by many important issues"
          entries={data.authorities}
          colorScheme="green"
        />
        <CyclesPanel cycles={data.cycles} />
      </div>

      {/* Dependency Graph */}
      <div className="card p-4">
        <h2 className="text-lg font-semibold text-gray-100 mb-4">
          Dependency Graph
        </h2>
        {issuesLoading ? (
          <div className="h-[500px] flex items-center justify-center">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-surface-3 border-t-status-open" />
          </div>
        ) : (issuesData?.all_issues ?? []).length === 0 ? (
          <EmptyState
            message="No issues found"
            description="Create some issues with dependencies to see the dependency graph."
          />
        ) : (
          <div className="h-[500px] rounded border border-border-default overflow-hidden">
            <DependencyGraph issues={issuesData!.all_issues} />
          </div>
        )}
      </div>
    </div>
  );
}
