// =============================================================================
// Beads Fleet -- Generic Agent Launcher
// =============================================================================
//
// Spawns Claude Code CLI in tmux windows to run autonomous tasks in any
// configured beads-enabled repo. Using tmux windows (instead of child_process)
// enables Claude Code hooks which don't fire in -p mode.
//
// Extended for pipeline integration: tracks epicId and pipelineStage so that
// label transitions can be applied when the agent exits.
// =============================================================================

import { exec, execFileSync } from "child_process";
import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import { createWriteStream, realpathSync } from "fs";
import path from "path";
import os from "os";
import { promisify } from "util";
import { getBdPath, getBdEnv } from "./bd-path";
import { buildOtelEnv, buildLangfuseTraceUrl, isLangfuseConfigured } from "./langfuse-env";

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentSession {
  pid: number; // Kept for backwards compat, set to 0 for tmux sessions
  repoPath: string;
  repoName: string;
  prompt: string;
  model: string;
  startedAt: string;
  logFile: string;
  epicId?: string;
  pipelineStage?: string;
  epicLabels?: string[];
  langfuseTraceUrl?: string;
  langfuseSessionId?: string;
  // New tmux-specific fields
  tmuxWindow?: string;
  statusFile?: string;
  launcherScript?: string;
  tmuxSessionName?: string; // Actual tmux session name for lifecycle management
  transcriptFile?: string; // Path to the agent's JSONL transcript file
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
  pollInterval: NodeJS.Timeout; // Polls transcript for end_turn
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  langfuseSpan?: any; // OTEL Span for lifecycle trace (typed as any to avoid hard dep)
  flushSentAt?: number; // Timestamp when Langfuse flush messages were sent
  exitSentAt?: number; // Timestamp when /exit was sent
}

const activeAgents = new Map<string, ActiveAgent>();

const LOG_DIR = path.join(os.tmpdir(), "beads-web-agent-logs");
const SESSIONS_DIR = path.join(os.tmpdir(), "beads-web-agent-sessions");
const STATUS_DIR = path.join(os.tmpdir(), "beads-web-agent-status");
const LAUNCHER_DIR = path.join(os.tmpdir(), "beads-web-launchers");
const TMUX_SESSION = "shipyard";

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

  // Clean up legacy single-session file (always old, pre-tmux format)
  try {
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

        // Check if tmux session still exists
        const sessionName = session.tmuxSessionName || session.tmuxWindow;
        if (sessionName) {
          const stillRunning = await tmuxSessionAlive(sessionName);
          if (stillRunning) {
            recovered.push(session);
          } else {
            await fs.unlink(path.join(SESSIONS_DIR, file)).catch(() => {});
          }
        } else if (session.pid && isPidAlive(session.pid)) {
          // Old format (pre-tmux), check PID
          recovered.push(session);
        } else {
          // Dead session, clean up
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
// tmux helpers
// ---------------------------------------------------------------------------

/**
 * Ensure the Shipyard tmux session exists.
 */
async function ensureTmuxSession(): Promise<void> {
  try {
    await execAsync(`/opt/homebrew/bin/tmux has-session -t ${TMUX_SESSION} 2>/dev/null`);
  } catch {
    // Session doesn't exist, create it
    await execAsync(`/opt/homebrew/bin/tmux new-session -d -s ${TMUX_SESSION}`);
  }
}

/**
 * Check if a tmux window exists.
 */
async function tmuxWindowExists(windowName: string): Promise<boolean> {
  try {
    await execAsync(`/opt/homebrew/bin/tmux list-windows -t ${TMUX_SESSION} -F '#{window_name}' 2>/dev/null | grep -q '^${windowName}$'`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the status file written by the launcher script on exit.
 */
async function readStatusFile(statusFile: string): Promise<{exitCode: number} | null> {
  try {
    const data = await fs.readFile(statusFile, "utf-8");
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/**
 * Check if a tmux session exists by name (not window — each agent gets its own session).
 */
async function tmuxSessionAlive(sessionName: string): Promise<boolean> {
  try {
    await execAsync(`/opt/homebrew/bin/tmux has-session -t "${sessionName}" 2>/dev/null`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect whether Claude Code has finished its turn by reading the agent's
 * specific transcript JSONL file. Looks for the last assistant message with
 * stop_reason: "end_turn" — this means Claude completed its response and is
 * waiting for user input.
 *
 * Uses the transcript file detected at launch (session.transcriptFile) to
 * avoid reading the wrong session's transcript in a shared project directory.
 */
async function detectAgentDone(session: AgentSession): Promise<boolean> {
  try {
    const filePath = session.transcriptFile;
    if (!filePath) return false;

    // Check if file has been modified recently (still being written to)
    const stat = await fs.stat(filePath);
    if (Date.now() - stat.mtimeMs < 5000) return false;

    // Read the last ~8KB of the file to find the last assistant message
    const readSize = Math.min(stat.size, 8192);
    const fh = await fs.open(filePath, "r");
    const buf = Buffer.alloc(readSize);
    await fh.read(buf, 0, readSize, Math.max(0, stat.size - readSize));
    await fh.close();

    const text = buf.toString("utf-8");
    const lines = text.split("\n").filter((l) => l.trim().length > 0);

    // Walk backward to find the last assistant message
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        const msg = entry.message;
        if (!msg) continue;
        const role = entry.type === "assistant" ? "assistant" : msg.role;
        if (role === "assistant" && msg.stop_reason === "end_turn") {
          return true;
        }
        // If we hit a user message or tool_use stop_reason, Claude is still working
        if (role === "user" || role === "assistant") {
          return false;
        }
      } catch { continue; }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Send two Langfuse flush messages to a tmux session, spaced 5s apart.
 * "Thank you" triggers Stop 1 → stores real work as pending.
 * "Goodbye" triggers Stop 2 → emits the pending real work.
 * After this, the caller sends /exit — which only loses the throwaway goodbye turn.
 */
async function sendTmuxFlush(sessionName: string): Promise<void> {
  const tmux = "/opt/homebrew/bin/tmux";
  await execAsync(`${tmux} send-keys -t "${sessionName}" "Thank you, that's all." Enter`);
  await new Promise((resolve) => setTimeout(resolve, 5000));
  await execAsync(`${tmux} send-keys -t "${sessionName}" "Goodbye." Enter`);
}

/**
 * Send /exit to a tmux session to trigger clean Claude Code shutdown.
 * This fires the Stop hook (which sends Langfuse traces) before the process exits.
 */
async function sendTmuxExit(sessionName: string): Promise<void> {
  const tmux = "/opt/homebrew/bin/tmux";
  await execAsync(`${tmux} send-keys -t "${sessionName}" "/exit" Enter`);
}

// Timing constants
const EXIT_TIMEOUT_MS = 30000; // Force-kill 30s after /exit if session won't die
const RECOVERY_DEBOUNCE_MS = 10000; // Don't attempt recovery more than once per 10s

// ---------------------------------------------------------------------------
// Poll loop — extracted so both launchAgent() and recovery can use it
// ---------------------------------------------------------------------------

/**
 * Start the poll loop that monitors a pipeline agent's tmux session.
 *
 * Pipeline agents get one prompt and produce one end_turn when done.
 * The loop is simple:
 *   1. Poll transcript for end_turn (file stale for 5s)
 *   2. Send "Thank you" → wait 5s → send "Goodbye" (triggers 2 Stop hooks for Langfuse)
 *   3. Wait for next end_turn → send /exit
 *
 * If the session dies unexpectedly, handle exit immediately.
 */
function startPollLoop(
  session: AgentSession,
  repoKey: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  langfuseSpan?: any,
): NodeJS.Timeout {
  const logFile = session.logFile;
  const tmuxSession = session.tmuxSessionName!;

  return setInterval(async () => {
    const agent = activeAgents.get(repoKey);
    if (!agent) return;

    const alive = await tmuxSessionAlive(tmuxSession);

    if (!alive) {
      // Session is gone — agent exited (crash, max-turns, or post-/exit)
      clearInterval(agent.pollInterval);
      activeAgents.delete(repoKey);
      await clearPersistedSession(repoKey);

      const exitCode = agent.exitSentAt ? 0 : null;
      await handleAgentExit(session, exitCode, agent.langfuseSpan);

      const finalLog = createWriteStream(logFile, { flags: "a" });
      finalLog.write(`\n[${new Date().toISOString()}] Agent exited (code ${exitCode})\n`);
      finalLog.end();
      return;
    }

    // Force-kill if /exit was sent but session won't die
    if (agent.exitSentAt) {
      if (Date.now() - agent.exitSentAt > EXIT_TIMEOUT_MS) {
        clearInterval(agent.pollInterval);
        await killAgent(agent);
        activeAgents.delete(repoKey);
        await clearPersistedSession(repoKey);
        await handleAgentExit(session, null, agent.langfuseSpan);

        const finalLog = createWriteStream(logFile, { flags: "a" });
        finalLog.write(`\n[${new Date().toISOString()}] Agent force-killed after /exit timeout\n`);
        finalLog.end();
      }
      return;
    }

    if (agent.flushSentAt) {
      // Flush was sent — wait 15s for Claude to respond and Stop hooks to fire, then /exit
      if (Date.now() - agent.flushSentAt > 15000) {
        agent.exitSentAt = Date.now();
        try {
          await sendTmuxExit(tmuxSession);
          const exitLog = createWriteStream(logFile, { flags: "a" });
          exitLog.write(`[${new Date().toISOString()}] Post-flush timeout — sent /exit\n`);
          exitLog.end();
        } catch (err) {
          console.error("[tmux] Failed to send /exit:", err);
          agent.exitSentAt = undefined;
        }
      }
      return;
    }

    // Check transcript for end_turn
    const isDone = await detectAgentDone(session);
    if (!isDone) return;

    // Agent finished its work → send flush messages for Langfuse
    agent.flushSentAt = Date.now();
    try {
      await sendTmuxFlush(tmuxSession);
      const flushLog = createWriteStream(logFile, { flags: "a" });
      flushLog.write(`[${new Date().toISOString()}] Agent done (end_turn) — sent Langfuse flush messages\n`);
      flushLog.end();
    } catch (err) {
      console.error("[tmux] Failed to send flush messages:", err);
      agent.flushSentAt = undefined;
    }
  }, 5000);
}

// ---------------------------------------------------------------------------
// Session recovery — restores tracking after hot-reloads
// ---------------------------------------------------------------------------

let lastRecoveryAttempt = 0;

/**
 * Recover agent sessions from persisted files after a hot-reload clears
 * the in-memory activeAgents map. Starts poll loops for recovered sessions
 * so exit detection and PID box display work again.
 */
async function attemptRecovery(): Promise<void> {
  const now = Date.now();
  if (now - lastRecoveryAttempt < RECOVERY_DEBOUNCE_MS) return;
  lastRecoveryAttempt = now;

  const sessions = await recoverSessions();
  for (const session of sessions) {
    if (!session.tmuxSessionName) continue;
    let key: string;
    try {
      key = realpathSync(session.repoPath);
    } catch {
      continue; // Path doesn't exist
    }
    if (activeAgents.has(key)) continue; // Already tracked

    const pollInterval = startPollLoop(session, key);
    activeAgents.set(key, { session, pollInterval });
    console.log(`[recovery] Recovered agent session for ${session.repoName} (tmux: ${session.tmuxSessionName})`);
  }
}

/**
 * Generate the launcher script that runs in the tmux window.
 */
function generateLauncherScript(
  session: AgentSession,
  otelEnv: Record<string, string>,
  options: LaunchOptions,
): string {
  const model = options.model ?? "sonnet";
  const maxTurns = options.maxTurns ?? 200;
  const allowedTools = options.allowedTools ?? "Bash,Read,Write,Edit,Glob,Grep";

  // Build env var exports
  const envExports = Object.entries(otelEnv)
    .map(([key, value]) => `export ${key}="${value}"`)
    .join("\n");

  // Escape single quotes in prompt for shell
  const escapedPrompt = options.prompt.replace(/'/g, "'\\''");

  const agentArg = options.agentName ? `--agent ${options.agentName}` : "";

  return `#!/bin/bash
# Keep it simple — match the Terminal.app approach that's proven to work.
# Claude Code finds settings.local.json by walking up the directory tree,
# which injects TRACE_TO_LANGFUSE and Langfuse keys into the process.
# Hooks then inherit these env vars and send traces to Langfuse.

cd "${session.repoPath}"
unset ANTHROPIC_API_KEY
unset CLAUDECODE

/Users/janemckay/.local/bin/claude \\
  ${agentArg} \\
  --max-turns ${maxTurns} \\
  --model ${model} \\
  --dangerously-skip-permissions \\
  --allowedTools ${allowedTools} \\
  --append-system-prompt '${escapedPrompt}'

EXIT_CODE=$?

# Write status file so beads_web can detect exit
mkdir -p "${STATUS_DIR}"
cat > "${session.statusFile}" << STATUSEOF
{"exitCode": $EXIT_CODE, "exitedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)", "epicId": "${session.epicId || ""}", "pipelineStage": "${session.pipelineStage || ""}", "repoPath": "${session.repoPath}"}
STATUSEOF
`;
}

// ---------------------------------------------------------------------------
// Pipeline stage transitions
// ---------------------------------------------------------------------------

/**
 * Maps the pipeline stage the agent was launched for to the next stage
 * label that should be applied when the agent exits successfully.
 *
 * Stages handled by handleChainAction (auto-chaining) are NOT listed here:
 *   development → auto-chains to QA
 *   qa → auto-chains to fix loop or submission-prep
 *   qa-fixes → auto-chains back to QA
 *
 * Stages that stop for human review use EXIT_LABELS instead:
 *   research → exits to research-complete (human reviews, then clicks "Run PM")
 *   planning → exits with plan:pending (human reviews plan)
 */
const NEXT_STAGE: Record<string, string> = {
  // QA with no bugs falls through chain action → advances to submission-prep
  qa: "pipeline:submission-prep",
  "submission-prep": "pipeline:submitted",
  "kit-management": "pipeline:completed",
};

/**
 * Pipeline stages that get special label handling on agent exit rather
 * than advancing to the next stage. These stages stop for human review.
 *
 * research: stops at research-complete for human review before PM stage
 *   (factory-core-lxc.1: removed auto-chain to generate-plan)
 * planning: stops with plan:pending for human review before build
 */
const EXIT_LABELS: Record<string, string[]> = {
  research: ["pipeline:research-complete"],
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

// Resolve fleet-core path: env var > hardcoded fallback
// Externalised so the path isn't brittle if fleet-core moves.
const FLEET_CORE_PATH = process.env.FLEET_CORE_PATH || "/Users/janemckay/dev/fleet/fleet-core";

/**
 * Returns true if the chain action handled the stage transition (so NEXT_STAGE
 * should be skipped), or false if normal NEXT_STAGE logic should proceed.
 */
async function handleChainAction(session: AgentSession, exitCode: number | null): Promise<boolean> {
  if (exitCode !== 0) return false; // Only chain on success

  const stage = session.pipelineStage;

  // -------------------------------------------------------------------------
  // research -> research-complete: stop for human review (human gate)
  // Human reviews research, then clicks "Run PM" from the dashboard.
  // EXIT_LABELS handles the label transition. No auto-chain.
  // (factory-core-lxc.1: removed auto-chain to generate-plan)
  // -------------------------------------------------------------------------
  if (stage === "research") {
    return false;
  }

  // -------------------------------------------------------------------------
  // planning -> plan:pending: stop for owner review (human gate)
  // Owner clicks "Approve Plan" or "Revise Plan" from the dashboard.
  // Do NOT auto-chain to build — the plan must be reviewed first.
  // -------------------------------------------------------------------------
  if (stage === "planning") {
    // plan:pending is added by the EXIT_LABELS map.
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
// Agent exit handler — extracted from inline handler for reusability
// ---------------------------------------------------------------------------

/**
 * Handle agent exit: complete Langfuse trace, update pipeline labels, trigger chain actions.
 * Called by both the tmux polling mechanism and stopAgent().
 */
async function handleAgentExit(
  session: AgentSession,
  exitCode: number | null,
  langfuseSpan: any, // eslint-disable-line @typescript-eslint/no-explicit-any
): Promise<void> {
  // Complete Langfuse lifecycle trace BEFORE pipeline transitions (factory-core-75e)
  // Per ADR-003: independent try/catch — Langfuse errors must not affect pipeline logic
  if (langfuseSpan) {
    try {
      const { LangfuseOtelSpanAttributes } = await import("@langfuse/tracing");
      const duration = Date.now() - new Date(session.startedAt).getTime();
      const status = exitCode === 0 ? "SUCCESS" : "ERROR";
      langfuseSpan.setAttribute(
        LangfuseOtelSpanAttributes.TRACE_OUTPUT,
        JSON.stringify({ exitCode, durationMs: duration, status }),
      );
      if (exitCode !== 0) {
        langfuseSpan.setStatus({ code: 2, message: `Agent exited with code ${exitCode}` }); // SpanStatusCode.ERROR = 2
      } else {
        langfuseSpan.setStatus({ code: 1 }); // SpanStatusCode.OK = 1
      }
      langfuseSpan.end();
    } catch (err) {
      // ADR-003: Langfuse errors must never prevent exit handling or pipeline transitions
      console.error("[langfuse] Failed to complete lifecycle trace:", err);
    }
  }

  // Perform pipeline label transitions if epicId and pipelineStage are set
  if (session.epicId && session.pipelineStage) {
    try {
      const { addLabelsToEpic, removeLabelsFromEpic } = await import("./pipeline-labels");

      // Always remove agent:running
      await removeLabelsFromEpic(session.epicId, ["agent:running"]);

      if (exitCode === 0) {
        // Check for special exit labels (e.g., research -> pipeline:research-complete,
        // planning -> plan:pending). When exit labels include a pipeline:* label,
        // also remove the current pipeline label so only one is active.
        // (factory-core-lxc.1)
        const exitLabels = EXIT_LABELS[session.pipelineStage];
        if (exitLabels) {
          const hasNewPipelineLabel = exitLabels.some((l) => l.startsWith("pipeline:"));
          if (hasNewPipelineLabel) {
            const currentLabel = `pipeline:${session.pipelineStage}`;
            await removeLabelsFromEpic(session.epicId, [currentLabel]);
          }
          await addLabelsToEpic(session.epicId, exitLabels);
        }

        // Check if a chain action handles the transition (e.g., dev -> QA loop)
        const chainHandled = await handleChainAction(session, exitCode);

        // Advance to next pipeline stage only if no chain action took over
        if (!chainHandled) {
          const nextStage = NEXT_STAGE[session.pipelineStage];
          if (nextStage) {
            const currentLabel = `pipeline:${session.pipelineStage}`;
            await removeLabelsFromEpic(session.epicId, [currentLabel]);
            await addLabelsToEpic(session.epicId, [nextStage]);
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
// Launch
// ---------------------------------------------------------------------------

export async function launchAgent(options: LaunchOptions): Promise<AgentSession> {
  const repoKey = realpathSync(options.repoPath);
  const existing = activeAgents.get(repoKey);
  if (existing) {
    const stillRunning = existing.session.tmuxSessionName
      ? await tmuxSessionAlive(existing.session.tmuxSessionName)
      : false;
    if (stillRunning) {
      throw new Error(
        `Agent already running in tmux window "${existing.session.tmuxWindow}" in ${existing.session.repoName}. Stop it first.`,
      );
    }
  }

  await ensureLogDir();
  await fs.mkdir(STATUS_DIR, { recursive: true });
  await fs.mkdir(LAUNCHER_DIR, { recursive: true });

  const model = options.model ?? "sonnet";
  const repoName = options.repoName ?? path.basename(options.repoPath);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logFile = path.join(LOG_DIR, `agent-${repoName}-${timestamp}.log`);
  const statusFile = path.join(STATUS_DIR, `${options.epicId || repoName}-${options.pipelineStage || "unknown"}-${timestamp}.json`);
  const launcherScript = path.join(LAUNCHER_DIR, `launcher-${options.epicId || repoName}-${options.pipelineStage || "unknown"}-${timestamp}.sh`);
  const tmuxWindow = `${options.epicId || repoName}-${options.pipelineStage || "unknown"}`;

  // Ensure cwd exists (planning agents run in app repos that may not exist yet)
  await fs.mkdir(options.repoPath, { recursive: true });

  // Build OTEL env vars for Langfuse observability (factory-core-75e)
  // Returns empty object if Langfuse credentials are not configured (graceful degradation)
  const otelEnv = buildOtelEnv({
    epicId: options.epicId,
    agentType: options.agentName,
    pipelineStage: options.pipelineStage,
    repoName,
  });

  // Build Langfuse trace URL and session ID (factory-core-75e)
  const langfuseTraceUrl = options.epicId ? buildLangfuseTraceUrl(options.epicId) : undefined;
  const langfuseSessionId = options.epicId || undefined;

  const session: AgentSession = {
    pid: 0, // Backwards compat — set to 0 for tmux sessions
    repoPath: options.repoPath,
    repoName,
    prompt: options.prompt,
    model,
    startedAt: new Date().toISOString(),
    logFile,
    epicId: options.epicId,
    pipelineStage: options.pipelineStage,
    epicLabels: options.epicLabels,
    langfuseTraceUrl,
    langfuseSessionId,
    tmuxWindow,
    statusFile,
    launcherScript,
  };

  // Build the tmux session name — one session per agent
  const tmuxSession = `shipyard-${(options.epicId || repoName).replace(/[^a-zA-Z0-9_-]/g, "-")}-${(options.pipelineStage || "unknown").replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  session.tmuxSessionName = tmuxSession;

  // Build the inline claude command args
  const allowedTools = options.allowedTools ?? "Bash,Read,Write,Edit,Glob,Grep";
  const maxTurns = options.maxTurns ?? 200;
  const agentFlag = options.agentName ? `--agent ${options.agentName}` : "";

  // Create initial log file
  const writableLog = createWriteStream(logFile, { flags: "w" });
  writableLog.write(`[${new Date().toISOString()}] Agent started in tmux: ${model} in ${repoName}\n`);
  writableLog.write(`[${new Date().toISOString()}] Tmux session: ${tmuxSession}\n`);
  writableLog.write(`[${new Date().toISOString()}] Prompt: ${options.prompt.slice(0, 200)}...\n\n`);
  writableLog.end();

  // Create Langfuse lifecycle trace (factory-core-75e, ADR-003: try/catch required)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let langfuseSpan: any = undefined;
  if (isLangfuseConfigured()) {
    try {
      const { getLangfuseTracer, LangfuseOtelSpanAttributes } = await import("@langfuse/tracing");
      const tracer = getLangfuseTracer();
      const traceName = `agent-${options.agentName || "unknown"}-${options.epicId || "no-epic"}`;
      langfuseSpan = tracer.startSpan(traceName, {
        attributes: {
          [LangfuseOtelSpanAttributes.TRACE_NAME]: traceName,
          [LangfuseOtelSpanAttributes.TRACE_SESSION_ID]: langfuseSessionId || "",
          [LangfuseOtelSpanAttributes.TRACE_TAGS]: JSON.stringify(
            ["agent-lifecycle", options.agentName || "unknown", options.pipelineStage || "unknown"],
          ),
          [LangfuseOtelSpanAttributes.TRACE_METADATA]: JSON.stringify({
            epicId: options.epicId,
            agentType: options.agentName,
            pipelineStage: options.pipelineStage,
            repoName,
            repoPath: options.repoPath,
            model,
            tmuxWindow,
          }),
          [LangfuseOtelSpanAttributes.TRACE_INPUT]: JSON.stringify({
            prompt: options.prompt.slice(0, 500),
          }),
        },
      });
    } catch (err) {
      // ADR-003: Langfuse errors must never prevent agent launch
      console.error("[langfuse] Failed to create lifecycle trace:", err);
    }
  }

  // Generate a session ID so we know exactly which transcript file to read
  const claudeSessionId = randomUUID();
  const safeCwd = options.repoPath.replace(/\//g, "-").replace(/^-/, "-");
  const projectDir = path.join(os.homedir(), ".claude", "projects", safeCwd);
  session.transcriptFile = path.join(projectDir, `${claudeSessionId}.jsonl`);

  // Launch in tmux with --session-id so the transcript file is predictable
  const tmuxCmd = `export PATH="/opt/homebrew/bin:$PATH" && cd ${session.repoPath} && unset ANTHROPIC_API_KEY && unset CLAUDECODE && /Users/janemckay/.local/bin/claude ${agentFlag} --session-id ${claudeSessionId} --max-turns ${maxTurns} --model ${model} --dangerously-skip-permissions --allowedTools ${allowedTools}`;
  await execAsync(`/opt/homebrew/bin/tmux new-session -d -s "${tmuxSession}" "${tmuxCmd}"`);

  // Wait for Claude Code to initialise, then paste the prompt
  const promptFile = path.join(LAUNCHER_DIR, `prompt-${tmuxSession}.txt`);
  await fs.writeFile(promptFile, options.prompt);

  setTimeout(async () => {
    try {
      const tmux = "/opt/homebrew/bin/tmux";
      await execAsync(`${tmux} load-buffer "${promptFile}"`);
      await execAsync(`${tmux} paste-buffer -t "${tmuxSession}"`);
      await execAsync(`${tmux} send-keys -t "${tmuxSession}" Enter`);
      await fs.unlink(promptFile).catch(() => {});
    } catch (err) {
      console.error("[tmux] Failed to send prompt:", err);
    }
  }, 6000);

  // Start poll loop for exit detection (extracted for reuse by session recovery)
  const pollInterval = startPollLoop(session, repoKey, langfuseSpan);

  activeAgents.set(repoKey, { session, pollInterval, langfuseSpan });
  await persistSession(session);

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
  // Recover sessions lost to hot-reloads
  if (activeAgents.size === 0) {
    await attemptRecovery();
  }

  if (repoPath) {
    const key = realpathSync(repoPath);
    const agent = activeAgents.get(key);
    if (!agent) return { running: false, session: null };
    if (agent.session.tmuxSessionName) {
      const stillRunning = await tmuxSessionAlive(agent.session.tmuxSessionName);
      if (!stillRunning) {
        activeAgents.delete(key);
        return { running: false, session: null };
      }
    }
    return {
      running: true,
      session: agent.session,
      recentLog: await readRecentLog(agent.session.logFile),
    };
  }

  // No repoPath: return first running agent (backwards compat)
  for (const [key, agent] of activeAgents) {
    if (agent.session.tmuxSessionName) {
      const stillRunning = await tmuxSessionAlive(agent.session.tmuxSessionName);
      if (!stillRunning) {
        activeAgents.delete(key);
        continue;
      }
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
  // Recover sessions lost to hot-reloads
  if (activeAgents.size === 0) {
    await attemptRecovery();
  }

  const agents: AgentStatus[] = [];

  for (const [key, agent] of activeAgents) {
    if (agent.session.tmuxSessionName) {
      const stillRunning = await tmuxSessionAlive(agent.session.tmuxSessionName);
      if (!stillRunning) {
        activeAgents.delete(key);
        continue;
      }
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
      await killAgent(agent);
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
    await killAgent(agent);

    // Call exit handler immediately for manual stops
    await handleAgentExit(agent.session, null, agent.langfuseSpan);

    activeAgents.delete(key);
    await clearPersistedSession(repoPath);
    return { stopped: true, pid };
  }

  // No repoPath: stop first running agent (backwards compat)
  for (const [key, agent] of activeAgents) {
    const pid = agent.session.pid;
    await killAgent(agent);

    // Call exit handler immediately for manual stops
    await handleAgentExit(agent.session, null, agent.langfuseSpan);

    activeAgents.delete(key);
    await clearPersistedSession(agent.session.repoPath);
    return { stopped: true, pid };
  }
  return { stopped: false };
}

async function killAgent(agent: ActiveAgent): Promise<void> {
  // Stop the polling interval
  clearInterval(agent.pollInterval);

  // Kill the tmux session (each agent runs in its own session)
  const sessionName = agent.session.tmuxSessionName;
  if (sessionName) {
    try {
      await execAsync(`/opt/homebrew/bin/tmux kill-session -t "${sessionName}"`);
    } catch {
      // Session may already be gone
    }
  }
}
