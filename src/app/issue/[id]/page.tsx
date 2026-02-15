"use client";

import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useState } from "react";
import { useIssueDetail } from "@/hooks/useIssueDetail";
import { useIssues } from "@/hooks/useIssues";
import { useTokenUsage } from "@/hooks/useTokenUsage";
import { useIssueAction } from "@/hooks/useIssueAction";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { PriorityIndicator } from "@/components/ui/PriorityIndicator";
import { IssueTypeIcon } from "@/components/ui/IssueTypeIcon";
import { ErrorState } from "@/components/ui/ErrorState";
import type { IssueStatus, PlanIssue } from "@/lib/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveIssues(ids: string[], allIssues: PlanIssue[]): PlanIssue[] {
  return ids
    .map((id) => allIssues.find((i) => i.id === id))
    .filter((i): i is PlanIssue => i !== undefined);
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ---------------------------------------------------------------------------
// Skeleton loader
// ---------------------------------------------------------------------------

function DetailSkeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      {/* Back button placeholder */}
      <div className="h-5 w-16 rounded bg-surface-2" />

      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="h-6 w-6 rounded bg-surface-2" />
        <div className="h-4 w-20 rounded bg-surface-2" />
        <div className="h-6 w-64 rounded bg-surface-2" />
      </div>

      {/* Two column layout */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Main */}
        <div className="lg:col-span-2 space-y-6">
          <div className="card p-5 space-y-3">
            <div className="h-4 w-24 rounded bg-surface-2" />
            <div className="h-4 w-full rounded bg-surface-2" />
            <div className="h-4 w-3/4 rounded bg-surface-2" />
            <div className="h-4 w-5/6 rounded bg-surface-2" />
          </div>
          <div className="card p-5 space-y-3">
            <div className="h-4 w-32 rounded bg-surface-2" />
            <div className="h-4 w-48 rounded bg-surface-2" />
            <div className="h-4 w-48 rounded bg-surface-2" />
          </div>
        </div>
        {/* Sidebar */}
        <div className="space-y-4">
          <div className="card p-5 space-y-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="space-y-1">
                <div className="h-3 w-16 rounded bg-surface-2" />
                <div className="h-5 w-24 rounded bg-surface-2" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dependency list sub-component
// ---------------------------------------------------------------------------

function DependencyList({
  label,
  resolvedIssues,
  unresolvedIds,
}: {
  label: string;
  resolvedIssues: PlanIssue[];
  unresolvedIds: string[];
}) {
  if (resolvedIssues.length === 0 && unresolvedIds.length === 0) {
    return (
      <div>
        <h3 className="text-xs font-medium uppercase tracking-wider text-gray-500 mb-2">
          {label}
        </h3>
        <p className="text-sm text-gray-500">None</p>
      </div>
    );
  }

  return (
    <div>
      <h3 className="text-xs font-medium uppercase tracking-wider text-gray-500 mb-2">
        {label}
      </h3>
      <ul className="space-y-1.5">
        {resolvedIssues.map((dep) => (
          <li key={dep.id} className="flex items-center gap-2 text-sm">
            <Link
              href={`/issue/${dep.id}`}
              className="font-mono text-xs text-blue-400 hover:text-blue-300 hover:underline shrink-0"
            >
              {dep.id}
            </Link>
            <span className="text-gray-300 truncate">{dep.title}</span>
            <StatusBadge status={dep.status} size="sm" />
          </li>
        ))}
        {unresolvedIds.map((id) => (
          <li key={id} className="flex items-center gap-2 text-sm">
            <Link
              href={`/issue/${id}`}
              className="font-mono text-xs text-blue-400 hover:text-blue-300 hover:underline"
            >
              {id}
            </Link>
            <span className="text-gray-500 italic">unknown issue</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Action buttons
// ---------------------------------------------------------------------------

function IssueActionButtons({ issueId, status }: { issueId: string; status: IssueStatus }) {
  const mutation = useIssueAction();
  const [closeReason, setCloseReason] = useState("");
  const [showCloseInput, setShowCloseInput] = useState(false);

  const handleStart = () => mutation.mutate({ issueId, action: "start" });
  const handleReopen = () => mutation.mutate({ issueId, action: "reopen" });
  const handleClose = () => {
    mutation.mutate(
      { issueId, action: "close", reason: closeReason || undefined },
      { onSuccess: () => { setShowCloseInput(false); setCloseReason(""); } },
    );
  };

  return (
    <div className="space-y-2">
      {status === "open" && (
        <button
          onClick={handleStart}
          disabled={mutation.isPending}
          className="w-full rounded-md bg-amber-600 px-3 py-2 text-sm font-medium text-white hover:bg-amber-500 disabled:opacity-50 transition-colors"
        >
          {mutation.isPending ? "Starting..." : "Start Work"}
        </button>
      )}

      {(status === "in_progress" || status === "blocked" || status === "deferred") && (
        <>
          {!showCloseInput ? (
            <button
              onClick={() => setShowCloseInput(true)}
              disabled={mutation.isPending}
              className="w-full rounded-md bg-green-600 px-3 py-2 text-sm font-medium text-white hover:bg-green-500 disabled:opacity-50 transition-colors"
            >
              Close
            </button>
          ) : (
            <div className="space-y-2">
              <input
                type="text"
                value={closeReason}
                onChange={(e) => setCloseReason(e.target.value)}
                placeholder="Close reason (optional)"
                className="w-full rounded-md border border-border-default bg-surface-2 px-3 py-1.5 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-green-500"
                onKeyDown={(e) => { if (e.key === "Enter") handleClose(); if (e.key === "Escape") setShowCloseInput(false); }}
                autoFocus
              />
              <div className="flex gap-2">
                <button
                  onClick={handleClose}
                  disabled={mutation.isPending}
                  className="flex-1 rounded-md bg-green-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-green-500 disabled:opacity-50 transition-colors"
                >
                  {mutation.isPending ? "Closing..." : "Confirm"}
                </button>
                <button
                  onClick={() => { setShowCloseInput(false); setCloseReason(""); }}
                  className="rounded-md bg-surface-2 px-3 py-1.5 text-sm text-gray-400 hover:text-gray-200 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {status === "closed" && (
        <button
          onClick={handleReopen}
          disabled={mutation.isPending}
          className="w-full rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
        >
          {mutation.isPending ? "Reopening..." : "Reopen"}
        </button>
      )}

      {mutation.isError && (
        <p className="text-xs text-red-400">{mutation.error.message}</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export default function IssueDetailPage() {
  const params = useParams();
  const router = useRouter();
  const issueId = typeof params.id === "string" ? params.id : null;

  const {
    data,
    isLoading: detailLoading,
    error: detailError,
    refetch,
  } = useIssueDetail(issueId);

  const { data: planData } = useIssues();
  const allIssues = planData?.all_issues ?? [];
  const { data: tokenRecords } = useTokenUsage(issueId ?? undefined);

  // Use plan_issue for graph data (blocked_by, blocks), raw_issue for detail fields
  const planIssue = data?.plan_issue ?? null;
  const rawIssue = data?.raw_issue ?? null;

  // The primary display issue merges both sources
  const issue = planIssue;

  // --- Loading ---
  if (detailLoading) {
    return <DetailSkeleton />;
  }

  // --- Error ---
  if (detailError || !issue) {
    return (
      <div className="space-y-6">
        <button
          onClick={() => router.back()}
          className="inline-flex items-center gap-1 text-sm text-gray-400 hover:text-gray-200 transition-colors"
        >
          <svg
            className="w-4 h-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M15 19l-7-7 7-7"
            />
          </svg>
          Back
        </button>
        <ErrorState
          message="Issue not found"
          detail={
            detailError instanceof Error
              ? detailError.message
              : `Could not load issue ${issueId ?? "(unknown)"}`
          }
          onRetry={() => refetch()}
        />
      </div>
    );
  }

  // --- Resolve dependencies ---
  const blockedByResolved = resolveIssues(issue.blocked_by, allIssues);
  const blockedByUnresolved = issue.blocked_by.filter(
    (id) => !allIssues.some((i) => i.id === id)
  );
  const unblocksResolved = resolveIssues(issue.blocks, allIssues);
  const unblocksUnresolved = issue.blocks.filter(
    (id) => !allIssues.some((i) => i.id === id)
  );

  // --- Epic children (issues whose epic field points to this issue) ---
  const epicChildren = allIssues.filter((i) => i.epic === issue.id);

  // --- Labels ---
  const labels = rawIssue?.labels ?? issue.labels ?? [];

  return (
    <div className="space-y-6">
      {/* Back button */}
      <button
        onClick={() => router.back()}
        className="inline-flex items-center gap-1 text-sm text-gray-400 hover:text-gray-200 transition-colors"
      >
        <svg
          className="w-4 h-4"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M15 19l-7-7 7-7"
          />
        </svg>
        Back
      </button>

      {/* Header */}
      <div className="flex items-center gap-3 flex-wrap">
        <IssueTypeIcon type={issue.issue_type} showLabel />
        <span className="font-mono text-sm text-gray-400">{issue.id}</span>
        <h1 className="text-2xl font-bold text-white">{issue.title}</h1>
      </div>

      {/* Two-column layout */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* ---- Left column (main content) ---- */}
        <div className="lg:col-span-2 space-y-6">
          {/* Description */}
          <section className="card p-5">
            <h2 className="text-xs font-medium uppercase tracking-wider text-gray-500 mb-3">
              Description
            </h2>
            {rawIssue?.description ? (
              <p className="text-sm text-gray-300 whitespace-pre-wrap leading-relaxed">
                {rawIssue.description}
              </p>
            ) : (
              <p className="text-sm text-gray-500 italic">No description</p>
            )}
          </section>

          {/* Dependency Tree */}
          <section className="card p-5 space-y-5">
            <h2 className="text-xs font-medium uppercase tracking-wider text-gray-500 mb-1">
              Dependencies
            </h2>
            <DependencyList
              label="Blocked By"
              resolvedIssues={blockedByResolved}
              unresolvedIds={blockedByUnresolved}
            />
            <DependencyList
              label="Unblocks"
              resolvedIssues={unblocksResolved}
              unresolvedIds={unblocksUnresolved}
            />
            {epicChildren.length > 0 && (
              <DependencyList
                label={`Children (${epicChildren.length})`}
                resolvedIssues={epicChildren}
                unresolvedIds={[]}
              />
            )}
          </section>

          {/* Token Usage */}
          {tokenRecords && tokenRecords.length > 0 && (
            <section className="card p-5">
              <h2 className="text-xs font-medium uppercase tracking-wider text-gray-500 mb-3">
                Token Usage
              </h2>
              {/* Summary stats row */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-4">
                <div>
                  <p className="text-xs text-gray-500">Total Cost</p>
                  <p className="text-lg font-bold text-amber-400">
                    ${tokenRecords.reduce((sum, r) => sum + r.total_cost_usd, 0).toFixed(2)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">Total Tokens</p>
                  <p className="text-lg font-bold text-white">
                    {tokenRecords.reduce((sum, r) => sum + r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_creation_tokens, 0).toLocaleString()}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">Sessions</p>
                  <p className="text-lg font-bold text-white">
                    {tokenRecords.length}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">Total Turns</p>
                  <p className="text-lg font-bold text-white">
                    {tokenRecords.reduce((sum, r) => sum + r.num_turns, 0).toLocaleString()}
                  </p>
                </div>
              </div>

              {/* Session breakdown table */}
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-surface-2">
                      <th className="px-2 py-1.5 text-xs font-medium uppercase tracking-wider text-gray-500">Date</th>
                      <th className="px-2 py-1.5 text-xs font-medium uppercase tracking-wider text-gray-500">Model</th>
                      <th className="px-2 py-1.5 text-xs font-medium uppercase tracking-wider text-gray-500 text-right">Tokens</th>
                      <th className="px-2 py-1.5 text-xs font-medium uppercase tracking-wider text-gray-500 text-right">Cost</th>
                      <th className="px-2 py-1.5 text-xs font-medium uppercase tracking-wider text-gray-500 text-right">Turns</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-surface-2">
                    {tokenRecords.map((record, idx) => (
                      <tr key={idx} className="text-gray-300">
                        <td className="px-2 py-1.5 text-xs">{formatTimestamp(record.timestamp)}</td>
                        <td className="px-2 py-1.5 text-xs font-mono">{record.model}</td>
                        <td className="px-2 py-1.5 text-xs text-right font-mono">
                          {(record.input_tokens + record.output_tokens + record.cache_read_tokens + record.cache_creation_tokens).toLocaleString()}
                        </td>
                        <td className="px-2 py-1.5 text-xs text-right font-mono text-amber-400">
                          ${record.total_cost_usd.toFixed(2)}
                        </td>
                        <td className="px-2 py-1.5 text-xs text-right font-mono">{record.num_turns}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </div>

        {/* ---- Right column (sidebar) ---- */}
        <div className="space-y-4">
          <div className="card p-5 space-y-5">
            {/* Status */}
            <div>
              <h3 className="text-xs font-medium uppercase tracking-wider text-gray-500 mb-1">
                Status
              </h3>
              <StatusBadge status={issue.status} size="md" />
            </div>

            {/* Action Buttons */}
            <IssueActionButtons issueId={issue.id} status={issue.status} />

            {/* Priority */}
            <div>
              <h3 className="text-xs font-medium uppercase tracking-wider text-gray-500 mb-1">
                Priority
              </h3>
              <PriorityIndicator priority={issue.priority} showLabel />
            </div>

            {/* Owner */}
            <div>
              <h3 className="text-xs font-medium uppercase tracking-wider text-gray-500 mb-1">
                Owner
              </h3>
              <p className="text-sm text-gray-300">
                {rawIssue?.owner ?? issue.owner ?? "Unassigned"}
              </p>
            </div>

            {/* Labels */}
            <div>
              <h3 className="text-xs font-medium uppercase tracking-wider text-gray-500 mb-1">
                Labels
              </h3>
              {labels.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {labels.map((label) => (
                    <span
                      key={label}
                      className="inline-flex items-center rounded-full bg-surface-2 px-2.5 py-0.5 text-xs font-medium text-gray-300"
                    >
                      {label}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-gray-500">None</p>
              )}
            </div>

            {/* Epic */}
            {issue.epic && (
              <div>
                <h3 className="text-xs font-medium uppercase tracking-wider text-gray-500 mb-1">
                  Epic
                </h3>
                <Link
                  href={`/issue/${issue.epic}`}
                  className="text-sm text-blue-400 hover:text-blue-300 hover:underline"
                >
                  <span className="font-mono text-xs">{issue.epic}</span>
                  {issue.epic_title && (
                    <span className="ml-1.5 text-gray-300">{issue.epic_title}</span>
                  )}
                </Link>
              </div>
            )}

            {/* Impact Score */}
            {issue.impact_score != null && (
              <div>
                <h3 className="text-xs font-medium uppercase tracking-wider text-gray-500 mb-1">
                  Impact Score
                </h3>
                <div className="flex items-center gap-2">
                  <div className="flex-1 h-2 rounded-full bg-surface-2 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-blue-500 to-purple-500"
                      style={{
                        width: `${Math.min(issue.impact_score * 100, 100)}%`,
                      }}
                    />
                  </div>
                  <span className="text-xs font-medium text-gray-300">
                    {Math.round(issue.impact_score * 100)}%
                  </span>
                </div>
              </div>
            )}

            {/* Timestamps */}
            {rawIssue && (
              <>
                <div className="border-t border-border-default pt-4 space-y-3">
                  <div>
                    <h3 className="text-xs font-medium uppercase tracking-wider text-gray-500 mb-0.5">
                      Created
                    </h3>
                    <p className="text-sm text-gray-400">
                      {formatTimestamp(rawIssue.created_at)}
                    </p>
                    {rawIssue.created_by && (
                      <p className="text-xs text-gray-500">
                        by {rawIssue.created_by}
                      </p>
                    )}
                  </div>
                  <div>
                    <h3 className="text-xs font-medium uppercase tracking-wider text-gray-500 mb-0.5">
                      Updated
                    </h3>
                    <p className="text-sm text-gray-400">
                      {formatTimestamp(rawIssue.updated_at)}
                    </p>
                  </div>
                  {rawIssue.closed_at && (
                    <div>
                      <h3 className="text-xs font-medium uppercase tracking-wider text-gray-500 mb-0.5">
                        Closed
                      </h3>
                      <p className="text-sm text-gray-400">
                        {formatTimestamp(rawIssue.closed_at)}
                      </p>
                    </div>
                  )}
                </div>

                {/* Close Reason */}
                {rawIssue.close_reason && (
                  <div>
                    <h3 className="text-xs font-medium uppercase tracking-wider text-gray-500 mb-1">
                      Close Reason
                    </h3>
                    <p className="text-sm text-gray-300">
                      {rawIssue.close_reason}
                    </p>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
