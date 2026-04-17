// =============================================================================
// Per-bead builder prompt construction (factory-core-z9h.5)
// =============================================================================
//
// When start-wave launches one builder per bead (factory-core-z9h.3), each
// agent should receive a prompt scoped to a single bead — its title, its
// description, its acceptance criteria verbatim, its Files: manifest, and
// the matching section of the test-scenarios document. This module owns
// all that string plumbing so route.ts can call a single function and get
// back a ready-to-launch prompt.
//
// Regression patterns considered:
// - #1 Write/Read Disconnect — planner writes "Files:" / "Acceptance
//   Criteria:", this module reads them. The parsers are tolerant of
//   formatting drift (heading style, bullet style, CRLF) but exact on
//   bead-ID matching.
// - #7 Type Confusion — "no AC", "no test-scenarios section", "no test-
//   scenarios doc" are three distinct branches with their own explicit
//   fallback strings.
// =============================================================================

import { promises as fs } from "fs";
import { execFileSync } from "child_process";
import { getBdPath, getBdEnv } from "@/lib/bd-path";

export interface BeadDetail {
  id: string;
  title: string;
  /** Raw description section from `bd show` — empty string when absent. */
  description: string;
  /**
   * Raw acceptance-criteria block extracted from the bead description.
   * Empty string when the bead declares no ACs; the prompt builder will
   * substitute a "no AC — smoke only" directive rather than render empty.
   */
  acceptanceCriteria: string;
  /**
   * Files the bead declares it will touch. Empty array when the bead has
   * no Files: section yet (pre-z9h.7). The prompt lists them verbatim so
   * the builder knows its blast radius.
   */
  files: string[];
  /** Raw bd show output, kept for debugging / future extractors. */
  rawShow: string;
}

/**
 * Normalise CRLF / CR line endings so downstream regex matchers don't need
 * to worry about the boundary characters.
 */
function normaliseLineEndings(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/**
 * Run `bd show <beadId>` and return the raw text. Throws on failure so
 * callers can distinguish "bead does not exist" from "empty AC section".
 */
export function runBdShow(beadId: string, repoPath: string): string {
  const bdPath = getBdPath();
  const bdEnv = getBdEnv();
  const result = execFileSync(bdPath, ["show", beadId], {
    cwd: repoPath,
    env: { ...process.env, ...bdEnv },
    encoding: "utf-8",
    timeout: 10000,
  });
  return normaliseLineEndings(result);
}

/**
 * Extract the Acceptance Criteria block from a bd show output.
 *
 * bd show typically formats AC as part of the description. The planner
 * uses these headings in practice:
 *   - "## Acceptance Criteria"
 *   - "Acceptance Criteria:"
 *   - "**Acceptance Criteria:**"
 *   - bd's own AC field (rendered under a "Design/Acceptance Criteria"
 *     banner by `bd show`).
 *
 * Captures until the next section heading (markdown or bd-show all-caps).
 * Returns an empty string when no AC heading is found.
 */
export function extractAcceptanceCriteria(showOutput: string): string {
  const text = normaliseLineEndings(showOutput);
  const lines = text.split("\n");
  // Headings that mark the start of the AC block. Tolerates:
  //   "## Acceptance Criteria"
  //   "Acceptance Criteria:"
  //   "**Acceptance Criteria:**"
  //   "**Acceptance Criteria**"
  // The trailing ** may sit on either side of the optional colon.
  const acHeader = /^\s*(?:#+\s*)?\*{0,2}\s*Acceptance\s*Criteria\s*:?\s*\*{0,2}\s*$/i;
  // bd-show all-caps section boundary (NOTES, LABELS, PARENT, DEPENDS ON, etc).
  const bdSectionHeader = /^[A-Z][A-Z ]*[A-Z](?:\s*:.*)?$/;
  // Any other markdown heading (## Foo, ### Foo, etc).
  const otherMdHeader = /^#+\s+\S/;

  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (acHeader.test(lines[i])) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return "";

  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (acHeader.test(line)) continue; // don't stop on the same section header
    if (bdSectionHeader.test(line) || otherMdHeader.test(line)) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n").trim();
}

/**
 * Extract the description section from bd show output. bd-show renders
 * DESCRIPTION as an all-caps banner followed by the description prose,
 * terminating at the next banner (NOTES / LABELS / PARENT / etc.).
 */
export function extractDescription(showOutput: string): string {
  const text = normaliseLineEndings(showOutput);
  const lines = text.split("\n");
  const descHeader = /^\s*DESCRIPTION\s*$/;
  const bdSectionHeader = /^[A-Z][A-Z ]*[A-Z](?:\s*:.*)?$/;

  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (descHeader.test(lines[i])) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return "";

  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (bdSectionHeader.test(line)) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n").trim();
}

/**
 * Extract the Files: manifest from bd show output.
 * Mirrors parseFilesManifest in agent-launcher.ts but lives here to keep
 * the bead-prompt module self-contained and avoid a circular import when
 * this module is tested in isolation.
 */
export function extractFilesManifest(showOutput: string): string[] {
  const text = normaliseLineEndings(showOutput);
  const lines = text.split("\n");
  const filesHeader = /^\s*(?:#+\s*)?\*{0,2}\s*Files\s*:?\s*\*{0,2}\s*$/i;
  const bdSectionHeader = /^[A-Z][A-Z ]*[A-Z](?:\s*:.*)?$/;
  const otherMdHeader = /^#+\s+\S/;

  let inSection = false;
  const files: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (!inSection) {
      if (filesHeader.test(line)) inSection = true;
      continue;
    }
    if (bdSectionHeader.test(line) && !filesHeader.test(line)) break;
    if (otherMdHeader.test(line) && !filesHeader.test(line)) break;
    const bullet = line.match(/^\s*[-*]\s+(\S.*)$/);
    if (bullet) {
      const cleaned = bullet[1].replace(/`/g, "").trim();
      if (cleaned) files.push(cleaned);
    }
  }
  return files;
}

/**
 * Extract the bead title from the first line of bd show output.
 * Format observed: "◐ <beadId> · <title>   [● P<n> · <STATUS>]".
 */
export function extractTitle(showOutput: string, beadId: string): string {
  const text = normaliseLineEndings(showOutput);
  const firstLine = text.split("\n").find((l) => l.includes(beadId)) ?? "";
  const match = firstLine.match(
    new RegExp(`${beadId.replace(/\./g, "\\.")}\\s*·\\s*([^\\[]+?)\\s*\\[`),
  );
  return match ? match[1].trim() : beadId;
}

/**
 * Load a bead's detail from bd show and pull out the structured bits we
 * need for prompt construction.
 */
export function loadBeadDetail(beadId: string, repoPath: string): BeadDetail {
  const raw = runBdShow(beadId, repoPath);
  return {
    id: beadId,
    title: extractTitle(raw, beadId),
    description: extractDescription(raw),
    acceptanceCriteria: extractAcceptanceCriteria(raw),
    files: extractFilesManifest(raw),
    rawShow: raw,
  };
}

/**
 * Extract the test-scenarios section for a specific bead from the
 * test-scenarios document.
 *
 * Expected heading format (produced by the test-spec agent):
 *   "### Bead: <beadId> — <title>"
 *
 * Matching rules:
 * - Exact bead ID match only. The beadId is escaped and followed by a
 *   non-digit / end-of-word assertion so that looking up `z9h.5` does NOT
 *   accidentally capture `z9h.55`.
 * - Section runs until the NEXT `### Bead:` heading or `##` heading (wave
 *   header) or end of document.
 *
 * Returns `null` when the document doesn't contain a section for this
 * bead — distinct from returning an empty string (which would mean "a
 * section exists but is empty", which shouldn't happen with a healthy
 * test-spec output).
 */
export function extractBeadTestScenarios(
  testScenariosContent: string,
  beadId: string,
): string | null {
  const text = normaliseLineEndings(testScenariosContent);
  const lines = text.split("\n");
  // Match "### Bead: <beadId>" where <beadId> is followed by a non-ID
  // character (space, em-dash, hyphen, punctuation). End-of-word won't
  // work because `.` is not part of `\w`.
  const escaped = beadId.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
  const headerRe = new RegExp(`^###\\s+Bead:\\s+${escaped}(?:[^0-9A-Za-z_.]|$)`);
  const endRe = /^###\s+Bead:\s+/;
  const waveHeaderRe = /^##\s+/;

  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headerRe.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (endRe.test(lines[i]) || waveHeaderRe.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n").trim();
}

/**
 * Load the test-scenarios doc from disk and pull out the section for a
 * specific bead. Returns:
 *   - { status: "missing-doc" } when the file does not exist (or the
 *     path is undefined).
 *   - { status: "missing-section", content: null } when the doc exists
 *     but has no section for this bead.
 *   - { status: "present", content: "<section text>" } on success.
 *
 * Callers log the status so missing scenarios are visible — but no
 * branch throws, because we never want to block a launch on missing tests.
 */
export async function loadBeadTestScenarios(
  testScenariosPath: string | undefined,
  beadId: string,
): Promise<
  | { status: "missing-doc" }
  | { status: "missing-section"; content: null }
  | { status: "present"; content: string }
> {
  if (!testScenariosPath) return { status: "missing-doc" };
  let text: string;
  try {
    text = await fs.readFile(testScenariosPath, "utf-8");
  } catch {
    return { status: "missing-doc" };
  }
  const section = extractBeadTestScenarios(text, beadId);
  if (section === null) return { status: "missing-section", content: null };
  return { status: "present", content: section };
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

export interface PerBeadPromptInputs {
  beadId: string;
  beadTitle: string;
  beadDescription: string;
  beadAcceptanceCriteria: string;
  beadFiles: string[];
  epicId: string;
  epicTitle: string;
  shipType: string;
  waveNumber: number;
  repoPath: string;
  fleetCorePath: string;
  researchPath?: string;
  planPath?: string;
  specPath?: string;
  architecturePath?: string;
  /** Result of loadBeadTestScenarios — the prompt annotates the scenarios branch. */
  testScenarios:
    | { status: "missing-doc" }
    | { status: "missing-section"; content: null }
    | { status: "present"; content: string };
  /**
   * Path to the test-scenarios doc (for the prompt to cite). May be
   * absent even when testScenarios.status === "missing-doc" (caller
   * didn't supply one).
   */
  testScenariosPath?: string;
}

/**
 * Build the focused per-bead builder prompt.
 *
 * The resulting string is plain UTF-8 — no shell quoting needed because
 * launchAgent writes it to a temp file and loads it into tmux via
 * load-buffer / paste-buffer, which bypasses shell parsing.
 */
export function buildPerBeadPrompt(inputs: PerBeadPromptInputs): string {
  const {
    beadId,
    beadTitle,
    beadDescription,
    beadAcceptanceCriteria,
    beadFiles,
    epicId,
    epicTitle,
    shipType,
    waveNumber,
    repoPath,
    fleetCorePath,
    researchPath,
    planPath,
    specPath,
    architecturePath,
    testScenarios,
    testScenariosPath,
  } = inputs;

  const paths: string[] = [];
  paths.push(`Product repo: ${repoPath}`);
  paths.push(`Fleet-core: ${fleetCorePath}`);
  if (researchPath) paths.push(`Research report: ${researchPath}`);
  if (specPath) paths.push(`Functional spec: ${specPath}`);
  if (architecturePath) paths.push(`Architecture: ${architecturePath}`);
  if (planPath) paths.push(`Build plan: ${planPath}`);
  if (testScenariosPath) paths.push(`Test scenarios doc: ${testScenariosPath}`);

  const acBlock =
    beadAcceptanceCriteria.trim().length > 0
      ? beadAcceptanceCriteria.trim()
      : "(no AC — smoke only: verify the bead description's stated behaviour is reachable without errors)";

  const filesBlock =
    beadFiles.length > 0
      ? beadFiles.map((f) => `- ${f}`).join("\n")
      : "(no Files: manifest declared in this bead — proceed carefully and keep changes tightly scoped)";

  let testScenariosBlock: string;
  switch (testScenarios.status) {
    case "missing-doc":
      testScenariosBlock =
        "(test-scenarios document not found — write tests from the Acceptance Criteria above)";
      break;
    case "missing-section":
      testScenariosBlock = `(WARNING: test scenarios missing for ${beadId} — write tests from AC)`;
      break;
    case "present":
      testScenariosBlock = testScenarios.content;
      break;
  }

  return [
    `Build bead ${beadId} — ${beadTitle}.`,
    ``,
    `You are ONE of multiple parallel builders working epic ${epicId} (${epicTitle}), wave ${waveNumber}. Work ONLY bead ${beadId}. Do not start, claim, or close any other bead.`,
    ``,
    `Ship type: ${shipType}.`,
    paths.join(". ") + ".",
    ``,
    `--- Bead Description ---`,
    beadDescription.trim().length > 0
      ? beadDescription.trim()
      : "(bead has no description — see title above)",
    ``,
    `--- Acceptance Criteria ---`,
    acBlock,
    ``,
    `--- Files: manifest (this bead's declared blast radius) ---`,
    filesBlock,
    ``,
    `--- Test Scenarios for ${beadId} ---`,
    testScenariosBlock,
    ``,
    `--- Standing orders ---`,
    `Read fleet-core standing orders and agent instructions (agent-discipline.md, regression-patterns.md, platform standards for ${shipType}) before writing code. Follow the builder agent process: read standing orders, claim, implement, commit, self-review, close with a meaningful reason.`,
  ].join("\n");
}
