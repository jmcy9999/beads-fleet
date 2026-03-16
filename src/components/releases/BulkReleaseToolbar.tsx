"use client";

import { useState } from "react";

interface BulkReleaseToolbarProps {
  selectedCount: number;
  availableReleases: string[]; // e.g. ["release:2.1", "release:3.0"]
  currentRelease: string | null; // null = unassigned section
  onAssign: (releaseLabel: string) => void;
  onRemove: () => void;
  onClear: () => void;
  isBusy: boolean;
}

export function BulkReleaseToolbar({
  selectedCount,
  availableReleases,
  currentRelease,
  onAssign,
  onRemove,
  onClear,
  isBusy,
}: BulkReleaseToolbarProps) {
  const [showDropdown, setShowDropdown] = useState(false);
  const [newVersion, setNewVersion] = useState("");

  if (selectedCount === 0) return null;

  // Filter out current release from move targets
  const moveTargets = availableReleases.filter((r) => r !== currentRelease);

  const handleAssign = (label: string) => {
    onAssign(label);
    setShowDropdown(false);
    setNewVersion("");
  };

  const handleCreateAndAssign = () => {
    const trimmed = newVersion.trim();
    if (!trimmed) return;
    const label = trimmed.startsWith("release:") ? trimmed : `release:${trimmed}`;
    handleAssign(label);
  };

  return (
    <div className="flex items-center gap-3 px-3 py-2 bg-blue-500/10 border border-blue-500/20 rounded-lg">
      <span className="text-sm text-blue-300 font-medium">
        {selectedCount} selected
      </span>

      {/* Move to release dropdown */}
      <div className="relative">
        <button
          onClick={() => setShowDropdown(!showDropdown)}
          disabled={isBusy}
          className="px-3 py-1 text-xs font-medium rounded bg-blue-500/20 text-blue-300 hover:bg-blue-500/30 disabled:opacity-50 transition-colors"
        >
          {isBusy ? "Working..." : "Move to release..."}
        </button>
        {showDropdown && (
          <div className="absolute top-full left-0 mt-1 w-56 bg-surface-1 border border-surface-2 rounded-lg shadow-xl z-50 overflow-hidden">
            {/* Existing releases */}
            {moveTargets.map((label) => (
              <button
                key={label}
                onClick={() => handleAssign(label)}
                className="w-full text-left px-3 py-2 text-sm text-gray-200 hover:bg-surface-2 transition-colors"
              >
                v{label.replace("release:", "")}
              </button>
            ))}
            {moveTargets.length > 0 && (
              <div className="border-t border-surface-2" />
            )}
            {/* Create new release */}
            <div className="p-2">
              <div className="flex gap-1">
                <input
                  type="text"
                  value={newVersion}
                  onChange={(e) => setNewVersion(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleCreateAndAssign();
                    if (e.key === "Escape") setShowDropdown(false);
                  }}
                  placeholder="New version (e.g. 2.2)"
                  className="flex-1 px-2 py-1 text-xs bg-surface-0 border border-surface-2 rounded text-gray-200 placeholder:text-gray-500 focus:outline-none focus:border-blue-500"
                  autoFocus
                />
                <button
                  onClick={handleCreateAndAssign}
                  disabled={!newVersion.trim()}
                  className="px-2 py-1 text-xs font-medium rounded bg-green-500/20 text-green-300 hover:bg-green-500/30 disabled:opacity-30 transition-colors"
                >
                  +
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Remove from release */}
      {currentRelease && (
        <button
          onClick={onRemove}
          disabled={isBusy}
          className="px-3 py-1 text-xs font-medium rounded bg-red-500/20 text-red-300 hover:bg-red-500/30 disabled:opacity-50 transition-colors"
        >
          Remove from release
        </button>
      )}

      {/* Clear selection */}
      <button
        onClick={onClear}
        className="px-2 py-1 text-xs text-gray-400 hover:text-gray-200 transition-colors ml-auto"
      >
        Clear
      </button>
    </div>
  );
}
