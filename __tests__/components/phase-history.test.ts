// =============================================================================
// Tests for getPhaseHistory() in src/components/fleet/fleet-utils.ts
// =============================================================================
// Covers: phase history derivation from current pipeline stage, including
//         linear pipeline stages and the terminal "bad-idea" stage.
// =============================================================================

import {
  getPhaseHistory,
  PIPELINE_ORDER,
  FLEET_STAGE_CONFIG,
  type FleetStage,
  type PhaseHistoryEntry,
} from "@/components/fleet/fleet-utils";

// =============================================================================
// PIPELINE_ORDER
// =============================================================================

describe("PIPELINE_ORDER", () => {
  it("should contain 10 linear stages (excluding bad-idea)", () => {
    expect(PIPELINE_ORDER).toHaveLength(10);
  });

  it("should be ordered from idea to completed", () => {
    expect(PIPELINE_ORDER).toEqual([
      "idea",
      "research",
      "research-complete",
      "plan-review",
      "development",
      "qa",
      "submission-prep",
      "submitted",
      "kit-management",
      "completed",
    ]);
  });

  it("should not include bad-idea", () => {
    expect(PIPELINE_ORDER).not.toContain("bad-idea");
  });

  it("every stage in PIPELINE_ORDER should have a FLEET_STAGE_CONFIG entry", () => {
    for (const stage of PIPELINE_ORDER) {
      expect(FLEET_STAGE_CONFIG[stage]).toBeDefined();
    }
  });
});

// =============================================================================
// getPhaseHistory -- basic behavior
// =============================================================================

describe("getPhaseHistory", () => {
  it("returns an entry for each stage in PIPELINE_ORDER", () => {
    const history = getPhaseHistory("idea");
    expect(history).toHaveLength(PIPELINE_ORDER.length);
    expect(history.map((h) => h.stage)).toEqual(PIPELINE_ORDER);
  });

  it("returns exactly one 'current' entry", () => {
    for (const stage of PIPELINE_ORDER) {
      const history = getPhaseHistory(stage);
      const currentEntries = history.filter((h) => h.status === "current");
      expect(currentEntries).toHaveLength(1);
      expect(currentEntries[0].stage).toBe(stage);
    }
  });
});

// =============================================================================
// getPhaseHistory -- first stage (idea)
// =============================================================================

describe("getPhaseHistory -- idea stage", () => {
  let history: PhaseHistoryEntry[];

  beforeAll(() => {
    history = getPhaseHistory("idea");
  });

  it("marks 'idea' as current", () => {
    expect(history[0]).toEqual({ stage: "idea", status: "current" });
  });

  it("marks all subsequent stages as future", () => {
    const futureStages = history.filter((h) => h.status === "future");
    expect(futureStages).toHaveLength(9);
  });

  it("has no past stages", () => {
    const pastStages = history.filter((h) => h.status === "past");
    expect(pastStages).toHaveLength(0);
  });
});

// =============================================================================
// getPhaseHistory -- middle stage (development)
// =============================================================================

describe("getPhaseHistory -- development stage", () => {
  let history: PhaseHistoryEntry[];

  beforeAll(() => {
    history = getPhaseHistory("development");
  });

  it("marks 'development' as current", () => {
    const current = history.find((h) => h.status === "current");
    expect(current).toEqual({ stage: "development", status: "current" });
  });

  it("marks idea, research, research-complete, plan-review as past", () => {
    const pastStages = history.filter((h) => h.status === "past").map((h) => h.stage);
    expect(pastStages).toEqual(["idea", "research", "research-complete", "plan-review"]);
  });

  it("marks qa through completed as future", () => {
    const futureStages = history.filter((h) => h.status === "future").map((h) => h.stage);
    expect(futureStages).toEqual([
      "qa",
      "submission-prep",
      "submitted",
      "kit-management",
      "completed",
    ]);
  });
});

// =============================================================================
// getPhaseHistory -- last stage (completed)
// =============================================================================

describe("getPhaseHistory -- completed stage", () => {
  let history: PhaseHistoryEntry[];

  beforeAll(() => {
    history = getPhaseHistory("completed");
  });

  it("marks 'completed' as current", () => {
    const current = history.find((h) => h.status === "current");
    expect(current).toEqual({ stage: "completed", status: "current" });
  });

  it("marks all preceding stages as past", () => {
    const pastStages = history.filter((h) => h.status === "past");
    expect(pastStages).toHaveLength(9);
  });

  it("has no future stages", () => {
    const futureStages = history.filter((h) => h.status === "future");
    expect(futureStages).toHaveLength(0);
  });
});

// =============================================================================
// getPhaseHistory -- research-complete stage
// =============================================================================

describe("getPhaseHistory -- research-complete stage", () => {
  it("marks idea and research as past", () => {
    const history = getPhaseHistory("research-complete");
    const pastStages = history.filter((h) => h.status === "past").map((h) => h.stage);
    expect(pastStages).toEqual(["idea", "research"]);
  });

  it("marks research-complete as current", () => {
    const history = getPhaseHistory("research-complete");
    const current = history.find((h) => h.status === "current");
    expect(current?.stage).toBe("research-complete");
  });

  it("marks plan-review through completed as future", () => {
    const history = getPhaseHistory("research-complete");
    const futureStages = history.filter((h) => h.status === "future").map((h) => h.stage);
    expect(futureStages).toEqual([
      "plan-review",
      "development",
      "qa",
      "submission-prep",
      "submitted",
      "kit-management",
      "completed",
    ]);
  });
});

// =============================================================================
// getPhaseHistory -- bad-idea (terminal stage)
// =============================================================================

describe("getPhaseHistory -- bad-idea stage", () => {
  let history: PhaseHistoryEntry[];

  beforeAll(() => {
    history = getPhaseHistory("bad-idea");
  });

  it("returns entries for PIPELINE_ORDER stages (not bad-idea itself)", () => {
    expect(history).toHaveLength(PIPELINE_ORDER.length);
    expect(history.map((h) => h.stage)).toEqual(PIPELINE_ORDER);
  });

  it("marks 'idea' as past (app started as an idea before being rejected)", () => {
    expect(history[0]).toEqual({ stage: "idea", status: "past" });
  });

  it("marks all stages after idea as future (never reached)", () => {
    const futureStages = history.filter((h) => h.status === "future");
    expect(futureStages).toHaveLength(9);
  });

  it("has no current entry (bad-idea is not in the linear pipeline)", () => {
    const currentEntries = history.filter((h) => h.status === "current");
    expect(currentEntries).toHaveLength(0);
  });
});

// =============================================================================
// getPhaseHistory -- every linear stage
// =============================================================================

describe("getPhaseHistory -- every linear stage has correct counts", () => {
  it.each(PIPELINE_ORDER.map((stage, idx) => [stage, idx] as [FleetStage, number]))(
    "%s: %d past + 1 current + rest future = 10 total",
    (stage, idx) => {
      const history = getPhaseHistory(stage);
      const past = history.filter((h) => h.status === "past").length;
      const current = history.filter((h) => h.status === "current").length;
      const future = history.filter((h) => h.status === "future").length;

      expect(past).toBe(idx);
      expect(current).toBe(1);
      expect(future).toBe(PIPELINE_ORDER.length - idx - 1);
      expect(past + current + future).toBe(PIPELINE_ORDER.length);
    },
  );
});

// =============================================================================
// getPhaseHistory -- stage order is preserved
// =============================================================================

describe("getPhaseHistory -- ordering", () => {
  it("always returns stages in PIPELINE_ORDER regardless of input", () => {
    const stages: FleetStage[] = [
      "idea",
      "research",
      "development",
      "submitted",
      "completed",
      "bad-idea",
    ];
    for (const stage of stages) {
      const history = getPhaseHistory(stage);
      expect(history.map((h) => h.stage)).toEqual(PIPELINE_ORDER);
    }
  });

  it("past stages always come before current which comes before future", () => {
    const history = getPhaseHistory("submission-prep");
    const statuses = history.map((h) => h.status);
    // All "past" entries should come before "current", which comes before "future"
    const lastPast = statuses.lastIndexOf("past");
    const currentIdx = statuses.indexOf("current");
    const firstFuture = statuses.indexOf("future");

    expect(lastPast).toBeLessThan(currentIdx);
    expect(currentIdx).toBeLessThan(firstFuture);
  });
});
