// =============================================================================
// Tests for handleChainAction four new auto-chain branches
// (factory-core-3yqr.4 — F2/F3/F4/F5/F6 and ADR-005/-006/-007/-008/-009)
// =============================================================================
//
// Scope:
//   - research stage:      autoChainEnabled("research") + POST run-pm
//   - product-spec stage:  autoChainEnabled("product-spec") + POST run-architect
//   - architecture stage:  autoChainEnabled("architecture") + POST generate-plan
//   - test-spec stage:     autoChainEnabled("test-spec") + POST start-wave
//                           with {waveNumber: 1}
//
// Modes (asserted per branch):
//   - Happy path           flag ON, no checkpoint, no venture, 200 →
//                          returns true, fetch fired, audit notes line emitted.
//   - Flag off             autoChainEnabled returns false → returns false,
//                          no fetch, no execBdSync notes.
//   - Checkpoint set       checkpoint:after-<stage> → returns false, no dispatch.
//   - Typo'd checkpoint    checkpoint:after-pm → chain proceeds AND a notes line
//                          flags the unrecognised label (ADR-008).
//   - Venture rejection    ship-type:venture → returns false, no dispatch
//                          (ADR-007 defense-in-depth).
//   - Dispatch 5xx         returns false, fail-closed, NO audit notes.
//   - Thrown fetch         returns false, same as 5xx.
//   - Audit-line failure   dispatch 2xx, execBdSync throws on the audit
//                          append → returns true anyway (ADR-009).
//   - Concurrent exits     two near-simultaneous handleChainAction calls for
//                          the same (epic, stage) → chainLock serialises and
//                          the second times out with return=false.
//
// Regression patterns referenced:
//   #7  Type Confusion    — the four branches are distinct; each targets
//                           its own action. A typo'd checkpoint suffix is a
//                           third state (ignore + log) between
//                           "recognised pause" and "absent".
//   #13 Silent Swallowing — every failure path logs AND returns false; the
//                           audit notes failure on success still logs but
//                           does not flip the return value.
// =============================================================================

// ---------------------------------------------------------------------------
// Mocks — declared BEFORE importing the module under test (jest hoists).
// ---------------------------------------------------------------------------

type ExecResult = { stdout?: string; error?: Error };

// Default execBehaviour returns empty output; individual tests override for
// scenarios that need specific bd show / bd list responses.
let execBehaviour: (args: string[]) => ExecResult = () => ({ stdout: "" });

// Tracks every execFileSync call so tests can inspect the exact args passed
// (notes append lines are the primary audit target — ADR-009).
type ExecCall = { args: string[] };
let execCalls: ExecCall[] = [];

jest.mock("child_process", () => {
  const actual = jest.requireActual("child_process");
  return {
    ...actual,
    execFileSync: jest.fn((_bd: string, args: string[]) => {
      execCalls.push({ args });
      const r = execBehaviour(args);
      if (r.error) throw r.error;
      return r.stdout ?? "";
    }),
  };
});

// Stub bd-path so execBdSync never hits a real binary.
jest.mock("@/lib/bd-path", () => ({
  getBdPath: () => "/usr/local/bin/bd",
  getBdEnv: () => ({ PATH: "/usr/local/bin" }),
}));

// Stub langfuse-env (loaded by agent-launcher module init).
jest.mock("@/lib/langfuse-env", () => ({
  buildOtelEnv: () => ({}),
  buildLangfuseTraceUrl: () => null,
  isLangfuseConfigured: () => false,
}));

// Feature flag — controlled per-test via setStageFlag(). We wire
// autoChainEnabled to a map so we can toggle each of the four stages
// independently and verify the helper routes the right flag to the right
// branch (guarding against any future copy-paste regression of the flag
// name inside chainToNextStage).
const stageFlags: Record<string, boolean> = {
  research: false,
  "product-spec": false,
  architecture: false,
  "test-spec": false,
};
const AUTO_CHAIN_STAGES_FIXTURE = [
  "research",
  "product-spec",
  "architecture",
  "test-spec",
] as const;

jest.mock("@/lib/fleet-config", () => ({
  // k7gy planning branch calls readFleetConfig — keep its shape stable.
  readFleetConfig: jest.fn(() => ({
    plan_review_auto_chain: false,
    auto_chain_stages: { ...stageFlags },
  })),
  resetFleetConfigCache: jest.fn(),
  autoChainEnabled: jest.fn((stage: string) => stageFlags[stage] === true),
  AUTO_CHAIN_STAGES: AUTO_CHAIN_STAGES_FIXTURE,
  // Type-only export — no runtime value needed.
}));

function setStageFlag(stage: string, value: boolean): void {
  stageFlags[stage] = value;
}

function resetStageFlags(): void {
  for (const s of Object.keys(stageFlags)) stageFlags[s] = false;
}

// pipeline-labels: the new branches never call into label mutation (ADR-005
// — "no label mutation"). We still stub it so the module loads without
// touching real bd.
jest.mock("@/lib/pipeline-labels", () => ({
  addLabelsToEpic: jest.fn(async () => {}),
  removeLabelsFromEpic: jest.fn(async () => {}),
  removeLabelsFromEpicStrict: jest.fn(async () => {}),
  getEpicLabels: jest.fn(async () => []),
}));

// beads_web-aiq: mock smoke-test-freshness (dynamic import in QA handler).
jest.mock("@/lib/smoke-test-freshness", () => ({
  checkSmokeTestFreshness: jest.fn(async () => ({ ok: true })),
}));

// beads_web-aiq: mock wave-completeness (dynamic import in QA handler).
// Default: gate passes through (no incomplete waves).
jest.mock("@/lib/wave-completeness", () => ({
  enforceWaveCompletenessOrDispatch: jest.fn(async () => ({ intercepted: false })),
}));

// beads_web-aiq: mock pipeline-router (dynamic import in QA handler for
// ship-type-aware routing via nextStage()). Uses real implementation.
jest.mock("@/lib/pipeline-router", () => {
  // Inline the DEPLOY_TAIL and SUBMISSION_TAIL routing so the mock is
  // self-contained (no circular dependency on pipeline-routes.ts).
  const DEPLOY_TAIL_TARGETS: Record<string, string> = {
    qa: "deploying",
    deploying: "live",
    live: "kit-management",
    "kit-management": "completed",
  };
  const SUBMISSION_TAIL_TARGETS: Record<string, string> = {
    qa: "submission-prep",
    "submission-prep": "submitted",
    "kit-management": "completed",
  };
  const SHIP_TYPE_TARGETS: Record<string, Record<string, string>> = {
    internal: DEPLOY_TAIL_TARGETS,
    "web-app": DEPLOY_TAIL_TARGETS,
    "python-tool": DEPLOY_TAIL_TARGETS,
    game: DEPLOY_TAIL_TARGETS,
    "wordpress-plugin": SUBMISSION_TAIL_TARGETS,
    "ios-app": SUBMISSION_TAIL_TARGETS,
    "macos-app": SUBMISSION_TAIL_TARGETS,
  };
  return {
    nextStage: jest.fn((stage: string, shipType: string) => {
      const targets = SHIP_TYPE_TARGETS[shipType];
      if (!targets) return undefined;
      return targets[stage] ?? undefined;
    }),
    assertShipType: jest.fn(),
  };
});

import {
  handleChainAction,
  type AgentSession,
} from "@/lib/agent-launcher";
import { __lockManagerResetForTests } from "@/lib/locks/lock-manager";

// ---------------------------------------------------------------------------
// Fetch capture — dispatch goes through fetch to /api/fleet/action.
// ---------------------------------------------------------------------------

type FetchCall = { url: string; body: Record<string, unknown> };
let fetchCalls: FetchCall[] = [];
let fetchResponseOk = true;
let fetchResponseStatus = 200;
let fetchThrows = false;
let fetchLatencyMs = 0;

beforeEach(() => {
  fetchCalls = [];
  fetchResponseOk = true;
  fetchResponseStatus = 200;
  fetchThrows = false;
  fetchLatencyMs = 0;
  execCalls = [];
  execBehaviour = () => ({ stdout: "" });
  resetStageFlags();
  __lockManagerResetForTests();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = jest.fn(async (url: string, init?: RequestInit) => {
    if (fetchLatencyMs > 0) {
      await new Promise((r) => setTimeout(r, fetchLatencyMs));
    }
    if (fetchThrows) {
      throw new Error("simulated fetch failure");
    }
    const body =
      init && init.body
        ? (JSON.parse(init.body as string) as Record<string, unknown>)
        : {};
    fetchCalls.push({ url, body });
    return {
      ok: fetchResponseOk,
      status: fetchResponseStatus,
    } as Response;
  });
});

afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).fetch;
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Minimal `bd show <epic>` fixture. `LABELS:` is what readEpicState parses.
 */
function epicShowFor(labels: string): string {
  return `
◐ test-epic · Test Epic [● P1 · IN_PROGRESS]
LABELS: ${labels}
`;
}

/** No children — empty epic tree (readEpicState handles this cleanly). */
const EMPTY_EPIC_TREE = `
◐ test-epic ● P1 [epic] Empty Epic
`;

function makeSession(
  epicId: string,
  stage: string,
  overrides: Partial<AgentSession> = {},
): AgentSession {
  return {
    pid: 0,
    repoPath: "/Users/janemckay/dev/fleet/fleet-core",
    repoName: "fleet-core",
    prompt: `Run ${stage} for ${epicId}`,
    model: "sonnet",
    startedAt: new Date().toISOString(),
    logFile: "/tmp/test.log",
    epicId,
    pipelineStage: stage,
    epicLabels: ["ship-type:internal", `pipeline:${stage}`],
    ...overrides,
  };
}

/**
 * Wire an epic snapshot. Labels come from `labels`. No bugs exist (the four
 * branches don't consult openBugCount — they only read snapshot.labels).
 */
function wireEpic(epicId: string, labels: string): void {
  execBehaviour = (args) => {
    if (args[0] === "show" && args[1] === epicId) {
      return { stdout: epicShowFor(labels) };
    }
    if (args[0] === "list") {
      return { stdout: EMPTY_EPIC_TREE };
    }
    // `bd update --append-notes` calls resolve to empty stdout success.
    return { stdout: "" };
  };
}

/**
 * Stage → action dispatch table (the authoritative mapping the helper
 * implements). Tests iterate this table so every branch is covered against
 * every test mode — a regression in any one branch surfaces as a failed
 * assertion with that branch's name in the test title.
 */
const BRANCH_TABLE: Array<{
  stage: "research" | "product-spec" | "architecture" | "test-spec";
  toStage: string;
  action: string;
  extraBody?: Record<string, unknown>;
}> = [
  { stage: "research", toStage: "product-spec", action: "run-pm" },
  { stage: "product-spec", toStage: "architecture", action: "run-architect" },
  { stage: "architecture", toStage: "plan-review", action: "generate-plan" },
  {
    stage: "test-spec",
    toStage: "development",
    action: "start-wave",
    extraBody: { waveNumber: 1 },
  },
];

// ---------------------------------------------------------------------------
// Per-branch mode coverage
// ---------------------------------------------------------------------------

describe.each(BRANCH_TABLE)(
  "chainToNextStage — $stage → $toStage ($action)",
  ({ stage, toStage, action, extraBody }) => {
    let counter = 0;
    const nextEpic = () => `test-${stage}-${++counter}`;

    it("happy path: flag ON, no checkpoint, no venture → 200 + audit notes line", async () => {
      setStageFlag(stage, true);
      const epicId = nextEpic();
      wireEpic(epicId, "ship-type:internal");

      const handled = await handleChainAction(makeSession(epicId, stage), 0);

      expect(handled).toBe(true);
      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0].url).toContain("/api/fleet/action");
      expect(fetchCalls[0].body.action).toBe(action);
      expect(fetchCalls[0].body.epicId).toBe(epicId);
      expect(fetchCalls[0].body.epicTitle).toBe("fleet-core");
      // Extra body fields (only start-wave has waveNumber: 1).
      if (extraBody) {
        for (const [k, v] of Object.entries(extraBody)) {
          expect(fetchCalls[0].body[k]).toEqual(v);
        }
      }
      // Audit notes line per ADR-009. We look for a --append-notes call with
      // the arrow "<fromStage> → <toStage>" signature.
      const auditCalls = execCalls.filter(
        (c) =>
          c.args[0] === "update" &&
          c.args.includes("--append-notes") &&
          c.args.some((a) => a.includes(`${stage} → ${toStage}`)),
      );
      expect(auditCalls).toHaveLength(1);
      // The audit line must carry the epic ID and the factory-core-3yqr
      // trace prefix so `bd show` is self-describing.
      const auditLine = auditCalls[0].args[auditCalls[0].args.length - 1];
      expect(auditLine).toContain("factory-core-3yqr auto-chain:");
      expect(auditLine).toMatch(/at \d{4}-\d{2}-\d{2}T/);
    });

    it("flag OFF → returns false, no fetch, no notes", async () => {
      setStageFlag(stage, false);
      const epicId = nextEpic();
      wireEpic(epicId, "ship-type:internal");

      const handled = await handleChainAction(makeSession(epicId, stage), 0);

      expect(handled).toBe(false);
      expect(fetchCalls).toHaveLength(0);
      // No `--append-notes` calls either (guard against future regression
      // that logs an audit line even when the kill switch is off).
      const notesCalls = execCalls.filter((c) => c.args.includes("--append-notes"));
      expect(notesCalls).toHaveLength(0);
    });

    it("checkpoint:after-<stage> present → returns false, no fetch", async () => {
      setStageFlag(stage, true);
      const epicId = nextEpic();
      wireEpic(epicId, `ship-type:internal, checkpoint:after-${stage}`);

      const handled = await handleChainAction(makeSession(epicId, stage), 0);

      expect(handled).toBe(false);
      expect(fetchCalls).toHaveLength(0);
      // Also no audit line — the helper must not write notes when paused.
      const notesCalls = execCalls.filter((c) => c.args.includes("--append-notes"));
      expect(notesCalls).toHaveLength(0);
    });

    it("ship-type:venture present (ADR-007 defense-in-depth) → returns false, no fetch", async () => {
      setStageFlag(stage, true);
      const epicId = nextEpic();
      // Venture + flag on + no checkpoint. The venture check is AFTER the
      // flag check and BEFORE the checkpoint check per ADR-007.
      wireEpic(epicId, "ship-type:venture");

      const handled = await handleChainAction(makeSession(epicId, stage), 0);

      expect(handled).toBe(false);
      expect(fetchCalls).toHaveLength(0);
    });

    it("dispatch 5xx → returns false (fail-closed), NO audit line", async () => {
      setStageFlag(stage, true);
      fetchResponseOk = false;
      fetchResponseStatus = 500;
      const epicId = nextEpic();
      wireEpic(epicId, "ship-type:internal");

      const handled = await handleChainAction(makeSession(epicId, stage), 0);

      expect(handled).toBe(false);
      // Dispatch WAS attempted (exactly once — no retry per ADR-005).
      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0].body.action).toBe(action);
      // CRITICAL: no audit line on failure. An audit line on a failed
      // dispatch would be a misleading trail (pretends the chain advanced).
      const auditCalls = execCalls.filter(
        (c) =>
          c.args.includes("--append-notes") &&
          c.args.some((a) => a.includes("factory-core-3yqr auto-chain")),
      );
      expect(auditCalls).toHaveLength(0);
    });

    it("fetch throws → returns false (fail-closed), NO audit line", async () => {
      setStageFlag(stage, true);
      fetchThrows = true;
      const epicId = nextEpic();
      wireEpic(epicId, "ship-type:internal");

      const handled = await handleChainAction(makeSession(epicId, stage), 0);

      expect(handled).toBe(false);
      const auditCalls = execCalls.filter(
        (c) =>
          c.args.includes("--append-notes") &&
          c.args.some((a) => a.includes("factory-core-3yqr auto-chain")),
      );
      expect(auditCalls).toHaveLength(0);
    });

    it("audit-line write failure is tolerated (ADR-009) — still returns true", async () => {
      setStageFlag(stage, true);
      const epicId = nextEpic();
      // Inject a bd failure ONLY on the --append-notes call (not on show /
      // list). The dispatch itself succeeds; the notes append throws.
      execBehaviour = (args) => {
        if (args[0] === "show" && args[1] === epicId) {
          return { stdout: epicShowFor("ship-type:internal") };
        }
        if (args[0] === "list") return { stdout: EMPTY_EPIC_TREE };
        if (args[0] === "update" && args.includes("--append-notes")) {
          return { error: new Error("simulated bd --append-notes failure") };
        }
        return { stdout: "" };
      };

      const handled = await handleChainAction(makeSession(epicId, stage), 0);

      // ADR-009: dispatch has succeeded and the route transitioned the
      // label — the notes append is a best-effort breadcrumb. Returning
      // false here would cause the exit handler to fall through to
      // NEXT_STAGE (incorrect for these stages) / re-trigger, so we MUST
      // return true even if the notes write fails.
      expect(handled).toBe(true);
      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0].body.action).toBe(action);
    });
  },
);

// ---------------------------------------------------------------------------
// Unknown checkpoint suffix handling (ADR-008) — shared across all branches
// ---------------------------------------------------------------------------

describe("chainToNextStage — unknown checkpoint suffix handling (ADR-008)", () => {
  let counter = 0;
  const nextEpic = () => `test-unknown-ckpt-${++counter}`;

  it("checkpoint:after-pm on research branch → chain proceeds AND a note is emitted", async () => {
    // The description's worked example: an owner types `checkpoint:after-pm`
    // intending `checkpoint:after-product-spec`. ADR-008: the chain proceeds
    // (unknown suffix is ignored), BUT a note is appended flagging the
    // typo so it surfaces on `bd show` / the dashboard card.
    setStageFlag("research", true);
    const epicId = nextEpic();
    wireEpic(epicId, "ship-type:internal, checkpoint:after-pm");

    const handled = await handleChainAction(makeSession(epicId, "research"), 0);

    expect(handled).toBe(true);
    // Dispatch fires normally.
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].body.action).toBe("run-pm");

    // A note was appended flagging the unrecognised label.
    const unknownSuffixNotes = execCalls.filter(
      (c) =>
        c.args[0] === "update" &&
        c.args.includes("--append-notes") &&
        c.args.some((a) => a.includes("unrecognised checkpoint label")),
    );
    expect(unknownSuffixNotes).toHaveLength(1);
    const noteLine =
      unknownSuffixNotes[0].args[unknownSuffixNotes[0].args.length - 1];
    expect(noteLine).toContain("checkpoint:after-pm");
    expect(noteLine).toContain(epicId);
    expect(noteLine).toContain("after-research");
    expect(noteLine).toContain("after-product-spec");
    expect(noteLine).toContain("after-architecture");
    expect(noteLine).toContain("after-test-spec");

    // Separately, the SUCCESS audit line was also written (dispatch
    // succeeded per ADR-009).
    const auditNotes = execCalls.filter(
      (c) =>
        c.args.includes("--append-notes") &&
        c.args.some((a) => a.includes("factory-core-3yqr auto-chain")),
    );
    expect(auditNotes).toHaveLength(1);
  });

  it("recognised checkpoint suffix does NOT trigger unknown-suffix note", async () => {
    // Defensive: the valid suffix for this stage (checkpoint:after-research)
    // must not be flagged as unknown — it's a legitimate pause signal.
    // Also: the pause check fires first so no dispatch and no notes at all.
    setStageFlag("research", true);
    const epicId = nextEpic();
    wireEpic(epicId, "ship-type:internal, checkpoint:after-research");

    const handled = await handleChainAction(makeSession(epicId, "research"), 0);

    expect(handled).toBe(false);
    expect(fetchCalls).toHaveLength(0);
    const notesCalls = execCalls.filter((c) => c.args.includes("--append-notes"));
    expect(notesCalls).toHaveLength(0);
  });

  it("checkpoint:after-<OTHER-recognised-stage> on research branch → chain proceeds; that label is a legitimate pause for a DIFFERENT stage, not an unknown suffix", async () => {
    // Regression guard: `checkpoint:after-product-spec` on a research-stage
    // exit is NOT an unknown suffix (it IS a recognised suffix), and it is
    // NOT a pause for research (the pause check is `checkpoint:after-research`).
    // Expected: chain proceeds, no unknown-suffix note.
    setStageFlag("research", true);
    const epicId = nextEpic();
    wireEpic(epicId, "ship-type:internal, checkpoint:after-product-spec");

    const handled = await handleChainAction(makeSession(epicId, "research"), 0);

    expect(handled).toBe(true);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].body.action).toBe("run-pm");

    // The unknown-suffix note must NOT fire because after-product-spec is
    // in the supported set — it just doesn't match THIS stage's pause key.
    const unknownNotes = execCalls.filter(
      (c) =>
        c.args.includes("--append-notes") &&
        c.args.some((a) => a.includes("unrecognised checkpoint label")),
    );
    expect(unknownNotes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Cross-branch smoke tests (architectural invariants)
// ---------------------------------------------------------------------------

describe("chainToNextStage — cross-branch invariants", () => {
  let counter = 0;
  const nextEpic = () => `test-cross-${++counter}`;

  it("test-spec branch is the only one carrying waveNumber: 1 (AC)", async () => {
    // Regression guard: the extraBody parameter must only apply to the
    // branch that passes it. A future copy-paste that accidentally passed
    // waveNumber: 1 to generate-plan would silently misdispatch; assert
    // every other branch's body has NO waveNumber field at all.
    setStageFlag("research", true);
    setStageFlag("product-spec", true);
    setStageFlag("architecture", true);
    setStageFlag("test-spec", true);

    for (const { stage, action } of BRANCH_TABLE) {
      fetchCalls = [];
      execCalls = [];
      const epicId = nextEpic();
      wireEpic(epicId, "ship-type:internal");

      await handleChainAction(makeSession(epicId, stage), 0);

      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0].body.action).toBe(action);
      if (stage === "test-spec") {
        expect(fetchCalls[0].body.waveNumber).toBe(1);
      } else {
        expect(fetchCalls[0].body.waveNumber).toBeUndefined();
      }
    }
  });

  it("non-zero exit short-circuits before any chain logic (pre-3yqr invariant preserved)", async () => {
    // The top-of-handleChainAction exitCode guard must still fire for the
    // four new stages — verifies we didn't accidentally route research
    // (or any of the new stages) past it.
    setStageFlag("research", true);
    const epicId = nextEpic();
    wireEpic(epicId, "ship-type:internal");

    const handled = await handleChainAction(makeSession(epicId, "research"), 1);

    expect(handled).toBe(false);
    expect(fetchCalls).toHaveLength(0);
    expect(execCalls).toHaveLength(0);
  });

  it("session without epicId short-circuits with warn (pre-3yqr invariant preserved)", async () => {
    setStageFlag("research", true);
    const session: AgentSession = {
      pid: 0,
      repoPath: "/tmp/fake",
      repoName: "fake",
      prompt: "",
      model: "sonnet",
      startedAt: new Date().toISOString(),
      logFile: "/tmp/test.log",
      pipelineStage: "research",
      // epicId intentionally unset — handleChainAction bails before the
      // lock, never reaches dispatchChainAction.
    };

    const handled = await handleChainAction(session, 0);

    expect(handled).toBe(false);
    expect(fetchCalls).toHaveLength(0);
  });

  it("unknown stage (something other than the four new + existing) → no chain", async () => {
    // A fifth stage name we don't wire (e.g. "build-fix") must not
    // accidentally fall into any new branch. The dispatcher returns false
    // and NEXT_STAGE takes over.
    setStageFlag("research", true);
    const epicId = nextEpic();
    wireEpic(epicId, "ship-type:internal");

    const handled = await handleChainAction(makeSession(epicId, "totally-unknown-stage"), 0);

    expect(handled).toBe(false);
    expect(fetchCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Concurrency — chainLock serialises exits on the same (epic, stage)
// ---------------------------------------------------------------------------

describe("chainToNextStage — chainLock concurrency (AC: two concurrent exits → one dispatch)", () => {
  let counter = 0;
  const nextEpic = () => `test-concur-${++counter}`;

  it("two concurrent research exits for same epic → one handler wins, the other times out on the lock", async () => {
    // Simulates the ppx.6 race: two near-simultaneous exit observations
    // (final poll + session-close handler). The chainLock(epicId) wrapper
    // in handleChainAction serialises them; the second waiter hits the
    // 500ms timeout and returns false without dispatching.
    setStageFlag("research", true);
    const epicId = nextEpic();
    wireEpic(epicId, "ship-type:internal");
    // Hold the first handler's fetch long enough that the second caller
    // blows through the chainLock 500ms timeout.
    fetchLatencyMs = 700;

    const session = (): AgentSession => makeSession(epicId, "research");

    const [a, b] = await Promise.all([
      handleChainAction(session(), 0),
      handleChainAction(session(), 0),
    ]);

    // Exactly one dispatch — the second caller timed out on the lock.
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].body.action).toBe("run-pm");
    // Exactly one true and one false (order is not guaranteed).
    expect([a, b].sort()).toEqual([false, true]);
  }, 15000);
});

// =============================================================================
// beads_web-aiq: QA stage — ship-type-aware routing tests (ACs 4, 5, 6, 7)
// =============================================================================
//
// Scope:
//   - AC4: internal qa → deploying (primary fix verification)
//   - AC5: web-app, python-tool, game qa → deploying (DEPLOY_TAIL generality)
//   - AC6: wordpress-plugin qa → submission-prep (SUBMISSION_TAIL regression check)
//   - AC7: fallback path is ship-type-aware (defense-in-depth)
//
// Regression patterns referenced:
//   #7  Type Confusion  — ship type branching; each ship type gets the correct
//                         target stage per pipeline-routes.ts registry.
//   #13 Silent Swallowing — defense-in-depth: if nextStage() returns undefined,
//                          stay at qa with warning (don't crash, don't advance).
// =============================================================================

/**
 * Wire an epic for QA-stage testing. Returns appropriate bd show / bd list
 * output for readEpicState + getWaveStatus with zero bugs and no children.
 */
function wireQAEpic(epicId: string, shipType: string): void {
  const showOutput = `
○ ${epicId} · Test QA Epic [● P1 · IN_PROGRESS]
LABELS: ship-type:${shipType}, pipeline:qa
`;
  execBehaviour = (args) => {
    // bd show <epicId> — used by getWaveStatus, readEpicState, and round-check
    if (args[0] === "show" && args[1] === epicId) {
      return { stdout: showOutput.trim() };
    }
    // bd list --status=all ... — used by getWaveStatus for children
    if (args[0] === "list" && args.includes("--status=all")) {
      return { stdout: "" }; // No children → hasWaves=false
    }
    // bd list --status=open ... — used by readEpicState for bug count
    if (args[0] === "list" && args.includes("--status=open")) {
      return { stdout: "" }; // No bugs
    }
    // bd update --append-notes — audit lines
    return { stdout: "" };
  };
}

describe("handleChainAction — qa stage — ship-type-aware routing (beads_web-aiq)", () => {
  let counter = 0;
  const nextEpic = () => `test-qa-aiq-${++counter}`;

  // Import the mocked pipeline-labels so we can inspect calls.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pipelineLabels = jest.requireMock("@/lib/pipeline-labels") as {
    addLabelsToEpic: jest.Mock;
    removeLabelsFromEpic: jest.Mock;
  };

  beforeEach(() => {
    pipelineLabels.addLabelsToEpic.mockClear();
    pipelineLabels.removeLabelsFromEpic.mockClear();
  });

  // AC4: internal qa → deploying
  it("AC4: ship-type:internal advances qa → deploying (NOT submission-prep)", async () => {
    const epicId = nextEpic();
    wireQAEpic(epicId, "internal");

    const session = makeSession(epicId, "qa", {
      epicLabels: ["ship-type:internal", "pipeline:qa"],
    });
    const handled = await handleChainAction(session, 0);

    expect(handled).toBe(true);
    // pipeline:qa should be removed
    expect(pipelineLabels.removeLabelsFromEpic).toHaveBeenCalledWith(
      epicId,
      ["pipeline:qa"],
    );
    // pipeline:deploying + qa:needs-review should be added
    const addCalls = pipelineLabels.addLabelsToEpic.mock.calls;
    const allAddedLabels = addCalls.flatMap((c: [string, string[]]) => c[1]);
    expect(allAddedLabels).toContain("pipeline:deploying");
    expect(allAddedLabels).toContain("qa:needs-review");
    expect(allAddedLabels).not.toContain("pipeline:submission-prep");
  });

  // AC5: web-app qa → deploying
  it("AC5: ship-type:web-app advances qa → deploying", async () => {
    const epicId = nextEpic();
    wireQAEpic(epicId, "web-app");

    const session = makeSession(epicId, "qa", {
      epicLabels: ["ship-type:web-app", "pipeline:qa"],
    });
    const handled = await handleChainAction(session, 0);

    expect(handled).toBe(true);
    const addCalls = pipelineLabels.addLabelsToEpic.mock.calls;
    const allAddedLabels = addCalls.flatMap((c: [string, string[]]) => c[1]);
    expect(allAddedLabels).toContain("pipeline:deploying");
    expect(allAddedLabels).not.toContain("pipeline:submission-prep");
  });

  // AC5: python-tool qa → deploying
  it("AC5: ship-type:python-tool advances qa → deploying", async () => {
    const epicId = nextEpic();
    wireQAEpic(epicId, "python-tool");

    const session = makeSession(epicId, "qa", {
      epicLabels: ["ship-type:python-tool", "pipeline:qa"],
    });
    const handled = await handleChainAction(session, 0);

    expect(handled).toBe(true);
    const addCalls = pipelineLabels.addLabelsToEpic.mock.calls;
    const allAddedLabels = addCalls.flatMap((c: [string, string[]]) => c[1]);
    expect(allAddedLabels).toContain("pipeline:deploying");
    expect(allAddedLabels).not.toContain("pipeline:submission-prep");
  });

  // AC5: game qa → deploying
  it("AC5: ship-type:game advances qa → deploying", async () => {
    const epicId = nextEpic();
    wireQAEpic(epicId, "game");

    const session = makeSession(epicId, "qa", {
      epicLabels: ["ship-type:game", "pipeline:qa"],
    });
    const handled = await handleChainAction(session, 0);

    expect(handled).toBe(true);
    const addCalls = pipelineLabels.addLabelsToEpic.mock.calls;
    const allAddedLabels = addCalls.flatMap((c: [string, string[]]) => c[1]);
    expect(allAddedLabels).toContain("pipeline:deploying");
    expect(allAddedLabels).not.toContain("pipeline:submission-prep");
  });

  // AC7: defense-in-depth — nextStage() returns correct fallback targets
  // for stages that were previously in the hard-coded NEXT_STAGE map.
  // handleAgentExit is not exported, so we verify the replacement logic
  // indirectly by confirming the pipeline-router nextStage() mock returns
  // the correct values for the fallback-path stages.
  it("AC7: nextStage() returns correct targets for fallback stages (defense-in-depth verification)", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { nextStage } = jest.requireMock("@/lib/pipeline-router") as {
      nextStage: jest.Mock;
    };

    // The old NEXT_STAGE map had:
    //   qa → submission-prep (WRONG for DEPLOY_TAIL — fixed by AC2)
    //   submission-prep → submitted
    //   kit-management → completed
    //
    // The new fallback uses nextStage(stage, shipType). Verify it returns
    // ship-type-aware targets for these stages.

    // internal: qa → deploying (not submission-prep)
    expect(nextStage("qa", "internal")).toBe("deploying");

    // wordpress-plugin: qa → submission-prep
    expect(nextStage("qa", "wordpress-plugin")).toBe("submission-prep");

    // wordpress-plugin: submission-prep → submitted
    expect(nextStage("submission-prep", "wordpress-plugin")).toBe("submitted");

    // internal: kit-management → completed
    expect(nextStage("kit-management", "internal")).toBe("completed");

    // Unknown ship type → undefined (defense-in-depth: no auto-chain)
    expect(nextStage("qa", "unknown-ship-type")).toBeUndefined();
  });

  // AC6: wordpress-plugin qa → submission-prep (regression check)
  it("AC6: ship-type:wordpress-plugin advances qa → submission-prep (SUBMISSION_TAIL regression check)", async () => {
    const epicId = nextEpic();
    // wordpress-plugin uses --label epic:<id> for bug query (not --parent)
    const showOutput = `
○ ${epicId} · Test WP Epic [● P1 · IN_PROGRESS]
LABELS: ship-type:wordpress-plugin, pipeline:qa
`;
    execBehaviour = (args) => {
      if (args[0] === "show" && args[1] === epicId) {
        return { stdout: showOutput.trim() };
      }
      if (args[0] === "list") {
        return { stdout: "" }; // No children, no bugs
      }
      return { stdout: "" };
    };

    const session = makeSession(epicId, "qa", {
      epicLabels: ["ship-type:wordpress-plugin", "pipeline:qa"],
    });
    const handled = await handleChainAction(session, 0);

    expect(handled).toBe(true);
    const addCalls = pipelineLabels.addLabelsToEpic.mock.calls;
    const allAddedLabels = addCalls.flatMap((c: [string, string[]]) => c[1]);
    expect(allAddedLabels).toContain("pipeline:submission-prep");
    expect(allAddedLabels).toContain("qa:needs-review");
    expect(allAddedLabels).not.toContain("pipeline:deploying");
  });
});
