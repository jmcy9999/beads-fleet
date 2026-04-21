"use client";

// =============================================================================
// ReconcilerStatusCard — factory-core-lfcf.5
// =============================================================================
// Compact read-only status card showing reconciler health. Polls
// /api/fleet/reconciler/status every 10s. Per zero-human-touchpoints
// (2026-04-21), no action CTAs — just status.
//
// Colour semantics:
//   - running + recent tick (< 3x tickInterval)  → green
//   - running + stale tick (> 3x tickInterval)   → amber
//   - not running OR fetch error                 → red
// =============================================================================

import { useEffect, useState } from "react";

interface ReconcilerStatus {
  running: boolean;
  reason?: string;
  lastTickAt?: string;
  tickIntervalMs: number;
  eventsProcessedLastTick: number;
  actionsDispatchedLastTick: number;
  rulesRegistered: Array<{
    name: string;
    lastMatchedAt?: string;
    totalActionsDispatched: number;
  }>;
  recentActions: Array<{
    at: string;
    ruleName: string;
    epicId: string;
    idempotencyKey: string;
  }>;
}

function formatRelative(iso?: string): string {
  if (!iso) return "never";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "unknown";
  if (ms < 10_000) return "just now";
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  return `${Math.floor(ms / 3_600_000)}h ago`;
}

function colourForStatus(s: ReconcilerStatus | null): string {
  if (!s) return "text-gray-400 border-gray-700";
  if (!s.running) return "text-red-400 border-red-700";
  if (!s.lastTickAt) return "text-amber-400 border-amber-700";
  const age = Date.now() - Date.parse(s.lastTickAt);
  if (age > s.tickIntervalMs * 3) return "text-amber-400 border-amber-700";
  return "text-emerald-400 border-emerald-700";
}

export function ReconcilerStatusCard() {
  const [status, setStatus] = useState<ReconcilerStatus | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchStatus() {
      try {
        const res = await fetch("/api/fleet/reconciler/status");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as ReconcilerStatus;
        if (!cancelled) {
          setStatus(data);
          setErr(null);
        }
      } catch (e) {
        if (!cancelled) {
          setErr(e instanceof Error ? e.message : String(e));
        }
      }
    }

    void fetchStatus();
    const interval = setInterval(fetchStatus, 10_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const colour = colourForStatus(status);
  const headline =
    err !== null
      ? `offline (${err})`
      : !status
        ? "loading..."
        : !status.running
          ? `stopped${status.reason ? ` — ${status.reason}` : ""}`
          : `ok — last tick ${formatRelative(status.lastTickAt)}`;

  const actionCount = status?.recentActions.length ?? 0;

  return (
    <div
      className={`rounded border bg-slate-900/50 p-3 text-xs ${colour}`}
      data-testid="reconciler-status-card"
    >
      <div className="flex items-center justify-between">
        <div className="font-mono uppercase tracking-wider">
          Reconciler: {headline}
        </div>
        {status && status.recentActions.length > 0 && (
          <button
            className="ml-2 text-[10px] opacity-70 hover:opacity-100"
            onClick={() => setExpanded((v) => !v)}
            type="button"
          >
            {expanded ? "hide" : "show"} actions ({actionCount})
          </button>
        )}
      </div>

      {status && (
        <div className="mt-1 flex gap-3 text-[11px] text-gray-400">
          <span>rules: {status.rulesRegistered.length}</span>
          <span>evts/tick: {status.eventsProcessedLastTick}</span>
          <span>acts/tick: {status.actionsDispatchedLastTick}</span>
        </div>
      )}

      {expanded && status && (
        <ul className="mt-2 space-y-1 text-[11px]">
          {status.recentActions.slice(0, 10).map((a) => (
            <li key={a.idempotencyKey} className="truncate text-gray-300">
              <span className="text-gray-500">{formatRelative(a.at)}</span>{" "}
              <span className="text-cyan-400">{a.ruleName}</span>{" "}
              <span className="text-gray-400">→</span>{" "}
              <span>{a.epicId}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
