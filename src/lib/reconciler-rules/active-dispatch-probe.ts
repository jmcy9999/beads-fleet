/**
 * factory-core-3p1e.10 — Active-dispatch probe.
 *
 * Helper used by the repeat-dispatch-escalation rule to short-circuit
 * coherence escalation when the LATEST dispatch for a stuck (epicId,
 * stage) is actually making progress.
 *
 * Background: stuck-in-stage emits a `reconciler-action-taken` event
 * every time it fires a recovery dispatch. The repeat-dispatch-escalation
 * rule counts those events; on the third strike it dispatches the
 * coherence agent. But that count does NOT prove "no progress" — it
 * only proves "the rule fired three times." The first two firings can
 * legitimately be no-ops (e.g. the dispatched agent was blocked behind a
 * needs-decision child bead) and the third firing can succeed and launch
 * a real builder that's now happily streaming tokens. Escalating to
 * coherence in that scenario races a live builder.
 *
 * Probe contract: for an (epicId, stage), return `active=true` when
 * BOTH:
 *   (a) a tmux session whose name starts with `shipyard-<epicId>-<stage>-`
 *       is alive (the canonical naming convention from
 *       agent-launcher.ts).
 *   (b) that session is making progress: either the agent's JSONL
 *       transcript file's mtime is within the last 5 minutes, OR the
 *       tmux session's `session_activity` timestamp is within the last
 *       5 minutes.
 *
 * Failure-safe defaults: any probe sub-step that throws or returns
 * unparseable data degrades to "no signal" (returns null / 0 / empty),
 * so a probe failure cannot accidentally suppress a real escalation.
 *
 * All filesystem and tmux access is injected via `ActiveDispatchProbeDeps`
 * so unit tests can drive the probe deterministically without shelling
 * out or touching the home directory.
 */

/** Window for "actively progressing." 5 minutes per AC. */
export const ACTIVE_PROGRESS_WINDOW_MS = 5 * 60_000;

export interface ActiveDispatchProbeDeps {
  /** Currently-alive tmux session names. */
  listTmuxSessions: () => string[];
  /**
   * Last-activity unix timestamp (seconds) for a tmux session. Returns
   * null when the session does not exist or the activity field cannot
   * be read.
   */
  getTmuxSessionActivitySec: (sessionName: string) => number | null;
  /**
   * Most-recent transcript JSONL mtime (milliseconds since epoch) for
   * an epic, or null if no transcript file is available. Implementation
   * must scan ~/.claude/projects/ for files attributable to this epic
   * (typically by inspecting tmux sessions registered under the epic
   * and resolving their session_id → JSONL path).
   */
  findLatestJsonlMtimeMs: (epicId: string) => number | null;
  /** Now in milliseconds. Injected for deterministic tests. */
  now: () => number;
}

export interface ActiveDispatchProbeResult {
  /** True when both AC conditions (a) and (b) are met. */
  active: boolean;
  /** First matching tmux session name, if any session matched. */
  sessionName?: string;
  /**
   * JSONL transcript mtime as ISO-8601 string, when (b) was satisfied
   * via the JSONL path. Useful for the suppression-event payload.
   */
  jsonlMtime?: string;
  /**
   * tmux session_activity as ISO-8601 string, when (b) was satisfied
   * via the tmux fallback OR for diagnostic context even when inactive.
   */
  lastActivityAt?: string;
}

/**
 * Run the active-dispatch probe. Pure (delegates side effects to deps).
 *
 * Decision rule:
 *   1. Find tmux sessions matching `shipyard-<epicId>-<stage>-*`.
 *   2. If none → not active.
 *   3. Pick the session with the most recent activity timestamp (or
 *      the first one if none have activity timestamps). Break ties by
 *      timestamp — newest wins.
 *   4. Check JSONL mtime for the epic. If within the 5-min window,
 *      active=true with `jsonlMtime` populated.
 *   5. Else check the chosen session's activity timestamp. If within
 *      the window, active=true with `lastActivityAt` populated.
 *   6. Otherwise active=false. `sessionName` is still populated so
 *      callers can include the (inactive) session in diagnostic logs.
 */
export function probeActiveDispatch(
  epicId: string,
  stage: string,
  deps: ActiveDispatchProbeDeps,
): ActiveDispatchProbeResult {
  const prefix = `shipyard-${epicId}-${stage}-`;
  const sessions = deps.listTmuxSessions();
  const matching = sessions.filter((s) => s.startsWith(prefix));
  if (matching.length === 0) {
    return { active: false };
  }

  // Pick the matching session with the most recent activity. If no
  // session has an activity timestamp, fall back to the first one.
  let chosen: { name: string; activitySec: number | null } = {
    name: matching[0],
    activitySec: deps.getTmuxSessionActivitySec(matching[0]),
  };
  for (let i = 1; i < matching.length; i++) {
    const a = deps.getTmuxSessionActivitySec(matching[i]);
    if (
      a !== null &&
      (chosen.activitySec === null || a > chosen.activitySec)
    ) {
      chosen = { name: matching[i], activitySec: a };
    }
  }

  const nowMs = deps.now();
  const horizonMs = nowMs - ACTIVE_PROGRESS_WINDOW_MS;
  const lastActivityAt =
    chosen.activitySec !== null
      ? new Date(chosen.activitySec * 1000).toISOString()
      : undefined;

  // (b.i) JSONL mtime check — preferred signal because the transcript
  // file growing means the agent itself is actually emitting tokens
  // (vs tmux activity which can come from passive escape sequences).
  const jsonlMs = deps.findLatestJsonlMtimeMs(epicId);
  if (jsonlMs !== null && jsonlMs >= horizonMs) {
    return {
      active: true,
      sessionName: chosen.name,
      jsonlMtime: new Date(jsonlMs).toISOString(),
      lastActivityAt,
    };
  }

  // (b.ii) Fallback: tmux session_activity within the window.
  if (chosen.activitySec !== null && chosen.activitySec * 1000 >= horizonMs) {
    return {
      active: true,
      sessionName: chosen.name,
      lastActivityAt,
    };
  }

  return {
    active: false,
    sessionName: chosen.name,
    lastActivityAt,
  };
}
