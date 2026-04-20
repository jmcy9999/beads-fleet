// =============================================================================
// Beads Fleet — fleet.json Configuration Reader
// =============================================================================
//
// Typed accessor for runtime feature flags stored in fleet-core's fleet.json.
//
// Resolves the config file via `path.join(process.cwd(), "fleet.json")` so the
// reader adapts to whichever Shipyard root hosts the dev server. No absolute
// paths are inlined (internal guardrail #1 — single-source paths).
//
// Every read is FAIL-CLOSED (regression pattern #13). Missing file, malformed
// JSON, absent `features` object, absent key, or a non-boolean value all
// resolve to the safest value: `false`. The accessor NEVER throws.
//
// Added by factory-core-k7gy.3 (ADR-003) to gate the plan-review auto-chain.
// See docs/research/plan-review-by-reviewer-agent-architecture.md.
// =============================================================================

import { readFileSync } from "fs";
import * as path from "path";

/**
 * Typed view of the `features` section of fleet.json. Only keys consumed by
 * beads_web are listed here — other files may add keys, but this accessor is
 * the single source of truth for what beads_web reads.
 */
export interface FleetConfig {
  /**
   * Kill switch for the plan-review auto-chain introduced by factory-core-k7gy.
   * When `true`, planner exit auto-launches the reviewer and PASS/REVISE
   * verdicts flow without owner clicks. When `false` (default), the legacy
   * owner-click approve-and-build path is used.
   */
  plan_review_auto_chain: boolean;
}

// Fail-safe defaults — also the return value on every error path.
const DEFAULT_CONFIG: FleetConfig = {
  plan_review_auto_chain: false,
};

/**
 * Module-level cache. Populated on the first successful or failed read and
 * returned from subsequent calls within the same process. Satisfies the F9
 * non-functional requirement (accessor latency < 5ms on cache hits).
 *
 * `null` means "not yet read"; any non-null value is a cached result.
 */
let cachedConfig: FleetConfig | null = null;

/**
 * Read the plan-review feature flag (and any future flags) from fleet.json.
 *
 * Returns {@link DEFAULT_CONFIG} (`plan_review_auto_chain: false`) on any
 * failure — missing file, malformed JSON, absent key, non-boolean value.
 * Never throws.
 *
 * @returns a {@link FleetConfig} with guaranteed typed fields
 */
export function readFleetConfig(): FleetConfig {
  if (cachedConfig !== null) {
    return cachedConfig;
  }

  const configPath = path.join(process.cwd(), "fleet.json");
  cachedConfig = loadAndParse(configPath);
  return cachedConfig;
}

/**
 * Reset the module-level cache. Intended for tests only — production code
 * should never need to invalidate the cache within a process.
 */
export function resetFleetConfigCache(): void {
  cachedConfig = null;
}

// ---------------------------------------------------------------------------
// Internal — fail-closed load and sanitise
// ---------------------------------------------------------------------------

function loadAndParse(configPath: string): FleetConfig {
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch {
    // Missing file, permission error, or any other I/O failure → default.
    return DEFAULT_CONFIG;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Truncated / malformed JSON → default.
    return DEFAULT_CONFIG;
  }

  if (!parsed || typeof parsed !== "object") {
    return DEFAULT_CONFIG;
  }

  const features = (parsed as { features?: unknown }).features;
  if (!features || typeof features !== "object") {
    return DEFAULT_CONFIG;
  }

  const rawFlag = (features as { plan_review_auto_chain?: unknown })
    .plan_review_auto_chain;

  // Strict boolean check — no truthy-string coercion, no `1 !== true` surprises.
  // Regression pattern #8: sanitise settings even when the framework is lax.
  const planReviewAutoChain = rawFlag === true;

  return { plan_review_auto_chain: planReviewAutoChain };
}
