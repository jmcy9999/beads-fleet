// =============================================================================
// Beads Fleet — Simple TTL Cache (scoped variant)
// =============================================================================
//
// In-memory cache with time-to-live expiration. Used by bv-client to avoid
// redundant subprocess calls for data that changes infrequently.
//
// factory-core-ppx.3 extensions (per ADR-004):
// - Each entry carries a `CacheScope` tag: `{type:"epic",epicId}`,
//   `{type:"repo",repoPath}`, or `{type:"global"}`. Legacy `set(key, data)`
//   calls default to `{type:"global"}` so every existing caller continues
//   to work without change.
// - `invalidateScope(scope)` removes entries whose scope matches (exact
//   equality, not transitive — `{type:"global"}` only clears global
//   entries; it does NOT dump per-epic or per-repo state).
// - `getOrCompute<T>(key, scope, compute)` provides single-flight rebuild:
//   when a compute is in progress for `key`, concurrent callers await the
//   same Promise rather than each running their own compute. On rejection
//   the in-flight entry is cleared so the next caller retries
//   (regression pattern #13: no silent swallowing / no stuck pending).
//
// HMR caveat (dev-only):
// The `inFlight` Map is module-scoped. Next.js HMR may replace this module
// mid-compute, losing the in-flight coalescence. Production builds do not
// use HMR. The existing TTL store has the same characteristic.
// =============================================================================

// ---------------------------------------------------------------------------
// CacheScope — discriminated union for scoped invalidation
// ---------------------------------------------------------------------------

/**
 * Tag that identifies which owning scope a cache entry belongs to.
 *
 * - `epic`: entry is specific to one epic (e.g. "getEpicLabels:foo-abc").
 *   Scope-match via `epicId` equality.
 * - `repo`: entry is specific to one repo path (e.g. "listIssues:/Users/...").
 *   Scope-match via `repoPath` equality.
 * - `global`: entry is not owned by any specific epic/repo (e.g. fleet
 *   overview aggregates). Scope-match via `type === "global"` only —
 *   global invalidation does NOT cascade to epic/repo entries.
 */
export type CacheScope =
  | { readonly type: "epic"; readonly epicId: string }
  | { readonly type: "repo"; readonly repoPath: string }
  | { readonly type: "global" };

/**
 * Exact-equality match on two scopes. Used by `invalidateScope` to select
 * entries for eviction. Per ADR-004: match is exact, not transitive —
 * global never matches epic/repo; epic A never matches epic B; repo X
 * never matches repo Y.
 */
export function cacheScopesEqual(a: CacheScope, b: CacheScope): boolean {
  if (a.type !== b.type) return false;
  switch (a.type) {
    case "epic":
      return b.type === "epic" && a.epicId === (b as typeof a).epicId;
    case "repo":
      return b.type === "repo" && a.repoPath === (b as typeof a).repoPath;
    case "global":
      return b.type === "global";
    default: {
      // Exhaustiveness guard — adding a new variant will surface here
      // as a TypeScript error (regression pattern #7 — Type Confusion
      // on Enum Branching).
      const _exhaustive: never = a;
      return _exhaustive;
    }
  }
}

// ---------------------------------------------------------------------------
// Internal entry shape
// ---------------------------------------------------------------------------

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  scope: CacheScope;
}

const DEFAULT_GLOBAL_SCOPE: CacheScope = { type: "global" };

export class TTLCache {
  private store = new Map<string, CacheEntry<unknown>>();
  private inFlight = new Map<string, Promise<unknown>>();
  private defaultTTL: number;

  constructor(defaultTTLMs: number = 10_000) {
    this.defaultTTL = defaultTTLMs;
  }

  /**
   * Returns the cached value for `key` or `null` on miss / TTL expiry.
   *
   * Note: a cached `null` or `undefined` value cannot be distinguished from
   * "key absent" by `get` alone — this matches the pre-ppx.3 behaviour and
   * is relied on by legacy callers. `getOrCompute` does NOT have this
   * ambiguity internally (it checks the underlying Map directly).
   */
  get<T>(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > this.defaultTTL) {
      this.store.delete(key);
      return null;
    }
    return entry.data as T;
  }

  /**
   * Stores `data` under `key` with a scope tag.
   *
   * Backward compatibility: the 2-argument signature `set(key, data)` is
   * preserved — it tags the entry with `{type:"global"}`. Existing callers
   * that haven't been migrated to scoped caching continue to behave as
   * before.
   */
  set<T>(key: string, data: T, scope: CacheScope = DEFAULT_GLOBAL_SCOPE): void {
    this.store.set(key, { data, timestamp: Date.now(), scope });
  }

  /**
   * Removes the entry for `key` regardless of scope. Used by legacy
   * point-invalidation callers that know the exact key.
   */
  invalidate(key: string): void {
    this.store.delete(key);
  }

  /**
   * Removes every entry. Preserved as the catastrophic / fallback path;
   * ppx.8 sweeps route-handler call sites to use `invalidateScope` where
   * an owning epic/repo is known. `invalidateAll` remains only where no
   * scope can be attributed.
   *
   * Also clears any in-flight single-flight computations — on
   * catastrophic invalidation, pending reads should re-issue.
   */
  invalidateAll(): void {
    this.store.clear();
    this.inFlight.clear();
  }

  /**
   * Removes every entry whose scope exactly equals `scope`.
   *
   * Per ADR-004 / Feature 5 AC:
   * - `invalidateScope({type:"epic",epicId:"foo"})` clears entries tagged
   *   for epic `foo` ONLY — entries for other epics or for repos / global
   *   are untouched.
   * - `invalidateScope({type:"global"})` clears global entries ONLY —
   *   epic/repo-tagged entries survive.
   *
   * Complexity: O(N) over stored entries. Empirically <1ms at 1k entries.
   */
  invalidateScope(scope: CacheScope): void {
    // Snapshot the entries first — per architecture Layer Rule
    // "Snapshots over references", iterate a stable snapshot not the
    // live Map (defensive against any future mutation during iteration).
    for (const [key, entry] of Array.from(this.store.entries())) {
      if (cacheScopesEqual(entry.scope, scope)) {
        this.store.delete(key);
      }
    }
  }

  /**
   * Single-flight cache-or-compute.
   *
   * Semantics:
   * 1. If a live (non-expired) entry exists for `key`, return it without
   *    calling `compute`.
   * 2. If a compute is already in-flight for `key`, return the same
   *    Promise so the N concurrent callers share one compute invocation
   *    (Feature 5 AC: "only one rebuild runs per invalidation").
   * 3. Otherwise start a new compute, cache the result on success (with
   *    the supplied `scope`), and return the value.
   *
   * Error path (regression pattern #13): if `compute` rejects, the
   * in-flight entry is cleared so the next caller re-attempts. All
   * concurrent waiters receive the same rejection. Failed results are
   * NEVER cached.
   */
  async getOrCompute<T>(
    key: string,
    scope: CacheScope,
    compute: () => Promise<T>,
  ): Promise<T> {
    // Fast path: live cache entry.
    const existing = this.store.get(key);
    if (existing && Date.now() - existing.timestamp <= this.defaultTTL) {
      return existing.data as T;
    }
    // Expired entry — evict proactively so a future miss check is accurate.
    if (existing) this.store.delete(key);

    // Single-flight: coalesce concurrent callers onto one Promise.
    const pending = this.inFlight.get(key) as Promise<T> | undefined;
    if (pending) return pending;

    const promise = (async () => {
      try {
        const result = await compute();
        // Cache on success only.
        this.set(key, result, scope);
        return result;
      } finally {
        // Always clear the in-flight entry — on success the value is now
        // in the cache; on failure the next caller re-attempts.
        this.inFlight.delete(key);
      }
    })();

    this.inFlight.set(key, promise);
    return promise;
  }
}

export const cache = new TTLCache(10_000);
