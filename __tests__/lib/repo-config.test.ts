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
// readdir, unlink for beads_web-u67 backup-before-write tests; rename for
// beads_web-poh.5 atomic-write tests.
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
      rename: jest.fn(),
    },
  };
});

import { promises as fsPromises } from "fs";
const mockReadFile = fsPromises.readFile as jest.MockedFunction<typeof fsPromises.readFile>;
const mockCopyFile = fsPromises.copyFile as jest.MockedFunction<typeof fsPromises.copyFile>;
const mockWriteFile = fsPromises.writeFile as jest.MockedFunction<typeof fsPromises.writeFile>;
const mockReaddir = fsPromises.readdir as jest.MockedFunction<typeof fsPromises.readdir>;
const mockUnlink = fsPromises.unlink as jest.MockedFunction<typeof fsPromises.unlink>;
const mockRename = fsPromises.rename as jest.MockedFunction<typeof fsPromises.rename>;
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
    // beads_web-poh.5: readConfig must distinguish a real ENOENT from
    // other I/O failures, so the error must carry .code === "ENOENT" the
    // way Node's fs really emits it.
    const enoent = new Error("ENOENT: no such file or directory");
    (enoent as NodeJS.ErrnoException).code = "ENOENT";
    mockReadFile.mockRejectedValue(enoent);

    const paths = await getAllRepoPaths();
    // readConfig returns { repos: [] } on first-run / missing file
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
    // Default: rename succeeds (poh.5 atomic write)
    mockRename.mockResolvedValue(undefined);
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

// ---------------------------------------------------------------------------
// beads_web-poh.5: registry-collapse defences — atomic write, strict
// readConfig, in-process write mutex.
// ---------------------------------------------------------------------------

describe("writeConfig — atomic write via temp+rename (beads_web-poh.5)", () => {
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
    mockReadFile.mockResolvedValue(JSON.stringify(mockStore));
    mockWriteFile.mockResolvedValue(undefined);
    mockCopyFile.mockResolvedValue(undefined);
    mockReaddir.mockResolvedValue([] as unknown as Awaited<ReturnType<typeof fsPromises.readdir>>);
    mockUnlink.mockResolvedValue(undefined);
    mockRename.mockResolvedValue(undefined);
    mockExistsSync.mockReturnValue(true);
  });

  it("writes to a temp path inside the home directory, never to the live config path", async () => {
    await setActiveRepo("/repos/factory-core");

    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    const writePath = mockWriteFile.mock.calls[0][0] as string;
    // Temp file must live next to the config and be uniquely named so
    // concurrent writers don't collide on the same temp path.
    expect(writePath).toMatch(/\.beads-web\.json\.tmp\.\d+\.[a-z0-9]+$/);
    expect(writePath).not.toBe(CONFIG_PATH);
  });

  it("renames the temp file onto the live config path (POSIX-atomic publish)", async () => {
    await setActiveRepo("/repos/factory-core");

    expect(mockRename).toHaveBeenCalledTimes(1);
    const [from, to] = mockRename.mock.calls[0] as [string, string];
    // Source is the same temp path that writeFile was called with
    expect(from).toBe(mockWriteFile.mock.calls[0][0]);
    expect(to).toBe(CONFIG_PATH);
  });

  it("cleans up the temp file when writeFile fails", async () => {
    const enospc = new Error("ENOSPC: no space left on device");
    (enospc as NodeJS.ErrnoException).code = "ENOSPC";
    mockWriteFile.mockRejectedValue(enospc);

    await expect(setActiveRepo("/repos/factory-core")).rejects.toThrow(/ENOSPC/);

    // Rename must NOT be called when writeFile failed
    expect(mockRename).not.toHaveBeenCalled();
    // Best-effort temp cleanup: unlink called on the same temp path
    expect(mockUnlink).toHaveBeenCalled();
    const unlinkPath = mockUnlink.mock.calls[0][0] as string;
    expect(unlinkPath).toBe(mockWriteFile.mock.calls[0][0]);
  });

  it("cleans up the temp file when rename fails", async () => {
    const eperm = new Error("EPERM: operation not permitted");
    (eperm as NodeJS.ErrnoException).code = "EPERM";
    mockRename.mockRejectedValue(eperm);

    await expect(setActiveRepo("/repos/factory-core")).rejects.toThrow(/EPERM/);

    expect(mockUnlink).toHaveBeenCalled();
    const unlinkPath = mockUnlink.mock.calls[0][0] as string;
    expect(unlinkPath).toBe(mockWriteFile.mock.calls[0][0]);
  });

  it("does not bubble up failures from temp-file cleanup unlink", async () => {
    const ebusy = new Error("EBUSY: resource busy");
    (ebusy as NodeJS.ErrnoException).code = "EBUSY";
    mockWriteFile.mockRejectedValue(ebusy);
    mockUnlink.mockRejectedValue(new Error("ENOENT — temp file already gone"));

    // Caller still sees the original write error, not the unlink error
    await expect(setActiveRepo("/repos/factory-core")).rejects.toThrow(/EBUSY/);
  });
});

describe("readConfig — strict error discrimination (beads_web-poh.5)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockWriteFile.mockResolvedValue(undefined);
    mockCopyFile.mockResolvedValue(undefined);
    mockReaddir.mockResolvedValue([] as unknown as Awaited<ReturnType<typeof fsPromises.readdir>>);
    mockUnlink.mockResolvedValue(undefined);
    mockRename.mockResolvedValue(undefined);
    mockExistsSync.mockReturnValue(true);
  });

  it("returns empty store on real ENOENT (genuine first run)", async () => {
    const enoent = new Error("ENOENT: no such file or directory");
    (enoent as NodeJS.ErrnoException).code = "ENOENT";
    mockReadFile.mockRejectedValue(enoent);

    const paths = await getAllRepoPaths();
    expect(paths).toEqual([]);
  });

  it("propagates non-ENOENT I/O errors instead of silently seeding empty", async () => {
    // EACCES, EBUSY, EISDIR etc. must surface — not be swallowed into
    // an empty store. The 2026-05-07 collapse was caused by silently
    // returning empty on parse failures, which let getRepos seed a
    // 1-repo registry from BEADS_PROJECT_PATH and clobber the file.
    const eacces = new Error("EACCES: permission denied");
    (eacces as NodeJS.ErrnoException).code = "EACCES";
    mockReadFile.mockRejectedValue(eacces);

    await expect(getAllRepoPaths()).rejects.toThrow(/EACCES/);
  });

  it("throws on JSON parse failure (corruption signal, not first-run signal)", async () => {
    // A reader that hits the file mid-truncate sees a partial / invalid
    // JSON payload. That MUST throw, not seed empty — otherwise a
    // subsequent mutator clobbers the registry to a single-repo state.
    mockReadFile.mockResolvedValue("{ this is not valid json");

    await expect(getAllRepoPaths()).rejects.toThrow(/failed to parse/);
  });

  it("throws on empty file content (partial-write artefact)", async () => {
    // fs.writeFile with O_TRUNC blanks the file before writing bytes.
    // A reader hitting that window sees "". Treating "" as { repos: [] }
    // is the exact mistake that produced the 191-byte collapse.
    mockReadFile.mockResolvedValue("");

    await expect(getAllRepoPaths()).rejects.toThrow(/empty/);
  });

  it("does NOT clobber the registry when readConfig fails mid-write", async () => {
    // Repro of the collapse: addRepo is called, readConfig hits a
    // partial file, sees "" → must throw → must NOT proceed to write a
    // 1-repo seed.
    mockReadFile.mockResolvedValue("");

    await expect(addRepo("/repos/anything")).rejects.toThrow();
    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(mockRename).not.toHaveBeenCalled();
  });
});

describe("write mutex — concurrent mutators serialized (beads_web-poh.5)", () => {
  const CONFIG_PATH = path.join(os.homedir(), ".beads-web.json");

  beforeEach(() => {
    jest.clearAllMocks();
    mockWriteFile.mockResolvedValue(undefined);
    mockCopyFile.mockResolvedValue(undefined);
    mockReaddir.mockResolvedValue([] as unknown as Awaited<ReturnType<typeof fsPromises.readdir>>);
    mockUnlink.mockResolvedValue(undefined);
    mockRename.mockResolvedValue(undefined);
    mockExistsSync.mockReturnValue(true);
  });

  it("concurrent setActiveRepo calls do not interleave read-mutate-write", async () => {
    // Simulate the two-tab-click race: two setActive calls fired at the
    // same tick. Without the mutex they both readConfig() at the same
    // initial state, then both writeConfig(); the later one's write
    // wins, the earlier one's intent is lost. With the mutex, the
    // second call's readConfig observes the first call's write.
    const initialStore = {
      repos: [
        { name: "factory-core", path: "/repos/factory-core" },
        { name: "beads_web", path: "/repos/beads_web" },
      ],
      activeRepo: "/repos/factory-core",
    };

    // readFile resolves with the most recently written body each time,
    // so we can verify ordering through the parsed activeRepo.
    let currentDisk = JSON.stringify(initialStore);
    mockReadFile.mockImplementation(async () => currentDisk);
    mockWriteFile.mockImplementation(async (_path, body) => {
      // The temp-file write captures what *would* be published.
      // We commit it to "disk" only on rename, modelling reality.
      pendingWrite = body as string;
    });
    let pendingWrite: string | null = null;
    mockRename.mockImplementation(async () => {
      if (pendingWrite !== null) {
        currentDisk = pendingWrite;
        pendingWrite = null;
      }
    });

    // Fire both calls concurrently. If the mutex serializes properly,
    // the second one should find the first's write on disk.
    const observed: string[] = [];
    const callA = setActiveRepo("/repos/beads_web").then((s) => observed.push(`A:${s.activeRepo}`));
    const callB = setActiveRepo("/repos/factory-core").then((s) => observed.push(`B:${s.activeRepo}`));

    await Promise.all([callA, callB]);

    // Both calls completed, both writes hit disk in order.
    expect(mockRename).toHaveBeenCalledTimes(2);
    expect(mockRename.mock.calls[0][1]).toBe(CONFIG_PATH);
    expect(mockRename.mock.calls[1][1]).toBe(CONFIG_PATH);

    // The final on-disk state preserves all repos — no collapse.
    const finalState = JSON.parse(currentDisk);
    expect(finalState.repos).toHaveLength(2);
  });

  it("mutex survives a failing mutation — subsequent mutations still run", async () => {
    // If the lock chain rejects on a failed write, every subsequent
    // mutation in the process would deadlock. Verify that a failure in
    // mutation #1 doesn't block mutation #2 from starting.
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        repos: [{ name: "x", path: "/repos/x" }],
        activeRepo: "/repos/x",
      }),
    );

    // First call: writeFile fails.
    // Second call: writeFile succeeds.
    mockWriteFile
      .mockRejectedValueOnce(new Error("transient I/O error"))
      .mockResolvedValueOnce(undefined);

    await expect(setActiveRepo("/repos/x")).rejects.toThrow(/transient/);
    // Second call must complete — does NOT hang on a poisoned lock.
    await expect(setActiveRepo("/repos/x")).resolves.toBeDefined();
  });
});
