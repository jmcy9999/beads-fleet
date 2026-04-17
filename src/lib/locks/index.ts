// =============================================================================
// Beads Fleet — Locks module (public surface)
// =============================================================================
//
// Re-exports only the public API of the advisory lock subsystem. Internal
// implementation (the tail-Promise Map, `acquire`/`release` primitives,
// test-only helpers) is NOT re-exported — callers must use `withLock` with
// a `LockKey` produced by a factory helper.
//
// Consumers (per architecture ADR-002):
//   - `pipeline-labels.ts` → withLock(epicLock(id), 30000, fn)  (ppx.5)
//   - `agent-launcher.ts` → withLock(chainLock(id), 500, fn)    (ppx.6)
// =============================================================================

export { withLock } from "./lock-manager";
export { epicLock, chainLock, repoLock, LockKey, LockTimeoutError } from "./types";
