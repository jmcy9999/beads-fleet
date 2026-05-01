// =============================================================================
// Beads Fleet — Marker Routing Interpretation
// =============================================================================
//
// Pure function that maps marker content (status, next_agent, blocker_class)
// to a routing decision. Reusable by:
//   - dispatchChainAction inline branch (beads_web-kvn)
//   - reconciler rule (beads_web-xfc)
//
// Design source: factory-core-o4lx architect memo:
//   - § 4 (Q2) — blocker-class → next_agent mapping table
//   - § 6 (Q4) — precedence rule (lines 347-362)
//
// Schema source: factory-core/docs/architecture/marker-schema.md (ed9d3b4)
//   + factory-core/standards/generic/marker-protocol.md § 2
//
// Pure function discipline: interpretMarkerForRouting has NO I/O and NO side
// effects. Callers handle I/O (reading markers, dispatching agents).
// =============================================================================

import type { MarkerData } from "./marker-reader";

/**
 * Canonical set of agent types in the pipeline.
 *
 * 10-agent set per architect memo § 4 + bead ADDENDUM resolution:
 * includes product-manager (PM owns spec interpretation for spec-ambiguity).
 *
 * Canonical 10-agent list is documented in factory-core schema docs
 * (marker-protocol.md § 2 + marker-schema.md), synced by factory-core-o4lx.2.
 */
export type AgentType =
  | "architect"
  | "planner"
  | "builder"
  | "reviewer"
  | "qa"
  | "polish"
  | "test-spec"
  | "product-manager"
  | "operator"
  | "coherence";

/**
 * Result of interpreting a marker for routing purposes.
 *
 * - override=true: marker routing overrides pipeline-routes default.
 *   nextAgent is the agent type to dispatch.
 * - override=false: fall through to pipeline-routes default progression.
 *   nextAgent is undefined.
 */
export interface RoutingDecision {
  override: boolean;
  nextAgent?: AgentType;
  action?: string;
  reason: string;
}

/**
 * Snapshot of epic state provided by the caller. Used for context
 * in routing decisions. Placeholder — kvn/xfc will define the full shape.
 */
export interface EpicStateSnapshot {
  epicId: string;
  currentStage: string;
  labels: string[];
}

// ---------------------------------------------------------------------------
// Blocker-class → next_agent mapping table (per architect memo § 4, lines
// 279-289). Canonical. Unknown blocker_class values fall back to coherence.
// ---------------------------------------------------------------------------

const BLOCKER_CLASS_TO_AGENT: Record<string, AgentType> = {
  "design-question": "architect",
  "spec-ambiguity": "product-manager",
  "scope-conflict": "coherence",
  "test-fail": "builder",
  "file-conflict": "planner",
  "orchestrator-down": "operator",
};

// ---------------------------------------------------------------------------
// interpretMarkerForRouting — pure function, no I/O, no side effects
// ---------------------------------------------------------------------------

/**
 * Interpret a marker's routing fields and return a routing decision.
 *
 * Precedence rule (per architect memo § 6 Q4, lines 347-362):
 *   1. Explicit next_agent field → dispatch that agent (mechanical override)
 *   2. status=blocked + blocker_class → map via BLOCKER_CLASS_TO_AGENT table
 *   3. status=needs-decision + BLOCKER in whats_open → coherence
 *   4. status=success → override=false (fallback to pipeline-routes)
 *   5. status=failure → re-dispatch same agent
 *
 * Never throws. Returns override=false with explanatory reason for
 * invalid/unknown markers (loose schema discipline).
 *
 * @param marker - Parsed marker data (from readMarker)
 * @param snapshot - Current epic state snapshot (for context)
 * @returns Routing decision indicating whether to override pipeline-routes
 */
export function interpretMarkerForRouting(
  marker: MarkerData,
  _snapshot: EpicStateSnapshot,
): RoutingDecision {
  // Guard: invalid marker (missing status field)
  if (!marker.status) {
    return {
      override: false,
      reason: "invalid marker (missing status field)",
    };
  }

  // Precedence 1: Explicit next_agent field
  // next_agent ALWAYS wins over blocker_class and status-based inference.
  if (
    marker.next_agent &&
    typeof marker.next_agent === "string" &&
    marker.next_agent.trim() !== ""
  ) {
    return {
      override: true,
      nextAgent: marker.next_agent as AgentType,
      reason: "explicit next_agent field",
    };
  }

  // Precedence 2: status=blocked + blocker_class
  // Map blocker_class to next agent via canonical table.
  if (marker.status === "blocked" && marker.blocker_class) {
    const mappedAgent = BLOCKER_CLASS_TO_AGENT[marker.blocker_class];
    if (mappedAgent) {
      return {
        override: true,
        nextAgent: mappedAgent,
        reason: `blocker_class=${marker.blocker_class} maps to ${mappedAgent}`,
      };
    }
    // Unknown blocker_class → coherence fallback
    return {
      override: true,
      nextAgent: "coherence",
      reason: `unknown blocker_class=${marker.blocker_class}, fallback to coherence`,
    };
  }

  // Precedence 3: status=needs-decision + BLOCKER in whats_open
  // Existing 2m5z pattern: route to coherence for reasoning.
  if (marker.status === "needs-decision") {
    const hasBlocker = (marker.whats_open ?? []).some((item) =>
      item.trim().toUpperCase().startsWith("BLOCKER:"),
    );
    if (hasBlocker) {
      return {
        override: true,
        nextAgent: "coherence",
        reason: "needs-decision with BLOCKER in whats_open",
      };
    }
  }

  // Precedence 4: status=success → fallback to pipeline-routes
  if (marker.status === "success") {
    return {
      override: false,
      reason: "status=success, fallback to pipeline-routes",
    };
  }

  // Precedence 5: status=failure → re-dispatch same agent
  if (marker.status === "failure") {
    const sameAgent = marker.stage as AgentType;
    return {
      override: true,
      nextAgent: sameAgent,
      reason: "status=failure, re-dispatch same agent",
    };
  }

  // Fallback: no routing decision (status not recognized or
  // needs-decision without BLOCKER prefix in whats_open)
  return {
    override: false,
    reason: `no routing decision for status=${marker.status}`,
  };
}
