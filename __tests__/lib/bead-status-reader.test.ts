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
//
// Mock pattern: jest.mock("child_process", { execSync }) per the precedent
// at __tests__/lib/agent-launcher-marker-cleanup.test.ts.
// =============================================================================

import * as fs from "fs";
import * as path from "path";

jest.mock("child_process", () => {
  const actual = jest.requireActual("child_process");
  return {
    ...actual,
    execSync: jest.fn(),
  };
});

import { execSync } from "child_process";
import { readBeadStatus, type BeadSnapshot } from "../../src/lib/bead-status-reader";

const mockedExecSync = execSync as jest.MockedFunction<typeof execSync>;

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

describe("bead-status-reader (beads_web-ehp.1)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ---- AC: Happy path with real fixture (open task with wave:5) ----
  test("happy path — real bd fixture parses to fully-populated BeadSnapshot", async () => {
    mockedExecSync.mockReturnValue(OPEN_TASK_FIXTURE as never);

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
    mockedExecSync.mockReturnValue(CLOSED_TASK_FIXTURE as never);

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
    mockedExecSync.mockReturnValue(DEFERRED_FIXTURE as never);

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
    mockedExecSync.mockReturnValue(fakeBdShow({ status }) as never);
    const snap = await readBeadStatus("fake-test-bead", "/fake/repo");
    expect(snap?.status).toBe(status);
  });

  // ---- Failure mode: binary missing / spawn failure ----
  test("failure — execSync throws (binary missing) → returns null", async () => {
    mockedExecSync.mockImplementation(() => {
      const err = new Error("spawn bd ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });

    const snap = await readBeadStatus("any-id", "/fake/repo");

    expect(snap).toBeNull();
  });

  // ---- Failure mode: non-zero exit ----
  test("failure — execSync throws on non-zero exit → returns null", async () => {
    mockedExecSync.mockImplementation(() => {
      const err = new Error("Command failed: bd show foo --json") as NodeJS.ErrnoException;
      (err as NodeJS.ErrnoException & { status?: number }).status = 1;
      throw err;
    });

    const snap = await readBeadStatus("missing-bead", "/fake/repo");

    expect(snap).toBeNull();
  });

  // ---- Failure mode: malformed JSON ----
  test("failure — malformed JSON output → returns null", async () => {
    mockedExecSync.mockReturnValue("{not valid json[" as never);

    const snap = await readBeadStatus("any-id", "/fake/repo");

    expect(snap).toBeNull();
  });

  // ---- Failure mode: empty stdout ----
  test("failure — empty string output → returns null (JSON.parse throws)", async () => {
    mockedExecSync.mockReturnValue("" as never);

    const snap = await readBeadStatus("any-id", "/fake/repo");

    expect(snap).toBeNull();
  });

  // ---- Failure mode: empty array (bd returned no bead) ----
  test("failure — empty array output → returns null (no bead in payload)", async () => {
    mockedExecSync.mockReturnValue("[]" as never);

    const snap = await readBeadStatus("missing-bead", "/fake/repo");

    expect(snap).toBeNull();
  });

  // ---- Failure mode: partial output (missing required fields) ----
  test("failure — payload missing 'status' field → returns null", async () => {
    mockedExecSync.mockReturnValue(
      JSON.stringify([{ id: "x", labels: [], issue_type: "task" }]) as never,
    );

    const snap = await readBeadStatus("x", "/fake/repo");

    expect(snap).toBeNull();
  });

  test("failure — payload missing 'id' field → returns null", async () => {
    mockedExecSync.mockReturnValue(
      JSON.stringify([{ status: "open", labels: [], issue_type: "task" }]) as never,
    );

    const snap = await readBeadStatus("x", "/fake/repo");

    expect(snap).toBeNull();
  });

  // ---- Failure mode: unknown status enum value ----
  test("failure — unknown status value → returns null (schema mismatch)", async () => {
    mockedExecSync.mockReturnValue(
      fakeBdShow({ status: "frobnicated" }) as never,
    );

    const snap = await readBeadStatus("x", "/fake/repo");

    expect(snap).toBeNull();
  });

  // ---- Schema-tolerance: missing labels array → empty array, not null ----
  test("schema-tolerance — missing labels field → empty labels array", async () => {
    const noLabelsPayload = JSON.stringify([
      { id: "x", status: "open", issue_type: "task" },
    ]);
    mockedExecSync.mockReturnValue(noLabelsPayload as never);

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
    mockedExecSync.mockReturnValue(
      fakeBdShow({ labels: ["pipeline:development", "ship-type:internal"] }) as never,
    );

    const snap = (await readBeadStatus("x", "/fake/repo")) as BeadSnapshot;

    expect(snap.pipelineStage).toBe("development");
  });

  // ---- Derived: hasAgentRunning ----
  test("derived — agent:running label → hasAgentRunning=true", async () => {
    mockedExecSync.mockReturnValue(
      fakeBdShow({ labels: ["agent:running", "wave:2"] }) as never,
    );

    const snap = (await readBeadStatus("x", "/fake/repo")) as BeadSnapshot;

    expect(snap.hasAgentRunning).toBe(true);
  });

  // ---- Derived: hasReviewNeedsHuman ----
  test("derived — review:needs-human label → hasReviewNeedsHuman=true", async () => {
    mockedExecSync.mockReturnValue(
      fakeBdShow({ labels: ["review:needs-human"] }) as never,
    );

    const snap = (await readBeadStatus("x", "/fake/repo")) as BeadSnapshot;

    expect(snap.hasReviewNeedsHuman).toBe(true);
  });

  // ---- Derived: currentQaRound = max across qa:round-N labels ----
  test("derived — qa:round-N labels → currentQaRound is max N", async () => {
    mockedExecSync.mockReturnValue(
      fakeBdShow({
        labels: ["qa:round-2", "qa:round-5", "qa:round-3", "ship-type:internal"],
      }) as never,
    );

    const snap = (await readBeadStatus("x", "/fake/repo")) as BeadSnapshot;

    expect(snap.currentQaRound).toBe(5);
  });

  // ---- Derived: currentWave = lowest N across wave:N labels ----
  test("derived — wave:N labels → currentWave is lowest N", async () => {
    mockedExecSync.mockReturnValue(
      fakeBdShow({ labels: ["wave:7", "wave:3", "wave:5"] }) as never,
    );

    const snap = (await readBeadStatus("x", "/fake/repo")) as BeadSnapshot;

    expect(snap.currentWave).toBe(3);
  });

  // ---- Derived: all derived fields together (rich label set) ----
  test("derived — rich label set populates all derived fields together", async () => {
    mockedExecSync.mockReturnValue(
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
      }) as never,
    );

    const snap = (await readBeadStatus("x", "/fake/repo")) as BeadSnapshot;

    expect(snap.status).toBe("in_progress");
    expect(snap.pipelineStage).toBe("qa");
    expect(snap.hasAgentRunning).toBe(true);
    expect(snap.hasReviewNeedsHuman).toBe(true);
    expect(snap.currentQaRound).toBe(4);
    expect(snap.currentWave).toBe(2);
  });

  // ---- spawn shape contract: cwd, env, timeout passed correctly ----
  test("spawn shape — execSync called with bd show, cwd, env, timeout", async () => {
    mockedExecSync.mockReturnValue(OPEN_TASK_FIXTURE as never);

    await readBeadStatus("factory-core-a4tx.32f", "/fake/repo/path");

    expect(mockedExecSync).toHaveBeenCalledTimes(1);
    const [cmd, opts] = mockedExecSync.mock.calls[0];
    expect(cmd).toMatch(/show factory-core-a4tx\.32f --json$/);
    expect(opts).toMatchObject({
      cwd: "/fake/repo/path",
      encoding: "utf-8",
    });
    expect((opts as { timeout?: number }).timeout).toBeGreaterThan(0);
  });
});
