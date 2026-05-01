/**
 * Tests for `shipyard reason` CLI (factory-core-3p1e.8).
 *
 * Coverage strategy: pure functions (parseCoherenceOutput, stripCodeFences,
 * formatOutput, buildUserPrompt) are exercised directly; runReason() is
 * exercised with injected mocks for fs, bd, event-log, and the claude
 * subprocess. The CLI entry point (main()) is NOT exercised here — its only
 * job is dependency wiring + process.exit. Verifying it would require
 * spawning a real Node child, which doubles run time without adding
 * coverage of any logic that isn't already tested via runReason().
 *
 * Pyramid placement: all unit tests. Integration verification (real claude
 * subprocess against a real stuck epic) is the operator-tested promotion
 * step in AC6, recorded in the marker.
 */

import { PipelineEvent } from "../../src/lib/event-log";
import {
  buildUserPrompt,
  CoherenceOutput,
  formatOutput,
  parseCoherenceOutput,
  ReasonDeps,
  ReasonExitCode,
  runReason,
  stripCodeFences,
} from "../../src/cli/reason";

// ---------------------------------------------------------------------------
// Pure-function tests
// ---------------------------------------------------------------------------

describe("stripCodeFences", () => {
  it("returns bare JSON unchanged", () => {
    const input = '{"recommendation":"x"}';
    expect(stripCodeFences(input)).toBe(input);
  });

  it("strips ```json fences", () => {
    const input = '```json\n{"recommendation":"x"}\n```';
    expect(stripCodeFences(input)).toBe('{"recommendation":"x"}');
  });

  it("strips bare ``` fences", () => {
    const input = '```\n{"a":1}\n```';
    expect(stripCodeFences(input)).toBe('{"a":1}');
  });

  it("trims surrounding whitespace", () => {
    const input = '   \n  {"a":1}  \n  ';
    expect(stripCodeFences(input)).toBe('{"a":1}');
  });

  it("does not strip fences that are not at the boundaries", () => {
    const input = 'text ```json {"a":1} ``` more';
    expect(stripCodeFences(input)).toBe(input);
  });
});

describe("parseCoherenceOutput", () => {
  const valid: CoherenceOutput = {
    recommendation: "Re-plan with input-validation ACs",
    reasoning: "Bugs at rounds 3-5 cite missing validation; this is a missing-AC pattern.",
    confidence: 0.82,
  };

  it("accepts a valid bare JSON object", () => {
    const result = parseCoherenceOutput(JSON.stringify(valid));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual(valid);
    }
  });

  it("accepts a code-fenced JSON object", () => {
    const fenced = "```json\n" + JSON.stringify(valid) + "\n```";
    const result = parseCoherenceOutput(fenced);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual(valid);
    }
  });

  it("rejects malformed JSON with parse error", () => {
    const result = parseCoherenceOutput("{not json");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/JSON parse failed/);
    }
  });

  it("rejects non-object top-level (array)", () => {
    const result = parseCoherenceOutput("[1,2,3]");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/expected an object/);
    }
  });

  it("rejects non-object top-level (string)", () => {
    const result = parseCoherenceOutput('"hello"');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/expected an object/);
    }
  });

  it("rejects missing 'recommendation' field", () => {
    const result = parseCoherenceOutput(
      JSON.stringify({ reasoning: "x", confidence: 0.5 }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/missing field 'recommendation'/);
    }
  });

  it("rejects empty 'recommendation'", () => {
    const result = parseCoherenceOutput(
      JSON.stringify({ recommendation: "", reasoning: "x", confidence: 0.5 }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/non-empty/);
      expect(result.error).toMatch(/recommendation/);
    }
  });

  it("rejects whitespace-only 'recommendation'", () => {
    const result = parseCoherenceOutput(
      JSON.stringify({ recommendation: "   \t\n  ", reasoning: "x", confidence: 0.5 }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/non-empty/);
    }
  });

  it("rejects non-string 'recommendation'", () => {
    const result = parseCoherenceOutput(
      JSON.stringify({ recommendation: 42, reasoning: "x", confidence: 0.5 }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/recommendation.*must be a string/);
    }
  });

  it("rejects missing 'reasoning' field", () => {
    const result = parseCoherenceOutput(
      JSON.stringify({ recommendation: "x", confidence: 0.5 }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/missing field 'reasoning'/);
    }
  });

  it("rejects missing 'confidence' field", () => {
    const result = parseCoherenceOutput(
      JSON.stringify({ recommendation: "x", reasoning: "y" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/missing field 'confidence'/);
    }
  });

  it("rejects non-numeric 'confidence'", () => {
    const result = parseCoherenceOutput(
      JSON.stringify({ recommendation: "x", reasoning: "y", confidence: "0.5" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/confidence.*finite number/);
    }
  });

  it("rejects 'confidence' > 1", () => {
    const result = parseCoherenceOutput(
      JSON.stringify({ recommendation: "x", reasoning: "y", confidence: 1.5 }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/\[0, 1\]/);
      expect(result.error).toMatch(/confidence/);
    }
  });

  it("rejects 'confidence' < 0", () => {
    const result = parseCoherenceOutput(
      JSON.stringify({ recommendation: "x", reasoning: "y", confidence: -0.1 }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/\[0, 1\]/);
    }
  });

  it("accepts 'confidence' at boundaries 0 and 1", () => {
    const r0 = parseCoherenceOutput(
      JSON.stringify({ recommendation: "x", reasoning: "y", confidence: 0 }),
    );
    expect(r0.ok).toBe(true);
    const r1 = parseCoherenceOutput(
      JSON.stringify({ recommendation: "x", reasoning: "y", confidence: 1 }),
    );
    expect(r1.ok).toBe(true);
  });

  it("rejects NaN 'confidence'", () => {
    // NaN can't be JSON-serialised, so test via raw string.
    const result = parseCoherenceOutput(
      '{"recommendation":"x","reasoning":"y","confidence":NaN}',
    );
    // Either parse fails (NaN is not valid JSON) or schema fails — both 1.
    expect(result.ok).toBe(false);
  });

  it("preserves UTF-8 multi-byte characters in recommendation", () => {
    const utf8 = {
      recommendation: "Re-plan with ellipsis…and curly “quotes”",
      reasoning: "y",
      confidence: 0.5,
    };
    const result = parseCoherenceOutput(JSON.stringify(utf8));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.recommendation).toBe(utf8.recommendation);
    }
  });
});

describe("formatOutput", () => {
  const data: CoherenceOutput = {
    recommendation: "File a bug for the stale label",
    reasoning: "Two pipeline:* labels present, blocking auto-chain.",
    confidence: 0.9,
  };

  it("includes all three sections in order: recommendation, reasoning, confidence", () => {
    const out = formatOutput(data, true /* noColour */);
    const recIdx = out.indexOf("Recommendation:");
    const reaIdx = out.indexOf("Reasoning:");
    const conIdx = out.indexOf("Confidence:");
    expect(recIdx).toBeGreaterThan(-1);
    expect(reaIdx).toBeGreaterThan(-1);
    expect(conIdx).toBeGreaterThan(-1);
    expect(recIdx).toBeLessThan(reaIdx);
    expect(reaIdx).toBeLessThan(conIdx);
  });

  it("omits ANSI codes when noColour=true", () => {
    const out = formatOutput(data, true);
    expect(out).not.toMatch(/\x1b\[/);
  });

  it("includes ANSI codes when noColour=false", () => {
    const out = formatOutput(data, false);
    expect(out).toMatch(/\x1b\[/);
  });

  it("renders confidence with 2 decimal places", () => {
    const out = formatOutput({ ...data, confidence: 0.876543 }, true);
    expect(out).toMatch(/Confidence:\s*0\.88/);
  });

  it("uses green for high confidence (>= 0.75)", () => {
    const out = formatOutput({ ...data, confidence: 0.8 }, false);
    expect(out).toContain("\x1b[32m");
  });

  it("uses yellow for mid confidence ([0.4, 0.75))", () => {
    const out = formatOutput({ ...data, confidence: 0.5 }, false);
    expect(out).toContain("\x1b[33m");
  });

  it("uses red for low confidence (< 0.4)", () => {
    const out = formatOutput({ ...data, confidence: 0.2 }, false);
    expect(out).toContain("\x1b[31m");
  });
});

describe("buildUserPrompt", () => {
  it("includes the epic id, bd state, and events", () => {
    const events: PipelineEvent[] = [
      {
        type: "agent-exited",
        timestamp: "2026-04-29T10:00:00Z",
        epicId: "test-epic",
        stage: "build",
      },
    ];
    const prompt = buildUserPrompt(
      "test-epic",
      "DESCRIPTION\nThe epic body\n\nLABELS: pipeline:build",
      events,
    );
    expect(prompt).toContain("test-epic");
    expect(prompt).toContain("The epic body");
    expect(prompt).toContain("LABELS: pipeline:build");
    expect(prompt).toContain("agent-exited");
  });

  it("handles zero events gracefully", () => {
    const prompt = buildUserPrompt("e", "bd state", []);
    expect(prompt).toMatch(/no events recorded/i);
  });

  it("handles empty bd state gracefully", () => {
    const prompt = buildUserPrompt("e", "", []);
    expect(prompt).toMatch(/\(empty\)/);
  });

  it("requests JSON output explicitly with the schema", () => {
    const prompt = buildUserPrompt("e", "bd", []);
    expect(prompt).toMatch(/recommendation/);
    expect(prompt).toMatch(/reasoning/);
    expect(prompt).toMatch(/confidence/);
    expect(prompt).toMatch(/JSON/);
  });

  it("instructs the agent NOT to dispatch curl actions", () => {
    const prompt = buildUserPrompt("e", "bd", []);
    expect(prompt).toMatch(/do NOT/i);
  });
});

// ---------------------------------------------------------------------------
// runReason() — orchestration with mocks
// ---------------------------------------------------------------------------

interface MockState {
  files: Record<string, string>;
  bdShows: Record<string, string | null>;
  bdShowError?: Error;
  events: PipelineEvent[];
  spawnResult: {
    status: number | null;
    stdout: string;
    stderr: string;
    error?: NodeJS.ErrnoException;
  };
  logs: string[];
  errs: string[];
  spawnCalls: Array<{
    systemPrompt: string;
    userPrompt: string;
    cwd: string;
  }>;
}

function makeDeps(state: MockState): ReasonDeps {
  return {
    readFile: (p) => {
      if (state.files[p] !== undefined) return state.files[p];
      throw new Error(`mock readFile: no fixture for ${p}`);
    },
    fileExists: (p) => p in state.files,
    runBdShow: (epicId) => {
      if (state.bdShowError) throw state.bdShowError;
      if (!(epicId in state.bdShows)) {
        throw new Error(`mock runBdShow: no fixture for ${epicId}`);
      }
      return state.bdShows[epicId];
    },
    readEpicEvents: async () => state.events,
    spawnClaude: (systemPrompt, userPrompt, cwd) => {
      state.spawnCalls.push({ systemPrompt, userPrompt, cwd });
      return state.spawnResult;
    },
    log: (msg) => state.logs.push(msg),
    err: (msg) => state.errs.push(msg),
  };
}

function makeState(overrides: Partial<MockState> = {}): MockState {
  const SHIPYARD_PATH = "/fake/factory-core";
  return {
    files: {
      [`${SHIPYARD_PATH}/.claude/agents/coherence.md`]:
        "# coherence agent\n(system prompt body)\n",
    },
    bdShows: {
      "factory-core-jba": "DESCRIPTION\nA stuck epic\n\nLABELS: pipeline:build",
    },
    events: [],
    spawnResult: {
      status: 0,
      stdout: JSON.stringify({
        recommendation: "Re-plan with feedback X",
        reasoning: "Bugs cluster around feature Y; AC missing.",
        confidence: 0.85,
      }),
      stderr: "",
    },
    logs: [],
    errs: [],
    spawnCalls: [],
    ...overrides,
  };
}

const SHIPYARD_PATH = "/fake/factory-core";

describe("runReason — happy path", () => {
  it("returns 0, prints recommendation/reasoning/confidence", async () => {
    const state = makeState();
    const code: ReasonExitCode = await runReason(
      { epicId: "factory-core-jba", shipyardPath: SHIPYARD_PATH, noColour: true },
      makeDeps(state),
    );
    expect(code).toBe(0);
    expect(state.errs).toEqual([]);
    expect(state.logs.length).toBe(1);
    const out = state.logs[0];
    expect(out).toMatch(/Re-plan with feedback X/);
    expect(out).toMatch(/Bugs cluster/);
    expect(out).toMatch(/0\.85/);
  });

  it("passes coherence.md content as the system prompt", async () => {
    const state = makeState();
    await runReason(
      { epicId: "factory-core-jba", shipyardPath: SHIPYARD_PATH, noColour: true },
      makeDeps(state),
    );
    expect(state.spawnCalls.length).toBe(1);
    expect(state.spawnCalls[0].systemPrompt).toContain("coherence agent");
    expect(state.spawnCalls[0].cwd).toBe(SHIPYARD_PATH);
  });

  it("includes events in the user prompt when present", async () => {
    const events: PipelineEvent[] = [
      {
        type: "stage-dispatched",
        timestamp: "2026-04-29T10:00:00Z",
        epicId: "factory-core-jba",
      },
      {
        type: "agent-exited",
        timestamp: "2026-04-29T10:05:00Z",
        epicId: "factory-core-jba",
      },
    ];
    const state = makeState({ events });
    await runReason(
      { epicId: "factory-core-jba", shipyardPath: SHIPYARD_PATH, noColour: true },
      makeDeps(state),
    );
    expect(state.spawnCalls[0].userPrompt).toContain("stage-dispatched");
    expect(state.spawnCalls[0].userPrompt).toContain("agent-exited");
  });

  it("accepts code-fenced subprocess output", async () => {
    const fenced =
      "```json\n" +
      JSON.stringify({
        recommendation: "X",
        reasoning: "Y",
        confidence: 0.5,
      }) +
      "\n```";
    const state = makeState({
      spawnResult: { status: 0, stdout: fenced, stderr: "" },
    });
    const code = await runReason(
      { epicId: "factory-core-jba", shipyardPath: SHIPYARD_PATH, noColour: true },
      makeDeps(state),
    );
    expect(code).toBe(0);
    expect(state.logs[0]).toMatch(/Recommendation:.*X/);
  });
});

describe("runReason — exit code 1 (parse / schema failures)", () => {
  it("returns 1 when subprocess emits malformed JSON", async () => {
    const state = makeState({
      spawnResult: { status: 0, stdout: "{not json", stderr: "" },
    });
    const code = await runReason(
      { epicId: "factory-core-jba", shipyardPath: SHIPYARD_PATH, noColour: true },
      makeDeps(state),
    );
    expect(code).toBe(1);
    expect(state.errs.some((e) => /JSON parse failed/.test(e))).toBe(true);
  });

  it("returns 1 when 'recommendation' is empty", async () => {
    const state = makeState({
      spawnResult: {
        status: 0,
        stdout: JSON.stringify({
          recommendation: "",
          reasoning: "y",
          confidence: 0.5,
        }),
        stderr: "",
      },
    });
    const code = await runReason(
      { epicId: "factory-core-jba", shipyardPath: SHIPYARD_PATH, noColour: true },
      makeDeps(state),
    );
    expect(code).toBe(1);
    expect(state.errs.some((e) => /recommendation/.test(e))).toBe(true);
  });

  it("returns 1 when 'confidence' is out of range", async () => {
    const state = makeState({
      spawnResult: {
        status: 0,
        stdout: JSON.stringify({
          recommendation: "x",
          reasoning: "y",
          confidence: 1.5,
        }),
        stderr: "",
      },
    });
    const code = await runReason(
      { epicId: "factory-core-jba", shipyardPath: SHIPYARD_PATH, noColour: true },
      makeDeps(state),
    );
    expect(code).toBe(1);
    expect(state.errs.some((e) => /confidence/.test(e))).toBe(true);
  });

  it("includes the raw subprocess output in the error stream when parse fails", async () => {
    const state = makeState({
      spawnResult: {
        status: 0,
        stdout: "this is not json at all",
        stderr: "",
      },
    });
    const code = await runReason(
      { epicId: "factory-core-jba", shipyardPath: SHIPYARD_PATH, noColour: true },
      makeDeps(state),
    );
    expect(code).toBe(1);
    expect(state.errs.some((e) => /this is not json at all/.test(e))).toBe(true);
  });
});

describe("runReason — exit code 2 (epic not found)", () => {
  it("returns 2 when bd reports the epic is not found", async () => {
    const state = makeState({
      bdShows: { "factory-core-jba": null },
    });
    const code = await runReason(
      { epicId: "factory-core-jba", shipyardPath: SHIPYARD_PATH, noColour: true },
      makeDeps(state),
    );
    expect(code).toBe(2);
    expect(state.errs.some((e) => /not found/i.test(e))).toBe(true);
    // Subprocess must NOT be invoked.
    expect(state.spawnCalls.length).toBe(0);
  });

  it("returns 2 when bd show throws", async () => {
    const state = makeState({
      bdShowError: new Error("bd not installed"),
    });
    const code = await runReason(
      { epicId: "factory-core-jba", shipyardPath: SHIPYARD_PATH, noColour: true },
      makeDeps(state),
    );
    expect(code).toBe(2);
    expect(state.spawnCalls.length).toBe(0);
  });
});

describe("runReason — exit code 3 (subprocess / config failures)", () => {
  it("returns 3 when claude is not in PATH (ENOENT)", async () => {
    const enoent = Object.assign(new Error("spawn claude ENOENT"), {
      code: "ENOENT",
    });
    const state = makeState({
      spawnResult: {
        status: null,
        stdout: "",
        stderr: "",
        error: enoent as NodeJS.ErrnoException,
      },
    });
    const code = await runReason(
      { epicId: "factory-core-jba", shipyardPath: SHIPYARD_PATH, noColour: true },
      makeDeps(state),
    );
    expect(code).toBe(3);
    expect(state.errs.some((e) => /not found in PATH/.test(e))).toBe(true);
  });

  it("returns 3 when claude exits with non-zero status, forwards stderr", async () => {
    const state = makeState({
      spawnResult: {
        status: 2,
        stdout: "",
        stderr: "ratelimit: too many requests",
      },
    });
    const code = await runReason(
      { epicId: "factory-core-jba", shipyardPath: SHIPYARD_PATH, noColour: true },
      makeDeps(state),
    );
    expect(code).toBe(3);
    // The subprocess's stderr must be piped through.
    expect(state.errs.some((e) => /ratelimit/.test(e))).toBe(true);
  });

  it("returns 3 with a clear message when coherence.md is missing", async () => {
    const state = makeState({ files: {} /* no coherence.md fixture */ });
    const code = await runReason(
      { epicId: "factory-core-jba", shipyardPath: SHIPYARD_PATH, noColour: true },
      makeDeps(state),
    );
    expect(code).toBe(3);
    expect(
      state.errs.some(
        (e) => /coherence\.md not found/i.test(e) && e.includes(SHIPYARD_PATH),
      ),
    ).toBe(true);
    // Subprocess must NOT be invoked when coherence.md is missing.
    expect(state.spawnCalls.length).toBe(0);
  });

  it("returns 3 on generic spawn errors that aren't ENOENT", async () => {
    const generic = Object.assign(new Error("spawn EACCES"), { code: "EACCES" });
    const state = makeState({
      spawnResult: {
        status: null,
        stdout: "",
        stderr: "",
        error: generic as NodeJS.ErrnoException,
      },
    });
    const code = await runReason(
      { epicId: "factory-core-jba", shipyardPath: SHIPYARD_PATH, noColour: true },
      makeDeps(state),
    );
    expect(code).toBe(3);
  });
});

describe("runReason — SHIPYARD_PATH resolution", () => {
  it("resolves coherence.md relative to the supplied shipyardPath", async () => {
    const altPath = "/somewhere/else";
    const state: MockState = {
      ...makeState(),
      files: {
        [`${altPath}/.claude/agents/coherence.md`]: "alt system prompt",
      },
    };
    const code = await runReason(
      { epicId: "factory-core-jba", shipyardPath: altPath, noColour: true },
      makeDeps(state),
    );
    expect(code).toBe(0);
    expect(state.spawnCalls[0].systemPrompt).toBe("alt system prompt");
    expect(state.spawnCalls[0].cwd).toBe(altPath);
  });
});
