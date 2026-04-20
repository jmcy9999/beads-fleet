import { promises as fs } from "fs";
import os from "os";
import path from "path";
import {
  resolveRepoPath,
  sanitizeTopicName,
  findExistingDocPath,
} from "@/lib/repo-path-resolver";

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

  it("returns empty string for empty input", () => {
    expect(sanitizeTopicName("")).toBe("");
  });

  it("returns empty string for whitespace-only input", () => {
    expect(sanitizeTopicName("   ")).toBe("");
  });

  it("returns empty string for special-characters-only input", () => {
    expect(sanitizeTopicName("!@#$%")).toBe("");
  });

  it("handles numeric strings with spaces", () => {
    expect(sanitizeTopicName("123 456")).toBe("123-456");
  });

  // factory-core-k7gy.13: underscores in epic titles (e.g. "beads_web") used
  // to be stripped entirely, producing "beadsweb-…" which never matched the
  // on-disk file "beads-web-…". They must now convert to hyphens.
  it("converts underscores to hyphens", () => {
    expect(sanitizeTopicName("beads_web concurrency safety")).toBe(
      "beads-web-concurrency-safety",
    );
  });

  it("handles multiple underscores in a single word", () => {
    expect(sanitizeTopicName("snake_case_word research")).toBe(
      "snake-case-word-research",
    );
  });
});

// factory-core-k7gy.13: filesystem-aware doc-path resolver. The naive
// sanitise/truncate slug does not always match what's actually on disk
// (research docs are often named with fewer or different words). Before
// handing a derived path to an agent, prefer a file that actually exists.
describe("findExistingDocPath", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "k7gy13-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns the naive path when it exists", async () => {
    const naive = path.join(tmpDir, "exact-topic-functional-spec.md");
    await fs.writeFile(naive, "body", "utf-8");

    const result = await findExistingDocPath({
      naivePath: naive,
      searchDir: tmpDir,
      slug: "exact-topic",
      suffix: "-functional-spec.md",
    });
    expect(result).toBe(naive);
  });

  // The k7gy.13 scenario: derived slug is longer than what's on disk.
  // On-disk file uses 3 words of the title; derived uses 5. Fallback
  // must find the shorter match.
  it("finds a shorter-slug on-disk file when the derived slug overshoots", async () => {
    const onDisk = path.join(tmpDir, "beads-web-concurrency-safety-functional-spec.md");
    await fs.writeFile(onDisk, "body", "utf-8");

    const naive = path.join(
      tmpDir,
      "beads-web-concurrency-safety-support-multiple-functional-spec.md",
    );

    const result = await findExistingDocPath({
      naivePath: naive,
      searchDir: tmpDir,
      slug: "beads-web-concurrency-safety-support-multiple",
      suffix: "-functional-spec.md",
    });
    expect(result).toBe(onDisk);
  });

  it("falls back to the naive path when no match exists", async () => {
    const naive = path.join(tmpDir, "nothing-here-functional-spec.md");

    const result = await findExistingDocPath({
      naivePath: naive,
      searchDir: tmpDir,
      slug: "nothing-here",
      suffix: "-functional-spec.md",
    });
    expect(result).toBe(naive);
  });

  it("prefers the longest-matching prefix when multiple candidates exist", async () => {
    const short = path.join(tmpDir, "beads-web-functional-spec.md");
    const longer = path.join(
      tmpDir,
      "beads-web-concurrency-safety-functional-spec.md",
    );
    const unrelated = path.join(tmpDir, "unrelated-topic-functional-spec.md");
    await fs.writeFile(short, "short", "utf-8");
    await fs.writeFile(longer, "longer", "utf-8");
    await fs.writeFile(unrelated, "unrelated", "utf-8");

    const result = await findExistingDocPath({
      naivePath: path.join(tmpDir, "beads-web-concurrency-safety-support-multiple-functional-spec.md"),
      searchDir: tmpDir,
      slug: "beads-web-concurrency-safety-support-multiple",
      suffix: "-functional-spec.md",
    });
    // The 'longer' candidate shares 3 leading tokens with the slug
    // (beads-web-concurrency-safety) vs 'short' which shares only 2
    // (beads-web). Longest-prefix wins.
    expect(result).toBe(longer);
  });

  it("does not match files with a different suffix even if slug matches", async () => {
    const arch = path.join(tmpDir, "beads-web-concurrency-safety-architecture.md");
    await fs.writeFile(arch, "arch", "utf-8");

    const naive = path.join(
      tmpDir,
      "beads-web-concurrency-safety-support-multiple-functional-spec.md",
    );
    const result = await findExistingDocPath({
      naivePath: naive,
      searchDir: tmpDir,
      slug: "beads-web-concurrency-safety-support-multiple",
      suffix: "-functional-spec.md",
    });
    // No matching -functional-spec.md — must fall back to naive
    expect(result).toBe(naive);
  });

  it("handles a missing searchDir gracefully (returns naive)", async () => {
    const naive = "/tmp/some-nonexistent-directory-xyz/a-functional-spec.md";
    const result = await findExistingDocPath({
      naivePath: naive,
      searchDir: "/tmp/some-nonexistent-directory-xyz",
      slug: "a",
      suffix: "-functional-spec.md",
    });
    expect(result).toBe(naive);
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

    it("returns undefined for specPath and architecturePath (ventures skip PM/Architect)", () => {
      const result = resolveRepoPath(
        "venture",
        "LensCycle Opportunity",
        appName,
        epicId,
        fleetCorePath
      );

      expect(result.specPath).toBeUndefined();
      expect(result.architecturePath).toBeUndefined();
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

    it("returns correct specPath and architecturePath for internal fleet-core work", () => {
      const result = resolveRepoPath(
        "internal",
        "Pipeline: Add new stage",
        "Pipeline",
        epicId,
        fleetCorePath
      );

      expect(result.specPath).toBe(
        `${fleetCorePath}/docs/research/pipeline-add-new-stage-functional-spec.md`
      );
      expect(result.architecturePath).toBe(
        `${fleetCorePath}/docs/research/pipeline-add-new-stage-architecture.md`
      );
    });

    it("returns correct specPath and architecturePath for beads_web work", () => {
      const result = resolveRepoPath(
        "internal",
        "Dashboard: Add repo path resolver",
        "Dashboard",
        epicId,
        fleetCorePath
      );

      expect(result.specPath).toBe(
        `${fleetCorePath}/docs/research/dashboard-add-repo-path-resolver-functional-spec.md`
      );
      expect(result.architecturePath).toBe(
        `${fleetCorePath}/docs/research/dashboard-add-repo-path-resolver-architecture.md`
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
      expect(result.specPath).toBe(
        `${fleetCorePath}/products/${appName}/research/functional-spec.md`
      );
      expect(result.architecturePath).toBe(
        `${fleetCorePath}/products/${appName}/research/architecture.md`
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
