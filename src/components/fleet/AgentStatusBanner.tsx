"use client";

import { useState, useRef, useEffect } from "react";
import type { AgentSession } from "@/lib/agent-launcher";

interface AgentStatusBannerProps {
  session: AgentSession;
  recentLog?: string;
  onStop: () => void;
  isStopping: boolean;
}

export function AgentStatusBanner({ session, recentLog, onStop, isStopping }: AgentStatusBannerProps) {
  const [expanded, setExpanded] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);

  const elapsed = Date.now() - new Date(session.startedAt).getTime();
  const minutes = Math.floor(elapsed / 60_000);
  const hours = Math.floor(minutes / 60);
  const elapsedLabel = hours > 0
    ? `${hours}h ${minutes % 60}m`
    : `${minutes}m`;

  // Auto-scroll log to bottom when new output arrives
  useEffect(() => {
    if (expanded && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [recentLog, expanded]);

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
        <div className="flex items-center gap-2">
          <button
            onClick={() => setExpanded(!expanded)}
            className="px-3 py-1.5 text-xs font-medium rounded-md text-gray-400 hover:text-gray-200 bg-surface-2 hover:bg-surface-3 border border-border-default transition-colors"
          >
            {expanded ? "Hide Log" : "Show Log"}
          </button>
          <button
            onClick={onStop}
            disabled={isStopping}
            className="px-3 py-1.5 text-xs font-medium rounded-md text-red-400 hover:text-red-300 bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 transition-colors disabled:opacity-50"
          >
            {isStopping ? "Stopping..." : "Stop Agent"}
          </button>
        </div>
      </div>

      {expanded && (
        <pre
          ref={logRef}
          className="mt-3 p-3 rounded-md bg-surface-0 border border-border-default text-[11px] font-mono text-gray-300 overflow-auto max-h-64 whitespace-pre-wrap break-words"
        >
          {recentLog || "Waiting for output..."}
        </pre>
      )}
    </div>
  );
}
