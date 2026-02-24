"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { PlanIssue } from "@/lib/types";
import { StatusBadge } from "./StatusBadge";
import { PriorityIndicator } from "./PriorityIndicator";
import { IssueTypeIcon } from "./IssueTypeIcon";

function getProject(issue: PlanIssue): string {
  const label = issue.labels?.find((l) => l.startsWith("project:"));
  return label ? label.slice(8) : "";
}

function getSubmissionBadge(label: string): { text: string; className: string } | null {
  if (!label.startsWith("submission:")) return null;
  const state = label.slice(11);
  const styles: Record<string, string> = {
    ready: "bg-blue-500/20 text-blue-300",
    "in-review": "bg-amber-500/20 text-amber-300",
    approved: "bg-green-500/20 text-green-300",
    rejected: "bg-red-500/20 text-red-300",
  };
  return { text: state, className: styles[state] ?? "bg-surface-2 text-gray-300" };
}

function computeEpicProgress(epicId: string, allIssues: PlanIssue[]): { closed: number; total: number } | null {
  const children = allIssues.filter((i) => i.epic === epicId);
  if (children.length === 0) return null;
  const closed = children.filter((i) => i.status === "closed").length;
  return { closed, total: children.length };
}

function formatRelativeDate(dateStr: string | undefined): string | null {
  if (!dateStr) return null;
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return null;
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return "today";
  if (diffDays === 1) return "1d ago";
  if (diffDays < 30) return `${diffDays}d ago`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo ago`;
  return `${Math.floor(diffDays / 365)}y ago`;
}

interface IssueCardProps {
  issue: PlanIssue;
  variant?: "card" | "row";
  onClick?: (issueId: string) => void;
  tokenCost?: number;
  allIssues?: PlanIssue[];
}

export function IssueCard({
  issue,
  variant = "card",
  onClick,
  tokenCost,
  allIssues,
}: IssueCardProps) {
  const router = useRouter();

  const handleClick = () => {
    if (onClick) {
      onClick(issue.id);
    } else {
      router.push(`/issue/${issue.id}`);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleClick();
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
          {getProject(issue) ? (
            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-surface-2 text-gray-300">
              {getProject(issue)}
            </span>
          ) : (
            <span className="text-gray-500">{"\u2014"}</span>
          )}
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
          {issue.owner ?? "\u2014"}
        </td>
        <td className="px-3 py-2 text-sm">
          {issue.epic ? (
            <div>
              <Link
                href={`/issue/${issue.epic}`}
                onClick={(e) => e.stopPropagation()}
                className="text-purple-400 hover:text-purple-300 transition-colors"
              >
                {issue.epic_title ?? issue.epic}
              </Link>
              {allIssues && (() => {
                const progress = computeEpicProgress(issue.epic!, allIssues);
                if (!progress) return null;
                const pct = Math.round((progress.closed / progress.total) * 100);
                return (
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <div className="flex-1 h-1 bg-surface-2 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-green-500 to-emerald-400 rounded-full"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="text-[10px] text-gray-500">{pct}%</span>
                  </div>
                );
              })()}
            </div>
          ) : (
            <span className="text-gray-500">{"\u2014"}</span>
          )}
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
        <td className="px-3 py-2 text-sm text-right font-mono">
          {tokenCost != null && tokenCost > 0 ? (
            <span className="text-amber-400">${tokenCost.toFixed(2)}</span>
          ) : (
            <span className="text-gray-500">{"\u2014"}</span>
          )}
        </td>
        <td className="px-3 py-2 text-xs text-gray-500" title={issue.created_at}>
          {formatRelativeDate(issue.created_at) ?? "\u2014"}
        </td>
      </tr>
    );
  }

  // Card variant: use <Link> wrapper when there is no custom onClick handler
  const cardContent = (
    <>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <IssueTypeIcon type={issue.issue_type} />
          <span className="font-mono text-xs text-gray-400">{issue.id}</span>
        </div>
        <div className="flex items-center gap-2">
          {getProject(issue) && (
            <span className="text-[10px] text-gray-500 bg-surface-2 px-1.5 py-0.5 rounded">
              {getProject(issue)}
            </span>
          )}
          <PriorityIndicator priority={issue.priority} />
        </div>
      </div>
      <h3 className="text-sm font-medium mb-2 line-clamp-2">{issue.title}</h3>
      {allIssues && issue.issue_type === "epic" && (() => {
        const progress = computeEpicProgress(issue.id, allIssues);
        if (!progress) return null;
        const pct = Math.round((progress.closed / progress.total) * 100);
        return (
          <div className="mt-1 mb-2 flex items-center gap-1.5">
            <div className="flex-1 h-1.5 bg-surface-2 rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-green-500 to-emerald-400 rounded-full"
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="text-[10px] text-gray-500">{progress.closed}/{progress.total}</span>
          </div>
        );
      })()}
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
      {issue.labels && issue.labels.some((l) => l.startsWith("submission:")) && (
        <div className="flex flex-wrap gap-1 mb-1">
          {issue.labels.filter((l) => l.startsWith("submission:")).map((label) => {
            const badge = getSubmissionBadge(label);
            if (!badge) return null;
            return (
              <span
                key={label}
                className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${badge.className}`}
              >
                {badge.text}
              </span>
            );
          })}
        </div>
      )}
      <div className="flex items-center justify-between">
        <StatusBadge status={issue.status} />
        <div className="flex items-center gap-2 text-xs text-gray-400">
          {formatRelativeDate(issue.created_at) && (
            <span className="text-gray-500" title={issue.created_at}>
              {formatRelativeDate(issue.created_at)}
            </span>
          )}
          {issue.blocked_by.length > 0 && (
            <span className="text-status-blocked font-medium">
              {issue.blocked_by.length} blocked
            </span>
          )}
          {issue.owner && <span>{issue.owner}</span>}
          {tokenCost != null && tokenCost > 0 && (
            <span className="text-amber-400 font-mono">${tokenCost.toFixed(2)}</span>
          )}
        </div>
      </div>
    </>
  );

  if (onClick) {
    return (
      <div
        className="card-hover p-3 cursor-pointer"
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        role="button"
        tabIndex={0}
      >
        {cardContent}
      </div>
    );
  }

  return (
    <Link
      href={`/issue/${issue.id}`}
      className="card-hover p-3 cursor-pointer block"
    >
      {cardContent}
    </Link>
  );
}
