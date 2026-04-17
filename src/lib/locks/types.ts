// =============================================================================
// Beads Fleet — Lock Types
// =============================================================================
//
// Value types for the per-resource advisory lock manager (factory-core-ppx).
//
// Design:
// - `LockKey` is a validated namespace+id pair. The `toString()` produces
//   `${namespace}:${id}` which is used as the Map key in `LockManager`.
//   Validation rejects unsanitised input that could cause unintended
//   lock-key collisions (e.g. a bead ID containing whitespace or a repo
//   path with shell metacharacters).
// - `LockHandle` is an opaque token only used internally by `withLock`.
//   Callers never construct or release handles directly — release is
//   guaranteed by a `finally` block around the caller's function.
// - `LockTimeoutError` is thrown by `withLock` when the queue wait for a
//   key exceeds the configured `timeoutMs`. Carries `key` and `timeoutMs`
//   so callers can log structured context.
//
// Per architecture ADR-001/ADR-002 (docs/research/beads-web-concurrency-
// safety-architecture.md) this module is the Domain-layer value-type slice
// of the lock subsystem. No I/O, no async work — just types and validation.
// =============================================================================

/**
 * Regex for a well-formed bd-issue-ID (bead ID).
 *
 * Accepts the canonical bd-ID shape used across fleet:
 *   - lowercase/uppercase alphanumerics, hyphens, and one-or-more dotted
 *     numeric suffixes ("factory-core-ppx", "factory-core-ppx.1",
 *     "factory-core-ppx.10").
 *
 * Rejects anything with whitespace or shell metacharacters, which is the
 * key security invariant for lock keys — see architecture doc "Security
 * Architecture" §3 (Input validation).
 */
const BD_ID_REGEX = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+(?:\.[A-Za-z0-9]+)*$/;

/**
 * Regex for a repo-path lock id.
 *
 * Accepts the path characters we realistically see on the developer machine
 * (POSIX paths with ASCII alphanumerics, hyphens, dots, underscores, slashes,
 * tildes). Rejects whitespace, shell redirection characters, and other
 * input that could cause unintended key collisions.
 */
const REPO_PATH_REGEX = /^[A-Za-z0-9/._~\-]+$/;

/**
 * Regex for the namespace component. Short lowercase alpha tokens only —
 * the three known namespaces today are `epic`, `chain`, and `repo`. Future
 * additions follow the same pattern.
 */
const NAMESPACE_REGEX = /^[a-z]+$/;

/**
 * A validated lock-key namespace+id pair.
 *
 * Construct via the `epicLock(id)`, `chainLock(id)`, or `repoLock(path)`
 * factory helpers — direct construction is also supported but the factories
 * are the idiomatic path from the caller.
 *
 * `toString()` produces `${namespace}:${id}` which is the stable form used
 * by `LockManager` as the internal Map key. Two `LockKey` instances with
 * the same namespace+id compare equal via their `toString()` result.
 */
export class LockKey {
  readonly namespace: string;
  readonly id: string;

  constructor(namespace: string, id: string) {
    if (typeof namespace !== "string" || namespace.length === 0) {
      throw new TypeError(
        "LockKey namespace must be a non-empty string",
      );
    }
    if (!NAMESPACE_REGEX.test(namespace)) {
      throw new TypeError(
        `LockKey namespace must match ${NAMESPACE_REGEX} (got "${namespace}")`,
      );
    }
    if (typeof id !== "string" || id.length === 0) {
      throw new TypeError("LockKey id must be a non-empty string");
    }
    if (!BD_ID_REGEX.test(id) && !REPO_PATH_REGEX.test(id)) {
      throw new TypeError(
        `LockKey id "${id}" does not match the bd-issue-ID regex ` +
          `(${BD_ID_REGEX}) or repo-path regex (${REPO_PATH_REGEX}). ` +
          "Unsanitised input is rejected to prevent unintended key " +
          "collisions.",
      );
    }
    this.namespace = namespace;
    this.id = id;
  }

  toString(): string {
    return `${this.namespace}:${this.id}`;
  }
}

/**
 * Opaque token returned by internal lock acquisition. Callers never see a
 * `LockHandle` — the public surface is `withLock(key, timeoutMs, fn)` which
 * guarantees release via a `finally` block. This type exists so future
 * distributed-lock implementations (v2.0 per ADR-001) can carry additional
 * state (lease token, Redis key expiry) through the same internal API.
 */
export interface LockHandle {
  readonly release: () => void;
}

/**
 * Thrown by `withLock` when the queue wait for a key exceeds `timeoutMs`.
 *
 * The `key` field is the stringified lock key (e.g. `"epic:factory-core-ppx"`)
 * so callers can log structured context without needing access to the
 * `LockKey` instance.
 */
export class LockTimeoutError extends Error {
  readonly key: string;
  readonly timeoutMs: number;

  constructor(key: string, timeoutMs: number) {
    super(`Lock "${key}" timed out after ${timeoutMs}ms`);
    this.name = "LockTimeoutError";
    this.key = key;
    this.timeoutMs = timeoutMs;
    // Restore prototype chain for instanceof checks across transpilation
    Object.setPrototypeOf(this, LockTimeoutError.prototype);
  }
}

/**
 * Factory: lock scoped to label-mutating operations on an epic.
 * Keys produced: `epic:<epicId>`.
 *
 * Used by `pipeline-labels.ts` (ppx.5) to serialise `addLabelsToEpic`,
 * `removeLabelsFromEpic`, and `removeLabelsFromEpicStrict` on the same
 * epic. Different epics do not contend on this lock.
 */
export function epicLock(epicId: string): LockKey {
  return new LockKey("epic", epicId);
}

/**
 * Factory: lock scoped to the atomic read-state-then-transition block in
 * `handleChainAction`. Keys produced: `chain:<epicId>`.
 *
 * ADR-002: deliberately distinct from `epicLock` so `handleChainAction`
 * can call `addLabelsToEpic` (which acquires `epicLock`) without deadlock.
 */
export function chainLock(epicId: string): LockKey {
  return new LockKey("chain", epicId);
}

/**
 * Factory: lock scoped to a repo path. Keys produced: `repo:<path>`.
 *
 * Not used by v1.0 call sites but exposed for future per-repo serialisation
 * (e.g. git stash/pop sequences) so callers don't need to instantiate
 * `LockKey` directly.
 */
export function repoLock(repoPath: string): LockKey {
  return new LockKey("repo", repoPath);
}
