"use client";

import { useState, useMemo, useCallback } from "react";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { PriorityIndicator } from "@/components/ui/PriorityIndicator";
import { IssueTypeIcon } from "@/components/ui/IssueTypeIcon";
import { useIssueAction } from "@/hooks/useIssueAction";
import { getReleaseLabel } from "./types";
import type { PlanIssue } from "@/lib/types";

interface AddBeadsModalProps {
  releaseLabel: string;
  allIssues: PlanIssue[];
  onClose: () => void;
}

export function AddBeadsModal({ releaseLabel, allIssues, onClose }: AddBeadsModalProps) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [isBusy, setIsBusy] = useState(false);
  const [statusFilter, setStatusFilter] = useState<"all" | "open">("open");
  const action = useIssueAction();

  // Show issues NOT already in this release
  const candidates = useMemo(() => {
    return allIssues.filter((i) => {
      const rl = getReleaseLabel(i);
      if (rl === releaseLabel) return false;
      if (statusFilter === "open" && i.status === "closed") return false;
      if (search) {
        const q = search.toLowerCase();
        return (
          i.title.toLowerCase().includes(q) ||
          i.id.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [allIssues, releaseLabel, search, statusFilter]);

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleAssign = useCallback(async () => {
    if (selected.size === 0) return;
    setIsBusy(true);
    try {
      const ops: Promise<unknown>[] = [];
      for (const id of selected) {
        const issue = allIssues.find((i) => i.id === id);
        if (!issue) continue;
        // Remove old release label if present
        const oldLabel = getReleaseLabel(issue);
        if (oldLabel) {
          ops.push(action.mutateAsync({ issueId: id, action: "label-rm", reason: oldLabel }));
        }
        ops.push(action.mutateAsync({ issueId: id, action: "label-add", reason: releaseLabel }));
      }
      await Promise.all(ops);
      onClose();
    } finally {
      setIsBusy(false);
    }
  }, [selected, allIssues, releaseLabel, action, onClose]);

  const version = releaseLabel.replace("release:", "");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-surface-1 border border-surface-2 rounded-xl shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-surface-2">
          <h2 className="text-lg font-semibold text-white">
            Add beads to v{version}
          </h2>
          <button
            onClick={onClose}
            className="p-1 rounded text-gray-400 hover:text-white hover:bg-surface-2 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Search + filters */}
        <div className="px-5 py-3 border-b border-surface-2 flex gap-3">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search beads by title or ID..."
            className="flex-1 px-3 py-2 text-sm bg-surface-0 border border-surface-2 rounded-lg text-gray-200 placeholder:text-gray-500 focus:outline-none focus:border-blue-500"
            autoFocus
          />
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as "all" | "open")}
            className="px-3 py-2 text-sm bg-surface-0 border border-surface-2 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500"
          >
            <option value="open">Open only</option>
            <option value="all">All statuses</option>
          </select>
        </div>

        {/* Issue list */}
        <div className="flex-1 overflow-y-auto px-5 py-2">
          {candidates.length === 0 ? (
            <p className="text-center text-gray-500 py-8 text-sm">
              {search ? "No matching beads found." : "All beads are already assigned to this release."}
            </p>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {candidates.slice(0, 100).map((issue) => {
                  const currentRelease = getReleaseLabel(issue);
                  return (
                    <tr
                      key={issue.id}
                      onClick={() => toggleSelect(issue.id)}
                      className={`cursor-pointer hover:bg-surface-2/50 transition-colors ${
                        selected.has(issue.id) ? "bg-blue-500/10" : ""
                      }`}
                    >
                      <td className="px-2 py-1.5 w-8">
                        <input
                          type="checkbox"
                          checked={selected.has(issue.id)}
                          onChange={() => toggleSelect(issue.id)}
                          className="rounded border-gray-500 bg-surface-0 text-blue-500 focus:ring-blue-500 focus:ring-offset-0 cursor-pointer"
                        />
                      </td>
                      <td className="px-2 py-1.5 w-8">
                        <IssueTypeIcon type={issue.issue_type} />
                      </td>
                      <td className="px-2 py-1.5">
                        <span className="text-gray-200">{issue.title}</span>
                        <span className="ml-2 text-xs text-gray-500 font-mono">{issue.id}</span>
                        {currentRelease && (
                          <span className="ml-2 text-[10px] text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded">
                            v{currentRelease.replace("release:", "")}
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-1.5 w-24">
                        <StatusBadge status={issue.status} />
                      </td>
                      <td className="px-2 py-1.5 w-16">
                        <PriorityIndicator priority={issue.priority} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {candidates.length > 100 && (
            <p className="text-center text-gray-500 text-xs py-2">
              Showing first 100 of {candidates.length} results. Use search to narrow down.
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-surface-2">
          <span className="text-sm text-gray-400">
            {selected.size} bead{selected.size !== 1 ? "s" : ""} selected
          </span>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm rounded-lg text-gray-300 hover:bg-surface-2 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleAssign}
              disabled={selected.size === 0 || isBusy}
              className="px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isBusy
                ? "Assigning..."
                : `Add ${selected.size} bead${selected.size !== 1 ? "s" : ""} to v${version}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
