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
}

// ---------------------------------------------------------------------------
// State -- in-memory singleton (process lifetime)
// ---------------------------------------------------------------------------

let activeSession: AgentSession | null = null;
let activeProcess: ChildProcess | null = null;

const LOG_DIR = path.join(os.tmpdir(), "beads-web-agent-logs");

// ---------------------------------------------------------------------------
// Pipeline stage transitions
// ---------------------------------------------------------------------------

/**
 * Maps the pipeline stage the agent was launched for to the next stage
 * label that should be applied when the agent exits successfully.
 */
const NEXT_STAGE: Record<string, string> = {
  research: "pipeline:research-complete",
  // Planning agents don't advance the pipeline stage on exit -- the plan
  // stays at research-complete with plan:pending until Jane approves.
  // So "planning" is intentionally omitted from this mapping.
  development: "pipeline:submission-prep",
  "submission-prep": "pipeline:submitted",
  "kit-management": "pipeline:completed",
};

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
  if (activeSession && activeProcess && !activeProcess.killed) {
    throw new Error(
      `Agent already running (PID ${activeSession.pid}) in ${activeSession.repoName}. Stop it first.`,
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

  // Spawn detached so it survives if the API process restarts
  const child = spawn("claude", args, {
    cwd: options.repoPath,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      // Must unset CLAUDECODE to avoid "nested session" error
      CLAUDECODE: undefined,
      NO_COLOR: "1",
    },
  });

  // Pipe stdout/stderr to log file
  const logStream = await fs.open(logFile, "w");
  const writableLog = logStream.createWriteStream();
  child.stdout?.pipe(writableLog);
  child.stderr?.pipe(writableLog);

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

  activeSession = session;
  activeProcess = child;

  // Clean up when process exits and handle pipeline label transitions
  child.on("exit", async (exitCode) => {
    const exitedSession = activeSession;
    if (exitedSession != null && exitedSession.pid === child.pid) {
      activeSession = null;
      activeProcess = null;

      // Perform pipeline label transitions if epicId and pipelineStage are set
      if (exitedSession.epicId && exitedSession.pipelineStage) {
        try {
          const { addLabelsToEpic, removeLabelsFromEpic } = await import("./pipeline-labels");

          // Always remove agent:running
          await removeLabelsFromEpic(exitedSession.epicId, ["agent:running"]);

          // If the agent exited cleanly (code 0), advance to next stage
          const nextStage = NEXT_STAGE[exitedSession.pipelineStage];
          if (exitCode === 0 && nextStage) {
            const currentLabel = `pipeline:${exitedSession.pipelineStage}`;
            await removeLabelsFromEpic(exitedSession.epicId, [currentLabel]);
            await addLabelsToEpic(exitedSession.epicId, [nextStage]);
          }
          // If non-zero exit, the pipeline label stays at the current stage
          // (card stays in the same column with no agent indicator)
        } catch (err) {
          console.error("Failed to update pipeline labels on agent exit:", err);
        }
      }
    }
    writableLog.end();
    logStream.close();
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

export async function getAgentStatus(): Promise<AgentStatus> {
  if (!activeSession || !activeProcess) {
    return { running: false, session: null };
  }

  // Check if process is still alive
  if (activeProcess.killed || activeProcess.exitCode !== null) {
    activeSession = null;
    activeProcess = null;
    return { running: false, session: null };
  }

  // Read recent log output (last 2KB)
  let recentLog: string | undefined;
  try {
    const stat = await fs.stat(activeSession.logFile);
    const readSize = Math.min(stat.size, 2048);
    const offset = Math.max(0, stat.size - readSize);
    const fh = await fs.open(activeSession.logFile, "r");
    const buf = Buffer.alloc(readSize);
    await fh.read(buf, 0, readSize, offset);
    await fh.close();
    recentLog = buf.toString("utf-8");
  } catch {
    // Log file not readable yet
  }

  return {
    running: true,
    session: activeSession,
    recentLog,
  };
}

// ---------------------------------------------------------------------------
// Stop
// ---------------------------------------------------------------------------

export async function stopAgent(): Promise<{ stopped: boolean; pid?: number }> {
  if (!activeSession || !activeProcess) {
    return { stopped: false };
  }

  const pid = activeSession.pid;

  try {
    // Send SIGTERM to the process group (negative PID kills the group)
    process.kill(-pid, "SIGTERM");
  } catch {
    // Process may already be dead
    try {
      activeProcess.kill("SIGTERM");
    } catch {
      // Already dead
    }
  }

  activeSession = null;
  activeProcess = null;

  return { stopped: true, pid };
}
