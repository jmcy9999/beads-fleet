/**
 * beads_web-xfc — Marker-driven-routing reconciler rule.
 *
 * Defense-in-depth complement to kvn's inline fast path (dispatchChainAction).
 * Catches cases where the inline branch didn't fire:
 *   - Agent exited outside the normal chain (crash, operator kill).
 *   - Orchestrator restarted between marker write and detectAgentDone.
 *   - Race condition in exit handling (agent exited before session registered).
 *
 * Hybrid discovery (beads_web-hs5, ADR-hs5-orphan-marker-recovery):
 *   1. Event-based discovery (original xfc): fires on agent-exited events,
 *      reads marker, dispatches. Lines 112-158 preserved.
 *   2. Filesystem-walk fallback (hs5): when event-based discovery produces
 *      zero matches AND the 5-min throttle permits, walk .beads/markers/
 *      in every registered repo to recover orphaned markers (markers with
 *      no corresponding agent-exited event).
 *
 * Three classes of orphaned markers recovered by the fallback:
 *   - Markers written BEFORE o4lx routing existed (lmxb canary).
 *   - Markers where event log was rotated / daemon restarted.
 *   - Markers written by external tools that don't emit agent-exited events.
 *
 * Match conditions (event-based path):
 *   - Recent agent-exited event (within reconciler lookback window ~60 min).
 *   - Marker exists for that (epicId, stage).
 *   - Marker signals routing intent (next_agent set OR status=needs-decision).
 *
 * Match conditions (filesystem-walk fallback):
 *   - Event-based path returned zero matches.
 *   - Marker file exists in .beads/markers/ of any registered repo.
 *   - Marker has epic_id and routing intent.
 *   - Bead is OPEN (closed beads' markers are stale).
 *
 * Act:
 *   - Call interpretMarkerForRouting(marker, snapshot).
 *   - If override=true, dispatch nextAgent via /api/fleet/action.
 *
 * Idempotency key: marker-driven-routing::<epicId>::<stage> (one routing
 * action per epic-stage pair). Stable regardless of discovery method.
 * Prevents double-dispatches when both inline branch (kvn) and reconciler
 * (xfc) see the same marker. No new fingerprint store (ADR Q2).
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
import { getActionForAgent } from "../agent-action-map";

export const MARKER_DRIVEN_ROUTING_RULE_NAME = "marker-driven-routing";

export interface MarkerDrivenRoutingEpicSnapshot {
  /** Current pipeline stage (derived from pipeline: label). */
  currentStage: string | null;
  /** Labels for the epic. */
  labels: string[];
  /** Title for dispatch logging. */
  title: string;
}

/** A registered repo from ~/.beads-web.json. */
export interface RegisteredRepo {
  name: string;
  path: string;
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
  /** Repo path for marker reads (event-based path). */
  repoPath: string;
  /** Override action URL for testing. */
  actionUrl?: string;

  // --- Filesystem-walk fallback (beads_web-hs5) ---

  /**
   * List registered repos from ~/.beads-web.json.
   * Returns empty array on read failure (tolerant per AC#8).
   * Optional — if absent, filesystem-walk fallback is disabled.
   */
  listRegisteredRepos?: () => RegisteredRepo[];
  /**
   * List .json files in a repo's .beads/markers/ directory.
   * Returns filenames (e.g., ["factory-core-lmxb-planner.json"]).
   * Returns empty array on ENOENT / EACCES (tolerant per AC#8).
   */
  listMarkerFiles?: (repoPath: string) => string[];
  /**
   * Check bead status. Returns "open", "closed", etc.
   * Returns null on bd failure (tolerant — skip marker on null).
   */
  readBeadStatus?: (beadId: string, repoPath: string) => string | null;
}

// ---------------------------------------------------------------------------
// getActionForAgent — extracted to src/lib/agent-action-map.ts (beads_web-qfd).
// Import is at the top of this file.
// ---------------------------------------------------------------------------

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

      // -------------------------------------------------------------------
      // Filesystem-walk fallback (beads_web-hs5, ADR-hs5 Q1).
      //
      // If event-based discovery returned zero matches AND the filesystem-
      // walk callbacks are configured, walk .beads/markers/ in every
      // registered repo to find orphaned markers. The throttle is enforced
      // by the reconciler core (minTickIntervalMs on the rule) — matches()
      // is only called when the throttle permits, so no second throttle
      // check here.
      //
      // De-dupe: if event-based discovery DID produce matches for a given
      // (epicId, stage), skip filesystem-discovered duplicates. In practice
      // this branch only runs when event-based matches are empty, but the
      // de-dupe is defensive.
      // -------------------------------------------------------------------
      if (
        matches.length === 0 &&
        opts.listRegisteredRepos &&
        opts.listMarkerFiles
      ) {
        // Collect (epicId, stage) tuples already matched by event-based path.
        const eventMatchedKeys = new Set<string>();
        for (const m of matches) {
          const ctx = m.context as { stage?: string } | undefined;
          if (ctx?.stage) {
            eventMatchedKeys.add(`${m.epicId}::${ctx.stage}`);
          }
        }

        let repos: RegisteredRepo[];
        try {
          repos = opts.listRegisteredRepos();
        } catch (err) {
          console.warn(
            `[xfc] filesystem-walk: failed to read registered repos — skip`,
            err instanceof Error ? err.message : err,
          );
          repos = [];
        }

        for (const repo of repos) {
          let markerFiles: string[];
          try {
            markerFiles = opts.listMarkerFiles(repo.path);
          } catch (err) {
            console.warn(
              `[xfc] filesystem-walk: failed to list markers in ${repo.path} — skip repo`,
              err instanceof Error ? err.message : err,
            );
            continue;
          }

          for (const fileName of markerFiles) {
            if (!fileName.endsWith(".json")) continue;

            const markerId = fileName.replace(/\.json$/, "");

            let marker: MarkerData | null;
            try {
              marker = await opts.readMarker(repo.path, markerId);
            } catch (err) {
              console.warn(
                `[xfc] filesystem-walk: failed to read marker ${markerId} in ${repo.path} — skip`,
                err instanceof Error ? err.message : err,
              );
              continue;
            }
            if (!marker) continue; // malformed/missing — readMarker returns null

            // Only process epic-scope markers (those with epic_id).
            // Bead-scope markers (bead_id only) don't carry pipeline routing.
            const epicId = marker.epic_id as string | undefined;
            if (!epicId) continue;

            const stage = marker.stage;
            if (!stage) continue;

            // Check routing intent (same logic as event-based path).
            const hasRoutingIntent =
              marker.next_agent !== undefined ||
              marker.status === "needs-decision";
            if (!hasRoutingIntent) continue;

            // De-dupe with event-based matches.
            const dedupeKey = `${epicId}::${stage}`;
            if (eventMatchedKeys.has(dedupeKey)) continue;

            // Check bead is OPEN — closed beads' markers are stale (ADR Q4).
            if (opts.readBeadStatus) {
              try {
                const status = opts.readBeadStatus(epicId, repo.path);
                if (status === "closed") {
                  continue; // stale marker for closed bead — skip
                }
                // null (bd failure) or any non-closed status -> proceed
              } catch (err) {
                console.warn(
                  `[xfc] filesystem-walk: readBeadStatus failed for ${epicId} in ${repo.path} — skip marker`,
                  err instanceof Error ? err.message : err,
                );
                continue;
              }
            }

            // Produce match with same idempotency key format as event-based
            // path. Reconciler core handles idempotency via reconciler-action-
            // taken events (reconciler.ts lines 308-323).
            const idempotencyKey = `${MARKER_DRIVEN_ROUTING_RULE_NAME}::${epicId}::${stage}`;
            eventMatchedKeys.add(dedupeKey); // prevent duplicates within walk

            matches.push({
              idempotencyKey,
              epicId,
              context: {
                stage,
                markerId,
                marker,
                // Track discovery method for act() — filesystem-walk markers
                // need the marker's repo path (may differ from opts.repoPath).
                discoveredVia: "filesystem-walk" as const,
                markerRepoPath: repo.path,
              },
            });
          }
        }
      }

      return matches;
    },

    async act(match) {
      const context = match.context as {
        stage: string;
        markerId: string;
        marker: MarkerData;
        discoveredVia?: "filesystem-walk";
        markerRepoPath?: string;
      };

      const discoveryMethod = context.discoveredVia ?? "event-based";
      console.log(
        `[xfc] marker-driven-routing for ${match.epicId}: stage=${context.stage}, marker=${context.markerId}, via=${discoveryMethod}`,
      );

      // Re-read marker (it may have changed since matches() ran, though
      // unlikely in the 10s tick interval). For filesystem-walk-discovered
      // markers, read from the marker's own repo path (not opts.repoPath).
      const markerRepoPath = context.markerRepoPath ?? opts.repoPath;
      const marker = await opts.readMarker(markerRepoPath, context.markerId);
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
