// =============================================================================
// Beads Fleet — Cross-Repo Plan-vs-Label Integrity Sweep
// =============================================================================
//
// factory-core-k7gy.4 (F2 implementation — see the architecture doc at
// docs/research/plan-review-by-reviewer-agent-architecture.md §Component
// Boundaries and ADR-006).
//
// Reconciles a build plan's Bead Summary table (the manifest) against the
// actual bead labels living in every registered Dolt repo. Emits one of three
// finding kinds per bead:
//
//   - orphan: bead listed in the manifest but no repo returns it for
//             `epic:<id>`.
//   - stray: repo returns a bead for `epic:<id>` but it's not in the
//            manifest (planner forgot to list it, or a rogue bead crept in).
//   - mislabel: bead is in the manifest AND a repo returns it, but tagged
//               with a different `epic:` label.
//
// Fail-closed (regression #13): any repo query that throws or times out puts
// the repoId on the `unavailable` list and clears the other three fields.
// Partial results are never returned — a missing repo could hide strays.
//
// The reviewer agent never imports this module directly. It calls the
// /api/plan-review/integrity HTTP endpoint (k7gy.8), which in turn calls
// runIntegritySweep. That keeps all Dolt knowledge centralised in beads_web
// (internal guardrail #2).
// =============================================================================

import { readFile } from "fs/promises";
import * as path from "path";

import { readIssuesFromDolt } from "@/lib/dolt-reader";
import { getRepos } from "@/lib/repo-config";
import type { BeadsIssue } from "@/lib/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Reference to a specific bead surfaced by the integrity sweep.
 * `expectedRepo` is filled for orphans / mislabels from the manifest.
 * `actualLabel` / `expectedLabel` are filled for mislabels only.
 */
export interface BeadRef {
  beadId: string;
  expectedRepo?: string;
  actualRepo?: string;
  expectedLabel?: string;
  actualLabel?: string;
}

/**
 * Canonical result shape of runIntegritySweep. Always has all four arrays.
 * `unavailable` non-empty means the other three are unreliable — the reviewer
 * treats any unavailability as NEEDS REVISION (ADR-006 fail-closed).
 */
export interface IntegrityResult {
  orphans: BeadRef[];
  strays: BeadRef[];
  mislabels: BeadRef[];
  unavailable: string[];
}

/**
 * One row of the Bead Summary manifest parsed out of the plan Markdown.
 * `expectedRepo` is inferred from the bead ID prefix (everything before the
 * first dot) — matches the existing Shipyard convention where
 * `factory-core-k7gy.3` lives in `factory-core`.
 */
export interface PlanManifestEntry {
  beadId: string;
  expectedRepo: string;
}

/**
 * Optional overrides for runIntegritySweep — exposed purely so tests can
 * inject mocks. Production callers pass nothing and get the real Dolt reader
 * and repo registry.
 */
export interface SweepDependencies {
  /**
   * Returns every registered repo's name + absolute path. Defaults to
   * {@link getRepos}() + picking out `{ name, path }`.
   */
  listRegisteredRepos?: () => Promise<Array<{ name: string; path: string }>>;
  /**
   * Reads every live issue from a repo's Dolt server. Defaults to
   * {@link readIssuesFromDolt}.
   */
  readIssuesFromRepo?: (repoPath: string) => Promise<BeadsIssue[]>;
  /**
   * Overridable per-repo and total timeout caps. Defaults to 60s total.
   * Individual repo queries inherit the same budget (so a single slow repo
   * can't blow the total cap).
   */
  timeoutMs?: number;
  /**
   * Directory relative to which `planManifestPath` is resolved. Defaults to
   * `process.cwd()`. The `/api/plan-review/integrity` route (k7gy.8) sets
   * this to the epic's repo path so a reviewer-relative path like
   * `.beads/plans/<epic>.md` resolves correctly regardless of beads_web's
   * cwd. Must be an absolute path; `..` segments in `planManifestPath` are
   * still rejected.
   */
  baseDir?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const INTEGRITY_SWEEP_TIMEOUT_MS = 60_000;

// Canonical epic / bead ID shape — matches architecture §Security.
// Example matches: factory-core-k7gy, factory-core-k7gy.3, abc-1.2.3
const EPIC_ID_REGEX = /^[a-z0-9-]+(\.[0-9]+)*$/;
const BEAD_ID_REGEX = /^[a-z0-9-]+\.\d+$/;

// ---------------------------------------------------------------------------
// Errors — named so the route handler can discriminate without string matching
// ---------------------------------------------------------------------------

export class InvalidEpicIdError extends Error {
  constructor(value: string) {
    super(`Invalid epicId: ${JSON.stringify(value)}`);
    this.name = "InvalidEpicIdError";
  }
}

export class InvalidPathError extends Error {
  constructor(value: string) {
    super(`Invalid planManifestPath: ${JSON.stringify(value)}`);
    this.name = "InvalidPathError";
  }
}

export class MissingBeadSummaryError extends Error {
  constructor() {
    super("Plan manifest has no '## Bead Summary' heading");
    this.name = "MissingBeadSummaryError";
  }
}

// ---------------------------------------------------------------------------
// Manifest parser
// ---------------------------------------------------------------------------

/**
 * Read the Bead Summary table out of a plan Markdown file and return every
 * bead ID + its expected repo (derived from the bead ID prefix).
 *
 * The expected table shape is the one produced by the Planner agent:
 *
 *     ## Bead Summary
 *     | # | Bead ID | Title | Wave | ... |
 *     |---|---------|-------|------|-----|
 *     | 1 | factory-core-k7gy.1 | ... | 1 | ... |
 *
 * Tolerates columns after `Bead ID` but requires the `Bead ID` column exists.
 */
export async function parsePlanManifest(
  planPath: string,
): Promise<PlanManifestEntry[]> {
  const raw = await readFile(planPath, "utf-8");
  const lines = raw.split(/\r?\n/);

  let inSummary = false;
  let headerSeen = false;
  let beadIdColumn = -1;
  const entries: PlanManifestEntry[] = [];

  for (const line of lines) {
    if (!inSummary) {
      if (/^##\s+Bead Summary\b/i.test(line)) {
        inSummary = true;
      }
      continue;
    }

    // Leaving the section when we hit the next heading.
    if (/^##\s+\S/.test(line)) {
      break;
    }

    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) {
      // Table hasn't started yet — keep scanning.
      continue;
    }

    // Drop leading/trailing pipes to isolate cells.
    const cells = trimmed
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());

    if (!headerSeen) {
      const beadIdIdx = cells.findIndex((c) => /^bead\s*id$/i.test(c));
      if (beadIdIdx >= 0) {
        beadIdColumn = beadIdIdx;
        headerSeen = true;
      }
      continue;
    }

    // Skip the alignment row: |---|---|...|
    if (cells.every((c) => /^:?-+:?$/.test(c) || c === "")) {
      continue;
    }

    if (beadIdColumn < 0 || beadIdColumn >= cells.length) {
      continue;
    }

    const beadId = cells[beadIdColumn];
    if (!BEAD_ID_REGEX.test(beadId)) {
      continue;
    }

    entries.push({
      beadId,
      expectedRepo: inferRepoFromBeadId(beadId),
    });
  }

  if (!inSummary) {
    throw new MissingBeadSummaryError();
  }

  return entries;
}

function inferRepoFromBeadId(beadId: string): string {
  // `factory-core-k7gy.3` → prefix `factory-core-k7gy`. The repo name is
  // everything before the final `-<token>.<n>` tuple; practically this maps
  // cleanly to the existing repo naming convention.
  const dot = beadId.indexOf(".");
  const prefix = dot >= 0 ? beadId.slice(0, dot) : beadId;
  // Derive repo name from the prefix: drop the epic token (last `-segment`).
  const lastDash = prefix.lastIndexOf("-");
  if (lastDash > 0) {
    return prefix.slice(0, lastDash);
  }
  return prefix;
}

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

/**
 * Reconcile the plan manifest against every registered repo's labels.
 *
 * @param epicId the epic ID (e.g., `factory-core-k7gy`)
 * @param planManifestPath path to the plan Markdown — resolved relative to
 *                         `process.cwd()`, rejected if it traverses `..`.
 * @param deps optional mocks for testing; defaults to real Dolt + repo-config.
 *
 * Fail-closed behaviour: any repo query that throws or exceeds the total
 * timeout is recorded in `unavailable`, and orphans/strays/mislabels are
 * returned empty. A manifest parse error throws up to the caller (route
 * handler turns it into a 400). `epicId` / `planManifestPath` validation
 * errors throw named error types the route can discriminate.
 */
export async function runIntegritySweep(
  epicId: string,
  planManifestPath: string,
  deps: SweepDependencies = {},
): Promise<IntegrityResult> {
  if (!EPIC_ID_REGEX.test(epicId)) {
    throw new InvalidEpicIdError(epicId);
  }

  const resolvedPath = validatePlanPath(planManifestPath, deps.baseDir);

  const timeoutMs = deps.timeoutMs ?? INTEGRITY_SWEEP_TIMEOUT_MS;
  const listRegisteredRepos =
    deps.listRegisteredRepos ??
    (async () => (await getRepos()).repos.map((r) => ({ name: r.name, path: r.path })));
  const readIssuesFromRepo = deps.readIssuesFromRepo ?? readIssuesFromDolt;

  let manifest: PlanManifestEntry[];
  try {
    manifest = await parsePlanManifest(resolvedPath);
  } catch (error) {
    // MissingBeadSummaryError / I/O error — propagate so the route can 400.
    throw error;
  }

  const repos = await listRegisteredRepos();

  // Concurrent per-repo queries, each wrapped in its own timeout + catch so
  // one slow/broken repo doesn't block the others.
  const sweepStart = Date.now();
  const repoResults = await Promise.all(
    repos.map(async (repo) => {
      try {
        const issues = await withTimeout(
          readIssuesFromRepo(repo.path),
          timeoutMs - (Date.now() - sweepStart),
          repo.name,
        );
        return { repo, issues, ok: true as const };
      } catch {
        return { repo, issues: [] as BeadsIssue[], ok: false as const };
      }
    }),
  );

  const unavailable: string[] = repoResults
    .filter((r) => !r.ok)
    .map((r) => r.repo.name);

  // Fail-closed (ADR-006): if any repo is down, we cannot trust the other
  // three fields, so return an empty shape with unavailable populated.
  if (unavailable.length > 0) {
    return {
      orphans: [],
      strays: [],
      mislabels: [],
      unavailable,
    };
  }

  return reconcile(epicId, manifest, repoResults);
}

function reconcile(
  epicId: string,
  manifest: PlanManifestEntry[],
  repoResults: Array<{
    repo: { name: string; path: string };
    issues: BeadsIssue[];
  }>,
): IntegrityResult {
  const expectedLabel = `epic:${epicId}`;
  const manifestById = new Map<string, PlanManifestEntry>();
  for (const entry of manifest) {
    manifestById.set(entry.beadId, entry);
  }

  // Build a lookup of (beadId -> {repoName, labels}) across every repo.
  const foundById = new Map<
    string,
    { repoName: string; labels: string[] }
  >();
  // Collect beads carrying *any* `epic:<epicId>` label — candidates for
  // strays/mislabels.
  const beadsTaggedForEpic: Array<{ beadId: string; repoName: string; labels: string[] }> = [];

  for (const { repo, issues } of repoResults) {
    for (const issue of issues) {
      const labels = issue.labels ?? [];
      foundById.set(issue.id, { repoName: repo.name, labels });
      if (labels.includes(expectedLabel)) {
        beadsTaggedForEpic.push({ beadId: issue.id, repoName: repo.name, labels });
      }
    }
  }

  const orphans: BeadRef[] = [];
  const mislabels: BeadRef[] = [];

  for (const entry of manifest) {
    const found = foundById.get(entry.beadId);
    if (!found) {
      orphans.push({
        beadId: entry.beadId,
        expectedRepo: entry.expectedRepo,
      });
      continue;
    }

    if (!found.labels.includes(expectedLabel)) {
      // Find the other `epic:<...>` label (if any) for the mislabel message.
      const otherEpicLabel = found.labels.find((l) => l.startsWith("epic:"));
      mislabels.push({
        beadId: entry.beadId,
        expectedRepo: entry.expectedRepo,
        actualRepo: found.repoName,
        expectedLabel,
        actualLabel: otherEpicLabel ?? "(none)",
      });
    }
  }

  const strays: BeadRef[] = beadsTaggedForEpic
    .filter((b) => !manifestById.has(b.beadId))
    .map((b) => ({
      beadId: b.beadId,
      actualRepo: b.repoName,
      actualLabel: expectedLabel,
    }));

  return {
    orphans,
    strays,
    mislabels,
    unavailable: [],
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validatePlanPath(planManifestPath: string, baseDir?: string): string {
  if (!planManifestPath || typeof planManifestPath !== "string") {
    throw new InvalidPathError(String(planManifestPath));
  }

  // Absolute paths are rejected (the architecture only deals with
  // relative-to-cwd plan paths; an absolute path to `/etc/passwd` must not
  // be accepted).
  if (path.isAbsolute(planManifestPath)) {
    throw new InvalidPathError(planManifestPath);
  }

  const normalised = path.normalize(planManifestPath);
  if (normalised.split(path.sep).includes("..")) {
    throw new InvalidPathError(planManifestPath);
  }

  const base = baseDir && path.isAbsolute(baseDir) ? baseDir : process.cwd();
  return path.join(base, normalised);
}

/**
 * Wrap a promise in a timeout that rejects with a labelled error. Budget
 * values <= 0 are treated as "time already exhausted" and reject immediately.
 */
function withTimeout<T>(
  promise: Promise<T>,
  budgetMs: number,
  label: string,
): Promise<T> {
  if (budgetMs <= 0) {
    return Promise.reject(new Error(`timeout exceeded for ${label}`));
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timeout exceeded for ${label}`));
    }, budgetMs);
    // Ensure long-running timers don't keep the process alive (tests).
    if (typeof timer === "object" && timer && "unref" in timer) {
      (timer as { unref: () => void }).unref();
    }
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
