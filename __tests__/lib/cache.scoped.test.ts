// =============================================================================
// Tests for src/lib/cache.ts — scoped TTLCache (factory-core-ppx.3)
// =============================================================================
// Covers the acceptance criteria for ppx.3:
// - CacheScope exact-equality matching (no transitive / prefix match)
// - set(key, data, scope) tags entries; 2-arg legacy set defaults to global
// - invalidateScope(scope) clears matching entries ONLY
// - getOrCompute collapses N concurrent callers into one compute
// - getOrCompute propagates compute rejection to ALL waiters AND clears
//   the in-flight entry so the next caller re-attempts
// - TTL still applies to scoped entries (scope is orthogonal to TTL)
// - 1,000-entry invalidateScope completes under the bead's 10ms budget
// - Backward compatibility: existing 2-arg callers and invalidateAll behave
//   unchanged
// =============================================================================

import {
  TTLCache,
  cacheScopesEqual,
  type CacheScope,
} from "@/lib/cache";

async function delay(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe("cacheScopesEqual (exact-equality discriminated union)", () => {
  it("global === global", () => {
    expect(
      cacheScopesEqual({ type: "global" }, { type: "global" }),
    ).toBe(true);
  });

  it("global !== epic / repo (no transitive match)", () => {
    expect(
      cacheScopesEqual({ type: "global" }, { type: "epic", epicId: "A" }),
    ).toBe(false);
    expect(
      cacheScopesEqual({ type: "global" }, { type: "repo", repoPath: "/p" }),
    ).toBe(false);
  });

  it("epic equality is on epicId", () => {
    expect(
      cacheScopesEqual(
        { type: "epic", epicId: "A" },
        { type: "epic", epicId: "A" },
      ),
    ).toBe(true);
    expect(
      cacheScopesEqual(
        { type: "epic", epicId: "A" },
        { type: "epic", epicId: "B" },
      ),
    ).toBe(false);
  });

  it("epic equality is exact — prefix does NOT match", () => {
    expect(
      cacheScopesEqual(
        { type: "epic", epicId: "foo" },
        { type: "epic", epicId: "foo-x" },
      ),
    ).toBe(false);
  });

  it("repo equality is on repoPath", () => {
    expect(
      cacheScopesEqual(
        { type: "repo", repoPath: "/a" },
        { type: "repo", repoPath: "/a" },
      ),
    ).toBe(true);
    expect(
      cacheScopesEqual(
        { type: "repo", repoPath: "/a" },
        { type: "repo", repoPath: "/b" },
      ),
    ).toBe(false);
  });
});

describe("TTLCache — scoped set/invalidateScope (factory-core-ppx.3)", () => {
  const epicA: CacheScope = { type: "epic", epicId: "A" };
  const epicB: CacheScope = { type: "epic", epicId: "B" };
  const repoX: CacheScope = { type: "repo", repoPath: "/x" };
  const repoY: CacheScope = { type: "repo", repoPath: "/y" };
  const global: CacheScope = { type: "global" };

  describe("set with scope + get round-trip", () => {
    it("set(key, v, epic scope) + get(key) returns v before TTL", () => {
      const c = new TTLCache(1000);
      c.set("k", "v", epicA);
      expect(c.get<string>("k")).toBe("v");
    });

    it("set(key, v, repo scope) + get(key) returns v", () => {
      const c = new TTLCache(1000);
      c.set("k", "v", repoX);
      expect(c.get<string>("k")).toBe("v");
    });

    it("legacy 2-arg set(key, v) defaults to global scope", () => {
      const c = new TTLCache(1000);
      c.set("k", "v");
      expect(c.get<string>("k")).toBe("v");
      // Global invalidation should clear it.
      c.invalidateScope(global);
      expect(c.get<string>("k")).toBeNull();
    });
  });

  describe("invalidateScope — exact match only", () => {
    it("epic-scoped invalidate clears matching epic entries only", () => {
      const c = new TTLCache(10000);
      c.set("a-key", "v1", epicA);
      c.set("b-key", "v2", epicB);
      c.invalidateScope(epicA);
      expect(c.get<string>("a-key")).toBeNull();
      expect(c.get<string>("b-key")).toBe("v2");
    });

    it("epic-scoped invalidate does NOT clear repo or global entries", () => {
      const c = new TTLCache(10000);
      c.set("e", "epic-v", epicA);
      c.set("r", "repo-v", repoX);
      c.set("g", "global-v", global);
      c.invalidateScope(epicA);
      expect(c.get<string>("e")).toBeNull();
      expect(c.get<string>("r")).toBe("repo-v");
      expect(c.get<string>("g")).toBe("global-v");
    });

    it("global-scoped invalidate clears global entries only (NOT epic / repo)", () => {
      const c = new TTLCache(10000);
      c.set("e", "epic-v", epicA);
      c.set("r", "repo-v", repoX);
      c.set("g", "global-v", global);
      c.invalidateScope(global);
      expect(c.get<string>("g")).toBeNull();
      expect(c.get<string>("e")).toBe("epic-v");
      expect(c.get<string>("r")).toBe("repo-v");
    });

    it("repo-scoped invalidate clears matching repo entries only", () => {
      const c = new TTLCache(10000);
      c.set("rx", "x-v", repoX);
      c.set("ry", "y-v", repoY);
      c.invalidateScope(repoX);
      expect(c.get<string>("rx")).toBeNull();
      expect(c.get<string>("ry")).toBe("y-v");
    });

    it("wrong epicId does not cross-clear (exact match on epicId)", () => {
      const c = new TTLCache(10000);
      c.set("k", "v", epicA);
      c.invalidateScope(epicB);
      expect(c.get<string>("k")).toBe("v");
    });

    it("prefix-similar epicIds do not cross-clear", () => {
      const c = new TTLCache(10000);
      c.set("k1", "v1", { type: "epic", epicId: "foo" });
      c.set("k2", "v2", { type: "epic", epicId: "foo-x" });
      c.invalidateScope({ type: "epic", epicId: "foo" });
      expect(c.get<string>("k1")).toBeNull();
      expect(c.get<string>("k2")).toBe("v2");
    });

    it("invalidateScope on an empty cache is a no-op", () => {
      const c = new TTLCache(10000);
      expect(() => c.invalidateScope(epicA)).not.toThrow();
      expect(() => c.invalidateScope(global)).not.toThrow();
    });

    it("boundary — 1,000 entries with mixed scopes clears matching subset in <10ms", () => {
      const c = new TTLCache(60000);
      for (let i = 0; i < 333; i++) c.set(`e${i}`, i, { type: "epic", epicId: "target" });
      for (let i = 0; i < 333; i++) c.set(`e_other${i}`, i, { type: "epic", epicId: "other" });
      for (let i = 0; i < 334; i++) c.set(`g${i}`, i, global);
      const started = Date.now();
      c.invalidateScope({ type: "epic", epicId: "target" });
      const elapsed = Date.now() - started;
      // Bead AC: under 10ms at 1k entries.
      expect(elapsed).toBeLessThan(10);
      // Verify: 333 "target" entries cleared; 333 "other" + 334 global remain.
      expect(c.get<number>("e0")).toBeNull();
      expect(c.get<number>("e_other0")).toBe(0);
      expect(c.get<number>("g0")).toBe(0);
    });
  });

  describe("TTL is orthogonal to scope", () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it("scoped entry still expires at TTL without any invalidate call", () => {
      const c = new TTLCache(100);
      c.set("k", "v", epicA);
      jest.advanceTimersByTime(101);
      expect(c.get<string>("k")).toBeNull();
    });

    it("invalidate and TTL are independent — scope invalidation doesn't reset TTL on survivors", () => {
      const c = new TTLCache(100);
      c.set("survivor", "sv", epicB);
      c.set("target", "tv", epicA);
      jest.advanceTimersByTime(50);
      c.invalidateScope(epicA);
      // 50ms remaining until survivor's TTL expires.
      expect(c.get<string>("survivor")).toBe("sv");
      jest.advanceTimersByTime(51);
      expect(c.get<string>("survivor")).toBeNull();
    });
  });

  describe("invalidateAll — backward compat (factor-core-ppx.3 notes)", () => {
    it("still clears every entry regardless of scope", () => {
      const c = new TTLCache(10000);
      c.set("e", "epic-v", epicA);
      c.set("r", "repo-v", repoX);
      c.set("g", "global-v", global);
      c.invalidateAll();
      expect(c.get<string>("e")).toBeNull();
      expect(c.get<string>("r")).toBeNull();
      expect(c.get<string>("g")).toBeNull();
    });
  });
});

describe("TTLCache.getOrCompute — single-flight rebuild (factory-core-ppx.3)", () => {
  const scope: CacheScope = { type: "epic", epicId: "foo" };

  it("first call runs compute and caches the result", async () => {
    const c = new TTLCache(1000);
    let invocations = 0;
    const compute = async () => {
      invocations++;
      return "first-result";
    };
    const result = await c.getOrCompute("k", scope, compute);
    expect(result).toBe("first-result");
    expect(invocations).toBe(1);
    // Cached — a direct get returns it.
    expect(c.get<string>("k")).toBe("first-result");
  });

  it("second call within TTL returns cached value WITHOUT re-running compute", async () => {
    const c = new TTLCache(1000);
    let invocations = 0;
    const compute = async () => {
      invocations++;
      return "v";
    };
    await c.getOrCompute("k", scope, compute);
    await c.getOrCompute("k", scope, compute);
    expect(invocations).toBe(1);
  });

  it("single-flight: 5 concurrent callers collapse to ONE compute invocation (Feature 5 AC)", async () => {
    const c = new TTLCache(10000);
    let invocations = 0;
    const slowCompute = async (): Promise<string> => {
      invocations++;
      await delay(50);
      return "rebuild-result";
    };
    const results = await Promise.all([
      c.getOrCompute("k", scope, slowCompute),
      c.getOrCompute("k", scope, slowCompute),
      c.getOrCompute("k", scope, slowCompute),
      c.getOrCompute("k", scope, slowCompute),
      c.getOrCompute("k", scope, slowCompute),
    ]);
    expect(invocations).toBe(1);
    expect(results).toEqual([
      "rebuild-result",
      "rebuild-result",
      "rebuild-result",
      "rebuild-result",
      "rebuild-result",
    ]);
  });

  it("rejection propagates to ALL waiters with the same error (regression pattern #13)", async () => {
    const c = new TTLCache(10000);
    const failingCompute = async (): Promise<string> => {
      await delay(10);
      throw new Error("bd down");
    };
    const p1 = c.getOrCompute("k", scope, failingCompute);
    const p2 = c.getOrCompute("k", scope, failingCompute);
    const p3 = c.getOrCompute("k", scope, failingCompute);
    await expect(p1).rejects.toThrow("bd down");
    await expect(p2).rejects.toThrow("bd down");
    await expect(p3).rejects.toThrow("bd down");
  });

  it("next call after a rejection re-attempts (in-flight entry cleared)", async () => {
    const c = new TTLCache(10000);
    let round = 0;
    const compute = async () => {
      round++;
      if (round === 1) throw new Error("transient");
      return `round-${round}`;
    };
    await expect(c.getOrCompute("k", scope, compute)).rejects.toThrow("transient");
    const second = await c.getOrCompute("k", scope, compute);
    expect(second).toBe("round-2");
    expect(round).toBe(2);
  });

  it("concurrent callers AFTER a rejection also retry (not stuck on stale pending Promise)", async () => {
    const c = new TTLCache(10000);
    let invocations = 0;
    const compute = async () => {
      invocations++;
      if (invocations === 1) {
        await delay(5);
        throw new Error("first-fail");
      }
      return "second-success";
    };
    await expect(c.getOrCompute("k", scope, compute)).rejects.toThrow(
      "first-fail",
    );
    // After rejection resolves, concurrent retries collapse into one second compute.
    const [a, b, c2] = await Promise.all([
      c.getOrCompute("k", scope, compute),
      c.getOrCompute("k", scope, compute),
      c.getOrCompute("k", scope, compute),
    ]);
    expect(a).toBe("second-success");
    expect(b).toBe("second-success");
    expect(c2).toBe("second-success");
    // Exactly 2 compute invocations total: the failing first + one shared retry.
    expect(invocations).toBe(2);
  });

  it("compute returning undefined is cached; next call does NOT re-run compute", async () => {
    const c = new TTLCache(1000);
    let invocations = 0;
    const compute = async () => {
      invocations++;
      return undefined as unknown as string;
    };
    const first = await c.getOrCompute<string>("k", scope, compute);
    expect(first).toBeUndefined();
    const second = await c.getOrCompute<string>("k", scope, compute);
    expect(second).toBeUndefined();
    expect(invocations).toBe(1);
  });

  it("TTL expiry forces a re-compute", async () => {
    const c = new TTLCache(40);
    let invocations = 0;
    const compute = async () => {
      invocations++;
      return `r${invocations}`;
    };
    await c.getOrCompute("k", scope, compute);
    await delay(60);
    await c.getOrCompute("k", scope, compute);
    expect(invocations).toBe(2);
  });

  it("invalidateScope clears a cached entry and forces a re-compute on next getOrCompute", async () => {
    const c = new TTLCache(10000);
    let invocations = 0;
    const compute = async () => {
      invocations++;
      return `r${invocations}`;
    };
    await c.getOrCompute("k", scope, compute);
    c.invalidateScope(scope);
    const second = await c.getOrCompute("k", scope, compute);
    expect(second).toBe("r2");
    expect(invocations).toBe(2);
  });

  it("getOrCompute supports 30 concurrent callers on the same key (Feature 5 NFR)", async () => {
    const c = new TTLCache(10000);
    let invocations = 0;
    const compute = async () => {
      invocations++;
      await delay(20);
      return { ok: true };
    };
    const results = await Promise.all(
      Array.from({ length: 30 }, () => c.getOrCompute("k", scope, compute)),
    );
    expect(invocations).toBe(1);
    for (const r of results) expect(r).toEqual({ ok: true });
  });

  it("boundary — two concurrent callers (smallest possible single-flight case)", async () => {
    const c = new TTLCache(1000);
    let invocations = 0;
    const compute = async () => {
      invocations++;
      await delay(5);
      return "v";
    };
    const [a, b] = await Promise.all([
      c.getOrCompute("k", scope, compute),
      c.getOrCompute("k", scope, compute),
    ]);
    expect(a).toBe("v");
    expect(b).toBe("v");
    expect(invocations).toBe(1);
  });
});
