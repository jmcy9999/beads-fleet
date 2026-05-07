// =============================================================================
// Beads Fleet — Multi-Repository Configuration
// =============================================================================
//
// Manages a list of Beads-enabled repositories. Stored as a JSON file at
// ~/.beads-web.json. The first repo in the list (or the one matching
// BEADS_PROJECT_PATH) is the default active repo.
// =============================================================================

import { promises as fs } from "fs";
import { existsSync, readFileSync } from "fs";
import path from "path";
import os from "os";
import * as mysql from "mysql2/promise";
import { probeDolt } from "./dolt-health";

export interface RepoConfig {
  name: string;
  path: string;
}

export interface RepoStore {
  repos: RepoConfig[];
  activeRepo?: string; // path of the currently active repo
  watchDirs?: string[]; // directories to scan for new .beads/ projects
}

const CONFIG_PATH = path.join(os.homedir(), ".beads-web.json");

// beads_web-poh.5: in-process write lock. Atomic writes (rename pattern)
// stop concurrent readers from seeing partial files, but two concurrent
// mutators can still suffer the lost-update problem (read-A → read-B →
// write-A → write-B; A's changes are silently dropped). The lock
// serializes every read-mutate-write inside a single Node process so
// each mutation observes the result of the previous one. Cross-process
// races are not in scope (Next.js dev/prod runs as one process).
let writeLock: Promise<unknown> = Promise.resolve();

function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeLock.then(() => fn());
  // Swallow rejections on the chain so one failed mutation does not
  // permanently poison the lock. The original promise is still returned
  // to the caller, so the caller still sees the error.
  writeLock = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

async function readConfig(): Promise<RepoStore> {
  let content: string;
  try {
    content = await fs.readFile(CONFIG_PATH, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      // Genuine first run — config file does not exist yet. Safe to
      // bootstrap with an empty store.
      return { repos: [] };
    }
    // beads_web-poh.5: any other read error (EACCES, EBUSY, EISDIR…)
    // means we cannot trust the store. Propagating the failure prevents
    // downstream mutators (addRepo, getRepos seed) from clobbering the
    // registry to a single-repo state under the assumption of "no
    // repos configured".
    throw err;
  }

  // beads_web-poh.5: an empty file is a partial-write artefact, not a
  // bootstrap signal. Refuse to silently treat it as "no repos" — that
  // is exactly the failure mode that produced the 191-byte single-repo
  // collapse observed on 2026-05-07.
  if (content.trim().length === 0) {
    throw new Error(
      `Registry file ${CONFIG_PATH} is empty — likely a partial-write race. Restore from a .bak.* backup or remove the file to bootstrap.`,
    );
  }

  try {
    return JSON.parse(content) as RepoStore;
  } catch (err) {
    throw new Error(
      `Registry file ${CONFIG_PATH} failed to parse: ${err instanceof Error ? err.message : String(err)}. Restore from a .bak.* backup or remove the file to bootstrap.`,
    );
  }
}

async function writeConfig(store: RepoStore): Promise<void> {
  // beads_web-u67: Backup-before-write — create timestamped backup of existing
  // registry before overwriting. Abort on backup failure (fail-safe).
  if (existsSync(CONFIG_PATH)) {
    const ts = new Date()
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d+Z$/, "Z");
    const backupPath = `${CONFIG_PATH}.bak.${ts}`;
    try {
      await fs.copyFile(CONFIG_PATH, backupPath);
    } catch (err) {
      throw new Error(
        `Backup failed before registry write: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // beads_web-poh.5: atomic write via temp-file + rename. fs.writeFile
  // opens with O_TRUNC and only then writes the bytes, leaving a window
  // where concurrent readers see an empty file → JSON.parse fails →
  // readConfig used to return { repos: [] } → mutator clobbers to a
  // single-repo registry. POSIX rename(2) is atomic on the same
  // filesystem, so concurrent readers see either the old file or the
  // new file in full — never a partial truncate.
  const tmpPath = `${CONFIG_PATH}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 10)}`;
  try {
    await fs.writeFile(tmpPath, JSON.stringify(store, null, 2), "utf-8");
    await fs.rename(tmpPath, CONFIG_PATH);
  } catch (err) {
    // Best-effort cleanup of the temp file. Ignore unlink failures —
    // the original error is what matters.
    try {
      await fs.unlink(tmpPath);
    } catch {
      // ignore
    }
    throw err;
  }

  // Best-effort pruning: keep last 5 backups, delete older ones.
  await pruneOldBackups();
}

/**
 * Prune old registry backups, keeping only the 5 most recent.
 * Best-effort: individual deletion failures are logged but do not throw.
 * Only prunes files matching the strict backup naming convention
 * (`.beads-web.json.bak.YYYYMMDDTHHMMSSZ`) — operator's ad-hoc backups
 * are never touched.
 */
async function pruneOldBackups(): Promise<void> {
  const BACKUP_REGEX = /^\.beads-web\.json\.bak\.\d{8}T\d{6}Z$/;
  try {
    const entries = await fs.readdir(os.homedir());
    const backups = entries.filter((f) => BACKUP_REGEX.test(f)).sort();
    if (backups.length <= 5) return;

    const toDelete = backups.slice(0, -5);
    for (const name of toDelete) {
      try {
        await fs.unlink(path.join(os.homedir(), name));
      } catch (unlinkErr) {
        console.warn(
          `[repo-config] Failed to prune old backup ${name}: ${unlinkErr instanceof Error ? unlinkErr.message : String(unlinkErr)}`,
        );
      }
    }
  } catch (readdirErr) {
    console.warn(
      `[repo-config] Failed to enumerate backups for pruning: ${readdirErr instanceof Error ? readdirErr.message : String(readdirErr)}`,
    );
  }
}

/**
 * Get all configured repositories. If none are configured, seeds with
 * the BEADS_PROJECT_PATH env var (if set).
 */
export async function getRepos(): Promise<RepoStore> {
  // beads_web-poh.5: serialize the read-mutate-write seed path. Without
  // the lock, two concurrent GETs can both observe an empty store and
  // both write a single-repo seed, racing on the rename.
  return withWriteLock(async () => {
    const store = await readConfig();

    // Seed from env var if no repos configured
    if (store.repos.length === 0 && process.env.BEADS_PROJECT_PATH) {
      const envPath = process.env.BEADS_PROJECT_PATH;
      const name = path.basename(envPath);
      store.repos.push({ name, path: envPath });
      store.activeRepo = envPath;
      await writeConfig(store);
    }

    return store;
  });
}

/**
 * Sentinel value representing "all projects" aggregation mode.
 */
export const ALL_PROJECTS_SENTINEL = "__all__";

/**
 * Get the currently active project path. Falls back to BEADS_PROJECT_PATH
 * if no active repo is set. Returns `"__all__"` when in aggregation mode.
 */
export async function getActiveProjectPath(): Promise<string> {
  const store = await readConfig();

  if (store.activeRepo === ALL_PROJECTS_SENTINEL) return ALL_PROJECTS_SENTINEL;
  if (store.activeRepo) return store.activeRepo;
  if (store.repos.length > 0) return store.repos[0].path;
  if (process.env.BEADS_PROJECT_PATH) return process.env.BEADS_PROJECT_PATH;

  throw new Error(
    "No repository configured. Set BEADS_PROJECT_PATH or add a repo via Settings.",
  );
}

/**
 * Get all configured repo paths.
 */
export async function getAllRepoPaths(): Promise<string[]> {
  const store = await readConfig();
  return store.repos.map((r) => r.path);
}

/**
 * Add a repository to the config.
 */
export async function addRepo(repoPath: string, name?: string): Promise<RepoStore> {
  return withWriteLock(async () => {
    const store = await readConfig();
    const resolvedPath = path.resolve(repoPath);

    // Check if already exists
    if (store.repos.some((r) => r.path === resolvedPath)) {
      return store;
    }

    // Verify .beads directory exists
    try {
      await fs.access(path.join(resolvedPath, ".beads"));
    } catch {
      throw new Error(`No .beads directory found at ${resolvedPath}`);
    }

    const repoName = name || path.basename(resolvedPath);
    store.repos.push({ name: repoName, path: resolvedPath });

    if (!store.activeRepo) {
      store.activeRepo = resolvedPath;
    }

    await writeConfig(store);
    return store;
  });
}

/**
 * Remove a repository from the config.
 */
export async function removeRepo(repoPath: string): Promise<RepoStore> {
  return withWriteLock(async () => {
    const store = await readConfig();
    const resolvedPath = path.resolve(repoPath);
    store.repos = store.repos.filter((r) => r.path !== resolvedPath);

    if (store.activeRepo === resolvedPath) {
      store.activeRepo = store.repos[0]?.path;
    }

    await writeConfig(store);
    return store;
  });
}

/**
 * Probe a single repo for an issue. Returns the repo path if the issue
 * exists in that repo, or null if it doesn't (or the repo is unreachable).
 *
 * Each invocation owns its own mysql.Connection lifecycle via try/finally —
 * safe for parallel fanout with no connection leaks.
 *
 * The inner logic (TCP probe, MySQL handshake, query) is preserved from the
 * sequential implementation; only the outer loop changed (beads_web-ccn).
 */
async function probeRepoForIssue(repo: RepoConfig, issueId: string): Promise<string | null> {
  const portFile = path.join(repo.path, ".beads", "dolt-server.port");
  if (!existsSync(portFile)) return null;

  const port = parseInt(readFileSync(portFile, "utf-8").trim(), 10);
  if (isNaN(port)) return null;

  // Cheap reachability check: TCP probe before MySQL handshake.
  // factory-core-3p1e.5 — drops dead-repo cost from ~3s (MySQL handshake
  // timeout) to ~50ms (TCP refusal). The MySQL handshake below is still
  // required for the actual issue-existence query.
  const probe = await probeDolt("127.0.0.1", port, 2000);
  if (probe.category !== "reachable") return null;

  // Read database name from metadata
  let database = path.basename(repo.path);
  const metaFile = path.join(repo.path, ".beads", "metadata.json");
  if (existsSync(metaFile)) {
    try {
      const meta = JSON.parse(readFileSync(metaFile, "utf-8"));
      if (meta.dolt_database) database = meta.dolt_database;
    } catch {
      // Use default
    }
  }

  let conn: mysql.Connection | null = null;
  try {
    conn = await mysql.createConnection({
      host: "127.0.0.1",
      port,
      user: "root",
      database,
      connectTimeout: 2000,
    });
    const [rows] = await conn.query("SELECT 1 FROM issues WHERE id = ? LIMIT 1", [issueId]);
    if ((rows as unknown[]).length > 0) return repo.path;
  } catch {
    // Dolt server unreachable or query failed — skip
  } finally {
    if (conn) await conn.end();
  }
  return null;
}

/**
 * Find which repo an issue belongs to by probing all configured repos in
 * parallel. Returns the repo path, or null if no repo contains the issue.
 *
 * Parallelization strategy (beads_web-ccn): uses Promise.allSettled over
 * the full registry, then returns the first non-null result in registry
 * order. This preserves deterministic ordering (same result as the former
 * sequential for...of) while reducing worst-case wall time from ~5s
 * (50 repos × 100ms each, sequential) to ~200-300ms (bounded by the
 * slowest reachable repo's MySQL handshake, parallel).
 *
 * Promise.allSettled chosen over Promise.any because:
 *   - Promise.any resolves on the first *fulfilled* value — but a repo
 *     returning null (issue not found) is a fulfilled promise, not a
 *     rejection. Promise.any would resolve on the first null, which is
 *     wrong.
 *   - Promise.allSettled waits for all probes, then we filter. The extra
 *     wall time vs a hypothetical early-exit is negligible: probes that
 *     find the issue return in ~100ms; probes that don't also return in
 *     ~100ms. The bottleneck is parallel I/O, not sequential filtering.
 */
export async function findRepoForIssue(issueId: string): Promise<string | null> {
  const store = await readConfig();
  if (store.repos.length === 0) return null;

  const results = await Promise.allSettled(
    store.repos.map((repo) => probeRepoForIssue(repo, issueId)),
  );

  // Return the first match in registry order (deterministic, same as
  // the former sequential walk).
  for (const result of results) {
    if (result.status === "fulfilled" && result.value !== null) {
      return result.value;
    }
  }
  return null;
}

/**
 * Set the active repository. Pass `"__all__"` to enable aggregation mode.
 */
export async function setActiveRepo(repoPath: string): Promise<RepoStore> {
  return withWriteLock(async () => {
    const store = await readConfig();

    // Allow the "all projects" sentinel without path resolution
    if (repoPath === ALL_PROJECTS_SENTINEL) {
      store.activeRepo = ALL_PROJECTS_SENTINEL;
      await writeConfig(store);
      return store;
    }

    const resolvedPath = path.resolve(repoPath);

    if (!store.repos.some((r) => r.path === resolvedPath)) {
      throw new Error(`Repository not found: ${resolvedPath}`);
    }

    store.activeRepo = resolvedPath;
    await writeConfig(store);
    return store;
  });
}

// ---------------------------------------------------------------------------
// Watch directories — auto-discover new beads projects
// ---------------------------------------------------------------------------

/**
 * Get the configured watch directories.
 */
export async function getWatchDirs(): Promise<string[]> {
  const store = await readConfig();
  return store.watchDirs ?? [];
}

/**
 * Set watch directories (overwrites existing list).
 */
export async function setWatchDirs(dirs: string[]): Promise<RepoStore> {
  return withWriteLock(async () => {
    const store = await readConfig();
    store.watchDirs = dirs.map((d) => path.resolve(d));
    await writeConfig(store);
    return store;
  });
}

/**
 * Scan watch directories for new beads-enabled projects (directories
 * containing a `.beads/` subdirectory). Auto-registers any newly found
 * projects. Returns the list of newly added project paths.
 *
 * Only scans one level deep within each watch directory.
 */
export async function scanWatchDirs(): Promise<string[]> {
  return withWriteLock(async () => {
    const store = await readConfig();
    const watchDirs = store.watchDirs ?? [];
    if (watchDirs.length === 0) return [];

    const existingPaths = new Set(store.repos.map((r) => r.path));
    const newPaths: string[] = [];

    for (const dir of watchDirs) {
      let entries: string[];
      try {
        const dirents = await fs.readdir(dir, { withFileTypes: true });
        entries = dirents
          .filter((d) => d.isDirectory())
          .map((d) => path.join(dir, d.name));
      } catch {
        // Watch dir doesn't exist or isn't readable — skip
        continue;
      }

      for (const candidate of entries) {
        if (existingPaths.has(candidate)) continue;

        // Check if this directory has .beads/
        const beadsDir = path.join(candidate, ".beads");
        try {
          await fs.access(beadsDir);
        } catch {
          continue;
        }

        // New beads project found — register it
        const name = path.basename(candidate);
        store.repos.push({ name, path: candidate });
        existingPaths.add(candidate);
        newPaths.push(candidate);
      }
    }

    if (newPaths.length > 0) {
      await writeConfig(store);
    }

    return newPaths;
  });
}
