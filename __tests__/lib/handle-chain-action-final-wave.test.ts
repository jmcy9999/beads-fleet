// =============================================================================
// Tests for handleChainAction — final wave must fire review-wave
// (factory-core-z9h.14)
// =============================================================================
//
// QA caught handleChainAction skipping the review-wave dispatch for the
// final wave of an epic. The pre-fix guard read:
//
//     if (waveStatus.hasWaves && !waveStatus.allWavesComplete) { ...review-wave... }
//     // fall-through
//     send-for-qa
//
// When the FINAL wave's last bead closed, getWaveStatus returned
// hasWaves=true, currentWaveComplete=true, AND allWavesComplete=true. The
// outer condition evaluated FALSE (allWavesComplete=true inverts) so
// review-wave was never reached; the code fell through to send-for-qa,
// bypassing the build-review gate for the last wave.
//
// The fix (z9h.14) changes the guard to `if (waveStatus.hasWaves)` so that
// any wave-labelled epic fires review-wave when the current wave completes —
// final wave included. The build-review handler (no next wave → QA at
// line 1440) handles the send-for-qa transition AFTER the reviewer passes.
//
// Regression patterns covered:
//   #7  Type Confusion on Enum Branching — the three wave-completion states
//       (mid-wave open, wave-complete-unreviewed, epic-fully-reviewed) must
//       map to three distinct branches; the legacy code collapsed
//       (wave-complete-unreviewed) for the FINAL wave into
//       (epic-fully-reviewed) and skipped the review gate.
// =============================================================================

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test.
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

// Stub out bd-path so execBdSync doesn't actually try to locate a bd binary.
jest.mock("@/lib/bd-path", () => ({
  getBdPath: () => "/usr/local/bin/bd",
  getBdEnv: () => ({ PATH: "/usr/local/bin" }),
}));

// Stub out langfuse-env (pulled in by agent-launcher module load).
jest.mock("@/lib/langfuse-env", () => ({
  buildOtelEnv: () => ({}),
  buildLangfuseTraceUrl: () => null,
  isLangfuseConfigured: () => false,
}));

import {
  handleChainAction,
  clearWaveReviewGuard,
  type AgentSession,
} from "@/lib/agent-launcher";

// ---------------------------------------------------------------------------
// Fetch capture — handleChainAction dispatches via fetch to the fleet action
// route. We capture the URL + body so tests can assert which action was fired.
// ---------------------------------------------------------------------------

type FetchCall = { url: string; body: Record<string, unknown> };
let fetchCalls: FetchCall[] = [];
let fetchResponseOk = true;

beforeEach(() => {
  fetchCalls = [];
  fetchResponseOk = true;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = jest.fn(async (url: string, init?: RequestInit) => {
    const body =
      init && init.body
        ? (JSON.parse(init.body as string) as Record<string, unknown>)
        : {};
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
// Fixtures that drive getWaveStatus.
// ---------------------------------------------------------------------------

const INTERNAL_EPIC_SHOW = `
◐ test-epic · Epic [● P1 · IN_PROGRESS]
LABELS: ship-type:internal, release:1.0
`;

/** One wave, one child, closed = final wave just completed (single-wave epic). */
const SINGLE_WAVE_TREE = `
◐ test-epic ● P1 [epic] Epic
└── ✓ test-epic.1 ● P1 task Closed child
`;
const SINGLE_WAVE_CHILD_CLOSED = `
✓ test-epic.1 · [CLOSED]
LABELS: wave:1, ship-type:internal
`;

/**
 * Three-wave epic, all children closed — the FINAL-wave scenario from the
 * bug description. Wave 3's single bead was the last to close.
 */
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

/** Mid-wave scenario: wave 1 complete, wave 2 still open. */
const TWO_WAVE_MID_TREE = `
◐ test-epic ● P1 [epic] Epic
├── ✓ test-epic.a ● P1 task Closed child (wave 1)
└── ○ test-epic.b ● P1 task Open child (wave 2)
`;
const TWO_WAVE_B_OPEN = `
○ test-epic.b · [OPEN]
LABELS: wave:2, ship-type:internal
`;

/** No wave labels at all — legacy epic, should chain directly to QA. */
const NO_WAVE_TREE = `
◐ test-epic ● P1 [epic] Epic
└── ✓ test-epic.1 ● P1 task Closed child
`;
const NO_WAVE_CHILD_CLOSED = `
✓ test-epic.1 · [CLOSED]
LABELS: ship-type:internal
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("handleChainAction development → review-wave (factory-core-z9h.14)", () => {
  // Each test uses a unique epicId to avoid leaking the module-level
  // firedWaveReviews Set across tests.
  let counter = 0;
  const nextEpic = () => `test-epic-z9h-14-${++counter}`;

  it("fires review-wave when the FINAL wave completes (allWavesComplete=true) — the regression", async () => {
    // This is the canonical z9h.14 reproduction: a 3-wave epic whose last
    // bead just closed. getWaveStatus returns hasWaves=true,
    // currentWaveComplete=true, allWavesComplete=true. Pre-fix the code
    // fell through to send-for-qa, skipping the build-review gate entirely.
    // Post-fix it must fire review-wave for wave 3.
    const epicId = nextEpic();
    clearWaveReviewGuard(epicId);

    execBehaviour = (args) => {
      if (args[0] === "show") {
        if (args[1] === epicId) return { stdout: INTERNAL_EPIC_SHOW };
        if (args[1] === "test-epic.a") return { stdout: THREE_WAVE_A_CLOSED };
        if (args[1] === "test-epic.b") return { stdout: THREE_WAVE_B_CLOSED };
        if (args[1] === "test-epic.c") return { stdout: THREE_WAVE_C_CLOSED };
      }
      if (args[0] === "list") return { stdout: THREE_WAVE_TREE };
      return { stdout: "" };
    };

    const session = makeSession({ epicId });
    const handled = await handleChainAction(session, 0);

    expect(handled).toBe(true);
    // Exactly one fetch, targeting review-wave for the FINAL wave (wave 3).
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toContain("/api/fleet/action");
    expect(fetchCalls[0].body.action).toBe("review-wave");
    expect(fetchCalls[0].body.waveNumber).toBe(3);
    // The bug: pre-fix, the URL was send-for-qa. Verify we did NOT fire it.
    const qaFires = fetchCalls.filter((c) => c.body.action === "send-for-qa");
    expect(qaFires).toHaveLength(0);
  });

  it("fires review-wave for a SINGLE-wave epic when its only bead closes", async () => {
    // Degenerate case: epic with exactly one wave. getWaveStatus returns
    // hasWaves=true, currentWaveComplete=true, allWavesComplete=true — same
    // shape as the final-wave bug. Without the z9h.14 fix, this epic also
    // bypassed review-wave.
    const epicId = nextEpic();
    clearWaveReviewGuard(epicId);

    execBehaviour = (args) => {
      if (args[0] === "show") {
        if (args[1] === epicId) return { stdout: INTERNAL_EPIC_SHOW };
        if (args[1] === "test-epic.1") return { stdout: SINGLE_WAVE_CHILD_CLOSED };
      }
      if (args[0] === "list") return { stdout: SINGLE_WAVE_TREE };
      return { stdout: "" };
    };

    const session = makeSession({ epicId });
    const handled = await handleChainAction(session, 0);

    expect(handled).toBe(true);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].body.action).toBe("review-wave");
    expect(fetchCalls[0].body.waveNumber).toBe(1);
  });

  it("refires start-wave (not review-wave) when the current wave still has open beads — the z9h.6 tail-bead path is preserved", async () => {
    // Sanity check: the fix must not break the pre-existing "wave in
    // progress" behaviour. Scenario: wave 1 all closed, wave 2 still has
    // open beads. getWaveStatus returns currentWave=2 (lowest wave with
    // unclosed beads) and currentWaveComplete=false. With a per-bead
    // session (session.beadId set), handleChainAction refires start-wave
    // so the orchestrator picks up newly-unblocked tail beads. Review-wave
    // must NOT fire here.
    const epicId = nextEpic();
    clearWaveReviewGuard(epicId);

    execBehaviour = (args) => {
      if (args[0] === "show") {
        if (args[1] === epicId) return { stdout: INTERNAL_EPIC_SHOW };
        if (args[1] === "test-epic.a") return { stdout: THREE_WAVE_A_CLOSED };
        if (args[1] === "test-epic.b") return { stdout: TWO_WAVE_B_OPEN };
      }
      if (args[0] === "list") return { stdout: TWO_WAVE_MID_TREE };
      return { stdout: "" };
    };

    // session.beadId set → the "refire start-wave" branch should take.
    const session = makeSession({ epicId, beadId: "test-epic.a" });
    const handled = await handleChainAction(session, 0);

    expect(handled).toBe(true);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].body.action).toBe("start-wave");
    expect(fetchCalls[0].body.waveNumber).toBe(2);
    // Crucial: review-wave must NOT fire on this path — only when the
    // current wave is actually complete.
    const reviewFires = fetchCalls.filter((c) => c.body.action === "review-wave");
    expect(reviewFires).toHaveLength(0);
  });

  it("falls through to send-for-qa ONLY when the epic has no wave labels (legacy / pre-z9h)", async () => {
    // The send-for-qa direct path from development must still work for
    // legacy epics whose children carry no wave:N labels. hasWaves=false
    // → fall-through → send-for-qa.
    const epicId = nextEpic();
    clearWaveReviewGuard(epicId);

    execBehaviour = (args) => {
      if (args[0] === "show") {
        if (args[1] === epicId) return { stdout: INTERNAL_EPIC_SHOW };
        if (args[1] === "test-epic.1") return { stdout: NO_WAVE_CHILD_CLOSED };
      }
      if (args[0] === "list") return { stdout: NO_WAVE_TREE };
      return { stdout: "" };
    };

    const session = makeSession({ epicId });
    const handled = await handleChainAction(session, 0);

    expect(handled).toBe(true);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].body.action).toBe("send-for-qa");
    const reviewFires = fetchCalls.filter((c) => c.body.action === "review-wave");
    expect(reviewFires).toHaveLength(0);
  });

  it("does not double-fire review-wave on a second exit for the same (epic, wave)", async () => {
    // Cross-check with z9h.6: the review-guard must still prevent a second
    // dispatch. Fire once, then invoke handleChainAction a second time —
    // the guard should short-circuit and no additional fetch is made.
    const epicId = nextEpic();
    clearWaveReviewGuard(epicId);

    execBehaviour = (args) => {
      if (args[0] === "show") {
        if (args[1] === epicId) return { stdout: INTERNAL_EPIC_SHOW };
        if (args[1] === "test-epic.a") return { stdout: THREE_WAVE_A_CLOSED };
        if (args[1] === "test-epic.b") return { stdout: THREE_WAVE_B_CLOSED };
        if (args[1] === "test-epic.c") return { stdout: THREE_WAVE_C_CLOSED };
      }
      if (args[0] === "list") return { stdout: THREE_WAVE_TREE };
      return { stdout: "" };
    };

    const session = makeSession({ epicId });
    const first = await handleChainAction(session, 0);
    const second = await handleChainAction(session, 0);

    expect(first).toBe(true);
    expect(second).toBe(true);
    // Exactly one dispatch across both calls thanks to the idempotency
    // guard (z9h.6). The second call sees shouldFireWaveReview=false and
    // returns without calling fetch.
    const reviewFires = fetchCalls.filter((c) => c.body.action === "review-wave");
    expect(reviewFires).toHaveLength(1);
  });

  it("skips chaining when exit code is non-zero (no wave review dispatch on agent failure)", async () => {
    // Defence: agents that exit non-zero should NOT trigger the chain.
    // handleChainAction returns false early and makes no fetch.
    const epicId = nextEpic();
    clearWaveReviewGuard(epicId);

    const session = makeSession({ epicId });
    const handled = await handleChainAction(session, 1);

    expect(handled).toBe(false);
    expect(fetchCalls).toHaveLength(0);
  });
});
