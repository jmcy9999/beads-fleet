"use client";
import type { CycleInfo } from "@/lib/types";

interface CyclesPanelProps {
  cycles: CycleInfo[];
}

export function CyclesPanel({ cycles }: CyclesPanelProps) {
  return (
    <div className="card p-5">
      <div className="mb-4">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-300">
          Dependency Cycles
        </h3>
        <p className="text-xs text-gray-500 mt-0.5">
          Circular dependencies that may cause scheduling issues
        </p>
      </div>

      {cycles.length === 0 ? (
        <div className="flex items-center gap-2 py-4">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-green-500/10 text-green-400 text-sm font-bold">
            &#10003;
          </span>
          <span className="text-sm text-green-400">No cycles detected</span>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-status-blocked/10 text-status-blocked text-sm font-bold">
              !
            </span>
            <span className="text-sm text-status-blocked">
              {cycles.length} cycle{cycles.length !== 1 ? "s" : ""} detected
            </span>
          </div>
          <ul className="space-y-2">
            {cycles.map((cycle) => (
              <li
                key={cycle.cycle_id}
                className="rounded-md bg-surface-2 px-3 py-2"
              >
                <span className="font-mono text-xs text-gray-300">
                  {cycle.issues.join(" \u2192 ")} \u2192 {cycle.issues[0]}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
