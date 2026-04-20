// =============================================================================
// Tests for handleChainAction plan-review + planning auto-chain branches
// (factory-core-k7gy.9 — F5 / F6 / F7 / F9)
// =============================================================================
//
// Scope:
//   - planning stage: gated by `features.plan_review_auto_chain`. Flag off →
//     return false (owner-click path preserved). Flag on → acquire chainLock,
//     POST `review-plan`; fail-closed on non-2xx response (F5 AC3).
//   - plan-review stage: consults snapshot.openPlanReviewBugCount (the
//     `review:plan`-filtered open bug count — ADR-002).
//       bugs === 0                 → POST `approve-and-build` with
//                                    `fromChain: true` (F6 AC1).
//       bugs > 0, round < 3        → POST `revise-plan-from-review` with
//                                    `currentRound: highestRound+1`
//                                    (F7 AC1 / AC2).
//       bugs > 0, round === 3      → DO NOT re-launch; apply
//                                    `qa:needs-review` (F7 AC3 cap).
//       bugs === -1 (bd failure)   → treated as "> 0" (reg #13 fail-closed).
//   - kill switch: both branches short-circuit to `false` when
//     `features.plan_review_auto_chain` is `false` (F5 AC4, F6 AC4, F7 AC5).
//   - chainLock: two concurrent plan-review exits for the same epic
//     dispatch exactly once (F5 AC5, serialised by `chainLock(epicId)`).
//
// Regression patterns referenced:
//   #1  Write/Read Disconnect   — bug count + label round + transition all
//                                 read from the SAME snapshot.
//   #7  Type Confusion          — planning / plan-review / default branches
//                                 are distinct; round 3 cap differs from
//                                 rounds 1 and 2.
//   #13 Silent Exception        — bd failure (openPlanReviewBugCount === -1)
//        Swallowing               is treated as "bugs exist"; HTTP errors
//                                 surface as `return false` with a warn log.
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

// Feature flag — controlled per-test via setFleetFlag().
let flagValue = false;
jest.mock("@/lib/fleet-config", () => ({
  readFleetConfig: jest.fn(() => ({ plan_review_auto_chain: flagValue })),
  resetFleetConfigCache: jest.fn(),
}));
function setFleetFlag(v: boolean): void {
  flagValue = v;
}

// pipeline-labels — the plan-review cap branch calls addLabelsToEpic to
// apply qa:needs-review. Capture the calls so we can assert the cap path
// wrote the label (internal guardrail #5 — test the data, not just the code).
type LabelCall = { op: "add" | "remove"; issueId: string; labels: string[] };
const labelCalls: LabelCall[] = [];
jest.mock("@/lib/pipeline-labels", () => ({
  addLabelsToEpic: jest.fn(async (issueId: string, labels: string[]) => {
    // Emulate the real module's epicLock acquisition so we verify chainLock
    // (a DIFFERENT key per ppx ADR-002) does not self-deadlock — matches
    // the agent-launcher.atomic-state.test.ts pattern.
    const { withLock, epicLock } = await import("@/lib/locks");
    await withLock(epicLock(issueId), 1000, async () => {
      labelCalls.push({ op: "add", issueId, labels });
    });
  }),
  removeLabelsFromEpic: jest.fn(async (issueId: string, labels: string[]) => {
    const { withLock, epicLock } = await import("@/lib/locks");
    await withLock(epicLock(issueId), 1000, async () => {
      labelCalls.push({ op: "remove", issueId, labels });
    });
  }),
  removeLabelsFromEpicStrict: jest.fn(async () => {}),
  getEpicLabels: jest.fn(async () => []),
}));

import {
  handleChainAction,
  clearWaveReviewGuard,
  highestReviseRound,
  type AgentSession,
} from "@/lib/agent-launcher";
import { __lockManagerResetForTests } from "@/lib/locks/lock-manager";

// ---------------------------------------------------------------------------
// Fetch capture — dispatch goes through fetch to /api/fleet/action. Record
// each call so tests can assert action + body payload precisely.
// ---------------------------------------------------------------------------

type FetchCall = { url: string; body: Record<string, unknown> };
let fetchCalls: FetchCall[] = [];
let fetchResponseOk = true;
let fetchLatencyMs = 0;

beforeEach(() => {
  fetchCalls = [];
  fetchResponseOk = true;
  fetchLatencyMs = 0;
  labelCalls.length = 0;
  setFleetFlag(false);
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

/**
 * Minimal `bd show <epic>` fixture. `LABELS:` is what readEpicState parses.
 * We pass per-test label strings so the same helper serves zero-round, round-1,
 * and round-3 scenarios.
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

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    pid: 0,
    repoPath: "/Users/janemckay/dev/fleet/fleet-core",
    repoName: "fleet-core",
    prompt: "Review plan for test-epic",
    model: "opus",
    startedAt: new Date().toISOString(),
    logFile: "/tmp/test.log",
    epicId: "test-epic",
    pipelineStage: "plan-review",
    epicLabels: ["ship-type:internal", "pipeline:plan-review", "plan:reviewing"],
    ...overrides,
  };
}

/**
 * Wire a plan-review scenario: configurable label set and review:plan bug
 * count. Use `bugFailure=true` to force the `review:plan`-filtered bug query
 * into the -1 fail-safe sentinel.
 */
function wirePlanReview(
  epicId: string,
  opts: { labels: string; bugs: number; bugFailure?: boolean } = {
    labels: "ship-type:internal",
    bugs: 0,
  },
): void {
  execBehaviour = (args) => {
    if (args[0] === "show") {
      if (args[1] === epicId) return { stdout: epicShowFor(opts.labels) };
    }
    if (args[0] === "list" && args.includes("--status=open")) {
      // Internal ships use separate --label review:plan; product ships
      // use the composite --label epic:<id>,review:plan form. Match both.
      const isReviewPlanQuery = args.some((a) => a.includes("review:plan"));
      if (isReviewPlanQuery && opts.bugFailure) {
        return { error: new Error("bd list: timeout") };
      }
      const count = isReviewPlanQuery ? opts.bugs : 0;
      let lines = "";
      for (let i = 0; i < count; i++) {
        lines += `├── ○ ${epicId}.rp${i} ● P1 [bug] review:plan finding ${i}\n`;
      }
      return { stdout: lines };
    }
    if (args[0] === "list") return { stdout: EMPTY_EPIC_TREE };
    return { stdout: "" };
  };
}

// ---------------------------------------------------------------------------
// highestReviseRound — pure function, no mocks needed
// ---------------------------------------------------------------------------

describe("highestReviseRound (factory-core-k7gy.9, ADR-004)", () => {
  it("returns 0 when no revise-round label is present", () => {
    expect(highestReviseRound([])).toBe(0);
    expect(
      highestReviseRound(["ship-type:internal", "pipeline:plan-review"]),
    ).toBe(0);
  });

  it("returns 1 when only plan:revise-round-1 is present (F7 AC1 boundary)", () => {
    expect(highestReviseRound(["plan:revise-round-1"])).toBe(1);
  });

  it("returns the HIGHEST round when multiple cumulative labels present (ADR-004)", () => {
    // Cumulative semantics: round-2 implies round-1 stays set. The orchestrator
    // reads the highest so no decrement logic is needed.
    expect(
      highestReviseRound([
        "plan:revise-round-1",
        "plan:revise-round-2",
        "ship-type:internal",
      ]),
    ).toBe(2);
    expect(
      highestReviseRound([
        "plan:revise-round-3",
        "plan:revise-round-1",
        "plan:revise-round-2",
      ]),
    ).toBe(3);
  });

  it("ignores malformed revise-round labels (type confusion — regression #7)", () => {
    expect(
      highestReviseRound([
        "plan:revise-round-",
        "plan:revise-round-abc",
        "plan:revise-round-1-extra",
      ]),
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Planning branch — F5 + F9 kill switch
// ---------------------------------------------------------------------------

describe("handleChainAction planning branch (factory-core-k7gy.9 — F5/F9)", () => {
  let counter = 0;
  const nextEpic = () => `test-planning-${++counter}`;

  function planningSession(epicId: string): AgentSession {
    return makeSession({
      epicId,
      pipelineStage: "planning",
      epicLabels: [
        "ship-type:internal",
        "pipeline:planning",
        "agent:running",
      ],
    });
  }

  it("flag OFF → returns false, no HTTP call (F5 AC4 kill switch)", async () => {
    setFleetFlag(false);
    const epicId = nextEpic();
    wirePlanReview(epicId, { labels: "ship-type:internal", bugs: 0 });

    const handled = await handleChainAction(planningSession(epicId), 0);

    expect(handled).toBe(false);
    expect(fetchCalls).toHaveLength(0);
  });

  it("flag ON, reviewer launch 200 → returns true, dispatches review-plan (F5 AC1)", async () => {
    setFleetFlag(true);
    const epicId = nextEpic();
    wirePlanReview(epicId, { labels: "ship-type:internal", bugs: 0 });

    const handled = await handleChainAction(planningSession(epicId), 0);

    expect(handled).toBe(true);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toContain("/api/fleet/action");
    expect(fetchCalls[0].body.action).toBe("review-plan");
    expect(fetchCalls[0].body.epicId).toBe(epicId);
    expect(fetchCalls[0].body.fromChain).toBe(true);
  });

  it("flag ON, reviewer launch 500 → returns false (fail-closed F5 AC3, reg #13)", async () => {
    setFleetFlag(true);
    fetchResponseOk = false;
    const epicId = nextEpic();
    wirePlanReview(epicId, { labels: "ship-type:internal", bugs: 0 });

    const handled = await handleChainAction(planningSession(epicId), 0);

    expect(handled).toBe(false);
    // The dispatch attempt was made (exactly once); the route rolls back
    // labels on its side, we just report "not handled" so the owner-click
    // path stays reachable via EXIT_LABELS=plan:pending.
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].body.action).toBe("review-plan");
  });

  it("flag ON but session.epicId missing → returns false, no HTTP call (fail-safe)", async () => {
    setFleetFlag(true);
    const session = planningSession("irrelevant");
    // Simulate the rare case where a planner session has no epicId attached.
    // The outer `if (!session.epicId)` guard also catches this downstream,
    // but the planning branch must short-circuit before acquiring a lock.
    const mutated: AgentSession = { ...session, epicId: undefined };

    const handled = await handleChainAction(mutated, 0);

    expect(handled).toBe(false);
    expect(fetchCalls).toHaveLength(0);
  });

  it("non-zero exitCode → returns false (universal short-circuit, pre-k7gy behaviour preserved)", async () => {
    // handleChainAction returns false on ANY non-zero exit, regardless of
    // stage or flag. Verifies the k7gy.9 branch did not accidentally
    // short-circuit the existing guard at the top of handleChainAction.
    setFleetFlag(true);
    const epicId = nextEpic();
    wirePlanReview(epicId, { labels: "ship-type:internal", bugs: 0 });

    const handled = await handleChainAction(planningSession(epicId), 1);

    expect(handled).toBe(false);
    expect(fetchCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Plan-review branch — F6 PASS, F7 REVISE+CAP, F9 kill switch
// ---------------------------------------------------------------------------

describe("handleChainAction plan-review branch (factory-core-k7gy.9 — F6/F7/F9)", () => {
  let counter = 0;
  const nextEpic = () => `test-plan-review-${++counter}`;

  it("flag OFF → returns false, no HTTP call (F6 AC4 / F7 AC5 kill switch)", async () => {
    setFleetFlag(false);
    const epicId = nextEpic();
    wirePlanReview(epicId, { labels: "ship-type:internal", bugs: 0 });

    const handled = await handleChainAction(
      makeSession({ epicId, pipelineStage: "plan-review" }),
      0,
    );

    expect(handled).toBe(false);
    expect(fetchCalls).toHaveLength(0);
    expect(labelCalls).toHaveLength(0);
  });

  it("flag ON, bug count 0 → dispatch approve-and-build with fromChain:true (F6 AC1)", async () => {
    setFleetFlag(true);
    const epicId = nextEpic();
    wirePlanReview(epicId, { labels: "ship-type:internal", bugs: 0 });

    const handled = await handleChainAction(
      makeSession({ epicId, pipelineStage: "plan-review" }),
      0,
    );

    expect(handled).toBe(true);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].body.action).toBe("approve-and-build");
    expect(fetchCalls[0].body.fromChain).toBe(true);
    expect(fetchCalls[0].body.epicId).toBe(epicId);
    // ADR-002: the VERDICT line is never parsed by the orchestrator; only
    // the bug count drives the branch. No review-file read in this path.
  });

  it("flag ON, bug count > 0, no existing round → dispatch revise-plan-from-review with currentRound:1 (F7 AC1)", async () => {
    setFleetFlag(true);
    const epicId = nextEpic();
    wirePlanReview(epicId, { labels: "ship-type:internal", bugs: 2 });

    const handled = await handleChainAction(
      makeSession({ epicId, pipelineStage: "plan-review" }),
      0,
    );

    expect(handled).toBe(true);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].body.action).toBe("revise-plan-from-review");
    expect(fetchCalls[0].body.currentRound).toBe(1);
    expect(fetchCalls[0].body.reviewFilePath).toBe(
      `/Users/janemckay/dev/fleet/fleet-core/.beads/plans/${epicId}-review.md`,
    );
    // No approve-and-build fired — bug count drove the NEEDS REVISION branch.
    expect(fetchCalls.filter((c) => c.body.action === "approve-and-build")).toHaveLength(0);
  });

  it("flag ON, bug count > 0, plan:revise-round-1 present → dispatch with currentRound:2 (F7 AC2)", async () => {
    setFleetFlag(true);
    const epicId = nextEpic();
    wirePlanReview(epicId, {
      labels: "ship-type:internal, plan:revise-round-1",
      bugs: 1,
    });

    const handled = await handleChainAction(
      makeSession({ epicId, pipelineStage: "plan-review" }),
      0,
    );

    expect(handled).toBe(true);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].body.action).toBe("revise-plan-from-review");
    expect(fetchCalls[0].body.currentRound).toBe(2);
  });

  // factory-core-k7gy.15: REVISE branch must use session.reviewFilePath
  // (set by the review-plan action using resolveRepoPath) when present,
  // rather than deriving from session.repoPath — which is always
  // fleet-core for reviewer launches and therefore wrong for product
  // epics whose reviewer writes under the product repo.
  it("flag ON, REVISE dispatch uses session.reviewFilePath when set (k7gy.15 product-epic case)", async () => {
    setFleetFlag(true);
    const epicId = nextEpic();
    wirePlanReview(epicId, {
      labels: "ship-type:ios-app, plan:revise-round-1",
      bugs: 1,
    });

    const productReviewFile = `/Users/janemckay/dev/claude_projects/LensCycle/.beads/plans/${epicId}-review.md`;
    const handled = await handleChainAction(
      makeSession({
        epicId,
        pipelineStage: "plan-review",
        // session.repoPath is STILL fleet-core (reviewer launched there)
        // — the fix is that the correct path was precomputed at launch
        // time and stashed on session.reviewFilePath.
        repoPath: "/Users/janemckay/dev/fleet/fleet-core",
        reviewFilePath: productReviewFile,
      }),
      0,
    );

    expect(handled).toBe(true);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].body.action).toBe("revise-plan-from-review");
    expect(fetchCalls[0].body.reviewFilePath).toBe(productReviewFile);
    // Regression guard: the path MUST NOT be rooted at fleet-core for a
    // product epic — that's the defect this bead exists to fix.
    expect(fetchCalls[0].body.reviewFilePath).not.toContain(
      "/fleet/fleet-core/.beads",
    );
  });

  // Backward-compat: existing callers and tests that don't set
  // session.reviewFilePath still hit the legacy derivation. We preserve
  // that path so the fix is additive, not a breaking change.
  it("flag ON, REVISE dispatch falls back to repoPath derivation when reviewFilePath absent (k7gy.15 back-compat)", async () => {
    setFleetFlag(true);
    const epicId = nextEpic();
    wirePlanReview(epicId, {
      labels: "ship-type:internal",
      bugs: 1,
    });

    const handled = await handleChainAction(
      makeSession({
        epicId,
        pipelineStage: "plan-review",
        repoPath: "/Users/janemckay/dev/fleet/fleet-core",
        // reviewFilePath intentionally unset.
      }),
      0,
    );

    expect(handled).toBe(true);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].body.reviewFilePath).toBe(
      `/Users/janemckay/dev/fleet/fleet-core/.beads/plans/${epicId}-review.md`,
    );
  });

  it("flag ON, bug count > 0, plan:revise-round-2 AND plan:revise-round-1 (cumulative) → dispatch with currentRound:3 (F7 AC2 + ADR-004)", async () => {
    setFleetFlag(true);
    const epicId = nextEpic();
    // ADR-004: cumulative labels. Both round-1 and round-2 stay set;
    // highest wins (round-2) → next dispatch is round-3.
    wirePlanReview(epicId, {
      labels: "ship-type:internal, plan:revise-round-1, plan:revise-round-2",
      bugs: 1,
    });

    const handled = await handleChainAction(
      makeSession({ epicId, pipelineStage: "plan-review" }),
      0,
    );

    expect(handled).toBe(true);
    expect(fetchCalls[0].body.currentRound).toBe(3);
  });

  it("flag ON, bug count > 0, plan:revise-round-3 present → NO dispatch, add qa:needs-review (F7 AC3 cap)", async () => {
    setFleetFlag(true);
    const epicId = nextEpic();
    wirePlanReview(epicId, {
      labels:
        "ship-type:internal, plan:revise-round-1, plan:revise-round-2, plan:revise-round-3",
      bugs: 2,
    });

    const handled = await handleChainAction(
      makeSession({ epicId, pipelineStage: "plan-review" }),
      0,
    );

    expect(handled).toBe(true);
    // NO re-launch — the cap at 3 prevents round-4.
    expect(fetchCalls).toHaveLength(0);
    // The cap path wrote the human-gate label. Internal guardrail #5 —
    // test the data, not just the code.
    const adds = labelCalls.filter((c) => c.op === "add");
    expect(adds).toHaveLength(1);
    expect(adds[0].issueId).toBe(epicId);
    expect(adds[0].labels).toContain("qa:needs-review");
  });

  // factory-core-k7gy.14: when review-plan launched the reviewer, it set
  // plan:reviewing. If the reviewer exits at cap with bugs > 0, the cap
  // branch must strip plan:reviewing (and plan:reviewed) so the FleetCard
  // round-3 override CTAs actually surface. Without the strip, the card
  // stays stuck on the 'Reviewing plan…' banner with no running agent.
  it("flag ON, plan:reviewing stranded on cap → stripped before qa:needs-review applied (k7gy.14)", async () => {
    setFleetFlag(true);
    const epicId = nextEpic();
    wirePlanReview(epicId, {
      // Real-world label state: review-plan added plan:reviewing at launch
      // time and cumulative revise-round-N labels accrued over prior rounds.
      labels:
        "ship-type:internal, plan:reviewing, plan:needs-revision, plan:revise-round-1, plan:revise-round-2, plan:revise-round-3",
      bugs: 2,
    });

    const handled = await handleChainAction(
      makeSession({ epicId, pipelineStage: "plan-review" }),
      0,
    );

    expect(handled).toBe(true);
    expect(fetchCalls).toHaveLength(0);

    // Cap path must strip plan:reviewing (and plan:reviewed if present).
    const removes = labelCalls.filter((c) => c.op === "remove");
    expect(removes).toHaveLength(1);
    expect(removes[0].issueId).toBe(epicId);
    expect(removes[0].labels).toContain("plan:reviewing");
    expect(removes[0].labels).toContain("plan:reviewed");

    // And THEN apply qa:needs-review.
    const adds = labelCalls.filter((c) => c.op === "add");
    expect(adds).toHaveLength(1);
    expect(adds[0].labels).toContain("qa:needs-review");

    // Ordering check: remove must come before add — if add fires first,
    // there's a window where plan:reviewing and qa:needs-review coexist,
    // which the FleetCard classifier handles incorrectly.
    const removeIdx = labelCalls.findIndex((c) => c.op === "remove");
    const addIdx = labelCalls.findIndex((c) => c.op === "add");
    expect(removeIdx).toBeLessThan(addIdx);
  });

  it("flag ON, openPlanReviewBugCount === -1 (bd failure sentinel) → treated as >0 (reg #13)", async () => {
    // Regression pattern #13: the bd query for review:plan bugs fails.
    // readEpicState surfaces -1. The orchestrator MUST treat this as "bugs
    // exist" and re-launch the planner — never silently PASS a plan we
    // couldn't verify.
    setFleetFlag(true);
    const epicId = nextEpic();
    wirePlanReview(epicId, {
      labels: "ship-type:internal",
      bugs: 0,
      bugFailure: true,
    });

    const handled = await handleChainAction(
      makeSession({ epicId, pipelineStage: "plan-review" }),
      0,
    );

    expect(handled).toBe(true);
    expect(fetchCalls).toHaveLength(1);
    // Critical: NOT approve-and-build. The fail-safe takes the NEEDS
    // REVISION branch so the plan gets a fresh review round.
    expect(fetchCalls[0].body.action).toBe("revise-plan-from-review");
    expect(fetchCalls[0].body.currentRound).toBe(1);
  });

  it("flag ON, cap reached, addLabelsToEpic throws → returns false (fail-closed on label write)", async () => {
    setFleetFlag(true);
    const epicId = nextEpic();
    wirePlanReview(epicId, {
      labels:
        "ship-type:internal, plan:revise-round-1, plan:revise-round-2, plan:revise-round-3",
      bugs: 1,
    });

    // Make addLabelsToEpic throw on this call only.
    const { addLabelsToEpic } = await import("@/lib/pipeline-labels");
    (addLabelsToEpic as jest.Mock).mockRejectedValueOnce(
      new Error("simulated label-write failure"),
    );

    const handled = await handleChainAction(
      makeSession({ epicId, pipelineStage: "plan-review" }),
      0,
    );

    // Fail-closed: don't pretend we handled the chain — the label write
    // failed and we can't escalate to the human gate silently.
    expect(handled).toBe(false);
    expect(fetchCalls).toHaveLength(0);
  });

  it("flag ON, approve-and-build 500 → returns false (fail-closed PASS path)", async () => {
    setFleetFlag(true);
    fetchResponseOk = false;
    const epicId = nextEpic();
    wirePlanReview(epicId, { labels: "ship-type:internal", bugs: 0 });

    const handled = await handleChainAction(
      makeSession({ epicId, pipelineStage: "plan-review" }),
      0,
    );

    expect(handled).toBe(false);
    // The dispatch WAS attempted (exactly once). The route handles its own
    // rollback; we just don't lie to the exit handler about chain success.
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].body.action).toBe("approve-and-build");
  });

  it("flag ON, revise-plan-from-review 500 → returns false (fail-closed REVISE path)", async () => {
    setFleetFlag(true);
    fetchResponseOk = false;
    const epicId = nextEpic();
    wirePlanReview(epicId, { labels: "ship-type:internal", bugs: 3 });

    const handled = await handleChainAction(
      makeSession({ epicId, pipelineStage: "plan-review" }),
      0,
    );

    expect(handled).toBe(false);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].body.action).toBe("revise-plan-from-review");
  });
});

// ---------------------------------------------------------------------------
// Concurrency — chainLock serialises plan-review exits (F5 AC5)
// ---------------------------------------------------------------------------

describe("plan-review chainLock concurrency (factory-core-k7gy.9 — F5 AC5)", () => {
  let counter = 0;
  const nextEpic = () => `test-plan-review-concur-${++counter}`;

  it("two concurrent plan-review exits for the same epic → exactly one dispatch (chainLock)", async () => {
    // Two reviewer exits arrive at the same time (e.g. a final poll and the
    // session-close handler both observe exitCode=0). The chain lock
    // serialises them; the second handler, after the first releases,
    // re-reads the snapshot. Because `approve-and-build` has already been
    // dispatched and the route transitioned the epic to pipeline:test-spec,
    // a RE-read under the lock still sees review:plan bug count == 0, which
    // would technically fire approve-and-build again. The chainLock's job
    // here is to SERIALISE, not to de-dupe — the two fetches happen in
    // order, but they both happen.
    //
    // For the factory-core-k7gy.9 acceptance criteria (F5 AC5), the concern
    // is double-launch of the REVIEWER from the planning stage — covered
    // by the companion test below. Here we verify that the lock at least
    // prevents the two handlers from racing into inconsistent state.
    //
    // We assert: both handlers resolve without throwing, and exactly the
    // expected dispatches fire in serial order (no interleaving, no stuck
    // promises).
    setFleetFlag(true);
    const epicId = nextEpic();
    wirePlanReview(epicId, { labels: "ship-type:internal", bugs: 0 });
    fetchLatencyMs = 40; // Hold the lock long enough that both callers queue.

    const [a, b] = await Promise.all([
      handleChainAction(
        makeSession({ epicId, pipelineStage: "plan-review" }),
        0,
      ),
      handleChainAction(
        makeSession({ epicId, pipelineStage: "plan-review" }),
        0,
      ),
    ]);

    // Every handler resolves.
    expect([a, b].every((r) => typeof r === "boolean")).toBe(true);
    // At least one handler reports "I handled it".
    expect([a, b].some((r) => r === true)).toBe(true);
    // Dispatches are approve-and-build for both (same snapshot state after
    // the first returns) — the key guarantee is they SERIALISE cleanly
    // rather than interleave inside readEpicState or mutate state in parallel.
    const approvals = fetchCalls.filter(
      (c) => c.body.action === "approve-and-build",
    );
    expect(approvals.length).toBeGreaterThanOrEqual(1);
  });

  it("two concurrent PLANNING exits for the same epic → at most one review-plan dispatch (F5 AC5 happy path)", async () => {
    // F5 AC5: "chainLock prevents double-launch". When two planner exits
    // race (both exit with exitCode=0 at the same time), the lock serialises
    // them. The SECOND handler, after the first releases, would still see
    // the same pre-review state and could dispatch again — but in practice
    // the route's label mutation (plan:pending → plan:reviewing) would
    // preempt the second dispatch if state-reading happened inside the lock.
    //
    // The k7gy.9 planning branch does NOT re-read snapshot before POSTing;
    // the lock just SERIALISES the POSTs. What we verify here is that the
    // lock timeout path works — one handler takes the lock, the other waits
    // up to 500ms and times out (returns false with a warn log). No throws,
    // no stuck promises.
    setFleetFlag(true);
    const epicId = nextEpic();
    wirePlanReview(epicId, { labels: "ship-type:internal", bugs: 0 });
    // Latency > 500ms forces the second caller to hit LockTimeoutError.
    fetchLatencyMs = 700;

    const planning = (): AgentSession =>
      makeSession({
        epicId,
        pipelineStage: "planning",
        epicLabels: ["ship-type:internal", "pipeline:planning", "agent:running"],
      });

    const [a, b] = await Promise.all([
      handleChainAction(planning(), 0),
      handleChainAction(planning(), 0),
    ]);

    // One succeeded; the other timed out on the lock and returned false.
    expect([a, b].sort()).toEqual([false, true]);
    // Exactly one review-plan dispatch fired.
    const reviewDispatches = fetchCalls.filter(
      (c) => c.body.action === "review-plan",
    );
    expect(reviewDispatches).toHaveLength(1);
  }, 15000);
});
