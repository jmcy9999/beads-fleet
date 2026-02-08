"use client";

import type { PlanIssue } from "@/lib/types";
import { StatusBadge } from "./StatusBadge";
import { PriorityIndicator } from "./PriorityIndicator";
import { IssueTypeIcon } from "./IssueTypeIcon";

interface IssueCardProps {
  issue: PlanIssue;
  variant?: "card" | "row";
  onClick?: (issueId: string) => void;
}

export function IssueCard({
  issue,
  variant = "card",
  onClick,
}: IssueCardProps) {
  const handleClick = () => onClick?.(issue.id);
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") onClick?.(issue.id);
  };

  if (variant === "row") {
    return (
      <tr
        className="hover:bg-surface-2 cursor-pointer transition-colors"
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        role="button"
        tabIndex={0}
      >
        <td className="px-3 py-2 font-mono text-xs text-gray-400">
          {issue.id}
        </td>
        <td className="px-3 py-2">
          <span className="inline-flex items-center gap-2">
            <IssueTypeIcon type={issue.issue_type} />
            <span className="text-sm">{issue.title}</span>
          </span>
        </td>
        <td className="px-3 py-2">
          <StatusBadge status={issue.status} />
        </td>
        <td className="px-3 py-2">
          <PriorityIndicator priority={issue.priority} />
        </td>
        <td className="px-3 py-2 text-sm text-gray-400">
          {issue.owner ?? "—"}
        </td>
        <td className="px-3 py-2 text-sm">
          {issue.blocked_by.length > 0 ? (
            <span className="text-status-blocked font-medium">
              {issue.blocked_by.length}
            </span>
          ) : (
            <span className="text-gray-500">0</span>
          )}
        </td>
      </tr>
    );
  }

  return (
    <div
      className="card-hover p-3 cursor-pointer"
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      role="button"
      tabIndex={0}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <IssueTypeIcon type={issue.issue_type} />
          <span className="font-mono text-xs text-gray-400">{issue.id}</span>
        </div>
        <PriorityIndicator priority={issue.priority} />
      </div>
      <h3 className="text-sm font-medium mb-2 line-clamp-2">{issue.title}</h3>
      {issue.impact_score != null && issue.impact_score > 0 && (
        <div className="mt-1 flex items-center gap-1.5">
          <div className="flex-1 h-1 bg-surface-2 rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-blue-500 to-purple-500 rounded-full"
              style={{ width: `${Math.round(issue.impact_score * 100)}%` }}
            />
          </div>
          <span className="text-[10px] text-gray-500">{Math.round(issue.impact_score * 100)}</span>
        </div>
      )}
      <div className="flex items-center justify-between">
        <StatusBadge status={issue.status} />
        <div className="flex items-center gap-2 text-xs text-gray-400">
          {issue.blocked_by.length > 0 && (
            <span className="text-status-blocked font-medium">
              {issue.blocked_by.length} blocked
            </span>
          )}
          {issue.owner && <span>{issue.owner}</span>}
        </div>
      </div>
    </div>
  );
}
