"use client";

import { useDiff } from "@/hooks/useDiff";
import type { DiffIssueChange } from "@/lib/types";

const BADGE_STYLES: Record<
  DiffIssueChange["change_type"],
  { label: string; classes: string }
> = {
  new: {
    label: "NEW",
    classes: "bg-green-500/15 text-green-400 border-green-500/30",
  },
  closed: {
    label: "CLOSED",
    classes: "bg-gray-500/15 text-gray-400 border-gray-500/30",
  },
  modified: {
    label: "MODIFIED",
    classes: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  },
  reopened: {
    label: "REOPENED",
    classes: "bg-blue-500/15 text-blue-400 border-blue-500/30",
  },
};

export function ActivityFeed() {
  const { data: diff, isLoading, error } = useDiff();

  if (isLoading) {
    return (
      <section className="card p-4">
        <h2 className="text-sm font-semibold text-white mb-3">
          Recent Changes
        </h2>
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="h-6 bg-surface-2 rounded animate-pulse"
            />
          ))}
        </div>
      </section>
    );
  }

  if (error || !diff || diff.changes.length === 0) {
    return (
      <section className="card p-4">
        <h2 className="text-sm font-semibold text-white mb-3">
          Recent Changes
        </h2>
        <p className="text-xs text-gray-500">No recent changes</p>
      </section>
    );
  }

  const entries = diff.changes.slice(0, 10);

  return (
    <section className="card p-4">
      <h2 className="text-sm font-semibold text-white mb-1">
        Recent Changes
      </h2>

      <p className="text-xs text-gray-400 mb-3">
        {[
          diff.new_count > 0 && `+${diff.new_count} new`,
          diff.closed_count > 0 && `${diff.closed_count} closed`,
          diff.modified_count > 0 && `${diff.modified_count} modified`,
          diff.reopened_count > 0 && `${diff.reopened_count} reopened`,
        ]
          .filter(Boolean)
          .join(", ")}
      </p>

      <ul className="space-y-1.5">
        {entries.map((change) => {
          const badge = BADGE_STYLES[change.change_type];
          return (
            <li
              key={`${change.issue_id}-${change.change_type}`}
              className="flex items-center gap-2 text-sm"
            >
              <span
                className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold border ${badge.classes}`}
              >
                {badge.label}
              </span>
              <span className="font-mono text-xs text-gray-400 shrink-0">
                {change.issue_id}
              </span>
              <span className="text-gray-300 truncate">{change.title}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
