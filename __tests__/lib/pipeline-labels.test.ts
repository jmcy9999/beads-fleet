// =============================================================================
// Tests for src/lib/pipeline-labels.ts
// =============================================================================
// Unit tests at the `execFile` level -- verifies the real error-path logic
// without the fleet-action route-level module mock. This is the regression
// test for factory-core-509.9 (QA round 1):
//
//   "Add a test that exercises the real error path: mock `execFile` (not
//    `removeLabelsFromEpic`) to reject with a non-benign error and assert
//    the handler returns 500 with an error toast message."
//
// The strict helper `removeLabelsFromEpicStrict` must:
//   - Throw on non-benign bd CLI errors (connection refused, timeout, etc.)
//   - Swallow benign "not found" / "does not have" errors (idempotency)
//
// The lenient helper `removeLabelsFromEpic` must continue to swallow all
// errors (documented existing behaviour for pipeline transitions).
// =============================================================================

// execFile is promisified in pipeline-labels.ts, so we mock the callback-style
// child_process.execFile and let promisify wrap it.
const mockExecFile = jest.fn();

jest.mock("child_process", () => ({
  execFile: (
    cmd: string,
    args: string[],
    opts: unknown,
    cb: (err: Error | null, stdout: string, stderr: string) => void,
  ) => mockExecFile(cmd, args, opts, cb),
}));

// repo-config.findRepoForIssue is called to resolve the repo path. Short-
// circuit it to avoid filesystem / Dolt access in the unit test.
jest.mock("@/lib/repo-config", () => ({
  findRepoForIssue: jest.fn().mockResolvedValue("/tmp/fake-repo"),
}));

// bd-path.getBdPath must return a deterministic path in the test environment.
jest.mock("@/lib/bd-path", () => ({
  getBdPath: () => "/usr/bin/bd",
  getBdEnv: () => ({ NO_COLOR: "1" }),
}));

// factory-core-wlsr.19: closeEpic now emits a bead-status-changed event
// after bd close succeeds. Mock event-log to (a) keep the unit test
// hermetic (no real fs writes) and (b) let us assert the call shape.
const mockAppendEvent = jest.fn();
jest.mock("@/lib/event-log", () => ({
  appendEvent: (
    repoPath: string,
    event: { type: string; epicId: string; payload?: Record<string, unknown> },
  ) => mockAppendEvent(repoPath, event),
}));

import {
  closeEpic,
  removeLabelsFromEpic,
  removeLabelsFromEpicStrict,
} from "@/lib/pipeline-labels";

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Configure the mocked execFile to resolve successfully (label removed).
 */
function execFileSucceeds(): void {
  mockExecFile.mockImplementation(
    (_cmd, _args, _opts, cb) => cb(null, "", ""),
  );
}

/**
 * Configure the mocked execFile to reject with the given error message.
 * Simulates a bd CLI failure (connection refused, timeout, etc.).
 */
function execFileFailsWith(message: string): void {
  mockExecFile.mockImplementation((_cmd, _args, _opts, cb) =>
    cb(new Error(message), "", message),
  );
}

// ---------------------------------------------------------------------------
// removeLabelsFromEpicStrict (factory-core-509.9)
// ---------------------------------------------------------------------------

describe("removeLabelsFromEpicStrict", () => {
  it("invokes `bd label remove` with the issue id and label", async () => {
    execFileSucceeds();

    await removeLabelsFromEpicStrict("epic-1", ["checkpoint:human-verify"]);

    expect(mockExecFile).toHaveBeenCalledTimes(1);
    const [cmd, args] = mockExecFile.mock.calls[0];
    expect(cmd).toBe("/usr/bin/bd");
    expect(args).toEqual([
      "label",
      "remove",
      "epic-1",
      "checkpoint:human-verify",
    ]);
  });

  it("resolves cleanly when bd succeeds", async () => {
    execFileSucceeds();

    await expect(
      removeLabelsFromEpicStrict("epic-1", ["qa:needs-review"]),
    ).resolves.toBeUndefined();
  });

  it("is a no-op when the label list is empty (does not call bd)", async () => {
    await removeLabelsFromEpicStrict("epic-1", []);

    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("swallows 'not found' errors as benign idempotency", async () => {
    execFileFailsWith("bd: label 'checkpoint:decision' not found on epic-1");

    await expect(
      removeLabelsFromEpicStrict("epic-1", ["checkpoint:decision"]),
    ).resolves.toBeUndefined();
  });

  it("swallows 'does not have' errors as benign idempotency", async () => {
    execFileFailsWith(
      "bd: issue epic-1 does not have label 'checkpoint:human-action'",
    );

    await expect(
      removeLabelsFromEpicStrict("epic-1", ["checkpoint:human-action"]),
    ).resolves.toBeUndefined();
  });

  it("RE-THROWS connection refused errors (regression: factory-core-509.9)", async () => {
    execFileFailsWith("connect ECONNREFUSED 127.0.0.1:3306");

    await expect(
      removeLabelsFromEpicStrict("epic-1", ["checkpoint:human-verify"]),
    ).rejects.toThrow(/checkpoint:human-verify.*epic-1.*ECONNREFUSED/);
  });

  it("RE-THROWS timeout errors (regression: factory-core-509.9)", async () => {
    execFileFailsWith("Command failed: timed out after 15000ms");

    await expect(
      removeLabelsFromEpicStrict("epic-1", ["qa:needs-review"]),
    ).rejects.toThrow(/qa:needs-review.*epic-1.*timed out/);
  });

  it("RE-THROWS permission errors (regression: factory-core-509.9)", async () => {
    execFileFailsWith("bd: permission denied writing to Dolt");

    await expect(
      removeLabelsFromEpicStrict("epic-1", ["checkpoint:decision"]),
    ).rejects.toThrow(/permission denied/);
  });

  it("stops on the first non-benign failure (does not silently continue)", async () => {
    // First label fails with a real error, second label would succeed -- but
    // the strict helper must throw on the first failure so the caller can
    // surface the error. (The loop aborts on throw.)
    let callCount = 0;
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
      callCount++;
      if (callCount === 1) {
        cb(new Error("bd: connection refused"), "", "bd: connection refused");
      } else {
        cb(null, "", "");
      }
    });

    await expect(
      removeLabelsFromEpicStrict("epic-1", ["label-a", "label-b"]),
    ).rejects.toThrow(/label-a.*connection refused/);
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it("continues past a benign idempotency error to process remaining labels", async () => {
    // If the first label is already absent, the strict helper must still
    // attempt the second label -- idempotency is not a real failure.
    let callCount = 0;
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
      callCount++;
      if (callCount === 1) {
        cb(new Error("label 'label-a' not found"), "", "");
      } else {
        cb(null, "", "");
      }
    });

    await expect(
      removeLabelsFromEpicStrict("epic-1", ["label-a", "label-b"]),
    ).resolves.toBeUndefined();
    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// removeLabelsFromEpic (lenient variant -- existing behaviour preserved)
// ---------------------------------------------------------------------------

describe("removeLabelsFromEpic (lenient)", () => {
  it("swallows non-benign bd errors (preserves documented pipeline-transition behaviour)", async () => {
    execFileFailsWith("connect ECONNREFUSED 127.0.0.1:3306");

    // The lenient variant MUST NOT throw. Pipeline transitions rely on
    // this to tolerate transient bd hiccups without aborting long chains.
    await expect(
      removeLabelsFromEpic("epic-1", ["pipeline:development"]),
    ).resolves.toBeUndefined();
  });

  it("also swallows benign idempotency errors", async () => {
    execFileFailsWith("label 'pipeline:qa' not found on epic-1");

    await expect(
      removeLabelsFromEpic("epic-1", ["pipeline:qa"]),
    ).resolves.toBeUndefined();
  });

  it("resolves cleanly on bd success", async () => {
    execFileSucceeds();

    await expect(
      removeLabelsFromEpic("epic-1", ["pipeline:research"]),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// closeEpic — bd close + bead-status-changed event emission
// (factory-core-wlsr.19 AC#4)
// ---------------------------------------------------------------------------

describe("closeEpic", () => {
  it("invokes `bd close <id> --reason <reason>` against the resolved repo", async () => {
    execFileSucceeds();

    await closeEpic("epic-1", "all done", "/repo/foo");

    expect(mockExecFile).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = mockExecFile.mock.calls[0];
    expect(cmd).toBe("/usr/bin/bd");
    expect(args).toEqual(["close", "epic-1", "--reason", "all done"]);
    expect(opts).toMatchObject({ cwd: "/repo/foo" });
  });

  it("emits bead-status-changed event AFTER bd close succeeds (AC#4)", async () => {
    execFileSucceeds();

    await closeEpic("epic-1", "all done", "/repo/foo");

    // Event must fire exactly once with the closeEpic-emitted shape.
    // Per coherence-outcome-classifier.ts § 'Closure event':
    //   { type: "bead-status-changed",
    //     epicId: <issueId>,
    //     payload: { beadId: <issueId>, newStatus: "closed" } }
    expect(mockAppendEvent).toHaveBeenCalledTimes(1);
    const [repoArg, eventArg] = mockAppendEvent.mock.calls[0];
    expect(repoArg).toBe("/repo/foo");
    expect(eventArg).toMatchObject({
      type: "bead-status-changed",
      epicId: "epic-1",
      payload: { beadId: "epic-1", newStatus: "closed" },
    });
  });

  it("emits the event AFTER bd close, not before (ordering is observable)", async () => {
    const callOrder: string[] = [];
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
      callOrder.push("bd-close");
      cb(null, "", "");
    });
    mockAppendEvent.mockImplementation(async () => {
      callOrder.push("append-event");
    });

    await closeEpic("epic-1", "x", "/repo/foo");

    expect(callOrder).toEqual(["bd-close", "append-event"]);
  });

  it("propagates bd close failure WITHOUT emitting the event (AC#4 ordering)", async () => {
    execFileFailsWith("connect ECONNREFUSED");

    await expect(closeEpic("epic-1", "x", "/repo/foo")).rejects.toThrow(
      /ECONNREFUSED/,
    );
    expect(mockAppendEvent).not.toHaveBeenCalled();
  });

  it("does NOT propagate event-log failures after a successful close (telemetry never breaks pipeline)", async () => {
    execFileSucceeds();
    mockAppendEvent.mockImplementationOnce(async () => {
      throw new Error("disk full");
    });
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(
        closeEpic("epic-1", "x", "/repo/foo"),
      ).resolves.toBeUndefined();
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });
});
