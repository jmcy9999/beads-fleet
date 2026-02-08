"use client";

import { useEffect } from "react";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { PriorityIndicator } from "@/components/ui/PriorityIndicator";
import { IssueTypeIcon } from "@/components/ui/IssueTypeIcon";
import type { PlanIssue } from "@/lib/types";

interface IssueDetailPanelProps {
  issue: PlanIssue;
  allIssues: PlanIssue[];
  onClose: () => void;
}

function resolveIssues(ids: string[], allIssues: PlanIssue[]): PlanIssue[] {
  return ids
    .map((id) => allIssues.find((i) => i.id === id))
    .filter((i): i is PlanIssue => i !== undefined);
}

export function IssueDetailPanel({
  issue,
  allIssues,
  onClose,
}: IssueDetailPanelProps) {
  // Close on Escape
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const blockedByIssues = resolveIssues(issue.blocked_by, allIssues);
  const unblocksIssues = resolveIssues(issue.blocks, allIssues);

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/50 z-40"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Panel */}
      <div className="fixed top-0 right-0 h-full w-full max-w-md bg-surface-1 border-l border-border-default z-50 overflow-y-auto shadow-xl animate-slide-in-right">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-default">
          <div className="flex items-center gap-2">
            <IssueTypeIcon type={issue.issue_type} />
            <span className="font-mono text-sm text-gray-400">{issue.id}</span>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-surface-2 transition-colors text-gray-400 hover:text-gray-200"
            aria-label="Close panel"
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <path d="M5 5l10 10M15 5L5 15" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="px-4 py-4 space-y-5">
          {/* Title */}
          <h2 className="text-lg font-semibold text-gray-100">{issue.title}</h2>

          {/* Status + Priority */}
          <div className="flex items-center gap-3">
            <StatusBadge status={issue.status} size="md" />
            <PriorityIndicator priority={issue.priority} showLabel />
          </div>

          {/* Owner */}
          <div>
            <h3 className="text-xs font-medium uppercase text-gray-500 mb-1">
              Owner
            </h3>
            <p className="text-sm text-gray-300">{issue.owner ?? "Unassigned"}</p>
          </div>

          {/* Labels */}
          {issue.labels && issue.labels.length > 0 && (
            <div>
              <h3 className="text-xs font-medium uppercase text-gray-500 mb-1">
                Labels
              </h3>
              <div className="flex flex-wrap gap-1.5">
                {issue.labels.map((label) => (
                  <span
                    key={label}
                    className="inline-flex items-center rounded-full bg-surface-2 px-2.5 py-0.5 text-xs font-medium text-gray-300"
                  >
                    {label}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Blocked By */}
          {issue.blocked_by.length > 0 && (
            <div>
              <h3 className="text-xs font-medium uppercase text-gray-500 mb-1">
                Blocked By
              </h3>
              <ul className="space-y-1">
                {blockedByIssues.map((dep) => (
                  <li
                    key={dep.id}
                    className="flex items-center gap-2 text-sm text-gray-300"
                  >
                    <span className="font-mono text-xs text-gray-500">
                      {dep.id}
                    </span>
                    <span className="truncate">{dep.title}</span>
                  </li>
                ))}
                {/* Show raw IDs for any that could not be resolved */}
                {issue.blocked_by
                  .filter((id) => !allIssues.some((i) => i.id === id))
                  .map((id) => (
                    <li
                      key={id}
                      className="font-mono text-xs text-gray-500"
                    >
                      {id}
                    </li>
                  ))}
              </ul>
            </div>
          )}

          {/* Unblocks */}
          {issue.blocks.length > 0 && (
            <div>
              <h3 className="text-xs font-medium uppercase text-gray-500 mb-1">
                Unblocks
              </h3>
              <ul className="space-y-1">
                {unblocksIssues.map((dep) => (
                  <li
                    key={dep.id}
                    className="flex items-center gap-2 text-sm text-gray-300"
                  >
                    <span className="font-mono text-xs text-gray-500">
                      {dep.id}
                    </span>
                    <span className="truncate">{dep.title}</span>
                  </li>
                ))}
                {issue.blocks
                  .filter((id) => !allIssues.some((i) => i.id === id))
                  .map((id) => (
                    <li
                      key={id}
                      className="font-mono text-xs text-gray-500"
                    >
                      {id}
                    </li>
                  ))}
              </ul>
            </div>
          )}

          {/* Impact Score */}
          {issue.impact_score != null && (
            <div>
              <h3 className="text-xs font-medium uppercase text-gray-500 mb-1">
                Impact Score
              </h3>
              <div className="flex items-center gap-2">
                <div className="flex-1 h-2 rounded-full bg-surface-2 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-blue-500 to-purple-500"
                    style={{ width: `${Math.min(issue.impact_score * 100, 100)}%` }}
                  />
                </div>
                <span className="text-xs font-medium text-gray-300">
                  {Math.round(issue.impact_score * 100)}%
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
