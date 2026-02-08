// =============================================================================
// Beads Web — Simple TTL Cache
// =============================================================================
//
// In-memory cache with time-to-live expiration. Used by bv-client to avoid
// redundant subprocess calls for data that changes infrequently.
// =============================================================================

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

export class TTLCache {
  private store = new Map<string, CacheEntry<unknown>>();
  private defaultTTL: number;

  constructor(defaultTTLMs: number = 10_000) {
    this.defaultTTL = defaultTTLMs;
  }

  get<T>(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > this.defaultTTL) {
      this.store.delete(key);
      return null;
    }
    return entry.data as T;
  }

  set<T>(key: string, data: T): void {
    this.store.set(key, { data, timestamp: Date.now() });
  }

  invalidate(key: string): void {
    this.store.delete(key);
  }

  invalidateAll(): void {
    this.store.clear();
  }
}

export const cache = new TTLCache(10_000);
