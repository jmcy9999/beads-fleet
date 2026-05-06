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
// Universal coherence routing extension (factory-core-wlsr.3):
//   Per ADR-001 (stage-aware rewrite at routing layer), ADR-003 (operator
//   action mapping retained, gated upstream) and ADR-004 (unknown stage =
//   fail-safe loop-agent), the precedence rules below intercept any
//   non-success outcome from a loop agent and route it to coherence.
//   Coherence's escalation path remains open: when stage="coherence", the
//   marker's next_agent="operator" is preserved as a legitimate escalation
//   per operator-set principle P1.
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
 * Closed set of loop-agent stages — the 8 agents that participate in the
 * autonomous pipeline loop. Per ADR-001 (factory-core-wlsr.3), these are the
 * stages whose markers are subject to the operator→coherence rewrite. Two
 * AgentType values are intentionally excluded:
 *
 *   - "coherence": coherence is the universal off-ramp; its own escalation
 *     to operator is legitimate and must NOT be rewritten back to itself
 *     (would create infinite recursion). See ADR-001's escape hatch.
 *   - "operator": operator is the human, never a loop agent.
 *
 * Maintenance contract: when adding a new loop-agent type, update this set
 * AND AgentType together. Adding without updating leaves the new agent's
 * markers exempt from the rewrite (a loop-agent could route directly to
 * operator and bypass coherence). Per ADR-004, unknown stage values are
 * treated as loop-agent (fail-safe) — so the omission is safe by default,
 * but explicit membership keeps the contract auditable.
 */
export const LOOP_AGENT_STAGES: ReadonlySet<string> = new Set([
  "architect",
  "planner",
  "builder",
  "reviewer",
  "qa",
  "polish",
  "test-spec",
  "product-manager",
]);

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
// Helpers
// ---------------------------------------------------------------------------

/**
 * Detect a BLOCKER:-prefixed item in whats_open. Reuses the existing
 * Precedence 3 predicate so BLOCKER detection stays consistent across
 * Precedences 2.6 and 3 (factory-core-wlsr.3 risk-flag).
 */
function hasBlockerInWhatsOpen(whatsOpen: string[] | undefined): boolean {
  return (whatsOpen ?? []).some((item) =>
    item.trim().toUpperCase().startsWith("BLOCKER:"),
  );
}

// ---------------------------------------------------------------------------
// interpretMarkerForRouting — pure function, no I/O, no side effects
// ---------------------------------------------------------------------------

/**
 * Interpret a marker's routing fields and return a routing decision.
 *
 * Precedence rule (per architect memo § 6 Q4 + factory-core-wlsr.3
 * ADR-001/003/004 universal coherence routing extension):
 *
 *   1.5 (NEW). next_agent="operator" + stage∈LOOP_AGENT_STAGES (or unknown
 *              stage per ADR-004 fail-safe) → rewrite to coherence
 *              (loop agents NEVER route directly to operator).
 *              ESCAPE HATCH: stage="coherence" preserves operator routing
 *              (coherence's legitimate escalation per ADR-001).
 *   1. Explicit next_agent field → dispatch that agent (mechanical override)
 *   2. status=blocked + blocker_class → map via BLOCKER_CLASS_TO_AGENT table
 *   2.5. status=blocked + no blocker_class → coherence safety net
 *   2.6 (NEW). status=success + BLOCKER: in whats_open → coherence
 *              (success-with-blockers is uncertainty, route via coherence).
 *   3. status=needs-decision + BLOCKER in whats_open → coherence
 *   3.5 (NEW). status=needs-decision + no BLOCKER → coherence
 *              (was: fallthrough to override=false, now treated as
 *              non-success outcome per operator-set principle P2).
 *   4. status=success → override=false (fallback to pipeline-routes)
 *   5 (CHANGED). status=failure → coherence (was: re-dispatch same agent;
 *                changed because failure is a non-success outcome that
 *                merits coherence reasoning, not blind re-dispatch).
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

  // Precedence 1.5 (factory-core-wlsr.3, ADR-001): stage-aware operator→
  // coherence rewrite. Loop agents NEVER route directly to operator. Must
  // run BEFORE Precedence 1 (explicit next_agent), otherwise next_agent=
  // operator would be returned unrewritten.
  //
  // Discriminator:
  //   - stage ∈ LOOP_AGENT_STAGES → rewrite (loop agent caller)
  //   - stage = "coherence" → preserve (legitimate escalation; ADR-001
  //     escape hatch — prevents coherence from looping to itself)
  //   - stage missing/unknown → rewrite (ADR-004 fail-safe: treat unknown
  //     as loop-agent to prevent slip-through bugs)
  if (
    marker.next_agent &&
    typeof marker.next_agent === "string" &&
    marker.next_agent.trim() === "operator"
  ) {
    const stage =
      typeof marker.stage === "string" ? marker.stage.trim() : undefined;
    const isCoherenceCaller = stage === "coherence";
    if (!isCoherenceCaller) {
      const isLoopAgent = stage ? LOOP_AGENT_STAGES.has(stage) : false;
      const stageDescriptor = stage
        ? isLoopAgent
          ? `stage=${stage}`
          : `unknown stage=${stage}`
        : "missing stage";
      return {
        override: true,
        nextAgent: "coherence",
        reason: `stage-aware rewrite: ${stageDescriptor} + next_agent=operator → coherence (loop agents never route directly to operator per ADR-001)`,
      };
    }
    // stage=coherence — fall through to Precedence 1 to return operator
    // unrewritten (legitimate escalation). Comment retained at the
    // Precedence 1 site below.
  }

  // Precedence 1: Explicit next_agent field
  // next_agent ALWAYS wins over blocker_class and status-based inference.
  // Note (ADR-001): when next_agent="operator", Precedence 1.5 above has
  // already gated this — only stage="coherence" reaches here with operator
  // routing intact (legitimate escalation).
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

  // Precedence 2.5: status=blocked with no blocker_class → coherence safety net
  // Pre-mortem IF2: when an agent writes status=blocked but forgets blocker_class,
  // the epic must NOT advance via default progression. Route to coherence as the
  // safest fallback — coherence can reason about the marker context and decide
  // the correct next action. (Per marker-protocol.md § 2 commit 8eb9fca.)
  if (marker.status === "blocked") {
    return {
      override: true,
      nextAgent: "coherence",
      reason:
        "status=blocked with no blocker_class, fallback to coherence safety net",
    };
  }

  // Precedence 2.6 (factory-core-wlsr.3): status=success + BLOCKER: in
  // whats_open → coherence. Per operator-set principle P2, success with
  // BLOCKER: items is a non-success outcome — the agent declared completion
  // but flagged blocking issues. Coherence reasons about whether to dispatch
  // a remediation agent or escalate.
  if (marker.status === "success" && hasBlockerInWhatsOpen(marker.whats_open)) {
    return {
      override: true,
      nextAgent: "coherence",
      reason:
        "status=success with BLOCKER: in whats_open, route to coherence (P2)",
    };
  }

  // Precedence 3: status=needs-decision + BLOCKER in whats_open
  // Existing 2m5z pattern: route to coherence for reasoning.
  if (marker.status === "needs-decision") {
    if (hasBlockerInWhatsOpen(marker.whats_open)) {
      return {
        override: true,
        nextAgent: "coherence",
        reason: "needs-decision with BLOCKER in whats_open",
      };
    }

    // Precedence 3.5 (factory-core-wlsr.3): status=needs-decision without
    // BLOCKER — was fallthrough, now routes to coherence per operator-set
    // principle P2 (any non-success outcome → coherence). Agents that aren't
    // confident (needs-decision is the agent saying "I don't know") get
    // coherence reasoning rather than silent fallthrough.
    return {
      override: true,
      nextAgent: "coherence",
      reason:
        "status=needs-decision without BLOCKER, route to coherence (P2)",
    };
  }

  // Precedence 4: status=success → fallback to pipeline-routes
  // (success without BLOCKER and without next_agent override — the canonical
  // happy path. Pipeline-routes default progression takes over.)
  if (marker.status === "success") {
    return {
      override: false,
      reason: "status=success, fallback to pipeline-routes",
    };
  }

  // Precedence 5 (factory-core-wlsr.3, CHANGED): status=failure → coherence
  // (was: re-dispatch same agent). Per operator-set principle P2, failure is
  // a non-success outcome that merits coherence reasoning. Blind same-agent
  // re-dispatch was the prior behaviour (re-running a planner that just
  // failed against the same input is unlikely to succeed); coherence reads
  // the marker, journal, and bead state to decide whether re-dispatch,
  // re-plan, file-bug, or escalate is the right next move.
  if (marker.status === "failure") {
    return {
      override: true,
      nextAgent: "coherence",
      reason: "status=failure, route to coherence (P2)",
    };
  }

  // Fallback: status not recognised. Loose-schema discipline — never throw.
  return {
    override: false,
    reason: `no routing decision for status=${marker.status}`,
  };
}
