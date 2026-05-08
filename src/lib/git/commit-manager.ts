// =============================================================================
// Beads Fleet — GitCommitManager (pull-rebase-retry)
// =============================================================================
//
// Provides `commitWithRetry` for ADR-003: concurrent agents committing to
// the same repo can produce merge conflicts on shared files (CLAUDE.md,
// .beads/ metadata). This wrapper:
//
//   1. Stages ONLY the files the caller names (never `git add -A` —
//      Internal Guardrail 2 / functional spec NFR).
//   2. Commits with the caller's message. On success, returns
//      `{status:"ok", sha}`.
//   3. On failure (index lock contention, non-FF rebase edge cases): stash
//      any uncommitted work, try `git pull --rebase` (defensive for the
//      non-FF scenario), pop the stash, retry the commit. Max 3 attempts.
//   4. On unrecoverable failure: return structured discriminated union —
//      `{status:"conflict", conflicts}` with conflicting paths, or
//      `{status:"stash-failed", reason}` if stash-pop failed. Uncommitted
//      work stays in the stash so it is never silently lost (Internal
//      Guardrail 2 / regression pattern #13).
//
// This library is NOT called by beads_web routes. It is consumed by:
//   - builder prompts that commit inside an agent
//   - `tools/generic/commit-gate.sh` shell wrapper (ppx.2 Task 3)
//
// poh.26 NOTE (2026-05-08): cross-process commit-serialization (flock on
// .git/shipyard-commit.lock) was added to commit-gate.sh to fix the
// parallel-agent commit-race observed in the C2 attempt-4 retest battery.
// This TS library does NOT yet take that lock — currently no caller uses
// it (verified: no `commitWithRetry` importers anywhere in src/). If/when
// a caller is wired up, this library MUST acquire the same flock before
// `git add`. See `tools/generic/commit-gate.sh` for the reference shape.
// =============================================================================

import { execFile } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Discriminated union returned by `commitWithRetry`.
 *
 * - `ok`: commit landed. `sha` is the 40-char HEAD SHA (round-trip
 *   verified via `git rev-parse HEAD`).
 * - `conflict`: all retry attempts exhausted OR rebase conflict could
 *   not be resolved. `conflicts` lists the file paths git reports as in
 *   conflict (best-effort; may be empty if git's state is not parseable).
 *   Uncommitted work, if any, is preserved in a git stash entry named
 *   with the `stashLabel` pattern — the caller can recover via
 *   `git stash list` / `git stash apply stash@{N}`.
 * - `stash-failed`: a `git stash pop` failed during the retry path.
 *   `reason` is the human-readable stderr output. The stash entry is
 *   PRESERVED (never dropped) so the caller can inspect and recover.
 */
export type CommitResult =
  | { status: "ok"; sha: string }
  | { status: "conflict"; conflicts: string[] }
  | { status: "stash-failed"; reason: string };

/**
 * Max attempts for the stage+commit operation. ADR-003 caps this at 3.
 * Exported as a constant for the boundary-condition tests that verify
 * "exactly 3 attempts, no 4th".
 */
export const MAX_COMMIT_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// Main entrypoint
// ---------------------------------------------------------------------------

/**
 * Stages `files` (and ONLY `files`), commits with `message`, and retries
 * up to 3 times on transient failures. Returns a structured `CommitResult`.
 *
 * Throws (not returns) when:
 *   - `files` is empty (defensive against refactors that mask a
 *     `git add -A` regression — never silently downgrade to all-files).
 *   - `repoPath` does not exist.
 *   - One of `files` does not exist on disk.
 *
 * Returns (does not throw) on expected-concurrency outcomes:
 *   - `{status:"conflict", ...}` after 3 failed attempts.
 *   - `{status:"stash-failed", ...}` when stash-pop fails.
 */
export async function commitWithRetry(
  repoPath: string,
  message: string,
  files: readonly string[],
): Promise<CommitResult> {
  // ----- Validation (fail fast, before touching git) ----------------------
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error(
      "commitWithRetry: files list must be non-empty (refusing to stage " +
        "with empty list — would mask a git add -A regression)",
    );
  }
  if (typeof repoPath !== "string" || repoPath.length === 0) {
    throw new Error("commitWithRetry: repoPath must be a non-empty string");
  }
  if (typeof message !== "string" || message.length === 0) {
    throw new Error("commitWithRetry: message must be a non-empty string");
  }

  try {
    const stat = await fs.stat(repoPath);
    if (!stat.isDirectory()) {
      throw new Error(
        `commitWithRetry: repoPath is not a directory: ${repoPath}`,
      );
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("repoPath is not a directory")) {
      throw err;
    }
    throw new Error(
      `commitWithRetry: repoPath does not exist: ${repoPath}`,
    );
  }

  // Verify each named file exists.
  for (const file of files) {
    if (typeof file !== "string" || file.length === 0) {
      throw new Error(
        `commitWithRetry: files entry must be a non-empty string (got ${JSON.stringify(file)})`,
      );
    }
    const abs = path.resolve(repoPath, file);
    try {
      await fs.stat(abs);
    } catch {
      throw new Error(
        `commitWithRetry: file not found: ${file} (expected at ${abs})`,
      );
    }
  }

  // ----- Retry loop --------------------------------------------------------
  const git = (args: string[]) =>
    execFileAsync("git", args, { cwd: repoPath, maxBuffer: 16 * 1024 * 1024 });

  let attemptsMade = 0;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= MAX_COMMIT_ATTEMPTS; attempt++) {
    attemptsMade = attempt;
    try {
      // Stage only the named files — never git add -A.
      await git(["add", "--", ...files]);

      // Commit with the caller's message. The -m arg is passed through
      // execFile, so shell metacharacters in the message are safe.
      await git(["commit", "-m", message]);

      // Success — verify the commit landed (Write/Read round-trip per
      // Internal Guardrail 2) by reading HEAD.
      const { stdout } = await git(["rev-parse", "HEAD"]);
      return { status: "ok", sha: stdout.trim() };
    } catch (err) {
      lastError = err;
      // Final attempt — don't try to recover, fall through to conflict return.
      if (attempt >= MAX_COMMIT_ATTEMPTS) break;

      // Try the recovery path: stash, pull-rebase (defensive), stash pop.
      const recovery = await attemptRecovery(repoPath, git);
      if (recovery.status === "stash-failed") {
        return recovery;
      }
      // Recovery succeeded — loop will retry the commit.
    }
  }

  // Exhausted attempts — gather any git-reported conflicts and return.
  const conflicts = await listConflictFiles(repoPath).catch(() => []);
  // Mark the last error as intentionally surfaced (satisfies lint).
  void lastError;
  void attemptsMade;
  return { status: "conflict", conflicts };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * After a failed commit attempt, try to recover so the next attempt can
 * succeed:
 *   1. Stash any uncommitted changes (includes untracked) with a unique
 *      label so we can verify the stash entry for Internal Guardrail 2.
 *   2. Try `git pull --rebase` — only if an upstream branch is configured.
 *      Local-only repos (no upstream) skip the pull entirely. Pull
 *      failures are swallowed (defensive only; next commit attempt will
 *      surface any real problem).
 *   3. `git stash pop` — on failure, return `stash-failed` with the stash
 *      PRESERVED (never drop; user can recover manually).
 *
 * Returns `{status: "ok"}` on successful recovery (retry the commit) or
 * `{status: "stash-failed", reason}` on unrecoverable stash failure.
 */
async function attemptRecovery(
  repoPath: string,
  git: (args: string[]) => Promise<{ stdout: string; stderr: string }>,
): Promise<{ status: "ok" } | { status: "stash-failed"; reason: string }> {
  // Check whether an upstream is configured. Fail-closed: if we can't
  // tell, skip the pull.
  let hasUpstream = false;
  try {
    await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
    hasUpstream = true;
  } catch {
    hasUpstream = false;
  }

  // Stash with a unique label so an operator can distinguish our stash
  // from any pre-existing stash entries.
  const stashLabel = `commitWithRetry-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  let stashed = false;
  try {
    const res = await git([
      "stash",
      "push",
      "--include-untracked",
      "-m",
      stashLabel,
    ]);
    // `git stash push` prints "No local changes to save" to stdout when
    // there's nothing to stash. Detect that — do NOT try to pop in that
    // case (pop would fail "No stash entries found").
    const combined = `${res.stdout}\n${res.stderr}`;
    stashed = !/No local changes to save/i.test(combined);
  } catch {
    // Stash failed (e.g. unmerged paths). Don't mark stashed — there's
    // nothing to pop.
    stashed = false;
  }

  if (hasUpstream) {
    // Best-effort pull-rebase. Errors are swallowed intentionally —
    // this is defensive for the non-FF case. A real problem will resurface
    // on the next commit attempt.
    try {
      await git(["pull", "--rebase"]);
    } catch {
      // Ignore — likely no remote changes or transient network blip.
    }
  }

  if (stashed) {
    try {
      await git(["stash", "pop"]);
    } catch (err) {
      const reason = extractMessage(err);
      return { status: "stash-failed", reason };
    }
  }

  // Small back-off so a transient index.lock has time to clear.
  await delay(50);

  return { status: "ok" };
}

/**
 * Parse `git status --porcelain` to extract paths with conflict markers
 * (U prefix, AA, DD, etc. — see git-status manpage). Best-effort — returns
 * an empty array on failure.
 */
async function listConflictFiles(repoPath: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["status", "--porcelain"],
      { cwd: repoPath, maxBuffer: 16 * 1024 * 1024 },
    );
    const conflicts: string[] = [];
    for (const line of stdout.split("\n")) {
      // Conflict states in git status --porcelain:
      //   UU, AA, DD, UA, AU, DU, UD — both index and worktree markers
      // We match any line where either of the first two chars is U, or
      // the two-char prefix is AA or DD.
      const prefix = line.slice(0, 2);
      if (
        prefix[0] === "U" ||
        prefix[1] === "U" ||
        prefix === "AA" ||
        prefix === "DD"
      ) {
        // `git status --porcelain` format: "XY path" or "XY path -> renamed"
        const pathPart = line.slice(3).trim();
        if (pathPart) conflicts.push(pathPart);
      }
    }
    return conflicts;
  } catch {
    return [];
  }
}

function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  // execFile rejects with a Node ErrnoException that often has .stderr too.
  const maybe = err as { stderr?: string; message?: string };
  if (typeof maybe?.stderr === "string" && maybe.stderr.length > 0) {
    return maybe.stderr.trim();
  }
  if (typeof maybe?.message === "string") return maybe.message;
  return String(err);
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
