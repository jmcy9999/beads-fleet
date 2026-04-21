"use client";

import { useCallback, useMemo, useState } from "react";
import { FleetBoard } from "@/components/fleet/FleetBoard";
import type { PipelineActionPayload } from "@/components/fleet/FleetBoard";
import Link from "next/link";
import { AgentStatusBanner } from "@/components/fleet/AgentStatusBanner";
import { buildFleetApps, computeEpicCosts } from "@/components/fleet/fleet-utils";
import { ErrorState } from "@/components/ui/ErrorState";
import { CardSkeleton } from "@/components/ui/LoadingSkeleton";
import { useIssues } from "@/hooks/useIssues";
import { useTokenUsageSummary } from "@/hooks/useTokenUsage";
import { useFleetAgentStatus, useAgentStop } from "@/hooks/useAgent";
import { usePipelineAction } from "@/hooks/usePipelineAction";
import { useAttentionItems } from "@/hooks/useAttentionItems";
import { AttentionBadge } from "@/components/fleet/AttentionBadge";
import { ReconcilerStatusCard } from "@/components/fleet/ReconcilerStatusCard";

export default function FleetPage() {
  const { data, isLoading, error, refetch } = useIssues();
  const { data: tokenData } = useTokenUsageSummary();
  // factory-core-d5b.7: fleet-wide status (all agents) replaces the
  // single-session query so parallel per-bead builders and concurrent
  // epics are all visible.
  const { data: fleetAgentStatus } = useFleetAgentStatus();
  const stopAgent = useAgentStop();
  const pipelineAction = usePipelineAction();
  const [pendingEpicId, setPendingEpicId] = useState<string | null>(null);

  const allIssues = useMemo(() => data?.all_issues ?? [], [data]);
  const epicCount = useMemo(
    () => allIssues.filter((i) => i.issue_type === "epic").length,
    [allIssues],
  );

  const epicCosts = useMemo(() => {
    if (!tokenData?.byIssue) return undefined;
    const apps = buildFleetApps(allIssues);
    return computeEpicCosts(apps, tokenData.byIssue);
  }, [allIssues, tokenData]);

  const totalFleetCost = useMemo(() => {
    if (!epicCosts) return 0;
    let sum = 0;
    for (const cost of epicCosts.values()) sum += cost.totalCost;
    return sum;
  }, [epicCosts]);

  // Derive attention items (human review gates) from the same useIssues data.
  // Card-level banners and the header badge share this one computation so they
  // never disagree (ADR-002 single source of truth). (factory-core-509.7)
  const attention = useAttentionItems(allIssues);

  // Build a map of epicId -> langfuseTraceUrl from agent sessions (factory-core-75e)
  // factory-core-d5b.7: iterate over the full fleet — when many agents run
  // concurrently, each contributes its own trace URL, keyed by epicId.
  const langfuseTraceUrls = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of fleetAgentStatus?.agents ?? []) {
      if (a.session?.epicId && a.session.langfuseTraceUrl) {
        map.set(a.session.epicId, a.session.langfuseTraceUrl);
      }
    }
    return map;
  }, [fleetAgentStatus?.agents]);

  const handlePipelineAction = useCallback(
    (payload: PipelineActionPayload) => {
      // Look up current labels from issue data for label-aware actions
      const epic = allIssues.find((i) => i.id === payload.epicId);
      setPendingEpicId(payload.epicId);
      pipelineAction.mutate(
        {
          ...payload,
          currentLabels: epic?.labels ?? [],
        },
        {
          onSettled: () => setPendingEpicId(null),
        },
      );
    },
    [allIssues, pipelineAction],
  );

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between mb-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold text-white">App Fleet</h1>
            {/* Header attention badge — hidden when zero items need review.
                Count derives from the same useAttentionItems computation as
                the card banners (factory-core-509.8). */}
            <AttentionBadge count={attention.totalCount} />
          </div>
          <p className="text-sm text-gray-400 mt-0.5">
            Fleet voyage — apps tracked as ships through build stages
          </p>
        </div>
        {data && (
          <div className="text-right">
            <span className="text-sm text-gray-400">
              {epicCount} app{epicCount !== 1 ? "s" : ""}
            </span>
            {totalFleetCost > 0 && (
              <div className="text-xs font-mono text-amber-400">
                Fleet total: ${totalFleetCost.toFixed(2)}
              </div>
            )}
          </div>
        )}
      </div>

      {/* factory-core-lfcf.5: reconciler status card. Status-only — no
          actions. Shows reconciler health + recent self-healing actions.
          Per zero-human-touchpoints directive, the reconciler is meant
          to be invisible; this card is the minimum-acceptable view of
          its liveness so Jane can glance and confirm it's running. */}
      <div className="mb-3">
        <ReconcilerStatusCard />
      </div>

      {/* Agent status banners — factory-core-d5b.7: one per running agent.
          Previously single-session rendering hid all but the first under
          z9h.3 parallel builders and ppx concurrent epics. */}
      {(fleetAgentStatus?.agents ?? [])
        .filter((a) => a.running && a.session)
        .map((a) => (
          <AgentStatusBanner
            key={a.session!.tmuxSessionName ?? `${a.session!.repoName}-${a.session!.startedAt}`}
            session={a.session!}
            recentLog={a.recentLog}
            onStop={() => stopAgent.mutate({ repoPath: a.session!.repoPath })}
            isStopping={stopAgent.isPending}
          />
        ))}

      {error && (
        <ErrorState
          message="Failed to load issues"
          detail={error instanceof Error ? error.message : String(error)}
          onRetry={() => refetch()}
        />
      )}

      {isLoading && (
        <div className="flex gap-2 overflow-x-auto flex-1 pb-4">
          {Array.from({ length: 9 }).map((_, col) => (
            <div
              key={col}
              className="min-w-[180px] max-w-[220px] flex-shrink-0 space-y-1.5"
            >
              <div className="h-8 w-32 animate-pulse bg-surface-2 rounded mb-3" />
              {Array.from({ length: 2 }).map((_, row) => (
                <CardSkeleton key={row} />
              ))}
            </div>
          ))}
        </div>
      )}

      {data && (
        <FleetBoard
          issues={allIssues}
          epicCosts={epicCosts}
          onPipelineAction={handlePipelineAction}
          agentRunning={(fleetAgentStatus?.totalRunning ?? 0) > 0}
          pendingEpicId={pendingEpicId}
          langfuseTraceUrls={langfuseTraceUrls}
          attentionByEpic={attention.countByEpic}
        />
      )}

      {/* Link to dedicated activity page */}
      <div className="mt-4 text-right">
        <Link
          href="/activity"
          className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
        >
          View agent activity &rarr;
        </Link>
      </div>

      {data && epicCount === 0 && (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center max-w-md">
            <div className="w-12 h-12 rounded-full bg-surface-2 flex items-center justify-center mx-auto mb-3">
              <svg
                className="w-6 h-6 text-gray-500"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z"
                />
              </svg>
            </div>
            <h3 className="text-sm font-medium text-gray-300 mb-1">
              No ships in the fleet
            </h3>
            <p className="text-xs text-gray-500">
              Create an epic to launch a ship through the fleet voyage.
              Add pipeline:* labels to move ships through stages.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
