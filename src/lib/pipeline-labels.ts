// =============================================================================
// Beads Fleet -- Pipeline Label Management
// =============================================================================
//
// Manages pipeline labels on fleet-core epics via the `bd` CLI.
// Used by the agent launcher (on exit transitions) and the fleet action API
// (on button clicks).
// =============================================================================

import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import { findRepoForIssue } from "./repo-config";
import { getBdPath, getBdEnv } from "./bd-path";

const execFile = promisify(execFileCb);
const BD = getBdPath();

const BD_TIMEOUT = 15_000;

/**
 * Resolve the repo path for a given issue. If epicRepoPath is provided,
 * use it directly. Otherwise, search all configured repos.
 */
async function resolveRepoPath(issueId: string, epicRepoPath?: string): Promise<string> {
  if (epicRepoPath) return epicRepoPath;

  const resolved = await findRepoForIssue(issueId);
  if (!resolved) {
    throw new Error(`Issue ${issueId} not found in any configured repo`);
  }
  return resolved;
}

/**
 * Add labels to an epic via `bd label add <issueId> <label1> <label2> ...`.
 */
export async function addLabelsToEpic(
  issueId: string,
  labels: string[],
  epicRepoPath?: string,
): Promise<void> {
  if (labels.length === 0) return;

  const repoPath = await resolveRepoPath(issueId, epicRepoPath);

  for (const label of labels) {
    try {
      await execFile(BD, ["label", "add", issueId, label], {
        cwd: repoPath,
        timeout: BD_TIMEOUT,
        env: { ...process.env, NO_COLOR: "1" },
      });
    } catch (err) {
      // If the label already exists, bd may error -- that's OK
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("already")) {
        console.error(`Failed to add label "${label}" to ${issueId}:`, msg);
      }
    }
  }
}

/**
 * Remove labels from an epic via `bd label remove <issueId> <label>`.
 */
export async function removeLabelsFromEpic(
  issueId: string,
  labels: string[],
  epicRepoPath?: string,
): Promise<void> {
  if (labels.length === 0) return;

  const repoPath = await resolveRepoPath(issueId, epicRepoPath);

  for (const label of labels) {
    try {
      await execFile(BD, ["label", "remove", issueId, label], {
        cwd: repoPath,
        timeout: BD_TIMEOUT,
        env: { ...process.env, NO_COLOR: "1" },
      });
    } catch (err) {
      // If the label doesn't exist, bd may error -- that's OK
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("not found") && !msg.includes("does not have")) {
        console.error(`Failed to remove label "${label}" from ${issueId}:`, msg);
      }
    }
  }
}

/**
 * Remove all pipeline:* labels from an epic. Reads the current labels
 * from the issue and removes any that start with "pipeline:".
 */
export async function removeAllPipelineLabels(
  issueId: string,
  currentLabels: string[],
  epicRepoPath?: string,
): Promise<void> {
  const pipelineLabels = currentLabels.filter((l) => l.startsWith("pipeline:"));
  await removeLabelsFromEpic(issueId, pipelineLabels, epicRepoPath);
}

/**
 * Close an epic via `bd close <issueId> --reason="<reason>"`.
 */
export async function closeEpic(
  issueId: string,
  reason: string,
  epicRepoPath?: string,
): Promise<void> {
  const repoPath = await resolveRepoPath(issueId, epicRepoPath);

  await execFile(BD, ["close", issueId, "--reason", reason], {
    cwd: repoPath,
    timeout: BD_TIMEOUT,
    env: { ...process.env, NO_COLOR: "1" },
  });
}

/**
 * Update epic status via `bd update <issueId> --status=<status>`.
 */
export async function updateEpicStatus(
  issueId: string,
  status: string,
  epicRepoPath?: string,
): Promise<void> {
  const repoPath = await resolveRepoPath(issueId, epicRepoPath);

  await execFile(BD, ["update", issueId, `--status=${status}`], {
    cwd: repoPath,
    timeout: BD_TIMEOUT,
    env: { ...process.env, NO_COLOR: "1" },
  });
}
