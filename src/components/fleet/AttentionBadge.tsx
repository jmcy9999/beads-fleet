"use client";

// =============================================================================
// AttentionBadge — header pill showing total attention items across the fleet
// =============================================================================
//
// Renders a small amber pill in the fleet page header so Jane can see at a
// glance how many human review gates are outstanding, even when the relevant
// cards are scrolled off screen.
//
// Design notes:
//   - Count is passed in as a prop from useAttentionItems (ADR-002 single
//     source of truth). The badge never recomputes — card indicators and the
//     badge always agree.
//   - Returns null when count === 0 (never render "0") so the header stays
//     quiet when there is nothing to do.
//   - Amber styling matches AttentionBanner for visual consistency.
//
// (factory-core-509.6)
// =============================================================================

interface AttentionBadgeProps {
  /** Total number of attention items needing human action. */
  count: number;
}

export function AttentionBadge({ count }: AttentionBadgeProps) {
  if (count <= 0) return null;

  const label = count === 1 ? "1 item needs attention" : `${count} items need attention`;

  return (
    <span
      role="status"
      aria-label={label}
      title={label}
      data-testid="attention-badge"
      className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/15 px-2.5 py-0.5 text-xs font-semibold text-amber-300"
    >
      <span
        className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400"
        aria-hidden="true"
      />
      {count}
      <span className="sr-only">{label}</span>
    </span>
  );
}
