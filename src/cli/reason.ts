#!/usr/bin/env -S npx tsx
/**
 * shipyard reason — on-demand coherence reasoning for a stuck epic.
 *
 * factory-core-3p1e.8 (Phase 2 Bucket B Item 8).
 *
 * Why this exists: the orchestrator's `repeat-dispatch-escalation` rule fires
 * after ~45 minutes of repeated dispatches with no pipeline progress. When
 * the operator is staring at a stuck epic on the dashboard NOW, that wait is
 * unacceptable. This CLI invokes the coherence agent against the same inputs
 * the auto-escalation would feed it, returning a recommendation, reasoning,
 * and a confidence score — so the operator can decide whether to wait or act.
 *
 * Invocation: `npx shipyard reason <epic-id>` from the beads_web-improved
 * repo root (after `npm install`). The `bin/shipyard` dispatcher routes to
 * this file via tsx.
 *
 * Architecture:
 *   - Reads bd state for the target epic (description + notes + labels +
 *     children) via `bd show`.
 *   - Reads the most-recent ~50 events for the epic via the existing
 *     event-log helper in `src/lib/event-log.ts`.
 *   - Reads the coherence agent's system prompt from
 *     `<SHIPYARD_PATH>/.claude/agents/coherence.md`.
 *   - Spawns `claude -p --append-system "$(cat coherence.md)"` with the
 *     bundled context as user input. Subprocess cwd is SHIPYARD_PATH so the
 *     agent can resolve relative file references in its prompt.
 *   - Parses the subprocess's stdout as JSON (stripping ```json code fences
 *     if present — LLMs frequently emit them despite explicit JSON-only
 *     instructions).
 *   - Validates the JSON against the {recommendation, reasoning, confidence}
 *     contract: recommendation is a non-empty string; confidence is a
 *     number in [0, 1].
 *   - Pretty-prints to stdout: recommendation (with ANSI verdict colour),
 *     reasoning, confidence.
 *
 * Exit codes (per AC):
 *   0 — success
 *   1 — JSON parse failure or schema mismatch
 *   2 — epic not found in bd
 *   3 — subprocess (claude) failure or `claude` not in PATH
 *
 * Testability: the runReason() function takes a Deps object so the test
 * suite can inject mocks for fs reads, bd lookup, event-log reads, and
 * subprocess invocation. The CLI entry point at the bottom of this file
 * wires up the production deps; tests bypass the CLI entry and call
 * runReason() directly.
 */

import { execFileSync, spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

import { readEvents, type PipelineEvent } from "../lib/event-log";
import { getBdEnv, getBdPath } from "../lib/bd-path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_SHIPYARD_PATH = "/Users/janemckay/dev/fleet/factory-core";
const COHERENCE_REL_PATH = path.join(".claude", "agents", "coherence.md");
const EVENT_TAIL_LIMIT = 50;

const ANSI_BOLD = "\x1b[1m";
const ANSI_GREEN = "\x1b[32m";
const ANSI_YELLOW = "\x1b[33m";
const ANSI_RED = "\x1b[31m";
const ANSI_RESET = "\x1b[0m";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReasonExitCode = 0 | 1 | 2 | 3;

export interface CoherenceOutput {
  recommendation: string;
  reasoning: string;
  confidence: number;
}

export interface SpawnClaudeResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** Set when the subprocess could not be spawned at all (e.g. ENOENT). */
  error?: NodeJS.ErrnoException;
}

export interface ReasonDeps {
  /** Synchronously read a file. Throws on missing/permission errors. */
  readFile: (filePath: string) => string;
  /** True iff the path exists. */
  fileExists: (filePath: string) => boolean;
  /** Run `bd show <epicId>` in the repo at `cwd`. Return raw stdout, or null when bd reports the bead is missing. Throw on other failures. */
  runBdShow: (epicId: string, cwd: string) => string | null;
  /** Read the most-recent N events for the epic from the repo's event log. */
  readEpicEvents: (
    epicId: string,
    cwd: string,
    limit: number,
  ) => Promise<PipelineEvent[]>;
  /** Spawn the claude CLI with the system prompt + user context. cwd is SHIPYARD_PATH. */
  spawnClaude: (
    systemPrompt: string,
    userPrompt: string,
    cwd: string,
  ) => SpawnClaudeResult;
  /** Process stdout. */
  log: (msg: string) => void;
  /** Process stderr. */
  err: (msg: string) => void;
}

export interface ReasonOptions {
  epicId: string;
  shipyardPath: string;
  /** When true, suppress ANSI colour codes (for non-TTY output / tests). */
  noColour?: boolean;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * LLMs frequently wrap JSON in ```json ... ``` code fences despite explicit
 * "respond with JSON only" instructions. Strip a single outer fence if
 * present. Tolerant of leading/trailing whitespace and the ```json language
 * tag. Idempotent on bare-JSON input.
 */
export function stripCodeFences(raw: string): string {
  const trimmed = raw.trim();
  // ```json\n...\n``` or ```\n...\n```
  const fenceMatch = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/);
  if (fenceMatch) return fenceMatch[1].trim();
  return trimmed;
}

/**
 * Parse + shape-validate the coherence agent's JSON output.
 *
 * Validation contract (from AC4):
 *   - recommendation: non-empty string
 *   - reasoning: string (may be empty in degenerate cases, but must exist)
 *   - confidence: number in [0, 1]
 *
 * Returns a discriminated union so the caller can exit with the correct code
 * and surface a meaningful error message. The error message names the
 * specific failing field per AC4.
 */
export function parseCoherenceOutput(
  raw: string,
):
  | { ok: true; data: CoherenceOutput }
  | { ok: false; error: string } {
  const stripped = stripCodeFences(raw);

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `JSON parse failed: ${msg}` };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      error: "JSON parse: expected an object at top level",
    };
  }

  const obj = parsed as Record<string, unknown>;

  // Validate fields in a stable order so the error message names the FIRST
  // missing/invalid field. This makes the failure deterministic across
  // structurally-equivalent malformed inputs.
  if (!("recommendation" in obj)) {
    return { ok: false, error: "schema: missing field 'recommendation'" };
  }
  if (typeof obj.recommendation !== "string") {
    return {
      ok: false,
      error: "schema: 'recommendation' must be a string",
    };
  }
  if (obj.recommendation.trim().length === 0) {
    return {
      ok: false,
      error: "schema: 'recommendation' must be a non-empty string",
    };
  }

  if (!("reasoning" in obj)) {
    return { ok: false, error: "schema: missing field 'reasoning'" };
  }
  if (typeof obj.reasoning !== "string") {
    return { ok: false, error: "schema: 'reasoning' must be a string" };
  }

  if (!("confidence" in obj)) {
    return { ok: false, error: "schema: missing field 'confidence'" };
  }
  if (typeof obj.confidence !== "number" || !Number.isFinite(obj.confidence)) {
    return {
      ok: false,
      error: "schema: 'confidence' must be a finite number",
    };
  }
  if (obj.confidence < 0 || obj.confidence > 1) {
    return {
      ok: false,
      error: `schema: 'confidence' must be in [0, 1] (got ${obj.confidence})`,
    };
  }

  return {
    ok: true,
    data: {
      recommendation: obj.recommendation,
      reasoning: obj.reasoning,
      confidence: obj.confidence,
    },
  };
}

/**
 * Format the coherence output for terminal display.
 *
 * Layout (per AC1 step 7 — recommendation first, reasoning second,
 * confidence last):
 *
 *   ▶ Recommendation: <text>            (bold + green/yellow/red verdict)
 *
 *   Reasoning:
 *   <text>
 *
 *   Confidence: 0.87
 *
 * Verdict colour by confidence band:
 *   ≥ 0.75 → green (high confidence)
 *   ≥ 0.4  → yellow (mid)
 *   <  0.4 → red (low — operator should verify)
 */
export function formatOutput(
  data: CoherenceOutput,
  noColour = false,
): string {
  const colour = (code: string) => (noColour ? "" : code);
  const verdictColour =
    data.confidence >= 0.75
      ? colour(ANSI_GREEN)
      : data.confidence >= 0.4
        ? colour(ANSI_YELLOW)
        : colour(ANSI_RED);
  const reset = colour(ANSI_RESET);
  const bold = colour(ANSI_BOLD);

  return [
    `${bold}${verdictColour}▶ Recommendation:${reset} ${data.recommendation}`,
    "",
    `${bold}Reasoning:${reset}`,
    data.reasoning,
    "",
    `${bold}Confidence:${reset} ${data.confidence.toFixed(2)}`,
  ].join("\n");
}

/**
 * Build the user-prompt blob handed to claude alongside the coherence.md
 * system prompt. The blob is the inputs the coherence agent's
 * documented diagnosis process expects: bd state for the epic, recent
 * events, and an explicit instruction to emit a JSON object in the schema
 * the CLI parses.
 *
 * The trailing JSON-only instruction is critical: coherence.md as written
 * tells Claude to append bd notes and dispatch curl actions. For the CLI
 * use case we need a structured response instead — the user prompt
 * overrides the dispatch behaviour for this on-demand flavour.
 */
export function buildUserPrompt(
  epicId: string,
  bdShowOutput: string,
  events: PipelineEvent[],
): string {
  const eventsBlock =
    events.length === 0
      ? "(no events recorded for this epic)"
      : events.map((e) => JSON.stringify(e)).join("\n");

  return [
    `# On-demand coherence reasoning request`,
    ``,
    `Epic ID: ${epicId}`,
    ``,
    `## bd state (from \`bd show\`)`,
    ``,
    bdShowOutput.trim() || "(empty)",
    ``,
    `## Recent events (most-recent first, up to ${EVENT_TAIL_LIMIT})`,
    ``,
    eventsBlock,
    ``,
    `## Output contract (REQUIRED)`,
    ``,
    `This invocation is a CLI request for on-demand reasoning, NOT an autonomous`,
    `dispatch. Do NOT modify bd state, do NOT fire curl actions. Instead, respond`,
    `with a SINGLE JSON object on stdout matching this exact shape:`,
    ``,
    `{`,
    `  "recommendation": "<one-sentence next action — pick from coherence's action vocabulary>",`,
    `  "reasoning": "<2-4 sentence diagnosis citing the specific evidence in bd state / events>",`,
    `  "confidence": <number in [0, 1] — your honest calibration>`,
    `}`,
    ``,
    `Output JSON only. No prose, no code fences, no commentary.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Production Deps — wired by the CLI entry point
// ---------------------------------------------------------------------------

const productionDeps: ReasonDeps = {
  readFile: (p) => fs.readFileSync(p, "utf-8"),
  fileExists: (p) => fs.existsSync(p),
  runBdShow: (epicId, cwd) => {
    const bdPath = getBdPath();
    const bdEnv = getBdEnv();
    try {
      return execFileSync(bdPath, ["show", epicId], {
        cwd,
        env: { ...process.env, ...bdEnv },
        encoding: "utf-8",
        timeout: 10_000,
        // Capture stderr so we can distinguish not-found from other errors.
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      // execFileSync throws on non-zero exit. bd returns non-zero with
      // "issue not found" when the bead doesn't exist; treat that
      // distinctly. Any other failure (timeout, bd not installed,
      // permission denied) is a real error and re-thrown.
      const e = err as NodeJS.ErrnoException & {
        stderr?: Buffer | string;
        stdout?: Buffer | string;
        status?: number;
      };
      const stderr = e.stderr
        ? (typeof e.stderr === "string" ? e.stderr : e.stderr.toString())
        : "";
      const stdout = e.stdout
        ? (typeof e.stdout === "string" ? e.stdout : e.stdout.toString())
        : "";
      const combined = `${stderr}\n${stdout}`;
      if (
        e.status === 1 &&
        /(not found|no issue found|no such issue|does not exist)/i.test(
          combined,
        )
      ) {
        return null;
      }
      throw err;
    }
  },
  readEpicEvents: async (epicId, cwd, limit) => {
    return readEvents(cwd, { epicId, limit });
  },
  spawnClaude: (systemPrompt, userPrompt, cwd) => {
    const result = spawnSync(
      "claude",
      ["-p", "--append-system-prompt", systemPrompt],
      {
        cwd,
        input: userPrompt,
        encoding: "utf-8",
        // Generous timeout — coherence reasoning isn't fast.
        timeout: 5 * 60_000,
        // Inherit env (claude relies on ANTHROPIC_API_KEY etc.).
        env: process.env,
      },
    );
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      error: result.error as NodeJS.ErrnoException | undefined,
    };
  },
  log: (msg) => process.stdout.write(msg + "\n"),
  err: (msg) => process.stderr.write(msg + "\n"),
};

// ---------------------------------------------------------------------------
// Core orchestration
// ---------------------------------------------------------------------------

/**
 * Execute the `reason` command. Returns the process exit code; does not
 * call process.exit() so tests can assert it directly.
 */
export async function runReason(
  opts: ReasonOptions,
  deps: ReasonDeps,
): Promise<ReasonExitCode> {
  const { epicId, shipyardPath, noColour } = opts;
  const coherencePath = path.join(shipyardPath, COHERENCE_REL_PATH);

  // 1. Resolve coherence.md. Clear error message must include the resolved
  //    path so the operator can fix SHIPYARD_PATH.
  if (!deps.fileExists(coherencePath)) {
    deps.err(
      `shipyard reason: coherence.md not found at ${coherencePath} ` +
        `(SHIPYARD_PATH=${shipyardPath}). ` +
        `Set SHIPYARD_PATH to the fleet-core-improved repo root.`,
    );
    return 3;
  }

  let systemPrompt: string;
  try {
    systemPrompt = deps.readFile(coherencePath);
  } catch (err) {
    deps.err(
      `shipyard reason: failed to read coherence.md at ${coherencePath}: ` +
        (err instanceof Error ? err.message : String(err)),
    );
    return 3;
  }

  // 2. bd show <epicId>. Null return = bead not found. Throw = real error.
  let bdShowOutput: string | null;
  try {
    bdShowOutput = deps.runBdShow(epicId, shipyardPath);
  } catch (err) {
    deps.err(
      `shipyard reason: bd show failed for ${epicId}: ` +
        (err instanceof Error ? err.message : String(err)),
    );
    return 2;
  }
  if (bdShowOutput === null) {
    deps.err(
      `shipyard reason: epic ${epicId} not found in bd ` +
        `(checked SHIPYARD_PATH=${shipyardPath}).`,
    );
    return 2;
  }

  // 3. Recent events.
  let events: PipelineEvent[];
  try {
    events = await deps.readEpicEvents(
      epicId,
      shipyardPath,
      EVENT_TAIL_LIMIT,
    );
  } catch (err) {
    // Event log read failure is non-fatal in production (the log can be
    // missing for fresh repos), but if it errors with something other
    // than ENOENT we should surface. readEvents already returns [] for
    // ENOENT, so any throw here is unusual — treat as soft warning and
    // proceed with empty events.
    deps.err(
      `shipyard reason: warning — event log read failed: ` +
        (err instanceof Error ? err.message : String(err)),
    );
    events = [];
  }

  // 4. Compose user prompt and call claude.
  const userPrompt = buildUserPrompt(epicId, bdShowOutput, events);
  const subprocess = deps.spawnClaude(
    systemPrompt,
    userPrompt,
    shipyardPath,
  );

  // 5. Subprocess error handling.
  if (subprocess.error) {
    if (subprocess.error.code === "ENOENT") {
      deps.err(
        "shipyard reason: claude command not found in PATH. " +
          "Install the Claude CLI or ensure it's on your PATH.",
      );
      return 3;
    }
    deps.err(
      `shipyard reason: subprocess error invoking claude: ${subprocess.error.message}`,
    );
    return 3;
  }
  if (subprocess.status !== 0) {
    deps.err(
      `shipyard reason: claude exited with status ${subprocess.status}.`,
    );
    if (subprocess.stderr) {
      deps.err(`--- claude stderr ---\n${subprocess.stderr}`);
    }
    return 3;
  }

  // 6. Parse JSON.
  const parsed = parseCoherenceOutput(subprocess.stdout);
  if (!parsed.ok) {
    deps.err(`shipyard reason: ${parsed.error}`);
    deps.err(`--- raw output ---\n${subprocess.stdout}`);
    return 1;
  }

  // 7. Pretty-print.
  deps.log(formatOutput(parsed.data, noColour));
  return 0;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Strip a leading 'reason' if the bin script forwarded it (it doesn't —
  // the dispatcher already shifts past 'reason' — but double-defending is
  // cheap insurance).
  const positional = args[0] === "reason" ? args.slice(1) : args;

  if (positional.length === 0 || !positional[0] || positional[0].trim() === "") {
    process.stderr.write("Usage: shipyard reason <epic-id>\n");
    process.exit(2);
  }

  if (positional.length > 1) {
    process.stderr.write(
      `shipyard reason: too many arguments (got ${positional.length}; expected 1)\n`,
    );
    process.exit(64);
  }

  const epicId = positional[0].trim();
  const shipyardPath =
    process.env.SHIPYARD_PATH || DEFAULT_SHIPYARD_PATH;

  const code = await runReason(
    {
      epicId,
      shipyardPath,
      noColour: !process.stdout.isTTY,
    },
    productionDeps,
  );
  process.exit(code);
}

// Only run main() when this file is the entry point (not when it's
// imported by tests).
if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(
      `shipyard reason: fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
    );
    process.exit(3);
  });
}
