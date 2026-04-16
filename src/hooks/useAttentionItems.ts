"use client";

// =============================================================================
// useAttentionItems — derive human-review attention items from useIssues data
// =============================================================================
//
// Pure derivation hook. Accepts the PlanIssue[] already fetched by useIssues
// and returns:
//   - allItems:      flat array of AttentionItem across all epics
//   - countByEpic:   Map<epicId, AttentionItem[]> for card-level rendering
//   - totalCount:    total number of attention items (for the header badge)
//
// Key design constraints (from factory-core-509 architecture):
//   - ADR-002 Single Source of Truth — the badge count and card indicators
//     must derive from the same data, so both are computed here in one pass.
//   - Derivation only — no separate polling, no API call. When useIssues
//     refetches (every 15s per 509.3), the derivation re-runs through normal
//     React render propagation.
//   - useMemo keys on the array reference, so the computation is skipped
//     when TanStack Query returns the same object between renders.
//
// See fleet-utils.ts for `getAttentionItems` and the AttentionItem shape.
// (factory-core-509.4)
// =============================================================================

import { useMemo } from "react";
import type { PlanIssue } from "@/lib/types";
import {
  buildFleetApps,
  getAttentionItems,
  type AttentionItem,
} from "@/components/fleet/fleet-utils";

export interface UseAttentionItemsResult {
  /** All attention items across every epic in the fleet, in a flat array. */
  allItems: AttentionItem[];
  /** Map of epicId → the attention items belonging to that epic. */
  countByEpic: Map<string, AttentionItem[]>;
  /** Total number of attention items — drives the header badge count. */
  totalCount: number;
}

const EMPTY_RESULT: UseAttentionItemsResult = {
  allItems: [],
  countByEpic: new Map(),
  totalCount: 0,
};

/**
 * Derive attention items from the list of all issues.
 *
 * Pure: does not fetch, poll, or cache anything beyond React's render loop.
 * Returns a stable empty result when `allIssues` is empty or undefined so
 * callers can rely on the shape regardless of loading state.
 */
export function useAttentionItems(
  allIssues: PlanIssue[] | undefined,
): UseAttentionItemsResult {
  return useMemo(() => {
    if (!allIssues || allIssues.length === 0) return EMPTY_RESULT;

    const apps = buildFleetApps(allIssues);
    const allItems: AttentionItem[] = [];
    const countByEpic = new Map<string, AttentionItem[]>();

    for (const app of apps) {
      const items = getAttentionItems(app);
      if (items.length === 0) continue;

      // Group by epic for FleetCard rendering.
      countByEpic.set(app.epic.id, items);

      // Flat list for the header badge total and any page-level listings.
      for (const item of items) allItems.push(item);
    }

    return { allItems, countByEpic, totalCount: allItems.length };
  }, [allIssues]);
}
