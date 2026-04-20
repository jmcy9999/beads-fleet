// =============================================================================
// Tests for src/lib/plan-review/integrity.ts — factory-core-k7gy.4
// =============================================================================
// Covers every F2 acceptance criterion plus the regression patterns flagged
// in the architecture: #2 (unguarded range / timeout), #7 (enum branching —
// orphan / stray / mislabel discriminator), #11 (concurrent queries), #13
// (fail-closed on any repo failure).
// =============================================================================

import { promises as fs, readFileSync } from "fs";
import * as os from "os";
import * as path from "path";

import {
  parsePlanManifest,
  runIntegritySweep,
  InvalidEpicIdError,
  InvalidPathError,
  MissingBeadSummaryError,
  INTEGRITY_SWEEP_TIMEOUT_MS,
} from "@/lib/plan-review/integrity";
import type { BeadsIssue } from "@/lib/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string | null = null;
const originalCwd = process.cwd();

async function writePlan(contents: string, filename = "plan.md"): Promise<string> {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "integrity-test-"));
  process.chdir(tempDir);
  const fullPath = path.join(tempDir, filename);
  await fs.writeFile(fullPath, contents, "utf-8");
  // Return the path relative to cwd so validatePlanPath accepts it.
  return filename;
}

afterEach(async () => {
  process.chdir(originalCwd);
  if (tempDir) {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
    tempDir = null;
  }
});

function makeIssue(
  id: string,
  labels: string[] = [],
  overrides: Partial<BeadsIssue> = {},
): BeadsIssue {
  return {
    id,
    title: `Issue ${id}`,
    status: "open",
    priority: 2,
    issue_type: "task",
    labels,
    created_at: "2026-04-20T00:00:00Z",
    updated_at: "2026-04-20T00:00:00Z",
    ...overrides,
  };
}

function canonicalPlan(beadRows: string[]): string {
  return [
    "# Sample Plan",
    "",
    "## Bead Summary",
    "",
    "| # | Bead ID | Title | Wave |",
    "|---|---------|-------|------|",
    ...beadRows,
    "",
    "## Next Section",
  ].join("\n");
}

// ===========================================================================
// parsePlanManifest
// ===========================================================================

describe("parsePlanManifest", () => {
  it("parses canonical planner-produced Bead Summary table", async () => {
    const planPath = await writePlan(
      canonicalPlan([
        "| 1 | factory-core-k7gy.1 | Reviewer | 1 |",
        "| 2 | factory-core-k7gy.3 | Flag | 1 |",
        "| 3 | factory-core-k7gy.9 | Orchestrator | 2 |",
      ]),
    );

    const entries = await parsePlanManifest(path.join(process.cwd(), planPath));
    expect(entries.map((e) => e.beadId)).toEqual([
      "factory-core-k7gy.1",
      "factory-core-k7gy.3",
      "factory-core-k7gy.9",
    ]);
    for (const entry of entries) {
      expect(entry.expectedRepo).toBe("factory-core");
    }
  });

  it("infers expectedRepo from the bead ID prefix for multiple repos", async () => {
    const planPath = await writePlan(
      canonicalPlan([
        "| 1 | factory-core-k7gy.1 | Reviewer | 1 |",
        "| 2 | lens-cycle-abc.2 | iOS | 1 |",
      ]),
    );

    const entries = await parsePlanManifest(path.join(process.cwd(), planPath));
    expect(entries.find((e) => e.beadId === "factory-core-k7gy.1")?.expectedRepo).toBe(
      "factory-core",
    );
    expect(entries.find((e) => e.beadId === "lens-cycle-abc.2")?.expectedRepo).toBe(
      "lens-cycle",
    );
  });

  it("throws MissingBeadSummaryError when no '## Bead Summary' heading exists", async () => {
    const planPath = await writePlan(
      ["# Sample Plan", "", "## Not Bead Summary", "| a | b |", "|---|---|", "| 1 | 2 |"].join(
        "\n",
      ),
    );
    await expect(
      parsePlanManifest(path.join(process.cwd(), planPath)),
    ).rejects.toBeInstanceOf(MissingBeadSummaryError);
  });

  it("tolerates extra columns to the right of the Bead ID column", async () => {
    const planPath = await writePlan(
      [
        "## Bead Summary",
        "",
        "| # | Bead ID | Title | Wave | Priority | Files |",
        "|---|---------|-------|------|----------|-------|",
        "| 1 | factory-core-k7gy.1 | Reviewer | 1 | P1 | reviewer.md |",
      ].join("\n"),
    );

    const entries = await parsePlanManifest(path.join(process.cwd(), planPath));
    expect(entries).toEqual([
      { beadId: "factory-core-k7gy.1", expectedRepo: "factory-core" },
    ]);
  });

  it("stops scanning when it hits the next '## heading'", async () => {
    const planPath = await writePlan(
      [
        "## Bead Summary",
        "| # | Bead ID |",
        "|---|---------|",
        "| 1 | factory-core-k7gy.1 |",
        "",
        "## Another Section",
        "| x | factory-core-k7gy.999 |", // must NOT be parsed
      ].join("\n"),
    );
    const entries = await parsePlanManifest(path.join(process.cwd(), planPath));
    expect(entries.map((e) => e.beadId)).toEqual(["factory-core-k7gy.1"]);
  });

  it("returns empty array when the table has zero bead rows", async () => {
    const planPath = await writePlan(canonicalPlan([]));
    const entries = await parsePlanManifest(path.join(process.cwd(), planPath));
    expect(entries).toEqual([]);
  });

  it("skips rows whose 'Bead ID' column doesn't match the canonical regex", async () => {
    const planPath = await writePlan(
      canonicalPlan([
        "| 1 | not-a-valid-id | Reviewer | 1 |",
        "| 2 | factory-core-k7gy.3 | Flag | 1 |",
      ]),
    );
    const entries = await parsePlanManifest(path.join(process.cwd(), planPath));
    expect(entries.map((e) => e.beadId)).toEqual(["factory-core-k7gy.3"]);
  });
});

// ===========================================================================
// runIntegritySweep — validation
// ===========================================================================

describe("runIntegritySweep — input validation", () => {
  it("throws InvalidEpicIdError for injection-shaped epicId", async () => {
    const planPath = await writePlan(canonicalPlan(["| 1 | factory-core-k7gy.1 | x | 1 |"]));
    await expect(
      runIntegritySweep("; rm -rf /", planPath, {
        listRegisteredRepos: async () => [],
        readIssuesFromRepo: async () => [],
      }),
    ).rejects.toBeInstanceOf(InvalidEpicIdError);
  });

  it("throws InvalidEpicIdError for uppercase epicId", async () => {
    await writePlan(canonicalPlan(["| 1 | factory-core-k7gy.1 | x | 1 |"]));
    await expect(
      runIntegritySweep("FACTORY-CORE-K7GY", "plan.md", {
        listRegisteredRepos: async () => [],
        readIssuesFromRepo: async () => [],
      }),
    ).rejects.toBeInstanceOf(InvalidEpicIdError);
  });

  it("accepts dotted epicId (nested)", async () => {
    const planPath = await writePlan(canonicalPlan([]));
    await expect(
      runIntegritySweep("foo-bar.3.7", planPath, {
        listRegisteredRepos: async () => [],
        readIssuesFromRepo: async () => [],
      }),
    ).resolves.toEqual({
      orphans: [],
      strays: [],
      mislabels: [],
      unavailable: [],
    });
  });

  it("throws InvalidPathError on path traversal in planManifestPath", async () => {
    await writePlan(canonicalPlan([]));
    await expect(
      runIntegritySweep("factory-core-k7gy", "../../etc/passwd", {
        listRegisteredRepos: async () => [],
        readIssuesFromRepo: async () => [],
      }),
    ).rejects.toBeInstanceOf(InvalidPathError);
  });

  it("throws InvalidPathError on absolute planManifestPath", async () => {
    await writePlan(canonicalPlan([]));
    await expect(
      runIntegritySweep("factory-core-k7gy", "/etc/passwd", {
        listRegisteredRepos: async () => [],
        readIssuesFromRepo: async () => [],
      }),
    ).rejects.toBeInstanceOf(InvalidPathError);
  });
});

// ===========================================================================
// runIntegritySweep — reconciliation
// ===========================================================================

describe("runIntegritySweep — reconciliation", () => {
  it("returns all-empty when every manifest bead is present with the expected label", async () => {
    const planPath = await writePlan(
      canonicalPlan([
        "| 1 | factory-core-k7gy.1 | a | 1 |",
        "| 2 | factory-core-k7gy.2 | b | 1 |",
        "| 3 | factory-core-k7gy.3 | c | 1 |",
      ]),
    );

    const result = await runIntegritySweep("factory-core-k7gy", planPath, {
      listRegisteredRepos: async () => [
        { name: "factory-core", path: "/tmp/factory-core" },
      ],
      readIssuesFromRepo: async () => [
        makeIssue("factory-core-k7gy.1", ["epic:factory-core-k7gy"]),
        makeIssue("factory-core-k7gy.2", ["epic:factory-core-k7gy"]),
        makeIssue("factory-core-k7gy.3", ["epic:factory-core-k7gy"]),
      ],
    });

    expect(result).toEqual({
      orphans: [],
      strays: [],
      mislabels: [],
      unavailable: [],
    });
  });

  it("flags an orphan when a manifest bead is missing from every repo", async () => {
    const planPath = await writePlan(
      canonicalPlan(["| 1 | factory-core-k7gy.1 | a | 1 |"]),
    );

    const result = await runIntegritySweep("factory-core-k7gy", planPath, {
      listRegisteredRepos: async () => [
        { name: "factory-core", path: "/tmp/factory-core" },
      ],
      readIssuesFromRepo: async () => [],
    });

    expect(result.orphans).toEqual([
      { beadId: "factory-core-k7gy.1", expectedRepo: "factory-core" },
    ]);
    expect(result.strays).toEqual([]);
    expect(result.mislabels).toEqual([]);
    expect(result.unavailable).toEqual([]);
  });

  it("flags a stray when a repo returns a bead tagged for the epic that the manifest does not list", async () => {
    const planPath = await writePlan(
      canonicalPlan(["| 1 | factory-core-k7gy.1 | a | 1 |"]),
    );

    const result = await runIntegritySweep("factory-core-k7gy", planPath, {
      listRegisteredRepos: async () => [
        { name: "factory-core", path: "/tmp/factory-core" },
      ],
      readIssuesFromRepo: async () => [
        makeIssue("factory-core-k7gy.1", ["epic:factory-core-k7gy"]),
        makeIssue("factory-core-k7gy.99", ["epic:factory-core-k7gy"]),
      ],
    });

    expect(result.orphans).toEqual([]);
    expect(result.strays).toEqual([
      {
        beadId: "factory-core-k7gy.99",
        actualRepo: "factory-core",
        actualLabel: "epic:factory-core-k7gy",
      },
    ]);
    expect(result.mislabels).toEqual([]);
  });

  it("flags a mislabel when a manifest bead has a different epic: label in the repo", async () => {
    const planPath = await writePlan(
      canonicalPlan(["| 1 | factory-core-k7gy.5 | e | 1 |"]),
    );

    const result = await runIntegritySweep("factory-core-k7gy", planPath, {
      listRegisteredRepos: async () => [
        { name: "factory-core", path: "/tmp/factory-core" },
      ],
      readIssuesFromRepo: async () => [
        makeIssue("factory-core-k7gy.5", ["epic:factory-core-other-epic"]),
      ],
    });

    expect(result.mislabels).toEqual([
      {
        beadId: "factory-core-k7gy.5",
        expectedRepo: "factory-core",
        actualRepo: "factory-core",
        expectedLabel: "epic:factory-core-k7gy",
        actualLabel: "epic:factory-core-other-epic",
      },
    ]);
    expect(result.orphans).toEqual([]);
    expect(result.strays).toEqual([]);
  });

  it("mislabel with no other epic: label reports actualLabel=(none)", async () => {
    const planPath = await writePlan(
      canonicalPlan(["| 1 | factory-core-k7gy.5 | e | 1 |"]),
    );

    const result = await runIntegritySweep("factory-core-k7gy", planPath, {
      listRegisteredRepos: async () => [
        { name: "factory-core", path: "/tmp/factory-core" },
      ],
      readIssuesFromRepo: async () => [
        // Present but no epic:* label at all.
        makeIssue("factory-core-k7gy.5", ["wave:1"]),
      ],
    });

    expect(result.mislabels[0].actualLabel).toBe("(none)");
  });

  it("handles a single-bead manifest that is present — all fields empty", async () => {
    const planPath = await writePlan(
      canonicalPlan(["| 1 | factory-core-k7gy.1 | a | 1 |"]),
    );
    const result = await runIntegritySweep("factory-core-k7gy", planPath, {
      listRegisteredRepos: async () => [
        { name: "factory-core", path: "/tmp/factory-core" },
      ],
      readIssuesFromRepo: async () =>
        [makeIssue("factory-core-k7gy.1", ["epic:factory-core-k7gy"])],
    });
    expect(result).toEqual({
      orphans: [],
      strays: [],
      mislabels: [],
      unavailable: [],
    });
  });

  it("handles a zero-bead manifest — strays if repos still return tagged beads", async () => {
    const planPath = await writePlan(canonicalPlan([]));
    const result = await runIntegritySweep("factory-core-k7gy", planPath, {
      listRegisteredRepos: async () => [
        { name: "factory-core", path: "/tmp/factory-core" },
      ],
      readIssuesFromRepo: async () => [
        makeIssue("factory-core-k7gy.1", ["epic:factory-core-k7gy"]),
      ],
    });
    expect(result.strays).toHaveLength(1);
    expect(result.orphans).toEqual([]);
  });
});

// ===========================================================================
// runIntegritySweep — fail-closed (regression #13)
// ===========================================================================

describe("runIntegritySweep — fail-closed on repo failure (#13)", () => {
  it("records the failing repo in unavailable and empties the other three fields", async () => {
    const planPath = await writePlan(
      canonicalPlan(["| 1 | factory-core-k7gy.1 | a | 1 |"]),
    );

    const result = await runIntegritySweep("factory-core-k7gy", planPath, {
      listRegisteredRepos: async () => [
        { name: "factory-core", path: "/tmp/factory-core" },
        { name: "beads", path: "/tmp/beads" },
      ],
      readIssuesFromRepo: async (repoPath: string) => {
        if (repoPath.includes("beads")) {
          throw new Error("ECONNREFUSED");
        }
        return [
          // factory-core returns a stray, which MUST be suppressed because
          // one repo is unavailable (ADR-006).
          makeIssue("factory-core-k7gy.1", ["epic:factory-core-k7gy"]),
          makeIssue("factory-core-k7gy.99", ["epic:factory-core-k7gy"]),
        ];
      },
    });

    expect(result.unavailable).toEqual(["beads"]);
    expect(result.orphans).toEqual([]);
    expect(result.strays).toEqual([]);
    expect(result.mislabels).toEqual([]);
  });

  it("records every repo in unavailable when every repo fails", async () => {
    const planPath = await writePlan(
      canonicalPlan(["| 1 | factory-core-k7gy.1 | a | 1 |"]),
    );

    const result = await runIntegritySweep("factory-core-k7gy", planPath, {
      listRegisteredRepos: async () => [
        { name: "factory-core", path: "/tmp/factory-core" },
        { name: "beads", path: "/tmp/beads" },
      ],
      readIssuesFromRepo: async () => {
        throw new Error("boom");
      },
    });

    expect(result.unavailable.sort()).toEqual(["beads", "factory-core"].sort());
    expect(result.orphans).toEqual([]);
  });
});

// ===========================================================================
// runIntegritySweep — concurrency + timeout (#11 + #2)
// ===========================================================================

describe("runIntegritySweep — concurrency + timeout", () => {
  it("queries all repos in parallel (#11)", async () => {
    const planPath = await writePlan(canonicalPlan([]));

    const delays = { a: 80, b: 80, c: 80 };
    const start = Date.now();

    const result = await runIntegritySweep("factory-core-k7gy", planPath, {
      listRegisteredRepos: async () => [
        { name: "a", path: "/tmp/a" },
        { name: "b", path: "/tmp/b" },
        { name: "c", path: "/tmp/c" },
      ],
      readIssuesFromRepo: async (repoPath: string) => {
        const key = path.basename(repoPath) as keyof typeof delays;
        await new Promise((r) => setTimeout(r, delays[key] ?? 0));
        return [];
      },
    });

    const elapsed = Date.now() - start;
    // Three 80ms calls in parallel should finish well under 240ms (sequential).
    expect(elapsed).toBeLessThan(200);
    expect(result.unavailable).toEqual([]);
  });

  it("times out a slow repo, marking it unavailable (#2)", async () => {
    const planPath = await writePlan(canonicalPlan([]));

    const result = await runIntegritySweep("factory-core-k7gy", planPath, {
      listRegisteredRepos: async () => [
        { name: "fast", path: "/tmp/fast" },
        { name: "slow", path: "/tmp/slow" },
      ],
      readIssuesFromRepo: async (repoPath: string) => {
        if (path.basename(repoPath) === "slow") {
          await new Promise((r) => setTimeout(r, 500));
        }
        return [];
      },
      timeoutMs: 50, // force the slow repo to trip the cap
    });

    expect(result.unavailable).toEqual(["slow"]);
  });

  it("exposes the default 60s cap constant so k7gy.8 can reuse it", () => {
    expect(INTEGRITY_SWEEP_TIMEOUT_MS).toBe(60_000);
  });
});

// ===========================================================================
// No direct dolt-reader modifications (internal guardrail)
// ===========================================================================

describe("does not modify dolt-reader.ts (internal guardrail)", () => {
  it("integrity.ts imports readIssuesFromDolt rather than re-implementing it", () => {
    const source = readFileSync(
      path.join(__dirname, "..", "..", "..", "src", "lib", "plan-review", "integrity.ts"),
      "utf-8",
    );
    expect(source).toMatch(/from\s+["']@\/lib\/dolt-reader["']/);
    expect(source).toMatch(/readIssuesFromDolt/);
  });
});
