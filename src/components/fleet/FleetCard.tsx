"use client";

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

interface FleetCardProps {
  app: FleetApp;
  cost?: EpicCost;
  onPipelineAction?: (payload: PipelineActionPayload) => void;
  agentRunning?: boolean;
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

export function FleetCard({ app, cost, onPipelineAction, agentRunning }: FleetCardProps) {
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

  /** Dispatch a pipeline action, preventing the Link navigation. */
  function handleAction(
    e: React.MouseEvent,
    action: PipelineActionPayload["action"],
  ) {
    e.preventDefault();
    e.stopPropagation();
    onPipelineAction?.({ epicId: epic.id, epicTitle: epic.title, action });
  }

  /** Whether any agent is running globally (disables launch buttons). */
  const anyAgentRunning = agentRunning ?? false;

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
                disabled={anyAgentRunning}
                className={BTN_BLUE}
              >
                {anyAgentRunning ? "Agent Running..." : "Start Research"}
              </button>
              <button
                onClick={(e) => handleAction(e, "skip-to-plan")}
                disabled={anyAgentRunning}
                className={BTN_GREEN}
              >
                {anyAgentRunning ? "Agent Running..." : "Skip to Plan"}
              </button>
            </>
          )}

          {/* In Research / In Development / Kit Management (with agent): Stop Agent */}
          {(app.stage === "research" || app.stage === "development" || app.stage === "kit-management") &&
            epicAgentRunning && (
              <button
                onClick={(e) => handleAction(e, "stop-agent")}
                className={BTN_RED}
              >
                Stop Agent
              </button>
            )}

          {/* Research Complete: buttons depend on plan sub-labels */}
          {app.stage === "research-complete" && (() => {
            const epicLabels = epic.labels ?? [];
            const hasPlanPending = epicLabels.includes("plan:pending");
            const hasPlanApproved = epicLabels.includes("plan:approved");

            // plan:approved -> ready to build
            if (hasPlanApproved) {
              return (
                <>
                  <button
                    onClick={(e) => handleAction(e, "send-for-development")}
                    disabled={anyAgentRunning}
                    className={BTN_GREEN}
                  >
                    {anyAgentRunning ? "Agent Running..." : "Start Building"}
                  </button>
                  <button
                    onClick={(e) => handleAction(e, "revise-plan")}
                    disabled={anyAgentRunning}
                    className={BTN_AMBER}
                  >
                    {anyAgentRunning ? "Agent Running..." : "Revise Plan"}
                  </button>
                  <button
                    onClick={(e) => handleAction(e, "deprioritise")}
                    disabled={anyAgentRunning}
                    className={BTN_RED}
                  >
                    Abandon
                  </button>
                </>
              );
            }

            // plan:pending -> plan generated, awaiting review
            if (hasPlanPending) {
              return (
                <>
                  <button
                    onClick={(e) => handleAction(e, "approve-plan")}
                    disabled={anyAgentRunning}
                    className={BTN_GREEN}
                  >
                    {anyAgentRunning ? "Agent Running..." : "Approve Plan"}
                  </button>
                  <button
                    onClick={(e) => handleAction(e, "revise-plan")}
                    disabled={anyAgentRunning}
                    className={BTN_AMBER}
                  >
                    {anyAgentRunning ? "Agent Running..." : "Revise Plan"}
                  </button>
                  <button
                    onClick={(e) => handleAction(e, "deprioritise")}
                    disabled={anyAgentRunning}
                    className={BTN_RED}
                  >
                    Abandon
                  </button>
                </>
              );
            }

            // No plan label -> initial research review
            return (
              <>
                <button
                  onClick={(e) => handleAction(e, "generate-plan")}
                  disabled={anyAgentRunning}
                  className={BTN_BLUE}
                >
                  {anyAgentRunning ? "Agent Running..." : "Generate Plan"}
                </button>
                <button
                  onClick={(e) => handleAction(e, "more-research")}
                  disabled={anyAgentRunning}
                  className={BTN_AMBER}
                >
                  {anyAgentRunning ? "Agent Running..." : "More Research"}
                </button>
                <button
                  onClick={(e) => handleAction(e, "deprioritise")}
                  disabled={anyAgentRunning}
                  className={BTN_RED}
                >
                  Abandon
                </button>
              </>
            );
          })()}

          {/* Prepare for Submission: three options */}
          {app.stage === "submission-prep" && (
            <>
              <button
                onClick={(e) => handleAction(e, "approve-submission")}
                disabled={anyAgentRunning}
                className={BTN_GREEN}
              >
                {anyAgentRunning ? "Agent Running..." : "Launch"}
              </button>
              <button
                onClick={(e) => handleAction(e, "send-back-to-dev")}
                disabled={anyAgentRunning}
                className={BTN_AMBER}
              >
                {anyAgentRunning ? "Agent Running..." : "Send Back"}
              </button>
              <button
                onClick={(e) => handleAction(e, "revise-plan-from-launch")}
                disabled={anyAgentRunning}
                className={BTN_AMBER}
              >
                {anyAgentRunning ? "Agent Running..." : "Revise Plan"}
              </button>
            </>
          )}

          {/* Submitted: Mark as Live */}
          {app.stage === "submitted" && (
            <button
              onClick={(e) => handleAction(e, "mark-as-live")}
              disabled={anyAgentRunning}
              className={BTN_GREEN}
            >
              {anyAgentRunning ? "Agent Running..." : "Mark Deployed"}
            </button>
          )}
        </div>
      )}
    </Link>
  );
}
