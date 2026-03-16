"use client";

import { useMemo, useState } from "react";
import { ReleaseIssueList } from "./ReleaseIssueList";
import { AddBeadsModal } from "./AddBeadsModal";
import { buildReleaseGroups, getStatusColor, getStatusLabel } from "./types";
import { computePriorityWeights, computeVelocity, estimateRelease } from "./estimate";
import type { PlanIssue } from "@/lib/types";

interface ProjectReleasesProps {
  projectName: string;
  issues: PlanIssue[];
}

export function ProjectReleases({ projectName, issues }: ProjectReleasesProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [addModal, setAddModal] = useState<string | null>(null); // release label for the modal
  const [creatingVersion, setCreatingVersion] = useState(false);
  const [newVersionInput, setNewVersionInput] = useState("");

  const releases = useMemo(() => buildReleaseGroups(issues), [issues]);

  // Compute ETA data from project history
  const weights = useMemo(() => computePriorityWeights(issues), [issues]);
  const velocity = useMemo(() => computeVelocity(issues), [issues]);

  // Collect all known release labels for the move-to dropdown
  const allReleaseLabels = useMemo(
    () => releases.filter((r) => r.label).map((r) => r.label),
    [releases]
  );

  const toggleExpand = (version: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(version)) next.delete(version);
      else next.add(version);
      return next;
    });
  };

  const handleCreateVersion = () => {
    const trimmed = newVersionInput.trim();
    if (!trimmed) return;
    const label = trimmed.startsWith("release:") ? trimmed : `release:${trimmed}`;
    // Open the add-beads modal for this new release
    setAddModal(label);
    setCreatingVersion(false);
    setNewVersionInput("");
  };

  if (releases.length === 0) return null;

  return (
    <>
      <div className="card p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-white">{projectName}</h2>
          <div className="flex items-center gap-2">
            {creatingVersion ? (
              <div className="flex items-center gap-1">
                <input
                  type="text"
                  value={newVersionInput}
                  onChange={(e) => setNewVersionInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleCreateVersion();
                    if (e.key === "Escape") {
                      setCreatingVersion(false);
                      setNewVersionInput("");
                    }
                  }}
                  placeholder="e.g. 2.2"
                  className="px-2 py-1 text-xs bg-surface-0 border border-surface-2 rounded text-gray-200 placeholder:text-gray-500 focus:outline-none focus:border-blue-500 w-24"
                  autoFocus
                />
                <button
                  onClick={handleCreateVersion}
                  disabled={!newVersionInput.trim()}
                  className="px-2 py-1 text-xs font-medium rounded bg-green-500/20 text-green-300 hover:bg-green-500/30 disabled:opacity-30 transition-colors"
                >
                  Create
                </button>
                <button
                  onClick={() => { setCreatingVersion(false); setNewVersionInput(""); }}
                  className="px-2 py-1 text-xs text-gray-400 hover:text-gray-200 transition-colors"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                onClick={() => setCreatingVersion(true)}
                className="flex items-center gap-1 px-3 py-1 text-xs font-medium rounded-lg bg-surface-2 text-gray-300 hover:bg-surface-2/80 hover:text-white transition-colors"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                </svg>
                New Release
              </button>
            )}
          </div>
        </div>
        <div className="space-y-2">
          {releases.map((release) => {
            const pct = release.total > 0 ? Math.round((release.closed / release.total) * 100) : 0;
            const isExpanded = expanded.has(release.version);
            const eta = release.label ? estimateRelease(release.issues, weights, velocity) : null;
            return (
              <div
                key={release.version}
                className="rounded-lg bg-surface-2/50 transition-colors"
              >
                <div
                  className="flex items-center gap-4 p-3 cursor-pointer hover:bg-surface-2 rounded-lg transition-colors"
                  onClick={() => toggleExpand(release.version)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === "Enter") toggleExpand(release.version); }}
                >
                  {/* Expand chevron */}
                  <svg
                    className={`w-4 h-4 text-gray-400 transition-transform shrink-0 ${isExpanded ? "rotate-90" : ""}`}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>

                  {/* Version */}
                  <div className="w-16 shrink-0">
                    {release.label ? (
                      <span className="text-sm font-mono font-semibold text-blue-400">
                        v{release.version}
                      </span>
                    ) : (
                      <span className="text-sm font-mono text-gray-500">{release.version}</span>
                    )}
                  </div>

                  {/* Status badge */}
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium border ${getStatusColor(release.status)}`}
                  >
                    {getStatusLabel(release.status)}
                  </span>

                  {/* Progress bar */}
                  <div className="flex-1 min-w-0">
                    <div className="h-2 rounded-full bg-surface-0 overflow-hidden">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-green-500 to-emerald-400 transition-all duration-300"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>

                  {/* Counts */}
                  <div className="text-xs text-gray-400 whitespace-nowrap w-28 text-right">
                    <span className="text-green-400">{release.closed}</span>
                    {" / "}
                    <span>{release.total}</span>
                    {" closed"}
                    {release.open > 0 && (
                      <span className="text-gray-500 ml-1">({release.open} open)</span>
                    )}
                  </div>

                  {/* ETA */}
                  {eta && eta.hasEstimate && eta.calendarDays !== 0 && (
                    <span
                      className={`text-xs whitespace-nowrap shrink-0 ${
                        eta.calendarDays === null
                          ? "text-gray-500"
                          : (eta.calendarDays ?? 0) <= 3
                            ? "text-green-400"
                            : (eta.calendarDays ?? 0) <= 14
                              ? "text-yellow-400"
                              : "text-orange-400"
                      }`}
                      title={`${Math.round(eta.beadDays * 10) / 10} bead-days at ${Math.round(velocity * 10) / 10} beads/day`}
                    >
                      {eta.display}
                    </span>
                  )}

                  {/* Add beads button (on versioned releases only) */}
                  {release.label && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setAddModal(release.label);
                      }}
                      className="p-1.5 rounded text-gray-500 hover:text-green-400 hover:bg-green-500/10 transition-colors shrink-0"
                      title={`Add beads to v${release.version}`}
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                      </svg>
                    </button>
                  )}
                </div>

                {/* Expanded issue list */}
                {isExpanded && (
                  <div className="px-3 pb-3">
                    <ReleaseIssueList
                      issues={release.issues}
                      releaseLabel={release.label || null}
                      availableReleases={allReleaseLabels}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Add beads modal */}
      {addModal && (
        <AddBeadsModal
          releaseLabel={addModal}
          allIssues={issues}
          onClose={() => setAddModal(null)}
        />
      )}
    </>
  );
}
