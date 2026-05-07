// =============================================================================
// beads_web-poh.17 — Persistent dispatch sentinels for marker-driven-routing
// =============================================================================
//
// The reconciler's idempotency mechanism dedupes dispatches by replaying
// `reconciler-action-taken` events from `events.jsonl` within a 60-minute
// horizon. Two failure modes break that mechanism in production:
//
//   1. The horizon rotates. After 60 minutes the bucket releases and a stale
//      marker (still on disk, untouched, already dispatched once) re-fires
//      via the filesystem-walk fallback in `marker-driven-routing.ts`.
//   2. `events.jsonl` rotation, daemon restart, or operator-side cleanup
//      drops the historical record. The dedupe check fails open and the
//      marker re-fires the next tick.
//
// Empirical: factory-core-1vud (2026-05-07) saw the product-manager agent
// re-dispatched four times against the same research marker as those
// horizons rotated.
//
// This module persists, alongside each marker, a small sentinel file
// recording the dispatch timestamp and the marker's mtime at dispatch time.
// matches() consults the sentinel before pushing a re-dispatch:
//   - no sentinel        → fresh routing intent, push
//   - sentinel exists, marker mtime <= sentinel.markerMtimeMs
//                         → already dispatched, marker unchanged, skip
//   - sentinel exists, marker mtime >  sentinel.markerMtimeMs
//                         → marker was REWRITTEN by the agent (genuine
//                           new intent — e.g. agent retried with different
//                           next_agent), push
//
// Sentinels live at `<repoPath>/.beads/markers/.dispatched/<key>.json`
// where `<key>` is the rule's idempotency key with `:` replaced by `_` so
// the path is filesystem-safe.
// =============================================================================

import { promises as fs, existsSync, readFileSync, statSync } from "fs";
import path from "path";

export interface DispatchSentinel {
  /** Full idempotency key the dispatch was recorded under. */
  idempotencyKey: string;
  /** ISO 8601 instant the dispatch was performed. */
  dispatchedAt: string;
  /** Marker file mtime (ms since epoch) AT DISPATCH TIME. */
  markerMtimeMs: number;
  /** Optional: marker filename for human debug. */
  markerId?: string;
  /** Optional: agent dispatched, for human debug. */
  nextAgent?: string;
}

const SENTINEL_DIR_NAME = ".dispatched";

/**
 * Encode an idempotency key into a filesystem-safe filename. POSIX paths
 * cannot contain `/`, and `:` is a separator on some legacy filesystems —
 * replace both with `_`.
 */
export function encodeIdempotencyKey(idempotencyKey: string): string {
  return idempotencyKey.replace(/[/:]/g, "_");
}

/**
 * Compute the on-disk path for a sentinel.
 */
export function sentinelPath(repoPath: string, idempotencyKey: string): string {
  return path.join(
    repoPath,
    ".beads",
    "markers",
    SENTINEL_DIR_NAME,
    `${encodeIdempotencyKey(idempotencyKey)}.json`,
  );
}

/**
 * Synchronous read used by the reconciler rule's matches() so the rule
 * stays single-pass over the filesystem walk. Returns `null` when the
 * sentinel does not exist or fails to parse — callers should treat both
 * as "no prior dispatch recorded" (fail-open is correct: the worst case
 * is one extra dispatch, which the reconciler's own event-log dedupe
 * still catches inside the 60-minute horizon).
 */
export function readDispatchSentinelSync(
  repoPath: string,
  idempotencyKey: string,
): DispatchSentinel | null {
  const p = sentinelPath(repoPath, idempotencyKey);
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, "utf-8");
    const parsed = JSON.parse(raw) as DispatchSentinel;
    if (
      typeof parsed.idempotencyKey === "string" &&
      typeof parsed.dispatchedAt === "string" &&
      typeof parsed.markerMtimeMs === "number"
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Async write used by act() after a successful dispatch. Atomic via
 * write-then-rename to avoid partial reads on a concurrent matches()
 * tick. Best-effort: failures are logged and swallowed because the
 * sentinel is a defence-in-depth layer — the reconciler's event-log
 * dedupe still works without it.
 */
export async function writeDispatchSentinel(
  repoPath: string,
  idempotencyKey: string,
  sentinel: DispatchSentinel,
): Promise<void> {
  const target = sentinelPath(repoPath, idempotencyKey);
  const dir = path.dirname(target);
  try {
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${target}.tmp.${process.pid}.${Math.random()
      .toString(36)
      .slice(2, 10)}`;
    await fs.writeFile(tmp, JSON.stringify(sentinel, null, 2), "utf-8");
    await fs.rename(tmp, target);
  } catch (err) {
    console.warn(
      `[xfc] writeDispatchSentinel failed for ${idempotencyKey} in ${repoPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Stat a marker file and return its mtime in ms. Returns 0 when the
 * file is missing or unreadable — callers compare with strict `<=` so
 * 0 means "treat as oldest possible" and any sentinel always wins.
 */
export function statMarkerMtimeSync(
  repoPath: string,
  markerId: string,
): number {
  const p = path.join(repoPath, ".beads", "markers", `${markerId}.json`);
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}
