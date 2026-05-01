/**
 * beads_web-xfc — Marker-driven-routing reconciler rule.
 *
 * Defense-in-depth complement to kvn's inline fast path (dispatchChainAction).
 * Catches cases where the inline branch didn't fire:
 *   - Agent exited outside the normal chain (crash, operator kill).
 *   - Orchestrator restarted between marker write and detectAgentDone.
 *   - Race condition in exit handling (agent exited before session registered).
 *
 * Hybrid approach per factory-core-o4lx architect memo § 5 Q3: reconciler
 * rule fires periodically on agent-exited events, reads marker, dispatches
 * appropriate next agent when marker signals routing intent.
 *
 * Match conditions:
 *   - Recent agent-exited event (within reconciler lookback window ~60 min).
 *   - Marker exists for that (epicId, stage).
 *   - Marker signals routing intent (next_agent set OR status=needs-decision).
 *
 * Act:
 *   - Call interpretMarkerForRouting(marker, snapshot).
 *   - If override=true, dispatch nextAgent via /api/fleet/action.
 *
 * Idempotency key: marker-driven-routing::<epicId>::<stage> (one routing
 * action per epic-stage pair). Prevents double-dispatches when both inline
 * branch (kvn) and reconciler (xfc) see the same marker.
 *
 * No agent-running check: xfc fires on agent-exited events (which only exist
 * after agent has already exited). By definition, agent is no longer running.
 * Stale agent:running labels are liveness-check's job to clear.
 */

import type { ReconcilerRule, ReconcilerMatch } from "../reconciler";
import type { MarkerData } from "../marker-reader";
import type { EpicStateSnapshot } from "../marker-routing";
import { interpretMarkerForRouting } from "../marker-routing";
import { getDefaultActionUrl } from "../orchestrator-url";

export const MARKER_DRIVEN_ROUTING_RULE_NAME = "marker-driven-routing";

export interface MarkerDrivenRoutingEpicSnapshot {
  /** Current pipeline stage (derived from pipeline: label). */
  currentStage: string | null;
  /** Labels for the epic. */
  labels: string[];
  /** Title for dispatch logging. */
  title: string;
}

export interface MarkerDrivenRoutingRuleOptions {
  /** Injected marker reader. Null result = marker missing/unreadable -> skip. */
  readMarker: (
    repoPath: string,
    markerId: string,
  ) => Promise<MarkerData | null>;
  /** Injected epic-state reader. Null result = bd failure -> skip. */
  readEpicSnapshot: (
    epicId: string,
  ) => Promise<MarkerDrivenRoutingEpicSnapshot | null>;
  /** Repo path for marker reads. */
  repoPath: string;
  /** Override action URL for testing. */
  actionUrl?: string;
}

// ---------------------------------------------------------------------------
// Agent-type to fleet action name mapping.
//
// Mirrors the canonical mapping at agent-launcher.ts:1843 (kvn commit
// 399b7fa). Local copy here because getActionForAgent is a module-private
// function in agent-launcher.ts — exporting it would require modifying
// kvn's file (spillover edit). Operator directive says "import, don't
// duplicate" but export is absent; local copy is the pragmatic choice
// given operator offline. See marker surprises_or_findings.
// ---------------------------------------------------------------------------

function getActionForAgent(agentType: string): string {
  const agentToAction: Record<string, string> = {
    architect: "run-architect",
    planner: "generate-plan",
    builder: "start-wave",
    reviewer: "review-wave",
    qa: "send-for-qa",
    polish: "send-for-polish",
    "test-spec": "run-test-spec",
    "product-manager": "run-pm",
    operator: "send-for-review",
    coherence: "run-coherence-agent",
  };

  const action = agentToAction[agentType];
  if (!action) {
    console.warn(
      `[xfc] unknown agent type '${agentType}' — falling back to run-${agentType}`,
    );
  }
  return action || `run-${agentType}`;
}

export function buildMarkerDrivenRoutingRule(
  opts: MarkerDrivenRoutingRuleOptions,
): ReconcilerRule {
  const actionUrl = opts.actionUrl ?? getDefaultActionUrl();

  return {
    name: MARKER_DRIVEN_ROUTING_RULE_NAME,

    async matches(events, _now) {
      // Event-based discovery: filter for agent-exited events within the
      // reconciler's lookback window (typically 60 min). For each epic-id
      // in those events, read marker and check routing intent.
      const epicStages = new Map<string, string>(); // epicId -> stage
      for (const e of events) {
        if (e.type === "agent-exited" && e.epicId && e.stage) {
          // Track the MOST RECENT stage for each epicId (later events in
          // the array overwrite earlier ones). Handles cases where an
          // epic has multiple agent-exited events in the lookback window.
          epicStages.set(e.epicId, e.stage);
        }
      }

      const matches: ReconcilerMatch[] = [];

      for (const [epicId, stage] of epicStages.entries()) {
        // Read marker for this (epicId, stage). Marker filename convention
        // per marker-protocol: epic-scope agents use <epicId>-<stage>.json;
        // per-bead agents use <beadId>.json. xfc targets epic-scope agents
        // (architect, planner, qa, etc.) so the markerId is <epicId>-<stage>.
        const markerId = `${epicId}-${stage}`;
        const marker = await opts.readMarker(opts.repoPath, markerId);

        if (!marker) continue; // marker missing/unreadable — skip

        // Check routing intent: next_agent set OR status=needs-decision.
        // Per architect memo § 6 Q4 precedence rule:
        //   - next_agent explicit -> override
        //   - status=needs-decision + BLOCKER -> coherence (via interpretMarkerForRouting)
        //   - status=success + no next_agent -> fallback (reconciler skips; inline branch handles)
        const hasRoutingIntent =
          marker.next_agent !== undefined ||
          marker.status === "needs-decision";

        if (!hasRoutingIntent) continue; // no routing intent — skip

        // Idempotency key: marker-driven-routing::<epicId>::<stage>.
        // One routing action per epic-stage pair. If inline branch (kvn)
        // already dispatched for this marker, the reconciler loop's
        // idempotency check will see the prior reconciler-action-taken
        // event and skip act().
        matches.push({
          idempotencyKey: `${MARKER_DRIVEN_ROUTING_RULE_NAME}::${epicId}::${stage}`,
          epicId,
          context: {
            stage,
            markerId,
            marker,
          },
        });
      }

      return matches;
    },

    async act(match) {
      const context = match.context as {
        stage: string;
        markerId: string;
        marker: MarkerData;
      };

      console.log(
        `[xfc] marker-driven-routing for ${match.epicId}: stage=${context.stage}, marker=${context.markerId}`,
      );

      // Re-read marker (it may have changed since matches() ran, though
      // unlikely in the 10s tick interval). Also read epic snapshot for
      // interpretMarkerForRouting's snapshot parameter.
      const marker = await opts.readMarker(opts.repoPath, context.markerId);
      if (!marker) {
        console.warn(
          `[xfc] marker ${context.markerId} missing at act() time (was present at matches()) — skip`,
        );
        return;
      }

      const epicSnapshot = await opts.readEpicSnapshot(match.epicId);
      if (!epicSnapshot) {
        console.warn(
          `[xfc] bd failure reading ${match.epicId} snapshot — skip`,
        );
        return;
      }

      // Build the EpicStateSnapshot expected by interpretMarkerForRouting
      // (from marker-routing.ts gc2). The function ignores the snapshot
      // parameter (_snapshot) but we supply it for type compatibility.
      const routingSnapshot: EpicStateSnapshot = {
        epicId: match.epicId,
        currentStage: epicSnapshot.currentStage ?? context.stage,
        labels: epicSnapshot.labels,
      };

      const routingDecision = interpretMarkerForRouting(marker, routingSnapshot);

      if (!routingDecision.override) {
        // No override — marker says "use pipeline-routes default". The
        // inline branch (kvn) handles that fallback; reconciler skips.
        console.log(
          `[xfc] ${match.epicId}: no override (reason: ${routingDecision.reason}) — skip`,
        );
        return;
      }

      const nextAgent = routingDecision.nextAgent;
      if (!nextAgent) {
        console.warn(
          `[xfc] ${match.epicId}: override=true but nextAgent missing — skip`,
        );
        return;
      }

      console.log(
        `[xfc] ${match.epicId}: dispatching ${nextAgent} (reason: ${routingDecision.reason})`,
      );

      // Map nextAgent to action name for /api/fleet/action dispatch.
      const actionName = getActionForAgent(nextAgent);

      // Dispatch via /api/fleet/action (same pattern as stuck-in-stage
      // and other reconciler rules).
      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), 15_000);
      try {
        const res = await fetch(actionUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: actionName,
            epicId: match.epicId,
            epicTitle: epicSnapshot.title,
            currentLabels: epicSnapshot.labels,
          }),
          signal: controller.signal,
        });

        if (!res.ok) {
          const text = await res.text().catch(() => "<unreadable>");
          throw new Error(
            `[xfc] dispatch for ${match.epicId} returned HTTP ${res.status}: ${text}`,
          );
        }

        console.log(
          `[xfc] ${match.epicId}: dispatched ${nextAgent} successfully`,
        );
      } finally {
        clearTimeout(timeoutHandle);
      }
    },
  };
}
