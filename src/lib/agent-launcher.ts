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
  // development -> qa is handled by handleChainAction, not NEXT_STAGE
  qa: "pipeline:submission-prep",
  "submission-prep": "pipeline:submitted",
  "kit-management": "pipeline:completed",
};

/**
 * Pipeline stages that get special label handling on agent exit rather
 * than advancing to the next stage. The planning agent adds `plan:pending`
 * so the card shows "Approve Plan" / "Revise Plan" buttons.
 */
const EXIT_LABELS: Record<string, string[]> = {
  planning: ["plan:pending"],
};

// ---------------------------------------------------------------------------
// Chain actions -- when an agent exits, optionally trigger the next step
// ---------------------------------------------------------------------------

const FACTORY_REPO_PATH = "/Users/janemckay/dev/claude_projects/cycle-apps-factory";

/**
 * Returns true if the chain action handled the stage transition (so NEXT_STAGE
 * should be skipped), or false if normal NEXT_STAGE logic should proceed.
 */
async function handleChainAction(session: AgentSession, exitCode: number | null): Promise<boolean> {
  if (exitCode !== 0) return false; // Only chain on success

  const stage = session.pipelineStage;

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
          `cd ${FACTORY_REPO_PATH} && bd show ${session.epicId} 2>/dev/null | grep -o "qa:round-[0-9]*" | sort -t- -k2 -n | tail -1 || echo ""`,
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

  // Read recent log output (last 8KB)
  let recentLog: string | undefined;
  try {
    const stat = await fs.stat(activeSession.logFile);
    const readSize = Math.min(stat.size, 8192);
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
