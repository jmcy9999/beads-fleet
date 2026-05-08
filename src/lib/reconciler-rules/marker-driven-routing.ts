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
import {
  buildDispatchContext,
  evaluatePreconditions,
} from "../dispatch-preconditions";
import {
  appendEvent,
  RECONCILER_ACTION_REFUSED,
} from "../event-log";
import type { DispatchSentinel } from "../marker-dispatch-sentinel";

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

  // --- Persistent dispatch sentinels (beads_web-poh.17) ---

  /**
   * Read the persistent sentinel recorded after a prior successful
   * dispatch for this idempotency key. Returns null when no sentinel
   * exists (genuine first dispatch) or the file is unparseable
   * (treat as no record, fail-open). Optional — if absent, the rule
   * falls back to the reconciler's event-log dedupe alone.
   */
  readDispatchSentinel?: (
    repoPath: string,
    idempotencyKey: string,
  ) => DispatchSentinel | null;

  /**
   * Persist a sentinel after a successful dispatch. Best-effort: write
   * failures must not break the dispatch. Optional — if absent, no
   * sentinel is written and the rule operates as before.
   */
  writeDispatchSentinel?: (
    repoPath: string,
    idempotencyKey: string,
    sentinel: DispatchSentinel,
  ) => Promise<void>;

  /**
   * Synchronous stat for a marker file's mtime in ms. Used in the
   * filesystem-walk path to compare marker freshness against the
   * sentinel. Returns 0 when the file is missing — the comparison
   * `markerMtimeMs <= sentinel.markerMtimeMs` then trivially holds, so
   * the rule treats it as "already dispatched, skip" (correct: the
   * marker is gone, nothing to dispatch).
   */
  statMarkerMtime?: (repoPath: string, markerId: string) => number;

  /**
   * beads_web-poh.18: throttle the filesystem-walk fallback path
   * specifically. The event-based path is cheap (walks the in-memory
   * events array) and must run every tick so an at-HEAD coherence
   * marker is dispatched before stuck-in-stage gets a chance to
   * pre-empt it. The filesystem walk is expensive (~400ms per repo
   * scan across ~40 repos) and gets its own throttle.
   *
   * Default 300_000 ms (5 minutes) — the same value the outer
   * `throttled()` wrapper used pre-poh.18.
   */
  filesystemWalkThrottleMs?: number;
}

// ---------------------------------------------------------------------------
// getActionForAgent — extracted to src/lib/agent-action-map.ts (beads_web-qfd).
// Import is at the top of this file.
// ---------------------------------------------------------------------------

// 2026-05-08 (C2 attempt 3 empirical): launchAgent records pipeline-label
// stage names (e.g. "product-spec", "architecture") on agent-exited events,
// but agents write markers using their AGENT names (e.g. "product-manager",
// "architect"). Translate before constructing markerId. Identity rows ("X" →
// "X") are listed for documentation; the lookup falls back to identity.
//
// 2026-05-08 (poh.24, C2 attempt 4 empirical): launchAgent at the planner
// dispatch sites (route.ts:1469,1614,1656,1705,3343) sets pipelineStage="planning"
// but the canonical pipeline-label name is "plan-review" and the planner agent
// writes its marker as <epic>-planner.json. The "plan-review" entry below is
// kept for the route.ts:3247 outlier and for forward-consistency with the label
// lexicon; "planning" is added so the 4 main call sites resolve the same way.
// Both keys map to "planner" → identical markerId construction.
const STAGE_TO_AGENT_NAME: Record<string, string> = {
  research: "research",
  "product-spec": "product-manager",
  architecture: "architect",
  planning: "planner",
  "plan-review": "planner",
  "test-spec": "test-spec",
  development: "builder",
};

export function buildMarkerDrivenRoutingRule(
  opts: MarkerDrivenRoutingRuleOptions,
): ReconcilerRule {
  const actionUrl = opts.actionUrl ?? getDefaultActionUrl();
  // beads_web-poh.18: per-rule state used to throttle ONLY the expensive
  // filesystem-walk fallback. The cheap event-based path is unthrottled
  // so a coherence-exit marker is dispatched within one tick and
  // pre-empts stuck-in-stage on the same tick.
  const filesystemWalkThrottleMs = opts.filesystemWalkThrottleMs ?? 300_000;
  let lastFilesystemWalkAtMs = 0;

  return {
    name: MARKER_DRIVEN_ROUTING_RULE_NAME,

    async matches(events, now) {
      // Event-based discovery: filter for agent-exited events within the
      // reconciler's lookback window (typically 60 min). For each epic-id
      // in those events, read marker and check routing intent.
      //
      // beads_web-poh.22 (2026-05-08): track the MOST RECENT stage per epic
      // by explicit timestamp comparison. Earlier implementation used
      // `Map.set` overwrite while iterating the events array and assumed
      // "later in iteration = later in time". But `readEvents` returns
      // events newest-first (`filtered.reverse()` at event-log.ts:256), so
      // the last iteration was actually the OLDEST event — inverted intent.
      // Comparing `Date.parse(e.timestamp)` is order-independent and
      // survives any future change to readEvents's ordering.
      const epicLatest = new Map<string, { stage: string; ts: number }>();
      for (const e of events) {
        if (e.type !== "agent-exited" || !e.epicId || !e.stage) continue;
        const ts = Date.parse(e.timestamp);
        if (Number.isNaN(ts)) continue;
        const existing = epicLatest.get(e.epicId);
        if (!existing || ts > existing.ts) {
          epicLatest.set(e.epicId, { stage: e.stage, ts });
        }
      }
      const epicStages = new Map<string, string>();
      for (const [epicId, { stage }] of epicLatest.entries()) {
        epicStages.set(epicId, stage);
      }
      if (epicStages.size > 0) {
        const summary = Array.from(epicStages.entries())
          .map(([id, s]) => `${id}=${s}`)
          .join(", ");
        console.log(`[xfc] matches: latest-stage-per-epic { ${summary} }`);
      }

      const matches: ReconcilerMatch[] = [];

      for (const [epicId, stage] of epicStages.entries()) {
        // Read marker for this (epicId, stage). Marker filename convention
        // per marker-protocol: epic-scope agents use <epicId>-<agentName>.json;
        // per-bead agents use <beadId>.json. xfc targets epic-scope agents
        // (architect, planner, qa, etc.).
        //
        // 2026-05-08 fix (C2 attempt 3 empirical): the agent-exited event's
        // `stage` field carries the PIPELINE-LABEL name (e.g. "product-spec",
        // "architecture") set by launchAgent, but agents write marker files
        // using their AGENT name (e.g. "product-manager", "architect").
        // research-stage worked by coincidence (both names equal). Translate
        // pipeline-label → agent-name before constructing markerId.
        const agentName = STAGE_TO_AGENT_NAME[stage] ?? stage;
        const markerId = `${epicId}-${agentName}`;
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
      // registered repo to find orphaned markers.
      //
      // beads_web-poh.18: throttle moved INTO the rule and scoped to the
      // filesystem-walk path only. Pre-poh.18 the whole rule was wrapped
      // in `throttled(..., 300_000)` which suppressed the cheap event-
      // based path too — meaning a fresh coherence-exit marker waited up
      // to 5 minutes for the next unblocked tick, during which
      // stuck-in-stage was free to pre-empt it. Now the event-based
      // path runs every tick and the filesystem walk has its own 5-min
      // budget.
      //
      // De-dupe: if event-based discovery DID produce matches for a given
      // (epicId, stage), skip filesystem-discovered duplicates. In practice
      // this branch only runs when event-based matches are empty, but the
      // de-dupe is defensive.
      // -------------------------------------------------------------------
      const nowMs = now.getTime();
      const filesystemWalkAllowed =
        nowMs - lastFilesystemWalkAtMs >= filesystemWalkThrottleMs;
      if (
        matches.length === 0 &&
        filesystemWalkAllowed &&
        opts.listRegisteredRepos &&
        opts.listMarkerFiles
      ) {
        // Mark the walk start before doing it — even if the walk yields
        // zero matches we have paid the filesystem cost and the throttle
        // should hold off the next walk by the configured budget.
        lastFilesystemWalkAtMs = nowMs;
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

            // -----------------------------------------------------------
            // beads_web-poh.17: persistent dispatch-sentinel dedupe.
            //
            // The reconciler's event-log dedupe expires after 60 minutes
            // and depends on `events.jsonl` being intact. When the bucket
            // rotates or the log is lost, the filesystem-walk path keeps
            // re-discovering the same stale marker on every tick and the
            // rule re-fires the same dispatch (factory-core-1vud V1
            // retest: PM dispatched 4×). The sentinel is the persistent
            // counterpart written next to the marker so a re-discovery
            // can short-circuit if the marker is still the one we already
            // dispatched.
            //
            // Skip when: a sentinel exists AND the marker has not been
            // rewritten since dispatch. A genuine retry (agent rewrites
            // its own marker with a new next_agent) bumps the mtime past
            // sentinel.markerMtimeMs and the match is pushed again.
            // -----------------------------------------------------------
            const markerMtimeMs = opts.statMarkerMtime
              ? opts.statMarkerMtime(repo.path, markerId)
              : 0;
            if (opts.readDispatchSentinel) {
              try {
                const sentinel = opts.readDispatchSentinel(
                  repo.path,
                  idempotencyKey,
                );
                if (
                  sentinel &&
                  markerMtimeMs > 0 &&
                  markerMtimeMs <= sentinel.markerMtimeMs
                ) {
                  console.log(
                    `[xfc] poh.17 sentinel-skip: ${idempotencyKey} already dispatched at ${sentinel.dispatchedAt} (markerMtime=${markerMtimeMs}, sentinel.markerMtimeMs=${sentinel.markerMtimeMs})`,
                  );
                  continue; // already dispatched, marker unchanged
                }
              } catch (err) {
                console.warn(
                  `[xfc] readDispatchSentinel failed for ${idempotencyKey} — fail-open and push match`,
                  err instanceof Error ? err.message : err,
                );
              }
            }

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
                // beads_web-poh.17: capture the mtime observed at match
                // time so act() can record the same value into the
                // sentinel on success. Using the match-time mtime (not a
                // re-stat in act()) keeps "marker rewritten between
                // matches() and act()" detectable on the NEXT tick: if
                // the marker is rewritten in that window, the next
                // matches() will see mtime > sentinel.markerMtimeMs
                // because we recorded the older value here.
                markerMtimeMs,
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
        markerMtimeMs?: number;
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

      // -----------------------------------------------------------------
      // beads_web-ehp.4: dispatch-precondition gate (Wave 3 integration).
      //
      // Architecture § Component Boundaries Contract 2: precondition check
      // runs AFTER snapshot re-read and BEFORE the action-route fetch.
      // Load-bearing for the 372-bead mass-defer (BD_STATUS_DEFERRED) and
      // operator-decision-pending Class C protection (OPERATOR_DECISION_
      // PENDING / REVIEW_NEEDS_HUMAN). On refusal: structured warn-log
      // tagged `reconciler_dispatch_refused` + a `reconciler-action-refused`
      // event (Wave-1 variant) + early return WITHOUT dispatching.
      //
      // RESOLVED (beads_web-3e6, 2026-05-08): refusals now signal back to
      // the reconciler loop via the `RuleActResult` return value, so the
      // action-taken event is NOT appended on refusal and the bucket
      // stays open for the next tick. The architectural FOLLOW-ON noted
      // above (ADR-006 — refusal-code bucketing key) is superseded by
      // this simpler approach: rule signals intent via return value;
      // reconciler treats refusal as "condition not met yet — try again
      // next tick". See reconciler.ts and beads_web-3e6 for details.
      // -----------------------------------------------------------------
      const precondCtx = await buildDispatchContext({
        epicId: match.epicId,
        repoPath: markerRepoPath,
        action: actionName,
      });
      const precondResult = evaluatePreconditions(precondCtx);
      if (!precondResult.ok) {
        console.warn(
          `[xfc] reconciler_dispatch_refused: rule=${MARKER_DRIVEN_ROUTING_RULE_NAME} epicId=${match.epicId} action=${actionName} refusalCode=${precondResult.refusalCode} failedCheck=${precondResult.failedCheck} reason="${precondResult.reason}"`,
        );
        await appendEvent(opts.repoPath, {
          type: RECONCILER_ACTION_REFUSED,
          epicId: match.epicId,
          stage: context.stage,
          payload: {
            ruleName: MARKER_DRIVEN_ROUTING_RULE_NAME,
            action: actionName,
            refusalCode: precondResult.refusalCode,
            failedCheck: precondResult.failedCheck,
            reason: precondResult.reason,
          },
        });
        return { refused: true, refusalCode: precondResult.refusalCode };
      }

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

        // -------------------------------------------------------------
        // beads_web-ehp.4: route-side precondition refusal (HTTP 412).
        //
        // Architecture § Seam 5 (defense-in-depth): both the rule AND the
        // action route validate preconditions. If the route refuses with
        // 412 (route-side check caught state the rule's own check missed
        // — race window, marker mutated mid-flight, etc.), the rule must
        // distinguish that from a genuine HTTP failure. 412 is a refusal:
        // log a structured warn-line tagged `reconciler_dispatch_refused_
        // at_route`, emit a `reconciler-action-refused` event with a
        // ROUTE_REFUSED_412 marker code, and return WITHOUT throwing.
        // Throwing would propagate to the reconciler tick handler and
        // count as an act() failure (which dispatches a different
        // recovery path — wrong semantics for a refusal).
        // -------------------------------------------------------------
        if (res.status === 412) {
          const text = await res.text().catch(() => "<unreadable>");
          console.warn(
            `[xfc] reconciler_dispatch_refused_at_route: rule=${MARKER_DRIVEN_ROUTING_RULE_NAME} epicId=${match.epicId} action=${actionName} httpStatus=412 body="${text}"`,
          );
          await appendEvent(opts.repoPath, {
            type: RECONCILER_ACTION_REFUSED,
            epicId: match.epicId,
            stage: context.stage,
            payload: {
              ruleName: MARKER_DRIVEN_ROUTING_RULE_NAME,
              action: actionName,
              refusalCode: "ROUTE_REFUSED_412",
              failedCheck: "route-side-precondition",
              reason: text,
            },
          });
          return { refused: true, refusalCode: "ROUTE_REFUSED_412" };
        }

        if (!res.ok) {
          const text = await res.text().catch(() => "<unreadable>");
          throw new Error(
            `[xfc] dispatch for ${match.epicId} returned HTTP ${res.status}: ${text}`,
          );
        }

        console.log(
          `[xfc] ${match.epicId}: dispatched ${nextAgent} successfully`,
        );

        // -----------------------------------------------------------
        // beads_web-poh.17: persist the dispatch sentinel so a future
        // filesystem-walk tick can recognise this marker as already
        // routed and short-circuit. Best-effort — sentinel-write
        // failures are logged inside writeDispatchSentinel and never
        // propagate. Only fires after a SUCCESSFUL dispatch (we are
        // past the 412/!ok branches above), and only when the rule
        // is configured with sentinel callbacks.
        // -----------------------------------------------------------
        if (opts.writeDispatchSentinel) {
          try {
            await opts.writeDispatchSentinel(markerRepoPath, match.idempotencyKey, {
              idempotencyKey: match.idempotencyKey,
              dispatchedAt: new Date().toISOString(),
              // Use the mtime captured at matches() time. If the marker
              // was rewritten between matches() and act() the next
              // tick's stat will see mtime > sentinel.markerMtimeMs and
              // re-dispatch (correct: a rewrite is a new routing intent).
              markerMtimeMs: context.markerMtimeMs ?? 0,
              markerId: context.markerId,
              nextAgent,
            });
          } catch (err) {
            console.warn(
              `[xfc] writeDispatchSentinel failed for ${match.idempotencyKey}: ${err instanceof Error ? err.message : err}`,
            );
          }
        }
      } finally {
        clearTimeout(timeoutHandle);
      }
    },
  };
}
