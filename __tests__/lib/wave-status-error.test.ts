// =============================================================================
// Tests for getWaveStatus error propagation (factory-core-z9h.10)
// =============================================================================
//
// QA found that when `bd list` failed, getWaveStatus returned
// { hasWaves: false, totalChildren: 0 } without signalling an error. Callers
// (handleChainAction dev-branch, send-for-development) treated that as
// "no waves present", silently advancing the pipeline — even when the epic
// had unclosed wave-labelled children.
//
// z9h.10 adds an `error?: string` field to WaveStatus so callers can refuse
// to act on unknown wave state. This file covers:
//   1. error is set when `bd list` fails
//   2. error is NOT set on the happy paths (no children / has waves)
//
// Regression patterns covered:
//   #13 Silent Exception Swallowing — bd failure must not masquerade as
//       a successful "no waves here" result.
//   #7  Type Confusion on Enum Branching — all-labelled / none-labelled /
//       UNKNOWN are three distinct states; this field materialises the
//       third state.
// =============================================================================

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

// getWaveStatus calls execFileSync (via execBdSync) to run `bd show <epic>`
// and `bd list --parent=<epic>` / `bd list --label=epic:<epic>`. We control
// the return value per-test via the behavior function so we can simulate
// (a) a successful epic show + a failing list, and (b) both succeeding.

type ExecResult = { stdout?: string; error?: Error };

let execBehaviour: (args: string[]) => ExecResult = () => ({ stdout: "" });

jest.mock("child_process", () => {
  const actual = jest.requireActual("child_process");
  return {
    ...actual,
    execFileSync: jest.fn((_bd: string, args: string[]) => {
      const r = execBehaviour(args);
      if (r.error) throw r.error;
      return r.stdout ?? "";
    }),
  };
});

// Stub out bd-path so execBdSync doesn't actually try to locate a bd binary.
jest.mock("@/lib/bd-path", () => ({
  getBdPath: () => "/usr/local/bin/bd",
  getBdEnv: () => ({ PATH: "/usr/local/bin" }),
}));

// Stub out langfuse-env (pulled in by agent-launcher module load).
jest.mock("@/lib/langfuse-env", () => ({
  buildOtelEnv: () => ({}),
  buildLangfuseTraceUrl: () => null,
  isLangfuseConfigured: () => false,
}));

import { getWaveStatus } from "@/lib/agent-launcher";

// Helpers --------------------------------------------------------------------

/** Simulate an epic-show result that marks the epic as internal ship-type. */
const INTERNAL_EPIC_SHOW = `
◐ factory-core-z9h · Epic [● P1 · IN_PROGRESS]
LABELS: ship-type:internal, release:1.0
`;

/**
 * Simulate the tree output bd emits for a successful
 * `bd list --parent=<epic>` — two children, one open one closed.
 */
const TWO_CHILDREN_TREE = `
◐ factory-core-z9h ● P1 [epic] Epic
├── ○ factory-core-z9h.aaa ● P1 task Open child
└── ✓ factory-core-z9h.bbb ● P1 task Closed child
`;

const CHILD_AAA_SHOW = `
○ factory-core-z9h.aaa · [OPEN]
LABELS: wave:1, ship-type:internal
`;

const CHILD_BBB_SHOW = `
✓ factory-core-z9h.bbb · [CLOSED]
LABELS: wave:1, ship-type:internal
`;

// ---------------------------------------------------------------------------

afterEach(() => {
  execBehaviour = () => ({ stdout: "" });
});

describe("getWaveStatus — error propagation (factory-core-z9h.10)", () => {
  it("sets `error` when `bd list` fails so callers can refuse to advance", async () => {
    // First call: bd show <epic> succeeds (needed for isInternal detection).
    // Second call: bd list --parent=<epic> fails.
    execBehaviour = (args) => {
      if (args[0] === "show") return { stdout: INTERNAL_EPIC_SHOW };
      if (args[0] === "list") return { error: new Error("bd: connection refused") };
      return { stdout: "" };
    };

    const status = await getWaveStatus("factory-core-z9h", "/Users/janemckay/dev/fleet/fleet-core");

    expect(status.error).toBeDefined();
    expect(status.error).toContain("bd list failed");
    expect(status.error).toContain("factory-core-z9h");
    // The shape stays safe for legacy callers that DO check hasWaves first,
    // but callers MUST check .error first — the type-confusion regression
    // pattern says "unknown" is a distinct state from "none-labelled".
    expect(status.hasWaves).toBe(false);
    expect(status.totalChildren).toBe(0);
    expect(status.childrenWithWaveLabels).toBe(0);
  });

  it("does NOT set `error` when everything succeeds and the epic has wave labels", async () => {
    // Epic show -> tree list -> child shows, all succeed.
    execBehaviour = (args) => {
      if (args[0] === "show") {
        if (args[1] === "factory-core-z9h") return { stdout: INTERNAL_EPIC_SHOW };
        if (args[1] === "factory-core-z9h.aaa") return { stdout: CHILD_AAA_SHOW };
        if (args[1] === "factory-core-z9h.bbb") return { stdout: CHILD_BBB_SHOW };
      }
      if (args[0] === "list") return { stdout: TWO_CHILDREN_TREE };
      return { stdout: "" };
    };

    const status = await getWaveStatus("factory-core-z9h", "/Users/janemckay/dev/fleet/fleet-core");

    expect(status.error).toBeUndefined();
    expect(status.hasWaves).toBe(true);
    expect(status.totalChildren).toBe(2);
    expect(status.childrenWithWaveLabels).toBe(2);
  });

  it("does NOT set `error` when `bd list` succeeds but returns zero children (legitimate empty epic)", async () => {
    // Distinguishes "unknown" (bd failed) from "none-labelled / no children"
    // (bd succeeded, returned nothing) — the Type Confusion #7 distinction.
    execBehaviour = (args) => {
      if (args[0] === "show") return { stdout: INTERNAL_EPIC_SHOW };
      if (args[0] === "list") return { stdout: "" };
      return { stdout: "" };
    };

    const status = await getWaveStatus("factory-core-z9h", "/Users/janemckay/dev/fleet/fleet-core");

    // bd succeeded -> no error. Empty epic -> no waves. That collapse is
    // legitimate because bd genuinely reported no children.
    expect(status.error).toBeUndefined();
    expect(status.hasWaves).toBe(false);
    expect(status.totalChildren).toBe(0);
    expect(status.childrenWithWaveLabels).toBe(0);
  });

  it("includes the filter args in the error message so ops can diagnose which query failed", async () => {
    execBehaviour = (args) => {
      if (args[0] === "show") return { stdout: INTERNAL_EPIC_SHOW };
      if (args[0] === "list") return { error: new Error("bd: unreachable") };
      return { stdout: "" };
    };

    const status = await getWaveStatus("some-epic", "/tmp/fleet");

    // Internal ship-type -> `--parent=some-epic` filter (not the --label
    // form). The caller log line includes this so a transient bd outage
    // on a specific filter shape is traceable.
    expect(status.error).toMatch(/--parent=some-epic/);
  });
});

describe("getWaveStatus — per-child bd show failure (factory-core-z9h.8)", () => {
  // Reproducer for the z9h.8 bug: when `bd list` succeeds but one of the
  // per-child `bd show` calls fails, the pre-fix code silently skipped the
  // failing child. If the skipped child was the only unclosed bead in its
  // wave, the wave map recorded {total: N-1, closed: N-1} and
  // currentWaveComplete flipped to true — auto-advancing the pipeline while
  // the bead was still open. The fix returns an explicit error so callers
  // refuse to advance on unknown wave state.

  const THREE_CHILDREN_TREE = `
◐ factory-core-z9h ● P1 [epic] Epic
├── ○ factory-core-z9h.aaa ● P1 task Open child (will flake)
├── ✓ factory-core-z9h.bbb ● P1 task Closed child
└── ✓ factory-core-z9h.ccc ● P1 task Closed child
`;

  const CLOSED_BBB_SHOW = `
✓ factory-core-z9h.bbb · [CLOSED]
LABELS: wave:1, ship-type:internal
`;

  const CLOSED_CCC_SHOW = `
✓ factory-core-z9h.ccc · [CLOSED]
LABELS: wave:1, ship-type:internal
`;

  it("sets `error` when a single child's `bd show` fails (silent-skip regression)", async () => {
    // Scenario: 3 wave:1 children. Two are closed, one is open (.aaa).
    // The open child's `bd show` flakes. Before the fix, this child was
    // silently skipped — the wave map recorded {total: 2, closed: 2} and
    // currentWaveComplete flipped to true. After the fix, getWaveStatus
    // returns an error so callers refuse to advance the pipeline.
    execBehaviour = (args) => {
      if (args[0] === "show") {
        if (args[1] === "factory-core-z9h") return { stdout: INTERNAL_EPIC_SHOW };
        if (args[1] === "factory-core-z9h.aaa") {
          return { error: new Error("bd: transient connection failure") };
        }
        if (args[1] === "factory-core-z9h.bbb") return { stdout: CLOSED_BBB_SHOW };
        if (args[1] === "factory-core-z9h.ccc") return { stdout: CLOSED_CCC_SHOW };
      }
      if (args[0] === "list") return { stdout: THREE_CHILDREN_TREE };
      return { stdout: "" };
    };

    const status = await getWaveStatus("factory-core-z9h", "/Users/janemckay/dev/fleet/fleet-core");

    expect(status.error).toBeDefined();
    expect(status.error).toContain("bd show failed");
    expect(status.error).toContain("factory-core-z9h.aaa");
    // Guard the specific silent-advance we are preventing:
    expect(status.currentWaveComplete).toBe(false);
    expect(status.allWavesComplete).toBe(false);
    // Shape contract: hasWaves=false + error set is the "UNKNOWN" state,
    // not "none-labelled". Callers check `error` first.
    expect(status.hasWaves).toBe(false);
  });

  it("names the failing child in the error message so ops can diagnose which bead flaked", async () => {
    // Distinct from z9h.10 (which names the failed filter). Here the
    // failing unit is a specific child ID, so it must appear in the log
    // to be actionable (e.g. retry that one bead).
    execBehaviour = (args) => {
      if (args[0] === "show") {
        if (args[1] === "factory-core-z9h") return { stdout: INTERNAL_EPIC_SHOW };
        if (args[1] === "factory-core-z9h.bbb") {
          return { error: new Error("bd: unreachable") };
        }
        if (args[1] === "factory-core-z9h.aaa") return { stdout: CLOSED_BBB_SHOW };
        if (args[1] === "factory-core-z9h.ccc") return { stdout: CLOSED_CCC_SHOW };
      }
      if (args[0] === "list") return { stdout: THREE_CHILDREN_TREE };
      return { stdout: "" };
    };

    const status = await getWaveStatus("factory-core-z9h", "/Users/janemckay/dev/fleet/fleet-core");

    expect(status.error).toMatch(/factory-core-z9h\.(aaa|bbb|ccc)/);
    expect(status.error).toMatch(/factory-core-z9h/);
  });

  it("returns immediately on the first failing child — no partial wave map leaked through", async () => {
    // Even if later children would succeed, we abort on the first failure.
    // This avoids a half-populated wave map that a downstream caller could
    // confuse with a real "all closed" state. We assert by checking the
    // shape returned is the canonical empty-error shape, not a partially
    // filled one.
    execBehaviour = (args) => {
      if (args[0] === "show") {
        if (args[1] === "factory-core-z9h") return { stdout: INTERNAL_EPIC_SHOW };
        if (args[1] === "factory-core-z9h.aaa") {
          return { error: new Error("bd: flake") };
        }
        // These would count a closed bead if reached:
        if (args[1] === "factory-core-z9h.bbb") return { stdout: CLOSED_BBB_SHOW };
        if (args[1] === "factory-core-z9h.ccc") return { stdout: CLOSED_CCC_SHOW };
      }
      if (args[0] === "list") return { stdout: THREE_CHILDREN_TREE };
      return { stdout: "" };
    };

    const status = await getWaveStatus("factory-core-z9h", "/Users/janemckay/dev/fleet/fleet-core");

    // A partial walk would leave waves populated with {1: {total: 2, closed: 2}}
    // (because .bbb + .ccc are closed) and flip currentWaveComplete. The fix
    // returns an empty waves map with childrenWithWaveLabels=0 to signal
    // "unknown" unambiguously.
    expect(status.waves.size).toBe(0);
    expect(status.childrenWithWaveLabels).toBe(0);
    expect(status.currentWaveComplete).toBe(false);
  });
});
