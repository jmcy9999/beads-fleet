"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { FleetColumn } from "./FleetColumn";
import {
  FLEET_STAGES,
  FLEET_STAGE_CONFIG,
  buildFleetApps,
  type FleetStage,
  type EpicCost,
} from "./fleet-utils";
import type { PlanIssue } from "@/lib/types";

export type PipelineAction =
  | "start-research"
  | "send-for-development"
  | "more-research"
  | "deprioritise"
  | "approve-submission"
  | "send-back-to-dev"
  | "mark-as-live"
  | "stop-agent"
  | "generate-plan"
  | "approve-plan"
  | "approve-and-build"
  | "revise-plan"
  | "skip-to-plan"
  | "revise-plan-from-launch"
  | "send-for-qa"
  | "qa-fix-and-retest";

export interface PipelineActionPayload {
  epicId: string;
  epicTitle: string;
  action: PipelineAction;
  feedback?: string;
}

interface FleetBoardProps {
  issues: PlanIssue[];
  epicCosts?: Map<string, EpicCost>;
  onPipelineAction?: (payload: PipelineActionPayload) => void;
  agentRunning?: boolean;
}

const DEFAULT_SCALE = 1;
const SCALE_STEP = 0.1;
const MIN_SCALE = 0.5;
const MAX_SCALE = 1.5;

const STORAGE_KEY = "beads-fleet-visible-columns";

function loadVisibleColumns(): Set<FleetStage> {
  if (typeof window === "undefined") return new Set(FLEET_STAGES);
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as string[];
      const valid = parsed.filter((s): s is FleetStage =>
        FLEET_STAGES.includes(s as FleetStage),
      );
      if (valid.length > 0) return new Set(valid);
    }
  } catch {
    // ignore
  }
  return new Set(FLEET_STAGES);
}

function saveVisibleColumns(columns: Set<FleetStage>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...columns]));
  } catch {
    // ignore
  }
}

const TOOLBAR_BTN =
  "p-1.5 rounded-md text-gray-400 hover:text-gray-200 hover:bg-surface-2 transition-colors";

export function FleetBoard({ issues, epicCosts, onPipelineAction, agentRunning }: FleetBoardProps) {
  const [scale, setScale] = useState(DEFAULT_SCALE);
  const [visibleColumns, setVisibleColumns] = useState<Set<FleetStage>>(loadVisibleColumns);
  const [filterOpen, setFilterOpen] = useState(false);
  const filterRef = useRef<HTMLDivElement>(null);

  const apps = buildFleetApps(issues);

  const grouped = new Map<FleetStage, typeof apps>();
  for (const stage of FLEET_STAGES) {
    grouped.set(stage, []);
  }
  for (const app of apps) {
    grouped.get(app.stage)!.push(app);
  }

  // Sort each column by priority (P0 first)
  for (const [, bucket] of Array.from(grouped)) {
    bucket.sort((a, b) => a.epic.priority - b.epic.priority);
  }

  const zoomIn = () => setScale((s) => Math.min(MAX_SCALE, Math.round((s + SCALE_STEP) * 10) / 10));
  const zoomOut = () => setScale((s) => Math.max(MIN_SCALE, Math.round((s - SCALE_STEP) * 10) / 10));
  const zoomReset = () => setScale(DEFAULT_SCALE);

  const toggleColumn = useCallback((stage: FleetStage) => {
    setVisibleColumns((prev) => {
      const next = new Set(prev);
      if (next.has(stage)) {
        // Don't allow hiding all columns
        if (next.size > 1) next.delete(stage);
      } else {
        next.add(stage);
      }
      saveVisibleColumns(next);
      return next;
    });
  }, []);

  const showAllColumns = useCallback(() => {
    const all = new Set(FLEET_STAGES);
    setVisibleColumns(all);
    saveVisibleColumns(all);
  }, []);

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!filterOpen) return;
    function handleClick(e: MouseEvent) {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) {
        setFilterOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [filterOpen]);

  const allVisible = visibleColumns.size === FLEET_STAGES.length;
  const filteredStages = FLEET_STAGES.filter((s) => visibleColumns.has(s));

  return (
    <div className="flex flex-col flex-1">
      {/* Toolbar: column filter + zoom controls */}
      <div className="flex items-center gap-2 mb-2 justify-end">
        {/* Column filter */}
        <div className="relative" ref={filterRef}>
          <button
            onClick={() => setFilterOpen(!filterOpen)}
            className={`${TOOLBAR_BTN} ${!allVisible ? "text-blue-400" : ""}`}
            title="Filter columns"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
            </svg>
          </button>

          {filterOpen && (
            <div className="absolute right-0 top-full mt-1 w-52 rounded-md bg-surface-1 border border-border-default shadow-lg z-50 py-1">
              <div className="px-3 py-1.5 border-b border-border-default flex items-center justify-between">
                <span className="text-[10px] uppercase tracking-wide text-gray-500 font-medium">Columns</span>
                {!allVisible && (
                  <button
                    onClick={showAllColumns}
                    className="text-[10px] text-blue-400 hover:text-blue-300"
                  >
                    Show all
                  </button>
                )}
              </div>
              {FLEET_STAGES.map((stage) => {
                const cfg = FLEET_STAGE_CONFIG[stage];
                const checked = visibleColumns.has(stage);
                return (
                  <button
                    key={stage}
                    onClick={() => toggleColumn(stage)}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-surface-2 transition-colors"
                  >
                    <span
                      className={`w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 ${
                        checked
                          ? "bg-blue-500 border-blue-500"
                          : "border-gray-600"
                      }`}
                    >
                      {checked && (
                        <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </span>
                    <span className={`${cfg.dotColor} w-2 h-2 rounded-full shrink-0`} />
                    <span className={checked ? "text-gray-200" : "text-gray-500"}>
                      {cfg.label}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Divider */}
        <div className="w-px h-4 bg-border-default" />

        {/* Zoom controls */}
        <button onClick={zoomOut} className={TOOLBAR_BTN} title="Zoom out" disabled={scale <= MIN_SCALE}>
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <circle cx="11" cy="11" r="7" />
            <path strokeLinecap="round" d="M21 21l-4.35-4.35M8 11h6" />
          </svg>
        </button>
        <button onClick={zoomReset} className={TOOLBAR_BTN} title="Reset zoom">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <circle cx="11" cy="11" r="7" />
            <path strokeLinecap="round" d="M21 21l-4.35-4.35" />
          </svg>
        </button>
        <button onClick={zoomIn} className={TOOLBAR_BTN} title="Zoom in" disabled={scale >= MAX_SCALE}>
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <circle cx="11" cy="11" r="7" />
            <path strokeLinecap="round" d="M21 21l-4.35-4.35M8 11h6M11 8v6" />
          </svg>
        </button>
        {scale !== DEFAULT_SCALE && (
          <span className="text-[10px] text-gray-500 ml-1">{Math.round(scale * 100)}%</span>
        )}
      </div>

      {/* Board with CSS transform scaling */}
      <div className="flex-1 overflow-auto">
        <div
          className="flex gap-2 pb-4"
          style={{
            transform: `scale(${scale})`,
            transformOrigin: "top left",
            width: `${100 / scale}%`,
          }}
        >
          {filteredStages.map((stage) => (
            <FleetColumn
              key={stage}
              stage={stage}
              apps={grouped.get(stage) ?? []}
              epicCosts={epicCosts}
              onPipelineAction={onPipelineAction}
              agentRunning={agentRunning}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
