// =============================================================================
// Tests for src/components/fleet/fleet-utils.ts
// =============================================================================
// Covers: detectStage (pipeline labels + legacy fallback), isAgentRunning,
//         buildFleetApps, computeEpicCosts, FLEET_STAGES, FLEET_STAGE_CONFIG
// =============================================================================

import {
  detectStage,
  isAgentRunning,
  buildFleetApps,
  computeEpicCosts,
  FLEET_STAGES,
  FLEET_STAGE_CONFIG,
  type FleetStage,
} from "@/components/fleet/fleet-utils";
import type { FleetApp } from "@/components/fleet/fleet-utils";
import type { PlanIssue, IssueTokenSummary } from "@/lib/types";

// ---------------------------------------------------------------------------
// Helper: create a mock PlanIssue with sensible defaults
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

function makeTokenSummary(
  overrides: Partial<IssueTokenSummary> & { issue_id: string },
): IssueTokenSummary {
  return {
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cache_read_tokens: 0,
    total_cache_creation_tokens: 0,
    total_tokens: 0,
    total_cost_usd: 0,
    session_count: 0,
    total_duration_ms: 0,
    total_turns: 0,
    first_session: "2026-01-01T00:00:00Z",
    last_session: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeFleetApp(epic: PlanIssue, children: PlanIssue[]): FleetApp {
  const all = [epic, ...children];
  const apps = buildFleetApps(all);
  return apps[0];
}

// =============================================================================
// FLEET_STAGES and FLEET_STAGE_CONFIG
// =============================================================================

describe("FLEET_STAGES", () => {
  it("should have 11 stages", () => {
    expect(FLEET_STAGES).toHaveLength(11);
  });

  it("should include all expected stages in order", () => {
    const expected: FleetStage[] = [
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
      "bad-idea",
    ];
    expect(FLEET_STAGES).toEqual(expected);
  });

  it("should have config for every stage", () => {
    for (const stage of FLEET_STAGES) {
      const config = FLEET_STAGE_CONFIG[stage];
      expect(config).toBeDefined();
      expect(config.label).toBeTruthy();
      expect(config.color).toBeTruthy();
      expect(config.dotColor).toBeTruthy();
    }
  });
});

// =============================================================================
// isAgentRunning
// =============================================================================

describe("isAgentRunning", () => {
  it("returns true when epic has agent:running label", () => {
    const epic = makePlanIssue({ labels: ["pipeline:research", "agent:running"] });
    expect(isAgentRunning(epic)).toBe(true);
  });

  it("returns false when epic does not have agent:running label", () => {
    const epic = makePlanIssue({ labels: ["pipeline:research"] });
    expect(isAgentRunning(epic)).toBe(false);
  });

  it("returns false when epic has no labels", () => {
    const epic = makePlanIssue({ labels: undefined });
    expect(isAgentRunning(epic)).toBe(false);
  });

  it("returns false when labels is empty array", () => {
    const epic = makePlanIssue({ labels: [] });
    expect(isAgentRunning(epic)).toBe(false);
  });
});

// =============================================================================
// detectStage -- Pipeline labels (primary detection)
// =============================================================================

describe("detectStage -- pipeline labels", () => {
  it("returns 'idea' when no pipeline labels exist", () => {
    const epic = makePlanIssue({ issue_type: "epic", labels: [] });
    expect(detectStage(epic, [])).toBe("idea");
  });

  it("returns 'research' for pipeline:research", () => {
    const epic = makePlanIssue({ issue_type: "epic", labels: ["pipeline:research", "agent:running"] });
    expect(detectStage(epic, [])).toBe("research");
  });

  it("returns 'research-complete' for pipeline:research-complete", () => {
    const epic = makePlanIssue({ issue_type: "epic", labels: ["pipeline:research-complete"] });
    expect(detectStage(epic, [])).toBe("research-complete");
  });

  it("returns 'development' for pipeline:development", () => {
    const epic = makePlanIssue({ issue_type: "epic", labels: ["pipeline:development", "agent:running"] });
    expect(detectStage(epic, [])).toBe("development");
  });

  it("returns 'submission-prep' for pipeline:submission-prep", () => {
    const epic = makePlanIssue({ issue_type: "epic", labels: ["pipeline:submission-prep"] });
    expect(detectStage(epic, [])).toBe("submission-prep");
  });

  it("returns 'submitted' for pipeline:submitted", () => {
    const epic = makePlanIssue({ issue_type: "epic", labels: ["pipeline:submitted", "submission:ready"] });
    expect(detectStage(epic, [])).toBe("submitted");
  });

  it("returns 'kit-management' for pipeline:kit-management", () => {
    const epic = makePlanIssue({ issue_type: "epic", labels: ["pipeline:kit-management", "agent:running"] });
    expect(detectStage(epic, [])).toBe("kit-management");
  });

  it("returns 'completed' for pipeline:completed", () => {
    const epic = makePlanIssue({ issue_type: "epic", labels: ["pipeline:completed"], status: "closed" });
    expect(detectStage(epic, [])).toBe("completed");
  });

  it("returns 'bad-idea' for pipeline:bad-idea", () => {
    const epic = makePlanIssue({ issue_type: "epic", labels: ["pipeline:bad-idea"], status: "closed" });
    expect(detectStage(epic, [])).toBe("bad-idea");
  });
});

// =============================================================================
// detectStage -- Priority order (most advanced stage wins)
// =============================================================================

describe("detectStage -- multiple pipeline labels (priority order)", () => {
  it("bad-idea wins over completed", () => {
    const epic = makePlanIssue({ issue_type: "epic", labels: ["pipeline:completed", "pipeline:bad-idea"] });
    expect(detectStage(epic, [])).toBe("bad-idea");
  });

  it("completed wins over kit-management", () => {
    const epic = makePlanIssue({ issue_type: "epic", labels: ["pipeline:kit-management", "pipeline:completed"] });
    expect(detectStage(epic, [])).toBe("completed");
  });

  it("submitted wins over development", () => {
    const epic = makePlanIssue({ issue_type: "epic", labels: ["pipeline:development", "pipeline:submitted"] });
    expect(detectStage(epic, [])).toBe("submitted");
  });

  it("development wins over research", () => {
    const epic = makePlanIssue({ issue_type: "epic", labels: ["pipeline:research", "pipeline:development"] });
    expect(detectStage(epic, [])).toBe("development");
  });

  it("research-complete wins over research", () => {
    const epic = makePlanIssue({ issue_type: "epic", labels: ["pipeline:research", "pipeline:research-complete"] });
    expect(detectStage(epic, [])).toBe("research-complete");
  });

  it("submission-prep wins over development", () => {
    const epic = makePlanIssue({ issue_type: "epic", labels: ["pipeline:development", "pipeline:submission-prep"] });
    expect(detectStage(epic, [])).toBe("submission-prep");
  });
});

// =============================================================================
// detectStage -- Fallback (legacy child-based detection)
// =============================================================================

describe("detectStage -- legacy fallback", () => {
  it("returns 'completed' when epic is closed and has no pipeline labels", () => {
    const epic = makePlanIssue({ issue_type: "epic", status: "closed", labels: [] });
    expect(detectStage(epic, [])).toBe("completed");
  });

  it("returns 'research' from child labels when no pipeline labels exist", () => {
    const epic = makePlanIssue({ issue_type: "epic", labels: [] });
    const child = makePlanIssue({ id: "C-1", epic: "ISSUE-1", labels: ["research"], status: "in_progress" });
    expect(detectStage(epic, [child])).toBe("research");
  });

  it("returns 'development' from child labels when no pipeline labels exist", () => {
    const epic = makePlanIssue({ issue_type: "epic", labels: [] });
    const child = makePlanIssue({ id: "C-1", epic: "ISSUE-1", labels: ["development"], status: "in_progress" });
    expect(detectStage(epic, [child])).toBe("development");
  });

  it("returns 'submitted' from child submission labels when no pipeline labels exist", () => {
    const epic = makePlanIssue({ issue_type: "epic", labels: [] });
    const child = makePlanIssue({ id: "C-1", epic: "ISSUE-1", labels: ["submission:ready"], status: "in_progress" });
    expect(detectStage(epic, [child])).toBe("submitted");
  });

  it("ignores closed children in fallback detection", () => {
    const epic = makePlanIssue({ issue_type: "epic", labels: [] });
    const child = makePlanIssue({ id: "C-1", epic: "ISSUE-1", labels: ["research"], status: "closed" });
    expect(detectStage(epic, [child])).toBe("idea");
  });

  it("returns 'idea' when no labels and no matching children", () => {
    const epic = makePlanIssue({ issue_type: "epic", labels: [] });
    const child = makePlanIssue({ id: "C-1", epic: "ISSUE-1", labels: [], status: "open" });
    expect(detectStage(epic, [child])).toBe("idea");
  });
});

// =============================================================================
// detectStage -- Pipeline labels override fallback
// =============================================================================

describe("detectStage -- pipeline labels override fallback", () => {
  it("pipeline label takes precedence over child labels", () => {
    const epic = makePlanIssue({ issue_type: "epic", labels: ["pipeline:research-complete"] });
    const child = makePlanIssue({ id: "C-1", epic: "ISSUE-1", labels: ["research"], status: "in_progress" });
    expect(detectStage(epic, [child])).toBe("research-complete");
  });

  it("pipeline label takes precedence over closed status", () => {
    const epic = makePlanIssue({ issue_type: "epic", labels: ["pipeline:bad-idea"], status: "closed" });
    expect(detectStage(epic, [])).toBe("bad-idea");
  });

  it("pipeline:completed wins over closed status fallback", () => {
    const epic = makePlanIssue({ issue_type: "epic", labels: ["pipeline:completed"], status: "closed" });
    // Both would resolve to "completed" -- pipeline label is checked first
    expect(detectStage(epic, [])).toBe("completed");
  });
});

// =============================================================================
// detectStage -- Backward compatibility with old-style labels
// =============================================================================

describe("detectStage -- backward compatibility with old labels", () => {
  it("handles epic with old-style 'research' label (no pipeline: prefix)", () => {
    // Old LensCycle epic has labels: ["research"] on the epic itself.
    // This is NOT a pipeline:* label, so it falls through to the fallback.
    // No children, no pipeline labels -> "idea"
    const epic = makePlanIssue({ issue_type: "epic", labels: ["research"] });
    expect(detectStage(epic, [])).toBe("idea");
  });

  it("handles epic with old-style label plus child with matching label", () => {
    const epic = makePlanIssue({ issue_type: "epic", labels: ["research"] });
    const child = makePlanIssue({ id: "C-1", epic: "ISSUE-1", labels: ["research"], status: "in_progress" });
    expect(detectStage(epic, [child])).toBe("research");
  });
});

// =============================================================================
// buildFleetApps
// =============================================================================

describe("buildFleetApps", () => {
  it("extracts only epic-type issues", () => {
    const issues = [
      makePlanIssue({ id: "E-1", issue_type: "epic", title: "App Alpha" }),
      makePlanIssue({ id: "T-1", issue_type: "task", title: "Task 1" }),
      makePlanIssue({ id: "B-1", issue_type: "bug", title: "Bug 1" }),
    ];
    const apps = buildFleetApps(issues);
    expect(apps).toHaveLength(1);
    expect(apps[0].epic.id).toBe("E-1");
  });

  it("returns empty array when no epics exist", () => {
    const issues = [makePlanIssue({ id: "T-1", issue_type: "task" })];
    expect(buildFleetApps(issues)).toEqual([]);
  });

  it("returns empty array for empty input", () => {
    expect(buildFleetApps([])).toEqual([]);
  });

  it("groups children by their epic field", () => {
    const issues = [
      makePlanIssue({ id: "E-1", issue_type: "epic" }),
      makePlanIssue({ id: "E-2", issue_type: "epic" }),
      makePlanIssue({ id: "T-1", issue_type: "task", epic: "E-1" }),
      makePlanIssue({ id: "T-2", issue_type: "task", epic: "E-1" }),
      makePlanIssue({ id: "T-3", issue_type: "task", epic: "E-2" }),
    ];
    const apps = buildFleetApps(issues);
    const app1 = apps.find((a) => a.epic.id === "E-1")!;
    const app2 = apps.find((a) => a.epic.id === "E-2")!;
    expect(app1.children).toHaveLength(2);
    expect(app2.children).toHaveLength(1);
  });

  it("computes progress correctly", () => {
    const issues = [
      makePlanIssue({ id: "E-1", issue_type: "epic" }),
      makePlanIssue({ id: "T-1", issue_type: "task", epic: "E-1", status: "closed" }),
      makePlanIssue({ id: "T-2", issue_type: "task", epic: "E-1", status: "open" }),
      makePlanIssue({ id: "T-3", issue_type: "task", epic: "E-1", status: "closed" }),
    ];
    const apps = buildFleetApps(issues);
    expect(apps[0].progress).toEqual({ closed: 2, total: 3 });
  });

  it("assigns stage based on pipeline labels", () => {
    const issues = [
      makePlanIssue({ id: "E-1", issue_type: "epic", labels: ["pipeline:development"] }),
      makePlanIssue({ id: "T-1", issue_type: "task", epic: "E-1" }),
    ];
    const apps = buildFleetApps(issues);
    expect(apps[0].stage).toBe("development");
  });

  it("assigns stage using fallback when no pipeline labels", () => {
    const issues = [
      makePlanIssue({ id: "E-1", issue_type: "epic" }),
      makePlanIssue({ id: "T-1", issue_type: "task", epic: "E-1", labels: ["development"] }),
    ];
    const apps = buildFleetApps(issues);
    expect(apps[0].stage).toBe("development");
  });
});

// =============================================================================
// computeEpicCosts
// =============================================================================

describe("computeEpicCosts", () => {
  it("returns empty map when no apps", () => {
    expect(computeEpicCosts([], {}).size).toBe(0);
  });

  it("returns empty map when no token usage data matches", () => {
    const epic = makePlanIssue({ id: "E-1", issue_type: "epic" });
    const app = makeFleetApp(epic, []);
    const byIssue = { "OTHER": makeTokenSummary({ issue_id: "OTHER", total_cost_usd: 5 }) };
    expect(computeEpicCosts([app], byIssue).size).toBe(0);
  });

  it("aggregates cost from epic itself as 'other' phase", () => {
    const epic = makePlanIssue({ id: "E-1", issue_type: "epic" });
    const app = makeFleetApp(epic, []);
    const byIssue = { "E-1": makeTokenSummary({ issue_id: "E-1", total_cost_usd: 3.5, session_count: 4 }) };
    const result = computeEpicCosts([app], byIssue);
    const cost = result.get("E-1")!;
    expect(cost.totalCost).toBeCloseTo(3.5);
    expect(cost.phases[0]).toEqual({ phase: "other", cost: 3.5, sessions: 4 });
  });

  it("classifies children by phase labels", () => {
    const epic = makePlanIssue({ id: "E-1", issue_type: "epic" });
    const children = [
      makePlanIssue({ id: "T-1", epic: "E-1", labels: ["research"] }),
      makePlanIssue({ id: "T-2", epic: "E-1", labels: ["development"] }),
      makePlanIssue({ id: "T-3", epic: "E-1", labels: ["submission:ready"] }),
    ];
    const app = makeFleetApp(epic, children);
    const byIssue = {
      "T-1": makeTokenSummary({ issue_id: "T-1", total_cost_usd: 1, session_count: 1 }),
      "T-2": makeTokenSummary({ issue_id: "T-2", total_cost_usd: 2, session_count: 1 }),
      "T-3": makeTokenSummary({ issue_id: "T-3", total_cost_usd: 3, session_count: 1 }),
    };
    const result = computeEpicCosts([app], byIssue);
    const cost = result.get("E-1")!;
    expect(cost.phases.find((p) => p.phase === "research")!.cost).toBeCloseTo(1);
    expect(cost.phases.find((p) => p.phase === "development")!.cost).toBeCloseTo(2);
    expect(cost.phases.find((p) => p.phase === "submission")!.cost).toBeCloseTo(3);
  });

  it("includes kit-management phase in ordering", () => {
    const epic = makePlanIssue({ id: "E-1", issue_type: "epic" });
    const children = [
      makePlanIssue({ id: "T-1", epic: "E-1", labels: ["pipeline:kit-management"] }),
      makePlanIssue({ id: "T-2", epic: "E-1", labels: ["research"] }),
    ];
    const app = makeFleetApp(epic, children);
    const byIssue = {
      "T-1": makeTokenSummary({ issue_id: "T-1", total_cost_usd: 5, session_count: 1 }),
      "T-2": makeTokenSummary({ issue_id: "T-2", total_cost_usd: 3, session_count: 1 }),
    };
    const result = computeEpicCosts([app], byIssue);
    const cost = result.get("E-1")!;
    const phases = cost.phases.map((p) => p.phase);
    expect(phases).toContain("research");
    expect(phases).toContain("kit-management");
    // kit-management should come after research in the order
    expect(phases.indexOf("research")).toBeLessThan(phases.indexOf("kit-management"));
  });

  it("orders phases as research, development, submission, kit-management, other", () => {
    const epic = makePlanIssue({ id: "E-1", issue_type: "epic" });
    const children = [
      makePlanIssue({ id: "T-1", epic: "E-1", labels: ["infra"] }),
      makePlanIssue({ id: "T-2", epic: "E-1", labels: ["submission:beta"] }),
      makePlanIssue({ id: "T-3", epic: "E-1", labels: ["development"] }),
      makePlanIssue({ id: "T-4", epic: "E-1", labels: ["research"] }),
      makePlanIssue({ id: "T-5", epic: "E-1", labels: ["pipeline:kit-management"] }),
    ];
    const app = makeFleetApp(epic, children);
    const byIssue: Record<string, IssueTokenSummary> = {};
    for (const child of children) {
      byIssue[child.id] = makeTokenSummary({ issue_id: child.id, total_cost_usd: 1, session_count: 1 });
    }
    const result = computeEpicCosts([app], byIssue);
    const cost = result.get("E-1")!;
    expect(cost.phases.map((p) => p.phase)).toEqual([
      "research",
      "development",
      "submission",
      "kit-management",
      "other",
    ]);
  });
});
