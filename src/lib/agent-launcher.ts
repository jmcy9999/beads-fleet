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
  // planning used to add plan:pending here, but now auto-chains to build
};

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
        }),
      });
      return true; // Chain handled (research -> planning)
    } catch (err) {
      console.error("Failed to chain planning after research:", err);
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // planning -> build: auto-start build after planning completes
  // (skips plan approval gate — agent proceeds, Jane reviews async)
  // -------------------------------------------------------------------------
  if (stage === "planning") {
    try {
      await fetch("http://localhost:3000/api/fleet/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "approve-and-build",
          epicId: session.epicId,
          epicTitle: session.repoName,
        }),
      });
      return true; // Chain handled (planning -> build)
    } catch (err) {
      console.error("Failed to chain build after planning:", err);
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // development -> QA: auto-send to QA after build completes
  // -------------------------------------------------------------------------
  if (stage === "development") {
    // After build crew finishes, auto-send to QA
    try {
      await fetch("http://localhost:3000/api/fleet/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "send-for-qa",
          epicId: session.epicId,
          epicTitle: session.repoName, // Will be resolved by extractAppName
        }),
      });
      return true; // Chain handled the transition (development -> qa)
    } catch (err) {
      console.error("Failed to chain QA after build:", err);
      return false; // Fall through to NEXT_STAGE (though development has no NEXT_STAGE entry)
    }
  } else if (stage === "qa") {
    // After QA finishes, check if bugs were filed
    try {
      const { execSync } = await import("child_process");
      const bugCount = execSync(
        `cd ${session.repoPath} && bd list --status=open --type=bug 2>/dev/null | grep -c "bug" || echo "0"`,
        { encoding: "utf-8" },
      ).trim();

      const hasBugs = parseInt(bugCount) > 0;

      if (hasBugs) {
        // Check round count -- max 3 rounds
        const roundResult = execSync(
          `cd ${FLEET_CORE_PATH} && bd show ${session.epicId} 2>/dev/null | grep -o "qa:round-[0-9]*" | sort -t- -k2 -n | tail -1 || echo ""`,
          { encoding: "utf-8" },
        ).trim();

        const currentRound = roundResult ? parseInt(roundResult.split("-")[1]) : 1;

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
          }),
        });
        return true; // Handled -- bugs found, looping back through dev -> QA
      }
      // If no bugs, the normal exit handler advances to submission-prep via NEXT_STAGE
      return false;
    } catch (err) {
      console.error("Failed to handle QA chain:", err);
      return false;
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
