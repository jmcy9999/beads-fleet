"use client";

import type { AgentSession } from "@/lib/agent-launcher";

interface AgentStatusBannerProps {
  session: AgentSession;
  onStop: () => void;
  isStopping: boolean;
}

export function AgentStatusBanner({ session, onStop, isStopping }: AgentStatusBannerProps) {
  const elapsed = Date.now() - new Date(session.startedAt).getTime();
  const minutes = Math.floor(elapsed / 60_000);
  const hours = Math.floor(minutes / 60);
  const elapsedLabel = hours > 0
    ? `${hours}h ${minutes % 60}m`
    : `${minutes}m`;

  return (
    <div className="mb-4 rounded-lg border border-status-progress/30 bg-status-progress/5 px-4 py-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="relative flex h-3 w-3">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-3 w-3 bg-amber-500" />
          </span>
          <div>
            <p className="text-sm font-medium text-gray-200">
              Agent running in{" "}
              <span className="text-amber-400">{session.repoName}</span>
            </p>
            <p className="text-xs text-gray-400 mt-0.5">
              {session.model} &middot; {elapsedLabel} elapsed &middot; PID {session.pid}
            </p>
          </div>
        </div>
        <button
          onClick={onStop}
          disabled={isStopping}
          className="px-3 py-1.5 text-xs font-medium rounded-md text-red-400 hover:text-red-300 bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 transition-colors disabled:opacity-50"
        >
          {isStopping ? "Stopping..." : "Stop Agent"}
        </button>
      </div>
    </div>
  );
}
