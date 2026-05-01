// =============================================================================
// Cross-cutting tests for src/lib/repo-config.ts
// =============================================================================
// beads_web-cnr (A.8): integration-surface tests beyond A.2's
// find-repo-for-issue parallel-walk test. These cover getAllRepoPaths + the
// registry read path that feeds into listOpenWaveBeadsAllRepos and the
// cross-repo enumeration route.
// =============================================================================

import path from "path";
import fs from "fs";
import os from "os";

// Mock mysql2/promise (needed because repo-config imports it for probeRepoForIssue)
jest.mock("mysql2/promise");

// Mock dolt-health TCP probe
jest.mock("@/lib/dolt-health", () => ({
  probeDolt: jest.fn(async (host: string, port: number) => ({
    host,
    port,
    category: "reachable",
    latencyMs: 0,
  })),
  clearProbeCache: jest.fn(),
}));

// Mock fs.promises.readFile to control the registry contents
jest.mock("fs", () => {
  const actual = jest.requireActual("fs");
  return {
    ...actual,
    promises: {
      ...actual.promises,
      readFile: jest.fn(),
    },
  };
});

import { promises as fsPromises } from "fs";
const mockReadFile = fsPromises.readFile as jest.MockedFunction<typeof fsPromises.readFile>;

import { getAllRepoPaths, getRepos } from "@/lib/repo-config";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getAllRepoPaths (beads_web-cnr A.8 cross-cutting)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns all configured repo paths in registry order", async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        repos: [
          { name: "factory-core", path: "/repos/factory-core" },
          { name: "beads_web", path: "/repos/beads_web" },
          { name: "StudyCycle", path: "/repos/StudyCycle" },
        ],
        activeRepo: "__all__",
      }),
    );

    const paths = await getAllRepoPaths();
    expect(paths).toEqual([
      "/repos/factory-core",
      "/repos/beads_web",
      "/repos/StudyCycle",
    ]);
  });

  it("returns empty array when no repos are configured", async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ repos: [] }));

    const paths = await getAllRepoPaths();
    expect(paths).toEqual([]);
  });

  it("returns empty array when registry file is missing (error case)", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"));

    const paths = await getAllRepoPaths();
    // readConfig returns { repos: [] } on file read failure
    expect(paths).toEqual([]);
  });

  it("preserves registry order (first repo is the default for kill-switch fallback)", async () => {
    // This test documents the contract that listOpenWaveBeadsAllRepos
    // relies on: when the kill-switch is active, it falls through to
    // allPaths[0]. Registry order must be stable.
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        repos: [
          { name: "primary", path: "/repos/primary" },
          { name: "secondary", path: "/repos/secondary" },
        ],
        activeRepo: "/repos/secondary", // active != first
      }),
    );

    const paths = await getAllRepoPaths();
    expect(paths[0]).toBe("/repos/primary");
    expect(paths).toHaveLength(2);
  });
});

describe("getRepos — registry shape (beads_web-cnr A.8 cross-cutting)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns repos with name and path fields (contract for cross-repo dispatch)", async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        repos: [
          { name: "factory-core", path: "/repos/factory-core" },
          { name: "beads_web", path: "/repos/beads_web" },
        ],
        activeRepo: "__all__",
      }),
    );

    const store = await getRepos();
    expect(store.repos).toHaveLength(2);
    for (const repo of store.repos) {
      expect(repo).toHaveProperty("name");
      expect(repo).toHaveProperty("path");
      expect(typeof repo.name).toBe("string");
      expect(typeof repo.path).toBe("string");
    }
  });

  it("watchDirs is optional and defaults to undefined", async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        repos: [{ name: "test", path: "/repos/test" }],
      }),
    );

    const store = await getRepos();
    expect(store.watchDirs).toBeUndefined();
  });
});
