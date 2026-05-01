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

// Mock fs — readFile for existing tests; existsSync, copyFile, writeFile,
// readdir, unlink for beads_web-u67 backup-before-write tests.
jest.mock("fs", () => {
  const actual = jest.requireActual("fs");
  return {
    ...actual,
    existsSync: jest.fn(actual.existsSync),
    promises: {
      ...actual.promises,
      readFile: jest.fn(),
      copyFile: jest.fn(),
      writeFile: jest.fn(),
      readdir: jest.fn(),
      unlink: jest.fn(),
    },
  };
});

import { promises as fsPromises } from "fs";
const mockReadFile = fsPromises.readFile as jest.MockedFunction<typeof fsPromises.readFile>;
const mockCopyFile = fsPromises.copyFile as jest.MockedFunction<typeof fsPromises.copyFile>;
const mockWriteFile = fsPromises.writeFile as jest.MockedFunction<typeof fsPromises.writeFile>;
const mockReaddir = fsPromises.readdir as jest.MockedFunction<typeof fsPromises.readdir>;
const mockUnlink = fsPromises.unlink as jest.MockedFunction<typeof fsPromises.unlink>;
const mockExistsSync = (fs.existsSync as jest.MockedFunction<typeof fs.existsSync>);

import { getAllRepoPaths, getRepos, setActiveRepo, addRepo } from "@/lib/repo-config";

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

// ---------------------------------------------------------------------------
// beads_web-u67: writeConfig — backup-before-write tests
// ---------------------------------------------------------------------------

describe("writeConfig — backup-before-write (beads_web-u67)", () => {
  const CONFIG_PATH = path.join(os.homedir(), ".beads-web.json");
  const mockStore = {
    repos: [
      { name: "factory-core", path: "/repos/factory-core" },
      { name: "beads_web", path: "/repos/beads_web" },
    ],
    activeRepo: "/repos/factory-core",
  };

  beforeEach(() => {
    jest.clearAllMocks();
    // Default: readFile returns a valid store (readConfig succeeds)
    mockReadFile.mockResolvedValue(JSON.stringify(mockStore));
    // Default: writeFile succeeds
    mockWriteFile.mockResolvedValue(undefined);
    // Default: copyFile succeeds
    mockCopyFile.mockResolvedValue(undefined);
    // Default: readdir returns no backups (nothing to prune)
    mockReaddir.mockResolvedValue([] as unknown as Awaited<ReturnType<typeof fsPromises.readdir>>);
    // Default: unlink succeeds
    mockUnlink.mockResolvedValue(undefined);
  });

  // --- AC 3: Backup filename format ---
  it("creates backup with correct compact ISO timestamp filename (AC 3)", async () => {
    mockExistsSync.mockReturnValue(true);

    // Trigger writeConfig via setActiveRepo (which reads then writes)
    await setActiveRepo("/repos/factory-core");

    expect(mockCopyFile).toHaveBeenCalledTimes(1);
    const backupPath = mockCopyFile.mock.calls[0][1] as string;
    const backupFilename = path.basename(backupPath);
    // Strict regex per bead AC 3 / FYI 5
    expect(backupFilename).toMatch(/^\.beads-web\.json\.bak\.\d{8}T\d{6}Z$/);
    // Source should be CONFIG_PATH
    expect(mockCopyFile.mock.calls[0][0]).toBe(CONFIG_PATH);
  });

  // --- AC 4: Abort on backup failure ---
  it("aborts write and throws when backup fails (AC 4)", async () => {
    mockExistsSync.mockReturnValue(true);
    const enospc = new Error("ENOSPC: no space left on device");
    (enospc as NodeJS.ErrnoException).code = "ENOSPC";
    mockCopyFile.mockRejectedValue(enospc);

    await expect(setActiveRepo("/repos/factory-core")).rejects.toThrow(
      /Backup failed before registry write.*ENOSPC/,
    );
    // writeFile must NEVER be called when backup fails
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  // --- AC 5: First-run bootstrap (no backup when registry doesn't exist) ---
  it("skips backup when registry does not exist — first-run (AC 5)", async () => {
    // readConfig returns empty (file doesn't exist — simulates first run)
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
    mockExistsSync.mockReturnValue(false);

    // getRepos seeds from env var on first run; we need to trigger writeConfig
    // without getRepos's env-var logic. Use addRepo which always calls writeConfig.
    // But addRepo calls fs.access — we need to mock that too.
    // Simpler: directly test via setActiveRepo path after seeding readConfig.
    // Actually — for the first-run case, existsSync(CONFIG_PATH) returns false.
    // The cleanest path: mock readConfig to return a store with repos,
    // mock existsSync to return false (registry file doesn't exist yet),
    // then call setActiveRepo.
    mockReadFile.mockResolvedValue(JSON.stringify(mockStore));
    mockExistsSync.mockReturnValue(false);

    await setActiveRepo("/repos/factory-core");

    expect(mockCopyFile).not.toHaveBeenCalled();
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
  });

  // --- AC 2: Pruning logic (keep last 5) ---
  it("prunes oldest backups when more than 5 exist (AC 2)", async () => {
    mockExistsSync.mockReturnValue(true);

    // Simulate 7 existing backups after the new one is written
    const backupNames = [
      ".beads-web.json.bak.20260501T120000Z",
      ".beads-web.json.bak.20260501T120100Z",
      ".beads-web.json.bak.20260501T120200Z",
      ".beads-web.json.bak.20260501T120300Z",
      ".beads-web.json.bak.20260501T120400Z",
      ".beads-web.json.bak.20260501T120500Z",
      ".beads-web.json.bak.20260501T120600Z",
    ];
    // Include non-matching files to verify regex strictness (FYI 5)
    const allEntries = [
      ".beads-web.json.bak-k7gy-11",
      ".beads-web.json.bak.pre-rename-20260430-154453",
      ".beads-web.json.bak.wipe-recovery-2026-04-29",
      ...backupNames,
      ".zshrc",
    ];
    mockReaddir.mockResolvedValue(allEntries as unknown as Awaited<ReturnType<typeof fsPromises.readdir>>);

    await setActiveRepo("/repos/factory-core");

    // Should delete the 2 oldest (indices 0 and 1)
    expect(mockUnlink).toHaveBeenCalledTimes(2);
    expect(mockUnlink).toHaveBeenCalledWith(
      path.join(os.homedir(), ".beads-web.json.bak.20260501T120000Z"),
    );
    expect(mockUnlink).toHaveBeenCalledWith(
      path.join(os.homedir(), ".beads-web.json.bak.20260501T120100Z"),
    );
  });

  // --- AC 2 edge: Pruning is best-effort (unlink failure doesn't throw) ---
  it("does not throw when pruning fails — best-effort (AC 2 edge)", async () => {
    mockExistsSync.mockReturnValue(true);
    const warnSpy = jest.spyOn(console, "warn").mockImplementation();

    const backupNames = [
      ".beads-web.json.bak.20260501T120000Z",
      ".beads-web.json.bak.20260501T120100Z",
      ".beads-web.json.bak.20260501T120200Z",
      ".beads-web.json.bak.20260501T120300Z",
      ".beads-web.json.bak.20260501T120400Z",
      ".beads-web.json.bak.20260501T120500Z",
      ".beads-web.json.bak.20260501T120600Z",
    ];
    mockReaddir.mockResolvedValue(backupNames as unknown as Awaited<ReturnType<typeof fsPromises.readdir>>);

    const eacces = new Error("EACCES: permission denied");
    mockUnlink.mockRejectedValueOnce(eacces).mockResolvedValueOnce(undefined);

    // Should NOT throw despite unlink failure
    await expect(setActiveRepo("/repos/factory-core")).resolves.toBeDefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to prune old backup"),
    );

    warnSpy.mockRestore();
  });
});
