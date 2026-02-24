"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import type { FilterCriteria, SavedView } from "@/lib/recipes";
import {
  getAllViews,
  loadCustomViews,
  saveCustomViews,
} from "@/lib/recipes";
import type { IssueStatus, IssueType, Priority } from "@/lib/types";
import { STATUS_CONFIG, PRIORITY_CONFIG } from "@/lib/types";
import { RecipeSelector } from "./RecipeSelector";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FilterBarProps {
  filter: FilterCriteria;
  onFilterChange: (filter: FilterCriteria) => void;
  activeViewId?: string;
  onViewChange?: (viewId: string) => void;
  availableProjects?: string[];
  availableEpics?: Map<string, string>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALL_STATUSES: IssueStatus[] = [
  "open",
  "in_progress",
  "blocked",
  "deferred",
  "closed",
  "pinned",
];

const ALL_TYPES: IssueType[] = ["bug", "feature", "task", "epic", "chore"];

const ALL_PRIORITIES: Priority[] = [0, 1, 2, 3, 4];

const TYPE_LABELS: Record<IssueType, string> = {
  bug: "Bug",
  feature: "Feature",
  task: "Task",
  epic: "Epic",
  chore: "Chore",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isDefaultFilter(filter: FilterCriteria): boolean {
  return (
    (!filter.statuses || filter.statuses.length === 0) &&
    (!filter.priorities || filter.priorities.length === 0) &&
    (!filter.types || filter.types.length === 0) &&
    !filter.owner &&
    (!filter.labels || filter.labels.length === 0) &&
    (!filter.projects || filter.projects.length === 0) &&
    !filter.epic &&
    filter.hasBlockers === undefined &&
    !filter.createdAfter &&
    !filter.createdBefore &&
    !filter.search
  );
}

// ---------------------------------------------------------------------------
// MultiSelectDropdown (reusable)
// ---------------------------------------------------------------------------

interface MultiSelectDropdownProps<T extends string | number> {
  label: string;
  options: T[];
  selected: T[];
  renderOption: (option: T) => React.ReactNode;
  onChange: (selected: T[]) => void;
}

function MultiSelectDropdown<T extends string | number>({
  label,
  options,
  selected,
  renderOption,
  onChange,
}: MultiSelectDropdownProps<T>) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  const toggle = (option: T) => {
    if (selected.includes(option)) {
      onChange(selected.filter((s) => s !== option));
    } else {
      onChange([...selected, option]);
    }
  };

  const count = selected.length;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-surface-2 border border-border-default rounded-md text-gray-300 hover:text-white hover:border-gray-500 transition-colors"
      >
        <span>{label}</span>
        {count > 0 && (
          <span className="inline-flex items-center justify-center w-4 h-4 text-[10px] font-bold rounded-full bg-status-open/20 text-status-open">
            {count}
          </span>
        )}
        <svg
          className={`w-3 h-3 text-gray-400 transition-transform ${open ? "rotate-180" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M19 9l-7 7-7-7"
          />
        </svg>
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1 w-48 bg-surface-1 border border-border-default rounded-lg shadow-xl z-50 py-1">
          {options.map((option) => (
            <button
              key={String(option)}
              type="button"
              onClick={() => toggle(option)}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-surface-2 transition-colors text-left"
            >
              <span
                className={`inline-flex items-center justify-center w-4 h-4 rounded border text-[10px] ${
                  selected.includes(option)
                    ? "bg-status-open border-status-open text-white"
                    : "border-gray-500 text-transparent"
                }`}
              >
                {selected.includes(option) ? "\u2713" : ""}
              </span>
              <span className="text-gray-300">{renderOption(option)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// DateRangeFilter
// ---------------------------------------------------------------------------

interface DateRangeFilterProps {
  createdAfter?: string;
  createdBefore?: string;
  onChange: (after: string | undefined, before: string | undefined) => void;
}

function DateRangeFilter({ createdAfter, createdBefore, onChange }: DateRangeFilterProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  const hasValue = !!createdAfter || !!createdBefore;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-surface-2 border border-border-default rounded-md text-gray-300 hover:text-white hover:border-gray-500 transition-colors"
      >
        <svg
          className="w-3.5 h-3.5 text-gray-400"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
          />
        </svg>
        <span>Created</span>
        {hasValue && (
          <span className="inline-flex items-center justify-center w-2 h-2 rounded-full bg-status-open" />
        )}
        <svg
          className={`w-3 h-3 text-gray-400 transition-transform ${open ? "rotate-180" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1 w-56 bg-surface-1 border border-border-default rounded-lg shadow-xl z-50 p-3 space-y-3">
          <div>
            <label className="block text-[10px] uppercase text-gray-500 font-medium mb-1">
              After
            </label>
            <input
              type="date"
              value={createdAfter ?? ""}
              onChange={(e) => onChange(e.target.value || undefined, createdBefore)}
              className="w-full px-2 py-1.5 text-xs bg-surface-2 border border-border-default rounded-md text-gray-300 focus:outline-none focus:border-gray-500 transition-colors [color-scheme:dark]"
            />
          </div>
          <div>
            <label className="block text-[10px] uppercase text-gray-500 font-medium mb-1">
              Before
            </label>
            <input
              type="date"
              value={createdBefore ?? ""}
              onChange={(e) => onChange(createdAfter, e.target.value || undefined)}
              className="w-full px-2 py-1.5 text-xs bg-surface-2 border border-border-default rounded-md text-gray-300 focus:outline-none focus:border-gray-500 transition-colors [color-scheme:dark]"
            />
          </div>
          {hasValue && (
            <button
              type="button"
              onClick={() => {
                onChange(undefined, undefined);
              }}
              className="w-full px-2 py-1 text-[10px] text-gray-400 hover:text-white bg-surface-2 border border-border-default rounded-md hover:border-gray-500 transition-colors"
            >
              Clear dates
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// FilterBar
// ---------------------------------------------------------------------------

export function FilterBar({
  filter,
  onFilterChange,
  activeViewId,
  onViewChange,
  availableProjects = [],
  availableEpics,
}: FilterBarProps) {
  const [views, setViews] = useState<SavedView[]>(() => getAllViews());
  const [showSavePrompt, setShowSavePrompt] = useState(false);
  const [saveName, setSaveName] = useState("");
  const saveInputRef = useRef<HTMLInputElement>(null);

  // Refresh views list from localStorage when component mounts or saves
  const refreshViews = useCallback(() => {
    setViews(getAllViews());
  }, []);

  // Focus save input when prompt opens
  useEffect(() => {
    if (showSavePrompt) {
      saveInputRef.current?.focus();
    }
  }, [showSavePrompt]);

  // Handlers
  const handleViewSelect = (view: SavedView) => {
    onFilterChange(view.filter);
    onViewChange?.(view.id);
  };

  const handleSearchChange = (search: string) => {
    onFilterChange({ ...filter, search: search || undefined });
    onViewChange?.("");
  };

  const handleStatusChange = (statuses: IssueStatus[]) => {
    onFilterChange({
      ...filter,
      statuses: statuses.length > 0 ? statuses : undefined,
    });
    onViewChange?.("");
  };

  const handlePriorityChange = (priorities: Priority[]) => {
    onFilterChange({
      ...filter,
      priorities: priorities.length > 0 ? priorities : undefined,
    });
    onViewChange?.("");
  };

  const handleTypeChange = (types: IssueType[]) => {
    onFilterChange({
      ...filter,
      types: types.length > 0 ? types : undefined,
    });
    onViewChange?.("");
  };

  const handleProjectChange = (projects: string[]) => {
    onFilterChange({
      ...filter,
      projects: projects.length > 0 ? projects : undefined,
    });
    onViewChange?.("");
  };

  const handleEpicChange = (epic: string | undefined) => {
    onFilterChange({
      ...filter,
      epic: epic || undefined,
    });
    onViewChange?.("");
  };

  const handleClear = () => {
    onFilterChange({});
    onViewChange?.("");
  };

  const handleSaveView = () => {
    const name = saveName.trim();
    if (!name) return;

    const newView: SavedView = {
      id: `custom-${Date.now()}`,
      name,
      filter: { ...filter },
      isBuiltIn: false,
    };

    const customs = loadCustomViews();
    customs.push(newView);
    saveCustomViews(customs);
    refreshViews();

    setSaveName("");
    setShowSavePrompt(false);
    onViewChange?.(newView.id);
  };

  const hasActiveFilters = !isDefaultFilter(filter);

  return (
    <div className="card p-3 mb-4">
      <div className="flex flex-wrap items-center gap-2">
        {/* Recipe / View selector */}
        <RecipeSelector
          views={views}
          activeViewId={activeViewId}
          onSelect={handleViewSelect}
        />

        {/* Divider */}
        <div className="w-px h-6 bg-border-default hidden sm:block" />

        {/* Search */}
        <div className="relative flex-shrink-0">
          <svg
            className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 pointer-events-none"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
          <input
            type="text"
            placeholder="Search..."
            value={filter.search ?? ""}
            onChange={(e) => handleSearchChange(e.target.value)}
            className="w-44 pl-8 pr-3 py-1.5 text-sm bg-surface-2 border border-border-default rounded-md text-gray-300 placeholder-gray-500 focus:outline-none focus:border-gray-500 transition-colors"
          />
        </div>

        {/* Status multi-select */}
        <MultiSelectDropdown
          label="Status"
          options={ALL_STATUSES}
          selected={filter.statuses ?? []}
          renderOption={(s) => STATUS_CONFIG[s].label}
          onChange={handleStatusChange}
        />

        {/* Priority multi-select */}
        <MultiSelectDropdown
          label="Priority"
          options={ALL_PRIORITIES}
          selected={filter.priorities ?? []}
          renderOption={(p) => PRIORITY_CONFIG[p].label}
          onChange={handlePriorityChange}
        />

        {/* Type multi-select */}
        <MultiSelectDropdown
          label="Type"
          options={ALL_TYPES}
          selected={filter.types ?? []}
          renderOption={(t) => TYPE_LABELS[t]}
          onChange={handleTypeChange}
        />

        {/* Project multi-select */}
        {availableProjects.length > 1 && (
          <MultiSelectDropdown
            label="Project"
            options={availableProjects}
            selected={filter.projects ?? []}
            renderOption={(p) => p}
            onChange={handleProjectChange}
          />
        )}

        {/* Epic filter */}
        {availableEpics && availableEpics.size > 0 && (
          <div className="relative">
            <select
              value={filter.epic ?? ""}
              onChange={(e) => handleEpicChange(e.target.value || undefined)}
              className="appearance-none px-3 py-1.5 pr-7 text-sm bg-surface-2 border border-border-default rounded-md text-gray-300 hover:text-white hover:border-gray-500 transition-colors cursor-pointer focus:outline-none focus:border-gray-500"
            >
              <option value="">All Epics</option>
              <option value="__none__">No Epic</option>
              {Array.from(availableEpics.entries()).map(([id, title]) => (
                <option key={id} value={id}>{title}</option>
              ))}
            </select>
            <svg
              className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 text-gray-400 pointer-events-none"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </div>
        )}

        {/* Date created filter */}
        <DateRangeFilter
          createdAfter={filter.createdAfter}
          createdBefore={filter.createdBefore}
          onChange={(after, before) => {
            onFilterChange({
              ...filter,
              createdAfter: after || undefined,
              createdBefore: before || undefined,
            });
            onViewChange?.("");
          }}
        />

        {/* Spacer pushes actions to right */}
        <div className="flex-1" />

        {/* Clear filters */}
        {hasActiveFilters && (
          <button
            type="button"
            onClick={handleClear}
            className="flex items-center gap-1 px-2.5 py-1.5 text-xs text-gray-400 hover:text-white bg-surface-2 border border-border-default rounded-md hover:border-gray-500 transition-colors"
          >
            <svg
              className="w-3 h-3"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
            Clear
          </button>
        )}

        {/* Save View */}
        {hasActiveFilters && !showSavePrompt && (
          <button
            type="button"
            onClick={() => setShowSavePrompt(true)}
            className="flex items-center gap-1 px-2.5 py-1.5 text-xs text-gray-400 hover:text-white bg-surface-2 border border-border-default rounded-md hover:border-gray-500 transition-colors"
          >
            <svg
              className="w-3 h-3"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z"
              />
            </svg>
            Save View
          </button>
        )}

        {/* Save prompt inline */}
        {showSavePrompt && (
          <div className="flex items-center gap-1.5">
            <input
              ref={saveInputRef}
              type="text"
              placeholder="View name..."
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSaveView();
                if (e.key === "Escape") {
                  setShowSavePrompt(false);
                  setSaveName("");
                }
              }}
              className="w-32 px-2.5 py-1.5 text-xs bg-surface-2 border border-border-default rounded-md text-gray-300 placeholder-gray-500 focus:outline-none focus:border-status-open transition-colors"
            />
            <button
              type="button"
              onClick={handleSaveView}
              disabled={!saveName.trim()}
              className="px-2.5 py-1.5 text-xs font-medium text-white bg-status-open/20 border border-status-open/30 rounded-md hover:bg-status-open/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => {
                setShowSavePrompt(false);
                setSaveName("");
              }}
              className="px-2 py-1.5 text-xs text-gray-500 hover:text-gray-300 transition-colors"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
