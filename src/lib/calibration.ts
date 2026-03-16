// =============================================================================
// Historical calibration — learn from closed beads to correct estimate bias
// =============================================================================
//
// Compares estimated_minutes against actual time (created → closed) for
// closed beads. Produces per-bucket (issue_type × priority) multipliers
// that correct systematic over/under-estimation.
//

import type { PlanIssue } from "./types";

export interface CalibrationFactors {
  [bucket: string]: { factor: number; sampleCount: number };
}

const MIN_SAMPLES = 5;

/**
 * Compute calibration factors from closed beads that have both
 * estimated_minutes and created_at/closed_at timestamps.
 *
 * Returns a map of "type_pN" → { factor, sampleCount }.
 * A factor > 1.0 means estimates are too low (work takes longer).
 * A factor < 1.0 means estimates are too high (work is faster).
 */
export function computeCalibration(allIssues: PlanIssue[]): CalibrationFactors {
  const buckets = new Map<
    string,
    { totalEstimated: number; totalActual: number; count: number }
  >();

  for (const issue of allIssues) {
    if (issue.status !== "closed") continue;
    if (
      issue.estimated_minutes == null ||
      issue.estimated_minutes <= 0 ||
      !issue.created_at ||
      !issue.closed_at
    )
      continue;

    const created = new Date(issue.created_at).getTime();
    const closed = new Date(issue.closed_at).getTime();
    if (isNaN(created) || isNaN(closed)) continue;

    const actualMinutes = (closed - created) / (1000 * 60);
    if (actualMinutes < 0) continue;

    const bucket = `${issue.issue_type}_p${issue.priority ?? 2}`;
    const data = buckets.get(bucket) ?? {
      totalEstimated: 0,
      totalActual: 0,
      count: 0,
    };
    data.totalEstimated += issue.estimated_minutes;
    data.totalActual += actualMinutes;
    data.count++;
    buckets.set(bucket, data);
  }

  const factors: CalibrationFactors = {};
  for (const [bucket, data] of buckets) {
    if (data.count >= MIN_SAMPLES && data.totalEstimated > 0) {
      factors[bucket] = {
        factor: data.totalActual / data.totalEstimated,
        sampleCount: data.count,
      };
    }
  }

  return factors;
}

/**
 * Apply a calibration factor to an estimate.
 * Returns the original estimate if no calibration data exists for the bucket.
 */
export function applyCalibratedEstimate(
  estimateMinutes: number,
  issueType: string,
  priority: number,
  factors: CalibrationFactors
): number {
  const bucket = `${issueType}_p${priority}`;
  const entry = factors[bucket];
  if (!entry) return estimateMinutes;
  return Math.round(estimateMinutes * entry.factor);
}

/**
 * Check if enough calibration data exists to be useful.
 */
export function hasCalibrationData(factors: CalibrationFactors): boolean {
  return Object.keys(factors).length > 0;
}
