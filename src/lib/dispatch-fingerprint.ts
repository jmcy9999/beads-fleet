/**
 * Dispatch fingerprint — factory-core-9l7q.1
 *
 * Idempotency guard for agent dispatches. Computes a state-fingerprint
 * (HEAD + open-children hash + findings-doc hash) for each (epic, wave,
 * agent) tuple and refuses to redispatch when nothing has changed.
 *
 * Context: k7gy Wave 3 spun 19 builder dispatches + 17 reviewer dispatches
 * on unchanged HEAD c31a24c. Every one was a no-op that still burned tokens.
 * This module is the MVP slice that makes the loop structurally impossible.
 *
 * Design notes:
 *  - Fingerprint is conservative: any change to HEAD, any child open/close,
 *    any edit to the findings doc bumps the fingerprint.
 *  - Storage is a JSON file on disk so it survives server restarts (the
 *    exact class of orphan this module cannot rely on in-memory maps to
 *    catch — see mwhm.1).
 *  - Bypass via `force: true` for legitimate re-runs (user pressed a
 *    "force re-review" button, audit replay, etc.).
 */

import { exec } from "child_process";
import { createHash } from "crypto";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";

const execAsync = promisify(exec);

const FINGERPRINT_FILE = path.join(
  os.tmpdir(),
  "beads-web-dispatch-fingerprints.json",
);

export interface Fingerprint {
  head: string;
  openChildrenHash: string;
  findingsDocHash: string;
  combined: string;
  computedAt: string;
}

export interface FingerprintCheckResult {
  duplicate: boolean;
  fingerprint: Fingerprint;
  previous?: Fingerprint;
}

interface StoredEntry {
  fingerprint: Fingerprint;
  lastDispatchedAt: string;
  agentType: string;
}

type Store = Record<string, StoredEntry>;

function storageKey(
  epicId: string,
  waveNumber: number | undefined,
  agentType: string,
): string {
  return `${epicId}::${waveNumber ?? "none"}::${agentType}`;
}

async function getHead(repoPath: string): Promise<string> {
  try {
    const { stdout } = await execAsync("git rev-parse HEAD", {
      cwd: repoPath,
      timeout: 5000,
    });
    return stdout.trim();
  } catch {
    // Not a git repo, or git is unavailable — return empty so fingerprint
    // is deterministic but still varies if e.g. children change.
    return "";
  }
}

async function getOpenChildrenIds(
  epicId: string,
  repoPath: string,
): Promise<string[]> {
  try {
    const { stdout } = await execAsync(
      `bd list --parent=${epicId} --status=open --json 2>/dev/null || bd list --parent=${epicId} --status=open`,
      { cwd: repoPath, timeout: 10000 },
    );
    // Try JSON parse first; fall back to regex extraction on the plain
    // text listing (bd older versions don't support --json).
    try {
      const parsed = JSON.parse(stdout);
      if (Array.isArray(parsed)) {
        return parsed
          .map((b) => b.id as string)
          .filter((x): x is string => typeof x === "string")
          .sort();
      }
    } catch {
      /* fall through to regex */
    }
    const ids = Array.from(stdout.matchAll(/(factory-core-[a-z0-9.]+)/g)).map(
      (m) => m[1],
    );
    return Array.from(new Set(ids)).sort();
  } catch {
    return [];
  }
}

async function getFindingsDocHash(
  epicId: string,
  repoPath: string,
): Promise<string> {
  // Findings-doc convention: docs/research/<epic-slug>-validation.md
  // We don't know the slug, so we scan docs/research/ for any file
  // matching *<shortId>*validation*.md and hash it.
  const shortId = epicId.replace(/^factory-core-/, "");
  const researchDir = path.join(repoPath, "docs", "research");
  try {
    const entries = await fs.readdir(researchDir);
    const match = entries.find(
      (f) => f.includes(shortId) && f.includes("validation") && f.endsWith(".md"),
    );
    if (!match) return createHash("sha256").update("").digest("hex");
    const body = await fs.readFile(path.join(researchDir, match), "utf-8");
    return createHash("sha256").update(body).digest("hex");
  } catch {
    return createHash("sha256").update("").digest("hex");
  }
}

/**
 * Compute the current fingerprint for an epic. Safe to call even when the
 * epic has no children yet (returns deterministic empty-state hash).
 */
export async function computeFingerprint(params: {
  epicId: string;
  repoPath: string;
}): Promise<Fingerprint> {
  const [head, openIds, findingsDocHash] = await Promise.all([
    getHead(params.repoPath),
    getOpenChildrenIds(params.epicId, params.repoPath),
    getFindingsDocHash(params.epicId, params.repoPath),
  ]);
  const openChildrenHash = createHash("sha256")
    .update(openIds.join(","))
    .digest("hex");
  const combined = createHash("sha256")
    .update(`${head}::${openChildrenHash}::${findingsDocHash}`)
    .digest("hex");
  return {
    head,
    openChildrenHash,
    findingsDocHash,
    combined,
    computedAt: new Date().toISOString(),
  };
}

async function readStore(): Promise<Store> {
  try {
    const body = await fs.readFile(FINGERPRINT_FILE, "utf-8");
    return JSON.parse(body) as Store;
  } catch {
    return {};
  }
}

async function writeStore(store: Store): Promise<void> {
  await fs.writeFile(FINGERPRINT_FILE, JSON.stringify(store, null, 2), "utf-8");
}

/**
 * Check whether the current state matches the last-stored fingerprint for
 * (epic, wave, agent). If it matches, `duplicate: true` — caller should
 * refuse the dispatch. If not, `duplicate: false` — caller should proceed
 * and then call `recordFingerprint` with the fresh tuple.
 */
export async function checkFingerprint(params: {
  epicId: string;
  waveNumber?: number;
  agentType: string;
  repoPath: string;
}): Promise<FingerprintCheckResult> {
  const fingerprint = await computeFingerprint(params);
  const store = await readStore();
  const key = storageKey(params.epicId, params.waveNumber, params.agentType);
  const previous = store[key]?.fingerprint;
  const duplicate = !!previous && previous.combined === fingerprint.combined;
  return { duplicate, fingerprint, previous };
}

/**
 * Record a successful dispatch. Overwrites any prior fingerprint for this
 * (epic, wave, agent) tuple.
 */
export async function recordFingerprint(params: {
  epicId: string;
  waveNumber?: number;
  agentType: string;
  fingerprint: Fingerprint;
}): Promise<void> {
  const store = await readStore();
  const key = storageKey(params.epicId, params.waveNumber, params.agentType);
  store[key] = {
    fingerprint: params.fingerprint,
    lastDispatchedAt: new Date().toISOString(),
    agentType: params.agentType,
  };
  await writeStore(store);
}

/**
 * Reset the fingerprint for a tuple — used by --force flows and manual
 * resets. After reset, the next dispatch proceeds and re-populates.
 */
export async function clearFingerprint(params: {
  epicId: string;
  waveNumber?: number;
  agentType: string;
}): Promise<void> {
  const store = await readStore();
  const key = storageKey(params.epicId, params.waveNumber, params.agentType);
  delete store[key];
  await writeStore(store);
}

export function shortHash(h: string): string {
  return h.slice(0, 12);
}
