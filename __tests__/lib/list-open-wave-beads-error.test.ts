// =============================================================================
// Tests for listOpenWaveBeads error propagation (factory-core-z9h.9)
// =============================================================================
//
// QA found that when a per-child `bd show` (or the outer `bd list`) failed,
// listOpenWaveBeads silently skipped the failing bead — start-wave never
// launched a builder for it, and the auto-chain either (a) deadlocked the
// wave or (b) advanced the pipeline past QA with unclosed work.
//
// z9h.9 mirrors the getWaveStatus error contract (z9h.8 / z9h.10): on any
// bd failure, throw a typed error so start-wave returns 500 instead of
// falling through to the legacy wave-session branch with an empty bead
// set.
//
// Regression patterns covered:
//   #13 Silent Exception Swallowing — a bd failure must not masquerade as
//       a successful "this bead isn't in the wave" result.
//   #7  Type Confusion on Enum Branching — in-wave / not-in-wave / UNKNOWN
//       are three distinct states; a transient bd failure is UNKNOWN, not
//       not-in-wave.
// =============================================================================

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

// listOpenWaveBeads calls execFileSync (via execBdSync) to run `bd show <epic>`,
// `bd list --parent=<epic>` / `bd list --label=epic:<epic>`, and `bd show <child>`
// for each open child. We control each call per-test via the behaviour function
// so we can simulate (a) a failing list, (b) a failing per-child show, and (c)
// the happy path.

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

// Stub out bd-path so execBdSync doesn't try to locate a real bd binary.
jest.mock("@/lib/bd-path", () => ({
  getBdPath: () => "/usr/local/bin/bd",
  getBdEnv: () => ({ PATH: "/usr/local/bin" }),
}));

// Stub out langfuse-env (pulled in transitively by agent-launcher).
jest.mock("@/lib/langfuse-env", () => ({
  buildOtelEnv: () => ({}),
  buildLangfuseTraceUrl: () => null,
  isLangfuseConfigured: () => false,
}));

import { listOpenWaveBeads } from "@/lib/agent-launcher";

// Helpers --------------------------------------------------------------------

/** Simulate an epic-show result that marks the epic as internal ship-type. */
const INTERNAL_EPIC_SHOW = `
◐ factory-core-z9h · Epic [● P1 · IN_PROGRESS]
LABELS: ship-type:internal, release:1.0
`;

/**
 * Simulate the tree output bd emits for a successful
 * `bd list --parent=<epic>` — two open children.
 */
const TWO_OPEN_CHILDREN_TREE = `
◐ factory-core-z9h ● P1 [epic] Epic
├── ○ factory-core-z9h.aaa ● P1 task Open child A
└── ○ factory-core-z9h.bbb ● P1 task Open child B
`;

/** Three children: one closed (skipped entirely), two open. */
const THREE_CHILDREN_TREE = `
◐ factory-core-z9h ● P1 [epic] Epic
├── ○ factory-core-z9h.aaa ● P1 task Open child (will flake)
├── ○ factory-core-z9h.bbb ● P1 task Open child
└── ✓ factory-core-z9h.ccc ● P1 task Closed child
`;

const CHILD_AAA_SHOW = `
○ factory-core-z9h.aaa · Alpha title [OPEN]
LABELS: wave:1, ship-type:internal
Files:
- src/a.ts
`;

const CHILD_BBB_SHOW = `
○ factory-core-z9h.bbb · Beta title [OPEN]
LABELS: wave:1, ship-type:internal
Files:
- src/b.ts
`;

// ---------------------------------------------------------------------------

afterEach(() => {
  execBehaviour = () => ({ stdout: "" });
});

describe("listOpenWaveBeads — outer bd list failure (factory-core-z9h.9)", () => {
  it("throws when `bd list` fails so start-wave can return 500", async () => {
    // First call: bd show <epic> succeeds (needed for isInternal detection).
    // Second call: bd list --parent=<epic> fails.
    execBehaviour = (args) => {
      if (args[0] === "show") return { stdout: INTERNAL_EPIC_SHOW };
      if (args[0] === "list") return { error: new Error("bd: connection refused") };
      return { stdout: "" };
    };

    await expect(
      listOpenWaveBeads(
        "factory-core-z9h",
        1,
        "/Users/janemckay/dev/fleet/fleet-core",
      ),
    ).rejects.toThrow(/bd list failed/);
  });

  it("names the epic and filter args in the error so ops can diagnose which query failed", async () => {
    execBehaviour = (args) => {
      if (args[0] === "show") return { stdout: INTERNAL_EPIC_SHOW };
      if (args[0] === "list") return { error: new Error("bd: unreachable") };
      return { stdout: "" };
    };

    // Internal ship-type routes through the --parent filter (not --label).
    await expect(
      listOpenWaveBeads("some-epic", 1, "/tmp/fleet"),
    ).rejects.toThrow(/--parent=some-epic/);
  });
});

describe("listOpenWaveBeads — per-child bd show failure (factory-core-z9h.9)", () => {
  it("throws when a single child's `bd show` fails (silent-skip regression)", async () => {
    // Scenario that previously produced the silent deadlock:
    //   - bd list succeeds and reports two open wave:1 children (aaa, bbb).
    //   - bd show aaa flakes (transient failure).
    // Before the fix, aaa was silently dropped from the returned list and
    // start-wave never launched a builder for it. Now listOpenWaveBeads
    // throws so start-wave returns 500 and the auto-chain registers the
    // failure instead of silently advancing.
    execBehaviour = (args) => {
      if (args[0] === "show") {
        if (args[1] === "factory-core-z9h") return { stdout: INTERNAL_EPIC_SHOW };
        if (args[1] === "factory-core-z9h.aaa") {
          return { error: new Error("bd: transient connection failure") };
        }
        if (args[1] === "factory-core-z9h.bbb") return { stdout: CHILD_BBB_SHOW };
      }
      if (args[0] === "list") return { stdout: TWO_OPEN_CHILDREN_TREE };
      return { stdout: "" };
    };

    await expect(
      listOpenWaveBeads(
        "factory-core-z9h",
        1,
        "/Users/janemckay/dev/fleet/fleet-core",
      ),
    ).rejects.toThrow(/bd show failed/);
  });

  it("names the failing child in the error so ops can retry that specific bead", async () => {
    // Distinct from the outer-list error (which names the failed filter).
    // Here the failing unit is a specific child ID, so it must appear in
    // the error message to be actionable.
    execBehaviour = (args) => {
      if (args[0] === "show") {
        if (args[1] === "factory-core-z9h") return { stdout: INTERNAL_EPIC_SHOW };
        if (args[1] === "factory-core-z9h.aaa") return { stdout: CHILD_AAA_SHOW };
        if (args[1] === "factory-core-z9h.bbb") {
          return { error: new Error("bd: unreachable") };
        }
      }
      if (args[0] === "list") return { stdout: TWO_OPEN_CHILDREN_TREE };
      return { stdout: "" };
    };

    await expect(
      listOpenWaveBeads(
        "factory-core-z9h",
        1,
        "/Users/janemckay/dev/fleet/fleet-core",
      ),
    ).rejects.toThrow(/factory-core-z9h\.bbb/);
  });

  it("throws on the first failing child — no partial wave list leaked through", async () => {
    // Even if later children would succeed, we abort on the first failure.
    // This avoids a half-populated list that a downstream caller could
    // confuse with "only these beads need builders".
    let laterShowCalled = false;
    execBehaviour = (args) => {
      if (args[0] === "show") {
        if (args[1] === "factory-core-z9h") return { stdout: INTERNAL_EPIC_SHOW };
        if (args[1] === "factory-core-z9h.aaa") {
          return { error: new Error("bd: flake") };
        }
        if (args[1] === "factory-core-z9h.bbb") {
          laterShowCalled = true;
          return { stdout: CHILD_BBB_SHOW };
        }
      }
      if (args[0] === "list") return { stdout: THREE_CHILDREN_TREE };
      return { stdout: "" };
    };

    await expect(
      listOpenWaveBeads(
        "factory-core-z9h",
        1,
        "/Users/janemckay/dev/fleet/fleet-core",
      ),
    ).rejects.toThrow();

    // Guards against partial enumeration: abort BEFORE querying later
    // children so no partial list can be returned.
    expect(laterShowCalled).toBe(false);
  });
});

describe("listOpenWaveBeads — happy path (factory-core-z9h.9)", () => {
  it("does NOT throw when everything succeeds and returns the expected wave beads", async () => {
    execBehaviour = (args) => {
      if (args[0] === "show") {
        if (args[1] === "factory-core-z9h") return { stdout: INTERNAL_EPIC_SHOW };
        if (args[1] === "factory-core-z9h.aaa") return { stdout: CHILD_AAA_SHOW };
        if (args[1] === "factory-core-z9h.bbb") return { stdout: CHILD_BBB_SHOW };
      }
      if (args[0] === "list") return { stdout: TWO_OPEN_CHILDREN_TREE };
      return { stdout: "" };
    };

    const beads = await listOpenWaveBeads(
      "factory-core-z9h",
      1,
      "/Users/janemckay/dev/fleet/fleet-core",
    );
    expect(beads.map((b) => b.id).sort()).toEqual([
      "factory-core-z9h.aaa",
      "factory-core-z9h.bbb",
    ]);
  });

  it("does NOT throw when `bd list` succeeds but returns zero children (legitimate empty epic)", async () => {
    // Distinguishes "unknown" (bd failed) from "no children" (bd succeeded,
    // returned nothing). The former must throw; the latter must return [].
    execBehaviour = (args) => {
      if (args[0] === "show") return { stdout: INTERNAL_EPIC_SHOW };
      if (args[0] === "list") return { stdout: "" };
      return { stdout: "" };
    };

    const beads = await listOpenWaveBeads(
      "factory-core-z9h",
      1,
      "/Users/janemckay/dev/fleet/fleet-core",
    );
    expect(beads).toEqual([]);
  });
});

// =============================================================================
// beads_web-alq (2026-05-09): union-filter recovery from filter divergence
// =============================================================================
//
// Empirical reproducer (factory-core-0pxw at C2 attempt-8 T7 23:19:26 BST):
// `bd list --status=all --parent=<id>` returned 0 children when the same
// filter run from the operator's CLI returned the wave-1 child. Same cwd,
// same bd binary, different process, different result. The rule path's
// review-wave dispatch refused with NO_WAVE_BEADS even though wave-1 beads
// existed; only coherence's explicit-waveNumber workaround unblocked it.
//
// Fix: enumerate via BOTH `--parent=<id>` AND `--label=epic:<id>` and union
// the results. Filter divergence is logged as a structured warning; either
// filter alone can satisfy the request.
// =============================================================================
describe("listOpenWaveBeads — alq union-filter divergence recovery", () => {
  it("returns the union when --parent= sees 0 but --label=epic: sees the child", async () => {
    execBehaviour = (args) => {
      if (args[0] === "show") {
        if (args[1] === "factory-core-z9h") return { stdout: INTERNAL_EPIC_SHOW };
        if (args[1] === "factory-core-z9h.aaa") return { stdout: CHILD_AAA_SHOW };
      }
      if (args[0] === "list") {
        // Parent filter returns 0 children (the alq divergence).
        if (args.some((a) => a.startsWith("--parent="))) {
          return { stdout: "" };
        }
        // Label filter returns the wave-1 child (the operator-CLI truth).
        if (args.includes("--label")) {
          return {
            stdout: "○ factory-core-z9h.aaa ● P1 task Open child A\n",
          };
        }
      }
      return { stdout: "" };
    };

    const beads = await listOpenWaveBeads(
      "factory-core-z9h",
      1,
      "/Users/janemckay/dev/fleet/fleet-core",
    );
    expect(beads.map((b) => b.id)).toEqual(["factory-core-z9h.aaa"]);
  });

  it("returns the union when --label= sees 0 but --parent=<id> sees the child", async () => {
    // Symmetric scenario: label table is stale, parent linkage is fresh.
    execBehaviour = (args) => {
      if (args[0] === "show") {
        if (args[1] === "factory-core-z9h") return { stdout: INTERNAL_EPIC_SHOW };
        if (args[1] === "factory-core-z9h.aaa") return { stdout: CHILD_AAA_SHOW };
      }
      if (args[0] === "list") {
        if (args.some((a) => a.startsWith("--parent="))) {
          return {
            stdout: "○ factory-core-z9h.aaa ● P1 task Open child A\n",
          };
        }
        if (args.includes("--label")) {
          return { stdout: "" };
        }
      }
      return { stdout: "" };
    };

    const beads = await listOpenWaveBeads(
      "factory-core-z9h",
      1,
      "/Users/janemckay/dev/fleet/fleet-core",
    );
    expect(beads.map((b) => b.id)).toEqual(["factory-core-z9h.aaa"]);
  });

  it("de-dups when both filters return the same child", async () => {
    execBehaviour = (args) => {
      if (args[0] === "show") {
        if (args[1] === "factory-core-z9h") return { stdout: INTERNAL_EPIC_SHOW };
        if (args[1] === "factory-core-z9h.aaa") return { stdout: CHILD_AAA_SHOW };
      }
      if (args[0] === "list") {
        // Both filters return the same child.
        return { stdout: "○ factory-core-z9h.aaa ● P1 task Open\n" };
      }
      return { stdout: "" };
    };

    const beads = await listOpenWaveBeads(
      "factory-core-z9h",
      1,
      "/Users/janemckay/dev/fleet/fleet-core",
    );
    expect(beads.map((b) => b.id)).toEqual(["factory-core-z9h.aaa"]);
  });

  it("throws when BOTH filters fail (z9h.9 contract preserved)", async () => {
    execBehaviour = (args) => {
      if (args[0] === "show") return { stdout: INTERNAL_EPIC_SHOW };
      if (args[0] === "list") return { error: new Error("bd: connection refused") };
      return { stdout: "" };
    };

    await expect(
      listOpenWaveBeads(
        "factory-core-z9h",
        1,
        "/Users/janemckay/dev/fleet/fleet-core",
      ),
    ).rejects.toThrow(/BOTH filters/);
  });
});
