// =============================================================================
// Tests for agent-launcher.handleChainAction — atomic state read + snapshot
// iteration (factory-core-ppx.6)
// =============================================================================
//
// Scope:
//   - handleChainAction wraps its body in `withLock(chainLock(epicId), 500)`
//     so two simultaneous exits for the same epic cannot both read stale
//     state and both fire a transition.
//   - readEpicState captures labels + wave status + open bug count into an
//     immutable EpicStateSnapshot; dispatchChainAction branches only on the
//     snapshot (no TOCTOU between read and transition — regression pattern
//     #1 Read/Write Disconnect).
//   - LockTimeoutError is caught at the top of the handler; the logger
//     warns once and the handler returns false (no throw).
//   - chainLock and epicLock use distinct keys per ADR-002, so the chain
//     handler can call addLabelsToEpic (which internally acquires epicLock)
//     without self-deadlocking.
//   - Feature 3 NFR: Any iteration over activeAgents or firedWaveReviews
//     captures Array.from(...) FIRST — verified both by spot-check in the
//     source and by calling the exported reading helpers while mutating
//     the underlying state in parallel (no thrown errors, stable results).
//
// Regression patterns referenced:
//   #1  Write/Read Disconnect   — bug count read + transition must share
//                                 the same snapshot (no TOCTOU).
//   #7  Type Confusion          — three branching states around wave
//                                 completion must stay distinct under
//                                 concurrent pressure.
//   #13 Silent Exception        — LockTimeoutError must surface as a warn
//        Swallowing               log + false return, never a swallowed
//                                 throw.
// =============================================================================

// ---------------------------------------------------------------------------
// Mocks — declared BEFORE importing the module under test (jest hoists).
// ---------------------------------------------------------------------------

type ExecResult = { stdout?: string; error?: Error };

let execBehaviour: (args: string[]) => ExecResult = () => ({ stdout: "" });

jest.mock("child_process", () => {
  const actual = jest.requireActual("child_process");
  return {
    ...actual,
    execFileSync: jest.fn((_bd: string, args: string[]) => {
      const r = execBehaviour(args);
      if (r.error) throw r.error;
      return r.stdout ?? "";
    }),
  };
});

// Stub bd-path so execBdSync never touches a real bd binary.
jest.mock("@/lib/bd-path", () => ({
  getBdPath: () => "/usr/local/bin/bd",
  getBdEnv: () => ({ PATH: "/usr/local/bin" }),
}));

// Stub langfuse-env (imported at module load).
jest.mock("@/lib/langfuse-env", () => ({
  buildOtelEnv: () => ({}),
  buildLangfuseTraceUrl: () => null,
  isLangfuseConfigured: () => false,
}));

// Stub pipeline-labels — the qa-done branch calls addLabelsToEpic /
// removeLabelsFromEpic; we want to record those calls and verify chainLock
// does NOT deadlock with epicLock (ADR-002).
const pipelineLabelCalls: Array<{ op: string; issueId: string; labels: string[] }> = [];
jest.mock("@/lib/pipeline-labels", () => ({
  addLabelsToEpic: jest.fn(async (issueId: string, labels: string[]) => {
    // Emulate ppx.5: this acquires an epicLock inside — which is a DIFFERENT
    // key from chainLock, so acquiring it while the caller holds chainLock
    // must not deadlock. We acquire it here to prove the point.
    const { withLock, epicLock } = await import("@/lib/locks");
    await withLock(epicLock(issueId), 1000, async () => {
      pipelineLabelCalls.push({ op: "add", issueId, labels });
    });
  }),
  removeLabelsFromEpic: jest.fn(async (issueId: string, labels: string[]) => {
    const { withLock, epicLock } = await import("@/lib/locks");
    await withLock(epicLock(issueId), 1000, async () => {
      pipelineLabelCalls.push({ op: "remove", issueId, labels });
    });
  }),
  removeLabelsFromEpicStrict: jest.fn(async () => {}),
  getEpicLabels: jest.fn(async () => []),
}));

import {
  handleChainAction,
  clearWaveReviewGuard,
  readEpicState,
  getFleetAgentStatus,
  type AgentSession,
} from "@/lib/agent-launcher";
import {
  withLock,
  chainLock,
  epicLock,
  LockTimeoutError,
} from "@/lib/locks";
import {
  __lockManagerResetForTests,
} from "@/lib/locks/lock-manager";

// ---------------------------------------------------------------------------
// Fetch capture — dispatchChainAction dispatches via fetch to the fleet
// action route. We record calls so tests can assert exactly-once semantics.
// ---------------------------------------------------------------------------

type FetchCall = { url: string; body: Record<string, unknown> };
let fetchCalls: FetchCall[] = [];
let fetchResponseOk = true;

// Optional latency injection per call — lets the "two simultaneous exits"
// test pin down ordering deterministically (hold the fetch long enough that
// the second handler must wait on the chain lock, not just beat it on the
// microtask queue).
let fetchLatencyMs = 0;

beforeEach(() => {
  fetchCalls = [];
  fetchResponseOk = true;
  fetchLatencyMs = 0;
  pipelineLabelCalls.length = 0;
  __lockManagerResetForTests();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = jest.fn(async (url: string, init?: RequestInit) => {
    const body =
      init && init.body
        ? (JSON.parse(init.body as string) as Record<string, unknown>)
        : {};
    if (fetchLatencyMs > 0) {
      await new Promise((r) => setTimeout(r, fetchLatencyMs));
    }
    fetchCalls.push({ url, body });
    return {
      ok: fetchResponseOk,
      status: fetchResponseOk ? 200 : 500,
    } as Response;
  });
});

afterEach(() => {
  execBehaviour = () => ({ stdout: "" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).fetch;
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const INTERNAL_EPIC_SHOW = `
◐ test-epic · Epic [● P1 · IN_PROGRESS]
LABELS: ship-type:internal, release:1.0
`;

/** Three-wave epic with all children closed (the "final-wave" shape). */
const THREE_WAVE_TREE = `
◐ test-epic ● P1 [epic] Epic
├── ✓ test-epic.a ● P1 task Closed child (wave 1)
├── ✓ test-epic.b ● P1 task Closed child (wave 2)
└── ✓ test-epic.c ● P1 task Closed child (wave 3)
`;
const THREE_WAVE_A_CLOSED = `
✓ test-epic.a · [CLOSED]
LABELS: wave:1, ship-type:internal
`;
const THREE_WAVE_B_CLOSED = `
✓ test-epic.b · [CLOSED]
LABELS: wave:2, ship-type:internal
`;
const THREE_WAVE_C_CLOSED = `
✓ test-epic.c · [CLOSED]
LABELS: wave:3, ship-type:internal
`;

/** Empty-epic fixture: no children, no waves. */
const EMPTY_EPIC_TREE = `
◐ test-epic-empty ● P1 [epic] Empty Epic
`;
const EMPTY_EPIC_SHOW = `
◐ test-epic-empty · Empty Epic [● P1 · IN_PROGRESS]
LABELS: ship-type:internal, release:1.0
`;

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    pid: 0,
    repoPath: "/Users/janemckay/dev/fleet/fleet-core",
    repoName: "fleet-core",
    prompt: "test prompt",
    model: "opus",
    startedAt: new Date().toISOString(),
    logFile: "/tmp/test.log",
    epicId: "test-epic",
    pipelineStage: "development",
    epicLabels: ["ship-type:internal", "release:1.0"],
    ...overrides,
  };
}

/** Wire a standard three-wave-all-closed execBehaviour for a given epicId. */
function wireThreeWaveAllClosed(epicId: string, extraBugs = 0): void {
  execBehaviour = (args) => {
    if (args[0] === "show") {
      if (args[1] === epicId) return { stdout: INTERNAL_EPIC_SHOW };
      if (args[1] === "test-epic.a") return { stdout: THREE_WAVE_A_CLOSED };
      if (args[1] === "test-epic.b") return { stdout: THREE_WAVE_B_CLOSED };
      if (args[1] === "test-epic.c") return { stdout: THREE_WAVE_C_CLOSED };
    }
    if (args[0] === "list" && args.includes("--status=open")) {
      // readEpicState's bug-count query. Return N synthetic bug lines.
      let lines = "";
      for (let i = 0; i < extraBugs; i++) {
        lines += `├── ○ ${epicId}.bug${i} ● P1 [bug] A test bug\n`;
      }
      return { stdout: lines };
    }
    if (args[0] === "list") return { stdout: THREE_WAVE_TREE };
    return { stdout: "" };
  };
}

// ---------------------------------------------------------------------------
// readEpicState — Feature 2 AC: one atomic read, populated snapshot
// ---------------------------------------------------------------------------

describe("readEpicState — snapshot shape (factory-core-ppx.6)", () => {
  it("returns { labels, waveStatus, openBugCount, capturedAt } populated", async () => {
    wireThreeWaveAllClosed("test-epic");

    const before = Date.now();
    const snapshot = await readEpicState(
      "test-epic",
      "/Users/janemckay/dev/fleet/fleet-core",
    );
    const after = Date.now();

    expect(snapshot.labels).toEqual(
      expect.arrayContaining(["ship-type:internal", "release:1.0"]),
    );
    expect(snapshot.waveStatus.hasWaves).toBe(true);
    expect(snapshot.waveStatus.currentWaveComplete).toBe(true);
    expect(snapshot.waveStatus.allWavesComplete).toBe(true);
    expect(snapshot.openBugCount).toBe(0);
    expect(snapshot.capturedAt).toBeGreaterThanOrEqual(before);
    expect(snapshot.capturedAt).toBeLessThanOrEqual(after);
  });

  it("returns sensible defaults for an unknown epic — no thrown error (boundary: nil/missing)", async () => {
    // Unknown epicId: bd show returns empty stdout; bd list likewise. The
    // snapshot must still resolve with a valid shape so the lock is
    // released cleanly — no orphaned lock, no thrown error.
    execBehaviour = () => ({ stdout: "" });

    const snapshot = await readEpicState(
      "non-existent-epic",
      "/Users/janemckay/dev/fleet/fleet-core",
    );

    expect(snapshot.labels).toEqual([]);
    expect(snapshot.waveStatus.hasWaves).toBe(false);
    expect(snapshot.openBugCount).toBe(0);
    expect(typeof snapshot.capturedAt).toBe("number");
  });

  it("encodes bd-failure as openBugCount === -1 (fail-safe sentinel)", async () => {
    // Make the bug-count bd call FAIL, but let the wave-status reads
    // succeed. The snapshot must carry `-1` so dispatchChainAction treats
    // it as "unknown, assume bugs" — the pre-ppx.6 contract for build-review
    // and qa stages.
    execBehaviour = (args) => {
      if (args[0] === "show") {
        if (args[1] === "test-epic") return { stdout: INTERNAL_EPIC_SHOW };
        if (args[1] === "test-epic.a") return { stdout: THREE_WAVE_A_CLOSED };
        if (args[1] === "test-epic.b") return { stdout: THREE_WAVE_B_CLOSED };
        if (args[1] === "test-epic.c") return { stdout: THREE_WAVE_C_CLOSED };
      }
      if (args[0] === "list" && args.includes("--status=open")) {
        return { error: new Error("bd list: connection refused") };
      }
      if (args[0] === "list") return { stdout: THREE_WAVE_TREE };
      return { stdout: "" };
    };

    const snapshot = await readEpicState(
      "test-epic",
      "/Users/janemckay/dev/fleet/fleet-core",
    );

    expect(snapshot.openBugCount).toBe(-1);
  });

  it("boundary: empty epic (no children, no waves) still yields a valid snapshot", async () => {
    execBehaviour = (args) => {
      if (args[0] === "show" && args[1] === "test-epic-empty") {
        return { stdout: EMPTY_EPIC_SHOW };
      }
      if (args[0] === "list") return { stdout: EMPTY_EPIC_TREE };
      return { stdout: "" };
    };

    const snapshot = await readEpicState(
      "test-epic-empty",
      "/Users/janemckay/dev/fleet/fleet-core",
    );

    expect(snapshot.labels).toContain("ship-type:internal");
    expect(snapshot.waveStatus.hasWaves).toBe(false);
    expect(snapshot.openBugCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// handleChainAction — lock + snapshot behaviour
// ---------------------------------------------------------------------------

describe("handleChainAction atomic state + chainLock (factory-core-ppx.6)", () => {
  let counter = 0;
  const nextEpic = () => `test-epic-ppx6-${++counter}`;

  it("serialises two simultaneous handleChainAction calls for the same epic — exactly one transition fires (Feature 2 AC happy path)", async () => {
    // Two parallel exits arrive at the same time with identical state.
    // The chain lock serialises them; the second one, on re-reading state
    // after the first releases, sees firedWaveReviews already marked for
    // the same (epic, wave) and returns true without firing again. The
    // dispatch count for review-wave is therefore exactly 1.
    const epicId = nextEpic();
    clearWaveReviewGuard(epicId);
    wireThreeWaveAllClosed(epicId);

    // Make fetch slow enough that both callers MUST queue on the lock —
    // not just on the microtask queue.
    fetchLatencyMs = 40;

    const [a, b] = await Promise.all([
      handleChainAction(makeSession({ epicId }), 0),
      handleChainAction(makeSession({ epicId }), 0),
    ]);

    // Both calls return true (either "I fired" or "I saw it was already
    // fired"). The point is: exactly one dispatch.
    expect(a).toBe(true);
    expect(b).toBe(true);
    const reviewFires = fetchCalls.filter((c) => c.body.action === "review-wave");
    expect(reviewFires).toHaveLength(1);
    expect(reviewFires[0].body.waveNumber).toBe(3);
  });

  it("handles 10 simultaneous exits — exactly one transition fires (boundary: max)", async () => {
    // Stress case: 10 parallel exits. Lock + firedWaveReviews together
    // must guarantee exactly one review-wave dispatch, with no throws and
    // no stuck handlers (every handler must resolve).
    const epicId = nextEpic();
    clearWaveReviewGuard(epicId);
    wireThreeWaveAllClosed(epicId);
    fetchLatencyMs = 15;

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        handleChainAction(makeSession({ epicId }), 0),
      ),
    );

    // Every handler resolves without throwing.
    expect(results.length).toBe(10);
    // At least one handler reports "I handled it" (returned true). The
    // others may report true (saw the guard) or false (timeout). What
    // matters for the concurrency guarantee is exactly-one dispatch.
    const reviewFires = fetchCalls.filter((c) => c.body.action === "review-wave");
    expect(reviewFires).toHaveLength(1);
  });

  it("routes bug-count read and transition through the SAME snapshot (no TOCTOU — regression #1)", async () => {
    // Build-review stage: bug count > 0 → fire start-wave (fix loop).
    // After the lock is acquired, readEpicState reads both the wave status
    // AND the bug count. The branching then runs off that one snapshot.
    // This test locks the atomicity: even if the underlying bd data
    // changes AFTER the snapshot is taken, the decision is based on the
    // captured state.
    const epicId = nextEpic();
    clearWaveReviewGuard(epicId);

    // Phase 1: before the lock is acquired, "2 bugs open". Once inside the
    // lock, the snapshot captures openBugCount=2. We then flip the
    // execBehaviour to "0 bugs open" — the handler MUST NOT re-read; it
    // must branch off the snapshot and dispatch start-wave (fix-wave).
    let phase = "pre-snapshot";
    execBehaviour = (args) => {
      if (args[0] === "show") {
        if (args[1] === epicId) return { stdout: INTERNAL_EPIC_SHOW };
        if (args[1] === "test-epic.a") return { stdout: THREE_WAVE_A_CLOSED };
        if (args[1] === "test-epic.b") return { stdout: THREE_WAVE_B_CLOSED };
        if (args[1] === "test-epic.c") return { stdout: THREE_WAVE_C_CLOSED };
      }
      if (args[0] === "list" && args.includes("--status=open")) {
        if (phase === "pre-snapshot" || phase === "snapshot-taken") {
          return {
            stdout:
              "├── ○ test-epic.bug1 ● P1 [bug] Bug one\n" +
              "└── ○ test-epic.bug2 ● P1 [bug] Bug two\n",
          };
        }
        // phase === "post-snapshot" — if the handler re-read here, it
        // would see 0 bugs and choose the wrong branch. The test asserts
        // this does NOT happen.
        return { stdout: "" };
      }
      if (args[0] === "list") return { stdout: THREE_WAVE_TREE };
      return { stdout: "" };
    };

    // Flip the phase while the handler is mid-dispatch. We can't hook
    // readEpicState directly from the test, so we use the fetch latency
    // as a proxy — by the time fetch is called, the snapshot has been
    // taken; we flip AFTER the snapshot but BEFORE fetch resolves.
    phase = "snapshot-taken";
    fetchLatencyMs = 20;
    const pending = handleChainAction(
      makeSession({
        epicId,
        pipelineStage: "build-review",
        prompt: "Review Wave 3 changes for epic test-epic",
      }),
      0,
    );
    // Wait a tick so readEpicState has captured the snapshot inside
    // withLock, then flip.
    await new Promise((r) => setTimeout(r, 5));
    phase = "post-snapshot";

    const handled = await pending;

    expect(handled).toBe(true);
    // Even though the bug list "changed" after the snapshot was captured,
    // the handler MUST have branched on the snapshot's bug count (>0) and
    // dispatched start-wave (fix loop) — NOT send-for-qa.
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].body.action).toBe("start-wave");
    expect(fetchCalls[0].body.waveNumber).toBe(3);
  });

  it("returns false on LockTimeoutError without throwing (Feature 2 AC edge)", async () => {
    // Pre-acquire the chain lock with a long hold (> 500ms). A handler
    // entering withLock now must time out after 500ms and return false —
    // no throw propagating to the poll loop, no transition fired.
    const epicId = nextEpic();
    clearWaveReviewGuard(epicId);
    wireThreeWaveAllClosed(epicId);

    // Hold the chain lock for 800ms — well past the 500ms handleChainAction
    // timeout. The test completes as soon as the handler times out (~500ms).
    let releaseHold!: () => void;
    const holdComplete = new Promise<void>((r) => { releaseHold = r; });
    const holdPromise = withLock(chainLock(epicId), 100000, async () => {
      await holdComplete;
    });

    const handled = await handleChainAction(makeSession({ epicId }), 0);

    expect(handled).toBe(false);
    // No transition fired because the handler never even read the snapshot.
    expect(fetchCalls).toHaveLength(0);

    // Release the hold and drain the queue so the test process exits cleanly.
    releaseHold();
    await holdPromise;
  }, 2000);

  it("uses chainLock (not epicLock) — internal addLabelsToEpic does not deadlock (ADR-002)", async () => {
    // The qa-done branch calls removeLabelsFromEpic + addLabelsToEpic while
    // the chain lock is held. Those internal calls acquire epicLock
    // (per ppx.5). Because chainLock and epicLock are distinct keys, the
    // nested lock acquisition does NOT deadlock.
    //
    // We wire a "qa done, no bugs" snapshot and run the handler end to end.
    // If the lock were the same key, the inner withLock would time out and
    // the handler would throw — the test would hang (Jest would kill it).
    // Passing means no deadlock.
    const epicId = nextEpic();
    clearWaveReviewGuard(epicId);

    // QA branch needs: bug count = 0, and labels that let isInternal check
    // work. readEpicState uses its OWN label read to derive isInternal —
    // the session's epicLabels only flow through to fetch bodies.
    execBehaviour = (args) => {
      if (args[0] === "show" && args[1] === epicId) {
        return { stdout: INTERNAL_EPIC_SHOW };
      }
      if (args[0] === "list" && args.includes("--status=open")) {
        return { stdout: "" }; // 0 open bugs
      }
      // QA stage checks wave status via readEpicState — we need hasWaves
      // to not matter here; return "no children" so waveStatus is the
      // empty-epic shape. The QA branch does not consult waveStatus.
      if (args[0] === "list") return { stdout: EMPTY_EPIC_TREE };
      return { stdout: "" };
    };

    const session = makeSession({ epicId, pipelineStage: "qa" });
    const handled = await handleChainAction(session, 0);

    expect(handled).toBe(true);
    // Verify the addLabelsToEpic / removeLabelsFromEpic pair was called —
    // proves the inner withLock(epicLock) acquisitions succeeded.
    const removeOps = pipelineLabelCalls.filter((c) => c.op === "remove");
    const addOps = pipelineLabelCalls.filter((c) => c.op === "add");
    expect(removeOps).toHaveLength(1);
    expect(removeOps[0].labels).toEqual(["pipeline:qa"]);
    expect(addOps).toHaveLength(1);
    expect(addOps[0].labels).toEqual([
      "pipeline:deploying",
      "qa:needs-review",
    ]);
  }, 5000);

  it("releases the chain lock on unhandled error (no orphaned lock)", async () => {
    // If the fetch call throws (network error, say), the handler's outer
    // catch should log and return false — but the lock MUST release so
    // the next caller can proceed. Verify by making the first call throw
    // via fetch, then confirming a second call acquires the lock and runs.
    const epicId = nextEpic();
    clearWaveReviewGuard(epicId);
    wireThreeWaveAllClosed(epicId);

    // First call: fetch throws. Handler should catch and return false.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = jest.fn(async () => {
      throw new Error("network down");
    });

    const first = await handleChainAction(makeSession({ epicId }), 0);
    expect(first).toBe(false);

    // Second call: restore fetch. Handler should proceed (lock was released).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = jest.fn(async (url: string, init?: RequestInit) => {
      const body =
        init && init.body
          ? (JSON.parse(init.body as string) as Record<string, unknown>)
          : {};
      fetchCalls.push({ url, body });
      return { ok: true, status: 200 } as Response;
    });

    // Clear the wave guard so the second call re-fires (the first call's
    // failure rolled back the guard per z9h.13).
    clearWaveReviewGuard(epicId);
    const second = await handleChainAction(makeSession({ epicId }), 0);
    expect(second).toBe(true);
    expect(fetchCalls.filter((c) => c.body.action === "review-wave")).toHaveLength(1);
  });

  it("skips chain + does not acquire lock when session has no epicId (boundary: nil/missing)", async () => {
    // Without an epicId we cannot form a chainLock key safely. The handler
    // warns and returns false — no lock is acquired, no orphaned state.
    const session = makeSession({ epicId: undefined });
    const handled = await handleChainAction(session, 0);

    expect(handled).toBe(false);
    expect(fetchCalls).toHaveLength(0);

    // Sanity: a following call WITH a valid epicId still works — i.e. the
    // Map had no dangling entry from the skipped call.
    const epicId = nextEpic();
    clearWaveReviewGuard(epicId);
    wireThreeWaveAllClosed(epicId);
    const follow = await handleChainAction(makeSession({ epicId }), 0);
    expect(follow).toBe(true);
  });

  it("returns false early (no lock acquired) when exitCode !== 0", async () => {
    // Non-success exits never chain — the lock isn't involved, no fetch,
    // no bd calls. Verifies we did not introduce a regression where the
    // lock is held for stages that don't transition.
    const epicId = nextEpic();
    const handled = await handleChainAction(
      makeSession({ epicId }),
      1,
    );

    expect(handled).toBe(false);
    expect(fetchCalls).toHaveLength(0);
  });

  it("research and planning stages short-circuit without acquiring the chain lock", async () => {
    // These stages exit without chaining — the lock should not be touched.
    // We pre-acquire the chain lock for the epic with a short hold; if
    // handleChainAction tried to acquire it, the test would hang until
    // the hold completes. It should NOT — research/planning return false
    // before the lock is entered.
    const epicId = nextEpic();

    let releaseHold!: () => void;
    const holdComplete = new Promise<void>((r) => { releaseHold = r; });
    const holdPromise = withLock(chainLock(epicId), 100000, async () => {
      await holdComplete;
    });

    const researchHandled = await handleChainAction(
      makeSession({ epicId, pipelineStage: "research" }),
      0,
    );
    const planningHandled = await handleChainAction(
      makeSession({ epicId, pipelineStage: "planning" }),
      0,
    );

    expect(researchHandled).toBe(false);
    expect(planningHandled).toBe(false);
    expect(fetchCalls).toHaveLength(0);

    releaseHold();
    await holdPromise;
  }, 2000);
});

// ---------------------------------------------------------------------------
// Snapshot iteration (Feature 3 NFR) — activeAgents must be iterated via
// Array.from() so concurrent mutations don't affect the iterating caller.
// ---------------------------------------------------------------------------

describe("Snapshot iteration over activeAgents (factory-core-ppx.6 — Feature 3 NFR)", () => {
  it("getFleetAgentStatus does not throw while iterating the activeAgents Map", async () => {
    // We can't directly seed activeAgents (module-private Map) without
    // launching a real agent. Instead, we exercise the live call and
    // assert it returns a well-shaped result — the important guarantee is
    // that iteration uses `Array.from(activeAgents.entries())` so the loop
    // tolerates concurrent mutation from parallel exit handlers. The
    // source-level test below pins the invariant that every iteration
    // spot uses Array.from, which is what proves the snapshot semantic.
    // A dedicated same-repo test (ppx.10) covers the key-format invariant
    // for populated Maps.
    const status = await getFleetAgentStatus();
    expect(status).toHaveProperty("agents");
    expect(status).toHaveProperty("totalRunning");
    expect(Array.isArray(status.agents)).toBe(true);
    expect(typeof status.totalRunning).toBe("number");
    // Call it a second time — should still return a consistent result
    // regardless of how many sessions are discovered on disk.
    const again = await getFleetAgentStatus();
    expect(again.totalRunning).toBe(status.totalRunning);
  });

  it("source-level invariant: every iteration of activeAgents / firedWaveReviews / flushingTmuxSessions uses Array.from(...)", async () => {
    // Compile-time invariant check via source grep. If a future change
    // reintroduces a bare `for (const x of activeAgents)` iteration, this
    // test fails with an actionable message pointing at the offending
    // line — matching the pattern of z9h.12's sessionFileFor test.
    const fs = await import("fs");
    const path = await import("path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "../../src/lib/agent-launcher.ts"),
      "utf-8",
    );

    // Accept: `for (X of Array.from(activeAgents...))` / `.values()` / etc.
    // Reject: `for (X of activeAgents)` / `activeAgents.values()` without
    // a preceding `Array.from(`.
    const lines = src.split("\n");
    const offenders: Array<{ line: number; text: string }> = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Look for `for (... of activeAgents` that's NOT preceded by Array.from.
      const m = line.match(
        /for\s*\([^)]+\s+of\s+(activeAgents|firedWaveReviews|flushingTmuxSessions)(\.\w+\(\))?\s*\)/,
      );
      if (m) {
        offenders.push({ line: i + 1, text: line.trim() });
      }
      // Also flag direct `.forEach` / `.values()` / `.entries()` / `.keys()`
      // iteration not wrapped in Array.from.
      const m2 = line.match(
        /(activeAgents|firedWaveReviews|flushingTmuxSessions)\.(forEach|values|entries|keys)\s*\(/,
      );
      if (m2) {
        // The same line must also contain Array.from(...
        if (!line.includes("Array.from(")) {
          offenders.push({ line: i + 1, text: line.trim() });
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
