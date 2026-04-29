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

async function readConfig(): Promise<RepoStore> {
  try {
    const content = await fs.readFile(CONFIG_PATH, "utf-8");
    return JSON.parse(content) as RepoStore;
  } catch {
    return { repos: [] };
  }
}

async function writeConfig(store: RepoStore): Promise<void> {
  await fs.writeFile(CONFIG_PATH, JSON.stringify(store, null, 2), "utf-8");
}

/**
 * Get all configured repositories. If none are configured, seeds with
 * the BEADS_PROJECT_PATH env var (if set).
 */
export async function getRepos(): Promise<RepoStore> {
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
}

/**
 * Remove a repository from the config.
 */
export async function removeRepo(repoPath: string): Promise<RepoStore> {
  const store = await readConfig();
  const resolvedPath = path.resolve(repoPath);
  store.repos = store.repos.filter((r) => r.path !== resolvedPath);

  if (store.activeRepo === resolvedPath) {
    store.activeRepo = store.repos[0]?.path;
  }

  await writeConfig(store);
  return store;
}

/**
 * Find which repo an issue belongs to by checking each configured repo's
 * SQLite DB for a matching issue ID. Returns the repo path, or null if
 * no repo contains the issue.
 */
export async function findRepoForIssue(issueId: string): Promise<string | null> {
  const store = await readConfig();
  for (const repo of store.repos) {
    const portFile = path.join(repo.path, ".beads", "dolt-server.port");
    if (!existsSync(portFile)) continue;

    const port = parseInt(readFileSync(portFile, "utf-8").trim(), 10);
    if (isNaN(port)) continue;

    // Cheap reachability check: TCP probe before MySQL handshake.
    // factory-core-3p1e.5 — drops dead-repo cost from ~3s (MySQL handshake
    // timeout) to ~50ms (TCP refusal). The MySQL handshake below is still
    // required for the actual issue-existence query.
    const probe = await probeDolt("127.0.0.1", port, 2000);
    if (probe.category !== "reachable") continue;

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
  }
  return null;
}

/**
 * Set the active repository. Pass `"__all__"` to enable aggregation mode.
 */
export async function setActiveRepo(repoPath: string): Promise<RepoStore> {
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
  const store = await readConfig();
  store.watchDirs = dirs.map((d) => path.resolve(d));
  await writeConfig(store);
  return store;
}

/**
 * Scan watch directories for new beads-enabled projects (directories
 * containing a `.beads/` subdirectory). Auto-registers any newly found
 * projects. Returns the list of newly added project paths.
 *
 * Only scans one level deep within each watch directory.
 */
export async function scanWatchDirs(): Promise<string[]> {
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
}
