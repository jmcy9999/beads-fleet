/**
 * factory-core-zsjv.6 — Repeat-dispatch-escalation rule.
 *
 * Detects the "groundhog day" pattern where stuck-in-stage keeps firing
 * the same recovery action for the same (epic, stage) across multiple
 * 15-minute idempotency buckets. The dispatch succeeds (agent launches,
 * runs, exits) but the auto-chain from exit doesn't advance the epic.
 * 15 min later a fresh bucket triggers another identical recovery.
 *
 * Mechanical re-dispatch can't fix this pattern — the problem isn't
 * "transition was dropped" (that's what lfcf.4/zsjv.1 already handle)
 * but "transition completes yet the pipeline doesn't progress." Causes
 * could be: partial-transition bugs leaving stale labels (zsjv.4
 * addressed many of these but older epics may still carry them), agent
 * crashes without emitting exit events, an action-handler that returns
 * 2xx without actually completing its downstream work, or the reconciler
 * choosing the wrong resume action for an epic's actual state.
 *
 * Diagnosis requires judgment — exactly what the coherence agent is for.
 *
 * Rule:
 *   matches: for each (epicId, stage) combination referenced by
 *     reconciler-action-taken events in the lookback window where
 *     ruleName = 'stuck-in-stage', count occurrences. When the count
 *     reaches THRESHOLD (default 3), emit a match.
 *   act: dispatch run-coherence-agent with anomalyClass =
 *     'repeat-dispatch-no-progress'. Include attemptCount and the
 *     recent action history so the coherence agent can see what the
 *     reconciler tried without having to re-query the log.
 *
 * Idempotency key: `repeat-dispatch-escalation::<epicId>::<stage>`.
 * Single escalation per (epic, stage) inside the idempotency horizon
 * (1 hour default) regardless of how many more stuck-in-stage actions
 * fire during that window. When the epic advances past the stuck
 * stage, subsequent reconciler-action-taken events group under a
 * different (epic, stage) key — so a later re-stall at a different
 * stage triggers a fresh escalation.
 */

import type { ReconcilerRule, ReconcilerMatch } from "../reconciler";
import { getDefaultActionUrl } from "../orchestrator-url";
import type { ActiveDispatchProbeResult } from "./active-dispatch-probe";

export const REPEAT_DISPATCH_ESCALATION_RULE_NAME =
  "repeat-dispatch-escalation";

/**
 * factory-core-3p1e.10 — kind for the audit event written when the rule
 * suppresses an otherwise-eligible escalation because the latest
 * dispatch is actively progressing. Distinct from `reconciler-action-taken`
 * so suppression is auditable without being mistaken for an action.
 */
export const REPEAT_DISPATCH_SUPPRESSED_EVENT_TYPE =
  "repeat-dispatch-suppressed";

/** How many stuck-in-stage action-taken events for the same (epic, stage)
 *  before we call in coherence. 3 means we've watched mechanical
 *  re-dispatch fail three 15-minute cycles in a row. */
export const DEFAULT_REPEAT_THRESHOLD = 3;

/** How far back to look when counting repeats. Must cover at least
 *  (THRESHOLD × stuck-in-stage bucket = 45 minutes) so all three
 *  dispatches are visible. Default 1 hour. */
export const DEFAULT_WINDOW_MS = 60 * 60_000;

export interface EpicSnapshot {
  /** Current pipeline stage on bd (prefix stripped). Used to skip
   *  escalation if the epic has already advanced past the stuck stage. */
  currentStage: string | null;
  /** Labels for dispatch. */
  labels: string[];
  /** Title for dispatch. */
  title: string;
}

export interface RepeatDispatchEscalationRuleOptions {
  actionUrl?: string;
  /** Threshold for escalation. Default 3. */
  threshold?: number;
  /** Lookback window for counting stuck-in-stage events. Default 1h. */
  windowMs?: number;
  /** Reads live epic state. Null = bd failure → skip. */
  readEpicSnapshot: (epicId: string) => Promise<EpicSnapshot | null>;
  /**
   * factory-core-3p1e.10 — active-dispatch probe. When provided, the
   * rule consults the probe before escalating: if the latest dispatch
   * for (epicId, stage) is actively progressing (matching tmux session
   * alive AND transcript mtime / session activity within 5 minutes),
   * the rule logs + emits a `repeat-dispatch-suppressed` event and
   * does NOT enqueue a coherence escalation. Omitting the probe
   * preserves pre-3p1e.10 behaviour (escalate purely on count).
   */
  probeActiveDispatch?: (
    epicId: string,
    stage: string,
  ) => Promise<ActiveDispatchProbeResult> | ActiveDispatchProbeResult;
  /**
   * factory-core-3p1e.10 — emit a `repeat-dispatch-suppressed` audit
   * event when the probe reports active. Required iff `probeActiveDispatch`
   * is provided; absence is silently ignored (suppression still occurs;
   * just no audit trail). Production binds this to `appendEvent(repoPath, ...)`.
   */
  appendSuppressedEvent?: (event: {
    epicId: string;
    stage: string;
    attemptCount: number;
    sessionName?: string;
    jsonlMtime?: string;
    lastActivityAt?: string;
  }) => Promise<void>;
}

interface RepeatGroup {
  epicId: string;
  stage: string;
  count: number;
  recentActions: Array<{
    at: string;
    action: string;
  }>;
}

export function buildRepeatDispatchEscalationRule(
  opts: RepeatDispatchEscalationRuleOptions,
): ReconcilerRule {
  const actionUrl = opts.actionUrl ?? getDefaultActionUrl();
  const threshold = opts.threshold ?? DEFAULT_REPEAT_THRESHOLD;
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;

  return {
    name: REPEAT_DISPATCH_ESCALATION_RULE_NAME,

    async matches(events, now) {
      const horizonMs = now.getTime() - windowMs;

      // Collect stuck-in-stage action-taken events in the window,
      // grouping by (epicId, stage). The stage comes from the action's
      // context payload (zsjv.1 sets context.stage).
      const groups = new Map<string, RepeatGroup>();

      for (const e of events) {
        if (e.type !== "reconciler-action-taken") continue;
        const eventMs = Date.parse(e.timestamp);
        if (!Number.isFinite(eventMs) || eventMs < horizonMs) continue;
        const payload = e.payload as
          | {
              ruleName?: string;
              context?: { stage?: string; resumeAction?: string };
              success?: boolean;
            }
          | undefined;
        if (payload?.ruleName !== "stuck-in-stage") continue;
        const stage = payload?.context?.stage;
        if (!stage) continue;

        const key = `${e.epicId}::${stage}`;
        const group = groups.get(key) ?? {
          epicId: e.epicId,
          stage,
          count: 0,
          recentActions: [],
        };
        group.count += 1;
        group.recentActions.push({
          at: e.timestamp,
          action: payload.context?.resumeAction ?? "unknown",
        });
        groups.set(key, group);
      }

      const matches: ReconcilerMatch[] = [];

      for (const group of groups.values()) {
        if (group.count < threshold) continue;

        // Re-verify live state: if the epic has already advanced past
        // the stuck stage, don't escalate — the pattern self-resolved.
        const snap = await opts.readEpicSnapshot(group.epicId);
        if (!snap) continue;
        if (snap.currentStage !== group.stage) {
          // Epic moved on; the prior repeat dispatches belong to a past
          // state. Skip.
          continue;
        }

        // factory-core-3p1e.10 — suppress when the latest dispatch is
        // actively progressing. The repeat-count counts dispatch events
        // but does not prove "no progress"; the FIRST two firings can
        // legitimately be no-ops (blocked-on a needs-decision child)
        // and the THIRD firing can succeed and launch a real builder.
        // Escalating to coherence in that scenario races a live agent.
        if (opts.probeActiveDispatch) {
          let probe: ActiveDispatchProbeResult;
          try {
            probe = await opts.probeActiveDispatch(group.epicId, group.stage);
          } catch (err) {
            // Probe failure is non-fatal: degrade to "no signal" so a
            // probe defect can't accidentally suppress a real escalation.
            console.warn(
              `[zsjv.6] active-dispatch probe threw for ${group.epicId} ${group.stage}; proceeding to escalate. err=${err instanceof Error ? err.message : String(err)}`,
            );
            probe = { active: false };
          }
          if (probe.active) {
            const jsonlPart = probe.jsonlMtime
              ? `, jsonl_mtime=${probe.jsonlMtime}`
              : probe.lastActivityAt
                ? `, session_activity=${probe.lastActivityAt}`
                : "";
            console.log(
              `[zsjv.6] repeat-dispatch suppressed: ${group.epicId} ${group.stage} latest dispatch active (session=${probe.sessionName ?? "<unknown>"}${jsonlPart})`,
            );
            if (opts.appendSuppressedEvent) {
              try {
                await opts.appendSuppressedEvent({
                  epicId: group.epicId,
                  stage: group.stage,
                  attemptCount: group.count,
                  sessionName: probe.sessionName,
                  jsonlMtime: probe.jsonlMtime,
                  lastActivityAt: probe.lastActivityAt,
                });
              } catch (err) {
                console.error(
                  `[zsjv.6] appendSuppressedEvent threw for ${group.epicId} ${group.stage}: ${err instanceof Error ? err.message : String(err)}`,
                );
              }
            }
            continue; // suppress: do NOT enqueue escalation
          }
        }

        matches.push({
          idempotencyKey: `${REPEAT_DISPATCH_ESCALATION_RULE_NAME}::${group.epicId}::${group.stage}`,
          epicId: group.epicId,
          context: {
            stage: group.stage,
            attemptCount: group.count,
            recentActions: group.recentActions,
          },
        });
      }

      return matches;
    },

    async act(match) {
      const context = match.context as {
        stage: string;
        attemptCount: number;
        recentActions: Array<{ at: string; action: string }>;
      };

      console.log(
        `[zsjv.6] repeat-dispatch-escalation for ${match.epicId}: stage=${context.stage}, ${context.attemptCount} stuck-in-stage recoveries in the last hour without progress. Dispatching coherence agent.`,
      );

      const snap = await opts.readEpicSnapshot(match.epicId);
      if (!snap) {
        throw new Error(
          `[zsjv.6] snapshot read failed for ${match.epicId}; retry next tick`,
        );
      }

      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), 15_000);
      let res: Response;
      try {
        res = await fetch(actionUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "run-coherence-agent",
            epicId: match.epicId,
            epicTitle: snap.title,
            currentLabels: snap.labels,
            anomalyClass: "repeat-dispatch-no-progress",
            coherenceContext: {
              stuckStage: context.stage,
              attemptCount: context.attemptCount,
              recentActions: context.recentActions,
            },
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutHandle);
      }

      if (!res.ok) {
        const text = await res.text().catch(() => "<unreadable>");
        throw new Error(
          `[zsjv.6] run-coherence-agent dispatch for ${match.epicId} returned HTTP ${res.status}: ${text}`,
        );
      }
    },
  };
}

