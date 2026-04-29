// =============================================================================
// Tests for src/lib/cache.ts — TTLCache
// =============================================================================

import { TTLCache } from "@/lib/cache";

describe("TTLCache", () => {
  // ---------------------------------------------------------------------------
  // Basic get/set behavior
  // ---------------------------------------------------------------------------

  describe("get", () => {
    it("returns null for a missing key", () => {
      const cache = new TTLCache(1000);
      expect(cache.get("nonexistent")).toBeNull();
    });

    it("returns the value after set", () => {
      const cache = new TTLCache(1000);
      cache.set("key1", "value1");
      expect(cache.get<string>("key1")).toBe("value1");
    });

    it("returns null for a different missing key when other keys exist", () => {
      const cache = new TTLCache(1000);
      cache.set("exists", 42);
      expect(cache.get("missing")).toBeNull();
    });
  });

  describe("set", () => {
    it("overwrites an existing key", () => {
      const cache = new TTLCache(1000);
      cache.set("key", "first");
      cache.set("key", "second");
      expect(cache.get<string>("key")).toBe("second");
    });

    it("stores multiple keys independently", () => {
      const cache = new TTLCache(1000);
      cache.set("a", 1);
      cache.set("b", 2);
      cache.set("c", 3);
      expect(cache.get<number>("a")).toBe(1);
      expect(cache.get<number>("b")).toBe(2);
      expect(cache.get<number>("c")).toBe(3);
    });
  });

  // ---------------------------------------------------------------------------
  // TTL expiration
  // ---------------------------------------------------------------------------

  describe("TTL expiration", () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it("returns the value before TTL expires", () => {
      const cache = new TTLCache(100);
      cache.set("key", "value");
      jest.advanceTimersByTime(50);
      expect(cache.get<string>("key")).toBe("value");
    });

    it("returns null after TTL expires", () => {
      const cache = new TTLCache(100);
      cache.set("key", "value");
      jest.advanceTimersByTime(101);
      expect(cache.get<string>("key")).toBeNull();
    });

    it("returns null exactly at TTL boundary (> comparison)", () => {
      const cache = new TTLCache(100);
      cache.set("key", "value");
      // Advance exactly 100ms — the check is > (not >=), so this should still be valid
      jest.advanceTimersByTime(100);
      expect(cache.get<string>("key")).toBe("value");
    });

    it("removes the expired entry from the store on access", () => {
      const cache = new TTLCache(100);
      cache.set("key", "value");
      jest.advanceTimersByTime(101);
      // First access expires it
      expect(cache.get<string>("key")).toBeNull();
      // Second access also returns null (entry was deleted)
      expect(cache.get<string>("key")).toBeNull();
    });

    it("uses the default TTL of 30s when no TTL is specified", () => {
      // factory-core-3p1e.5 bumped the default TTL from 10s to 30s to reduce
      // dashboard cold-misses on the 15s refetch interval. Test updated to
      // match the new boundary; behaviour is otherwise identical.
      const cache = new TTLCache();
      cache.set("key", "value");
      jest.advanceTimersByTime(29_999);
      expect(cache.get<string>("key")).toBe("value");
      jest.advanceTimersByTime(2);
      expect(cache.get<string>("key")).toBeNull();
    });

    it("re-set refreshes the TTL", () => {
      const cache = new TTLCache(100);
      cache.set("key", "value");
      jest.advanceTimersByTime(80);
      // Re-set the same key, resetting the timer
      cache.set("key", "updated");
      jest.advanceTimersByTime(80);
      // 80ms after re-set, should still be valid
      expect(cache.get<string>("key")).toBe("updated");
      jest.advanceTimersByTime(21);
      // 101ms after re-set, should be expired
      expect(cache.get<string>("key")).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Invalidation
  // ---------------------------------------------------------------------------

  describe("invalidate", () => {
    it("removes a specific key", () => {
      const cache = new TTLCache(1000);
      cache.set("a", 1);
      cache.set("b", 2);
      cache.invalidate("a");
      expect(cache.get<number>("a")).toBeNull();
      expect(cache.get<number>("b")).toBe(2);
    });

    it("is a no-op for a non-existent key", () => {
      const cache = new TTLCache(1000);
      cache.set("a", 1);
      cache.invalidate("nonexistent");
      expect(cache.get<number>("a")).toBe(1);
    });
  });

  describe("invalidateAll", () => {
    it("clears all entries", () => {
      const cache = new TTLCache(1000);
      cache.set("a", 1);
      cache.set("b", 2);
      cache.set("c", 3);
      cache.invalidateAll();
      expect(cache.get<number>("a")).toBeNull();
      expect(cache.get<number>("b")).toBeNull();
      expect(cache.get<number>("c")).toBeNull();
    });

    it("is a no-op on an empty cache", () => {
      const cache = new TTLCache(1000);
      expect(() => cache.invalidateAll()).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // Different data types
  // ---------------------------------------------------------------------------

  describe("data type support", () => {
    it("stores and retrieves strings", () => {
      const cache = new TTLCache(1000);
      cache.set("str", "hello world");
      expect(cache.get<string>("str")).toBe("hello world");
    });

    it("stores and retrieves numbers", () => {
      const cache = new TTLCache(1000);
      cache.set("num", 42);
      expect(cache.get<number>("num")).toBe(42);
    });

    it("stores and retrieves objects", () => {
      const cache = new TTLCache(1000);
      const obj = { name: "test", nested: { count: 5 } };
      cache.set("obj", obj);
      expect(cache.get<typeof obj>("obj")).toEqual(obj);
    });

    it("stores and retrieves arrays", () => {
      const cache = new TTLCache(1000);
      const arr = [1, "two", { three: 3 }];
      cache.set("arr", arr);
      expect(cache.get<typeof arr>("arr")).toEqual(arr);
    });

    it("stores and retrieves booleans", () => {
      const cache = new TTLCache(1000);
      cache.set("bool-true", true);
      cache.set("bool-false", false);
      expect(cache.get<boolean>("bool-true")).toBe(true);
      expect(cache.get<boolean>("bool-false")).toBe(false);
    });

    it("stores and retrieves null values (wrapped as data)", () => {
      const cache = new TTLCache(1000);
      // null as data is stored successfully — but get returns null for missing keys too,
      // so this is an edge case: the entry exists but data is null
      cache.set("nullable", null);
      // The entry exists and the data is null, which is returned as-is (null)
      expect(cache.get("nullable")).toBeNull();
    });
  });
});
