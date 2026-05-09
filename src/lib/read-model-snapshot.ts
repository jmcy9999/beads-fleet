import path from "path";

import { readIssuesFromDolt } from "./dolt-reader";
import { issuesToPlan } from "./plan-builder";
import type { CacheScope } from "./cache";
import type {
  BeadsIssue,
  OfflineRepoInfo,
  PlanIssue,
  PlanSummary,
  PlanTrack,
  RobotPlan,
} from "./types";

const DEFAULT_TTL_MS = 15_000;
const DEFAULT_STALE_MS = 5 * 60_000;

interface SnapshotEntry<T> {
  data: T;
  updatedAtMs: number;
}

export interface RepoReadSnapshot {
  repoPath: string;
  repoName: string;
  issues: BeadsIssue[];
  plan: RobotPlan;
  generatedAt: string;
  refreshDurationMs: number;
}

export interface PortfolioReadSnapshot {
  repoPaths: string[];
  repos: RepoReadSnapshot[];
  issues: BeadsIssue[];
  plan: RobotPlan;
  offline_repos: OfflineRepoInfo[];
  generatedAt: string;
  refreshDurationMs: number;
}

const snapshotStore = new Map<string, SnapshotEntry<unknown>>();
const inFlight = new Map<string, Promise<unknown>>();
let cacheGeneration = 0;

function cacheKeyForRepo(repoPath: string): string {
  return `repo:${repoPath}`;
}

function cacheKeyForPortfolio(repoPaths: readonly string[]): string {
  return `portfolio:${JSON.stringify(repoPaths)}`;
}

function getCacheNumber(name: string, fallback: number): number {
  const parsed = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const ttlMs = () => getCacheNumber("BEADS_READ_MODEL_TTL_MS", DEFAULT_TTL_MS);
const staleMs = () =>
  getCacheNumber("BEADS_READ_MODEL_STALE_MS", DEFAULT_STALE_MS);

async function getCachedSnapshot<T>(
  key: string,
  compute: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  const existing = snapshotStore.get(key) as SnapshotEntry<T> | undefined;
  const age = existing ? now - existing.updatedAtMs : Number.POSITIVE_INFINITY;

  if (existing && age <= ttlMs()) {
    return existing.data;
  }

  const pending = inFlight.get(key) as Promise<T> | undefined;

  if (existing && age <= staleMs()) {
    if (!pending) {
      const generation = cacheGeneration;
      const refresh = refreshSnapshot(key, generation, compute).catch((err) => {
        console.warn(
          `[read-model] background refresh failed for ${key}:`,
          err instanceof Error ? err.message : err,
        );
        return existing.data;
      });
      inFlight.set(key, refresh);
      refresh.finally(() => {
        if (inFlight.get(key) === refresh) inFlight.delete(key);
      });
    }
    return existing.data;
  }

  if (pending) {
    try {
      return await pending;
    } catch (err) {
      if (existing) return existing.data;
      throw err;
    }
  }

  const generation = cacheGeneration;
  const refresh = refreshSnapshot(key, generation, compute);
  inFlight.set(key, refresh);
  try {
    return await refresh;
  } catch (err) {
    if (existing) return existing.data;
    throw err;
  } finally {
    if (inFlight.get(key) === refresh) inFlight.delete(key);
  }
}

async function refreshSnapshot<T>(
  key: string,
  generation: number,
  compute: () => Promise<T>,
): Promise<T> {
  const data = await compute();
  if (generation === cacheGeneration) {
    snapshotStore.set(key, { data, updatedAtMs: Date.now() });
  }
  return data;
}

async function buildRepoSnapshot(repoPath: string): Promise<RepoReadSnapshot> {
  const startedAt = Date.now();
  const issues = await readIssuesFromDolt(repoPath);
  const plan = issuesToPlan(issues, repoPath);
  return {
    repoPath,
    repoName: path.basename(repoPath),
    issues,
    plan,
    generatedAt: plan.timestamp,
    refreshDurationMs: Date.now() - startedAt,
  };
}

function withProjectLabel(issue: PlanIssue, repoName: string): PlanIssue {
  const projectLabel = `project:${repoName}`;
  const labels = issue.labels ? [...issue.labels] : [];
  if (!labels.includes(projectLabel)) labels.push(projectLabel);
  return { ...issue, labels };
}

function aggregatePlans(
  repoSnapshots: RepoReadSnapshot[],
  offlineRepos: OfflineRepoInfo[],
): RobotPlan {
  const allIssues: PlanIssue[] = [];
  const allTracks: PlanTrack[] = [];
  const summary: PlanSummary = {
    open_count: 0,
    in_progress_count: 0,
    blocked_count: 0,
    closed_count: 0,
  };

  let trackOffset = 0;
  for (const snapshot of repoSnapshots) {
    const { plan, repoName } = snapshot;

    for (const issue of plan.all_issues) {
      allIssues.push(withProjectLabel(issue, repoName));
    }

    for (const track of plan.tracks) {
      allTracks.push({
        ...track,
        track_number: track.track_number + trackOffset,
        label: track.label ? `[${repoName}] ${track.label}` : `[${repoName}]`,
        issues: track.issues.map((issue) => withProjectLabel(issue, repoName)),
      });
    }
    trackOffset += plan.tracks.length;

    summary.open_count += plan.summary.open_count;
    summary.in_progress_count += plan.summary.in_progress_count;
    summary.blocked_count += plan.summary.blocked_count;
    summary.closed_count += plan.summary.closed_count;
  }

  return {
    timestamp: new Date().toISOString(),
    project_path: "__all__",
    summary,
    tracks: allTracks,
    all_issues: allIssues,
    offline_repos: offlineRepos,
  };
}

async function buildPortfolioSnapshot(
  repoPaths: string[],
): Promise<PortfolioReadSnapshot> {
  const startedAt = Date.now();
  const snapshotRepoPaths = [...repoPaths];
  const results = await Promise.allSettled(
    snapshotRepoPaths.map((repoPath) => getRepoReadSnapshot(repoPath)),
  );

  const repos: RepoReadSnapshot[] = [];
  const offlineRepos: OfflineRepoInfo[] = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const repoPath = snapshotRepoPaths[i];
    if (result.status === "fulfilled") {
      repos.push(result.value);
      continue;
    }

    offlineRepos.push({
      repoName: path.basename(repoPath),
      repoPath,
      reason:
        result.reason instanceof Error
          ? result.reason.message
          : String(result.reason),
    });
  }

  const plan = aggregatePlans(repos, offlineRepos);

  return {
    repoPaths: snapshotRepoPaths,
    repos,
    issues: repos.flatMap((repo) => repo.issues),
    plan,
    offline_repos: offlineRepos,
    generatedAt: plan.timestamp,
    refreshDurationMs: Date.now() - startedAt,
  };
}

export async function getRepoReadSnapshot(
  repoPath: string,
): Promise<RepoReadSnapshot> {
  return getCachedSnapshot(cacheKeyForRepo(repoPath), () =>
    buildRepoSnapshot(repoPath),
  );
}

export async function getPortfolioReadSnapshot(
  repoPaths: string[],
): Promise<PortfolioReadSnapshot> {
  const snapshotRepoPaths = [...repoPaths];
  return getCachedSnapshot(cacheKeyForPortfolio(snapshotRepoPaths), () =>
    buildPortfolioSnapshot(snapshotRepoPaths),
  );
}

export function invalidateReadModelSnapshots(scope?: CacheScope): void {
  if (!scope || scope.type === "global" || scope.type === "epic") {
    cacheGeneration++;
    snapshotStore.clear();
    inFlight.clear();
    return;
  }

  cacheGeneration++;
  snapshotStore.delete(cacheKeyForRepo(scope.repoPath));

  for (const key of Array.from(snapshotStore.keys())) {
    if (key.startsWith("portfolio:")) snapshotStore.delete(key);
  }
  for (const key of Array.from(inFlight.keys())) {
    if (
      key === cacheKeyForRepo(scope.repoPath) ||
      key.startsWith("portfolio:")
    ) {
      inFlight.delete(key);
    }
  }
}

export function __resetReadModelSnapshotsForTests(): void {
  cacheGeneration++;
  snapshotStore.clear();
  inFlight.clear();
}
