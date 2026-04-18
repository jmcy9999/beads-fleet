// =============================================================================
// Concurrency tests for src/lib/pipeline-labels.ts (factory-core-ppx.5)
// =============================================================================
//
// Verifies the per-epic label locking integration: `addLabelsToEpic`,
// `removeLabelsFromEpic`, and `removeLabelsFromEpicStrict` all wrap their
// bodies in `withLock(epicLock(issueId), 30_000, …)`.
//
// Acceptance criteria covered (factory-core-ppx.5):
//   Happy path  — two concurrent addLabelsToEpic calls on the SAME epic
//                 serialise FIFO; the second waits for the first.
//   Edge case   — two concurrent calls on DIFFERENT epics run in parallel
//                 (per-epic locking, ADR-002).
//   Edge case   — lock holder that throws releases the lock so the next
//                 caller proceeds (no deadlock, regression pattern #13).
//   Edge case   — concurrent addLabelsToEpic calls on the SAME epic:
//                 all labels applied, no lost bd invocations.
//   Edge case   — removeLabelsFromEpic concurrent with addLabelsToEpic on
//                 the SAME epic: bd invocations appear in lock-acquisition
//                 order, no interleaving.
//   Edge case   — removeLabelsFromEpicStrict validation read + remove
//                 run inside the same lock (no TOCTOU: regression-patterns
//                 Read/Write Disconnect).
//   Boundary    — empty labels: lock acquired briefly, no bd calls, no error.
//   Boundary    — 100 concurrent callers on the same epic: FIFO order,
//                 every caller observed (no lost labels).
//   Boundary    — issueId = undefined: rejects BEFORE any lock is acquired
//                 (no orphaned LockManager entry).
//   Nesting     — the LockManager would deadlock if `addLabelsToEpic`
//                 re-entered itself on the same epic; an instrumented wait
//                 confirms the re-entrant call never completes before the
//                 outer body does (lock timeout proves non-reentrant
//                 behaviour, matching ADR-002).
//   Timeout     — with an artificially low timeout, a blocked caller
//                 rejects with `LockTimeoutError` and the next caller
//                 proceeds normally once the holder releases.
// =============================================================================

// execFile is promisified in pipeline-labels.ts, so we mock the callback-style
// child_process.execFile and let promisify wrap it.
const mockExecFile = jest.fn();

jest.mock("child_process", () => ({
  execFile: (
    cmd: string,
    args: string[],
    opts: unknown,
    cb: (err: Error | null, stdout: string, stderr: string) => void,
  ) => mockExecFile(cmd, args, opts, cb),
}));

// repo-config.findRepoForIssue is called to resolve the repo path. Short-
// circuit it to avoid filesystem / Dolt access in the unit test.
jest.mock("@/lib/repo-config", () => ({
  findRepoForIssue: jest.fn().mockResolvedValue("/tmp/fake-repo"),
}));

// bd-path.getBdPath must return a deterministic path in the test environment.
jest.mock("@/lib/bd-path", () => ({
  getBdPath: () => "/usr/bin/bd",
  getBdEnv: () => ({ NO_COLOR: "1" }),
}));

import {
  addLabelsToEpic,
  removeLabelsFromEpic,
  removeLabelsFromEpicStrict,
  __setEpicLabelLockTimeoutMsForTests,
  __resetEpicLabelLockTimeoutMsForTests,
} from "@/lib/pipeline-labels";
import { LockTimeoutError } from "@/lib/locks";
import {
  __lockManagerSize,
  __lockManagerResetForTests,
} from "@/lib/locks/lock-manager";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function tick(): Promise<void> {
  await new Promise((r) => setImmediate(r));
}

async function delay(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * Configure `execFile` to succeed synchronously. Records every call for
 * ordering assertions.
 *
 * Returns the shared call log -- an array of `{ op, issueId, label }` in
 * the order `execFile` was invoked.
 */
function instrumentExecFile(callLog: Array<{ op: string; issueId: string; label: string }>): void {
  mockExecFile.mockImplementation((_cmd, args, _opts, cb) => {
    // args shape: ["label", "add"|"remove", issueId, label]
    const op = args[1];
    const issueId = args[2];
    const label = args[3];
    callLog.push({ op, issueId, label });
    cb(null, "", "");
  });
}

/**
 * Configure `execFile` so each call blocks for `holdMs` before resolving.
 * Used to probe serialisation: if two callers run concurrently and each
 * blocks for `holdMs`, contention on the same epic pushes total elapsed
 * time above `holdMs` (roughly 2 * holdMs for two serialised callers).
 */
function instrumentExecFileWithDelay(
  holdMs: number,
  callLog: Array<{ op: string; issueId: string; label: string; phase: "start" | "end" }>,
): void {
  mockExecFile.mockImplementation((_cmd, args, _opts, cb) => {
    const op = args[1];
    const issueId = args[2];
    const label = args[3];
    callLog.push({ op, issueId, label, phase: "start" });
    setTimeout(() => {
      callLog.push({ op, issueId, label, phase: "end" });
      cb(null, "", "");
    }, holdMs);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  __lockManagerResetForTests();
  __resetEpicLabelLockTimeoutMsForTests();
});

afterEach(() => {
  __resetEpicLabelLockTimeoutMsForTests();
});

// ---------------------------------------------------------------------------
// Happy path — two concurrent addLabelsToEpic calls on the SAME epic
// ---------------------------------------------------------------------------

describe("addLabelsToEpic — same-epic serialisation (Feature 1 happy path)", () => {
  it("serialises two concurrent calls FIFO: caller A's bd invocations all precede caller B's", async () => {
    const log: Array<{ op: string; issueId: string; label: string; phase: "start" | "end" }> = [];
    instrumentExecFileWithDelay(20, log);

    // Caller A applies ["a1", "a2"], Caller B applies ["b1", "b2"]. If the
    // lock is enforced, A's four phase markers (start:a1, end:a1, start:a2,
    // end:a2) all land BEFORE any of B's markers. Without the lock, the
    // two setTimeout-based bd calls would interleave.
    const a = addLabelsToEpic("foo-abc", ["a1", "a2"]);
    const b = addLabelsToEpic("foo-abc", ["b1", "b2"]);
    await Promise.all([a, b]);

    // Split into "A events" and "B events" and verify every A event
    // occurred before every B event.
    const aEvents = log.filter((e) => e.label.startsWith("a"));
    const bEvents = log.filter((e) => e.label.startsWith("b"));
    const lastAIdx = log.lastIndexOf(aEvents[aEvents.length - 1]);
    const firstBIdx = log.indexOf(bEvents[0]);
    expect(lastAIdx).toBeLessThan(firstBIdx);
    // Sanity: both callers fully completed.
    expect(aEvents).toHaveLength(4);
    expect(bEvents).toHaveLength(4);
  });

  it("applies BOTH callers' labels after both finish (no lost bd invocations)", async () => {
    const log: Array<{ op: string; issueId: string; label: string }> = [];
    instrumentExecFile(log);

    await Promise.all([
      addLabelsToEpic("foo-abc", ["x"]),
      addLabelsToEpic("foo-abc", ["x"]),
    ]);

    // Both callers invoked `bd label add` once each — bd's Dolt-backed
    // `label add` is itself idempotent (adding an existing label is a
    // no-op) so the caller-visible post-condition is "label x present".
    // At this integration layer we verify the bd invocation pair actually
    // happened — no silent short-circuit dropped one of them.
    const addsForFoo = log.filter((e) => e.op === "add" && e.issueId === "foo-abc");
    expect(addsForFoo).toHaveLength(2);
    expect(addsForFoo.every((e) => e.label === "x")).toBe(true);
  });

  it("total elapsed time reflects SERIAL execution (>= sum of per-caller holds)", async () => {
    const hold = 30;
    const log: Array<{ op: string; issueId: string; label: string; phase: "start" | "end" }> = [];
    instrumentExecFileWithDelay(hold, log);

    const started = Date.now();
    await Promise.all([
      addLabelsToEpic("foo-abc", ["a"]),
      addLabelsToEpic("foo-abc", ["b"]),
    ]);
    const elapsed = Date.now() - started;
    // Two serialised calls, one bd invocation each — elapsed should be
    // at least 2 * hold (allow small slack for setTimeout skew).
    expect(elapsed).toBeGreaterThanOrEqual(hold * 2 - 10);
  });
});

// ---------------------------------------------------------------------------
// Per-epic isolation (ADR-002) — different epics run in parallel
// ---------------------------------------------------------------------------

describe("addLabelsToEpic — per-epic isolation (ADR-002)", () => {
  it("two concurrent calls on DIFFERENT epics run in parallel (no contention)", async () => {
    const hold = 40;
    const log: Array<{ op: string; issueId: string; label: string; phase: "start" | "end" }> = [];
    instrumentExecFileWithDelay(hold, log);

    const started = Date.now();
    await Promise.all([
      addLabelsToEpic("epic-one", ["x"]),
      addLabelsToEpic("epic-two", ["y"]),
    ]);
    const elapsed = Date.now() - started;

    // Parallel: total should be near `hold`, never close to 2 * hold.
    expect(elapsed).toBeLessThan(hold * 2 - 10);

    // Both bd invocations happened; their start markers interleave (both
    // landed before either end marker) — the clearest signal that the
    // two callers ran concurrently.
    const starts = log.filter((e) => e.phase === "start");
    const endsBeforeSecondStart = log
      .slice(0, log.indexOf(starts[1]))
      .filter((e) => e.phase === "end");
    expect(endsBeforeSecondStart).toHaveLength(0);
  });

  it("serialises on same epic but runs parallel on different epics in the same burst", async () => {
    const hold = 30;
    const log: Array<{ op: string; issueId: string; label: string; phase: "start" | "end" }> = [];
    instrumentExecFileWithDelay(hold, log);

    // Two callers on epic-1 (serialised), one on epic-2 (parallel to the
    // epic-1 work). Expected elapsed: ~ 2 * hold for the epic-1 queue;
    // epic-2 completes within that same window.
    const started = Date.now();
    await Promise.all([
      addLabelsToEpic("epic-1", ["a"]),
      addLabelsToEpic("epic-1", ["b"]),
      addLabelsToEpic("epic-2", ["c"]),
    ]);
    const elapsed = Date.now() - started;

    // Must be enough time for the two epic-1 calls to serialise…
    expect(elapsed).toBeGreaterThanOrEqual(hold * 2 - 10);
    // …but NOT enough for all three to serialise (epic-2 ran in parallel).
    expect(elapsed).toBeLessThan(hold * 3);
  });
});

// ---------------------------------------------------------------------------
// removeLabelsFromEpic concurrent with addLabelsToEpic (same epic)
// ---------------------------------------------------------------------------

describe("addLabelsToEpic / removeLabelsFromEpic — same-epic ordering", () => {
  it("bd invocations from both helpers appear in lock-acquisition order, not interleaved", async () => {
    const log: Array<{ op: string; issueId: string; label: string; phase: "start" | "end" }> = [];
    instrumentExecFileWithDelay(15, log);

    // Kick off the add first so it wins the lock; then kick off the
    // remove — it must wait its turn.
    const addP = addLabelsToEpic("foo-abc", ["x1", "x2"]);
    // Small microtask tick so `addP` has registered in the LockManager
    // Map before `removeP` tries to queue.
    await Promise.resolve();
    const removeP = removeLabelsFromEpic("foo-abc", ["y1", "y2"]);
    await Promise.all([addP, removeP]);

    const ops = log.map((e) => ({ op: e.op, phase: e.phase, label: e.label }));
    // Every "add" event precedes every "remove" event.
    const lastAdd = ops.lastIndexOf(ops.filter((o) => o.op === "add").slice(-1)[0]);
    const firstRemove = ops.indexOf(ops.filter((o) => o.op === "remove")[0]);
    expect(lastAdd).toBeGreaterThanOrEqual(0);
    expect(firstRemove).toBeGreaterThan(lastAdd);
  });

  it("reversed order: if remove wins the lock first, its invocations precede the add's", async () => {
    const log: Array<{ op: string; issueId: string; label: string; phase: "start" | "end" }> = [];
    instrumentExecFileWithDelay(15, log);

    const removeP = removeLabelsFromEpic("foo-abc", ["y1"]);
    await Promise.resolve();
    const addP = addLabelsToEpic("foo-abc", ["x1"]);
    await Promise.all([removeP, addP]);

    const ops = log.map((e) => ({ op: e.op, phase: e.phase }));
    // Every "remove" event precedes every "add" event.
    const lastRemove = ops.lastIndexOf(ops.filter((o) => o.op === "remove").slice(-1)[0]);
    const firstAdd = ops.indexOf(ops.filter((o) => o.op === "add")[0]);
    expect(firstAdd).toBeGreaterThan(lastRemove);
  });
});

// ---------------------------------------------------------------------------
// removeLabelsFromEpicStrict — validation read + remove inside one lock
// (regression-patterns Read/Write Disconnect, TOCTOU prevention)
// ---------------------------------------------------------------------------

describe("removeLabelsFromEpicStrict — no TOCTOU window", () => {
  it("all bd invocations for one strict-remove call happen contiguously (no other caller interleaves)", async () => {
    const log: Array<{ op: string; issueId: string; label: string; phase: "start" | "end" }> = [];
    instrumentExecFileWithDelay(20, log);

    // A strict-remove with multiple labels; concurrently, an add tries to
    // sneak between the strict-remove's internal bd calls. If the lock is
    // applied only to a narrow validation step (not the full body), the
    // add would interleave. Under our wrapping, the strict-remove's two
    // bd invocations are contiguous.
    const strictP = removeLabelsFromEpicStrict("foo-abc", ["l1", "l2"]);
    await Promise.resolve();
    const addP = addLabelsToEpic("foo-abc", ["x"]);
    await Promise.all([strictP, addP]);

    // Find the indices of the strict-remove's two "remove" starts and the
    // add's "add" start — the remove starts must be adjacent in the log.
    const removeStarts = log
      .map((e, i) => ({ ...e, i }))
      .filter((e) => e.op === "remove" && e.phase === "start");
    expect(removeStarts).toHaveLength(2);
    const addStart = log
      .map((e, i) => ({ ...e, i }))
      .find((e) => e.op === "add" && e.phase === "start");
    expect(addStart).toBeDefined();

    // No add-start index can fall between the two remove-start indices.
    // (Stronger: the add must come either entirely before or entirely
    // after both removes.)
    const [r1, r2] = removeStarts;
    const a = addStart!;
    const interleaved = a.i > r1.i && a.i < r2.i;
    expect(interleaved).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Boundary — empty labels
// ---------------------------------------------------------------------------

describe("boundary — empty labels", () => {
  it("addLabelsToEpic('foo', []) acquires the lock briefly and calls no bd commands", async () => {
    instrumentExecFile([]);
    await expect(addLabelsToEpic("foo-abc", [])).resolves.toBeUndefined();
    expect(mockExecFile).not.toHaveBeenCalled();
    await tick();
    // LockManager Map must be empty after release.
    expect(__lockManagerSize()).toBe(0);
  });

  it("removeLabelsFromEpic('foo', []) is a no-op and does not leak a lock entry", async () => {
    instrumentExecFile([]);
    await expect(removeLabelsFromEpic("foo-abc", [])).resolves.toBeUndefined();
    expect(mockExecFile).not.toHaveBeenCalled();
    await tick();
    expect(__lockManagerSize()).toBe(0);
  });

  it("removeLabelsFromEpicStrict('foo', []) is a no-op and does not leak a lock entry", async () => {
    instrumentExecFile([]);
    await expect(removeLabelsFromEpicStrict("foo-abc", [])).resolves.toBeUndefined();
    expect(mockExecFile).not.toHaveBeenCalled();
    await tick();
    expect(__lockManagerSize()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Boundary — 100 concurrent callers on the same epic
// ---------------------------------------------------------------------------

describe("boundary — 100 concurrent callers on same epic", () => {
  it("all complete in FIFO order with every bd invocation observed (no lost labels)", async () => {
    const log: Array<{ op: string; issueId: string; label: string }> = [];
    instrumentExecFile(log);

    const N = 100;
    const tasks: Array<Promise<void>> = [];
    for (let i = 0; i < N; i++) {
      tasks.push(addLabelsToEpic("fifo-epic", [`l${i}`]));
    }
    await Promise.all(tasks);

    // Every caller produced exactly one bd invocation, and the order of
    // labels matches the submission order (FIFO).
    expect(log).toHaveLength(N);
    for (let i = 0; i < N; i++) {
      expect(log[i]).toEqual({ op: "add", issueId: "fifo-epic", label: `l${i}` });
    }
    // Map drained.
    await tick();
    expect(__lockManagerSize()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Boundary — nil / missing issueId
// ---------------------------------------------------------------------------

describe("boundary — nil / missing issueId (no orphaned lock)", () => {
  it("addLabelsToEpic(undefined, ...) rejects with a descriptive error BEFORE touching the LockManager", async () => {
    instrumentExecFile([]);
    await expect(
      // @ts-expect-error runtime guard — caller passed undefined
      addLabelsToEpic(undefined, ["x"]),
    ).rejects.toThrow(/addLabelsToEpic.*issueId.*non-empty string/);

    // No bd call; no orphaned entry in the LockManager Map.
    expect(mockExecFile).not.toHaveBeenCalled();
    await tick();
    expect(__lockManagerSize()).toBe(0);
  });

  it("addLabelsToEpic('', ...) rejects with a descriptive error BEFORE touching the LockManager", async () => {
    instrumentExecFile([]);
    await expect(addLabelsToEpic("", ["x"])).rejects.toThrow(
      /addLabelsToEpic.*issueId.*non-empty string/,
    );
    expect(mockExecFile).not.toHaveBeenCalled();
    await tick();
    expect(__lockManagerSize()).toBe(0);
  });

  it("removeLabelsFromEpic(null, ...) rejects with a descriptive error BEFORE touching the LockManager", async () => {
    instrumentExecFile([]);
    await expect(
      // @ts-expect-error runtime guard
      removeLabelsFromEpic(null, ["x"]),
    ).rejects.toThrow(/removeLabelsFromEpic.*issueId.*non-empty string/);
    expect(mockExecFile).not.toHaveBeenCalled();
    await tick();
    expect(__lockManagerSize()).toBe(0);
  });

  it("removeLabelsFromEpicStrict('', ...) rejects with a descriptive error BEFORE touching the LockManager", async () => {
    instrumentExecFile([]);
    await expect(removeLabelsFromEpicStrict("", ["x"])).rejects.toThrow(
      /removeLabelsFromEpicStrict.*issueId.*non-empty string/,
    );
    expect(mockExecFile).not.toHaveBeenCalled();
    await tick();
    expect(__lockManagerSize()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Release-on-throw — crashed holder doesn't deadlock waiters
// ---------------------------------------------------------------------------

describe("release-on-throw — crashed lock holder", () => {
  it("if bd throws mid-operation the lock is still released and the next caller proceeds", async () => {
    // First caller's bd invocation rejects; this is a non-benign error in
    // the strict variant, which rethrows. The lock-release `finally` must
    // still fire so the next caller acquires without hanging.
    let call = 0;
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
      call++;
      if (call === 1) {
        cb(new Error("bd: connection refused"), "", "bd: connection refused");
      } else {
        cb(null, "", "");
      }
    });

    await expect(
      removeLabelsFromEpicStrict("foo-abc", ["boom"]),
    ).rejects.toThrow(/connection refused/);

    // Second caller on the same epic must proceed -- if the lock leaked
    // it would sit in the LockManager queue forever.
    const started = Date.now();
    await expect(addLabelsToEpic("foo-abc", ["x"])).resolves.toBeUndefined();
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(100);

    // Map drained after both callers.
    await tick();
    expect(__lockManagerSize()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Lock timeout — artificially low timeout override
// ---------------------------------------------------------------------------

describe("lock timeout — LockTimeoutError + recovery", () => {
  it("waiter times out with LockTimeoutError when the holder blocks past the configured timeout", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    __setEpicLabelLockTimeoutMsForTests(50);

    // First caller blocks for 200ms.
    mockExecFile.mockImplementationOnce((_cmd, _args, _opts, cb) => {
      setTimeout(() => cb(null, "", ""), 200);
    });
    const first = addLabelsToEpic("foo-abc", ["holder"]);

    // Let the first caller register its chain.
    await Promise.resolve();

    // Second caller with a 50ms timeout should reject LockTimeoutError.
    await expect(addLabelsToEpic("foo-abc", ["waiter"])).rejects.toBeInstanceOf(
      LockTimeoutError,
    );

    // We emitted exactly one warn line about the timeout.
    const timeoutWarns = warnSpy.mock.calls.filter((c) =>
      String(c[0]).includes("timed out waiting for epic:foo-abc"),
    );
    expect(timeoutWarns.length).toBeGreaterThanOrEqual(1);

    // After the holder releases, a fresh caller should proceed normally.
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => cb(null, "", ""));
    await first;

    await expect(addLabelsToEpic("foo-abc", ["later"])).resolves.toBeUndefined();

    warnSpy.mockRestore();
  });

  it("non-timeout errors from the wrapped body do NOT emit a timeout warn line", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    // A strict-remove that fails with a non-benign error rethrows but
    // that's not a lock-timeout -- we must not log the timeout-warn
    // message for it.
    mockExecFile.mockImplementationOnce((_cmd, _args, _opts, cb) =>
      cb(new Error("bd: connection refused"), "", ""),
    );
    await expect(
      removeLabelsFromEpicStrict("foo-abc", ["x"]),
    ).rejects.toThrow(/connection refused/);

    const timeoutWarns = warnSpy.mock.calls.filter((c) =>
      String(c[0]).includes("timed out waiting for"),
    );
    expect(timeoutWarns.length).toBe(0);

    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Nesting detector — re-entrant call on the same key would deadlock
// ---------------------------------------------------------------------------

describe("nesting detector — re-entrant call on same epic deadlocks", () => {
  it("a nested addLabelsToEpic on the SAME epic cannot complete while the outer body holds the lock (proves non-reentrant ADR-002 invariant)", async () => {
    __setEpicLabelLockTimeoutMsForTests(60);

    // The outer caller's first bd invocation will, instead of resolving,
    // kick off a NESTED addLabelsToEpic on the same epic. The nested
    // call queues behind the outer's (already-acquired) lock. With a
    // 60 ms timeout, the nested call rejects with LockTimeoutError,
    // proving that the LockManager does NOT grant the same key twice
    // (the "no nested locking" architecture rule).
    let firstCall = true;
    let nestedError: unknown = undefined;
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
      if (firstCall) {
        firstCall = false;
        // Kick off the nested call and let it race against the timeout.
        // Use `process.nextTick` so the nested call queues on the Lock-
        // Manager AFTER the outer's chain entry is the tail.
        process.nextTick(async () => {
          try {
            await addLabelsToEpic("foo-abc", ["nested"]);
          } catch (e) {
            nestedError = e;
          }
        });
        // Hold the outer body for longer than the nested-call timeout so
        // the nested call must time out before the outer releases.
        setTimeout(() => cb(null, "", ""), 120);
        return;
      }
      cb(null, "", "");
    });

    await addLabelsToEpic("foo-abc", ["outer"]);

    // Drain microtasks so the nested call's catch has a chance to fire.
    await delay(20);

    // The nested call saw a LockTimeoutError — proving the outer's lock
    // blocked it. That is the deadlock condition the architecture warns
    // about; our test setup detects it by using a short timeout so the
    // test can assert the nesting was blocked instead of the process
    // hanging forever.
    expect(nestedError).toBeInstanceOf(LockTimeoutError);
  });
});

// ---------------------------------------------------------------------------
// Backwards compatibility — every existing public export is still callable
// with the same signature, documented for future maintainers who add new
// lock-wrapping code here.
// ---------------------------------------------------------------------------

describe("public-surface stability", () => {
  it("addLabelsToEpic, removeLabelsFromEpic, removeLabelsFromEpicStrict all accept (id, labels, epicRepoPath?)", async () => {
    instrumentExecFile([]);
    await expect(
      addLabelsToEpic("foo-abc", ["x"], "/tmp/fake-repo"),
    ).resolves.toBeUndefined();
    await expect(
      removeLabelsFromEpic("foo-abc", ["x"], "/tmp/fake-repo"),
    ).resolves.toBeUndefined();
    await expect(
      removeLabelsFromEpicStrict("foo-abc", ["x"], "/tmp/fake-repo"),
    ).resolves.toBeUndefined();
  });
});
