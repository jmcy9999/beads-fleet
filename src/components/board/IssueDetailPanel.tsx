"use client";

import { useEffect, useState } from "react";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { PriorityIndicator } from "@/components/ui/PriorityIndicator";
import { IssueTypeIcon } from "@/components/ui/IssueTypeIcon";
import { useIssueAction } from "@/hooks/useIssueAction";
import type { IssueStatus, PlanIssue } from "@/lib/types";

interface IssueDetailPanelProps {
  issue: PlanIssue;
  allIssues: PlanIssue[];
  onClose: () => void;
}

function CompactActionButtons({ issueId, status, labels }: { issueId: string; status: IssueStatus; labels?: string[] }) {
  const mutation = useIssueAction();
  const [closeReason, setCloseReason] = useState("");
  const [showCloseInput, setShowCloseInput] = useState(false);
  const [feedbackText, setFeedbackText] = useState("");
  const [showFeedbackInput, setShowFeedbackInput] = useState(false);

  const isResearch = labels?.includes("research") ?? false;

  const handleStart = () => mutation.mutate({ issueId, action: "start" });
  const handleReopen = () => mutation.mutate({ issueId, action: "reopen" });
  const handleClose = () => {
    mutation.mutate(
      { issueId, action: "close", reason: closeReason || undefined },
      { onSuccess: () => { setShowCloseInput(false); setCloseReason(""); } },
    );
  };
  const handleApprove = () => {
    mutation.mutate(
      { issueId, action: "close", reason: "Research approved. Ready for development." },
    );
  };
  const handleRequestMoreResearch = () => {
    if (!feedbackText.trim()) return;
    mutation.mutate(
      { issueId, action: "comment", reason: feedbackText.trim() },
      { onSuccess: () => { setShowFeedbackInput(false); setFeedbackText(""); } },
    );
  };

  return (
    <div className="space-y-2">
      <div className="flex gap-2 flex-wrap">
        {status === "open" && (
          <button
            onClick={handleStart}
            disabled={mutation.isPending}
            className="rounded-md bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-500 disabled:opacity-50 transition-colors"
          >
            {mutation.isPending ? "Starting..." : "Start Work"}
          </button>
        )}
        {(status === "in_progress" || status === "blocked" || status === "deferred") && (
          <>
            {/* Factory research workflow buttons */}
            {isResearch && (
              <>
                <button
                  onClick={handleApprove}
                  disabled={mutation.isPending}
                  className="rounded-md bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-500 disabled:opacity-50 transition-colors"
                >
                  {mutation.isPending ? "Approving..." : "Approve"}
                </button>
                <button
                  onClick={() => setShowFeedbackInput(!showFeedbackInput)}
                  disabled={mutation.isPending}
                  className="rounded-md bg-surface-2 px-3 py-1.5 text-xs font-medium text-gray-300 hover:text-white hover:bg-surface-3 border border-border-default disabled:opacity-50 transition-colors"
                >
                  More Research
                </button>
              </>
            )}
            <button
              onClick={() => showCloseInput ? handleClose() : setShowCloseInput(true)}
              disabled={mutation.isPending}
              className="rounded-md bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-500 disabled:opacity-50 transition-colors"
            >
              {mutation.isPending ? "Closing..." : showCloseInput ? "Confirm" : "Close"}
            </button>
          </>
        )}
        {status === "closed" && (
          <button
            onClick={handleReopen}
            disabled={mutation.isPending}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
          >
            {mutation.isPending ? "Reopening..." : "Reopen"}
          </button>
        )}
      </div>
      {/* Feedback input for "Request More Research" */}
      {showFeedbackInput && isResearch && (status === "in_progress" || status === "blocked" || status === "deferred") && (
        <div className="space-y-2">
          <textarea
            value={feedbackText}
            onChange={(e) => setFeedbackText(e.target.value)}
            placeholder="What additional research is needed?"
            rows={2}
            className="w-full rounded-md border border-border-default bg-surface-2 px-2 py-1 text-xs text-gray-200 placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none"
            onKeyDown={(e) => { if (e.key === "Escape") { setShowFeedbackInput(false); setFeedbackText(""); } }}
            autoFocus
          />
          <div className="flex gap-2">
            <button
              onClick={handleRequestMoreResearch}
              disabled={mutation.isPending || !feedbackText.trim()}
              className="flex-1 rounded-md bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
            >
              {mutation.isPending ? "Sending..." : "Send"}
            </button>
            <button
              onClick={() => { setShowFeedbackInput(false); setFeedbackText(""); }}
              className="text-xs text-gray-500 hover:text-gray-300"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {showCloseInput && (status === "in_progress" || status === "blocked" || status === "deferred") && (
        <div className="flex gap-2">
          <input
            type="text"
            value={closeReason}
            onChange={(e) => setCloseReason(e.target.value)}
            placeholder="Reason (optional)"
            className="flex-1 rounded-md border border-border-default bg-surface-2 px-2 py-1 text-xs text-gray-200 placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-green-500"
            onKeyDown={(e) => { if (e.key === "Enter") handleClose(); if (e.key === "Escape") setShowCloseInput(false); }}
            autoFocus
          />
          <button
            onClick={() => { setShowCloseInput(false); setCloseReason(""); }}
            className="text-xs text-gray-500 hover:text-gray-300"
          >
            Cancel
          </button>
        </div>
      )}
      {mutation.isError && (
        <p className="text-xs text-red-400">{mutation.error.message}</p>
      )}
    </div>
  );
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

          {/* Action Buttons */}
          <CompactActionButtons issueId={issue.id} status={issue.status} labels={issue.labels} />

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

          {/* Epic Progress */}
          {issue.issue_type === "epic" && (() => {
            const children = allIssues.filter((i) => i.epic === issue.id);
            if (children.length === 0) return null;
            const closedCount = children.filter((i) => i.status === "closed").length;
            const pct = Math.round((closedCount / children.length) * 100);
            return (
              <div>
                <h3 className="text-xs font-medium uppercase text-gray-500 mb-1">
                  Progress ({closedCount}/{children.length})
                </h3>
                <div className="flex items-center gap-2">
                  <div className="flex-1 h-2 rounded-full bg-surface-2 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-green-500 to-emerald-400"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="text-xs font-medium text-gray-300">
                    {pct}%
                  </span>
                </div>
              </div>
            );
          })()}

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
