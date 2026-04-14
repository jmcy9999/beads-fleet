"use client";

import { FLEET_STAGE_CONFIG, type FleetStage } from "./fleet-utils";

interface HelpSidebarProps {
  open: boolean;
  onClose: () => void;
}

interface StageInfo {
  stage: FleetStage;
  description: string;
  actions: string[];
}

const IOS_PIPELINE: StageInfo[] = [
  {
    stage: "idea",
    description: "New app concepts waiting to be evaluated.",
    actions: ["Start research", "Skip to plan", "Abandon (bad idea)"],
  },
  {
    stage: "research",
    description: "Agent runs market research, competitor analysis, and feasibility checks.",
    actions: ["Wait for agent", "Deprioritise"],
  },
  {
    stage: "research-complete",
    description: "Research report is ready for review. Decide whether to proceed.",
    actions: ["Run PM", "Request more research", "Deprioritise"],
  },
  {
    stage: "product-spec",
    description: "PM agent reads research and produces a functional specification with MVP scope decisions and per-feature acceptance criteria. Review the spec before proceeding to architecture.",
    actions: ["Run Architect", "Revise spec", "Deprioritise"],
  },
  {
    stage: "architecture",
    description: "Architect agent reads the functional spec and designs the system structure — layers, data model, component boundaries, and technology choices. Review the architecture before generating the build plan.",
    actions: ["Generate plan", "Revise architecture", "Deprioritise"],
  },
  {
    stage: "plan-review",
    description: "Implementation plan is ready. Review features, architecture, and scope.",
    actions: ["Approve plan", "Approve & build", "Revise plan"],
  },
  {
    stage: "development",
    description: "Agent is building the app based on the approved plan.",
    actions: ["Wait for agent", "Send for QA"],
  },
  {
    stage: "qa",
    description: "Quality assurance — testing, bug fixes, and polish.",
    actions: ["Fix & retest", "Mark ready to deploy"],
  },
  {
    stage: "submission-prep",
    description: "Preparing App Store assets, screenshots, and metadata.",
    actions: ["Approve submission"],
  },
  {
    stage: "submitted",
    description: "Submitted to App Store. Waiting for review.",
    actions: ["Mark as live", "Send back to dev"],
  },
  {
    stage: "kit-management",
    description: "Post-launch maintenance, updates, and CycleKit integration.",
    actions: ["Revise plan", "Mark completed"],
  },
];

const VENTURE_PIPELINE: StageInfo[] = [
  {
    stage: "idea",
    description: "New venture concepts waiting to be evaluated.",
    actions: ["Start research", "Skip to plan", "Abandon"],
  },
  {
    stage: "research",
    description: "Agent researches market opportunity, monetisation, and feasibility.",
    actions: ["Wait for agent", "Deprioritise"],
  },
  {
    stage: "research-complete",
    description: "Research report ready for review.",
    actions: ["Generate plan", "Request more research", "Deprioritise"],
  },
  {
    stage: "plan-review",
    description: "Review the venture plan, revenue model, and milestones.",
    actions: ["Approve plan", "Approve & build", "Revise plan"],
  },
  {
    stage: "development",
    description: "Agent is building the venture.",
    actions: ["Wait for agent", "Mark deploying"],
  },
  {
    stage: "deploying",
    description: "Deploying infrastructure and going live.",
    actions: ["Mark venture live"],
  },
  {
    stage: "live",
    description: "Venture is live and generating revenue.",
    actions: ["Mark venture complete"],
  },
];

function FlowDiagram({ stages }: { stages: StageInfo[] }) {
  return (
    <div className="flex flex-col items-center gap-0.5 my-2">
      {stages.map((info, i) => {
        const cfg = FLEET_STAGE_CONFIG[info.stage];
        return (
          <div key={info.stage} className="flex flex-col items-center">
            <div
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border-default bg-surface-2 w-full`}
            >
              <span className={`w-2 h-2 rounded-full shrink-0 ${cfg.dotColor}`} />
              <span className={`text-xs font-medium ${cfg.color}`}>{cfg.label}</span>
            </div>
            {i < stages.length - 1 && (
              <svg className="w-3 h-4 text-gray-600" viewBox="0 0 12 16" fill="none">
                <path d="M6 0v12M3 9l3 3 3-3" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </div>
        );
      })}
    </div>
  );
}

function StageDetails({ stages }: { stages: StageInfo[] }) {
  return (
    <div className="space-y-3">
      {stages.map((info) => {
        const cfg = FLEET_STAGE_CONFIG[info.stage];
        return (
          <div key={info.stage}>
            <div className="flex items-center gap-1.5 mb-1">
              <span className={`w-2 h-2 rounded-full shrink-0 ${cfg.dotColor}`} />
              <span className={`text-xs font-semibold ${cfg.color}`}>{cfg.label}</span>
            </div>
            <p className="text-[11px] text-gray-400 leading-relaxed mb-1">{info.description}</p>
            <div className="flex flex-wrap gap-1">
              {info.actions.map((action) => (
                <span
                  key={action}
                  className="text-[10px] px-1.5 py-0.5 rounded bg-surface-2 text-gray-500 border border-border-default"
                >
                  {action}
                </span>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function HelpSidebar({ open, onClose }: HelpSidebarProps) {
  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/30 z-40" onClick={onClose} />

      {/* Panel */}
      <div className="fixed right-0 top-0 bottom-0 w-80 bg-surface-1 border-l border-border-default z-50 flex flex-col animate-slide-in-right overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-default shrink-0">
          <h2 className="text-sm font-semibold text-gray-200">Fleet Board Guide</h2>
          <button
            onClick={onClose}
            className="p-1 rounded-md text-gray-400 hover:text-gray-200 hover:bg-surface-2 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
          {/* Intro */}
          <p className="text-xs text-gray-400 leading-relaxed">
            The fleet board tracks apps and ventures through a pipeline from idea to completion.
            Each card is an epic that moves through stages. Stages can be skipped when appropriate.
          </p>

          {/* iOS pipeline */}
          <details open>
            <summary className="text-xs font-semibold text-gray-300 cursor-pointer select-none hover:text-gray-100 transition-colors">
              iOS App Pipeline
            </summary>
            <div className="mt-2">
              <FlowDiagram stages={IOS_PIPELINE} />
              <div className="mt-3">
                <StageDetails stages={IOS_PIPELINE} />
              </div>
            </div>
          </details>

          {/* Venture pipeline */}
          <details>
            <summary className="text-xs font-semibold text-gray-300 cursor-pointer select-none hover:text-gray-100 transition-colors">
              Venture Pipeline
            </summary>
            <div className="mt-2">
              <FlowDiagram stages={VENTURE_PIPELINE} />
              <div className="mt-3">
                <StageDetails stages={VENTURE_PIPELINE} />
              </div>
            </div>
          </details>

          {/* Tips */}
          <details>
            <summary className="text-xs font-semibold text-gray-300 cursor-pointer select-none hover:text-gray-100 transition-colors">
              Tips
            </summary>
            <ul className="mt-2 space-y-1.5 text-[11px] text-gray-400 leading-relaxed list-disc list-inside">
              <li>Use the ship-type toggle (All / iOS / Venture) to filter the board.</li>
              <li>Use the column filter to hide stages you don&apos;t need.</li>
              <li>Zoom in/out for dense boards — your preference is saved.</li>
              <li>Click action buttons on cards to promote, skip, or reassign apps.</li>
              <li>Cards show progress bars, cost breakdowns, and agent status.</li>
              <li>The &ldquo;Abandoned&rdquo; column collects ideas that didn&apos;t pan out.</li>
            </ul>
          </details>
        </div>
      </div>
    </>
  );
}
