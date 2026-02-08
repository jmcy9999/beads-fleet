"use client";

import { useState, useMemo } from "react";
import type { PlanIssue } from "@/lib/types";
import { IssueCard } from "@/components/ui/IssueCard";

type SortKey = "id" | "title" | "status" | "priority" | "owner" | "blocked_by";
type SortDir = "asc" | "desc";

interface IssueTableProps {
  issues: PlanIssue[];
}

const COLUMN_HEADERS: { key: SortKey; label: string }[] = [
  { key: "id", label: "ID" },
  { key: "title", label: "Title" },
  { key: "status", label: "Status" },
  { key: "priority", label: "Priority" },
  { key: "owner", label: "Owner" },
  { key: "blocked_by", label: "Blocked By" },
];

function comparePlanIssues(a: PlanIssue, b: PlanIssue, key: SortKey): number {
  switch (key) {
    case "id":
      return a.id.localeCompare(b.id);
    case "title":
      return a.title.localeCompare(b.title);
    case "status":
      return a.status.localeCompare(b.status);
    case "priority":
      return (a.priority as number) - (b.priority as number);
    case "owner":
      return (a.owner ?? "").localeCompare(b.owner ?? "");
    case "blocked_by":
      return a.blocked_by.length - b.blocked_by.length;
    default:
      return 0;
  }
}

export function IssueTable({ issues }: IssueTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>("priority");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [showClosed, setShowClosed] = useState(false);

  const handleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const sortedIssues = useMemo(() => {
    const filtered = showClosed
      ? issues
      : issues.filter((issue) => issue.status !== "closed");

    return [...filtered].sort((a, b) => {
      const cmp = comparePlanIssues(a, b, sortKey);
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [issues, sortKey, sortDir, showClosed]);

  const sortIndicator = (key: SortKey) => {
    if (key !== sortKey) return null;
    return (
      <span className="ml-1 text-gray-400">
        {sortDir === "asc" ? "\u2191" : "\u2193"}
      </span>
    );
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-white">Issues</h2>
        <label className="flex items-center gap-2 text-sm text-gray-400 cursor-pointer">
          <input
            type="checkbox"
            checked={showClosed}
            onChange={(e) => setShowClosed(e.target.checked)}
            className="rounded border-gray-600 bg-surface-2 text-blue-500 focus:ring-blue-500/30"
          />
          Show closed
        </label>
      </div>

      {/* Desktop table */}
      <div className="hidden md:block overflow-x-auto">
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-surface-2">
              {COLUMN_HEADERS.map((col) => (
                <th
                  key={col.key}
                  className="px-3 py-2 text-xs font-medium uppercase tracking-wider text-gray-400 cursor-pointer hover:text-white transition-colors select-none"
                  onClick={() => handleSort(col.key)}
                >
                  {col.label}
                  {sortIndicator(col.key)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-2">
            {sortedIssues.map((issue) => (
              <IssueCard key={issue.id} issue={issue} variant="row" />
            ))}
          </tbody>
        </table>
        {sortedIssues.length === 0 && (
          <p className="text-center text-gray-500 py-8 text-sm">
            No issues to display.
          </p>
        )}
      </div>

      {/* Mobile cards */}
      <div className="md:hidden grid gap-3">
        {sortedIssues.map((issue) => (
          <IssueCard key={issue.id} issue={issue} variant="card" />
        ))}
        {sortedIssues.length === 0 && (
          <p className="text-center text-gray-500 py-8 text-sm">
            No issues to display.
          </p>
        )}
      </div>
    </div>
  );
}
