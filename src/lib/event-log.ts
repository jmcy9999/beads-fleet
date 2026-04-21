/**
 * Append-only event log (factory-core-lfcf.1).
 *
 * The event log is the architectural primitive that breaks the Shipyard's
 * dependency on "decide at the moment the agent exits." Every meaningful
 * pipeline moment (agent launched, agent exited, stage dispatched, pipeline
 * label changed, reconciler action taken) appends a fact here. The
 * reconciler (factory-core-lfcf.2) reads recent facts and determines what
 * SHOULD have happened but didn't — then it acts.
 *
 * Storage model:
 *   - One JSONL file per repo, at `<repoPath>/.beads/events.jsonl`.
 *   - Append-only. One event per line. Line terminator: "\n".
 *   - Single-process writes (beads_web is one Node process). No file
 *     locking required for the append; fs.appendFile is atomic for
 *     small writes on POSIX.
 *   - Reader must tolerate malformed lines (e.g. partial writes if we
 *     ever run into disk-full) — skip with a warning, don't throw.
 *
 * Design decisions (ADR):
 *   - Per-repo, not global. The bead state also lives per-repo; keeping
 *     events colocated preserves the "one repo = one unit of truth"
 *     invariant that the rest of the Shipyard obeys.
 *   - JSONL, not SQLite. Simpler; greppable by operators; easy rotation
 *     later. SQLite gains query power but loses transparency.
 *   - Event-log failures MUST NOT propagate. The whole point is
 *     resilience — making append failures kill the pipeline would recreate
 *     the fragility the event log is supposed to dissolve. See
 *     `appendEvent` below: it swallows and logs on error.
 */

import { promises as fs } from "fs";
import * as path from "path";

/**
 * Canonical event shape. `type` is the discriminator; consumers narrow
 * via type guards on `type`. `payload` is open-ended per event class so
 * new event kinds don't require schema migration.
 */
export interface PipelineEvent {
  /** Discriminator (e.g. "agent-exited", "stage-dispatched"). */
  type: string;
  /** ISO-8601 UTC timestamp. */
  timestamp: string;
  /** Epic the event is about. Always set — the reconciler indexes by epic. */
  epicId: string;
  /** Pipeline stage name when relevant (e.g. "build-review", "qa"). */
  stage?: string;
  /**
   * Correlation identifier for grouping related events. For agent
   * lifecycle events, the tmux session name serves this purpose —
   * launch / exit / subsequent dispatch share it so the reconciler can
   * pair them.
   */
  correlationId?: string;
  /** Event-type-specific payload. Shape is enforced by consumers. */
  payload?: Record<string, unknown>;
}

export interface ReadEventsOptions {
  /** Only return events whose timestamp >= this (ISO-8601). */
  since?: string;
  /** Only return events with exactly this type. */
  type?: string;
  /** Only return events whose epicId matches. */
  epicId?: string;
  /**
   * Cap on returned events. Applied after filtering, from the end of the
   * file (most recent first). Default: 10000.
   */
  limit?: number;
}

/**
 * Resolve the event-log path for a repo. Callers pass the repo root; we
 * append `.beads/events.jsonl`. Not exported — internal detail of the
 * module.
 */
function eventLogPath(repoPath: string): string {
  return path.join(repoPath, ".beads", "events.jsonl");
}

/**
 * Append a single event to the log.
 *
 * **Failure contract:** errors are logged to stderr but never thrown.
 * The pipeline must not stall because telemetry failed. A missed event
 * is strictly worse than a broken pipeline path that would have stalled
 * anyway — the reconciler can recover from missing events in many cases,
 * but cannot recover from a transition the event log prevented.
 */
export async function appendEvent(
  repoPath: string,
  event: Omit<PipelineEvent, "timestamp"> & { timestamp?: string },
): Promise<void> {
  const fullEvent: PipelineEvent = {
    ...event,
    timestamp: event.timestamp ?? new Date().toISOString(),
  };

  try {
    const line = JSON.stringify(fullEvent) + "\n";
    const logPath = eventLogPath(repoPath);
    // Ensure .beads directory exists — safe to call every time;
    // { recursive: true } makes it idempotent.
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await fs.appendFile(logPath, line, { encoding: "utf-8" });
  } catch (err) {
    console.error(
      `[event-log] appendEvent failed for repo=${repoPath} type=${event.type} epic=${event.epicId}:`,
      err instanceof Error ? err.message : err,
    );
    // Swallow. See failure contract above.
  }
}

/**
 * Read events from the log, applying optional filters.
 *
 * Returns newest-first by default — reconciler rules typically want
 * "what happened recently?" not "what happened first?". Callers needing
 * oldest-first can reverse the returned array.
 *
 * Malformed lines are skipped with a single-line warning; the reader does
 * not throw on bad input. This matches the failure contract of
 * appendEvent: the log must be resilient to partial-write corruption.
 *
 * **File-not-found is not an error** — it means nothing has been logged
 * yet. Returns [].
 */
export async function readEvents(
  repoPath: string,
  options: ReadEventsOptions = {},
): Promise<PipelineEvent[]> {
  const logPath = eventLogPath(repoPath);
  let raw: string;
  try {
    raw = await fs.readFile(logPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }

  const lines = raw.split("\n");
  const events: PipelineEvent[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as PipelineEvent;
      if (!parsed || typeof parsed !== "object" || !parsed.type || !parsed.timestamp) {
        console.warn(`[event-log] skipping malformed line in ${logPath}`);
        continue;
      }
      events.push(parsed);
    } catch {
      console.warn(`[event-log] skipping unparseable line in ${logPath}`);
      continue;
    }
  }

  const sinceMs = options.since ? Date.parse(options.since) : -Infinity;

  const filtered = events.filter((e) => {
    if (options.type && e.type !== options.type) return false;
    if (options.epicId && e.epicId !== options.epicId) return false;
    if (options.since) {
      const t = Date.parse(e.timestamp);
      if (Number.isNaN(t) || t < sinceMs) return false;
    }
    return true;
  });

  // newest-first
  filtered.reverse();

  const limit = options.limit ?? 10000;
  return filtered.slice(0, limit);
}

/**
 * Test helper — truncate the event log for a repo. Only exported for tests
 * that need a clean slate. Production code MUST NOT call this; the log is
 * append-only by design.
 */
export async function __resetEventLogForTests(
  repoPath: string,
): Promise<void> {
  const logPath = eventLogPath(repoPath);
  try {
    await fs.unlink(logPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}
