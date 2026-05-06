/**
 * Canonical mapping from AgentType to fleet action name.
 *
 * Extracted from agent-launcher.ts (kvn) and marker-driven-routing.ts (xfc)
 * to eliminate duplication. Both modules now import from here.
 *
 * The fleet action route (src/app/api/fleet/action/route.ts) dispatches
 * agents by action name (e.g., "run-architect"), but marker routing and
 * the reconciler resolve agents by AgentType (e.g., "architect"). This
 * function bridges the two.
 *
 * Falls back to `run-${agentType}` for unknown agents (future-proofing).
 *
 * @see beads_web-qfd (DRY refactor, pre-mortem IF3)
 */
import type { AgentType } from "./marker-routing";

const AGENT_TO_ACTION: Record<AgentType, string> = {
  architect: "run-architect",
  planner: "generate-plan",
  builder: "start-wave",
  reviewer: "review-wave",
  qa: "send-for-qa",
  polish: "send-for-polish",
  "test-spec": "run-test-spec",
  "product-manager": "run-pm",
  // Per ADR-003 (factory-core-wlsr.3) the operator → "send-for-review"
  // mapping is retained but its invocation is gated UPSTREAM by
  // interpretMarkerForRouting's Precedence 1.5 stage-aware rewrite. After
  // wlsr.3 lands, this mapping fires ONLY when the upstream caller is
  // stage="coherence" (i.e. coherence's legitimate escalation per
  // operator-set principle P1). Loop-agent markers with next_agent=operator
  // are rewritten to coherence before reaching this map; only coherence's
  // own escalation marker preserves operator routing through to
  // send-for-review. Do NOT remove or rename without coordinating with
  // the routing layer; the contract is enforced upstream where the
  // decision is made, not here.
  operator: "send-for-review",
  coherence: "run-coherence-agent",
};

export function getActionForAgent(agentType: AgentType): string {
  const action = AGENT_TO_ACTION[agentType];
  if (!action) {
    console.warn(
      `[agent-action-map] unknown agent type '${agentType}' — falling back to run-${agentType}`,
    );
  }
  return action || `run-${agentType}`;
}
