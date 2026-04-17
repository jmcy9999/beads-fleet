// =============================================================================
// Tests for src/lib/locks/lock-manager.ts + src/lib/locks/types.ts
// =============================================================================
// Covers the acceptance criteria for factory-core-ppx.1 (LockManager core):
// - withLock runs fn immediately when no contention
// - serialised execution under the same key
// - per-key isolation under different keys
// - release-on-throw (error propagates; next caller proceeds)
// - LockTimeoutError when wait exceeds timeoutMs
// - Map cleanup after release (no leaked entries)
// - FIFO ordering under contention
// - LockKey regex validation rejects unsanitised input
// - epicLock / chainLock produce distinct namespaces (ADR-002)
// - withLock rejects nil / bad arguments at runtime
// - 1s acquisition warn threshold fires console.warn exactly once
// - Public-surface invariant: internal Map / acquire / release are NOT
//   exported by the package index
// =============================================================================

import {
  withLock,
  epicLock,
  chainLock,
  repoLock,
  LockKey,
  LockTimeoutError,
} from "@/lib/locks";
import {
  __lockManagerSize,
  __lockManagerResetForTests,
} from "@/lib/locks/lock-manager";

// Small helper — yields control so microtask queue can drain between checks.
async function tick(): Promise<void> {
  await new Promise((r) => setImmediate(r));
}

async function delay(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe("LockKey (factory-core-ppx.1 — value type validation)", () => {
  describe("construction", () => {
    it("accepts a bd-issue-ID shape id", () => {
      const key = new LockKey("epic", "factory-core-ppx");
      expect(key.toString()).toBe("epic:factory-core-ppx");
    });

    it("accepts a bd-issue-ID with dotted numeric suffix", () => {
      const key = new LockKey("epic", "factory-core-ppx.1");
      expect(key.toString()).toBe("epic:factory-core-ppx.1");
    });

    it("accepts a repo-path shape id", () => {
      const key = new LockKey(
        "repo",
        "/Users/janemckay/dev/fleet/fleet-core",
      );
      expect(key.toString()).toBe("repo:/Users/janemckay/dev/fleet/fleet-core");
    });

    it("rejects an id containing whitespace (security: no unsanitised input)", () => {
      expect(() => new LockKey("epic", "not a valid id")).toThrow(/regex/);
    });

    it("rejects an empty id", () => {
      expect(() => new LockKey("epic", "")).toThrow(
        /LockKey id must be a non-empty string/,
      );
    });

    it("rejects a non-string id", () => {
      // @ts-expect-error — runtime guard for JS callers
      expect(() => new LockKey("epic", 42)).toThrow(/non-empty string/);
    });

    it("rejects an empty namespace", () => {
      expect(() => new LockKey("", "factory-core-ppx")).toThrow(
        /namespace must be a non-empty string/,
      );
    });

    it("rejects an invalid namespace (uppercase / digits / symbols)", () => {
      expect(() => new LockKey("Epic", "factory-core-ppx")).toThrow(
        /namespace must match/,
      );
      expect(() => new LockKey("epic1", "factory-core-ppx")).toThrow(
        /namespace must match/,
      );
      expect(() => new LockKey("epic-chain", "factory-core-ppx")).toThrow(
        /namespace must match/,
      );
    });

    it("rejects id with shell metacharacter", () => {
      expect(() => new LockKey("epic", "foo;rm -rf /")).toThrow(/regex/);
      expect(() => new LockKey("epic", "foo|bar")).toThrow(/regex/);
      expect(() => new LockKey("epic", "foo`bar`")).toThrow(/regex/);
    });
  });

  describe("ADR-002 namespace distinctness (epicLock vs chainLock)", () => {
    it("epicLock and chainLock produce DIFFERENT string keys for the same id", () => {
      const e = epicLock("factory-core-ppx");
      const c = chainLock("factory-core-ppx");
      expect(e.toString()).toBe("epic:factory-core-ppx");
      expect(c.toString()).toBe("chain:factory-core-ppx");
      expect(e.toString()).not.toBe(c.toString());
    });

    it("repoLock produces a `repo:<path>` key", () => {
      const r = repoLock("/Users/janemckay/dev/fleet/fleet-core");
      expect(r.toString()).toBe("repo:/Users/janemckay/dev/fleet/fleet-core");
    });
  });

  describe("LockTimeoutError", () => {
    it("carries key and timeoutMs fields", () => {
      const err = new LockTimeoutError("epic:foo-abc", 30000);
      expect(err.key).toBe("epic:foo-abc");
      expect(err.timeoutMs).toBe(30000);
      expect(err.name).toBe("LockTimeoutError");
    });

    it("is instanceof Error and LockTimeoutError", () => {
      const err = new LockTimeoutError("chain:foo-abc", 500);
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(LockTimeoutError);
    });

    it("has a descriptive message naming the key and timeout", () => {
      const err = new LockTimeoutError("epic:foo-abc", 250);
      expect(err.message).toContain("epic:foo-abc");
      expect(err.message).toContain("250");
    });
  });
});

describe("withLock (factory-core-ppx.1 — LockManager core)", () => {
  beforeEach(() => {
    __lockManagerResetForTests();
  });

  describe("happy path — no contention", () => {
    it("runs fn immediately and returns its value when nobody holds the key", async () => {
      const result = await withLock(epicLock("foo-abc"), 30000, async () => 42);
      expect(result).toBe(42);
    });

    it("releases the lock after fn completes (Map is empty)", async () => {
      await withLock(epicLock("foo-abc"), 30000, async () => "ok");
      // Allow microtasks (cleanup .then) to run before asserting
      await tick();
      expect(__lockManagerSize()).toBe(0);
    });

    it("supports a no-op fn and resolves with undefined", async () => {
      const result = await withLock(
        epicLock("a-b"),
        1000,
        async () => {},
      );
      expect(result).toBeUndefined();
    });
  });

  describe("serialisation on same key (ADR-001)", () => {
    it("two concurrent callers on the same key run in strict order, not interleaved", async () => {
      const order: string[] = [];
      const caller = (id: string, holdMs: number) =>
        withLock(epicLock("foo-abc"), 5000, async () => {
          order.push(`start:${id}`);
          await delay(holdMs);
          order.push(`end:${id}`);
        });

      await Promise.all([caller("A", 50), caller("B", 10)]);

      // Second caller does not start until first ends.
      expect(order).toEqual(["start:A", "end:A", "start:B", "end:B"]);
    });

    it("total elapsed time under same-key contention is additive (>= sum of holds)", async () => {
      const hold = 50;
      const started = Date.now();
      await Promise.all([
        withLock(epicLock("foo-abc"), 5000, () => delay(hold)),
        withLock(epicLock("foo-abc"), 5000, () => delay(hold)),
      ]);
      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(hold * 2 - 5);
    });

    it("FIFO order preserved under 100 queued callers on the same key", async () => {
      const order: number[] = [];
      const tasks: Array<Promise<void>> = [];
      for (let i = 0; i < 100; i++) {
        tasks.push(
          withLock(epicLock("fifo-test"), 60000, async () => {
            order.push(i);
            // Yield control so we can't possibly complete synchronously.
            await Promise.resolve();
          }),
        );
      }
      await Promise.all(tasks);
      expect(order).toEqual(Array.from({ length: 100 }, (_, i) => i));
    });
  });

  describe("per-key isolation (ADR-002)", () => {
    it("two concurrent callers on DIFFERENT keys run in parallel (no contention)", async () => {
      const hold = 40;
      const started = Date.now();
      await Promise.all([
        withLock(epicLock("epic-a"), 5000, () => delay(hold)),
        withLock(epicLock("epic-b"), 5000, () => delay(hold)),
      ]);
      const elapsed = Date.now() - started;
      // Parallel: total should be roughly max(hold, hold), not 2*hold.
      // Allow some scheduler slack.
      expect(elapsed).toBeLessThan(hold * 2 - 5);
    });

    it("epicLock(id) and chainLock(id) with the SAME id do NOT contend (ADR-002 no-deadlock invariant)", async () => {
      const hold = 40;
      const started = Date.now();
      await Promise.all([
        withLock(epicLock("foo-abc"), 5000, () => delay(hold)),
        withLock(chainLock("foo-abc"), 5000, () => delay(hold)),
      ]);
      const elapsed = Date.now() - started;
      expect(elapsed).toBeLessThan(hold * 2 - 5);
    });
  });

  describe("release-on-throw (regression pattern #13 — Silent Exception Swallowing)", () => {
    it("propagates the original error to the caller (never swallowed)", async () => {
      await expect(
        withLock(epicLock("foo-abc"), 5000, async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
    });

    it("releases the lock even when fn throws (next caller acquires immediately)", async () => {
      // First caller throws
      await expect(
        withLock(epicLock("foo-abc"), 5000, async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      // Second caller should acquire immediately — if the lock leaked, this
      // would time out or hang.
      const started = Date.now();
      const result = await withLock(
        epicLock("foo-abc"),
        5000,
        async () => "recovered",
      );
      const elapsed = Date.now() - started;
      expect(result).toBe("recovered");
      expect(elapsed).toBeLessThan(50);
    });

    it("does NOT swallow — error is rethrown unchanged", async () => {
      class CustomError extends Error {
        constructor(public code: string) {
          super(`custom: ${code}`);
        }
      }

      let caught: CustomError | undefined;
      try {
        await withLock(epicLock("foo-abc"), 5000, async () => {
          throw new CustomError("E42");
        });
      } catch (e) {
        caught = e as CustomError;
      }
      expect(caught).toBeInstanceOf(CustomError);
      expect(caught?.code).toBe("E42");
    });
  });

  describe("timeout (LockTimeoutError)", () => {
    it("rejects with LockTimeoutError when wait for predecessor exceeds timeoutMs", async () => {
      // First caller holds for 200ms.
      const first = withLock(epicLock("foo-abc"), 5000, () => delay(200));

      // Second caller has a 50ms timeout — should reject.
      await expect(
        withLock(epicLock("foo-abc"), 50, async () => "never"),
      ).rejects.toBeInstanceOf(LockTimeoutError);

      await first;
    });

    it("LockTimeoutError carries the stringified key and timeoutMs", async () => {
      const first = withLock(epicLock("foo-abc"), 5000, () => delay(100));

      try {
        await withLock(epicLock("foo-abc"), 25, async () => "never");
        fail("Expected LockTimeoutError");
      } catch (err) {
        expect(err).toBeInstanceOf(LockTimeoutError);
        const te = err as LockTimeoutError;
        expect(te.key).toBe("epic:foo-abc");
        expect(te.timeoutMs).toBe(25);
      }

      await first;
    });

    it("after a timeout, a later caller acquires normally once the original holder releases (no leaked lock)", async () => {
      // First holder holds for 150ms.
      const first = withLock(epicLock("foo-abc"), 5000, () => delay(150));

      // Three callers all time out at 30ms.
      await expect(
        withLock(epicLock("foo-abc"), 30, () => delay(1)),
      ).rejects.toBeInstanceOf(LockTimeoutError);
      await expect(
        withLock(epicLock("foo-abc"), 30, () => delay(1)),
      ).rejects.toBeInstanceOf(LockTimeoutError);
      await expect(
        withLock(epicLock("foo-abc"), 30, () => delay(1)),
      ).rejects.toBeInstanceOf(LockTimeoutError);

      // First holder completes.
      await first;
      await tick();

      // A fourth caller should acquire immediately.
      const started = Date.now();
      const result = await withLock(
        epicLock("foo-abc"),
        5000,
        async () => "ok",
      );
      const elapsed = Date.now() - started;
      expect(result).toBe("ok");
      expect(elapsed).toBeLessThan(50);

      // Map should be empty after everything drains.
      await tick();
      expect(__lockManagerSize()).toBe(0);
    });

    it("a timeout of 0 still rejects when the predecessor is not yet resolved", async () => {
      const first = withLock(epicLock("foo-abc"), 5000, () => delay(50));
      await expect(
        withLock(epicLock("foo-abc"), 0, async () => "never"),
      ).rejects.toBeInstanceOf(LockTimeoutError);
      await first;
    });
  });

  describe("1-second acquisition warn threshold", () => {
    it("emits console.warn exactly once when acquisition takes > 1s", async () => {
      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

      // First holder holds for 1100ms.
      const first = withLock(epicLock("slow-epic"), 5000, () => delay(1100));
      // Second caller waits; its acquisition time will exceed 1s.
      const second = await withLock(
        epicLock("slow-epic"),
        5000,
        async () => "ok",
      );
      await first;

      expect(second).toBe("ok");
      const lockWarns = warnSpy.mock.calls.filter((c) =>
        String(c[0]).includes("Lock") && String(c[0]).includes("slow-epic"),
      );
      expect(lockWarns.length).toBe(1);
      expect(String(lockWarns[0][0])).toMatch(/took \d+ms to acquire/);

      warnSpy.mockRestore();
    }, 5000);

    it("does NOT warn for fast acquisition (< 1s)", async () => {
      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

      await withLock(epicLock("fast-epic"), 5000, () => delay(50));
      await withLock(epicLock("fast-epic"), 5000, () => delay(50));

      const lockWarns = warnSpy.mock.calls.filter((c) =>
        String(c[0]).includes("Lock") && String(c[0]).includes("fast-epic"),
      );
      expect(lockWarns.length).toBe(0);

      warnSpy.mockRestore();
    });
  });

  describe("Map lifecycle (cleanup / no leaked entries)", () => {
    it("Map is empty before any caller invokes withLock", () => {
      expect(__lockManagerSize()).toBe(0);
    });

    it("Map is empty after a single caller completes", async () => {
      await withLock(epicLock("foo-abc"), 5000, async () => "ok");
      await tick();
      expect(__lockManagerSize()).toBe(0);
    });

    it("Map has one entry while a caller holds", async () => {
      let resolveHold!: () => void;
      const hold = new Promise<void>((r) => (resolveHold = r));
      const p = withLock(epicLock("foo-abc"), 5000, () => hold);
      // Give the chain a tick to install.
      await tick();
      expect(__lockManagerSize()).toBe(1);
      resolveHold();
      await p;
      await tick();
      expect(__lockManagerSize()).toBe(0);
    });

    it("Map size is bounded to one entry per key under heavy contention", async () => {
      // Kick off 200 callers on the SAME key concurrently.
      const tasks = Array.from({ length: 200 }, () =>
        withLock(epicLock("heavy-test"), 60000, () => delay(1)),
      );
      // While they're running, size should never exceed 1.
      await tick();
      expect(__lockManagerSize()).toBeLessThanOrEqual(1);
      await Promise.all(tasks);
      await tick();
      expect(__lockManagerSize()).toBe(0);
    });

    it("Map grows with distinct keys but each entry is independent", async () => {
      let resolveA!: () => void;
      let resolveB!: () => void;
      const holdA = new Promise<void>((r) => (resolveA = r));
      const holdB = new Promise<void>((r) => (resolveB = r));
      const pA = withLock(epicLock("a-b"), 5000, () => holdA);
      const pB = withLock(epicLock("c-d"), 5000, () => holdB);
      await tick();
      expect(__lockManagerSize()).toBe(2);
      resolveA();
      await pA;
      await tick();
      expect(__lockManagerSize()).toBe(1);
      resolveB();
      await pB;
      await tick();
      expect(__lockManagerSize()).toBe(0);
    });
  });

  describe("argument validation (runtime guards)", () => {
    it("rejects a null key", async () => {
      await expect(
        // @ts-expect-error runtime guard for JS callers
        withLock(null, 1000, async () => 1),
      ).rejects.toThrow(/LockKey/);
      // Map should not contain a null-key entry.
      expect(__lockManagerSize()).toBe(0);
    });

    it("rejects a plain string as a key", async () => {
      await expect(
        // @ts-expect-error runtime guard
        withLock("epic:foo-abc", 1000, async () => 1),
      ).rejects.toThrow(/LockKey/);
      expect(__lockManagerSize()).toBe(0);
    });

    it("rejects a non-number timeoutMs", async () => {
      await expect(
        // @ts-expect-error runtime guard
        withLock(epicLock("foo-abc"), "1000", async () => 1),
      ).rejects.toThrow(/timeoutMs/);
    });

    it("rejects a negative timeoutMs", async () => {
      await expect(
        withLock(epicLock("foo-abc"), -1, async () => 1),
      ).rejects.toThrow(/timeoutMs/);
    });

    it("rejects a non-function fn", async () => {
      await expect(
        // @ts-expect-error runtime guard
        withLock(epicLock("foo-abc"), 1000, null),
      ).rejects.toThrow(/fn/);
    });
  });

  describe("public-surface invariant (import stability)", () => {
    it("exports from @/lib/locks contain exactly the documented public surface", async () => {
      const mod = await import("@/lib/locks");
      const names = Object.keys(mod).sort();
      // Documented public surface (architecture Component Boundaries):
      //   withLock, epicLock, chainLock, repoLock, LockKey, LockTimeoutError
      expect(names).toEqual(
        [
          "LockKey",
          "LockTimeoutError",
          "chainLock",
          "epicLock",
          "repoLock",
          "withLock",
        ].sort(),
      );
    });

    it("does NOT expose the internal Map or acquire/release primitives from the index", async () => {
      const mod = await import("@/lib/locks");
      const names = Object.keys(mod);
      for (const leak of ["acquire", "release", "tails", "Map", "__lockManagerSize"]) {
        expect(names).not.toContain(leak);
      }
    });
  });
});
