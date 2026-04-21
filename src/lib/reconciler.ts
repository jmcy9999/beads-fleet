/**
 * Reconciler loop + rule registration API (factory-core-lfcf.2).
 *
 * Reads events produced by `event-log.ts` on a periodic tick and fires
 * declarative rules against them. Each rule looks at recent events and
 * decides "does something need to happen that hasn't?" — if so, the
 * reconciler acts (typically dispatching a pipeline chain action) and
 * appends a `reconciler-action-taken` event for idempotency.
 *
 * This file ships the scaffold. The first real rule lands in lfcf.4
 * (missed-wave-review-dispatch). A no-op placeholder rule is registered
 * here to exercise the wiring without producing behaviour.
 *
 * Architectural notes:
 *   - In-process setInterval for MVP. Not durable across beads_web
 *     restarts, but every restart re-reads the event log from scratch
 *     so the reconciler is re-hydrated for free — no persistent state
 *     needs to be stored in the reconciler itself.
 *   - Idempotency lives in rules, not in the loop. Each rule defines
 *     an idempotency key per match and consults the event log for a
 *     prior `reconciler-action-taken` event with that key before acting.
 *     This puts responsibility for "has this already been done?" at the
 *     rule level where the domain knowledge lives.
 *   - Rule exceptions MUST NOT kill the loop. Each rule runs inside a
 *     try/catch; failures are logged and the tick continues with the
 *     other rules. The whole point of the reconciler is resilience —
 *     one faulty rule should not stall recovery of every other issue.
 */

import { appendEvent, readEvents, type PipelineEvent } from "./event-log";

/**
 * One concrete intention to act, produced by a rule's `matches()` call.
 * The reconciler guarantees:
 *   - `idempotencyKey` is checked against prior `reconciler-action-taken`
 *     events in the lookback window; duplicate keys short-circuit before
 *     `act()` is called.
 *   - `epicId` and `ruleName` are preserved in the action-taken event
 *     emitted after a successful act.
 */
export interface ReconcilerMatch {
  /** Rule-scoped unique key for this match. Used for idempotency check. */
  idempotencyKey: string;
  /** Epic this action is about. */
  epicId: string;
  /** Arbitrary rule-specific context, preserved in action-taken payload. */
  context?: Record<string, unknown>;
}

/**
 * Rule contract. A rule is two pure-ish functions:
 *   matches — read recent events, return 0..N intentions to act.
 *   act — execute an intention (side effect).
 *
 * Keeping `matches` pure means the loop can be tested by passing in a
 * synthetic event array; real fs access only happens inside `act`.
 */
export interface ReconcilerRule {
  /** Unique rule name — appears in logs and action-taken events. */
  name: string;
  /**
   * Pure(-ish) function: given recent events and the current time, return
   * matches that describe what to do. May read external state for
   * context, but MUST NOT mutate.
   */
  matches(events: PipelineEvent[], now: Date): Promise<ReconcilerMatch[]>;
  /**
   * Side-effectful action. Typically dispatches a chain action via
   * /api/fleet/action. Must be safe to retry — if it throws, the
   * reconciler logs and continues; the next tick will see the same
   * match again and try again unless the idempotency check blocks it.
   */
  act(match: ReconcilerMatch): Promise<void>;
}

export interface ReconcilerStatus {
  running: boolean;
  lastTickAt?: string;
  tickIntervalMs: number;
  eventsProcessedLastTick: number;
  actionsDispatchedLastTick: number;
  rulesRegistered: Array<{
    name: string;
    lastMatchedAt?: string;
    totalActionsDispatched: number;
  }>;
  recentActions: Array<{
    at: string;
    ruleName: string;
    epicId: string;
    idempotencyKey: string;
  }>;
}

/**
 * How far back the reconciler looks for events on each tick. Must be
 * comfortably longer than the longest "transition should have happened
 * by now" deadline any rule cares about. zsjv.1 (stuck-in-stage) needs
 * to see events 15-60 min old; lfcf.4 (missed-wave-review) only needs
 * 10 min. We set the default to the longest rule need. Reads are cheap
 * (append-only JSONL, line-oriented parse) so a wider window doesn't
 * cost much per tick.
 */
export const DEFAULT_LOOKBACK_MS = 60 * 60 * 1000;

/**
 * How far back to look when checking idempotency. Should match (or
 * exceed) the longest "is this match still the same one?" horizon. MVP:
 * 1 hour — a rule that fires once per hour maximum should feel natural.
 */
export const DEFAULT_IDEMPOTENCY_HORIZON_MS = 60 * 60 * 1000;

interface RuleStats {
  lastMatchedAt?: string;
  totalActionsDispatched: number;
}

export class Reconciler {
  private rules: ReconcilerRule[] = [];
  private intervalHandle: NodeJS.Timeout | null = null;
  private repoPath: string;
  private tickIntervalMs: number;
  private lookbackMs: number;
  private idempotencyHorizonMs: number;

  private lastTickAt?: string;
  private eventsProcessedLastTick = 0;
  private actionsDispatchedLastTick = 0;
  private ruleStats = new Map<string, RuleStats>();
  private recentActions: ReconcilerStatus["recentActions"] = [];

  constructor(options: {
    repoPath: string;
    tickIntervalMs?: number;
    lookbackMs?: number;
    idempotencyHorizonMs?: number;
  }) {
    this.repoPath = options.repoPath;
    this.tickIntervalMs = options.tickIntervalMs ?? 10_000;
    this.lookbackMs = options.lookbackMs ?? DEFAULT_LOOKBACK_MS;
    this.idempotencyHorizonMs =
      options.idempotencyHorizonMs ?? DEFAULT_IDEMPOTENCY_HORIZON_MS;
  }

  registerRule(rule: ReconcilerRule): void {
    if (this.rules.some((r) => r.name === rule.name)) {
      throw new Error(
        `[reconciler] rule already registered with name "${rule.name}"`,
      );
    }
    this.rules.push(rule);
    this.ruleStats.set(rule.name, { totalActionsDispatched: 0 });
  }

  start(): void {
    if (this.intervalHandle) return; // already started
    // Kick off an immediate first tick so startup state is visible
    // without waiting one full interval.
    void this.tick();
    this.intervalHandle = setInterval(() => {
      void this.tick();
    }, this.tickIntervalMs);
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  /**
   * Run a single reconciliation tick. Public so tests can drive ticks
   * deterministically without relying on setInterval timing.
   */
  async tick(now: Date = new Date()): Promise<void> {
    const since = new Date(now.getTime() - this.lookbackMs).toISOString();
    this.lastTickAt = now.toISOString();

    let events: PipelineEvent[];
    try {
      events = await readEvents(this.repoPath, { since });
    } catch (err) {
      console.error(
        "[reconciler] failed to read events — skipping tick:",
        err instanceof Error ? err.message : err,
      );
      this.eventsProcessedLastTick = 0;
      this.actionsDispatchedLastTick = 0;
      return;
    }

    this.eventsProcessedLastTick = events.length;
    this.actionsDispatchedLastTick = 0;

    for (const rule of this.rules) {
      let matches: ReconcilerMatch[] = [];
      try {
        matches = await rule.matches(events, now);
      } catch (err) {
        console.error(
          `[reconciler] rule "${rule.name}" matches() threw — skipping:`,
          err instanceof Error ? err.message : err,
        );
        continue;
      }

      for (const match of matches) {
        // Idempotency check: has this exact (rule, key) already acted
        // within the idempotency horizon?
        const alreadyActed = events.some((e) => {
          if (e.type !== "reconciler-action-taken") return false;
          if (
            (e.payload as { ruleName?: string } | undefined)?.ruleName !==
            rule.name
          )
            return false;
          if (
            (e.payload as { idempotencyKey?: string } | undefined)
              ?.idempotencyKey !== match.idempotencyKey
          )
            return false;
          const eventMs = Date.parse(e.timestamp);
          if (Number.isNaN(eventMs)) return false;
          return now.getTime() - eventMs <= this.idempotencyHorizonMs;
        });

        if (alreadyActed) {
          continue; // short-circuit — this action was already taken
        }

        // factory-core-zsjv hotfix 2026-04-21: ALWAYS emit action-taken
        // regardless of act() success/failure. Previously a throwing
        // act() left the idempotency bucket unconsumed, so a permanent
        // failure (missing param, 4xx from action endpoint) would hammer
        // the same dispatch every tick for the entire idempotency
        // horizon. Now: bucket is consumed whether the dispatch
        // succeeded or not; transient failures still get retried when
        // the idempotency bucket naturally rotates (15 min for
        // stuck-in-stage, 1 hour for rule-scoped buckets).
        let actError: string | undefined;
        try {
          await rule.act(match);
          this.actionsDispatchedLastTick += 1;
        } catch (err) {
          actError = err instanceof Error ? err.message : String(err);
          console.error(
            `[reconciler] rule "${rule.name}" act() threw for key="${match.idempotencyKey}": ${actError}`,
          );
        }

        const stats =
          this.ruleStats.get(rule.name) ?? { totalActionsDispatched: 0 };
        stats.totalActionsDispatched += 1;
        stats.lastMatchedAt = now.toISOString();
        this.ruleStats.set(rule.name, stats);

        const actionRecord = {
          at: now.toISOString(),
          ruleName: rule.name,
          epicId: match.epicId,
          idempotencyKey: match.idempotencyKey,
        };
        this.recentActions.unshift(actionRecord);
        if (this.recentActions.length > 50) {
          this.recentActions = this.recentActions.slice(0, 50);
        }

        // Always-emit: consumes the idempotency bucket so the next tick
        // sees this action as already taken. Errors in the payload make
        // the failure visible for debugging.
        await appendEvent(this.repoPath, {
          type: "reconciler-action-taken",
          epicId: match.epicId,
          payload: {
            ruleName: rule.name,
            idempotencyKey: match.idempotencyKey,
            context: match.context,
            ...(actError !== undefined && {
              success: false,
              error: actError,
            }),
          },
        });
      }
    }
  }

  getStatus(): ReconcilerStatus {
    return {
      running: this.intervalHandle !== null,
      lastTickAt: this.lastTickAt,
      tickIntervalMs: this.tickIntervalMs,
      eventsProcessedLastTick: this.eventsProcessedLastTick,
      actionsDispatchedLastTick: this.actionsDispatchedLastTick,
      rulesRegistered: this.rules.map((r) => ({
        name: r.name,
        lastMatchedAt: this.ruleStats.get(r.name)?.lastMatchedAt,
        totalActionsDispatched:
          this.ruleStats.get(r.name)?.totalActionsDispatched ?? 0,
      })),
      recentActions: [...this.recentActions],
    };
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton + startup helpers
// ---------------------------------------------------------------------------

let globalReconciler: Reconciler | null = null;

export function getGlobalReconciler(): Reconciler | null {
  return globalReconciler;
}

/**
 * Called from instrumentation.ts on beads_web server startup. Idempotent:
 * calling multiple times has no effect. Hot-reload safe: if the module
 * reloads (dev mode), the old reconciler is stopped first.
 *
 * NOTE: rule registration is NOT done here. The caller is responsible for
 * registering rules BEFORE calling start — this keeps reconciler.ts
 * completely independent of the rules and their dependencies (which may
 * pull in agent-launcher.ts / child_process / bd CLI and therefore can't
 * safely live inside a module that might be bundled client-side).
 */
export function initReconciler(repoPath: string): Reconciler {
  if (globalReconciler) {
    globalReconciler.stop();
  }
  globalReconciler = new Reconciler({ repoPath });
  console.log(
    `[reconciler] initialized with repoPath=${repoPath}, tickIntervalMs=${globalReconciler["tickIntervalMs"]}`,
  );
  return globalReconciler;
}

/**
 * Test helper — forcibly stop and clear the global reconciler. Only for
 * tests that spin up their own reconciler after needing a clean slate.
 */
export function __resetGlobalReconcilerForTests(): void {
  if (globalReconciler) {
    globalReconciler.stop();
    globalReconciler = null;
  }
}

