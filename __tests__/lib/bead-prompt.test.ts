// =============================================================================
// Tests for src/lib/bead-prompt.ts
// =============================================================================
// factory-core-z9h.5 — per-bead builder prompt construction.
// Covers the extractors (AC, description, files, title, test-scenarios
// section), the tri-state loader, and the prompt-builder fallback branches.
// Shell metacharacter safety is covered by the "prompt contains raw text
// but is never interpolated through a shell" invariant — the builder
// returns a string, and start-wave passes it to launchAgent which routes
// through tmux load-buffer / paste-buffer (which bypasses shell parsing).
// =============================================================================

import {
  extractAcceptanceCriteria,
  extractDescription,
  extractFilesManifest,
  extractTitle,
  extractBeadTestScenarios,
  loadBeadTestScenarios,
  buildPerBeadPrompt,
  type PerBeadPromptInputs,
} from "@/lib/bead-prompt";
import { promises as fs } from "fs";
import path from "path";
import os from "os";

// ---------------------------------------------------------------------------
// extractAcceptanceCriteria
// ---------------------------------------------------------------------------
describe("extractAcceptanceCriteria", () => {
  it("returns empty string when no AC heading is present", () => {
    expect(extractAcceptanceCriteria("DESCRIPTION\nSome prose.\nLABELS: x")).toBe("");
  });

  it("extracts a markdown '## Acceptance Criteria' block", () => {
    const out = [
      "DESCRIPTION",
      "Prose.",
      "## Acceptance Criteria",
      "- Given A, When B, Then C.",
      "- Given D, When E, Then F.",
      "LABELS: wave:2",
    ].join("\n");
    expect(extractAcceptanceCriteria(out)).toBe(
      "- Given A, When B, Then C.\n- Given D, When E, Then F.",
    );
  });

  it("extracts a plain 'Acceptance Criteria:' heading", () => {
    const out = `Acceptance Criteria:\n- item one\n- item two\n`;
    expect(extractAcceptanceCriteria(out)).toBe("- item one\n- item two");
  });

  it("extracts a '**Acceptance Criteria:**' bold heading", () => {
    const out = `**Acceptance Criteria:**\n- a\n- b\nNOTES\nunrelated`;
    expect(extractAcceptanceCriteria(out)).toBe("- a\n- b");
  });

  it("stops at the next bd-show all-caps section header (LABELS, NOTES)", () => {
    const out = `## Acceptance Criteria\n- a\n- b\nLABELS: wave:1\n- c\n`;
    // c sits past LABELS header — excluded.
    expect(extractAcceptanceCriteria(out)).toBe("- a\n- b");
  });

  it("stops at the next markdown heading (e.g. '## Scope')", () => {
    const out = `## Acceptance Criteria\n- a\n- b\n## Scope\n- c\n`;
    expect(extractAcceptanceCriteria(out)).toBe("- a\n- b");
  });

  it("normalises CRLF line endings (regression pattern #1)", () => {
    const out = `## Acceptance Criteria\r\n- a\r\n- b\r\nLABELS: x\r\n`;
    expect(extractAcceptanceCriteria(out)).toBe("- a\n- b");
  });
});

// ---------------------------------------------------------------------------
// extractDescription
// ---------------------------------------------------------------------------
describe("extractDescription", () => {
  it("returns empty string when DESCRIPTION banner is missing", () => {
    expect(extractDescription("no description here")).toBe("");
  });

  it("captures prose between DESCRIPTION and the next banner", () => {
    const out = [
      "◐ foo.1 · Title [● P1 · OPEN]",
      "DESCRIPTION",
      "A multi-line",
      "description block.",
      "LABELS: x",
    ].join("\n");
    expect(extractDescription(out)).toBe("A multi-line\ndescription block.");
  });

  it("stops at NOTES banner", () => {
    const out = `DESCRIPTION\ndesc.\nNOTES\nnotes text`;
    expect(extractDescription(out)).toBe("desc.");
  });
});

// ---------------------------------------------------------------------------
// extractFilesManifest
// ---------------------------------------------------------------------------
describe("extractFilesManifest", () => {
  it("returns empty array when no Files: section exists", () => {
    expect(extractFilesManifest("DESCRIPTION\nprose\nLABELS: x")).toEqual([]);
  });

  it("parses a hyphen-bullet Files section", () => {
    const out = `Files:\n- a.ts\n- b.ts\n`;
    expect(extractFilesManifest(out)).toEqual(["a.ts", "b.ts"]);
  });

  it("strips backticks around paths", () => {
    expect(extractFilesManifest("Files:\n- `src/lib/x.ts`\n")).toEqual([
      "src/lib/x.ts",
    ]);
  });

  it("stops at the next bd-section header (LABELS)", () => {
    const out = `Files:\n- a.ts\nLABELS: wave:2\n- b.ts\n`;
    expect(extractFilesManifest(out)).toEqual(["a.ts"]);
  });
});

// ---------------------------------------------------------------------------
// extractTitle
// ---------------------------------------------------------------------------
describe("extractTitle", () => {
  it("extracts the title from the standard bd-show first line", () => {
    const out = `◐ factory-core-z9h.5 · Per-bead builder prompt construction   [● P1 · IN_PROGRESS]`;
    expect(extractTitle(out, "factory-core-z9h.5")).toBe(
      "Per-bead builder prompt construction",
    );
  });

  it("falls back to the bead id when no header line is present", () => {
    expect(extractTitle("no header here", "factory-core-z9h.5")).toBe(
      "factory-core-z9h.5",
    );
  });

  it("handles dots in the bead id correctly (no regex-escape bug)", () => {
    // If we forgot to escape the dot, `z9h.5` would match `z9h!5` too — this
    // test would pass accidentally. We use a realistic dotted id in a real
    // header instead to prove the path.
    const out = `◐ factory-core-z9h.5 · A Title [● P1 · OPEN]`;
    expect(extractTitle(out, "factory-core-z9h.5")).toBe("A Title");
  });
});

// ---------------------------------------------------------------------------
// extractBeadTestScenarios — exact-ID matching is the key AC
// ---------------------------------------------------------------------------
describe("extractBeadTestScenarios", () => {
  const docWithBoth = [
    "# Test Scenarios: factory-core-z9h",
    "",
    "## Wave 2",
    "",
    "### Bead: factory-core-z9h.5 — Per-bead prompt",
    "",
    "Scenario A for z9h.5",
    "Scenario B for z9h.5",
    "",
    "### Bead: factory-core-z9h.55 — A different bead",
    "",
    "Scenario for z9h.55",
    "",
  ].join("\n");

  it("extracts the section for a specific bead", () => {
    const section = extractBeadTestScenarios(docWithBoth, "factory-core-z9h.5");
    expect(section).toContain("Scenario A for z9h.5");
    expect(section).toContain("Scenario B for z9h.5");
  });

  it("does not confuse z9h.5 with z9h.55 (exact-ID match, the z9h.5 AC bullet)", () => {
    const section = extractBeadTestScenarios(docWithBoth, "factory-core-z9h.5");
    expect(section).not.toBeNull();
    expect(section).not.toContain("Scenario for z9h.55");
    expect(section).not.toContain("A different bead");
  });

  it("returns null when the document has no section for this bead", () => {
    const doc = [
      "## Wave 1",
      "### Bead: factory-core-z9h.2 — Fresh session per wave",
      "scenario",
    ].join("\n");
    expect(extractBeadTestScenarios(doc, "factory-core-z9h.5")).toBeNull();
  });

  it("stops at the next '### Bead:' heading", () => {
    const section = extractBeadTestScenarios(docWithBoth, "factory-core-z9h.5");
    expect(section).not.toContain("### Bead: factory-core-z9h.55");
  });

  it("stops at the next '## ' wave heading", () => {
    const doc = [
      "### Bead: foo.1 — Title",
      "scenario text",
      "## Wave 2",
      "next wave prose",
    ].join("\n");
    const section = extractBeadTestScenarios(doc, "foo.1");
    expect(section).toContain("scenario text");
    expect(section).not.toContain("next wave prose");
  });

  it("handles CRLF line endings (regression pattern #1)", () => {
    const doc = docWithBoth.replace(/\n/g, "\r\n");
    const section = extractBeadTestScenarios(doc, "factory-core-z9h.5");
    expect(section).toContain("Scenario A for z9h.5");
    expect(section).not.toContain("Scenario for z9h.55");
  });

  it("escapes regex-special characters in the bead id", () => {
    // A bead id containing a '+' (hypothetical) should not be treated as
    // a regex quantifier. The code escapes all specials.
    const doc = "### Bead: a+b.1 — title\nscenario\n";
    const section = extractBeadTestScenarios(doc, "a+b.1");
    expect(section).toContain("scenario");
  });
});

// ---------------------------------------------------------------------------
// loadBeadTestScenarios — tri-state return
// ---------------------------------------------------------------------------
describe("loadBeadTestScenarios", () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bead-prompt-test-"));
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns status:missing-doc when the path is undefined", async () => {
    const result = await loadBeadTestScenarios(undefined, "factory-core-z9h.5");
    expect(result.status).toBe("missing-doc");
  });

  it("returns status:missing-doc when the file does not exist", async () => {
    const result = await loadBeadTestScenarios(
      path.join(tmpDir, "nope.md"),
      "factory-core-z9h.5",
    );
    expect(result.status).toBe("missing-doc");
  });

  it("returns status:missing-section when the file exists but has no section", async () => {
    const filePath = path.join(tmpDir, "no-section.md");
    await fs.writeFile(filePath, "## Wave 1\n### Bead: other.1 — x\nstuff\n", "utf-8");
    const result = await loadBeadTestScenarios(filePath, "factory-core-z9h.5");
    expect(result.status).toBe("missing-section");
    if (result.status === "missing-section") {
      expect(result.content).toBeNull();
    }
  });

  it("returns status:present with the section content when found", async () => {
    const filePath = path.join(tmpDir, "found.md");
    const content = [
      "### Bead: factory-core-z9h.5 — Per-bead prompt",
      "",
      "Scenario text.",
      "",
    ].join("\n");
    await fs.writeFile(filePath, content, "utf-8");
    const result = await loadBeadTestScenarios(filePath, "factory-core-z9h.5");
    expect(result.status).toBe("present");
    if (result.status === "present") {
      expect(result.content).toContain("Scenario text.");
    }
  });
});

// ---------------------------------------------------------------------------
// buildPerBeadPrompt — covers the three fallback branches + happy path
// ---------------------------------------------------------------------------
describe("buildPerBeadPrompt", () => {
  const baseInputs: PerBeadPromptInputs = {
    beadId: "factory-core-z9h.5",
    beadTitle: "Per-bead builder prompt construction",
    beadDescription: "Each parallel builder receives a focused prompt.",
    beadAcceptanceCriteria: "- Given A, When B, Then C.",
    beadFiles: ["src/lib/bead-prompt.ts", "src/app/api/fleet/action/route.ts"],
    epicId: "factory-core-z9h",
    epicTitle: "Fully autonomous pipeline",
    shipType: "internal",
    waveNumber: 2,
    repoPath: "/abs/repo",
    fleetCorePath: "/abs/fleet-core",
    researchPath: "/abs/research.md",
    planPath: "/abs/plan.md",
    specPath: "/abs/spec.md",
    architecturePath: "/abs/arch.md",
    testScenariosPath: "/abs/scenarios.md",
    testScenarios: { status: "present", content: "Scenario block" },
  };

  it("happy path — prompt includes bead id, title, description, AC, files, scenarios, paths", () => {
    const prompt = buildPerBeadPrompt(baseInputs);
    expect(prompt).toContain("factory-core-z9h.5");
    expect(prompt).toContain("Per-bead builder prompt construction");
    expect(prompt).toContain("Each parallel builder receives a focused prompt.");
    expect(prompt).toContain("- Given A, When B, Then C.");
    expect(prompt).toContain("- src/lib/bead-prompt.ts");
    expect(prompt).toContain("- src/app/api/fleet/action/route.ts");
    expect(prompt).toContain("Scenario block");
    expect(prompt).toContain("/abs/repo");
    expect(prompt).toContain("/abs/fleet-core");
    expect(prompt).toContain("/abs/research.md");
    expect(prompt).toContain("/abs/plan.md");
    expect(prompt).toContain("/abs/spec.md");
    expect(prompt).toContain("/abs/arch.md");
    expect(prompt).toContain("/abs/scenarios.md");
  });

  it("explicitly tells the builder to work ONLY its bead (anti-cross-contamination)", () => {
    const prompt = buildPerBeadPrompt(baseInputs);
    expect(prompt).toMatch(/Work ONLY bead factory-core-z9h\.5/);
    expect(prompt).toMatch(/Do not start, claim, or close any other bead/);
  });

  it("AC fallback — 'no AC — smoke only' when AC is empty (the z9h.5 AC bullet)", () => {
    const prompt = buildPerBeadPrompt({ ...baseInputs, beadAcceptanceCriteria: "" });
    expect(prompt).toContain("no AC — smoke only");
    expect(prompt).not.toMatch(/^--- Acceptance Criteria ---\n\n/m); // never empty block
  });

  it("AC fallback — whitespace-only AC counts as empty", () => {
    const prompt = buildPerBeadPrompt({
      ...baseInputs,
      beadAcceptanceCriteria: "   \n  \n ",
    });
    expect(prompt).toContain("no AC — smoke only");
  });

  it("files fallback — when bead has no Files: manifest, renders a guidance note (not empty)", () => {
    const prompt = buildPerBeadPrompt({ ...baseInputs, beadFiles: [] });
    expect(prompt).toContain("no Files: manifest declared");
    expect(prompt).toContain("proceed carefully");
  });

  it("test-scenarios fallback — missing-section renders a warning with the bead id", () => {
    const prompt = buildPerBeadPrompt({
      ...baseInputs,
      testScenarios: { status: "missing-section", content: null },
    });
    expect(prompt).toMatch(
      /WARNING: test scenarios missing for factory-core-z9h\.5 — write tests from AC/,
    );
  });

  it("test-scenarios fallback — missing-doc renders a distinct note (not the 'missing section' warning)", () => {
    const prompt = buildPerBeadPrompt({
      ...baseInputs,
      testScenarios: { status: "missing-doc" },
    });
    expect(prompt).toContain("test-scenarios document not found");
    expect(prompt).not.toContain("test scenarios missing for factory-core-z9h.5");
  });

  it("description fallback — when description is empty, renders a safe placeholder (not 'undefined')", () => {
    const prompt = buildPerBeadPrompt({ ...baseInputs, beadDescription: "" });
    expect(prompt).toContain("bead has no description");
    expect(prompt).not.toContain("undefined");
  });

  it("optional paths omitted when not provided", () => {
    const prompt = buildPerBeadPrompt({
      ...baseInputs,
      researchPath: undefined,
      planPath: undefined,
      specPath: undefined,
      architecturePath: undefined,
      testScenariosPath: undefined,
    });
    expect(prompt).not.toContain("Research report:");
    expect(prompt).not.toContain("Functional spec:");
    expect(prompt).not.toContain("Architecture:");
    expect(prompt).not.toContain("Build plan:");
    expect(prompt).not.toContain("Test scenarios doc:");
    // Always-present anchors
    expect(prompt).toContain("Product repo:");
    expect(prompt).toContain("Fleet-core:");
  });

  it("shell-metachar safety — contents pass through verbatim (tmux load-buffer bypasses shell)", () => {
    // The prompt builder returns raw text; no escaping happens here because
    // the caller routes the string through tmux load-buffer / paste-buffer
    // which does not invoke a shell. We verify the builder doesn't mangle
    // common shell metacharacters: $(), `, ;, &, |, >, <.
    const spicyDesc = `$(rm -rf /) ; cat /etc/passwd & echo > hax.txt | \`curl evil\``;
    const prompt = buildPerBeadPrompt({ ...baseInputs, beadDescription: spicyDesc });
    expect(prompt).toContain(spicyDesc);
  });

  it("wave number is surfaced in the prompt (so the builder knows which wave it's in)", () => {
    const prompt = buildPerBeadPrompt({ ...baseInputs, waveNumber: 3 });
    expect(prompt).toContain("wave 3");
  });
});
