"use client";

import { useState } from "react";
import Link from "next/link";
import { PriorityIndicator } from "@/components/ui/PriorityIndicator";
import { StatusBadge } from "@/components/ui/StatusBadge";
import {
  isAgentRunning,
  getPhaseHistory,
  FLEET_STAGE_CONFIG,
  type FleetApp,
  type EpicCost,
} from "./fleet-utils";
import type { PipelineActionPayload } from "./FleetBoard";

/** Inline spinner shown on buttons while a pipeline action is in flight. */
function Spinner() {
  return (
    <svg
      className="animate-spin -ml-0.5 mr-1.5 h-3 w-3 inline-block"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

interface FleetCardProps {
  app: FleetApp;
  cost?: EpicCost;
  onPipelineAction?: (payload: PipelineActionPayload) => void;
  agentRunning?: boolean;
  pendingEpicId?: string | null;
}

const PHASE_COLORS: Record<string, string> = {
  research: "text-blue-400",
  development: "text-amber-400",
  submission: "text-purple-400",
  "kit-management": "text-indigo-400",
  other: "text-gray-400",
};

/** Shared style for primary action buttons on fleet cards. */
const BTN_PRIMARY =
  "w-full px-3 py-1.5 text-xs font-medium rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed";

/** Blue action button (launch/forward). */
const BTN_BLUE = `${BTN_PRIMARY} text-blue-400 hover:text-blue-300 bg-blue-500/10 hover:bg-blue-500/20 border border-blue-500/30`;

/** Amber action button (alternative). */
const BTN_AMBER = `${BTN_PRIMARY} text-amber-400 hover:text-amber-300 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30`;

/** Red action button (destructive/deprioritise). */
const BTN_RED = `${BTN_PRIMARY} text-red-400 hover:text-red-300 bg-red-500/10 hover:bg-red-500/20 border border-red-500/30`;

/** Green action button (approve/complete). */
const BTN_GREEN = `${BTN_PRIMARY} text-green-400 hover:text-green-300 bg-green-500/10 hover:bg-green-500/20 border border-green-500/30`;

export function FleetCard({ app, cost, onPipelineAction, agentRunning, pendingEpicId }: FleetCardProps) {
  const { epic, children, progress } = app;
  const pct =
    progress.total > 0
      ? Math.round((progress.closed / progress.total) * 100)
      : 0;

  const inProgress = children.filter(
    (c) => c.status === "in_progress",
  ).length;
  const blocked = children.filter((c) => c.status === "blocked").length;

  // Extract app name from epic title
  const appName = epic.title;

  // Check if this epic has an agent currently running
  const epicAgentRunning = isAgentRunning(epic);

  // Check for submission labels on the epic itself
  const submissionLabels = (epic.labels ?? []).filter((l) => l.startsWith("submission:"));
  // Also check children for legacy compatibility
  const childSubmissionLabels = children.flatMap(
    (c) => c.labels?.filter((l) => l.startsWith("submission:")) ?? [],
  );
  const allSubmissionLabels = [...submissionLabels, ...childSubmissionLabels];
  const uniqueSubmissionStates = [...new Set(allSubmissionLabels.map((l) => l.slice(11)))];

  const submissionStyles: Record<string, string> = {
    ready: "bg-blue-500/20 text-blue-300",
    "in-review": "bg-amber-500/20 text-amber-300",
    approved: "bg-green-500/20 text-green-300",
    rejected: "bg-red-500/20 text-red-300",
  };

  const [feedbackAction, setFeedbackAction] = useState<PipelineActionPayload["action"] | null>(null);
  const [feedbackText, setFeedbackText] = useState("");

  /** Dispatch a pipeline action, preventing the Link navigation. */
  function handleAction(
    e: React.MouseEvent,
    action: PipelineActionPayload["action"],
  ) {
    e.preventDefault();
    e.stopPropagation();
    onPipelineAction?.({ epicId: epic.id, epicTitle: epic.title, action });
  }

  /** Open the inline feedback textarea for actions that need comments. */
  function handleFeedbackAction(e: React.MouseEvent, action: PipelineActionPayload["action"]) {
    e.preventDefault();
    e.stopPropagation();
    setFeedbackAction(action);
    setFeedbackText("");
  }

  /** Submit the feedback-based action. */
  function submitFeedback(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (feedbackAction) {
      onPipelineAction?.({ epicId: epic.id, epicTitle: epic.title, action: feedbackAction, feedback: feedbackText });
      setFeedbackAction(null);
      setFeedbackText("");
    }
  }

  /** Whether any agent is running globally (disables launch buttons). */
  const anyAgentRunning = agentRunning ?? false;

  /** Whether this specific card's action is currently being submitted. */
  const isPendingThis = pendingEpicId === epic.id;

  /** Returns the appropriate label for an action button, accounting for pending/running states. */
  function actionLabel(defaultLabel: string): string {
    if (isPendingThis) return "Launching\u2026";
    if (anyAgentRunning) return "Agent Running\u2026";
    return defaultLabel;
  }

  return (
    <Link
      href={`/issue/${epic.id}`}
      className="card-hover p-2 cursor-pointer block"
    >
      {/* Header: ID + Priority + Agent indicator */}
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-[10px] text-gray-400">{epic.id}</span>
          {epicAgentRunning && (
            <span className="relative flex h-2.5 w-2.5" title="Agent running">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-amber-500" />
            </span>
          )}
        </div>
        <PriorityIndicator priority={epic.priority} />
      </div>

      {/* App name */}
      <h3 className="text-xs font-medium mb-1.5 line-clamp-2">{appName}</h3>

      {/* Progress bar */}
      {progress.total > 0 && (
        <div className="mb-2 flex items-center gap-1.5">
          <div className="flex-1 h-1.5 bg-surface-2 rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-green-500 to-emerald-400 rounded-full"
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className="text-[10px] text-gray-500">
            {progress.closed}/{progress.total}
          </span>
        </div>
      )}

      {/* Submission badges */}
      {uniqueSubmissionStates.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-2">
          {uniqueSubmissionStates.map((state) => (
            <span
              key={state}
              className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${submissionStyles[state] ?? "bg-surface-2 text-gray-300"}`}
            >
              {state}
            </span>
          ))}
        </div>
      )}

      {/* Cost breakdown */}
      {cost && cost.totalCost > 0 && (
        <div className="mb-2 py-1.5 border-t border-border-default">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] uppercase text-gray-500 font-medium">Cost</span>
            <span className="text-xs font-mono text-amber-400">
              ${cost.totalCost.toFixed(2)}
            </span>
          </div>
          {cost.phases.length > 1 && (
            <div className="flex flex-wrap gap-x-3 gap-y-0.5">
              {cost.phases.map((p) => (
                <span key={p.phase} className="text-[10px]">
                  <span className={PHASE_COLORS[p.phase] ?? "text-gray-400"}>
                    {p.phase}
                  </span>
                  <span className="text-gray-500 font-mono ml-0.5">
                    ${p.cost.toFixed(2)}
                  </span>
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Footer: status + stats */}
      <div className="flex items-center justify-between">
        <StatusBadge status={epic.status} />
        <div className="flex items-center gap-2 text-xs text-gray-400">
          {blocked > 0 && (
            <span className="text-status-blocked font-medium">
              {blocked} blocked
            </span>
          )}
          {inProgress > 0 && (
            <span className="text-status-progress">
              {inProgress} active
            </span>
          )}
          {epic.owner && <span>{epic.owner}</span>}
        </div>
      </div>

      {/* ---- Phase history indicator ---- */}
      <div className="mt-2 pt-2 border-t border-border-default flex items-center gap-1">
        {getPhaseHistory(app.stage).map(({ stage, status }) => {
          const cfg = FLEET_STAGE_CONFIG[stage];
          return (
            <span
              key={stage}
              title={cfg.label}
              className="relative flex items-center justify-center"
            >
              {status === "current" ? (
                /* Current stage: filled dot with a pulsing ring */
                <span className="relative flex h-2.5 w-2.5">
                  <span
                    className={`animate-ping absolute inline-flex h-full w-full rounded-full ${cfg.dotColor} opacity-40`}
                  />
                  <span
                    className={`relative inline-flex rounded-full h-2.5 w-2.5 ${cfg.dotColor}`}
                  />
                </span>
              ) : status === "past" ? (
                /* Past stage: solid filled dot */
                <span className={`inline-flex rounded-full h-2 w-2 ${cfg.dotColor}`} />
              ) : (
                /* Future stage: hollow/dimmed dot */
                <span className={`inline-flex rounded-full h-2 w-2 ${cfg.dotColor} opacity-20`} />
              )}
            </span>
          );
        })}
      </div>

      {/* ---- Stage-specific action buttons ---- */}
      {onPipelineAction && (
        <div className="mt-2 flex flex-col gap-1.5">
          {/* Ideas: Start Research + Skip to Plan */}
          {app.stage === "idea" && (
            <>
              <button
                onClick={(e) => handleAction(e, "start-research")}
                disabled={anyAgentRunning || isPendingThis}
                className={BTN_BLUE}
              >
                {isPendingThis && <Spinner />}
                {actionLabel("Start Research")}
              </button>
              <button
                onClick={(e) => handleAction(e, "skip-to-plan")}
                disabled={anyAgentRunning || isPendingThis}
                className={BTN_GREEN}
              >
                {isPendingThis && <Spinner />}
                {actionLabel("Skip to Plan")}
              </button>
            </>
          )}

          {/* In Research / In Development / Kit Management (with agent): Stop Agent */}
          {(app.stage === "research" || app.stage === "development" || app.stage === "kit-management") &&
            epicAgentRunning && (
              <button
                onClick={(e) => handleAction(e, "stop-agent")}
                disabled={isPendingThis}
                className={BTN_RED}
              >
                {isPendingThis && <Spinner />}
                {isPendingThis ? "Stopping\u2026" : "Stop Agent"}
              </button>
            )}

          {/* Research Complete: review recon, generate plan, or request more research */}
          {app.stage === "research-complete" && (
            <>
              <button
                onClick={(e) => handleAction(e, "generate-plan")}
                disabled={anyAgentRunning || isPendingThis}
                className={BTN_BLUE}
              >
                {isPendingThis && <Spinner />}
                {actionLabel("Generate Plan")}
              </button>
              <button
                onClick={(e) => handleFeedbackAction(e, "more-research")}
                disabled={anyAgentRunning || isPendingThis}
                className={BTN_AMBER}
              >
                {isPendingThis && <Spinner />}
                {actionLabel("More Research")}
              </button>
              <button
                onClick={(e) => handleAction(e, "deprioritise")}
                disabled={anyAgentRunning || isPendingThis}
                className={BTN_RED}
              >
                Abandon
              </button>
            </>
          )}

          {/* Plan Review: approve & build, or revise the plan */}
          {app.stage === "plan-review" && (() => {
            const hasPlanApproved = (epic.labels ?? []).includes("plan:approved");

            if (hasPlanApproved) {
              return (
                <>
                  <button
                    onClick={(e) => handleAction(e, "send-for-development")}
                    disabled={anyAgentRunning || isPendingThis}
                    className={BTN_GREEN}
                  >
                    {isPendingThis && <Spinner />}
                    {actionLabel("Begin Construction")}
                  </button>
                  <button
                    onClick={(e) => handleFeedbackAction(e, "revise-plan")}
                    disabled={anyAgentRunning || isPendingThis}
                    className={BTN_AMBER}
                  >
                    {isPendingThis && <Spinner />}
                    {actionLabel("Revise Plan")}
                  </button>
                </>
              );
            }

            // plan:pending — awaiting review
            return (
              <>
                <button
                  onClick={(e) => handleAction(e, "approve-and-build")}
                  disabled={anyAgentRunning || isPendingThis}
                  className={BTN_GREEN}
                >
                  {isPendingThis && <Spinner />}
                  {actionLabel("Approve & Build")}
                </button>
                <button
                  onClick={(e) => handleFeedbackAction(e, "revise-plan")}
                  disabled={anyAgentRunning || isPendingThis}
                  className={BTN_AMBER}
                >
                  {isPendingThis && <Spinner />}
                  {actionLabel("Revise Plan")}
                </button>
                <button
                  onClick={(e) => handleAction(e, "deprioritise")}
                  disabled={anyAgentRunning || isPendingThis}
                  className={BTN_RED}
                >
                  Abandon
                </button>
              </>
            );
          })()}

          {/* QA: Run QA, Skip to Submission, Send Back to Dev */}
          {app.stage === "qa" && (() => {
            // Extract QA round number from labels like qa:round-2
            const qaRoundLabel = (epic.labels ?? []).find((l) => l.startsWith("qa:round-"));
            const qaRound = qaRoundLabel ? parseInt(qaRoundLabel.replace("qa:round-", ""), 10) : null;

            return (
              <>
                {qaRound != null && !isNaN(qaRound) && (
                  <span className="inline-flex items-center rounded-full bg-green-500/20 text-green-300 px-2 py-0.5 text-[10px] font-medium self-start">
                    QA Round {qaRound}
                  </span>
                )}
                {epicAgentRunning ? (
                  <button disabled className={BTN_GREEN}>
                    QA in progress...
                  </button>
                ) : (
                  <>
                    <button
                      onClick={(e) => handleAction(e, "send-for-qa")}
                      disabled={anyAgentRunning || isPendingThis}
                      className={BTN_GREEN}
                    >
                      {isPendingThis && <Spinner />}
                      {actionLabel("Run QA")}
                    </button>
                    <button
                      onClick={(e) => handleAction(e, "approve-submission")}
                      disabled={anyAgentRunning || isPendingThis}
                      className={BTN_BLUE}
                    >
                      {isPendingThis && <Spinner />}
                      {actionLabel("Skip to Submission")}
                    </button>
                    <button
                      onClick={(e) => handleFeedbackAction(e, "send-back-to-dev")}
                      disabled={anyAgentRunning || isPendingThis}
                      className={BTN_AMBER}
                    >
                      {isPendingThis && <Spinner />}
                      {actionLabel("Send Back to Dev")}
                    </button>
                  </>
                )}
              </>
            );
          })()}

          {/* Prepare for Submission: three options */}
          {app.stage === "submission-prep" && (
            <>
              <button
                onClick={(e) => handleAction(e, "approve-submission")}
                disabled={anyAgentRunning || isPendingThis}
                className={BTN_GREEN}
              >
                {isPendingThis && <Spinner />}
                {actionLabel("Launch")}
              </button>
              <button
                onClick={(e) => handleFeedbackAction(e, "send-back-to-dev")}
                disabled={anyAgentRunning || isPendingThis}
                className={BTN_AMBER}
              >
                {isPendingThis && <Spinner />}
                {actionLabel("Send Back")}
              </button>
              <button
                onClick={(e) => handleFeedbackAction(e, "revise-plan-from-launch")}
                disabled={anyAgentRunning || isPendingThis}
                className={BTN_AMBER}
              >
                {isPendingThis && <Spinner />}
                {actionLabel("Revise Plan")}
              </button>
            </>
          )}

          {/* Submitted: Mark as Live */}
          {app.stage === "submitted" && (
            <button
              onClick={(e) => handleAction(e, "mark-as-live")}
              disabled={anyAgentRunning || isPendingThis}
              className={BTN_GREEN}
            >
              {isPendingThis && <Spinner />}
              {actionLabel("Mark Deployed")}
            </button>
          )}

          {/* Abandon: available at every stage except bad-idea and completed */}
          {app.stage !== "bad-idea" && app.stage !== "completed" &&
            /* Skip stages that already have a Deprioritise button */
            app.stage !== "research-complete" && app.stage !== "plan-review" && (
            <button
              onClick={(e) => handleAction(e, "deprioritise")}
              disabled={anyAgentRunning || isPendingThis}
              className={BTN_RED}
            >
              Abandon
            </button>
          )}

          {/* Inline feedback textarea (shown when a feedback action is selected) */}
          {feedbackAction && (
            <div className="mt-1.5 space-y-1.5" onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}>
              <textarea
                value={feedbackText}
                onChange={(e) => setFeedbackText(e.target.value)}
                placeholder={
                  feedbackAction === "revise-plan" || feedbackAction === "revise-plan-from-launch"
                    ? "What needs changing in the plan?"
                    : feedbackAction === "more-research"
                      ? "What areas need more research?"
                      : "Feedback for the agent..."
                }
                rows={3}
                autoFocus
                className="w-full rounded-md border border-border-default bg-surface-2 px-2 py-1.5 text-xs text-gray-200 placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-amber-500 resize-none"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    submitFeedback(e as unknown as React.MouseEvent);
                  }
                  if (e.key === "Escape") {
                    setFeedbackAction(null);
                    setFeedbackText("");
                  }
                }}
              />
              <div className="flex gap-1.5">
                <button
                  onClick={submitFeedback}
                  disabled={isPendingThis}
                  className={`flex-1 ${BTN_AMBER}`}
                >
                  {isPendingThis && <Spinner />}
                  {isPendingThis ? "Sending\u2026" : "Send"}
                </button>
                <button
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); setFeedbackAction(null); setFeedbackText(""); }}
                  disabled={isPendingThis}
                  className={`${BTN_PRIMARY} text-gray-400 hover:text-gray-300 bg-surface-2 hover:bg-surface-3 border border-border-default`}
                >
                  Cancel
                </button>
              </div>
              <p className="text-[10px] text-gray-600">
                {typeof navigator !== "undefined" && navigator.platform?.includes("Mac") ? "Cmd" : "Ctrl"}+Enter to send, Esc to cancel
              </p>
            </div>
          )}
        </div>
      )}
    </Link>
  );
}
