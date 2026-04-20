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
// Extended by factory-core-3yqr.1 (ADR-002) with `auto_chain_stages` map and
// the `autoChainEnabled(stage)` typed accessor that gates the four new chain
// transitions (research → PM → Architect → Planner → start-wave).
//
// See:
//   - docs/research/plan-review-by-reviewer-agent-architecture.md (k7gy)
//   - docs/research/full-auto-chain-one-click-epic-execution-architecture.md (3yqr)
// =============================================================================

import { readFileSync } from "fs";
import * as path from "path";

/**
 * The four pipeline stages that support auto-chain per factory-core-3yqr.
 *
 * Exported as a runtime `as const` tuple so consumers (and tests) can
 * enumerate the supported stages at runtime — TypeScript union types are
 * erased at runtime, so without this constant the `AutoChainStage` type
 * cannot be iterated. Deriving the union from the tuple (see below) ensures
 * the two surfaces cannot drift out of sync.
 *
 * Internal guardrail 7: the canonical list lives here; `fleet.json`'s
 * `features.auto_chain_stages` default keys must match this list exactly.
 * The drift test in `fleet-config.auto-chain.test.ts` enforces that match.
 */
export const AUTO_CHAIN_STAGES = [
  "research",
  "product-spec",
  "architecture",
  "test-spec",
] as const;

/**
 * Union of the four supported auto-chain stage names.
 *
 * Derived from {@link AUTO_CHAIN_STAGES} so adding / removing a stage happens
 * in exactly one place. `autoChainEnabled(stage)` accepts any `string` and
 * narrows to this union via {@link isAutoChainStage}; anything outside the
 * union returns `false` (regression pattern #7 — Type Confusion on Enum
 * Branching).
 */
export type AutoChainStage = (typeof AUTO_CHAIN_STAGES)[number];

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

  /**
   * Per-stage kill switches for the four auto-chain transitions introduced by
   * factory-core-3yqr (F1). Always fully populated by the loader — missing
   * stages in the on-disk `features.auto_chain_stages` map default to `false`
   * here so downstream code can index without undefined checks.
   */
  auto_chain_stages: Record<AutoChainStage, boolean>;
}

// Fail-safe defaults — also the return value on every error path.
const DEFAULT_CONFIG: FleetConfig = {
  plan_review_auto_chain: false,
  auto_chain_stages: {
    research: false,
    "product-spec": false,
    architecture: false,
    "test-spec": false,
  },
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
 * Read the feature flags from fleet.json.
 *
 * Returns {@link DEFAULT_CONFIG} (all flags `false`) on any failure — missing
 * file, malformed JSON, absent key, non-boolean value. Never throws.
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

/**
 * Type guard for {@link AutoChainStage}. Returns `true` iff `stage` is one of
 * the four recognised stage names (exact, case-sensitive — no trim, no case
 * normalisation). Used by {@link autoChainEnabled} to reject unknown names
 * and by tests to enumerate valid stages.
 */
export function isAutoChainStage(stage: string): stage is AutoChainStage {
  return (AUTO_CHAIN_STAGES as readonly string[]).includes(stage);
}

/**
 * Return `true` iff the auto-chain transition for the given stage is
 * enabled in `fleet.json`'s `features.auto_chain_stages` map.
 *
 * Unknown stage names, non-boolean values, missing keys, missing file,
 * malformed JSON — every failure mode returns `false` (fail-closed per
 * regression pattern #13; explicit opt-in per F9 bake-in).
 *
 * This function NEVER throws.
 *
 * @param stage a stage name; only {@link AutoChainStage} values can return true
 * @returns `true` iff the corresponding flag is `=== true` on disk
 */
export function autoChainEnabled(stage: string): boolean {
  if (!isAutoChainStage(stage)) {
    return false;
  }
  const config = readFleetConfig();
  return config.auto_chain_stages[stage] === true;
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

  const autoChainStages = readAutoChainStages(features as object);

  return {
    plan_review_auto_chain: planReviewAutoChain,
    auto_chain_stages: autoChainStages,
  };
}

/**
 * Read and sanitise the `features.auto_chain_stages` map.
 *
 * Missing / non-object section → all four stages `false`, no warning (this is
 * the shipped state for a freshly cloned repo without the key; not a
 * misconfiguration).
 *
 * Per-stage rules:
 *   - Missing key → `false`, no warning.
 *   - Literal `true` → `true`.
 *   - Literal `false` → `false`, no warning.
 *   - Anything else (non-boolean) → `false` and a `console.warn` naming the
 *     offending stage and bad value. Regression pattern #8 — strict boolean,
 *     no truthy coercion; regression pattern #13 — fail closed, never throw.
 */
function readAutoChainStages(
  features: object,
): Record<AutoChainStage, boolean> {
  const result: Record<AutoChainStage, boolean> = {
    research: false,
    "product-spec": false,
    architecture: false,
    "test-spec": false,
  };

  const rawSection = (features as { auto_chain_stages?: unknown })
    .auto_chain_stages;
  if (!rawSection || typeof rawSection !== "object") {
    // Missing / non-object → all false, no warning (shipped state).
    return result;
  }

  const section = rawSection as Record<string, unknown>;
  for (const stage of AUTO_CHAIN_STAGES) {
    const rawValue = section[stage];
    if (rawValue === undefined) {
      // Missing stage key → false, no warning.
      continue;
    }
    if (rawValue === true) {
      result[stage] = true;
    } else if (rawValue === false) {
      // Explicit false — no warning (shipped state).
      result[stage] = false;
    } else {
      // Non-boolean value present. Default to false and log once so a
      // misconfiguration in fleet.json is debuggable.
      console.warn(
        `[fleet-config] features.auto_chain_stages.${stage} must be a boolean; ` +
          `got ${JSON.stringify(rawValue)}. Using false.`,
      );
      result[stage] = false;
    }
  }

  return result;
}
