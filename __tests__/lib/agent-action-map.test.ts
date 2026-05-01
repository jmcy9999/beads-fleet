/**
 * Tests for the canonical agent-type to fleet-action mapping.
 *
 * @see beads_web-qfd (DRY refactor extracting getActionForAgent)
 */
import { getActionForAgent } from "../../src/lib/agent-action-map";

describe("getActionForAgent", () => {
  it("maps all 10 canonical agent types to their action names", () => {
    expect(getActionForAgent("architect")).toBe("run-architect");
    expect(getActionForAgent("planner")).toBe("generate-plan");
    expect(getActionForAgent("builder")).toBe("start-wave");
    expect(getActionForAgent("reviewer")).toBe("review-wave");
    expect(getActionForAgent("qa")).toBe("send-for-qa");
    expect(getActionForAgent("polish")).toBe("send-for-polish");
    expect(getActionForAgent("test-spec")).toBe("run-test-spec");
    expect(getActionForAgent("product-manager")).toBe("run-pm");
    expect(getActionForAgent("operator")).toBe("send-for-review");
    expect(getActionForAgent("coherence")).toBe("run-coherence-agent");
  });

  it("falls back to run-<agentType> for unknown agent types", () => {
    // Force the fallback path by casting to AgentType.
    // In production, this path fires only if a new AgentType is added
    // to the union but not yet to the mapping table.
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const result = getActionForAgent("deployer" as any);
    expect(result).toBe("run-deployer");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("unknown agent type 'deployer'"),
    );
    warnSpy.mockRestore();
  });
});
