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
   * Optional throttle: minimum milliseconds between two consecutive
   * executions of this rule. When set, the reconciler skips the rule
   * on a tick if less than minTickIntervalMs has elapsed since the
   * last run. Undefined = run every tick (default).
   *
   * Use for rules that watch slow-moving state (repeated-qa-round,
   * liveness-check, coherence-escalation) so they don't waste bd
   * calls on every 10s tick. Fast-reacting rules (stuck-in-stage,
   * missed-wave-review-dispatch) should leave this undefined.
   */
  minTickIntervalMs?: number;
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
   *
   * beads_web-3e6 (2026-05-08): act() may now return a `RuleActResult`
   * to signal a precondition refusal (e.g. PLAN_PENDING, AGENT_RUNNING_
   * NO_SESSION). When a refusal is returned, the reconciler does NOT
   * append a `reconciler-action-taken` event, so the idempotency bucket
   * is NOT consumed and the rule will re-fire on subsequent ticks once
   * the underlying refusal-condition has cleared (e.g. plan flipped from
   * pending → approved by auto-approve-internal-plans). Returning void
   * (or an undefined / non-refusal result) preserves the prior contract:
   * the action-taken event is appended and the bucket is consumed. Throws
   * still preserve zsjv hotfix semantics — error recorded with success=
   * false, bucket consumed (no infinite retry on permanent failure).
   */
  act(match: ReconcilerMatch): Promise<void | RuleActResult>;
}

/**
 * beads_web-3e6: rule.act() may return this sentinel to signal that the
 * dispatch was refused at a precondition gate. The reconciler treats
 * refusals as "condition not met yet — try again next tick" and skips
 * the action-taken event so the idempotency bucket stays open. Use this
 * for STATE-DEPENDENT refusals where the condition can plausibly change
 * (auto-approve flips plan:pending → plan:approved; agent:running gets
 * stripped on session-exit; review:* labels get cleared by operator).
 * Do NOT use this for permanent errors (4xx from action endpoint, missing
 * required param) — those should THROW so the bucket is consumed under
 * zsjv semantics.
 */
export interface RuleActResult {
  refused: true;
  refusalCode?: string;
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

/**
 * factory-core-3akh.1: max concurrent reconciler dispatches. When the
 * reconciler detects many matches simultaneously, firing them all at
 * once saturates the bd subprocess pool + Dolt connections, causing
 * load spikes and API timeouts. Cap defers excess dispatches to the
 * next tick (idempotency key is NOT consumed for deferred matches, so
 * they re-appear and fire once capacity is free).
 *
 * Default 3 — empirically chosen: lets the reconciler keep up with
 * typical stall recovery rates without crushing bd under load.
 * Overridable via RECONCILER_MAX_CONCURRENT env var.
 */
export const DEFAULT_MAX_CONCURRENT_DISPATCHES = 3;

interface RuleStats {
  lastMatchedAt?: string;
  totalActionsDispatched: number;
  /**
   * factory-core-3akh.2: per-rule throttle bookkeeping. The reconciler
   * uses this to enforce minTickIntervalMs — a rule's matches() runs
   * only if (now - lastRunAtMs) >= minTickIntervalMs.
   */
  lastRunAtMs?: number;
}

export class Reconciler {
  private rules: ReconcilerRule[] = [];
  private intervalHandle: NodeJS.Timeout | null = null;
  private repoPath: string;
  private tickIntervalMs: number;
  private lookbackMs: number;
  private idempotencyHorizonMs: number;
  /** factory-core-3akh.1: concurrent dispatch cap. */
  private maxConcurrentDispatches: number;
  /** factory-core-3akh.1: in-flight dispatch count (live during tick). */
  private inFlightDispatches = 0;

  private lastTickAt?: string;
  private eventsProcessedLastTick = 0;
  private actionsDispatchedLastTick = 0;
  private ruleStats = new Map<string, RuleStats>();
  private recentActions: ReconcilerStatus["recentActions"] = [];
  // zsjv hotfix 2026-04-21: prevent overlapping ticks. If a tick runs
  // longer than tickIntervalMs (normal when fetches hit the 15s
  // timeout), setInterval fires the next tick before the previous one
  // finishes — both read the same frozen events snapshot, both pass
  // idempotency, both dispatch. Multiple dispatches per 10s interval.
  // This flag serialises tick execution; overlapping fires become no-ops.
  private tickInProgress = false;

  constructor(options: {
    repoPath: string;
    tickIntervalMs?: number;
    lookbackMs?: number;
    idempotencyHorizonMs?: number;
    maxConcurrentDispatches?: number;
  }) {
    this.repoPath = options.repoPath;
    // 2026-05-07 emergency throttle: reconciler tick contention (40 repos × 5+ rules ×
    // bd subprocess per rule, every 10s) was saturating the event loop and starving
    // /api/fleet/action + /api/issues responses (60-90s+). Tracked under beads_web-poh.4.
    // RECONCILER_TICK_MS env var allows operator override; default bumped 10s → 60s.
    const envTick = parseInt(process.env.RECONCILER_TICK_MS ?? "", 10);
    this.tickIntervalMs =
      options.tickIntervalMs ??
      (Number.isFinite(envTick) && envTick > 0 ? envTick : 60_000);
    this.lookbackMs = options.lookbackMs ?? DEFAULT_LOOKBACK_MS;
    this.idempotencyHorizonMs =
      options.idempotencyHorizonMs ?? DEFAULT_IDEMPOTENCY_HORIZON_MS;
    // factory-core-3akh.1: constructor > env > compile-time default.
    const envCap = parseInt(
      process.env.RECONCILER_MAX_CONCURRENT ?? "",
      10,
    );
    this.maxConcurrentDispatches =
      options.maxConcurrentDispatches ??
      (Number.isFinite(envCap) && envCap > 0
        ? envCap
        : DEFAULT_MAX_CONCURRENT_DISPATCHES);
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
    // zsjv hotfix: skip if a previous tick is still running. Protects
    // against setInterval overlap when a tick runs longer than the
    // interval (common when fetches time out at 15s on a 10s tick).
    if (this.tickInProgress) {
      return;
    }
    this.tickInProgress = true;
    try {
      await this._tickInternal(now);
    } finally {
      this.tickInProgress = false;
    }
  }

  private async _tickInternal(now: Date): Promise<void> {
    const since = new Date(now.getTime() - this.lookbackMs).toISOString();
    this.lastTickAt = now.toISOString();
    // beads_web-poh follow-on (2026-05-08): regression-visibility log.
    // Without this we cannot distinguish "reconciler is ticking, just
    // doing nothing" from "reconciler is wedged / never bootstrapped"
    // by reading the orchestrator log alone — and the status endpoint
    // can lie (see the prerender cache failure mode in the status
    // route's force-dynamic comment). One line per tick at info level
    // is cheap (60s default tick) and makes "is it actually running?"
    // a one-grep question.
    console.log(`[reconciler] tick fired at ${this.lastTickAt}`);

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
    // factory-core-3akh.1: reset in-flight counter per tick. act() is
    // awaited sequentially in the current loop, so counter is 0 at tick
    // start and climbs as dispatches fire. When cap is hit, remaining
    // matches defer to next tick (idempotency bucket not consumed).
    this.inFlightDispatches = 0;

    for (const rule of this.rules) {
      // factory-core-3akh.2: per-rule throttle. Skip the rule if it ran
      // more recently than minTickIntervalMs ago. Saves bd calls inside
      // matches() — which is the hot path that generates load.
      if (rule.minTickIntervalMs !== undefined) {
        const stats = this.ruleStats.get(rule.name);
        const lastRunAtMs = stats?.lastRunAtMs;
        if (
          lastRunAtMs !== undefined &&
          now.getTime() - lastRunAtMs < rule.minTickIntervalMs
        ) {
          continue;
        }
      }

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

      // Record that we ran this rule's matches — lastRunAtMs drives the
      // per-rule throttle above.
      {
        const stats =
          this.ruleStats.get(rule.name) ?? { totalActionsDispatched: 0 };
        stats.lastRunAtMs = now.getTime();
        this.ruleStats.set(rule.name, stats);
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

        // factory-core-3akh.1: concurrency cap. If we're already at
        // max in-flight dispatches for this tick, skip WITHOUT
        // consuming the idempotency bucket. The match re-appears on
        // the next tick and fires when capacity is free.
        if (this.inFlightDispatches >= this.maxConcurrentDispatches) {
          console.log(
            `[reconciler] concurrency cap (${this.maxConcurrentDispatches}) reached — deferring ${rule.name}::${match.idempotencyKey} to next tick`,
          );
          continue;
        }
        this.inFlightDispatches += 1;

        // factory-core-zsjv hotfix 2026-04-21: ALWAYS emit action-taken
        // when act() returns normally OR throws — preventing infinite
        // retry on permanent failures (missing param, 4xx).
        //
        // beads_web-3e6 2026-05-08: EXCEPTION — act() may now return
        // `{ refused: true, refusalCode }` to signal a state-dependent
        // refusal (PLAN_PENDING, AGENT_RUNNING_NO_SESSION, REVIEW_NEEDS_
        // HUMAN, ROUTE_REFUSED_412). On refusal we do NOT append the
        // action-taken event, so the idempotency bucket stays open and
        // the rule re-fires next tick once the refusal-condition has
        // cleared. The rule itself appends a `reconciler-action-refused`
        // event for accountability. This closes the cascade where a
        // first-attempt refusal (e.g. start-wave called BEFORE auto-
        // approve-internal-plans flips plan:pending → plan:approved)
        // would block all subsequent attempts even after the refusal-
        // reason was gone. zsjv's permanent-failure protection is
        // preserved: throws still consume the bucket; only EXPLICIT
        // refusal sentinels skip the action-taken event.
        let actError: string | undefined;
        let actResult: void | RuleActResult = undefined;
        try {
          actResult = await rule.act(match);
          this.actionsDispatchedLastTick += 1;
        } catch (err) {
          actError = err instanceof Error ? err.message : String(err);
          console.error(
            `[reconciler] rule "${rule.name}" act() threw for key="${match.idempotencyKey}": ${actError}`,
          );
        }

        const refused =
          !!actResult &&
          (actResult as RuleActResult).refused === true;

        const stats =
          this.ruleStats.get(rule.name) ?? { totalActionsDispatched: 0 };
        // Refusals don't count as a dispatched action: nothing was
        // actually dispatched. lastMatchedAt still updates so observers
        // can see the rule is alive.
        if (!refused) {
          stats.totalActionsDispatched += 1;
        }
        stats.lastMatchedAt = now.toISOString();
        this.ruleStats.set(rule.name, stats);

        if (refused) {
          // 3e6: roll back the dispatched-counter increment we
          // optimistically did above (line "this.actionsDispatchedLast
          // Tick += 1"). The increment lives inside the try{} because
          // it has to be paired with `actResult = await rule.act()` —
          // a refusal shouldn't count toward dispatched-this-tick.
          this.actionsDispatchedLastTick = Math.max(
            0,
            this.actionsDispatchedLastTick - 1,
          );
          console.log(
            `[reconciler] rule "${rule.name}" act() refused with code=${(actResult as RuleActResult).refusalCode ?? "<none>"} for key="${match.idempotencyKey}" — idempotency bucket NOT consumed (will re-fire next tick if conditions still match)`,
          );
          continue;
        }

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

        // Always-emit (success path + throw path): consumes the
        // idempotency bucket so the next tick sees this action as
        // already taken. Errors in the payload make the failure visible
        // for debugging. Refusal path returns above and skips this
        // emit — see beads_web-3e6 above.
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
//
// zsjv hotfix 2026-04-21: Next.js dev mode creates separate module
// instances per compiled route chunk. A module-local `let` does NOT
// persist across those instances — each route sees its own `null`
// singleton and re-initialises the reconciler. Result: 3+ concurrent
// reconciler instances writing to the same event log, causing
// apparent idempotency failures.
//
// Fix: stash the singleton on `globalThis`. globalThis is shared
// process-wide regardless of how many module instances exist.

interface GlobalWithReconciler {
  __beadsWebReconciler?: Reconciler | null;
}

function getGlobal(): GlobalWithReconciler {
  return globalThis as unknown as GlobalWithReconciler;
}

export function getGlobalReconciler(): Reconciler | null {
  return getGlobal().__beadsWebReconciler ?? null;
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
  const g = getGlobal();
  if (g.__beadsWebReconciler) {
    g.__beadsWebReconciler.stop();
  }
  g.__beadsWebReconciler = new Reconciler({ repoPath });
  console.log(
    `[reconciler] initialized with repoPath=${repoPath}, tickIntervalMs=${g.__beadsWebReconciler["tickIntervalMs"]}`,
  );
  return g.__beadsWebReconciler;
}

/**
 * Test helper — forcibly stop and clear the global reconciler. Only for
 * tests that spin up their own reconciler after needing a clean slate.
 */
export function __resetGlobalReconcilerForTests(): void {
  const g = getGlobal();
  if (g.__beadsWebReconciler) {
    g.__beadsWebReconciler.stop();
    g.__beadsWebReconciler = null;
  }
}

