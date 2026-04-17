// =============================================================================
// Beads Fleet — Lock Manager (Promise-chain mutex)
// =============================================================================
//
// Per-resource advisory lock for serialising in-process operations that race
// on shared state (epic labels, auto-chain transitions, scoped caches).
//
// Implementation (ADR-001):
// - Module-level `Map<string, Promise<void>>` keyed by `LockKey.toString()`.
// - Each `withLock(key, timeoutMs, fn)` creates a fresh Promise and chains
//   it onto the existing tail Promise for the key. Callers await the
//   predecessor, then run `fn`, then resolve their Promise to release the
//   next waiter.
// - `finally` block guarantees release on both success and throw paths
//   (Guardrail 13: silent-exception-swallowing prevention).
// - `LockTimeoutError` is thrown when the wait for the predecessor exceeds
//   `timeoutMs`. Timeout releases the waiter's Promise too so downstream
//   callers aren't stuck.
// - Map cleanup fires when a chain resolves AND its entry is still the tail
//   (no one chained after) — keeps the Map bounded under sustained use.
//
// HMR caveat (dev-only):
// Next.js hot-module replacement replaces this module mid-process, which
// would lose lock state. Production builds do not use HMR. The
// `activeAgents` map in agent-launcher.ts has the same constraint — we
// accept this rather than persisting locks to disk (which would survive
// crashes and leak). See beads_web-Specific Notes in the architecture doc.
//
// Public surface:
//   withLock<T>(key, timeoutMs, fn): Promise<T>
//   epicLock(id), chainLock(id), repoLock(path) — factories returning LockKey
//   LockKey, LockTimeoutError — value types from `./types`
//
// Internal Map, `acquire`/`release` primitives, and LockHandle are NOT
// exported. Callers must use `withLock` (the `finally` block around `fn`
// is the release guarantee).
// =============================================================================

import { LockKey, LockTimeoutError } from "./types";

// ---------------------------------------------------------------------------
// Internal state — module-level tail-Promise Map.
//
// HMR note: declared at module top-level; Next.js dev-mode HMR may replace
// this module (and thus this Map) mid-operation, silently dropping locks.
// Mitigation: production build is not HMR'd. See `bd-path.ts` for the same
// lazy-init pattern used by `BD()`.
// ---------------------------------------------------------------------------
const tails = new Map<string, Promise<void>>();

/**
 * One-second wait threshold above which a `console.warn` is emitted on
 * lock acquisition. Early signal of contention — the functional spec
 * explicitly defers lock-contention metrics to v2.0, so a warn log here
 * is the lightweight v1.0 substitute.
 */
const ACQUISITION_WARN_THRESHOLD_MS = 1000;

/**
 * Acquires `key`, runs `fn`, releases `key` (always — in the `finally`).
 *
 * Promise-chain mutex:
 *   1. Look up the current tail Promise for `key` (or resolved-Promise).
 *   2. Create our own "myTurn" Promise (resolved when we release).
 *   3. Chain `myChain = prev.then(() => myTurn)` — this is the new tail.
 *   4. Await `prev` (with `timeoutMs`). When it resolves, our turn starts.
 *   5. Run `fn`. In `finally`, resolve `myTurn` so the next waiter can run.
 *   6. If our chain is still the tail after release, remove the Map entry.
 *
 * Throws `LockTimeoutError` if the await on `prev` exceeds `timeoutMs`.
 * Even on timeout, `myTurn` is resolved so waiters queued behind us still
 * make progress when the original predecessor completes.
 *
 * Never silently swallows errors from `fn` — the original error propagates
 * to the caller (prevention for regression pattern #13).
 */
export async function withLock<T>(
  key: LockKey,
  timeoutMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  // Runtime guard — TypeScript prevents the wrong arg at compile time but
  // JavaScript callers (or edge-case dynamic invocation) need an explicit
  // reject before we mutate any internal state.
  if (!(key instanceof LockKey)) {
    throw new TypeError(
      "withLock: expected a LockKey instance as the first argument",
    );
  }
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new TypeError(
      "withLock: timeoutMs must be a non-negative finite number",
    );
  }
  if (typeof fn !== "function") {
    throw new TypeError("withLock: fn must be a function");
  }

  const keyStr = key.toString();

  // Our own "release" gate — resolving this lets the next waiter's chain
  // proceed. Captured synchronously so every chained callback sees the
  // same resolver.
  let release!: () => void;
  const myTurn = new Promise<void>((resolve) => {
    release = resolve;
  });

  const prev = tails.get(keyStr) ?? Promise.resolve();
  const myChain = prev.then(() => myTurn);
  tails.set(keyStr, myChain);

  // Attach Map-cleanup to fire when our chain fully resolves. Using a
  // separate `.then` (not the main `myChain`) avoids changing the tail
  // identity that future callers chain onto. The cleanup is a no-op if
  // some other caller has already chained after us (tail !== myChain).
  myChain
    .then(() => {
      if (tails.get(keyStr) === myChain) {
        tails.delete(keyStr);
      }
    })
    // Defensive: the chain shouldn't reject (predecessors don't propagate
    // errors to the chain because we await `prev` separately below), but
    // attach a no-op catch so the promise doesn't become an unhandled
    // rejection if the JS engine ever reports one.
    .catch(() => {});

  const startWait = Date.now();
  // Wait for the predecessor to complete, with a timeout. On timeout we
  // still release `myTurn` (so callers queued after us aren't stranded).
  let timer: NodeJS.Timeout | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(
        () => reject(new LockTimeoutError(keyStr, timeoutMs)),
        timeoutMs,
      );
      prev.then(
        () => resolve(),
        // Predecessor errors are not ours to propagate — they were handled
        // in the predecessor's own withLock call. Treat predecessor
        // completion (resolve or reject) as "our turn".
        () => resolve(),
      );
    });
  } catch (err) {
    // Timeout path — release myTurn so queued callers can still make progress
    // once the original predecessor completes.
    release();
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }

  const waited = Date.now() - startWait;
  if (waited > ACQUISITION_WARN_THRESHOLD_MS) {
    console.warn(
      `[LockManager] Lock "${keyStr}" took ${waited}ms to acquire ` +
        "(exceeds 1s warn threshold)",
    );
  }

  try {
    return await fn();
  } finally {
    release();
  }
}

// ---------------------------------------------------------------------------
// Test-only introspection
// ---------------------------------------------------------------------------
// Exposed so unit tests can assert Map cleanup invariants ("Map is empty
// after release", "no leaked entries"). Not part of the public surface
// imported by production callers — hence prefixed with `__` per the same
// test-only convention used by other beads_web modules.
// ---------------------------------------------------------------------------

/** @internal Exposed for unit tests only. */
export function __lockManagerSize(): number {
  return tails.size;
}

/** @internal Exposed for unit tests only. Clears all lock state. */
export function __lockManagerResetForTests(): void {
  tails.clear();
}
