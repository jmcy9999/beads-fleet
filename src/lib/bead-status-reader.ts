// =============================================================================
// Beads Fleet — Bead Status Reader (beads_web-ehp.1)
// =============================================================================
//
// Thin async wrapper around `bd show <id> --json` that returns a typed
// BeadSnapshot value object — the canonical "what does this bead actually
// look like right now?" probe used by the dispatch-precondition library
// (Wave 2) and the precondition-checking reconciler rules (Wave 3).
//
// Layer: Infrastructure (no business logic). Returns null on every failure
// mode (binary missing, non-zero exit, malformed JSON, partial output,
// unknown status enum) — callers decide what null means in their context.
//
// Persistence: no caching. Each call is a fresh `bd show --json` per the
// architecture doc § Persistence Strategy. ehp epic ADR-002 is load-bearing
// on this reader returning null cleanly so that callers can distinguish
// "bd unreachable" from "bead in a known state" without try/catch.
//
// Precedent: src/lib/reconciler-bootstrap.ts inline `readBeadStatus` callback
// (lines ~629-647). That callback returns only `status`; this module
// generalises to the full BeadSnapshot shape (id + status + labels + type +
// derived label-aware fields) needed by Wave 2's evaluatePreconditions.
//
// Output shape (verified against live bd 2026-05-06):
//   `bd show <id> --json` returns a JSON ARRAY of one bead object with keys:
//     id, title, description, status, priority, issue_type, owner,
//     created_at, created_by, updated_at, labels (string[]), dependencies,
//     dependents.
//   Status enum: open | in_progress | blocked | closed | deferred.
// =============================================================================

import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
import { getBdEnv, getBdPath } from "./bd-path";

/**
 * Bead status enum mirroring `bd`'s wire enum.
 * Source: live `bd show --json` invocation 2026-05-06; verified against
 * existing inline callsite at `reconciler-bootstrap.ts` ~line 641.
 */
export type BeadStatus =
  | "open"
  | "in_progress"
  | "blocked"
  | "closed"
  | "deferred";

const BEAD_STATUSES: ReadonlySet<string> = new Set<BeadStatus>([
  "open",
  "in_progress",
  "blocked",
  "closed",
  "deferred",
]);

/**
 * Snapshot of a bead's current state, derived from a single `bd show` read.
 *
 * Raw fields mirror bd's wire shape (id/status/labels/type). Derived fields
 * are computed from labels by this reader so callers don't re-parse them.
 */
export interface BeadSnapshot {
  // ---- Raw fields (from bd wire) ------------------------------------------
  id: string;
  status: BeadStatus;
  labels: string[];
  /** bd's `issue_type`: e.g., "task" | "bug" | "feature" | "epic". */
  type: string;

  // ---- Derived fields (label-driven) --------------------------------------
  /** Suffix of the `pipeline:<stage>` label, or null if absent. */
  pipelineStage: string | null;
  /** Highest N across `qa:round-N` labels, or null if absent. */
  currentQaRound: number | null;
  /** Lowest N across `wave:N` labels, or null if absent. */
  currentWave: number | null;
  /** True iff `agent:running` label present. */
  hasAgentRunning: boolean;
  /** True iff `review:needs-human` label present. */
  hasReviewNeedsHuman: boolean;
}

/** 15s spawn timeout — wider than reconciler-bootstrap's 10s to absorb cold-start daemon RPC latency on first read. */
const BD_TIMEOUT_MS = 15_000;

/**
 * Read a bead's current state via `bd show <id> --json`.
 *
 * @param beadId  Full bd identifier (e.g., `beads_web-ehp.1` or
 *                `factory-core-niii.5`). Caller is responsible for shell-safe
 *                bead IDs — they should never contain whitespace or shell
 *                metacharacters under bd's id grammar.
 * @param repoPath Absolute path to the repo whose Dolt server hosts the bead.
 *                 Passed as `cwd` to the spawned bd process.
 * @returns Populated BeadSnapshot, or null on ANY failure mode (binary
 *          missing, non-zero exit, timeout, malformed JSON, empty/partial
 *          payload, unknown status enum). Never throws.
 */
export async function readBeadStatus(
  beadId: string,
  repoPath: string,
): Promise<BeadSnapshot | null> {
  let raw: string;
  try {
    const bd = getBdPath();
    const env = getBdEnv();
    // hfw + q8w (2026-05-07 fix): execFile (argv) replaces execSync (shell-string).
    // hfw: shell-string interpolation made `${beadId}` a shell-injection vector.
    // q8w: blocking execSync inside an async function stalled Next.js's event loop
    // on every dispatch (60s+ tail latency under load).
    // Now: argv-based execFile via promisify — no shell, non-blocking.
    const { stdout } = await execFileAsync(bd, ["show", beadId, "--json"], {
      cwd: repoPath,
      encoding: "utf-8",
      env,
      timeout: BD_TIMEOUT_MS,
    });
    raw = stdout;
  } catch {
    return null; // binary missing | non-zero exit | timeout — tolerate, callers treat null as "unknown"
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // malformed JSON / partial payload
  }

  // bd ships beads as a single-element array; tolerate a bare object too in case
  // a future bd version drops the array wrapper.
  const bead = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!bead || typeof bead !== "object") return null;

  const obj = bead as Record<string, unknown>;
  const id = typeof obj.id === "string" ? obj.id : null;
  const status = typeof obj.status === "string" ? obj.status : null;
  if (!id || !status || !BEAD_STATUSES.has(status)) return null;

  const labels: string[] = Array.isArray(obj.labels)
    ? obj.labels.filter((l): l is string => typeof l === "string")
    : [];
  // bd's wire field is `issue_type`; tolerate `type` for forward-compat.
  const type =
    typeof obj.issue_type === "string"
      ? obj.issue_type
      : typeof obj.type === "string"
        ? obj.type
        : "";

  return {
    id,
    status: status as BeadStatus,
    labels,
    type,
    pipelineStage: derivePipelineStage(labels),
    currentQaRound: deriveCurrentQaRound(labels),
    currentWave: deriveCurrentWave(labels),
    hasAgentRunning: labels.includes("agent:running"),
    hasReviewNeedsHuman: labels.includes("review:needs-human"),
  };
}

function derivePipelineStage(labels: string[]): string | null {
  const match = labels.find((l) => l.startsWith("pipeline:"));
  return match ? match.slice("pipeline:".length) : null;
}

function deriveCurrentQaRound(labels: string[]): number | null {
  let max: number | null = null;
  for (const l of labels) {
    const m = /^qa:round-(\d+)$/.exec(l);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && (max === null || n > max)) max = n;
    }
  }
  return max;
}

function deriveCurrentWave(labels: string[]): number | null {
  let min: number | null = null;
  for (const l of labels) {
    const m = /^wave:(\d+)$/.exec(l);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && (min === null || n < min)) min = n;
    }
  }
  return min;
}
