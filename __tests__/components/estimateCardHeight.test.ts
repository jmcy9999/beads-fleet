// =============================================================================
// Tests for src/components/fleet/estimateCardHeight.ts (factory-core-3p1e.9)
// =============================================================================
// Covers: per-section contribution (each conditional adds the documented
// HEIGHTS delta), combinations (multiple sections), default minimal case,
// regression fixtures using realistic FleetApp shapes.
// =============================================================================

import { estimateCardHeight, HEIGHTS } from "@/components/fleet/estimateCardHeight";
import type { FleetApp } from "@/components/fleet/fleet-utils";
import type { PlanIssue } from "@/lib/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePlanIssue(overrides: Partial<PlanIssue> = {}): PlanIssue {
  return {
    id: overrides.id ?? "ISSUE-1",
    title: overrides.title ?? "Test issue",
    status: overrides.status ?? "open",
    priority: overrides.priority ?? 2,
    issue_type: overrides.issue_type ?? "task",
    blocked_by: overrides.blocked_by ?? [],
    blocks: overrides.blocks ?? [],
    ...overrides,
  };
}

/**
 * Build a FleetApp directly (without buildFleetApps). estimateCardHeight
 * only inspects {epic, children, stage, shipType, progress}, so a hand-
 * rolled FleetApp is sufficient for the estimator's contract.
 */
function makeApp(overrides: Partial<FleetApp> = {}): FleetApp {
  const epic = overrides.epic ?? makePlanIssue({ id: "EPIC-1", labels: [] });
  return {
    epic,
    children: overrides.children ?? [],
    stage: overrides.stage ?? "completed",
    shipType: overrides.shipType ?? "internal",
    progress: overrides.progress ?? { closed: 0, total: 0 },
  };
}

// Structural-only baseline: the always-rendered card sections plus the
// inter-card gap. Every other contribution is conditional and added on
// top of this base.
const STRUCTURAL_BASE =
  HEIGHTS.CARD_PADDING +
  HEIGHTS.HEADER +
  HEIGHTS.APP_NAME +
  HEIGHTS.FOOTER +
  HEIGHTS.PHASE_HISTORY +
  HEIGHTS.CARD_GAP;

/**
 * Minimal terminal app: stage="completed" with no progress, no waves, no
 * submission, no attention, no agent. The estimator still adds:
 *   - QUICK_LINKS (rendered for any non-idea stage)
 *   - SNIPPET (rendered for any non-idea, non-bad-idea stage)
 * No COST (completed is excluded from costRenderingStages) and no action
 * buttons (completed is in skipAbandonStages).
 */
function minimalApp(): FleetApp {
  return makeApp({
    epic: makePlanIssue({ id: "EPIC-1", labels: [] }),
    stage: "completed",
    progress: { closed: 0, total: 0 },
    children: [],
  });
}

/** Expected height for the minimalApp() defined above. */
const MINIMAL_TERMINAL_BASELINE =
  STRUCTURAL_BASE + HEIGHTS.QUICK_LINKS + HEIGHTS.SNIPPET;

/**
 * Truly bare app: stage="bad-idea" — adds QUICK_LINKS only. Useful for
 * tests that want to isolate exactly one optional section.
 */
function bareApp(): FleetApp {
  return makeApp({
    epic: makePlanIssue({ id: "EPIC-1", labels: [] }),
    stage: "bad-idea",
    progress: { closed: 0, total: 0 },
    children: [],
  });
}

/** Expected height for the bareApp() defined above. */
const BARE_BASELINE = STRUCTURAL_BASE + HEIGHTS.QUICK_LINKS;

// =============================================================================
// Default minimal case
// =============================================================================

describe("estimateCardHeight — minimal case", () => {
  it("returns STRUCTURAL_BASE + QUICK_LINKS + SNIPPET for a minimal completed app", () => {
    // completed → non-idea (adds QUICK_LINKS) and non-bad-idea (adds SNIPPET).
    // Terminal stage → no COST, no buttons (skipAbandon).
    const app = minimalApp();
    expect(estimateCardHeight(app)).toBe(MINIMAL_TERMINAL_BASELINE);
  });

  it("returns STRUCTURAL_BASE + QUICK_LINKS for a bad-idea app (no SNIPPET, no COST, no buttons)", () => {
    const app = bareApp();
    expect(estimateCardHeight(app)).toBe(BARE_BASELINE);
  });

  it("returns a positive integer for any reasonable app", () => {
    const app = minimalApp();
    const h = estimateCardHeight(app);
    expect(Number.isInteger(h)).toBe(true);
    expect(h).toBeGreaterThan(0);
  });

  it("returns the same height for the same input (purity)", () => {
    const app = minimalApp();
    expect(estimateCardHeight(app)).toBe(estimateCardHeight(app));
  });
});

// =============================================================================
// Per-section contribution — each optional section adds exactly the
// documented HEIGHTS delta on top of the minimal baseline.
// =============================================================================

describe("estimateCardHeight — per-section contributions", () => {
  it("adds PROGRESS_BAR when progress.total > 0", () => {
    // Use bareApp to isolate exactly the PROGRESS_BAR delta.
    const app = makeApp({
      ...bareApp(),
      progress: { closed: 3, total: 10 },
    });
    expect(estimateCardHeight(app)).toBe(BARE_BASELINE + HEIGHTS.PROGRESS_BAR);
  });

  it("adds WAVE_INFO when at least one child has a wave:N label", () => {
    const app = makeApp({
      ...bareApp(),
      children: [makePlanIssue({ id: "C1", labels: ["wave:1"] })],
    });
    expect(estimateCardHeight(app)).toBe(BARE_BASELINE + HEIGHTS.WAVE_INFO);
  });

  it("adds SUBMISSION_BADGES when epic has a submission:* label", () => {
    const app = makeApp({
      epic: makePlanIssue({ id: "EPIC-1", labels: ["submission:ready"] }),
      stage: "bad-idea",
      progress: { closed: 0, total: 0 },
      children: [],
    });
    expect(estimateCardHeight(app)).toBe(
      BARE_BASELINE + HEIGHTS.SUBMISSION_BADGES,
    );
  });

  it("adds SUBMISSION_BADGES when a child has a submission:* label", () => {
    const app = makeApp({
      ...bareApp(),
      children: [makePlanIssue({ id: "C1", labels: ["submission:approved"] })],
    });
    expect(estimateCardHeight(app)).toBe(
      BARE_BASELINE + HEIGHTS.SUBMISSION_BADGES,
    );
  });

  it("adds QUICK_LINKS for any non-idea stage", () => {
    // Compare idea (no quick links) vs research (quick links + many other extras).
    // Use bareApp's bad-idea stage to keep the comparison narrow:
    // bad-idea also adds QUICK_LINKS, so the bad-idea height already
    // contains that contribution. We assert that a true idea stage is
    // QUICK_LINKS shorter than bad-idea (after backing out idea's buttons).
    const ideaApp = makeApp({
      epic: makePlanIssue({ id: "EPIC-1", labels: [] }),
      stage: "idea",
      progress: { closed: 0, total: 0 },
      children: [],
    });
    const ideaH = estimateCardHeight(ideaApp);
    // idea has 3 buttons (start-research, skip-to-plan, Abandon).
    const ideaButtonCost =
      HEIGHTS.ACTION_BLOCK_MARGIN + 3 * HEIGHTS.ACTION_BUTTON;
    // (idea structural - quick links) vs (bad-idea structural):
    // idea = STRUCTURAL_BASE + buttons; bad-idea = STRUCTURAL_BASE + QUICK_LINKS.
    // Therefore bad-idea - idea = QUICK_LINKS - buttonCost.
    expect(BARE_BASELINE - (ideaH - ideaButtonCost)).toBe(HEIGHTS.QUICK_LINKS);
  });

  it("does NOT add QUICK_LINKS for idea stage", () => {
    const app = makeApp({
      epic: makePlanIssue({ id: "EPIC-1", labels: [] }),
      stage: "idea",
      progress: { closed: 0, total: 0 },
      children: [],
    });
    // idea stage: no quick links, no snippet, no cost, no langfuse, but
    // has 2 buttons (start-research, skip-to-plan) + Abandon = 3 buttons.
    const expected =
      STRUCTURAL_BASE +
      HEIGHTS.ACTION_BLOCK_MARGIN +
      3 * HEIGHTS.ACTION_BUTTON;
    expect(estimateCardHeight(app)).toBe(expected);
  });

  it("adds LANGFUSE when epic has agent:running label", () => {
    // Use stage:research with agent running — research has minimal extras
    // beyond its non-idea defaults, so we can isolate the langfuse delta.
    const baseApp: FleetApp = makeApp({
      ...minimalApp(),
      stage: "research",
    });
    const baseH = estimateCardHeight(baseApp);
    const agentApp: FleetApp = makeApp({
      ...baseApp,
      epic: makePlanIssue({
        id: "EPIC-1",
        labels: ["agent:running"],
      }),
    });
    // agent-running on research stage flips action button shape too:
    // research-no-agent has 0 stage buttons + Abandon (1); research-w-agent
    // has 1 stop-agent + Abandon = 2. Net delta: +LANGFUSE +ACTION_BUTTON.
    const agentH = estimateCardHeight(agentApp);
    expect(agentH - baseH).toBe(HEIGHTS.LANGFUSE + HEIGHTS.ACTION_BUTTON);
  });

  it("adds SNIPPET for any non-idea, non-bad-idea stage", () => {
    // bad-idea (no SNIPPET, no COST, no buttons) vs research:
    // research adds SNIPPET + COST_BASE + ACTION_BLOCK_MARGIN + 1 button (Abandon).
    // QUICK_LINKS is in both so no delta there.
    const bad = estimateCardHeight(bareApp());
    const research = estimateCardHeight(
      makeApp({ ...bareApp(), stage: "research" }),
    );
    expect(research - bad).toBe(
      HEIGHTS.SNIPPET +
        HEIGHTS.COST_BASE +
        HEIGHTS.ACTION_BLOCK_MARGIN +
        HEIGHTS.ACTION_BUTTON,
    );
  });

  it("does NOT add SNIPPET for bad-idea stage", () => {
    const app = bareApp();
    expect(estimateCardHeight(app)).toBe(BARE_BASELINE);
  });

  it("adds COST_BASE for active stages (research) but NOT for bad-idea", () => {
    const bad = estimateCardHeight(bareApp()); // no cost
    const research = estimateCardHeight(
      makeApp({ ...bareApp(), stage: "research" }),
    );
    expect(research).toBeGreaterThanOrEqual(bad + HEIGHTS.COST_BASE);
  });

  it("adds COST_BASE + COST_PHASES for active development stage", () => {
    const research = estimateCardHeight(
      makeApp({ ...bareApp(), stage: "research" }),
    );
    const development = estimateCardHeight(
      makeApp({
        ...bareApp(),
        stage: "development",
      }),
    );
    // Both have COST_BASE; development also has COST_PHASES.
    // Beyond COST_PHASES, development with no waves, no
    // pipeline:development label, no open children, no venture: 0 stage
    // buttons + Abandon = 1, same as research's 1 button (Abandon).
    expect(development - research).toBe(HEIGHTS.COST_PHASES);
  });

  it("adds ATTENTION_BANNER_PER_ITEM for each attention-trigger label", () => {
    const app = makeApp({
      epic: makePlanIssue({
        id: "EPIC-1",
        labels: [
          "checkpoint:human-verify",
          "checkpoint:decision",
          "qa:needs-review",
        ],
      }),
      stage: "bad-idea",
      progress: { closed: 0, total: 0 },
      children: [],
    });
    expect(estimateCardHeight(app)).toBe(
      BARE_BASELINE + 3 * HEIGHTS.ATTENTION_BANNER_PER_ITEM,
    );
  });

  it("adds ATTENTION_BANNER_PER_ITEM for each child with the human label", () => {
    const app = makeApp({
      ...bareApp(),
      children: [
        makePlanIssue({ id: "C1", labels: ["human"] }),
        makePlanIssue({ id: "C2", labels: ["human"] }),
        makePlanIssue({ id: "C3", labels: [] }),
      ],
    });
    expect(estimateCardHeight(app)).toBe(
      BARE_BASELINE + 2 * HEIGHTS.ATTENTION_BANNER_PER_ITEM,
    );
  });
});

// =============================================================================
// Action-button shape per stage
// =============================================================================

describe("estimateCardHeight — action button shape", () => {
  it("idea stage renders 3 buttons (start-research, skip-to-plan, Abandon)", () => {
    const app = makeApp({
      epic: makePlanIssue({ id: "EPIC-1", labels: [] }),
      stage: "idea",
      progress: { closed: 0, total: 0 },
      children: [],
    });
    const expected =
      STRUCTURAL_BASE +
      HEIGHTS.ACTION_BLOCK_MARGIN +
      3 * HEIGHTS.ACTION_BUTTON;
    expect(estimateCardHeight(app)).toBe(expected);
  });

  it("research-complete stage renders 3 buttons (Run PM, More Research, Deprioritise)", () => {
    const app = makeApp({ ...bareApp(), stage: "research-complete" });
    // research-complete is in skipAbandonStages, so button count = 3 only.
    // research-complete also adds SNIPPET, COST_BASE (QUICK_LINKS is in BARE).
    const expected =
      BARE_BASELINE +
      HEIGHTS.SNIPPET +
      HEIGHTS.COST_BASE +
      HEIGHTS.ACTION_BLOCK_MARGIN +
      3 * HEIGHTS.ACTION_BUTTON;
    expect(estimateCardHeight(app)).toBe(expected);
  });

  it("development stage with agent running renders 1 button (stop-agent) + Abandon", () => {
    const app = makeApp({
      epic: makePlanIssue({ id: "EPIC-1", labels: ["agent:running"] }),
      stage: "development",
      progress: { closed: 0, total: 0 },
      children: [],
    });
    // dev w/ agent running: 1 stop-agent + Abandon = 2. Plus LANGFUSE,
    // SNIPPET, COST_BASE+PHASES (QUICK_LINKS is included via STRUCTURAL+
    // QUICK_LINKS for non-idea stages).
    const expected =
      STRUCTURAL_BASE +
      HEIGHTS.QUICK_LINKS +
      HEIGHTS.LANGFUSE +
      HEIGHTS.SNIPPET +
      HEIGHTS.COST_BASE +
      HEIGHTS.COST_PHASES +
      HEIGHTS.ACTION_BLOCK_MARGIN +
      2 * HEIGHTS.ACTION_BUTTON;
    expect(estimateCardHeight(app)).toBe(expected);
  });

  it("plan-review with plan:reviewing sub-state renders the 'Reviewing plan…' text", () => {
    const app = makeApp({
      epic: makePlanIssue({ id: "EPIC-1", labels: ["plan:reviewing"] }),
      stage: "plan-review",
      progress: { closed: 0, total: 0 },
      children: [],
    });
    // plan-review in skipAbandonStages. plan:reviewing -> 1 text, 0 buttons (no agent running).
    const expected =
      STRUCTURAL_BASE +
      HEIGHTS.QUICK_LINKS +
      HEIGHTS.SNIPPET +
      HEIGHTS.COST_BASE +
      HEIGHTS.COST_PHASES +
      HEIGHTS.ACTION_BLOCK_MARGIN +
      HEIGHTS.ACTION_TEXT;
    expect(estimateCardHeight(app)).toBe(expected);
  });

  it("plan-review with plan:revise-round-3 renders 3 buttons + review-file link + text", () => {
    const app = makeApp({
      epic: makePlanIssue({ id: "EPIC-1", labels: ["plan:revise-round-3"] }),
      stage: "plan-review",
      progress: { closed: 0, total: 0 },
      children: [],
    });
    const expected =
      STRUCTURAL_BASE +
      HEIGHTS.QUICK_LINKS +
      HEIGHTS.SNIPPET +
      HEIGHTS.COST_BASE +
      HEIGHTS.COST_PHASES +
      HEIGHTS.ACTION_BLOCK_MARGIN +
      HEIGHTS.ACTION_TEXT +
      HEIGHTS.REVIEW_FILE_LINK +
      3 * HEIGHTS.ACTION_BUTTON;
    expect(estimateCardHeight(app)).toBe(expected);
  });

  it("qa stage with qa:round-1 label adds the QA_ROUND_BADGE + send-for-polish button", () => {
    const app = makeApp({
      epic: makePlanIssue({ id: "EPIC-1", labels: ["qa:round-1"] }),
      stage: "qa",
      progress: { closed: 0, total: 0 },
      children: [],
    });
    // qa-no-agent round 1: 4 stage buttons + Abandon = 5; QA_ROUND_BADGE extra.
    const expected =
      STRUCTURAL_BASE +
      HEIGHTS.QUICK_LINKS +
      HEIGHTS.SNIPPET +
      HEIGHTS.COST_BASE +
      HEIGHTS.COST_PHASES +
      HEIGHTS.ACTION_BLOCK_MARGIN +
      HEIGHTS.QA_ROUND_BADGE +
      5 * HEIGHTS.ACTION_BUTTON;
    expect(estimateCardHeight(app)).toBe(expected);
  });

  it("qa stage with qa:round-2 omits the send-for-polish button", () => {
    const app = makeApp({
      epic: makePlanIssue({ id: "EPIC-1", labels: ["qa:round-2"] }),
      stage: "qa",
      progress: { closed: 0, total: 0 },
      children: [],
    });
    // qa round 2: 3 stage buttons + Abandon = 4; QA_ROUND_BADGE extra.
    const expected =
      STRUCTURAL_BASE +
      HEIGHTS.QUICK_LINKS +
      HEIGHTS.SNIPPET +
      HEIGHTS.COST_BASE +
      HEIGHTS.COST_PHASES +
      HEIGHTS.ACTION_BLOCK_MARGIN +
      HEIGHTS.QA_ROUND_BADGE +
      4 * HEIGHTS.ACTION_BUTTON;
    expect(estimateCardHeight(app)).toBe(expected);
  });

  it("submission-prep renders 4 buttons (launch, send-back, revise, Abandon)", () => {
    const app = makeApp({ ...bareApp(), stage: "submission-prep" });
    const expected =
      BARE_BASELINE +
      HEIGHTS.SNIPPET +
      HEIGHTS.COST_BASE +
      HEIGHTS.COST_PHASES +
      HEIGHTS.ACTION_BLOCK_MARGIN +
      4 * HEIGHTS.ACTION_BUTTON;
    expect(estimateCardHeight(app)).toBe(expected);
  });

  it("completed stage renders no action buttons (and no action block margin)", () => {
    const app = minimalApp();
    // completed: STRUCTURAL_BASE + QUICK_LINKS + SNIPPET, no buttons.
    expect(estimateCardHeight(app)).toBe(MINIMAL_TERMINAL_BASELINE);
  });

  it("bad-idea stage renders no action buttons (only QUICK_LINKS extra)", () => {
    const app = bareApp();
    expect(estimateCardHeight(app)).toBe(BARE_BASELINE);
  });
});

// =============================================================================
// Combinations / regression fixtures
// =============================================================================

describe("estimateCardHeight — realistic combinations", () => {
  it("a fully-loaded development epic with 2 waves, 1 attention banner, agent running", () => {
    const app = makeApp({
      epic: makePlanIssue({
        id: "EPIC-1",
        labels: [
          "agent:running",
          "pipeline:development",
          "checkpoint:human-verify",
        ],
      }),
      stage: "development",
      progress: { closed: 5, total: 12 },
      children: [
        makePlanIssue({ id: "C1", status: "open", labels: ["wave:1"] }),
        makePlanIssue({ id: "C2", status: "open", labels: ["wave:2"] }),
      ],
      shipType: "internal",
    });

    // dev w/ agent running: 1 stop-agent + Abandon = 2.
    // (pipeline:development label is checked in actionButtonShape only when
    //  agent is NOT running; ignored when running.)
    const expected =
      HEIGHTS.CARD_PADDING +
      HEIGHTS.HEADER +
      HEIGHTS.APP_NAME +
      HEIGHTS.FOOTER +
      HEIGHTS.PHASE_HISTORY +
      HEIGHTS.PROGRESS_BAR +
      HEIGHTS.WAVE_INFO +
      HEIGHTS.QUICK_LINKS +
      HEIGHTS.LANGFUSE +
      HEIGHTS.SNIPPET +
      HEIGHTS.COST_BASE +
      HEIGHTS.COST_PHASES +
      HEIGHTS.ATTENTION_BANNER_PER_ITEM +
      HEIGHTS.ACTION_BLOCK_MARGIN +
      2 * HEIGHTS.ACTION_BUTTON +
      HEIGHTS.CARD_GAP;
    expect(estimateCardHeight(app)).toBe(expected);
  });

  it("a venture in development with no waves yet (deploy CTA + Abandon = 2 buttons)", () => {
    const app = makeApp({
      epic: makePlanIssue({ id: "EPIC-1", labels: [] }),
      stage: "development",
      shipType: "venture",
      progress: { closed: 0, total: 0 },
      children: [],
    });
    // dev no-agent, no wave labels, no pipeline:development, no open
    // children: 0 stage buttons + 1 venture deploy + Abandon = 2.
    const expected =
      STRUCTURAL_BASE +
      HEIGHTS.QUICK_LINKS +
      HEIGHTS.SNIPPET +
      HEIGHTS.COST_BASE +
      HEIGHTS.COST_PHASES +
      HEIGHTS.ACTION_BLOCK_MARGIN +
      2 * HEIGHTS.ACTION_BUTTON;
    expect(estimateCardHeight(app)).toBe(expected);
  });

  it("test-spec stage with no agent renders 2 stage buttons + Abandon = 3", () => {
    const app = makeApp({ ...bareApp(), stage: "test-spec" });
    const expected =
      BARE_BASELINE +
      HEIGHTS.SNIPPET +
      HEIGHTS.COST_BASE +
      HEIGHTS.COST_PHASES +
      HEIGHTS.ACTION_BLOCK_MARGIN +
      3 * HEIGHTS.ACTION_BUTTON;
    expect(estimateCardHeight(app)).toBe(expected);
  });

  it("submitted stage renders mark-as-live + Abandon = 2 buttons", () => {
    const app = makeApp({ ...bareApp(), stage: "submitted" });
    const expected =
      BARE_BASELINE +
      HEIGHTS.SNIPPET +
      HEIGHTS.COST_BASE +
      HEIGHTS.COST_PHASES +
      HEIGHTS.ACTION_BLOCK_MARGIN +
      2 * HEIGHTS.ACTION_BUTTON;
    expect(estimateCardHeight(app)).toBe(expected);
  });

  it("live stage renders mark-complete + Abandon = 2 buttons", () => {
    const app = makeApp({ ...bareApp(), stage: "live" });
    const expected =
      BARE_BASELINE +
      HEIGHTS.SNIPPET +
      HEIGHTS.COST_BASE +
      HEIGHTS.COST_PHASES +
      HEIGHTS.ACTION_BLOCK_MARGIN +
      2 * HEIGHTS.ACTION_BUTTON;
    expect(estimateCardHeight(app)).toBe(expected);
  });

  it("returns >= STRUCTURAL_BASE for every defined stage", () => {
    const stages: FleetApp["stage"][] = [
      "idea",
      "research",
      "research-complete",
      "product-spec",
      "architecture",
      "plan-review",
      "test-spec",
      "development",
      "qa",
      "submission-prep",
      "submitted",
      "kit-management",
      "deploying",
      "live",
      "completed",
      "bad-idea",
    ];
    for (const stage of stages) {
      const app = makeApp({
        epic: makePlanIssue({ id: "EPIC-1", labels: [] }),
        stage,
        progress: { closed: 0, total: 0 },
        children: [],
      });
      const h = estimateCardHeight(app);
      expect(h).toBeGreaterThanOrEqual(STRUCTURAL_BASE);
      expect(Number.isInteger(h)).toBe(true);
    }
  });
});

// =============================================================================
// Boundary conditions
// =============================================================================

describe("estimateCardHeight — boundaries", () => {
  it("handles a missing labels array on the epic", () => {
    const epic: PlanIssue = makePlanIssue({ id: "EPIC-1" });
    delete (epic as { labels?: string[] }).labels;
    const app = makeApp({
      epic,
      stage: "bad-idea",
      progress: { closed: 0, total: 0 },
      children: [],
    });
    expect(() => estimateCardHeight(app)).not.toThrow();
    expect(estimateCardHeight(app)).toBe(BARE_BASELINE);
  });

  it("handles a child with missing labels array", () => {
    const child: PlanIssue = makePlanIssue({ id: "C1" });
    delete (child as { labels?: string[] }).labels;
    const app = makeApp({ ...bareApp(), children: [child] });
    expect(() => estimateCardHeight(app)).not.toThrow();
    expect(estimateCardHeight(app)).toBe(BARE_BASELINE);
  });

  it("handles a large progress.total (does not blow up the height)", () => {
    const app = makeApp({
      ...bareApp(),
      progress: { closed: 0, total: 100000 },
    });
    expect(estimateCardHeight(app)).toBe(
      BARE_BASELINE + HEIGHTS.PROGRESS_BAR,
    );
  });

  it("handles many children with wave labels (only one WAVE_INFO contribution)", () => {
    const children = Array.from({ length: 50 }, (_, i) =>
      makePlanIssue({ id: `C${i}`, labels: [`wave:${(i % 3) + 1}`] }),
    );
    const app = makeApp({ ...bareApp(), children });
    expect(estimateCardHeight(app)).toBe(BARE_BASELINE + HEIGHTS.WAVE_INFO);
  });
});
