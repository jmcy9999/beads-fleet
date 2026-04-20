// =============================================================================
// Tests for src/components/fleet/fleet-utils.ts
// =============================================================================
// Covers: detectStage (pipeline labels + legacy fallback), isAgentRunning,
//         buildFleetApps, computeEpicCosts, getWaveInfo, collectWaveNumbers,
//         appHasWave, FLEET_STAGES, FLEET_STAGE_CONFIG
// =============================================================================

import {
  detectStage,
  isAgentRunning,
  buildFleetApps,
  computeEpicCosts,
  getWaveInfo,
  collectWaveNumbers,
  appHasWave,
  getAttentionItems,
  deriveCurrentRound,
  classifyPlanReviewSubState,
  ATTENTION_CONFIG,
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
  it("should have 16 stages", () => {
    expect(FLEET_STAGES).toHaveLength(16);
  });

  it("should include all expected stages in order", () => {
    const expected: FleetStage[] = [
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

  it("returns 'test-spec' for pipeline:test-spec", () => {
    const epic = makePlanIssue({ issue_type: "epic", labels: ["pipeline:test-spec"] });
    expect(detectStage(epic, [])).toBe("test-spec");
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

// =============================================================================
// getWaveInfo (factory-core-cur.1.12)
// =============================================================================

describe("getWaveInfo", () => {
  it("returns null when no children have wave labels", () => {
    const children = [
      makePlanIssue({ id: "T-1", labels: ["development"] }),
      makePlanIssue({ id: "T-2", labels: [] }),
    ];
    expect(getWaveInfo(children)).toBeNull();
  });

  it("returns null for empty children array", () => {
    expect(getWaveInfo([])).toBeNull();
  });

  it("returns wave progress for children with wave labels", () => {
    const children = [
      makePlanIssue({ id: "T-1", labels: ["wave:1"], status: "closed" }),
      makePlanIssue({ id: "T-2", labels: ["wave:1"], status: "open" }),
      makePlanIssue({ id: "T-3", labels: ["wave:2"], status: "open" }),
    ];
    const result = getWaveInfo(children)!;
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ wave: 1, total: 2, closed: 1 });
    expect(result[1]).toEqual({ wave: 2, total: 1, closed: 0 });
  });

  it("handles mixed children (some with wave labels, some without)", () => {
    const children = [
      makePlanIssue({ id: "T-1", labels: ["wave:1"], status: "closed" }),
      makePlanIssue({ id: "T-2", labels: ["development"], status: "open" }),
      makePlanIssue({ id: "T-3", labels: ["wave:2"], status: "open" }),
    ];
    const result = getWaveInfo(children)!;
    expect(result).toHaveLength(2);
    // T-2 is ignored (no wave label)
    expect(result[0]).toEqual({ wave: 1, total: 1, closed: 1 });
  });

  it("correctly counts all closed beads in a wave", () => {
    const children = [
      makePlanIssue({ id: "T-1", labels: ["wave:1"], status: "closed" }),
      makePlanIssue({ id: "T-2", labels: ["wave:1"], status: "closed" }),
      makePlanIssue({ id: "T-3", labels: ["wave:1"], status: "closed" }),
    ];
    const result = getWaveInfo(children)!;
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ wave: 1, total: 3, closed: 3 });
  });

  it("returns waves sorted by wave number", () => {
    const children = [
      makePlanIssue({ id: "T-1", labels: ["wave:3"], status: "open" }),
      makePlanIssue({ id: "T-2", labels: ["wave:1"], status: "closed" }),
      makePlanIssue({ id: "T-3", labels: ["wave:2"], status: "open" }),
    ];
    const result = getWaveInfo(children)!;
    expect(result.map(w => w.wave)).toEqual([1, 2, 3]);
  });

  it("ignores invalid wave labels (non-numeric)", () => {
    const children = [
      makePlanIssue({ id: "T-1", labels: ["wave:abc"], status: "open" }),
      makePlanIssue({ id: "T-2", labels: ["wave:1"], status: "open" }),
    ];
    const result = getWaveInfo(children)!;
    expect(result).toHaveLength(1);
    expect(result[0].wave).toBe(1);
  });

  it("handles children with undefined labels", () => {
    const children = [
      makePlanIssue({ id: "T-1", labels: undefined }),
      makePlanIssue({ id: "T-2", labels: ["wave:1"], status: "open" }),
    ];
    const result = getWaveInfo(children)!;
    expect(result).toHaveLength(1);
  });
});

// =============================================================================
// collectWaveNumbers (factory-core-cur.1.12)
// =============================================================================

describe("collectWaveNumbers", () => {
  it("returns empty array when no apps have waves", () => {
    const epic = makePlanIssue({ id: "E-1", issue_type: "epic" });
    const child = makePlanIssue({ id: "T-1", epic: "E-1", labels: [] });
    const app = makeFleetApp(epic, [child]);
    expect(collectWaveNumbers([app])).toEqual([]);
  });

  it("returns empty array for empty apps", () => {
    expect(collectWaveNumbers([])).toEqual([]);
  });

  it("returns sorted unique wave numbers from one app", () => {
    const epic = makePlanIssue({ id: "E-1", issue_type: "epic" });
    const children = [
      makePlanIssue({ id: "T-1", epic: "E-1", labels: ["wave:2"] }),
      makePlanIssue({ id: "T-2", epic: "E-1", labels: ["wave:1"] }),
      makePlanIssue({ id: "T-3", epic: "E-1", labels: ["wave:3"] }),
    ];
    const app = makeFleetApp(epic, children);
    expect(collectWaveNumbers([app])).toEqual([1, 2, 3]);
  });

  it("deduplicates wave numbers across apps", () => {
    const epic1 = makePlanIssue({ id: "E-1", issue_type: "epic" });
    const epic2 = makePlanIssue({ id: "E-2", issue_type: "epic" });
    const c1 = makePlanIssue({ id: "T-1", epic: "E-1", labels: ["wave:1"] });
    const c2 = makePlanIssue({ id: "T-2", epic: "E-2", labels: ["wave:1"] });
    const c3 = makePlanIssue({ id: "T-3", epic: "E-2", labels: ["wave:2"] });
    const all = [epic1, epic2, c1, c2, c3];
    const apps = buildFleetApps(all);
    expect(collectWaveNumbers(apps)).toEqual([1, 2]);
  });

  it("ignores children without wave labels", () => {
    const epic = makePlanIssue({ id: "E-1", issue_type: "epic" });
    const children = [
      makePlanIssue({ id: "T-1", epic: "E-1", labels: ["wave:1"] }),
      makePlanIssue({ id: "T-2", epic: "E-1", labels: ["development"] }),
    ];
    const app = makeFleetApp(epic, children);
    expect(collectWaveNumbers([app])).toEqual([1]);
  });
});

// =============================================================================
// appHasWave (factory-core-cur.1.12)
// =============================================================================

describe("appHasWave", () => {
  it("returns true when app has children in the specified wave", () => {
    const epic = makePlanIssue({ id: "E-1", issue_type: "epic" });
    const child = makePlanIssue({ id: "T-1", epic: "E-1", labels: ["wave:2"] });
    const app = makeFleetApp(epic, [child]);
    expect(appHasWave(app, 2)).toBe(true);
  });

  it("returns false when app has no children in the specified wave", () => {
    const epic = makePlanIssue({ id: "E-1", issue_type: "epic" });
    const child = makePlanIssue({ id: "T-1", epic: "E-1", labels: ["wave:1"] });
    const app = makeFleetApp(epic, [child]);
    expect(appHasWave(app, 3)).toBe(false);
  });

  it("returns false when app has no wave labels at all", () => {
    const epic = makePlanIssue({ id: "E-1", issue_type: "epic" });
    const child = makePlanIssue({ id: "T-1", epic: "E-1", labels: ["development"] });
    const app = makeFleetApp(epic, [child]);
    expect(appHasWave(app, 1)).toBe(false);
  });

  it("returns false when app has no children", () => {
    const epic = makePlanIssue({ id: "E-1", issue_type: "epic" });
    const app = makeFleetApp(epic, []);
    expect(appHasWave(app, 1)).toBe(false);
  });

  it("handles children with undefined labels", () => {
    const epic = makePlanIssue({ id: "E-1", issue_type: "epic" });
    const child = makePlanIssue({ id: "T-1", epic: "E-1", labels: undefined });
    const app = makeFleetApp(epic, [child]);
    expect(appHasWave(app, 1)).toBe(false);
  });
});

// =============================================================================
// detectStage -- New pipeline label mappings (factory-core-cur.1.19)
// =============================================================================

describe("detectStage -- product-spec and architecture stages (factory-core-lxc.2)", () => {
  it("returns 'product-spec' for pipeline:product-spec", () => {
    const epic = makePlanIssue({ issue_type: "epic", labels: ["pipeline:product-spec"] });
    expect(detectStage(epic, [])).toBe("product-spec");
  });

  it("returns 'architecture' for pipeline:architecture", () => {
    const epic = makePlanIssue({ issue_type: "epic", labels: ["pipeline:architecture"] });
    expect(detectStage(epic, [])).toBe("architecture");
  });

  it("product-spec wins over research-complete", () => {
    const epic = makePlanIssue({ issue_type: "epic", labels: ["pipeline:research-complete", "pipeline:product-spec"] });
    expect(detectStage(epic, [])).toBe("product-spec");
  });

  it("architecture wins over product-spec", () => {
    const epic = makePlanIssue({ issue_type: "epic", labels: ["pipeline:product-spec", "pipeline:architecture"] });
    expect(detectStage(epic, [])).toBe("architecture");
  });

  it("plan-review wins over architecture", () => {
    const epic = makePlanIssue({ issue_type: "epic", labels: ["pipeline:architecture", "pipeline:plan-review"] });
    expect(detectStage(epic, [])).toBe("plan-review");
  });

  it("FLEET_STAGE_CONFIG has product-spec entry", () => {
    expect(FLEET_STAGE_CONFIG["product-spec"]).toEqual({
      label: "Product Spec",
      color: "text-rose-400",
      dotColor: "bg-rose-400",
    });
  });

  it("FLEET_STAGE_CONFIG has architecture entry", () => {
    expect(FLEET_STAGE_CONFIG["architecture"]).toEqual({
      label: "Architecture",
      color: "text-sky-400",
      dotColor: "bg-sky-400",
    });
  });
});

describe("detectStage -- CLAUDE.md pipeline label coverage", () => {
  it("returns 'plan-review' for pipeline:plan-review", () => {
    const epic = makePlanIssue({ issue_type: "epic", labels: ["pipeline:plan-review"] });
    expect(detectStage(epic, [])).toBe("plan-review");
  });

  it("returns 'submission-prep' for pipeline:compliance-check", () => {
    const epic = makePlanIssue({ issue_type: "epic", labels: ["pipeline:compliance-check"] });
    expect(detectStage(epic, [])).toBe("submission-prep");
  });

  it("returns 'submission-prep' for pipeline:package", () => {
    const epic = makePlanIssue({ issue_type: "epic", labels: ["pipeline:package"] });
    expect(detectStage(epic, [])).toBe("submission-prep");
  });

  it("returns 'submitted' for pipeline:awaiting-review", () => {
    const epic = makePlanIssue({ issue_type: "epic", labels: ["pipeline:awaiting-review"] });
    expect(detectStage(epic, [])).toBe("submitted");
  });

  it("returns 'submitted' for pipeline:in-review", () => {
    const epic = makePlanIssue({ issue_type: "epic", labels: ["pipeline:in-review"] });
    expect(detectStage(epic, [])).toBe("submitted");
  });

  it("returns 'qa' for pipeline:qa-round-1", () => {
    const epic = makePlanIssue({ issue_type: "epic", labels: ["pipeline:qa-round-1"] });
    expect(detectStage(epic, [])).toBe("qa");
  });

  it("returns 'qa' for pipeline:qa-round-2", () => {
    const epic = makePlanIssue({ issue_type: "epic", labels: ["pipeline:qa-round-2"] });
    expect(detectStage(epic, [])).toBe("qa");
  });

  it("returns 'qa' for pipeline:ux-polish", () => {
    const epic = makePlanIssue({ issue_type: "epic", labels: ["pipeline:ux-polish"] });
    expect(detectStage(epic, [])).toBe("qa");
  });

  it("returns 'qa' for pipeline:qa-review", () => {
    const epic = makePlanIssue({ issue_type: "epic", labels: ["pipeline:qa-review"] });
    expect(detectStage(epic, [])).toBe("qa");
  });

  it("returns 'qa' for pipeline:security-review", () => {
    const epic = makePlanIssue({ issue_type: "epic", labels: ["pipeline:security-review"] });
    expect(detectStage(epic, [])).toBe("qa");
  });

  it("returns 'development' for pipeline:build-review", () => {
    const epic = makePlanIssue({ issue_type: "epic", labels: ["pipeline:build-review"] });
    expect(detectStage(epic, [])).toBe("development");
  });

  it("returns 'deploying' for pipeline:deploying", () => {
    const epic = makePlanIssue({ issue_type: "epic", labels: ["pipeline:deploying"] });
    expect(detectStage(epic, [])).toBe("deploying");
  });

  it("returns 'live' for pipeline:live", () => {
    const epic = makePlanIssue({ issue_type: "epic", labels: ["pipeline:live"] });
    expect(detectStage(epic, [])).toBe("live");
  });
});

// =============================================================================
// getAttentionItems — surface human review gates (factory-core-509.1)
// =============================================================================

describe("getAttentionItems", () => {
  function appOf(epic: PlanIssue, children: PlanIssue[] = []): FleetApp {
    return makeFleetApp(epic, children);
  }

  // -------------------------------------------------------------------------
  // Configuration sanity
  // -------------------------------------------------------------------------

  describe("ATTENTION_CONFIG", () => {
    it("defines a config entry for every attention type", () => {
      expect(ATTENTION_CONFIG["verification-needed"].sourceLabel).toBe("checkpoint:human-verify");
      expect(ATTENTION_CONFIG["decision-required"].sourceLabel).toBe("checkpoint:decision");
      expect(ATTENTION_CONFIG["human-action"].sourceLabel).toBe("checkpoint:human-action");
      expect(ATTENTION_CONFIG["qa-review"].sourceLabel).toBe("qa:needs-review");
      // human-flagged has no source label — driven by child label
      expect(ATTENTION_CONFIG["human-flagged"].sourceLabel).toBeUndefined();
    });

    it("verification-needed offers Approve action", () => {
      expect(ATTENTION_CONFIG["verification-needed"].actions).toEqual([
        { name: "human-approve", label: "Approve" },
      ]);
    });

    it("decision-required, human-action, qa-review, human-flagged offer Dismiss action", () => {
      for (const t of ["decision-required", "human-action", "qa-review", "human-flagged"] as const) {
        expect(ATTENTION_CONFIG[t].actions).toEqual([
          { name: "human-dismiss", label: "Dismiss" },
        ]);
      }
    });

    it("uses canonical reason text for each type", () => {
      expect(ATTENTION_CONFIG["verification-needed"].reason).toBe("Human Verification Required");
      expect(ATTENTION_CONFIG["decision-required"].reason).toBe("Decision Required");
      expect(ATTENTION_CONFIG["human-action"].reason).toBe("Human Action Required");
      expect(ATTENTION_CONFIG["qa-review"].reason).toBe("QA Review Needed");
      expect(ATTENTION_CONFIG["human-flagged"].reason).toBe("Flagged for Human Decision");
    });
  });

  // -------------------------------------------------------------------------
  // Detection — happy paths per attention type
  // -------------------------------------------------------------------------

  it("detects checkpoint:human-verify as verification-needed", () => {
    const epic = makePlanIssue({
      id: "EPIC-1",
      issue_type: "epic",
      labels: ["pipeline:development", "checkpoint:human-verify"],
    });
    const items = getAttentionItems(appOf(epic));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      epicId: "EPIC-1",
      type: "verification-needed",
      reason: "Human Verification Required",
      targetLabel: "checkpoint:human-verify",
      actions: [{ name: "human-approve", label: "Approve" }],
    });
  });

  it("detects checkpoint:decision as decision-required", () => {
    const epic = makePlanIssue({
      id: "EPIC-2",
      issue_type: "epic",
      labels: ["pipeline:plan-review", "checkpoint:decision"],
    });
    const items = getAttentionItems(appOf(epic));
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("decision-required");
    expect(items[0].reason).toBe("Decision Required");
    expect(items[0].targetLabel).toBe("checkpoint:decision");
  });

  it("detects checkpoint:human-action as human-action", () => {
    const epic = makePlanIssue({
      id: "EPIC-3",
      issue_type: "epic",
      labels: ["pipeline:development", "checkpoint:human-action"],
    });
    const items = getAttentionItems(appOf(epic));
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("human-action");
    expect(items[0].reason).toBe("Human Action Required");
    expect(items[0].targetLabel).toBe("checkpoint:human-action");
  });

  it("detects qa:needs-review as qa-review", () => {
    const epic = makePlanIssue({
      id: "EPIC-4",
      issue_type: "epic",
      labels: ["pipeline:qa", "qa:needs-review"],
    });
    const items = getAttentionItems(appOf(epic));
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("qa-review");
    expect(items[0].reason).toBe("QA Review Needed");
    expect(items[0].targetLabel).toBe("qa:needs-review");
  });

  it("detects child bead with `human` label as human-flagged with bead context", () => {
    const epic = makePlanIssue({
      id: "EPIC-5",
      issue_type: "epic",
      labels: ["pipeline:development"],
    });
    const child = makePlanIssue({
      id: "EPIC-5.1",
      title: "Investigate Dolt connection failure",
      epic: "EPIC-5",
      labels: ["human"],
    });
    const items = getAttentionItems(appOf(epic, [child]));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      epicId: "EPIC-5",
      beadId: "EPIC-5.1",
      beadTitle: "Investigate Dolt connection failure",
      type: "human-flagged",
      reason: "Flagged for Human Decision",
    });
    expect(items[0].targetLabel).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Detection — empty / negative cases
  // -------------------------------------------------------------------------

  it("returns empty array when no attention labels are present", () => {
    const epic = makePlanIssue({
      id: "EPIC-N1",
      issue_type: "epic",
      labels: ["pipeline:development", "ship-type:internal"],
    });
    expect(getAttentionItems(appOf(epic))).toEqual([]);
  });

  it("returns empty array when epic has no labels at all", () => {
    const epic = makePlanIssue({ id: "EPIC-N2", issue_type: "epic", labels: undefined });
    expect(getAttentionItems(appOf(epic))).toEqual([]);
  });

  it("returns empty array for closed epic with stale checkpoint:human-verify", () => {
    const epic = makePlanIssue({
      id: "EPIC-N3",
      issue_type: "epic",
      status: "closed",
      labels: ["pipeline:completed", "checkpoint:human-verify"],
    });
    expect(getAttentionItems(appOf(epic))).toEqual([]);
  });

  it("returns empty array for closed epic with child carrying `human` label", () => {
    const epic = makePlanIssue({
      id: "EPIC-N4",
      issue_type: "epic",
      status: "closed",
      labels: ["pipeline:completed"],
    });
    const child = makePlanIssue({
      id: "EPIC-N4.1",
      epic: "EPIC-N4",
      labels: ["human"],
    });
    expect(getAttentionItems(appOf(epic, [child]))).toEqual([]);
  });

  it("excludes a previously labelled epic once the label has been removed", () => {
    const epic = makePlanIssue({
      id: "EPIC-N5",
      issue_type: "epic",
      labels: ["pipeline:development"], // checkpoint:human-verify removed
    });
    expect(getAttentionItems(appOf(epic))).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Detection — robustness
  // -------------------------------------------------------------------------

  it("safely skips children with null/undefined labels", () => {
    const epic = makePlanIssue({
      id: "EPIC-R1",
      issue_type: "epic",
      labels: ["pipeline:development", "checkpoint:human-verify"],
    });
    const child1 = makePlanIssue({ id: "EPIC-R1.1", epic: "EPIC-R1", labels: undefined });
    const child2 = makePlanIssue({ id: "EPIC-R1.2", epic: "EPIC-R1", labels: undefined });
    const items = getAttentionItems(appOf(epic, [child1, child2]));
    // Only the epic-level checkpoint should produce an item; no errors thrown.
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("verification-needed");
  });

  it("safely handles children with empty labels arrays", () => {
    const epic = makePlanIssue({ id: "EPIC-R2", issue_type: "epic", labels: [] });
    const child = makePlanIssue({ id: "EPIC-R2.1", epic: "EPIC-R2", labels: [] });
    expect(getAttentionItems(appOf(epic, [child]))).toEqual([]);
  });

  it("returns multiple items when epic has multiple attention labels", () => {
    const epic = makePlanIssue({
      id: "EPIC-M1",
      issue_type: "epic",
      labels: [
        "pipeline:development",
        "checkpoint:human-verify",
        "checkpoint:decision",
        "qa:needs-review",
      ],
    });
    const items = getAttentionItems(appOf(epic));
    expect(items).toHaveLength(3);
    const types = items.map((i) => i.type).sort();
    expect(types).toEqual(["decision-required", "qa-review", "verification-needed"]);
  });

  it("returns one item per child when multiple children carry `human`", () => {
    const epic = makePlanIssue({ id: "EPIC-M2", issue_type: "epic", labels: ["pipeline:development"] });
    const c1 = makePlanIssue({ id: "EPIC-M2.1", epic: "EPIC-M2", labels: ["human"], title: "Bead one" });
    const c2 = makePlanIssue({ id: "EPIC-M2.2", epic: "EPIC-M2", labels: ["human"], title: "Bead two" });
    const items = getAttentionItems(appOf(epic, [c1, c2]));
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.beadId).sort()).toEqual(["EPIC-M2.1", "EPIC-M2.2"]);
    expect(items.map((i) => i.beadTitle).sort()).toEqual(["Bead one", "Bead two"]);
  });

  it("combines epic-level and child-level items on the same app", () => {
    const epic = makePlanIssue({
      id: "EPIC-M3",
      issue_type: "epic",
      labels: ["pipeline:development", "checkpoint:human-verify"],
    });
    const child = makePlanIssue({ id: "EPIC-M3.1", epic: "EPIC-M3", labels: ["human"] });
    const items = getAttentionItems(appOf(epic, [child]));
    expect(items).toHaveLength(2);
    expect(items.find((i) => i.type === "verification-needed")).toBeDefined();
    expect(items.find((i) => i.type === "human-flagged")).toBeDefined();
  });

  it("produces stable ids unique within an app", () => {
    const epic = makePlanIssue({
      id: "EPIC-ID",
      issue_type: "epic",
      labels: ["pipeline:development", "checkpoint:human-verify", "checkpoint:decision"],
    });
    const child = makePlanIssue({ id: "EPIC-ID.1", epic: "EPIC-ID", labels: ["human"] });
    const ids = getAttentionItems(appOf(epic, [child])).map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("EPIC-ID:checkpoint:human-verify");
    expect(ids).toContain("EPIC-ID:checkpoint:decision");
    expect(ids).toContain("EPIC-ID:human:EPIC-ID.1");
  });

  // -------------------------------------------------------------------------
  // Detection — performance & purity
  // -------------------------------------------------------------------------

  it("is a pure function — repeated calls return equivalent results", () => {
    const epic = makePlanIssue({
      id: "EPIC-P1",
      issue_type: "epic",
      labels: ["pipeline:development", "checkpoint:human-verify"],
    });
    const a = getAttentionItems(appOf(epic));
    const b = getAttentionItems(appOf(epic));
    expect(a).toEqual(b);
  });

  it("completes synchronously for 50 epics × 20 children each (perf smoke)", () => {
    // Build 50 apps, each with 20 children, half flagged with `human`.
    const apps: FleetApp[] = [];
    for (let e = 0; e < 50; e++) {
      const epic = makePlanIssue({
        id: `EPIC-PERF-${e}`,
        issue_type: "epic",
        labels: ["pipeline:development", "checkpoint:human-verify"],
      });
      const children: PlanIssue[] = [];
      for (let c = 0; c < 20; c++) {
        children.push(
          makePlanIssue({
            id: `EPIC-PERF-${e}.${c}`,
            epic: `EPIC-PERF-${e}`,
            labels: c % 2 === 0 ? ["human"] : [],
          }),
        );
      }
      apps.push(makeFleetApp(epic, children));
    }
    const start = Date.now();
    const totals = apps.map((a) => getAttentionItems(a).length);
    const elapsed = Date.now() - start;
    // Each epic: 1 (checkpoint) + 10 (every other child) = 11 items
    expect(totals.every((n) => n === 11)).toBe(true);
    expect(elapsed).toBeLessThan(500); // generous — synchronous detection is microseconds
  });
});

// =============================================================================
// factory-core-k7gy.6 — plan-review auto-chain helpers
// =============================================================================

describe("deriveCurrentRound (k7gy.6 F8 AC)", () => {
  it("returns 0 when no plan:revise-round-* labels are present", () => {
    expect(deriveCurrentRound(["plan:needs-revision"])).toBe(0);
  });

  it("returns 1 when only plan:revise-round-1 is present", () => {
    expect(
      deriveCurrentRound(["plan:needs-revision", "plan:revise-round-1"]),
    ).toBe(1);
  });

  it("returns the highest numeric suffix when cumulative labels are present (ADR-004)", () => {
    expect(
      deriveCurrentRound([
        "plan:needs-revision",
        "plan:revise-round-1",
        "plan:revise-round-2",
      ]),
    ).toBe(2);
  });

  it("returns 3 at the cap", () => {
    expect(
      deriveCurrentRound([
        "plan:revise-round-1",
        "plan:revise-round-2",
        "plan:revise-round-3",
      ]),
    ).toBe(3);
  });

  it("is future-proof against double-digit round labels", () => {
    expect(deriveCurrentRound(["plan:revise-round-10"])).toBe(10);
  });

  it("returns 3 when only the round-3 label is present (independent of earlier labels)", () => {
    expect(deriveCurrentRound(["plan:revise-round-3"])).toBe(3);
  });

  it("ignores unrelated labels", () => {
    expect(
      deriveCurrentRound(["pipeline:plan-review", "wave:1", "ship-type:internal"]),
    ).toBe(0);
  });
});

describe("classifyPlanReviewSubState (k7gy.6 F8 AC)", () => {
  it("returns 'reviewing' when plan:reviewing is present", () => {
    expect(classifyPlanReviewSubState(["plan:reviewing", "agent:running"]))
      .toBe("reviewing");
  });

  it("returns 'needs-revision-round-1-or-2' for round 1", () => {
    expect(
      classifyPlanReviewSubState([
        "plan:needs-revision",
        "plan:revise-round-1",
      ]),
    ).toBe("needs-revision-round-1-or-2");
  });

  it("returns 'needs-revision-round-1-or-2' for round 2", () => {
    expect(
      classifyPlanReviewSubState([
        "plan:needs-revision",
        "plan:revise-round-1",
        "plan:revise-round-2",
      ]),
    ).toBe("needs-revision-round-1-or-2");
  });

  it("returns 'needs-revision-round-3' at the cap", () => {
    expect(
      classifyPlanReviewSubState([
        "plan:needs-revision",
        "plan:revise-round-1",
        "plan:revise-round-2",
        "plan:revise-round-3",
      ]),
    ).toBe("needs-revision-round-3");
  });

  it("returns 'reviewed' transient state", () => {
    expect(classifyPlanReviewSubState(["plan:reviewed"])).toBe("reviewed");
  });

  it("returns 'approved' unchanged from pre-k7gy", () => {
    expect(classifyPlanReviewSubState(["plan:approved", "pipeline:test-spec"]))
      .toBe("approved");
  });

  it("returns 'pending' for the owner-override path", () => {
    expect(classifyPlanReviewSubState(["plan:pending"])).toBe("pending");
  });

  it("returns 'none' when no plan:* label is present", () => {
    expect(classifyPlanReviewSubState(["pipeline:plan-review"])).toBe("none");
  });

  it("plan:reviewing wins deterministically when both plan:reviewing and plan:needs-revision are present (regression #7)", () => {
    expect(
      classifyPlanReviewSubState(["plan:reviewing", "plan:needs-revision"]),
    ).toBe("reviewing");
  });
});

describe("detectStage — plan-review auto-chain mappings (k7gy.6 F8 AC5)", () => {
  it("plan:reviewing maps to plan-review column", () => {
    const epic = makePlanIssue({
      issue_type: "epic",
      labels: ["plan:reviewing", "agent:running"],
    });
    expect(detectStage(epic, [])).toBe("plan-review");
  });

  it("plan:reviewed maps to plan-review column", () => {
    const epic = makePlanIssue({
      issue_type: "epic",
      labels: ["plan:reviewed"],
    });
    expect(detectStage(epic, [])).toBe("plan-review");
  });

  it("plan:needs-revision maps to plan-review column", () => {
    const epic = makePlanIssue({
      issue_type: "epic",
      labels: ["plan:needs-revision", "plan:revise-round-1"],
    });
    expect(detectStage(epic, [])).toBe("plan-review");
  });

  it("plan:pending still maps to plan-review (regression-safe — pre-k7gy path)", () => {
    const epic = makePlanIssue({
      issue_type: "epic",
      labels: ["pipeline:research-complete", "plan:pending"],
    });
    expect(detectStage(epic, [])).toBe("plan-review");
  });

  it("plan:approved still maps to plan-review (existing behaviour preserved)", () => {
    const epic = makePlanIssue({
      issue_type: "epic",
      labels: ["pipeline:research-complete", "plan:approved"],
    });
    expect(detectStage(epic, [])).toBe("plan-review");
  });
});
