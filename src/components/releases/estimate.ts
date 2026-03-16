import type { PlanIssue } from "@/lib/types";

// ---------------------------------------------------------------------------
// Priority-weighted ETA for releases
// ---------------------------------------------------------------------------

/** Default weights (days per bead) when no project history is available. */
const DEFAULT_WEIGHTS: Record<number, number> = {
  0: 0.2,
  1: 0.5,
  2: 0.4,
  3: 5.0,
  4: 7.0,
};

/**
 * Compute average days-to-close per priority bucket from closed issues.
 * Falls back to DEFAULT_WEIGHTS for buckets with no data.
 */
export function computePriorityWeights(
  allIssues: PlanIssue[]
): Record<number, number> {
  const buckets = new Map<number, { totalDays: number; count: number }>();

  for (const issue of allIssues) {
    if (issue.status !== "closed") continue;
    if (!issue.created_at || !issue.closed_at) continue;

    const created = new Date(issue.created_at).getTime();
    const closed = new Date(issue.closed_at).getTime();
    if (isNaN(created) || isNaN(closed)) continue;

    const days = (closed - created) / (1000 * 60 * 60 * 24);
    if (days < 0) continue;

    const p = issue.priority ?? 2;
    const bucket = buckets.get(p) ?? { totalDays: 0, count: 0 };
    bucket.totalDays += days;
    bucket.count += 1;
    buckets.set(p, bucket);
  }

  const weights: Record<number, number> = { ...DEFAULT_WEIGHTS };
  for (const [priority, bucket] of buckets) {
    if (bucket.count >= 3) {
      // Only use project data if we have enough samples
      weights[priority] = bucket.totalDays / bucket.count;
    }
  }

  return weights;
}

/**
 * Compute recent velocity: beads closed per calendar day over the last N days.
 * Returns 0 if no beads were closed recently.
 */
export function computeVelocity(
  allIssues: PlanIssue[],
  windowDays = 14
): number {
  const now = Date.now();
  const cutoff = now - windowDays * 24 * 60 * 60 * 1000;

  let closedInWindow = 0;
  for (const issue of allIssues) {
    if (issue.status !== "closed" || !issue.closed_at) continue;
    const closed = new Date(issue.closed_at).getTime();
    if (isNaN(closed)) continue;
    if (closed >= cutoff) closedInWindow++;
  }

  return closedInWindow / windowDays;
}

export interface ReleaseEstimate {
  /** Total weighted bead-days of remaining work. */
  beadDays: number;
  /** Estimated calendar days to complete (beadDays / velocity). */
  calendarDays: number | null;
  /** Whether we have enough data to show an estimate. */
  hasEstimate: boolean;
  /** Display string like "~3 days" or "~2 weeks" or "No estimate". */
  display: string;
}

/**
 * Estimate remaining calendar days for a set of open release issues.
 */
export function estimateRelease(
  releaseIssues: PlanIssue[],
  weights: Record<number, number>,
  velocity: number
): ReleaseEstimate {
  const openIssues = releaseIssues.filter((i) => i.status !== "closed");

  if (openIssues.length === 0) {
    return { beadDays: 0, calendarDays: 0, hasEstimate: true, display: "Complete" };
  }

  let beadDays = 0;
  for (const issue of openIssues) {
    const p = issue.priority ?? 2;
    beadDays += weights[p] ?? weights[2] ?? 0.5;
  }

  if (velocity <= 0) {
    return { beadDays, calendarDays: null, hasEstimate: false, display: "No estimate" };
  }

  const calendarDays = Math.ceil(beadDays / velocity);

  return {
    beadDays,
    calendarDays,
    hasEstimate: true,
    display: formatDays(calendarDays),
  };
}

function formatDays(days: number): string {
  if (days <= 0) return "< 1 day";
  if (days === 1) return "~1 day";
  if (days < 7) return `~${days} days`;
  const weeks = Math.round(days / 7);
  if (weeks === 1) return "~1 week";
  if (days < 30) return `~${weeks} weeks`;
  const months = Math.round(days / 30);
  if (months === 1) return "~1 month";
  return `~${months} months`;
}
