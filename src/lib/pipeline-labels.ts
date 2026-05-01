// =============================================================================
// Beads Fleet -- Pipeline Label Management
// =============================================================================
//
// Manages pipeline labels on fleet-core epics via the `bd` CLI.
// Used by the agent launcher (on exit transitions) and the fleet action API
// (on button clicks).
//
// Concurrency (factory-core-ppx.5):
// Every label-mutating operation wraps its body in `withLock(epicLock(id), …)`
// so two concurrent callers targeting the SAME epic are serialised, while
// callers on DIFFERENT epics proceed in parallel (per architecture ADR-002).
// Lock timeout: 30 s (functional spec NFR). On `LockTimeoutError`, we emit a
// single-line `console.warn` and rethrow -- the caller decides whether to
// retry (architecture risk #1; see `removeLabelsFromEpicStrict` vs
// `removeLabelsFromEpic` for the existing pattern).
//
// No nested locking: these functions must not, while holding `epicLock(id)`,
// call any other operation that acquires `epicLock(id)` for the same id.
// Currently none do -- the accompanying concurrency test contains a nesting
// detector that would trip if this invariant is ever violated.
// =============================================================================

import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import { findRepoForIssue } from "./repo-config";
import { getBdPath } from "./bd-path";
import { withLock, epicLock, LockTimeoutError } from "./locks";

const execFile = promisify(execFileCb);
// Lazy-initialize BD to avoid stale references during Next.js hot reload.
// Module-level getBdPath() can return a stale cached value when HMR
// replaces modules. (factory-core-cur.1.21)
let _bd: string | null = null;
function BD(): string {
  if (!_bd) _bd = getBdPath();
  return _bd;
}

const BD_TIMEOUT = 15_000;

// ---------------------------------------------------------------------------
// Epic-label lock timeout (factory-core-ppx.5)
// ---------------------------------------------------------------------------
// Default: 30 s per the functional spec NFR. Stored as a module-level `let`
// so tests can artificially lower it via `__setEpicLabelLockTimeoutMsForTests`
// -- the same test-only override convention used by `__lockManagerResetForTests`
// in `locks/lock-manager.ts`. Production code never mutates this.
// ---------------------------------------------------------------------------
const DEFAULT_EPIC_LABEL_LOCK_TIMEOUT_MS = 30_000;
let epicLabelLockTimeoutMs = DEFAULT_EPIC_LABEL_LOCK_TIMEOUT_MS;

/** @internal Exposed for unit tests only. Overrides the epic-label lock timeout. */
export function __setEpicLabelLockTimeoutMsForTests(ms: number): void {
  epicLabelLockTimeoutMs = ms;
}

/** @internal Exposed for unit tests only. Restores the default 30 s timeout. */
export function __resetEpicLabelLockTimeoutMsForTests(): void {
  epicLabelLockTimeoutMs = DEFAULT_EPIC_LABEL_LOCK_TIMEOUT_MS;
}

/**
 * Validate an issueId before we do anything with it -- including before we
 * acquire any lock. A nil/empty/non-string id is a programmer error and
 * must surface a descriptive message (never an orphaned lock entry in the
 * LockManager's Map). Factory-core-ppx.5 boundary AC.
 */
function assertValidIssueId(
  fnName: string,
  issueId: unknown,
): asserts issueId is string {
  if (typeof issueId !== "string" || issueId.length === 0) {
    throw new TypeError(
      `${fnName}: issueId must be a non-empty string (got ${
        issueId === null ? "null" : typeof issueId
      })`,
    );
  }
}

/**
 * Wrap a label-mutating body in `withLock(epicLock(issueId), …)`.
 *
 * On `LockTimeoutError`: log one structured warn line and rethrow. Never
 * silently swallow (regression-patterns.md #13). Other errors from `body`
 * propagate unchanged.
 */
async function withEpicLabelLock<T>(
  fnName: string,
  issueId: string,
  body: () => Promise<T>,
): Promise<T> {
  try {
    return await withLock(epicLock(issueId), epicLabelLockTimeoutMs, body);
  } catch (err) {
    if (err instanceof LockTimeoutError) {
      console.warn(
        `[pipeline-labels] ${fnName} timed out waiting for ${err.key} after ${err.timeoutMs}ms`,
      );
    }
    throw err;
  }
}

/**
 * Resolve the repo path for a given issue. If epicRepoPath is provided,
 * use it directly. Otherwise, search all configured repos.
 */
async function resolveRepoPath(issueId: string, epicRepoPath?: string): Promise<string> {
  if (epicRepoPath) return epicRepoPath;

  const resolved = await findRepoForIssue(issueId);
  if (!resolved) {
    throw new Error(`Issue ${issueId} not found in any configured repo`);
  }
  return resolved;
}

/**
 * Read the current labels from an epic via `bd show <issueId>`.
 * Returns the array of labels found, or an empty array on failure.
 * Used to get fresh labels instead of relying on stale request body data
 * (factory-core-hnv.19).
 */
export async function getEpicLabels(
  issueId: string,
  epicRepoPath?: string,
): Promise<string[]> {
  const repoPath = await resolveRepoPath(issueId, epicRepoPath);
  try {
    const { stdout } = await execFile(BD(), ["show", issueId], {
      cwd: repoPath,
      timeout: BD_TIMEOUT,
      env: { ...process.env, NO_COLOR: "1" },
    });
    // Parse labels from the "LABELS:" line in bd show output
    const labelsMatch = stdout.match(/LABELS:\s*(.+)/);
    if (labelsMatch) {
      return labelsMatch[1].split(",").map((l: string) => l.trim()).filter(Boolean);
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Add labels to an epic via `bd label add <issueId> <label1> <label2> ...`.
 *
 * Serialised per-epic via `epicLock(issueId)` (factory-core-ppx.5). Two
 * callers on the same epic queue FIFO; callers on different epics do not
 * contend.
 */
export async function addLabelsToEpic(
  issueId: string,
  labels: string[],
  epicRepoPath?: string,
): Promise<void> {
  assertValidIssueId("addLabelsToEpic", issueId);

  return withEpicLabelLock("addLabelsToEpic", issueId, async () => {
    if (labels.length === 0) return;

    const repoPath = await resolveRepoPath(issueId, epicRepoPath);

    for (const label of labels) {
      try {
        await execFile(BD(), ["label", "add", issueId, label], {
          cwd: repoPath,
          timeout: BD_TIMEOUT,
          env: { ...process.env, NO_COLOR: "1" },
        });
      } catch (err) {
        // If the label already exists, bd may error -- that's OK
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("already")) {
          console.error(`Failed to add label "${label}" to ${issueId}:`, msg);
        }
      }
    }
  });
}

/**
 * Remove labels from an epic via `bd label remove <issueId> <label>`.
 *
 * Lenient variant used by pipeline transitions: swallows non-idempotency
 * errors (connection failures, timeouts, unknown bd errors) and logs them
 * so a transient bd hiccup doesn't break a long pipeline chain. Callers
 * that must surface errors to the user should use
 * {@link removeLabelsFromEpicStrict} instead. (factory-core-509.9)
 *
 * Serialised per-epic via `epicLock(issueId)` (factory-core-ppx.5).
 */
export async function removeLabelsFromEpic(
  issueId: string,
  labels: string[],
  epicRepoPath?: string,
): Promise<void> {
  assertValidIssueId("removeLabelsFromEpic", issueId);

  return withEpicLabelLock("removeLabelsFromEpic", issueId, async () => {
    if (labels.length === 0) return;

    const repoPath = await resolveRepoPath(issueId, epicRepoPath);

    for (const label of labels) {
      try {
        await execFile(BD(), ["label", "remove", issueId, label], {
          cwd: repoPath,
          timeout: BD_TIMEOUT,
          env: { ...process.env, NO_COLOR: "1" },
        });
      } catch (err) {
        // If the label doesn't exist, bd may error -- that's OK
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("not found") && !msg.includes("does not have")) {
          console.error(`Failed to remove label "${label}" from ${issueId}:`, msg);
        }
      }
    }
  });
}

/**
 * Remove labels from an epic, propagating bd CLI errors.
 *
 * Strict variant for user-initiated actions (human-approve, human-dismiss)
 * where a silent failure would be a lie: the UI toast would report success
 * while the indicator stays on the board. Benign idempotency errors
 * ("not found", "does not have") are still swallowed -- the post-condition
 * "label is absent" is satisfied whether we removed it or it was never there.
 *
 * Any other bd CLI failure (connection refused, timeout, permission denied)
 * is re-thrown so the HTTP handler returns 500 and the client shows an
 * error toast.
 *
 * Serialised per-epic via `epicLock(issueId)` (factory-core-ppx.5) so the
 * validation read AND the remove happen within the same lock -- no TOCTOU
 * window (regression-patterns.md Read/Write Disconnect).
 *
 * Regression reference: regression-patterns.md #13 Silent Exception Swallowing.
 * Spec AC: docs/research/surface-hook-enforcement-and-human-functional-spec.md
 * line 90. (factory-core-509.9)
 */
export async function removeLabelsFromEpicStrict(
  issueId: string,
  labels: string[],
  epicRepoPath?: string,
): Promise<void> {
  assertValidIssueId("removeLabelsFromEpicStrict", issueId);

  return withEpicLabelLock("removeLabelsFromEpicStrict", issueId, async () => {
    if (labels.length === 0) return;

    const repoPath = await resolveRepoPath(issueId, epicRepoPath);

    for (const label of labels) {
      try {
        await execFile(BD(), ["label", "remove", issueId, label], {
          cwd: repoPath,
          timeout: BD_TIMEOUT,
          env: { ...process.env, NO_COLOR: "1" },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Idempotency: removing a label that was never there is a no-op success.
        if (msg.includes("not found") || msg.includes("does not have")) continue;
        // Everything else is a real failure the caller must handle.
        throw new Error(
          `Failed to remove label "${label}" from ${issueId}: ${msg}`,
        );
      }
    }
  });
}

/**
 * Remove all pipeline:* labels from an epic. Reads the current labels
 * from the issue and removes any that start with "pipeline:".
 */
export async function removeAllPipelineLabels(
  issueId: string,
  currentLabels: string[],
  epicRepoPath?: string,
): Promise<void> {
  const pipelineLabels = currentLabels.filter((l) => l.startsWith("pipeline:"));
  await removeLabelsFromEpic(issueId, pipelineLabels, epicRepoPath);
}

/**
 * Close an epic via `bd close <issueId> --reason="<reason>"`.
 */
export async function closeEpic(
  issueId: string,
  reason: string,
  epicRepoPath?: string,
): Promise<void> {
  const repoPath = await resolveRepoPath(issueId, epicRepoPath);

  await execFile(BD(), ["close", issueId, "--reason", reason], {
    cwd: repoPath,
    timeout: BD_TIMEOUT,
    env: { ...process.env, NO_COLOR: "1" },
  });
}

/**
 * Update epic status via `bd update <issueId> --status=<status>`.
 */
export async function updateEpicStatus(
  issueId: string,
  status: string,
  epicRepoPath?: string,
): Promise<void> {
  const repoPath = await resolveRepoPath(issueId, epicRepoPath);

  await execFile(BD(), ["update", issueId, `--status=${status}`], {
    cwd: repoPath,
    timeout: BD_TIMEOUT,
    env: { ...process.env, NO_COLOR: "1" },
  });
}

/**
 * Dismiss a child bead's "human" flag via `bd human dismiss <beadId>`.
 *
 * Used by the fleet board when Jane clicks "Dismiss" on a human-flagged
 * child bead indicator. Runs in the repo that owns the bead.
 * (factory-core-509.2)
 */
export async function dismissHumanItem(
  beadId: string,
  repoPath: string,
): Promise<void> {
  await execFile(BD(), ["human", "dismiss", beadId], {
    cwd: repoPath,
    timeout: BD_TIMEOUT,
    env: { ...process.env, NO_COLOR: "1" },
  });
}
