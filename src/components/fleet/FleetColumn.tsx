import { FleetCard } from "./FleetCard";
import {
  FLEET_STAGE_CONFIG,
  type FleetApp,
  type FleetStage,
  type EpicCost,
} from "./fleet-utils";
import type { PipelineActionPayload } from "./FleetBoard";

interface FleetColumnProps {
  stage: FleetStage;
  apps: FleetApp[];
  epicCosts?: Map<string, EpicCost>;
  onPipelineAction?: (payload: PipelineActionPayload) => void;
  agentRunning?: boolean;
  pendingEpicId?: string | null;
}

export function FleetColumn({ stage, apps, epicCosts, onPipelineAction, agentRunning, pendingEpicId }: FleetColumnProps) {
  const config = FLEET_STAGE_CONFIG[stage];

  return (
    <div className="min-w-[180px] max-w-[220px] flex-shrink-0 flex flex-col h-full">
      {/* Column header */}
      <div className="flex items-center gap-1.5 px-2 py-1.5 mb-2">
        <span
          className={`h-2 w-2 rounded-full ${config.dotColor}`}
          aria-hidden="true"
        />
        <h2 className={`text-xs font-medium ${config.color} truncate uppercase tracking-wide`}>
          {config.label}
        </h2>
        <span className="ml-auto rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-gray-400">
          {apps.length}
        </span>
      </div>

      {/* Card list */}
      <div className="flex-1 overflow-y-auto space-y-1.5 px-0.5">
        {apps.length === 0 ? (
          <p className="text-center text-sm text-gray-500 py-8">No apps</p>
        ) : (
          apps.map((app) => (
            <FleetCard
              key={app.epic.id}
              app={app}
              cost={epicCosts?.get(app.epic.id)}
              onPipelineAction={onPipelineAction}
              agentRunning={agentRunning}
              pendingEpicId={pendingEpicId}
            />
          ))
        )}
      </div>
    </div>
  );
}
