"use client";

import { useMemo, useState, useCallback } from "react";
import Link from "next/link";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { PriorityIndicator } from "@/components/ui/PriorityIndicator";
import { IssueTypeIcon } from "@/components/ui/IssueTypeIcon";
import { useIssueAction } from "@/hooks/useIssueAction";
import { BulkReleaseToolbar } from "./BulkReleaseToolbar";
import { sortIssuesForRelease, getReleaseLabel } from "./types";
import type { PlanIssue } from "@/lib/types";

interface ReleaseIssueListProps {
  issues: PlanIssue[];
  releaseLabel: string | null; // null = unassigned group
  availableReleases: string[];
}

export function ReleaseIssueList({
  issues,
  releaseLabel,
  availableReleases,
}: ReleaseIssueListProps) {
  const sorted = useMemo(() => sortIssuesForRelease(issues), [issues]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [isBusy, setIsBusy] = useState(false);
  const action = useIssueAction();

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selected.size === sorted.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(sorted.map((i) => i.id)));
    }
  };

  const runBulkAction = useCallback(
    async (ops: { issueId: string; action: "label-add" | "label-rm"; reason: string }[]) => {
      setIsBusy(true);
      try {
        await Promise.all(
          ops.map((op) =>
            action.mutateAsync({ issueId: op.issueId, action: op.action, reason: op.reason })
          )
        );
        setSelected(new Set());
      } finally {
        setIsBusy(false);
      }
    },
    [action]
  );

  const handleAssign = useCallback(
    (targetLabel: string) => {
      const ops: { issueId: string; action: "label-add" | "label-rm"; reason: string }[] = [];
      for (const id of selected) {
        const issue = sorted.find((i) => i.id === id);
        if (!issue) continue;
        // Remove old release label if it has one
        const oldLabel = getReleaseLabel(issue);
        if (oldLabel && oldLabel !== targetLabel) {
          ops.push({ issueId: id, action: "label-rm", reason: oldLabel });
        }
        // Add new release label
        if (oldLabel !== targetLabel) {
          ops.push({ issueId: id, action: "label-add", reason: targetLabel });
        }
      }
      if (ops.length > 0) runBulkAction(ops);
    },
    [selected, sorted, runBulkAction]
  );

  const handleRemove = useCallback(() => {
    if (!releaseLabel) return;
    const ops = Array.from(selected).map((id) => ({
      issueId: id,
      action: "label-rm" as const,
      reason: releaseLabel,
    }));
    if (ops.length > 0) runBulkAction(ops);
  }, [selected, releaseLabel, runBulkAction]);

  // Single-row quick assign
  const handleQuickAssign = useCallback(
    async (issueId: string, targetLabel: string) => {
      setIsBusy(true);
      try {
        const issue = sorted.find((i) => i.id === issueId);
        const oldLabel = issue ? getReleaseLabel(issue) : undefined;
        if (oldLabel && oldLabel !== targetLabel) {
          await action.mutateAsync({ issueId, action: "label-rm", reason: oldLabel });
        }
        await action.mutateAsync({ issueId, action: "label-add", reason: targetLabel });
      } finally {
        setIsBusy(false);
      }
    },
    [sorted, action]
  );

  const handleQuickRemove = useCallback(
    async (issueId: string) => {
      if (!releaseLabel) return;
      setIsBusy(true);
      try {
        await action.mutateAsync({ issueId, action: "label-rm", reason: releaseLabel });
      } finally {
        setIsBusy(false);
      }
    },
    [releaseLabel, action]
  );

  const allChecked = selected.size === sorted.length && sorted.length > 0;

  return (
    <div className="mt-2 border-t border-surface-2 pt-2 space-y-2">
      <BulkReleaseToolbar
        selectedCount={selected.size}
        availableReleases={availableReleases}
        currentRelease={releaseLabel}
        onAssign={handleAssign}
        onRemove={handleRemove}
        onClear={() => setSelected(new Set())}
        isBusy={isBusy}
      />
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-gray-500 border-b border-surface-2">
            <th className="text-left px-2 py-1 w-8">
              <input
                type="checkbox"
                checked={allChecked}
                onChange={toggleAll}
                className="rounded border-gray-500 bg-surface-0 text-blue-500 focus:ring-blue-500 focus:ring-offset-0 cursor-pointer"
              />
            </th>
            <th className="text-left px-2 py-1 font-medium w-8"></th>
            <th className="text-left px-2 py-1 font-medium">Title</th>
            <th className="text-left px-2 py-1 font-medium w-24">Status</th>
            <th className="text-left px-2 py-1 font-medium w-16">Priority</th>
            <th className="text-left px-2 py-1 font-medium w-20">Type</th>
            <th className="text-right px-2 py-1 font-medium w-20"></th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((issue) => (
            <tr
              key={issue.id}
              className={`hover:bg-surface-2/50 transition-colors ${
                selected.has(issue.id) ? "bg-blue-500/5" : ""
              }`}
            >
              <td className="px-2 py-1.5">
                <input
                  type="checkbox"
                  checked={selected.has(issue.id)}
                  onChange={() => toggleSelect(issue.id)}
                  className="rounded border-gray-500 bg-surface-0 text-blue-500 focus:ring-blue-500 focus:ring-offset-0 cursor-pointer"
                />
              </td>
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
              <td className="px-2 py-1.5 text-right">
                <QuickActions
                  issueId={issue.id}
                  releaseLabel={releaseLabel}
                  availableReleases={availableReleases}
                  onAssign={handleQuickAssign}
                  onRemove={handleQuickRemove}
                  isBusy={isBusy}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Quick action buttons on each row
// ---------------------------------------------------------------------------

function QuickActions({
  issueId,
  releaseLabel,
  availableReleases,
  onAssign,
  onRemove,
  isBusy,
}: {
  issueId: string;
  releaseLabel: string | null;
  availableReleases: string[];
  onAssign: (issueId: string, label: string) => void;
  onRemove: (issueId: string) => void;
  isBusy: boolean;
}) {
  const [showPicker, setShowPicker] = useState(false);

  const targets = availableReleases.filter((r) => r !== releaseLabel);

  return (
    <div className="flex items-center gap-1 justify-end relative">
      {/* Quick move button (for unassigned or to move between releases) */}
      {targets.length > 0 && (
        <div className="relative">
          <button
            onClick={(e) => {
              e.stopPropagation();
              setShowPicker(!showPicker);
            }}
            disabled={isBusy}
            className="p-1 rounded text-gray-500 hover:text-blue-400 hover:bg-blue-500/10 disabled:opacity-50 transition-colors"
            title={releaseLabel ? "Move to another release" : "Assign to release"}
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
            </svg>
          </button>
          {showPicker && (
            <div className="absolute right-0 top-full mt-1 w-36 bg-surface-1 border border-surface-2 rounded-lg shadow-xl z-50 overflow-hidden">
              {targets.map((label) => (
                <button
                  key={label}
                  onClick={(e) => {
                    e.stopPropagation();
                    onAssign(issueId, label);
                    setShowPicker(false);
                  }}
                  className="w-full text-left px-3 py-1.5 text-xs text-gray-200 hover:bg-surface-2 transition-colors"
                >
                  v{label.replace("release:", "")}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Remove from release */}
      {releaseLabel && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemove(issueId);
          }}
          disabled={isBusy}
          className="p-1 rounded text-gray-500 hover:text-red-400 hover:bg-red-500/10 disabled:opacity-50 transition-colors"
          title="Remove from release"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      )}
    </div>
  );
}
