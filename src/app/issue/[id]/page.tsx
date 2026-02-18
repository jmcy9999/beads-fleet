"use client";

import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useState, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useIssueDetail } from "@/hooks/useIssueDetail";
import { useIssues } from "@/hooks/useIssues";
import { useTokenUsage, useTokenUsageSummary } from "@/hooks/useTokenUsage";
import { useResearchReport } from "@/hooks/useResearchReport";
import { usePlanReport } from "@/hooks/usePlanReport";
import { useComments, useAddComment } from "@/hooks/useComments";
import { useIssueAction } from "@/hooks/useIssueAction";
import { usePipelineAction } from "@/hooks/usePipelineAction";
import type { PipelineActionType } from "@/hooks/usePipelineAction";
import { buildFleetApps, computeEpicCosts } from "@/components/fleet/fleet-utils";
import { ActivityTimeline } from "@/components/fleet/ActivityTimeline";
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

import { extractAppName } from "@/lib/extract-app-name";

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

function IssueActionButtons({ issueId, status, labels }: { issueId: string; status: IssueStatus; labels?: string[] }) {
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
          {/* Factory research workflow buttons */}
          {isResearch && (
            <div className="space-y-2 pb-2 mb-2 border-b border-border-default">
              <button
                onClick={handleApprove}
                disabled={mutation.isPending}
                className="w-full rounded-md bg-green-600 px-3 py-2 text-sm font-medium text-white hover:bg-green-500 disabled:opacity-50 transition-colors"
              >
                {mutation.isPending ? "Approving..." : "Approve & Send to Development"}
              </button>
              {!showFeedbackInput ? (
                <button
                  onClick={() => setShowFeedbackInput(true)}
                  disabled={mutation.isPending}
                  className="w-full rounded-md bg-surface-2 px-3 py-2 text-sm font-medium text-gray-300 hover:text-white hover:bg-surface-3 border border-border-default disabled:opacity-50 transition-colors"
                >
                  Request More Research
                </button>
              ) : (
                <div className="space-y-2">
                  <textarea
                    value={feedbackText}
                    onChange={(e) => setFeedbackText(e.target.value)}
                    placeholder="What additional research is needed?"
                    rows={3}
                    className="w-full rounded-md border border-border-default bg-surface-2 px-3 py-1.5 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none"
                    onKeyDown={(e) => { if (e.key === "Escape") { setShowFeedbackInput(false); setFeedbackText(""); } }}
                    autoFocus
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={handleRequestMoreResearch}
                      disabled={mutation.isPending || !feedbackText.trim()}
                      className="flex-1 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
                    >
                      {mutation.isPending ? "Sending..." : "Send Feedback"}
                    </button>
                    <button
                      onClick={() => { setShowFeedbackInput(false); setFeedbackText(""); }}
                      className="rounded-md bg-surface-2 px-3 py-1.5 text-sm text-gray-400 hover:text-gray-200 transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Standard close button */}
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
// Pipeline stage detection (from epic labels)
// ---------------------------------------------------------------------------

type PipelineStage =
  | "idea"
  | "research"
  | "research-complete"
  | "plan-review"
  | "development"
  | "qa"
  | "submission-prep"
  | "submitted"
  | "kit-management"
  | "completed"
  | "bad-idea";

function detectPipelineStage(labels: string[]): PipelineStage {
  if (labels.includes("pipeline:bad-idea")) return "bad-idea";
  if (labels.includes("pipeline:completed")) return "completed";
  if (labels.includes("pipeline:kit-management")) return "kit-management";
  if (labels.includes("pipeline:submitted")) return "submitted";
  if (labels.includes("pipeline:submission-prep")) return "submission-prep";
  if (labels.includes("pipeline:qa")) return "qa";
  if (labels.includes("pipeline:development")) return "development";
  if (labels.includes("pipeline:research-complete")) {
    if (labels.includes("plan:pending") || labels.includes("plan:approved")) {
      return "plan-review";
    }
    return "research-complete";
  }
  if (labels.includes("pipeline:research")) return "research";
  return "idea";
}

// ---------------------------------------------------------------------------
// Pipeline action buttons (for epics with pipeline:* labels)
// ---------------------------------------------------------------------------

function PipelineActionButtons({
  epicId,
  labels,
}: {
  epicId: string;
  labels: string[];
}) {
  const mutation = usePipelineAction();
  const [feedbackText, setFeedbackText] = useState("");
  const [showFeedback, setShowFeedback] = useState<"more-research" | "send-back" | "revise-plan" | "revise-plan-from-launch" | null>(null);

  const stage = detectPipelineStage(labels);
  const hasAgentRunning = labels.includes("agent:running");

  const handleAction = (action: PipelineActionType, feedback?: string) => {
    mutation.mutate(
      { epicId, action, feedback },
      {
        onSuccess: () => {
          setShowFeedback(null);
          setFeedbackText("");
        },
      },
    );
  };

  const renderFeedbackArea = (
    action: PipelineActionType,
    placeholder: string,
    buttonLabel: string,
  ) => (
    <div className="space-y-2">
      <textarea
        value={feedbackText}
        onChange={(e) => setFeedbackText(e.target.value)}
        placeholder={placeholder}
        rows={3}
        className="w-full rounded-md border border-border-default bg-surface-2 px-3 py-1.5 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setShowFeedback(null);
            setFeedbackText("");
          }
        }}
        autoFocus
      />
      <div className="flex gap-2">
        <button
          onClick={() => handleAction(action, feedbackText.trim() || undefined)}
          disabled={mutation.isPending}
          className="flex-1 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
        >
          {mutation.isPending ? "Sending..." : buttonLabel}
        </button>
        <button
          onClick={() => {
            setShowFeedback(null);
            setFeedbackText("");
          }}
          className="rounded-md bg-surface-2 px-3 py-1.5 text-sm text-gray-400 hover:text-gray-200 transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );

  return (
    <div className="space-y-2">
      {/* Ideas stage: Start Research + Skip to Plan */}
      {stage === "idea" && (
        <div className="space-y-2">
          <button
            onClick={() => handleAction("start-research")}
            disabled={mutation.isPending}
            className="w-full rounded-md bg-green-600 px-3 py-2 text-sm font-medium text-white hover:bg-green-500 disabled:opacity-50 transition-colors"
          >
            {mutation.isPending ? "Starting..." : "Start Research"}
          </button>
          <button
            onClick={() => handleAction("skip-to-plan")}
            disabled={mutation.isPending}
            className="w-full rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
          >
            {mutation.isPending ? "Starting..." : "Skip to Plan"}
          </button>
        </div>
      )}

      {/* In Research: Stop Agent (only if agent is running) */}
      {stage === "research" && hasAgentRunning && (
        <button
          onClick={() => handleAction("stop-agent")}
          disabled={mutation.isPending}
          className="w-full rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-50 transition-colors"
        >
          {mutation.isPending ? "Stopping..." : "Stop Agent"}
        </button>
      )}

      {/* Research Complete: review recon, generate plan, or request more research */}
      {stage === "research-complete" && (
        <div className="space-y-2">
          <button
            onClick={() => handleAction("generate-plan")}
            disabled={mutation.isPending}
            className="w-full rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
          >
            {mutation.isPending ? "Generating..." : "Generate Plan"}
          </button>

          {showFeedback !== "more-research" ? (
            <button
              onClick={() => setShowFeedback("more-research")}
              disabled={mutation.isPending}
              className="w-full rounded-md bg-surface-2 px-3 py-2 text-sm font-medium text-gray-300 hover:text-white hover:bg-surface-3 border border-border-default disabled:opacity-50 transition-colors"
            >
              More Research
            </button>
          ) : (
            renderFeedbackArea(
              "more-research",
              "What additional research is needed?",
              "Send Feedback & Re-run Research",
            )
          )}

          <button
            onClick={() => handleAction("deprioritise")}
            disabled={mutation.isPending}
            className="w-full rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-50 transition-colors"
          >
            {mutation.isPending ? "Deprioritising..." : "Deprioritise"}
          </button>
        </div>
      )}

      {/* Plan Review: approve & build, or revise the plan */}
      {stage === "plan-review" && (() => {
        const hasPlanApproved = labels.includes("plan:approved");

        if (hasPlanApproved) {
          return (
            <div className="space-y-2">
              <button
                onClick={() => handleAction("send-for-development")}
                disabled={mutation.isPending}
                className="w-full rounded-md bg-green-600 px-3 py-2 text-sm font-medium text-white hover:bg-green-500 disabled:opacity-50 transition-colors"
              >
                {mutation.isPending ? "Launching..." : "Begin Construction"}
              </button>

              {showFeedback !== "revise-plan" ? (
                <button
                  onClick={() => setShowFeedback("revise-plan")}
                  disabled={mutation.isPending}
                  className="w-full rounded-md bg-surface-2 px-3 py-2 text-sm font-medium text-gray-300 hover:text-white hover:bg-surface-3 border border-border-default disabled:opacity-50 transition-colors"
                >
                  Revise Plan
                </button>
              ) : (
                renderFeedbackArea(
                  "revise-plan",
                  "What changes are needed to the plan?",
                  "Send Feedback & Revise Plan",
                )
              )}
            </div>
          );
        }

        // plan:pending — awaiting review
        return (
          <div className="space-y-2">
            <button
              onClick={() => handleAction("approve-and-build")}
              disabled={mutation.isPending}
              className="w-full rounded-md bg-green-600 px-3 py-2 text-sm font-medium text-white hover:bg-green-500 disabled:opacity-50 transition-colors"
            >
              {mutation.isPending ? "Approving & Launching..." : "Approve & Build"}
            </button>

            {showFeedback !== "revise-plan" ? (
              <button
                onClick={() => setShowFeedback("revise-plan")}
                disabled={mutation.isPending}
                className="w-full rounded-md bg-surface-2 px-3 py-2 text-sm font-medium text-gray-300 hover:text-white hover:bg-surface-3 border border-border-default disabled:opacity-50 transition-colors"
              >
                Revise Plan
              </button>
            ) : (
              renderFeedbackArea(
                "revise-plan",
                "What changes are needed to the plan?",
                "Send Feedback & Revise Plan",
              )
            )}

            <button
              onClick={() => handleAction("deprioritise")}
              disabled={mutation.isPending}
              className="w-full rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-50 transition-colors"
            >
              {mutation.isPending ? "Deprioritising..." : "Deprioritise"}
            </button>
          </div>
        );
      })()}

      {/* In Development: Stop Agent (only if agent is running) */}
      {stage === "development" && hasAgentRunning && (
        <button
          onClick={() => handleAction("stop-agent")}
          disabled={mutation.isPending}
          className="w-full rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-50 transition-colors"
        >
          {mutation.isPending ? "Stopping..." : "Stop Agent"}
        </button>
      )}

      {/* QA: Run QA, Skip to Submission, Send Back to Dev */}
      {stage === "qa" && (() => {
        const qaRoundLabel = labels.find((l) => l.startsWith("qa:round-"));
        const qaRound = qaRoundLabel ? parseInt(qaRoundLabel.replace("qa:round-", ""), 10) : null;

        return (
          <div className="space-y-2">
            {qaRound != null && !isNaN(qaRound) && (
              <span className="inline-flex items-center rounded-full bg-green-500/20 text-green-300 px-2.5 py-0.5 text-xs font-medium">
                QA Round {qaRound}
              </span>
            )}

            {hasAgentRunning ? (
              <button
                onClick={() => handleAction("stop-agent")}
                disabled={mutation.isPending}
                className="w-full rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-50 transition-colors"
              >
                {mutation.isPending ? "Stopping..." : "Stop QA Agent"}
              </button>
            ) : (
              <>
                <button
                  onClick={() => handleAction("send-for-qa")}
                  disabled={mutation.isPending}
                  className="w-full rounded-md bg-green-600 px-3 py-2 text-sm font-medium text-white hover:bg-green-500 disabled:opacity-50 transition-colors"
                >
                  {mutation.isPending ? "Starting..." : "Run QA"}
                </button>
                <button
                  onClick={() => handleAction("approve-submission")}
                  disabled={mutation.isPending}
                  className="w-full rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
                >
                  {mutation.isPending ? "Advancing..." : "Skip to Submission"}
                </button>

                {showFeedback !== "send-back" ? (
                  <button
                    onClick={() => setShowFeedback("send-back")}
                    disabled={mutation.isPending}
                    className="w-full rounded-md bg-surface-2 px-3 py-2 text-sm font-medium text-gray-300 hover:text-white hover:bg-surface-3 border border-border-default disabled:opacity-50 transition-colors"
                  >
                    Send Back to Dev
                  </button>
                ) : (
                  renderFeedbackArea(
                    "send-back-to-dev",
                    "What needs to be fixed?",
                    "Send Feedback & Return to Dev",
                  )
                )}
              </>
            )}
          </div>
        );
      })()}

      {/* Submission Prep: Approve Submission, Send back to Development, Revise Plan */}
      {stage === "submission-prep" && (
        <div className="space-y-2">
          <button
            onClick={() => handleAction("approve-submission")}
            disabled={mutation.isPending}
            className="w-full rounded-md bg-green-600 px-3 py-2 text-sm font-medium text-white hover:bg-green-500 disabled:opacity-50 transition-colors"
          >
            {mutation.isPending ? "Approving..." : "Approve Submission"}
          </button>

          {showFeedback !== "send-back" ? (
            <button
              onClick={() => setShowFeedback("send-back")}
              disabled={mutation.isPending}
              className="w-full rounded-md bg-surface-2 px-3 py-2 text-sm font-medium text-gray-300 hover:text-white hover:bg-surface-3 border border-border-default disabled:opacity-50 transition-colors"
            >
              Send back to Development
            </button>
          ) : (
            renderFeedbackArea(
              "send-back-to-development",
              "What needs to be fixed or changed?",
              "Send Feedback & Restart Development",
            )
          )}

          {showFeedback !== "revise-plan-from-launch" ? (
            <button
              onClick={() => setShowFeedback("revise-plan-from-launch")}
              disabled={mutation.isPending}
              className="w-full rounded-md bg-surface-2 px-3 py-2 text-sm font-medium text-gray-300 hover:text-white hover:bg-surface-3 border border-border-default disabled:opacity-50 transition-colors"
            >
              Revise Plan
            </button>
          ) : (
            renderFeedbackArea(
              "revise-plan-from-launch",
              "What needs to change in the plan?",
              "Send Feedback & Revise Plan",
            )
          )}
        </div>
      )}

      {/* Submitted: Mark as Live */}
      {stage === "submitted" && (
        <button
          onClick={() => handleAction("mark-as-live")}
          disabled={mutation.isPending}
          className="w-full rounded-md bg-green-600 px-3 py-2 text-sm font-medium text-white hover:bg-green-500 disabled:opacity-50 transition-colors"
        >
          {mutation.isPending ? "Marking..." : "Mark as Live"}
        </button>
      )}

      {/* Kit Management: Stop Agent (only if agent is running) */}
      {stage === "kit-management" && hasAgentRunning && (
        <button
          onClick={() => handleAction("stop-agent")}
          disabled={mutation.isPending}
          className="w-full rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-50 transition-colors"
        >
          {mutation.isPending ? "Stopping..." : "Stop Agent"}
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
  const { data: tokenSummary } = useTokenUsageSummary();
  const { data: comments } = useComments(issueId);
  const addComment = useAddComment();
  const [commentText, setCommentText] = useState("");

  // Use plan_issue for graph data (blocked_by, blocks), raw_issue for detail fields
  const planIssue = data?.plan_issue ?? null;
  const rawIssue = data?.raw_issue ?? null;

  // The primary display issue merges both sources
  const issue = planIssue;

  // Research report — derive app name from epic title
  // Show the research report for: (a) issues with the legacy "research" label,
  // or (b) epics at any pipeline stage from research onward (where a report exists).
  const researchAppName = useMemo(() => {
    if (!issue) return null;
    const issueLabels = rawIssue?.labels ?? issue.labels ?? [];
    const hasLegacyResearch = issueLabels.includes("research");
    const hasPipelineResearch = issueLabels.some(
      (l) =>
        l === "pipeline:research" ||
        l === "pipeline:research-complete" ||
        l === "pipeline:development" ||
        l === "pipeline:qa" ||
        l === "pipeline:submission-prep" ||
        l === "pipeline:submitted" ||
        l === "pipeline:kit-management" ||
        l === "pipeline:completed",
    );
    if (!hasLegacyResearch && !hasPipelineResearch) return null;
    // If this issue has an epic, use the epic title to derive app name
    if (issue.epic_title) return extractAppName(issue.epic_title);
    // If this IS an epic with research label, use its own title
    if (issue.issue_type === "epic") return extractAppName(issue.title);
    return null;
  }, [issue, rawIssue]);
  const { data: researchReport } = useResearchReport(researchAppName);

  // Fetch plan if one exists (API returns 404 gracefully for issues without plans)
  const { data: planReport } = usePlanReport(issueId);

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

  // --- Epic cost (for epic-type issues, aggregate cost of self + children) ---
  const epicCost = issue.issue_type === "epic" && tokenSummary?.byIssue
    ? (() => {
        const apps = buildFleetApps(allIssues).filter((a) => a.epic.id === issue.id);
        if (apps.length === 0) return null;
        const costs = computeEpicCosts(apps, tokenSummary.byIssue);
        return costs.get(issue.id) ?? null;
      })()
    : null;

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

          {/* Notes (research reports, etc.) */}
          {rawIssue?.notes && (
            <section className="card p-5">
              <h2 className="text-xs font-medium uppercase tracking-wider text-gray-500 mb-3">
                Notes
              </h2>
              <p className="text-sm text-gray-300 whitespace-pre-wrap leading-relaxed">
                {rawIssue.notes}
              </p>
            </section>
          )}

          {/* Research Report (markdown from factory repo) */}
          {researchReport?.content && (
            <section className="card p-5">
              <h2 className="text-xs font-medium uppercase tracking-wider text-gray-500 mb-3">
                Research Report
              </h2>
              <div className="prose prose-invert prose-sm max-w-none
                prose-headings:text-gray-200 prose-headings:font-semibold
                prose-h1:text-lg prose-h2:text-base prose-h3:text-sm
                prose-p:text-gray-300 prose-p:leading-relaxed
                prose-a:text-blue-400 prose-a:no-underline hover:prose-a:underline
                prose-strong:text-gray-200
                prose-code:text-amber-300 prose-code:bg-surface-2 prose-code:rounded prose-code:px-1
                prose-pre:bg-surface-0 prose-pre:border prose-pre:border-border-default
                prose-table:text-sm
                prose-th:text-gray-400 prose-th:border-border-default
                prose-td:border-border-default
                prose-li:text-gray-300
                prose-blockquote:border-blue-500/50 prose-blockquote:text-gray-400
                prose-hr:border-border-default">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {researchReport.content}
                </ReactMarkdown>
              </div>
            </section>
          )}

          {/* Plan (markdown from .beads/plans/) */}
          {planReport?.content && (
            <section className="card p-5">
              <details open>
                <summary className="text-xs font-medium uppercase tracking-wider text-purple-400 mb-3 cursor-pointer select-none list-none flex items-center gap-1.5 [&::-webkit-details-marker]:hidden">
                  <svg className="w-3 h-3 transition-transform [[open]>summary>&]:rotate-90" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                  Plan
                </summary>
                <div className="prose prose-invert prose-sm max-w-none
                  prose-headings:text-gray-200 prose-headings:font-semibold
                  prose-h1:text-lg prose-h2:text-base prose-h3:text-sm
                  prose-p:text-gray-300 prose-p:leading-relaxed
                  prose-a:text-blue-400 prose-a:no-underline hover:prose-a:underline
                  prose-strong:text-gray-200
                  prose-code:text-amber-300 prose-code:bg-surface-2 prose-code:rounded prose-code:px-1
                  prose-pre:bg-surface-0 prose-pre:border prose-pre:border-border-default
                  prose-table:text-sm
                  prose-th:text-gray-400 prose-th:border-border-default
                  prose-td:border-border-default
                  prose-li:text-gray-300
                  prose-blockquote:border-purple-500/50 prose-blockquote:text-gray-400
                  prose-hr:border-border-default">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {planReport.content}
                  </ReactMarkdown>
                </div>
              </details>
            </section>
          )}

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
            {epicChildren.length > 0 && (() => {
              const closedCount = epicChildren.filter((c) => c.status === "closed").length;
              const pct = Math.round((closedCount / epicChildren.length) * 100);
              return (
                <div>
                  <div className="flex items-center gap-3 mb-2">
                    <h3 className="text-xs font-medium uppercase tracking-wider text-gray-500">
                      Children ({closedCount}/{epicChildren.length} — {pct}%)
                    </h3>
                    <div className="flex-1 max-w-[200px] h-2 bg-surface-2 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-green-500 to-emerald-400 rounded-full"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                  <ul className="space-y-1.5">
                    {epicChildren.map((dep) => (
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
                  </ul>
                </div>
              );
            })()}
          </section>

          {/* Comments */}
          <section className="card p-5">
            <h2 className="text-xs font-medium uppercase tracking-wider text-gray-500 mb-3">
              Comments
              {comments && comments.length > 0 && (
                <span className="ml-1.5 text-gray-600">({comments.length})</span>
              )}
            </h2>

            {comments && comments.length > 0 ? (
              <div className="space-y-3 mb-4">
                {comments.map((c) => (
                  <div key={c.id} className="border-l-2 border-border-default pl-3">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-xs font-medium text-gray-300">{c.author}</span>
                      <span className="text-xs text-gray-500">
                        {formatTimestamp(c.created_at)}
                      </span>
                    </div>
                    <p className="text-sm text-gray-300 whitespace-pre-wrap">{c.text}</p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-gray-500 italic mb-4">No comments yet</p>
            )}

            <div className="space-y-2">
              <textarea
                value={commentText}
                onChange={(e) => setCommentText(e.target.value)}
                placeholder="Add a comment..."
                rows={2}
                className="w-full rounded-md border border-border-default bg-surface-2 px-3 py-1.5 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && commentText.trim()) {
                    addComment.mutate(
                      { issueId: issue.id, text: commentText.trim() },
                      { onSuccess: () => setCommentText("") },
                    );
                  }
                }}
              />
              <div className="flex items-center justify-between">
                <span className="text-xs text-gray-500">
                  {typeof navigator !== "undefined" && navigator.platform?.includes("Mac") ? "Cmd" : "Ctrl"}+Enter to submit
                </span>
                <button
                  onClick={() => {
                    if (!commentText.trim()) return;
                    addComment.mutate(
                      { issueId: issue.id, text: commentText.trim() },
                      { onSuccess: () => setCommentText("") },
                    );
                  }}
                  disabled={addComment.isPending || !commentText.trim()}
                  className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
                >
                  {addComment.isPending ? "Posting..." : "Comment"}
                </button>
              </div>
              {addComment.isError && (
                <p className="text-xs text-red-400">{addComment.error.message}</p>
              )}
            </div>
          </section>

          {/* Epic Cost Breakdown (for epics with token data) */}
          {epicCost && epicCost.totalCost > 0 && (
            <section className="card p-5">
              <h2 className="text-xs font-medium uppercase tracking-wider text-gray-500 mb-3">
                App Cost
              </h2>
              <div className="grid grid-cols-2 gap-4 mb-3">
                <div>
                  <p className="text-xs text-gray-500">Total Cost</p>
                  <p className="text-lg font-bold text-amber-400">
                    ${epicCost.totalCost.toFixed(2)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">Sessions</p>
                  <p className="text-lg font-bold text-white">
                    {epicCost.totalSessions}
                  </p>
                </div>
              </div>
              {epicCost.phases.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs text-gray-500">By Phase</p>
                  {epicCost.phases.map((p) => {
                    const phasePct = epicCost.totalCost > 0
                      ? Math.round((p.cost / epicCost.totalCost) * 100)
                      : 0;
                    const phaseColors: Record<string, string> = {
                      research: "from-blue-500 to-blue-400",
                      development: "from-amber-500 to-amber-400",
                      submission: "from-purple-500 to-purple-400",
                      other: "from-gray-500 to-gray-400",
                    };
                    const phaseTextColors: Record<string, string> = {
                      research: "text-blue-400",
                      development: "text-amber-400",
                      submission: "text-purple-400",
                      other: "text-gray-400",
                    };
                    return (
                      <div key={p.phase}>
                        <div className="flex items-center justify-between mb-0.5">
                          <span className={`text-xs font-medium capitalize ${phaseTextColors[p.phase] ?? "text-gray-400"}`}>
                            {p.phase}
                          </span>
                          <span className="text-xs font-mono text-gray-400">
                            ${p.cost.toFixed(2)} ({phasePct}%)
                          </span>
                        </div>
                        <div className="h-1.5 bg-surface-2 rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full bg-gradient-to-r ${phaseColors[p.phase] ?? "from-gray-500 to-gray-400"}`}
                            style={{ width: `${phasePct}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          )}

          {/* Agent Activity Timeline */}
          {tokenRecords && tokenRecords.length > 0 && (
            <section className="card p-5">
              <h2 className="text-xs font-medium uppercase tracking-wider text-gray-500 mb-3">
                Agent Activity
              </h2>
              <ActivityTimeline
                records={tokenRecords}
                issueMap={Object.fromEntries(allIssues.map((i) => [i.id, i]))}
                showIssueLinks={false}
                initialDays={7}
              />
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

            {/* Action Buttons — pipeline buttons for epics, legacy buttons otherwise */}
            {issue.issue_type === "epic" || labels.some((l) => l.startsWith("pipeline:")) ? (
              <PipelineActionButtons epicId={issue.id} labels={labels} />
            ) : (
              <IssueActionButtons issueId={issue.id} status={issue.status} labels={labels} />
            )}

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
