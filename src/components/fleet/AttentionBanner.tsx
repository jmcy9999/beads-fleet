"use client";

// =============================================================================
// AttentionBanner — amber attention indicators rendered on a FleetCard
// =============================================================================
//
// Surfaces checkpoint hooks and human-review gates that need Jane's attention.
// One banner per AttentionItem; multiple items stack vertically. Each banner
// carries a reason line and one action button (Approve or Dismiss) which
// dispatches through the parent onAction callback.
//
// Design notes:
//   - Extracted as a standalone component per ADR-004 — FleetCard is already
//     ~993 lines and integration should be minimal.
//   - Styling matches AgentStatusBanner (dark theme, amber accent) so the
//     indicator reads as an attention flag, not an error/warning.
//   - Detection happens upstream in useAttentionItems (ADR-002 single source
//     of truth). This component is a dumb renderer — regression-patterns #5.
//   - Action buttons show an inline spinner and disable while processing so
//     rapid double-clicks cannot fire two human-approve requests.
//
// (factory-core-509.5)
// =============================================================================

import { useState } from "react";
import type { AttentionItem } from "./fleet-utils";

interface AttentionBannerProps {
  /** Attention items to render. Empty array → component returns null. */
  items: AttentionItem[];
  /**
   * Called when the user clicks an action button.
   * The parent wires this through usePipelineAction with the item's
   * epicId / targetLabel / beadId payload.
   */
  onAction: (item: AttentionItem, actionName: string) => void;
}

/** Inline spinner for the action buttons while a request is in flight. */
function Spinner() {
  return (
    <svg
      className="animate-spin -ml-0.5 mr-1.5 h-3 w-3 inline-block"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

export function AttentionBanner({ items, onAction }: AttentionBannerProps) {
  // Track which item is currently pending so we can disable its buttons
  // locally while the mutation runs. We use the banner's stable `id` as the
  // key — resolved upstream in fleet-utils (epic+label or epic+bead).
  const [pendingId, setPendingId] = useState<string | null>(null);

  if (items.length === 0) return null;

  function handleClick(
    e: React.MouseEvent<HTMLButtonElement>,
    item: AttentionItem,
    actionName: string,
  ) {
    // The banners live inside the FleetCard's <Link> wrapper, so we must stop
    // the click from navigating to the issue detail page.
    e.preventDefault();
    e.stopPropagation();
    if (pendingId) return;
    setPendingId(item.id);
    try {
      onAction(item, actionName);
    } finally {
      // Reset in the next tick so the click registration completes before
      // the component re-renders; TanStack Query's onSettled elsewhere will
      // refetch and the item should disappear from `items`, at which point
      // the state is moot. Keeping a short guard prevents double-dispatch.
      setTimeout(() => setPendingId(null), 500);
    }
  }

  return (
    <div
      className="mt-2 space-y-1.5"
      data-testid="attention-banner-list"
    >
      {items.map((item) => {
        const isPending = pendingId === item.id;
        return (
          <div
            key={item.id}
            role="status"
            aria-label={item.reason}
            className="flex items-center justify-between gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5"
          >
            <div className="min-w-0 flex items-center gap-2">
              <span
                className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400"
                aria-hidden="true"
              />
              <div className="min-w-0">
                <p className="text-xs font-medium text-amber-300 truncate">
                  {item.reason}
                </p>
                {item.beadTitle && (
                  <p className="text-[11px] text-amber-400/70 truncate">
                    {item.beadId ? `${item.beadId}: ` : ""}
                    {item.beadTitle}
                  </p>
                )}
              </div>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              {item.actions.map((action) => (
                <button
                  key={action.name}
                  type="button"
                  onClick={(e) => handleClick(e, item, action.name)}
                  disabled={isPending}
                  aria-label={`${action.label} — ${item.reason}`}
                  className="px-2 py-1 text-[11px] font-medium rounded-md text-amber-300 hover:text-amber-200 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isPending && <Spinner />}
                  {action.label}
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
