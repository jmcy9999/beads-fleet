import { resolveRepoPath, sanitizeTopicName } from "@/lib/repo-path-resolver";

const FLEET_CORE_PATH = "/Users/janemckay/dev/fleet/fleet-core";
const PRODUCT_REPO_BASE = "/Users/janemckay/dev/claude_projects";

describe("sanitizeTopicName", () => {
  it("converts to lowercase and replaces spaces with hyphens", () => {
    expect(sanitizeTopicName("LensCycle Recon")).toBe("lenscycle-recon");
  });

  it("strips punctuation and special characters", () => {
    expect(sanitizeTopicName("Shipyard-as-a-Product: Research")).toBe(
      "shipyard-as-a-product-research"
    );
  });

  it("limits to 5 words max", () => {
    expect(
      sanitizeTopicName("This Is A Very Long Epic Title With Many Words")
    ).toBe("this-is-a-very-long");
  });

  it("strips leading/trailing hyphens", () => {
    expect(sanitizeTopicName("- Research & Analysis -")).toBe(
      "research-analysis"
    );
  });
});

describe("resolveRepoPath", () => {
  const epicId = "fleet-core-abc";
  const appName = "LensCycle";
  const fleetCorePath = FLEET_CORE_PATH;

  describe("venture ship type", () => {
    it("returns fleet-core repo with docs/research path", () => {
      const result = resolveRepoPath(
        "venture",
        "LensCycle Opportunity",
        appName,
        epicId,
        fleetCorePath
      );

      expect(result.repoPath).toBe(fleetCorePath);
      expect(result.repoName).toBe("fleet-core");
      expect(result.researchPath).toBe(
        `${fleetCorePath}/docs/research/lenscycle-opportunity.md`
      );
      expect(result.planPath).toBeUndefined();
    });
  });

  describe("internal ship type", () => {
    it("returns beads_web repo when title mentions dashboard", () => {
      const result = resolveRepoPath(
        "internal",
        "Dashboard: Add repo path resolver",
        "Dashboard",
        epicId,
        fleetCorePath
      );

      expect(result.repoPath).toBe(`${PRODUCT_REPO_BASE}/beads_web`);
      expect(result.repoName).toBe("beads_web");
      expect(result.researchPath).toBe(
        `${fleetCorePath}/docs/research/dashboard-add-repo-path-resolver.md`
      );
      expect(result.planPath).toBe(
        `${PRODUCT_REPO_BASE}/beads_web/.beads/plans/${epicId}.md`
      );
    });

    it("returns beads_web repo when title mentions beads_web", () => {
      const result = resolveRepoPath(
        "internal",
        "beads_web: Fix agent launcher",
        "BeadsWeb",
        epicId,
        fleetCorePath
      );

      expect(result.repoPath).toBe(`${PRODUCT_REPO_BASE}/beads_web`);
      expect(result.repoName).toBe("beads_web");
    });

    it("returns beads_web repo when title mentions fleet board", () => {
      const result = resolveRepoPath(
        "internal",
        "Fleet Board: Pipeline improvements",
        "FleetBoard",
        epicId,
        fleetCorePath
      );

      expect(result.repoPath).toBe(`${PRODUCT_REPO_BASE}/beads_web`);
      expect(result.repoName).toBe("beads_web");
    });

    it("returns fleet-core repo for other internal work", () => {
      const result = resolveRepoPath(
        "internal",
        "Pipeline: Add new stage",
        "Pipeline",
        epicId,
        fleetCorePath
      );

      expect(result.repoPath).toBe(fleetCorePath);
      expect(result.repoName).toBe("fleet-core");
      expect(result.researchPath).toBe(
        `${fleetCorePath}/docs/research/pipeline-add-new-stage.md`
      );
      expect(result.planPath).toBe(
        `${fleetCorePath}/.beads/plans/${epicId}.md`
      );
    });
  });

  describe("product ship types", () => {
    it("returns product repo for ios-app", () => {
      const result = resolveRepoPath(
        "ios-app",
        "LensCycle: Cycle Tracking App",
        appName,
        epicId,
        fleetCorePath
      );

      expect(result.repoPath).toBe(`${PRODUCT_REPO_BASE}/${appName}`);
      expect(result.repoName).toBe(appName);
      expect(result.researchPath).toBe(
        `${fleetCorePath}/products/${appName}/research/report.md`
      );
      expect(result.planPath).toBe(
        `${PRODUCT_REPO_BASE}/${appName}/.beads/plans/${epicId}.md`
      );
    });

    it("returns product repo for macos-app", () => {
      const result = resolveRepoPath(
        "macos-app",
        "DeskTimer: Pomodoro Timer",
        "DeskTimer",
        epicId,
        fleetCorePath
      );

      expect(result.repoPath).toBe(`${PRODUCT_REPO_BASE}/DeskTimer`);
      expect(result.repoName).toBe("DeskTimer");
      expect(result.researchPath).toBe(
        `${fleetCorePath}/products/DeskTimer/research/report.md`
      );
      expect(result.planPath).toBe(
        `${PRODUCT_REPO_BASE}/DeskTimer/.beads/plans/${epicId}.md`
      );
    });

    it("returns product repo for web-app", () => {
      const result = resolveRepoPath(
        "web-app",
        "TaskFlow: Task Manager",
        "TaskFlow",
        epicId,
        fleetCorePath
      );

      expect(result.repoPath).toBe(`${PRODUCT_REPO_BASE}/TaskFlow`);
      expect(result.repoName).toBe("TaskFlow");
    });

    it("returns product repo for wordpress-plugin", () => {
      const result = resolveRepoPath(
        "wordpress-plugin",
        "EasyForms: Form Builder",
        "EasyForms",
        epicId,
        fleetCorePath
      );

      expect(result.repoPath).toBe(`${PRODUCT_REPO_BASE}/EasyForms`);
      expect(result.repoName).toBe("EasyForms");
    });

    it("returns product repo for python-tool", () => {
      const result = resolveRepoPath(
        "python-tool",
        "DataSync: CSV Processor",
        "DataSync",
        epicId,
        fleetCorePath
      );

      expect(result.repoPath).toBe(`${PRODUCT_REPO_BASE}/DataSync`);
      expect(result.repoName).toBe("DataSync");
    });

    it("returns product repo for game", () => {
      const result = resolveRepoPath(
        "game",
        "SpaceRunner: Endless Runner",
        "SpaceRunner",
        epicId,
        fleetCorePath
      );

      expect(result.repoPath).toBe(`${PRODUCT_REPO_BASE}/SpaceRunner`);
      expect(result.repoName).toBe("SpaceRunner");
    });
  });
});
