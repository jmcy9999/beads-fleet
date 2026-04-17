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
  /** Wave number this agent is scoped to (factory-core-z9h.2). */
  waveNumber?: number;
  /** Bead ID this agent is scoped to (factory-core-z9h.3). */
  beadId?: string;
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
  /**
   * Wave number this agent is working (factory-core-z9h.2).
   * Included in the tmux session name and session file so that each wave
   * gets a visibly distinct session — no name collision between successive
   * waves of the same epic. When unset, session naming falls back to the
   * legacy <epicId>-<pipelineStage> form.
   */
  waveNumber?: number;
  /**
   * Bead ID this agent is scoped to (factory-core-z9h.3).
   * When set, the agent is a per-bead parallel builder and its session name,
   * session file, and activeAgents key all include the bead ID so that
   * multiple agents can run concurrently in the same repo and wave without
   * clobbering each other's state.
   */
  beadId?: string;
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

// ---------------------------------------------------------------------------
// Wave review idempotency guard (factory-core-z9h.6)
// ---------------------------------------------------------------------------
//
// When N parallel builders run in a wave, each one's exit fires
// handleChainAction. Two (or more) near-simultaneous exits can both see
// `currentWaveComplete === true` and both try to fire `review-wave`. This
// module-level Set keyed on `${epicId}::${wave}` ensures `review-wave`
// fires exactly once per (epic, wave) pair.
//
// The poll loop can also double-fire handleAgentExit for a single agent
// (session death + final poll). The same guard covers that case.
//
// The set is cleared when review-wave itself closes (via clearWaveReviewGuard)
// so a RE-run of the same wave (e.g. after a bug fix) can re-trigger review.
// ---------------------------------------------------------------------------
const firedWaveReviews = new Set<string>();

/**
 * Returns true if `review-wave` has NOT yet been fired for this (epic, wave)
 * pair. Callers should check this BEFORE firing review-wave and call
 * {@link markWaveReviewFired} immediately after a successful dispatch.
 *
 * Exported for tests.
 */
export function shouldFireWaveReview(epicId: string, wave: number): boolean {
  return !firedWaveReviews.has(`${epicId}::${wave}`);
}

/**
 * Record that review-wave has been dispatched for this (epic, wave) pair.
 * Subsequent shouldFireWaveReview calls return false until the guard is
 * cleared.
 *
 * Exported for tests.
 */
export function markWaveReviewFired(epicId: string, wave: number): void {
  firedWaveReviews.add(`${epicId}::${wave}`);
}

/**
 * Clear the wave review guard for an epic — optionally for a specific wave.
 * Called when the reviewer round completes and the next wave launches, so a
 * future re-run of the same wave (after bug fixes) can re-trigger review.
 *
 * Exported for tests.
 */
export function clearWaveReviewGuard(epicId: string, wave?: number): void {
  if (typeof wave === "number") {
    firedWaveReviews.delete(`${epicId}::${wave}`);
    return;
  }
  // Clear all waves for this epic (e.g. on epic close / reset).
  for (const key of Array.from(firedWaveReviews)) {
    if (key.startsWith(`${epicId}::`)) firedWaveReviews.delete(key);
  }
}

/**
 * Returns true if an agent is currently running for (repoPath, beadId).
 * Exported so route.ts can skip re-launching heads that are already active
 * when start-wave is called from the auto-chain after a bead closes
 * (factory-core-z9h.6 tail-bead launch).
 */
export function isAgentActive(repoPath: string, beadId?: string): boolean {
  const key = activeAgentKey(repoPath, beadId);
  return activeAgents.has(key);
}

/**
 * Returns true if at least one tracked agent still belongs to `epicId`.
 *
 * Under parallel per-bead builders (factory-core-z9h.3) multiple active
 * agents share a single epicId. This helper is the guard used by
 * {@link handleAgentExit} before clearing the `agent:running` label so the
 * label survives until the LAST builder for the epic exits
 * (factory-core-z9h.11).
 *
 * Note: startPollLoop removes the exiting agent from `activeAgents` BEFORE
 * handleAgentExit runs, so this check does not need to exclude the current
 * session.
 *
 * Exported for tests.
 */
export function hasActiveAgentForEpic(epicId: string): boolean {
  for (const agent of activeAgents.values()) {
    if (agent.session.epicId === epicId) return true;
  }
  return false;
}

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

/**
 * Compute the scope suffix used in session/tmux/launcher/status file names.
 *
 * factory-core-z9h.2 introduces wave scoping so that successive waves of the
 * same epic get visibly distinct tmux sessions (and distinct persisted state
 * files) — preventing collisions when the auto-chain hands off wave N → N+1.
 *
 * factory-core-z9h.3 will extend this by also including beadId so that
 * parallel per-bead builders within the same wave don't clobber each other.
 *
 * Returns an empty string when no scope is set — legacy single-agent-per-repo
 * callers keep the pre-z9h session naming pattern.
 */
export function sessionScopeSuffix(waveNumber?: number, beadId?: string): string {
  const parts: string[] = [];
  if (typeof waveNumber === "number" && Number.isFinite(waveNumber)) {
    parts.push(`wave${waveNumber}`);
  }
  if (beadId) {
    parts.push(beadId.replace(/[^a-zA-Z0-9_-]/g, "-"));
  }
  return parts.length > 0 ? `-${parts.join("-")}` : "";
}

function sessionFileFor(
  repoPath: string,
  waveNumber?: number,
  beadId?: string,
): string {
  const safe = repoPath.replace(/\//g, "_");
  const suffix = sessionScopeSuffix(waveNumber, beadId);
  return path.join(SESSIONS_DIR, `agent-${safe}${suffix}.json`);
}

async function persistSession(session: AgentSession): Promise<void> {
  try {
    await fs.mkdir(SESSIONS_DIR, { recursive: true });
    await fs.writeFile(
      sessionFileFor(session.repoPath, session.waveNumber, session.beadId),
      JSON.stringify(session, null, 2),
      "utf-8",
    );
  } catch {
    // Best effort — don't break the launch
  }
}

async function clearPersistedSession(
  repoPath: string,
  waveNumber?: number,
  beadId?: string,
): Promise<void> {
  try {
    await fs.unlink(sessionFileFor(repoPath, waveNumber, beadId));
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
 * Run the full Langfuse flush + exit sequence for a pipeline agent.
 *
 * 1. Send "Thank you" → wait 10s → call hook (ingests real work, stores as pending)
 * 2. Send "Goodbye" → wait 10s → call hook (emits the pending real work)
 * 3. Send /exit
 *
 * Calls langfuse_hook.py directly rather than relying on the Stop hook,
 * which doesn't fire reliably for spawned agents.
 */
async function runFlushAndExit(
  sessionName: string,
  session: AgentSession,
  logFile: string,
): Promise<void> {
  const tmux = "/opt/homebrew/bin/tmux";
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const callHook = async () => {
    if (!session.transcriptFile) return;
    const payload = JSON.stringify({
      session_id: session.transcriptFile.split("/").pop()?.replace(".jsonl", "") || "",
      transcript_path: session.transcriptFile,
      cwd: session.repoPath,
      hook_event_name: "Stop",
    });
    const hookEnv = {
      ...process.env,
      TRACE_TO_LANGFUSE: "true",
      ...buildOtelEnv({ epicId: session.epicId, agentType: session.pipelineStage, pipelineStage: session.pipelineStage, repoName: session.repoName }),
    };
    await execAsync(`echo '${payload.replace(/'/g, "'\\''")}' | python3 ~/.claude/hooks/langfuse_hook.py`, { timeout: 10000, env: hookEnv });
  };

  // Step 1: "Thank you" → wait → call hook (ingests + stores pending)
  await execAsync(`${tmux} send-keys -t "${sessionName}" "Thank you, that's all." Enter`);
  const log1 = createWriteStream(logFile, { flags: "a" });
  log1.write(`[${new Date().toISOString()}] Sent "Thank you"\n`);
  log1.end();
  await wait(10000);
  try { await callHook(); } catch (err) { console.error("[langfuse] Hook call 1 failed:", err); }
  const log2 = createWriteStream(logFile, { flags: "a" });
  log2.write(`[${new Date().toISOString()}] Hook call 1 complete\n`);
  log2.end();

  // Step 2: "Goodbye" → wait → call hook (emits pending real work)
  await execAsync(`${tmux} send-keys -t "${sessionName}" "Goodbye." Enter`);
  const log3 = createWriteStream(logFile, { flags: "a" });
  log3.write(`[${new Date().toISOString()}] Sent "Goodbye"\n`);
  log3.end();
  await wait(10000);
  try { await callHook(); } catch (err) { console.error("[langfuse] Hook call 2 failed:", err); }
  const log4 = createWriteStream(logFile, { flags: "a" });
  log4.write(`[${new Date().toISOString()}] Hook call 2 complete\n`);
  log4.end();

  // Step 3: /exit
  await execAsync(`${tmux} send-keys -t "${sessionName}" "/exit" Enter`);
  const log5 = createWriteStream(logFile, { flags: "a" });
  log5.write(`[${new Date().toISOString()}] Sent /exit\n`);
  log5.end();
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
      await clearPersistedSession(repoKey, session.waveNumber, session.beadId);

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
        await clearPersistedSession(repoKey, session.waveNumber, session.beadId);
        await handleAgentExit(session, null, agent.langfuseSpan);

        const finalLog = createWriteStream(logFile, { flags: "a" });
        finalLog.write(`\n[${new Date().toISOString()}] Agent force-killed after /exit timeout\n`);
        finalLog.end();
      }
      return;
    }

    // Already flushing/exiting — wait for session to die
    if (agent.flushSentAt) return;

    // Check transcript for end_turn
    const isDone = await detectAgentDone(session);
    if (!isDone) return;

    // Agent finished — stop polling, run flush + exit sequence
    clearInterval(agent.pollInterval);
    agent.flushSentAt = Date.now();

    try {
      await runFlushAndExit(tmuxSession, session, logFile);
      agent.exitSentAt = Date.now();

      // Clean up — session is dead after /exit
      activeAgents.delete(repoKey);
      await clearPersistedSession(repoKey, session.waveNumber, session.beadId);
      await handleAgentExit(session, 0, agent.langfuseSpan);
    } catch (err) {
      console.error("[flush-exit] Sequence failed:", err);
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
      // factory-core-z9h.3: recover composite key so per-bead parallel
      // builders (same repo, different beadId) don't collapse into one
      // tracked slot.
      key = activeAgentKey(session.repoPath, session.beadId);
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

export interface WaveStatus {
  hasWaves: boolean;
  waves: Map<number, { total: number; closed: number }>;
  currentWave: number;
  totalWaves: number;
  currentWaveComplete: boolean;
  allWavesComplete: boolean;
  hasCheckpointRequired: boolean;
  /**
   * Total number of direct children of the epic (factory-core-z9h.4).
   * Used by send-for-development to distinguish "no children at all" from
   * "no children have wave labels" from "all children closed".
   */
  totalChildren: number;
  /**
   * Count of children that have a wave:N label (factory-core-z9h.4).
   * If 0 < childrenWithWaveLabels < totalChildren the labelling is
   * inconsistent and the caller should reject — we never silently mix
   * waved and un-waved beads in the same epic.
   */
  childrenWithWaveLabels: number;
  /**
   * Present when wave state COULD NOT BE DETERMINED because one or more
   * underlying `bd` commands failed (factory-core-z9h.10).
   *
   * Callers must treat a non-empty `error` as "unknown wave state" and
   * MUST NOT proceed as if the wave were complete or as if the epic had
   * no wave labels. Specifically:
   *   - handleChainAction returns false (pipeline label stays unchanged)
   *   - send-for-development returns a 500 (does not fall through to the
   *     legacy single-session path)
   *
   * This enforces the three-branch contract from regression pattern #7
   * (Type Confusion): all-labelled / none-labelled / UNKNOWN are three
   * distinct states. "Unknown" must not silently collapse into
   * "none-labelled" — that was the silent-advance bug this field closes.
   *
   * Regression patterns:
   *   #13 Silent Exception Swallowing — a bd-command failure must not
   *   be reinterpreted as a successful result that says "no waves here".
   */
  error?: string;
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

  // Step 1: Get all children IDs and closed status
  // For internal epics, beads are in the same repo — use --parent
  // For product epics, beads are in a separate repo — use --label
  const isInternal = epicResult.stdout.includes("ship-type:internal");
  const filterArgs = isInternal
    ? ["list", "--status=all", `--parent=${epicId}`]
    : ["list", "--status=all", "--label", `epic:${epicId}`];
  const childrenResult = execBdSync(filterArgs, repoPath, 10000);
  if (!childrenResult.success) {
    // factory-core-z9h.10: do NOT silently collapse a bd failure into
    // hasWaves=false. Surface an error so callers (handleChainAction,
    // send-for-development) can refuse to advance the pipeline on
    // unknown wave state (regression pattern #13 / #7).
    return {
      hasWaves: false,
      waves: new Map(),
      currentWave: 0,
      totalWaves: 0,
      currentWaveComplete: false,
      allWavesComplete: false,
      hasCheckpointRequired,
      totalChildren: 0,
      childrenWithWaveLabels: 0,
      error: `bd list failed for epic ${epicId} (filter=${filterArgs.slice(1).join(" ")}) — cannot determine wave state`,
    };
  }

  const children = parseChildrenFromTree(childrenResult.stdout);
  if (children.length === 0) {
    return { hasWaves: false, waves: new Map(), currentWave: 0, totalWaves: 0, currentWaveComplete: false, allWavesComplete: false, hasCheckpointRequired, totalChildren: 0, childrenWithWaveLabels: 0 };
  }

  // Step 2: Get wave labels from bd show for each child
  // (factory-core-cur.1.26: bd list --parent= tree output omits labels,
  // so we must query each child individually to get wave:N labels)
  const waveMap = new Map<number, { total: number; closed: number }>();
  let childrenWithWaveLabels = 0;
  for (const child of children) {
    const showResult = execBdSync(["show", child.id], repoPath, 5000);
    if (!showResult.success) {
      // factory-core-z9h.8: do NOT silently skip a failed `bd show`.
      // Before this guard, a transient bd failure on one child was
      // reinterpreted as "this child has no wave label" — the child was
      // dropped from both totalChildren (via waveMap entries) and
      // childrenWithWaveLabels counters. If that dropped child was the
      // last unclosed bead in its wave, currentWaveComplete flipped to
      // true and handleChainAction dispatched review-wave / send-for-qa
      // while the bead was still open.
      //
      // z9h.10 already surfaces outer `bd list` failures via WaveStatus.error
      // and callers (handleChainAction dev-branch, send-for-development)
      // already refuse to advance when `error` is set. Mirror that contract
      // here for per-child show failures: return immediately with a populated
      // `error` so the pipeline stays at pipeline:development until bd is
      // reachable again.
      //
      // Regression patterns:
      //   #13 Silent Exception Swallowing — a bd failure must not
      //       masquerade as a successful "no wave label" result.
      //   #7  Type Confusion on Enum Branching — all-labelled /
      //       none-labelled / UNKNOWN are three distinct states; a
      //       transient bd failure is UNKNOWN, not none-labelled.
      return {
        hasWaves: false,
        waves: new Map(),
        currentWave: 0,
        totalWaves: 0,
        currentWaveComplete: false,
        allWavesComplete: false,
        hasCheckpointRequired,
        totalChildren: children.length,
        childrenWithWaveLabels: 0,
        error: `bd show failed for child ${child.id} of epic ${epicId} — cannot determine wave state`,
      };
    }

    const waveMatch = showResult.stdout.match(/wave:(\d+)/);
    if (!waveMatch) continue;
    const waveNum = parseInt(waveMatch[1], 10);
    if (isNaN(waveNum)) continue;

    childrenWithWaveLabels += 1;
    const entry = waveMap.get(waveNum) ?? { total: 0, closed: 0 };
    entry.total += 1;
    if (child.isClosed) {
      entry.closed += 1;
    }
    waveMap.set(waveNum, entry);
  }

  if (waveMap.size === 0) {
    return { hasWaves: false, waves: waveMap, currentWave: 0, totalWaves: 0, currentWaveComplete: false, allWavesComplete: false, hasCheckpointRequired, totalChildren: children.length, childrenWithWaveLabels: 0 };
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

  return { hasWaves: true, waves: waveMap, currentWave, totalWaves, currentWaveComplete, allWavesComplete, hasCheckpointRequired, totalChildren: children.length, childrenWithWaveLabels };
}

// ---------------------------------------------------------------------------
// factory-core-z9h.3: per-bead parallel builders
// ---------------------------------------------------------------------------

export interface WaveBead {
  /** Bead ID (e.g. factory-core-z9h.3) */
  id: string;
  /** First-line summary of the bead, for prompt construction */
  title: string;
  /**
   * Files the bead declares it will touch (z9h.7 "Files:" manifest).
   * Empty when the bead has no manifest — callers must treat that as
   * "unknown files → conservatively conflicts with everything else"
   * (see groupBeadsByFileConflict).
   */
  files: string[];
}

/**
 * Parse the Files: manifest from a `bd show` output.
 *
 * Expected format (produced by the planner once z9h.7 lands):
 *   Files:
 *   - path/to/file1.ts
 *   - path/to/file2.ts
 *
 * Returns an empty array if no Files: section is found, or if the section
 * exists but contains no bullet-list entries. Tolerant of both `- path` and
 * `* path` bullets and of additional whitespace.
 */
export function parseFilesManifest(showOutput: string): string[] {
  const lines = showOutput.split("\n");
  const files: string[] = [];
  let inFilesSection = false;
  // Header variants the planner may emit:
  //   "Files:"
  //   "## Files"
  //   "**Files:**"
  //   "FILES" (all-caps bd-show style)
  const filesHeader = /^\s*(?:#+\s*)?\*{0,2}\s*Files\s*:?\s*\*{0,2}\s*$/i;
  // Any bd-show-style section header: one or more ALL-CAPS words, optionally
  // followed by a colon and content on the same line. Matches "LABELS:",
  // "NOTES", "PARENT", "DEPENDS ON", "DESCRIPTION", etc. A bullet line like
  // "- x.ts" never matches because it doesn't start with a capital letter.
  const bdSectionHeader = /^[A-Z][A-Z ]*[A-Z](?:\s*:.*)?$/;
  // A markdown heading that is NOT the Files heading — e.g. "## Approach".
  const otherMarkdownHeader = /^#+\s+\S/;

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!inFilesSection) {
      if (filesHeader.test(line)) inFilesSection = true;
      continue;
    }
    // Files: header → stop at the next section boundary (bd-show header or
    // a new markdown heading, but NOT the Files heading itself).
    if (bdSectionHeader.test(line) && !filesHeader.test(line)) break;
    if (otherMarkdownHeader.test(line) && !filesHeader.test(line)) break;

    const bullet = line.match(/^\s*[-*]\s+(\S.*)$/);
    if (bullet) {
      // Strip trailing backticks (markdown code spans) and trim whitespace.
      const cleaned = bullet[1].replace(/`/g, "").trim();
      if (cleaned) files.push(cleaned);
      continue;
    }
    // Blank line inside the section — tolerate and keep scanning.
    if (line.trim() === "") continue;
    // Non-bullet prose inside Files: is ignored but doesn't end the section.
  }
  return files;
}

/**
 * Group beads into parallel-safe clusters based on shared file touches.
 *
 * Any two beads that share even one file form a conflict edge and must run
 * sequentially (they land in the same group). Beads with no shared files
 * form independent groups that can launch in parallel.
 *
 * Beads with an EMPTY files array are treated as "unknown touch set" and
 * must run sequentially with every other unknown-touch-set bead — we
 * conservatively assume conflict rather than silently racing filesystem
 * writes. Once z9h.7 ships and every bead has a manifest, this fallback
 * becomes moot.
 *
 * Returns: Array of groups. Each group is an ordered list of beads that
 * must run sequentially. Different groups may run in parallel.
 */
export function groupBeadsByFileConflict(beads: WaveBead[]): WaveBead[][] {
  if (beads.length === 0) return [];

  // Union-find over bead indices.
  const parent = beads.map((_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  // Build file -> bead-indices map to find overlaps efficiently.
  const fileToBeads = new Map<string, number[]>();
  const unknownBeads: number[] = [];
  for (let i = 0; i < beads.length; i++) {
    const files = beads[i].files;
    if (files.length === 0) {
      unknownBeads.push(i);
      continue;
    }
    for (const file of files) {
      const list = fileToBeads.get(file) ?? [];
      list.push(i);
      fileToBeads.set(file, list);
    }
  }

  // Union beads that share files.
  for (const indices of fileToBeads.values()) {
    for (let k = 1; k < indices.length; k++) {
      union(indices[0], indices[k]);
    }
  }

  // Union all unknown-manifest beads together — conservative default.
  for (let k = 1; k < unknownBeads.length; k++) {
    union(unknownBeads[0], unknownBeads[k]);
  }

  // Collect groups, preserving input order within each group so the caller
  // can rely on a stable sequential launch order.
  const groupsByRoot = new Map<number, WaveBead[]>();
  for (let i = 0; i < beads.length; i++) {
    const root = find(i);
    const arr = groupsByRoot.get(root) ?? [];
    arr.push(beads[i]);
    groupsByRoot.set(root, arr);
  }
  return Array.from(groupsByRoot.values());
}

/**
 * List open beads labelled wave:N for a given epic, reading their Files:
 * manifests so the caller can group them for parallel vs sequential launch.
 */
export async function listOpenWaveBeads(
  epicId: string,
  wave: number,
  repoPath: string,
): Promise<WaveBead[]> {
  if (!Number.isFinite(wave) || wave < 1) return [];

  const epicResult = execBdSync(["show", epicId], repoPath, 10000);
  const isInternal = epicResult.success && epicResult.stdout.includes("ship-type:internal");
  const filterArgs = isInternal
    ? ["list", "--status=all", `--parent=${epicId}`]
    : ["list", "--status=all", "--label", `epic:${epicId}`];
  const listResult = execBdSync(filterArgs, repoPath, 10000);
  if (!listResult.success) return [];

  const children = parseChildrenFromTree(listResult.stdout);
  const open: WaveBead[] = [];
  for (const child of children) {
    if (child.isClosed) continue;
    const showResult = execBdSync(["show", child.id], repoPath, 5000);
    if (!showResult.success) continue;

    // Confirm wave label matches the requested wave — filter defensively
    // since we're not using a composite --label filter on bd list.
    const waveMatch = showResult.stdout.match(/wave:(\d+)/);
    if (!waveMatch) continue;
    if (parseInt(waveMatch[1], 10) !== wave) continue;

    // Title is the first line of the show output that looks like
    // "... · <Bead ID> · <Title> ...". Fall back to the bead ID.
    const titleMatch = showResult.stdout.match(
      new RegExp(`${child.id.replace(/\./g, "\\.")}\\s*·\\s*([^\\n\\[]+?)\\s*\\[`),
    );
    const title = titleMatch ? titleMatch[1].trim() : child.id;

    const files = parseFilesManifest(showResult.stdout);
    open.push({ id: child.id, title, files });
  }
  return open;
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

      // factory-core-z9h.10: a bd failure means wave state is UNKNOWN.
      // Before this guard, a failed `bd list` returned hasWaves=false and
      // the code below fell through to an unconditional send-for-qa —
      // silently advancing an epic with unclosed beads. Returning false
      // here keeps the pipeline label at `pipeline:development` and
      // prevents the silent advance (regression patterns #13 / #7).
      if (waveStatus.error) {
        console.error(
          `chain (development): refusing to advance — ${waveStatus.error}`,
        );
        return false;
      }

      if (waveStatus.hasWaves && !waveStatus.allWavesComplete) {
        // Waves exist and not all complete — chain to review-wave for the completed wave
        if (waveStatus.currentWaveComplete) {
          // factory-core-z9h.6: With N parallel per-bead builders, two exits
          // may race and both see currentWaveComplete=true. The guard
          // ensures review-wave is dispatched exactly once per (epic, wave).
          if (!shouldFireWaveReview(session.epicId!, waveStatus.currentWave)) {
            return true; // Already handled by an earlier exit.
          }
          markWaveReviewFired(session.epicId!, waveStatus.currentWave);
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

        // factory-core-z9h.6: wave not complete. If this was a per-bead
        // agent (session.beadId set), re-fire start-wave so the orchestrator
        // can launch any newly-unblocked tail beads from the same
        // conflict group. start-wave skips heads with active agents
        // (isAgentActive) so parallel heads in other groups are not
        // re-launched.
        if (session.beadId) {
          await fetch("http://localhost:3000/api/fleet/action", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "start-wave",
              epicId: session.epicId,
              epicTitle: session.repoName,
              currentLabels: session.epicLabels,
              waveNumber: waveStatus.currentWave,
            }),
          });
          return true; // Chain handled (bead close -> launch next deferred bead)
        }
        // Wave-session agent (pre-z9h.3 or legacy fallback) exited without
        // closing all beads — no chain, stay at development.
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
      // factory-core-z9h.6 + regression pattern #13 (Silent Exception
      // Swallowing): log the failure explicitly. Returning false means the
      // normal NEXT_STAGE transition will NOT silently treat the wave as
      // complete — the pipeline label stays at `pipeline:development`.
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

      // Check if reviewer found any open bugs — scoped to this epic
      // All bugs must be fixed regardless of priority before advancing
      let hasBugs = false;
      const isInternalBuild = session.epicLabels?.some((l) => l === "ship-type:internal") ?? false;
      const bugFilterArgs = isInternalBuild
        ? ["list", "--status=open", `--parent=${session.epicId}`]
        : ["list", "--status=open", "--label", `epic:${session.epicId}`];
      const bugResult = execBdSync(
        bugFilterArgs,
        session.repoPath,
        10000,
      );
      if (bugResult.success) {
        // Count any open bugs regardless of priority
        const bugLines = bugResult.stdout.split("\n").filter(
          (line) => lineIsBugType(line),
        );
        hasBugs = bugLines.length > 0;
      } else {
        // If we can't query beads, assume bugs may exist (fail-safe)
        hasBugs = true;
      }

      if (hasBugs) {
        // Open bugs found — chain back to builder to fix same wave
        // Extract wave number from the prompt (e.g., "Review Wave 2 changes for epic...")
        const waveMatch = session.prompt.match(/Wave (\d+)/);
        const reviewedWave = waveMatch ? parseInt(waveMatch[1], 10) : waveStatus.currentWave;

        // factory-core-z9h.6: reviewer closed with bugs → start-wave re-runs
        // the wave. Clear the review guard for this wave so the NEXT wave
        // completion (after fixes) can re-fire review-wave.
        clearWaveReviewGuard(session.epicId!, reviewedWave);

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

        // Auto-advance to next wave — clear the guard for the wave we just reviewed
        // so the Set doesn't leak entries for the lifetime of the process (z9h.6 P2).
        clearWaveReviewGuard(session.epicId!, reviewedWave);
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

      // Final wave passed — chain to QA. Clear guard for the reviewed wave (z9h.6 P2).
      clearWaveReviewGuard(session.epicId!, reviewedWave);
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
      // Scope bug check to this epic
      const isInternalQA = session.epicLabels?.some((l) => l === "ship-type:internal") ?? false;
      const qaFilterArgs = isInternalQA
        ? ["list", "--status=open", `--parent=${session.epicId}`]
        : ["list", "--status=open", "--label", `epic:${session.epicId}`];
      const childrenResult = execBdSync(
        qaFilterArgs,
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
        // Check round count -- max 20 rounds
        const roundResult = execBdSync(["show", session.epicId!], FLEET_CORE_PATH, 10000);
        let currentRound = 1;
        if (roundResult.success) {
          const roundMatch = roundResult.stdout.match(/qa:round-(\d+)/g);
          if (roundMatch && roundMatch.length > 0) {
            const rounds = roundMatch.map((m: string) => parseInt(m.split("-")[1]));
            currentRound = Math.max(...rounds);
          }
        }

        if (currentRound >= 20) {
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

      // factory-core-z9h.11: Under parallel per-bead builders (z9h.3) an epic
      // can have N>1 active agents sharing one epicId. Removing `agent:running`
      // unconditionally on every exit stripped the label as soon as the FIRST
      // builder exited — even though N-1 others were still live — and the
      // dashboard's isAgentRunning(epic) then reported the epic as idle.
      //
      // Only clear `agent:running` once the exiting agent is the last one for
      // the epic. startPollLoop removes the current session from activeAgents
      // BEFORE handleAgentExit runs (see lines 505/522/549), so the lookup
      // does not need to exclude self.
      if (!hasActiveAgentForEpic(session.epicId)) {
        await removeLabelsFromEpic(session.epicId, ["agent:running"]);
      }

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

/**
 * Compute the activeAgents map key for a launch.
 *
 * factory-core-z9h.3: per-bead parallel builders share a repoPath but must
 * not share a map key — otherwise starting agent B for the same repo would
 * see the still-running agent A and refuse to launch. When a beadId is
 * supplied we suffix with `::<beadId>`; otherwise we fall back to the legacy
 * single-agent-per-repo key so pre-z9h callers behave exactly as before.
 */
function activeAgentKey(repoPath: string, beadId?: string): string {
  const real = realpathSync(repoPath);
  return beadId ? `${real}::${beadId}` : real;
}

export async function launchAgent(options: LaunchOptions): Promise<AgentSession> {
  const repoKey = activeAgentKey(options.repoPath, options.beadId);
  const existing = activeAgents.get(repoKey);
  if (existing) {
    const stillRunning = existing.session.tmuxSessionName
      ? await tmuxSessionAlive(existing.session.tmuxSessionName)
      : false;
    if (stillRunning) {
      const scope = options.beadId
        ? ` for bead ${options.beadId}`
        : "";
      throw new Error(
        `Agent already running in tmux window "${existing.session.tmuxWindow}" in ${existing.session.repoName}${scope}. Stop it first.`,
      );
    }
  }

  await ensureLogDir();
  await fs.mkdir(STATUS_DIR, { recursive: true });
  await fs.mkdir(LAUNCHER_DIR, { recursive: true });

  const model = options.model ?? "sonnet";
  const repoName = options.repoName ?? path.basename(options.repoPath);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  // factory-core-z9h.2: wave/bead scope is embedded in all per-agent file names
  // so successive waves (and, for z9h.3, parallel per-bead builders) don't
  // share status files, launcher scripts, or tmux window/session names.
  const scopeSuffix = sessionScopeSuffix(options.waveNumber, options.beadId);
  const logFile = path.join(LOG_DIR, `agent-${repoName}${scopeSuffix}-${timestamp}.log`);
  const statusFile = path.join(STATUS_DIR, `${options.epicId || repoName}-${options.pipelineStage || "unknown"}${scopeSuffix}-${timestamp}.json`);
  const launcherScript = path.join(LAUNCHER_DIR, `launcher-${options.epicId || repoName}-${options.pipelineStage || "unknown"}${scopeSuffix}-${timestamp}.sh`);
  const tmuxWindow = `${options.epicId || repoName}-${options.pipelineStage || "unknown"}${scopeSuffix}`;

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
    waveNumber: options.waveNumber,
    beadId: options.beadId,
    tmuxWindow,
    statusFile,
    launcherScript,
  };

  // Build the tmux session name — one session per agent.
  // factory-core-z9h.2: wave/bead suffix ensures successive waves (and, for
  // z9h.3, parallel per-bead builders) get distinct tmux session names.
  const tmuxSession = `shipyard-${(options.epicId || repoName).replace(/[^a-zA-Z0-9_-]/g, "-")}-${(options.pipelineStage || "unknown").replace(/[^a-zA-Z0-9_-]/g, "-")}${scopeSuffix}`;
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
  const safeCwd = options.repoPath.replace(/[/_]/g, "-").replace(/^-/, "-");
  const projectDir = path.join(os.homedir(), ".claude", "projects", safeCwd);
  session.transcriptFile = path.join(projectDir, `${claudeSessionId}.jsonl`);

  // Launch in tmux with --session-id so the transcript file is predictable
  const tmuxCmd = `export PATH="/opt/homebrew/bin:$PATH" && cd ${session.repoPath} && unset ANTHROPIC_API_KEY && unset CLAUDECODE && /Users/janemckay/.local/bin/claude ${agentFlag} --session-id ${claudeSessionId} --max-turns ${maxTurns} --model ${model} --dangerously-skip-permissions --allowedTools ${allowedTools}`;
  await execAsync(`/opt/homebrew/bin/tmux new-session -d -s "${tmuxSession}" "${tmuxCmd}"`);

  // Wait for Claude Code to initialise, then paste the prompt
  const promptFile = path.join(LAUNCHER_DIR, `prompt-${tmuxSession}.txt`);
  await fs.writeFile(promptFile, options.prompt);

  setTimeout(async () => {
    const tmux = "/opt/homebrew/bin/tmux";
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    const injectPrompt = async (): Promise<boolean> => {
      try {
        await execAsync(`${tmux} load-buffer "${promptFile}"`);
        await execAsync(`${tmux} paste-buffer -t "${tmuxSession}"`);
        await wait(500);
        await execAsync(`${tmux} send-keys -t "${tmuxSession}" Enter`);
        return true;
      } catch (err) {
        console.error("[tmux] Prompt injection failed:", err);
        return false;
      }
    };

    const transcriptActive = async (): Promise<boolean> => {
      if (!session.transcriptFile) return false;
      try {
        const stat = await fs.stat(session.transcriptFile);
        return stat.size > 100;
      } catch {
        return false;
      }
    };

    // Attempt 1: paste + enter
    if (await injectPrompt()) {
      await wait(5000);
      if (await transcriptActive()) {
        await fs.unlink(promptFile).catch(() => {});
        return;
      }
      // Retry just Enter (prompt may be pasted but Enter didn't fire)
      console.log("[tmux] Transcript not active, retrying Enter");
      try { await execAsync(`${tmux} send-keys -t "${tmuxSession}" Enter`); } catch { /* ignore */ }
      await wait(5000);
      if (await transcriptActive()) {
        await fs.unlink(promptFile).catch(() => {});
        return;
      }
    }

    // Attempt 2: full re-inject
    console.log("[tmux] Re-injecting prompt (attempt 2)");
    await injectPrompt();
    await wait(5000);
    await fs.unlink(promptFile).catch(() => {});
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
      await clearPersistedSession(
        agent.session.repoPath,
        agent.session.waveNumber,
        agent.session.beadId,
      );
      count++;
    }
    return { stopped: count > 0, stoppedCount: count };
  }

  if (repoPath) {
    const real = realpathSync(repoPath);
    // factory-core-z9h.3: there may be multiple agents per repo (per-bead
    // parallel builders). stopAgent(repoPath) stops every agent whose
    // session.repoPath resolves to the same realpath — preserving the
    // "stop this repo's work" semantic for single-agent callers while
    // also cleaning up all per-bead agents at once.
    const matches: Array<{ key: string; agent: ActiveAgent }> = [];
    for (const [key, agent] of activeAgents) {
      try {
        if (realpathSync(agent.session.repoPath) === real) {
          matches.push({ key, agent });
        }
      } catch {
        // Path resolution failed — skip
      }
    }
    if (matches.length === 0) return { stopped: false };

    let firstPid: number | undefined;
    for (const { key, agent } of matches) {
      if (firstPid === undefined) firstPid = agent.session.pid;
      await killAgent(agent);
      await handleAgentExit(agent.session, null, agent.langfuseSpan);
      activeAgents.delete(key);
      await clearPersistedSession(
        agent.session.repoPath,
        agent.session.waveNumber,
        agent.session.beadId,
      );
    }
    return {
      stopped: true,
      pid: firstPid,
      stoppedCount: matches.length,
    };
  }

  // No repoPath: stop first running agent (backwards compat)
  for (const [key, agent] of activeAgents) {
    const pid = agent.session.pid;
    await killAgent(agent);

    // Call exit handler immediately for manual stops
    await handleAgentExit(agent.session, null, agent.langfuseSpan);

    activeAgents.delete(key);
    await clearPersistedSession(
      agent.session.repoPath,
      agent.session.waveNumber,
      agent.session.beadId,
    );
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
