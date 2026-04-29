"use client";

// =============================================================================
// FleetColumn — virtualised column on the FleetBoard. (factory-core-3p1e.9)
// =============================================================================
//
// Cards are rendered through `react-window`'s VariableSizeList so a single
// dashboard with 50+ projects only paints the visible rows on first
// render. Per-row height comes from `estimateCardHeight` (a pure function
// over each FleetApp). The list re-measures whenever the apps array
// reference changes.
//
// Layout:
//   - Column wrapper: min/max-width clamped, flex-col, fills parent height
//     (h-full) so the inner list has a real height to bind to.
//   - Header: pinned to the top, not virtualised.
//   - List wrapper: flex-1 min-h-0 so it consumes whatever space remains;
//     ResizeObserver feeds the measured height to VariableSizeList.
//
// =============================================================================

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  VariableSizeList,
  type ListChildComponentProps,
} from "react-window";
import { FleetCard } from "./FleetCard";
import { estimateCardHeight } from "./estimateCardHeight";
import {
  FLEET_STAGE_CONFIG,
  type FleetApp,
  type FleetStage,
  type EpicCost,
  type AttentionItem,
} from "./fleet-utils";
import type { PipelineActionPayload } from "./FleetBoard";

interface FleetColumnProps {
  stage: FleetStage;
  apps: FleetApp[];
  epicCosts?: Map<string, EpicCost>;
  onPipelineAction?: (payload: PipelineActionPayload) => void;
  agentRunning?: boolean;
  pendingEpicId?: string | null;
  langfuseTraceUrls?: Map<string, string>;
  /** Per-epic attention items (factory-core-509.7). */
  attentionByEpic?: Map<string, AttentionItem[]>;
}

/**
 * Fallback height (px) used by the VariableSizeList until the
 * ResizeObserver feeds the real measurement. Sized to fit ~3 typical
 * cards, enough for the first frame to look reasonable and for component
 * tests in jsdom (where layout returns 0) to render visible rows.
 */
const FALLBACK_LIST_HEIGHT = 600;

/**
 * useLayoutEffect on the client, useEffect on the server. Avoids Next.js's
 * "useLayoutEffect on the server" warning during SSR/RSC rendering.
 */
const useIsoLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

export function FleetColumn({
  stage,
  apps,
  epicCosts,
  onPipelineAction,
  agentRunning,
  pendingEpicId,
  langfuseTraceUrls,
  attentionByEpic,
}: FleetColumnProps) {
  const config = FLEET_STAGE_CONFIG[stage];
  const wrapperRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<VariableSizeList>(null);
  const [containerHeight, setContainerHeight] = useState(0);

  // ---------------------------------------------------------------------
  // Measure the wrapper with ResizeObserver. VariableSizeList demands a
  // numeric `height` prop, so the wrapper's flex-1 height is observed and
  // forwarded to the list. The list re-renders when the column resizes
  // (window resize, dashboard layout shifts).
  // ---------------------------------------------------------------------
  useIsoLayoutEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const h = entries[0]?.contentRect.height ?? 0;
      setContainerHeight(h);
    });
    ro.observe(el);
    // Seed an initial value so the list paints on first effect tick
    // without waiting for the first ResizeObserver callback.
    setContainerHeight(el.getBoundingClientRect().height);
    return () => ro.disconnect();
  }, []);

  // ---------------------------------------------------------------------
  // Reset VariableSizeList's internal itemSize cache whenever the apps
  // array reference changes — fresh data, sort, or filter changes can
  // alter row heights even when length is unchanged. resetAfterIndex(0)
  // invalidates every memoised size and triggers a re-render.
  // ---------------------------------------------------------------------
  useEffect(() => {
    listRef.current?.resetAfterIndex(0);
  }, [apps]);

  // ---------------------------------------------------------------------
  // Per-row size lambda — looks up the FleetApp at the given index and
  // calls the pure estimator. VariableSizeList memoises this internally.
  // ---------------------------------------------------------------------
  const getItemSize = (index: number) => estimateCardHeight(apps[index]);

  // ---------------------------------------------------------------------
  // Row renderer. The `style` prop from VariableSizeList absolute-positions
  // the row within the scroll container; we wrap it in a div with light
  // horizontal padding to mirror the pre-virtualisation `px-0.5`. The
  // CARD_GAP baked into estimateCardHeight produces the visible space
  // between cards (the card naturally renders shorter than the row's
  // total height; the difference is whitespace below).
  // ---------------------------------------------------------------------
  function Row({ index, style }: ListChildComponentProps) {
    const app = apps[index];
    return (
      <div style={style} className="px-0.5">
        <FleetCard
          app={app}
          cost={epicCosts?.get(app.epic.id)}
          onPipelineAction={onPipelineAction}
          agentRunning={agentRunning}
          pendingEpicId={pendingEpicId}
          langfuseTraceUrl={langfuseTraceUrls?.get(app.epic.id)}
          attentionItems={attentionByEpic?.get(app.epic.id)}
        />
      </div>
    );
  }

  return (
    <div className="min-w-[180px] max-w-[220px] flex-shrink-0 flex flex-col h-full">
      {/* Column header */}
      <div className="flex items-center gap-1.5 px-2 py-1.5 mb-2">
        <span
          className={`h-2 w-2 rounded-full ${config.dotColor}`}
          aria-hidden="true"
        />
        <h2 className={`text-xs font-medium ${config.color} truncate uppercase tracking-wide`}>
          {config.label}
        </h2>
        <span className="ml-auto rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-gray-400">
          {apps.length}
        </span>
      </div>

      {/* Virtualised card list. A fallback height (FALLBACK_LIST_HEIGHT)
          is used until the ResizeObserver has fed the real measurement —
          ensures the list renders inside test environments (jsdom) where
          getBoundingClientRect returns 0, and avoids a one-frame blank
          column before useLayoutEffect runs in the browser. */}
      <div ref={wrapperRef} className="flex-1 min-h-0">
        {apps.length === 0 ? (
          <p className="text-center text-sm text-gray-500 py-8">No apps</p>
        ) : (
          <VariableSizeList
            ref={listRef}
            height={containerHeight > 0 ? containerHeight : FALLBACK_LIST_HEIGHT}
            width="100%"
            itemCount={apps.length}
            itemSize={getItemSize}
            overscanCount={3}
          >
            {Row}
          </VariableSizeList>
        )}
      </div>
    </div>
  );
}
