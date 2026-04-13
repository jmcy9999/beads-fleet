// =============================================================================
// Beads Fleet -- Generic Agent Launcher
// =============================================================================
//
// Spawns Claude Code CLI as a background subprocess to run autonomous tasks
// in any configured beads-enabled repo. Tracks running processes by PID.
//
// Extended for pipeline integration: tracks epicId and pipelineStage so that
// label transitions can be applied when the agent exits.
// =============================================================================

import { spawn, type ChildProcess } from "child_process";
import { promises as fs } from "fs";
import { createWriteStream, realpathSync, type WriteStream } from "fs";
import { createInterface } from "readline";
import path from "path";
import os from "os";
import { getBdPath, getBdEnv } from "./bd-path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentSession {
  pid: number;
  repoPath: string;
  repoName: string;
  prompt: string;
  model: string;
  startedAt: string;
  logFile: string;
  epicId?: string;
  pipelineStage?: string;
  epicLabels?: string[];
}

export interface LaunchOptions {
  repoPath: string;
  repoName?: string;
  prompt: string;
  model?: string;
  maxTurns?: number;
  allowedTools?: string;
  epicId?: string;
  pipelineStage?: string;
  agentName?: string;
  epicLabels?: string[];
}

// ---------------------------------------------------------------------------
// State -- per-repo map (allows parallel agents in different repos)
// ---------------------------------------------------------------------------

interface ActiveAgent {
  session: AgentSession;
  process: ChildProcess;
}

const activeAgents = new Map<string, ActiveAgent>();

const LOG_DIR = path.join(os.tmpdir(), "beads-web-agent-logs");
const SESSIONS_DIR = path.join(os.tmpdir(), "beads-web-agent-sessions");

// Backwards-compat: old single-session file (cleaned up on first use)
const LEGACY_SESSION_FILE = path.join(os.tmpdir(), "beads-web-agent-session.json");

// ---------------------------------------------------------------------------
// Session persistence — survives hot-reloads and server restarts
// ---------------------------------------------------------------------------

function sessionFileFor(repoPath: string): string {
  const safe = repoPath.replace(/\//g, "_");
  return path.join(SESSIONS_DIR, `agent-${safe}.json`);
}

async function persistSession(session: AgentSession): Promise<void> {
  try {
    await fs.mkdir(SESSIONS_DIR, { recursive: true });
    await fs.writeFile(
      sessionFileFor(session.repoPath),
      JSON.stringify(session, null, 2),
      "utf-8",
    );
  } catch {
    // Best effort — don't break the launch
  }
}

async function clearPersistedSession(repoPath: string): Promise<void> {
  try {
    await fs.unlink(sessionFileFor(repoPath));
  } catch {
    // File may not exist
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // Signal 0 = check if process exists
    return true;
  } catch {
    return false;
  }
}

async function recoverSessions(): Promise<AgentSession[]> {
  const recovered: AgentSession[] = [];

  // Clean up legacy single-session file
  try {
    const data = await fs.readFile(LEGACY_SESSION_FILE, "utf-8");
    const session = JSON.parse(data) as AgentSession;
    if (session.pid && isPidAlive(session.pid)) {
      recovered.push(session);
    }
    await fs.unlink(LEGACY_SESSION_FILE).catch(() => {});
  } catch {
    // No legacy file
  }

  // Read per-repo session files
  try {
    const files = await fs.readdir(SESSIONS_DIR);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const data = await fs.readFile(path.join(SESSIONS_DIR, file), "utf-8");
        const session = JSON.parse(data) as AgentSession;
        if (session.pid && isPidAlive(session.pid)) {
          recovered.push(session);
        } else {
          await fs.unlink(path.join(SESSIONS_DIR, file)).catch(() => {});
        }
      } catch {
        // Skip corrupt files
      }
    }
  } catch {
    // Sessions dir may not exist yet
  }

  return recovered;
}

// ---------------------------------------------------------------------------
// Pipeline stage transitions
// ---------------------------------------------------------------------------

/**
 * Maps the pipeline stage the agent was launched for to the next stage
 * label that should be applied when the agent exits successfully.
 *
 * Stages handled by handleChainAction (auto-chaining) are NOT listed here:
 *   research → auto-chains to planning
 *   planning → auto-chains to build
 *   development → auto-chains to QA
 *   qa → auto-chains to fix loop or submission-prep
 *   qa-fixes → auto-chains back to QA
 */
const NEXT_STAGE: Record<string, string> = {
  // QA with no bugs falls through chain action → advances to submission-prep
  qa: "pipeline:submission-prep",
  "submission-prep": "pipeline:submitted",
  "kit-management": "pipeline:completed",
};

/**
 * Pipeline stages that get special label handling on agent exit rather
 * than advancing to the next stage. Currently unused — planning now
 * auto-chains to build instead of waiting for plan approval.
 */
const EXIT_LABELS: Record<string, string[]> = {
  planning: ["plan:pending"],
};

// ---------------------------------------------------------------------------
// Safe bd execution — uses getBdPath() and getBdEnv() for reliable resolution
// (factory-core-cur.1.24: bare 'bd' in shell commands silently resolved to
// wrong binary; combined with '|| echo ""' error swallowing, bug detection
// returned empty strings and the pipeline advanced past QA with open bugs)
// ---------------------------------------------------------------------------

interface BdExecResult {
  stdout: string;
  success: boolean;
}

function execBdSync(args: string[], cwd: string, timeoutMs = 15000): BdExecResult {
  const { execFileSync } = require("child_process");
  const bd = getBdPath();
  const env = getBdEnv();
  try {
    const output = execFileSync(bd, args, {
      cwd,
      encoding: "utf-8",
      timeout: timeoutMs,
      env,
    }) as string;
    return { stdout: output.trim(), success: true };
  } catch {
    return { stdout: "", success: false };
  }
}

// ---------------------------------------------------------------------------
// Helpers for bd list output parsing
// ---------------------------------------------------------------------------

/**
 * Check if a bd list tree output line represents a bug-type bead.
 * Handles both tree output format variations:
 * - Open/in-progress items:  "● P0 [bug] Title"  (bracketed)
 * - Closed items:            "● P0 bug Title"     (unbracketed)
 * (factory-core-cur.1.25: tree output uses different formats for open vs closed)
 */
function lineIsBugType(line: string): boolean {
  return /P\d\s+\[?bug\]?\s/i.test(line);
}

/**
 * Parse child bead IDs and closed status from bd list --parent= tree output.
 * Tree format: ├── ✓ factory-core-cur.1.16 ● P0 bug Title...
 * Returns array of { id, isClosed } for each child (skips the root epic line).
 */
function parseChildrenFromTree(treeOutput: string): Array<{ id: string; isClosed: boolean }> {
  const children: Array<{ id: string; isClosed: boolean }> = [];
  for (const line of treeOutput.split("\n")) {
    // Match tree lines (├── or └──) with status icon and bead ID
    const idMatch = line.match(/[├└].*?[✓○◐●❄]\s+(\S+)\s/);
    if (!idMatch) continue;
    children.push({
      id: idMatch[1],
      isClosed: line.includes("✓"),
    });
  }
  return children;
}

// ---------------------------------------------------------------------------
// Wave status detection
// ---------------------------------------------------------------------------

interface WaveStatus {
  hasWaves: boolean;
  waves: Map<number, { total: number; closed: number }>;
  currentWave: number;
  totalWaves: number;
  currentWaveComplete: boolean;
  allWavesComplete: boolean;
  hasCheckpointRequired: boolean;
}

/**
 * Query the epic's children to determine wave completion status.
 * Returns wave info or { hasWaves: false } if no wave labels exist.
 *
 * @param epicId - The epic bead ID to query children for
 * @param repoPath - The repo where the epic's children live. For internal
 *   products this is fleet-core; for other ship types it's the product repo.
 *   (factory-core-cur.1.11: was hardcoded to FLEET_CORE_PATH)
 */
export async function getWaveStatus(epicId: string, repoPath: string): Promise<WaveStatus> {
  // Check if epic has wave-checkpoint:required label
  let hasCheckpointRequired = false;
  const epicResult = execBdSync(["show", epicId], repoPath, 10000);
  if (epicResult.success) {
    hasCheckpointRequired = epicResult.stdout.includes("wave-checkpoint:required");
  }

  // Step 1: Get all children IDs and closed status from tree output
  const childrenResult = execBdSync(["list", "--status=all", `--parent=${epicId}`], repoPath, 10000);
  if (!childrenResult.success) {
    return { hasWaves: false, waves: new Map(), currentWave: 0, totalWaves: 0, currentWaveComplete: false, allWavesComplete: false, hasCheckpointRequired };
  }

  const children = parseChildrenFromTree(childrenResult.stdout);
  if (children.length === 0) {
    return { hasWaves: false, waves: new Map(), currentWave: 0, totalWaves: 0, currentWaveComplete: false, allWavesComplete: false, hasCheckpointRequired };
  }

  // Step 2: Get wave labels from bd show for each child
  // (factory-core-cur.1.26: bd list --parent= tree output omits labels,
  // so we must query each child individually to get wave:N labels)
  const waveMap = new Map<number, { total: number; closed: number }>();
  for (const child of children) {
    const showResult = execBdSync(["show", child.id], repoPath, 5000);
    if (!showResult.success) continue;

    const waveMatch = showResult.stdout.match(/wave:(\d+)/);
    if (!waveMatch) continue;
    const waveNum = parseInt(waveMatch[1], 10);
    if (isNaN(waveNum)) continue;

    const entry = waveMap.get(waveNum) ?? { total: 0, closed: 0 };
    entry.total += 1;
    if (child.isClosed) {
      entry.closed += 1;
    }
    waveMap.set(waveNum, entry);
  }

  if (waveMap.size === 0) {
    return { hasWaves: false, waves: waveMap, currentWave: 0, totalWaves: 0, currentWaveComplete: false, allWavesComplete: false, hasCheckpointRequired };
  }

  // Use waveMap.size (count of distinct waves) for consistency with
  // fleet-utils.ts getWaveInfo which uses waveProgress.length (factory-core-cur.1.13)
  const totalWaves = waveMap.size;
  let currentWave = totalWaves;
  for (let w = 1; w <= totalWaves; w++) {
    const entry = waveMap.get(w);
    if (entry && entry.closed < entry.total) {
      currentWave = w;
      break;
    }
  }

  const currentEntry = waveMap.get(currentWave) ?? { total: 0, closed: 0 };
  const currentWaveComplete = currentEntry.closed >= currentEntry.total;
  const allWavesComplete = Array.from(waveMap.values()).every((e) => e.closed >= e.total);

  return { hasWaves: true, waves: waveMap, currentWave, totalWaves, currentWaveComplete, allWavesComplete, hasCheckpointRequired };
}

// ---------------------------------------------------------------------------
// Chain actions -- when an agent exits, optionally trigger the next step
// ---------------------------------------------------------------------------

const FLEET_CORE_PATH = "/Users/janemckay/dev/fleet/fleet-core";

/**
 * Returns true if the chain action handled the stage transition (so NEXT_STAGE
 * should be skipped), or false if normal NEXT_STAGE logic should proceed.
 */
async function handleChainAction(session: AgentSession, exitCode: number | null): Promise<boolean> {
  if (exitCode !== 0) return false; // Only chain on success

  const stage = session.pipelineStage;

  // -------------------------------------------------------------------------
  // research -> planning: auto-generate plan after research completes
  // -------------------------------------------------------------------------
  if (stage === "research") {
    try {
      // First apply the research-complete label (replacing research)
      const { addLabelsToEpic, removeLabelsFromEpic } = await import("./pipeline-labels");
      await removeLabelsFromEpic(session.epicId!, ["pipeline:research"]);
      await addLabelsToEpic(session.epicId!, ["pipeline:research-complete"]);

      // Auto-chain to planning
      await fetch("http://localhost:3000/api/fleet/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "generate-plan",
          epicId: session.epicId,
          epicTitle: session.repoName,
          currentLabels: session.epicLabels,
        }),
      });
      return true; // Chain handled (research -> planning)
    } catch (err) {
      console.error("Failed to chain planning after research:", err);
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // planning -> plan:pending: stop for owner review (human gate)
  // Owner clicks "Approve Plan" or "Revise Plan" from the dashboard.
  // Do NOT auto-chain to build — the plan must be reviewed first.
  // -------------------------------------------------------------------------
  if (stage === "planning") {
    // plan:pending is added by the EXIT_LABELS map (line ~167).
    // No auto-chain — return false so the normal exit handler applies EXIT_LABELS.
    return false;
  }

  // -------------------------------------------------------------------------
  // development -> wave review or QA: check wave status before chaining
  // -------------------------------------------------------------------------
  if (stage === "development") {
    try {
      // Use session.repoPath: for internal products that's fleet-core,
      // for other ship types it's the product repo where wave-labeled beads live
      const waveStatus = await getWaveStatus(session.epicId!, session.repoPath);

      if (waveStatus.hasWaves && !waveStatus.allWavesComplete) {
        // Waves exist and not all complete — chain to review-wave for the completed wave
        if (waveStatus.currentWaveComplete) {
          // Current wave is complete — launch reviewer for it
          await fetch("http://localhost:3000/api/fleet/action", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "review-wave",
              epicId: session.epicId,
              epicTitle: session.repoName,
              currentLabels: session.epicLabels,
              waveNumber: waveStatus.currentWave,
            }),
          });
          return true; // Chain handled (development -> wave review)
        }
        // Current wave not complete — builder didn't finish all beads, no chain
        return false;
      }

      // No waves or all waves complete — normal chain to QA
      await fetch("http://localhost:3000/api/fleet/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "send-for-qa",
          epicId: session.epicId,
          epicTitle: session.repoName,
          currentLabels: session.epicLabels,
        }),
      });
      return true; // Chain handled (development -> qa)
    } catch (err) {
      console.error("Failed to chain after build:", err);
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // build-review (wave review) -> next wave or QA
  // -------------------------------------------------------------------------
  if (stage === "build-review") {
    try {
      const waveStatus = await getWaveStatus(session.epicId!, session.repoPath);

      if (!waveStatus.hasWaves) {
        // No waves — shouldn't happen for wave review, but handle gracefully
        return false;
      }

      // Check if reviewer found P0/P1 issues — scoped to this epic's children
      // (factory-core-cur.1.22: was querying ALL repo bugs, not just epic children)
      let hasP0P1 = false;
      const bugResult = execBdSync(
        ["list", "--status=open", `--parent=${session.epicId}`],
        session.repoPath,
        10000,
      );
      if (bugResult.success) {
        // Count lines that are bugs with P0 or P1 priority
        // (factory-core-cur.1.25: use lineIsBugType() for format-resilient detection)
        const bugLines = bugResult.stdout.split("\n").filter(
          (line) => lineIsBugType(line) && /P[01]/.test(line),
        );
        hasP0P1 = bugLines.length > 0;
      } else {
        // If we can't query beads, assume bugs may exist (fail-safe)
        hasP0P1 = true;
      }

      if (hasP0P1) {
        // P0/P1 found — chain back to builder to fix same wave
        // Extract wave number from the prompt (e.g., "Review Wave 2 changes for epic...")
        const waveMatch = session.prompt.match(/Wave (\d+)/);
        const reviewedWave = waveMatch ? parseInt(waveMatch[1], 10) : waveStatus.currentWave;

        await fetch("http://localhost:3000/api/fleet/action", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "start-wave",
            epicId: session.epicId,
            epicTitle: session.repoName,
            currentLabels: session.epicLabels,
            waveNumber: reviewedWave,
          }),
        });
        return true; // Chain handled (review -> fix wave)
      }

      // Reviewer passed — determine next step
      const waveMatch = session.prompt.match(/Wave (\d+)/);
      const reviewedWave = waveMatch ? parseInt(waveMatch[1], 10) : waveStatus.currentWave;
      const nextWave = reviewedWave + 1;
      const hasNextWave = waveStatus.waves.has(nextWave);

      if (hasNextWave) {
        // More waves to go
        if (waveStatus.hasCheckpointRequired) {
          // Owner checkpoint required — add pending label and wait
          const { addLabelsToEpic } = await import("./pipeline-labels");
          await addLabelsToEpic(session.epicId!, ["wave-checkpoint:pending"]);
          return true; // Chain handled (paused for owner)
        }

        // Auto-advance to next wave
        await fetch("http://localhost:3000/api/fleet/action", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "start-wave",
            epicId: session.epicId,
            epicTitle: session.repoName,
            currentLabels: session.epicLabels,
            waveNumber: nextWave,
          }),
        });
        return true; // Chain handled (review -> next wave)
      }

      // Final wave passed — chain to QA
      await fetch("http://localhost:3000/api/fleet/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "send-for-qa",
          epicId: session.epicId,
          epicTitle: session.repoName,
          currentLabels: session.epicLabels,
        }),
      });
      return true; // Chain handled (final wave review -> qa)
    } catch (err) {
      console.error("Failed to chain after wave review:", err);
      return false;
    }
  }

  if (stage === "qa") {
    // After QA finishes, check if bugs were filed under this epic.
    // FAIL-SAFE: if we can't determine bug status, stay at QA rather than
    // advancing past unfixed bugs (factory-core-cur.1.16, .1.24).
    //
    // Root cause of .1.24: bare 'bd' in shell commands resolved to wrong
    // binary via Next.js PATH; '2>/dev/null || echo ""' swallowed the error,
    // returned empty string, hasBugs=false, pipeline advanced. Fix: use
    // execBdSync (getBdPath + getBdEnv) and treat bd failures as fail-safe.
    try {
      // Scope bug check to this epic's children (not all repo bugs)
      const childrenResult = execBdSync(
        ["list", "--status=open", `--parent=${session.epicId}`],
        session.repoPath,
        15000,
      );

      // FAIL-SAFE: if bd command failed, stay at QA
      if (!childrenResult.success) {
        console.error("QA chain: bd list failed — staying at QA (fail-safe)");
        return true;
      }

      // Check for any open bug beads under the epic
      // (factory-core-cur.1.25: use lineIsBugType() for format-resilient detection)
      const hasBugs = childrenResult.stdout.split("\n").some((line) => lineIsBugType(line));

      if (hasBugs) {
        // Check round count -- max 3 rounds
        const roundResult = execBdSync(["show", session.epicId!], FLEET_CORE_PATH, 10000);
        let currentRound = 1;
        if (roundResult.success) {
          const roundMatch = roundResult.stdout.match(/qa:round-(\d+)/g);
          if (roundMatch && roundMatch.length > 0) {
            const rounds = roundMatch.map((m: string) => parseInt(m.split("-")[1]));
            currentRound = Math.max(...rounds);
          }
        }

        if (currentRound >= 3) {
          // Max rounds -- flag for human review, don't loop
          console.log(`QA round ${currentRound}: max rounds reached, flagging for human review`);
          const { addLabelsToEpic } = await import("./pipeline-labels");
          await addLabelsToEpic(session.epicId!, ["qa:needs-review"]);
          return true; // Handled -- prevent NEXT_STAGE from advancing to submission-prep
        }

        // Send back to build crew to fix bugs, then re-QA
        await fetch("http://localhost:3000/api/fleet/action", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "qa-fix-and-retest",
            epicId: session.epicId,
            epicTitle: session.repoName,
            currentLabels: session.epicLabels,
          }),
        });
        return true; // Handled -- bugs found, looping back through dev -> QA
      }
      // No bugs under this epic -- QA passed!
      // Advance pipeline explicitly (don't rely on NEXT_STAGE which only maps to submission-prep)
      // factory-core-hnv.16: was returning false, falling through to NEXT_STAGE which
      // didn't always fire correctly. Now handles the transition directly.
      const { addLabelsToEpic: addQALabels, removeLabelsFromEpic: removeQALabels } = await import("./pipeline-labels");
      await removeQALabels(session.epicId!, ["pipeline:qa"]);
      await addQALabels(session.epicId!, ["pipeline:submission-prep", "qa:needs-review"]);
      console.log(`QA passed for ${session.epicId} — advanced to submission-prep`);
      return true; // Handled — don't fall through to NEXT_STAGE
    } catch (err) {
      console.error("Failed to handle QA chain:", err);
      // FAIL-SAFE: stay at QA if we can't determine bug status.
      // Better to pause for human review than advance past unfixed bugs.
      return true;
    }
  } else if (stage === "qa-fixes") {
    // After build crew fixes QA bugs, send back to QA
    try {
      await fetch("http://localhost:3000/api/fleet/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "send-for-qa",
          epicId: session.epicId,
          epicTitle: session.repoName,
          currentLabels: session.epicLabels,
        }),
      });
      return true; // Chain handled the transition (qa-fixes -> qa)
    } catch (err) {
      console.error("Failed to chain QA after bug fixes:", err);
      return false;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Ensure log directory exists
// ---------------------------------------------------------------------------

async function ensureLogDir(): Promise<void> {
  try {
    await fs.mkdir(LOG_DIR, { recursive: true });
  } catch {
    // Already exists
  }
}

// ---------------------------------------------------------------------------
// JSON log formatter — turns Claude CLI JSON output into readable progress
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
function formatAgentEvent(msg: any, ts: string, log: WriteStream): void {
  // Claude CLI --output-format json emits different message types
  const type = msg.type;

  if (type === "assistant" && msg.message?.content) {
    for (const block of msg.message.content) {
      if (block.type === "text" && block.text) {
        // Trim long text to keep log readable
        const text = block.text.length > 300
          ? block.text.slice(0, 300) + "..."
          : block.text;
        log.write(`[${ts}] THINKING: ${text}\n`);
      }
      if (block.type === "tool_use") {
        const input = block.input ?? {};
        const detail = formatToolDetail(block.name, input);
        log.write(`[${ts}] TOOL: ${block.name} ${detail}\n`);
      }
    }
  } else if (type === "result" && msg.result) {
    // Final result message
    const cost = msg.cost_usd ?? msg.result?.cost_usd;
    const costStr = cost ? ` ($${Number(cost).toFixed(4)})` : "";
    log.write(`[${ts}] RESULT: Agent finished${costStr}\n`);
  }
}

function formatToolDetail(name: string, input: any): string {
  switch (name) {
    case "Read":
      return input.file_path ? `→ ${input.file_path}` : "";
    case "Write":
      return input.file_path ? `→ ${input.file_path}` : "";
    case "Edit":
      return input.file_path ? `→ ${input.file_path}` : "";
    case "Glob":
      return input.pattern ? `→ ${input.pattern}` : "";
    case "Grep":
      return input.pattern ? `→ "${input.pattern}"` : "";
    case "Bash": {
      const cmd = input.command ?? "";
      const short = cmd.length > 100 ? cmd.slice(0, 100) + "..." : cmd;
      return `→ ${short}`;
    }
    case "Task":
      return input.description ? `→ ${input.description}` : "";
    default:
      return "";
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------

export async function launchAgent(options: LaunchOptions): Promise<AgentSession> {
  const repoKey = realpathSync(options.repoPath);
  const existing = activeAgents.get(repoKey);
  if (existing && !existing.process.killed && existing.process.exitCode === null) {
    throw new Error(
      `Agent already running (PID ${existing.session.pid}) in ${existing.session.repoName}. Stop it first.`,
    );
  }

  await ensureLogDir();

  const model = options.model ?? "sonnet";
  const maxTurns = options.maxTurns ?? 200;
  const allowedTools = options.allowedTools ?? "Bash,Read,Write,Edit,Glob,Grep";
  const repoName = options.repoName ?? path.basename(options.repoPath);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logFile = path.join(LOG_DIR, `agent-${repoName}-${timestamp}.log`);

  const args = [
    "-p",
    options.prompt,
    "--allowedTools",
    allowedTools,
    "--output-format",
    "json",
    "--max-turns",
    String(maxTurns),
    "--model",
    model,
  ];

  // Add agent name if specified
  if (options.agentName) {
    args.push("--agent", options.agentName);
  }

  // Ensure cwd exists (planning agents run in app repos that may not exist yet)
  await fs.mkdir(options.repoPath, { recursive: true });

  // Spawn via /bin/bash to ensure claude binary resolves correctly
  // (Node's spawn with Mach-O binaries + symlinks can fail with ENOENT)
  const claudeBin = process.env.CLAUDE_BIN || "/Users/janemckay/.local/bin/claude";
  const shellCmd = [claudeBin, ...args].map(a => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
  const child = spawn("/bin/bash", ["-c", shellCmd], {
    cwd: options.repoPath,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PATH: `/Users/janemckay/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: process.env.HOME || "/Users/janemckay",
      // Must unset CLAUDECODE to avoid "nested session" error
      CLAUDECODE: undefined,
      // Must unset ANTHROPIC_API_KEY so agents use the subscription, not the API
      // (beads_web loads this for Haiku title cleanup, but agents should not inherit it)
      ANTHROPIC_API_KEY: undefined,
      NO_COLOR: "1",
    },
  });

  // Parse JSON stdout into human-readable log; discard stderr (OTel noise)
  const writableLog = createWriteStream(logFile, { flags: "w" });
  writableLog.write(`[${new Date().toISOString()}] Agent started: ${model} in ${repoName}\n`);
  writableLog.write(`[${new Date().toISOString()}] Prompt: ${options.prompt.slice(0, 200)}...\n\n`);

  if (child.stdout) {
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      try {
        const msg = JSON.parse(line);
        const ts = new Date().toLocaleTimeString("en-GB", { hour12: false });
        formatAgentEvent(msg, ts, writableLog);
      } catch {
        // Non-JSON lines are OTel telemetry noise — discard them
      }
    });
  }
  // stderr is also OTel telemetry — discard it
  child.stderr?.resume();

  const session: AgentSession = {
    pid: child.pid!,
    repoPath: options.repoPath,
    repoName,
    prompt: options.prompt,
    model,
    startedAt: new Date().toISOString(),
    logFile,
    epicId: options.epicId,
    pipelineStage: options.pipelineStage,
    epicLabels: options.epicLabels,
  };

  activeAgents.set(repoKey, { session, process: child });
  await persistSession(session);

  // Clean up when process exits and handle pipeline label transitions
  child.on("exit", async (exitCode) => {
    const exitedAgent = activeAgents.get(repoKey);
    const exitedSession = exitedAgent?.session;
    if (exitedSession != null && exitedSession.pid === child.pid) {
      activeAgents.delete(repoKey);
      await clearPersistedSession(repoKey);

      // Perform pipeline label transitions if epicId and pipelineStage are set
      if (exitedSession.epicId && exitedSession.pipelineStage) {
        try {
          const { addLabelsToEpic, removeLabelsFromEpic } = await import("./pipeline-labels");

          // Always remove agent:running
          await removeLabelsFromEpic(exitedSession.epicId, ["agent:running"]);

          if (exitCode === 0) {
            // Check for special exit labels (e.g., planning -> plan:pending)
            const exitLabels = EXIT_LABELS[exitedSession.pipelineStage];
            if (exitLabels) {
              await addLabelsToEpic(exitedSession.epicId, exitLabels);
            }

            // Check if a chain action handles the transition (e.g., dev -> QA loop)
            const chainHandled = await handleChainAction(exitedSession, exitCode);

            // Advance to next pipeline stage only if no chain action took over
            if (!chainHandled) {
              const nextStage = NEXT_STAGE[exitedSession.pipelineStage];
              if (nextStage) {
                const currentLabel = `pipeline:${exitedSession.pipelineStage}`;
                await removeLabelsFromEpic(exitedSession.epicId, [currentLabel]);
                await addLabelsToEpic(exitedSession.epicId, [nextStage]);
              }
            }
          }
          // If non-zero exit, the pipeline label stays at the current stage
          // (card stays in the same column with no agent indicator)
        } catch (err) {
          console.error("Failed to update pipeline labels on agent exit:", err);
        }
      }
    }
    writableLog.write(`\n[${new Date().toLocaleTimeString("en-GB", { hour12: false })}] Agent exited (code ${exitCode})\n`);
    writableLog.end();
  });

  // Don't let the child keep our process alive
  child.unref();

  return session;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export interface AgentStatus {
  running: boolean;
  session: AgentSession | null;
  recentLog?: string;
}

/** Status of all agents across repos */
export interface FleetStatus {
  agents: AgentStatus[];
  totalRunning: number;
}

async function readRecentLog(logFile: string): Promise<string | undefined> {
  try {
    const stat = await fs.stat(logFile);
    const readSize = Math.min(stat.size, 8192);
    const offset = Math.max(0, stat.size - readSize);
    const fh = await fs.open(logFile, "r");
    const buf = Buffer.alloc(readSize);
    await fh.read(buf, 0, readSize, offset);
    await fh.close();
    return buf.toString("utf-8");
  } catch {
    return undefined;
  }
}

/**
 * Get status of a specific agent by repoPath, or the first running agent
 * (backwards-compatible for existing callers that expect a single agent).
 */
export async function getAgentStatus(repoPath?: string): Promise<AgentStatus> {
  if (repoPath) {
    const key = realpathSync(repoPath);
    const agent = activeAgents.get(key);
    if (!agent) return { running: false, session: null };
    if (agent.process.killed || agent.process.exitCode !== null) {
      activeAgents.delete(key);
      return { running: false, session: null };
    }
    return {
      running: true,
      session: agent.session,
      recentLog: await readRecentLog(agent.session.logFile),
    };
  }

  // No repoPath: return first running agent (backwards compat)
  for (const [key, agent] of activeAgents) {
    if (agent.process.killed || agent.process.exitCode !== null) {
      activeAgents.delete(key);
      continue;
    }
    return {
      running: true,
      session: agent.session,
      recentLog: await readRecentLog(agent.session.logFile),
    };
  }
  return { running: false, session: null };
}

/** Get status of all running agents */
export async function getFleetAgentStatus(): Promise<FleetStatus> {
  const agents: AgentStatus[] = [];

  for (const [key, agent] of activeAgents) {
    if (agent.process.killed || agent.process.exitCode !== null) {
      activeAgents.delete(key);
      continue;
    }
    agents.push({
      running: true,
      session: agent.session,
      recentLog: await readRecentLog(agent.session.logFile),
    });
  }

  return { agents, totalRunning: agents.length };
}

// ---------------------------------------------------------------------------
// Stop
// ---------------------------------------------------------------------------

/**
 * Stop an agent by repoPath. If no repoPath, stops the first running agent
 * (backwards compat). Pass "all" to stop all agents.
 */
export async function stopAgent(repoPath?: string): Promise<{ stopped: boolean; pid?: number; stoppedCount?: number }> {
  if (repoPath === "all") {
    let count = 0;
    for (const [key, agent] of activeAgents) {
      killAgent(agent);
      activeAgents.delete(key);
      await clearPersistedSession(agent.session.repoPath);
      count++;
    }
    return { stopped: count > 0, stoppedCount: count };
  }

  if (repoPath) {
    const key = realpathSync(repoPath);
    const agent = activeAgents.get(key);
    if (!agent) return { stopped: false };
    const pid = agent.session.pid;
    killAgent(agent);
    activeAgents.delete(key);
    await clearPersistedSession(repoPath);
    return { stopped: true, pid };
  }

  // No repoPath: stop first running agent (backwards compat)
  for (const [key, agent] of activeAgents) {
    const pid = agent.session.pid;
    killAgent(agent);
    activeAgents.delete(key);
    await clearPersistedSession(agent.session.repoPath);
    return { stopped: true, pid };
  }
  return { stopped: false };
}

function killAgent(agent: ActiveAgent): void {
  try {
    process.kill(-agent.session.pid, "SIGTERM");
  } catch {
    try {
      agent.process.kill("SIGTERM");
    } catch {
      // Already dead
    }
  }
}
