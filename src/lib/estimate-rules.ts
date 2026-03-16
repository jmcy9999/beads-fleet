// =============================================================================
// Label-based risk modifiers for time estimates
// =============================================================================
//
// When beads have labels indicating risk factors, apply additional time
// buffers to their estimates. These modifiers stack additively.
//

/** Risk modifier: additional minutes to add when a label is present. */
export const RISK_MODIFIERS: Record<string, number> = {
  "external-api": 2160,          // +36 hours — third-party unknowns
  "architecture-change": 1440,   // +24 hours — multi-layer ripple effects
  "ui-polish": 2880,             // +48 hours — design iteration cycles
  "needs-testing": 1440,         // +24 hours — test coverage burden
  "compliance": 960,             // +16 hours — legal/regulatory review
  "performance": 720,            // +12 hours — profiling and optimization
  "migration": 1440,             // +24 hours — data migration risk
};

/** Base estimate (minutes) by issue type when no explicit estimate exists. */
export const BASE_MINUTES: Record<string, number> = {
  bug: 30,        // ~0.5 hours
  task: 120,      // ~2 hours
  feature: 240,   // ~4 hours
  epic: 480,      // ~8 hours (tracking overhead)
};

/**
 * Apply risk modifiers to a base estimate based on issue labels.
 * Returns the adjusted estimate in minutes.
 */
export function applyRiskModifiers(
  baseMinutes: number,
  labels: string[]
): number {
  let adjusted = baseMinutes;
  for (const label of labels) {
    if (label in RISK_MODIFIERS) {
      adjusted += RISK_MODIFIERS[label];
    }
  }
  return adjusted;
}

/**
 * Compute a full estimate for an issue:
 * 1. Use estimated_minutes if present
 * 2. Otherwise use BASE_MINUTES for the issue type
 * 3. Apply risk modifiers from labels
 */
export function computeEstimate(
  estimatedMinutes: number | undefined,
  issueType: string,
  labels: string[]
): number {
  const base = (estimatedMinutes != null && estimatedMinutes > 0)
    ? estimatedMinutes
    : (BASE_MINUTES[issueType] ?? BASE_MINUTES.task);
  return applyRiskModifiers(base, labels);
}
