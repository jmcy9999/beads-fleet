// =============================================================================
// Integration tests for src/lib/dispatch-preconditions.ts (beads_web-ehp.3)
// =============================================================================
//
// Verifies the load-bearing AC: "Integration test uses a real tmp bd repo
// (no library-internal mocks beyond the readers' published interfaces)."
//
// Strategy:
//   - In beforeAll, spawn a fresh dolt sql-server on a random high port,
//     init a tmp bd repo against it, and create three beads:
//       (1) ehp3it-open    — status=open
//       (2) ehp3it-deferred — status=deferred (the 372-bead-defer scenario)
//       (3) ehp3it-closed  — status=closed
//     Plus marker fixture files at <repo>/.beads/markers/ for the
//     operator-decision-pending Class C scenario.
//   - Each test invokes the REAL `buildDispatchContext` + REAL
//     `evaluatePreconditions` against the real bd repo. No mocks of the
//     reader interfaces (readBeadStatus, readMarker, getEpicLabels).
//   - In afterAll, kill the dolt sql-server and remove the tmp dir.
//
// Skip conditions:
//   - dolt binary not available on PATH → describe.skip with an explicit
//     log line. Local dev has dolt; CI environments without dolt skip
//     these tests gracefully.
//
// AC items covered:
//   - "Given a real tmp bd repo with one bead in `status=deferred` AND a
//     real `buildDispatchContext` invocation, When `evaluatePreconditions`
//     runs end-to-end, Then refusal is `BD_STATUS_DEFERRED` AND the
//     snapshot was actually fetched via the Wave-1 reader (no internal
//     mocks of the reader interface)."
//   - "Given the load-bearing 372-bead-defer scenario reproduced against
//     a real tmp bd repo with a deferred bead, When the integration test
//     runs end-to-end (real bd, real marker reader, real label reader),
//     Then BD_STATUS_DEFERRED fires AND BD_READ_FAILED is NOT fired."
//   - "Given Wave-1 `readBeadStatus` and existing `marker-reader.read
//     Marker` and `pipeline-labels.getEpicLabels`, When `buildDispatch
//     Context({ epicId, repoPath, action })` runs against a real tmp bd
//     repo, Then it composes a fully-populated `DispatchContext.bead`,
//     `marker`, and `epicLabels` AND scaffolded fields default cleanly."
// =============================================================================

import {
  spawn,
  spawnSync,
  type ChildProcess,
} from "child_process";
import { promises as fs, mkdtempSync, rmSync, existsSync } from "fs";
import * as os from "os";
import * as path from "path";

import {
  buildDispatchContext,
  evaluatePreconditions,
} from "../../src/lib/dispatch-preconditions";

// ---------------------------------------------------------------------------
// Skip-condition helpers
// ---------------------------------------------------------------------------

/** Locate the dolt binary; null if not available. */
function findDolt(): string | null {
  const candidates = ["/opt/homebrew/bin/dolt", "/usr/local/bin/dolt", "dolt"];
  for (const c of candidates) {
    if (c.startsWith("/")) {
      if (existsSync(c)) return c;
      continue;
    }
    const result = spawnSync("which", [c], { encoding: "utf-8" });
    if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  }
  return null;
}

/** Locate the bd binary; null if not available. */
function findBd(): string | null {
  if (existsSync("/opt/homebrew/bin/bd")) return "/opt/homebrew/bin/bd";
  const result = spawnSync("which", ["bd"], { encoding: "utf-8" });
  if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  return null;
}

const DOLT_BIN = findDolt();
const BD_BIN = findBd();

/** Pick a random high port to avoid colliding with running dolt servers. */
function pickPort(): number {
  return 40000 + Math.floor(Math.random() * 5000);
}

/** Sleep helper for server-startup wait. */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Wait for a process to listen on a port (poll lsof up to ~10s). */
async function waitForPort(port: number, timeoutMs = 10_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = spawnSync("lsof", ["-i", `:${port}`], { encoding: "utf-8" });
    if (result.status === 0 && result.stdout.includes(`:${port}`)) return true;
    await sleep(200);
  }
  return false;
}

// ---------------------------------------------------------------------------
// describe gate — skip cleanly if dolt or bd unavailable
// ---------------------------------------------------------------------------

const ENABLED = DOLT_BIN !== null && BD_BIN !== null;
const describeIfEnabled = ENABLED ? describe : describe.skip;
if (!ENABLED) {
  // eslint-disable-next-line no-console
  console.log(
    `[dispatch-preconditions.integration.test] SKIPPING — dolt=${DOLT_BIN ?? "MISSING"}, bd=${BD_BIN ?? "MISSING"}`,
  );
}

describeIfEnabled("dispatch-preconditions integration (real bd + dolt)", () => {
  let tmpRoot: string;
  let repoPath: string;
  let serverProcess: ChildProcess | null = null;
  let serverPort: number;
  let openBeadId: string;
  let deferredBeadId: string;
  let closedBeadId: string;
  // The bd binary path is non-null here per the describeIfEnabled gate.
  const BD = BD_BIN!;
  const DOLT = DOLT_BIN!;

  /** Run a bd subcommand against the test repo + server, return stdout. */
  function bdRun(args: string[], opts: { allowFailure?: boolean } = {}): string {
    const env = {
      ...process.env,
      BEADS_DOLT_SERVER_PORT: String(serverPort),
      BEADS_DOLT_SERVER_HOST: "127.0.0.1",
      NO_COLOR: "1",
    };
    const result = spawnSync(BD, args, {
      cwd: repoPath,
      encoding: "utf-8",
      env,
      timeout: 30_000,
    });
    if (result.status !== 0 && !opts.allowFailure) {
      throw new Error(
        `bd ${args.join(" ")} failed (exit=${result.status}): ${result.stderr || result.stdout}`,
      );
    }
    return result.stdout;
  }

  beforeAll(async () => {
    // ---- Allocate tmp dirs ------------------------------------------------
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), "ehp3-int-"));
    repoPath = path.join(tmpRoot, "repo");
    await fs.mkdir(repoPath, { recursive: true });

    // git init so bd doesn't complain about non-repo cwd.
    spawnSync("git", ["init", "-q"], { cwd: repoPath });
    spawnSync("git", ["config", "user.email", "test@test.local"], {
      cwd: repoPath,
    });
    spawnSync("git", ["config", "user.name", "test"], { cwd: repoPath });

    // ---- Start a fresh dolt sql-server on a random port -------------------
    serverPort = pickPort();
    const dataDir = path.join(tmpRoot, "dolt-data");
    await fs.mkdir(dataDir, { recursive: true });
    serverProcess = spawn(
      DOLT,
      ["sql-server", "-H", "127.0.0.1", "-P", String(serverPort)],
      {
        cwd: dataDir,
        stdio: "ignore",
        detached: false,
      },
    );

    const ready = await waitForPort(serverPort);
    if (!ready) {
      serverProcess?.kill();
      throw new Error(
        `dolt sql-server failed to bind port ${serverPort} within 10s`,
      );
    }

    // ---- Init bd against the fresh server ---------------------------------
    bdRun([
      "init",
      `--server-port=${serverPort}`,
      "--skip-agents",
      "--skip-hooks",
      "--prefix=ehp3it",
    ]);

    // ---- Create three beads ------------------------------------------------
    openBeadId = bdRun(["q", "Open test bead"]).trim();
    deferredBeadId = bdRun(["q", "Deferred test bead (372-bead-defer scenario)"]).trim();
    closedBeadId = bdRun(["q", "Closed test bead"]).trim();

    // ---- Set the lifecycle states ------------------------------------------
    bdRun(["update", deferredBeadId, "--status=deferred"]);
    bdRun(["update", closedBeadId, "--status=closed"]);

    // ---- Add labels for Class C epic-label test ----------------------------
    bdRun(["label", "add", openBeadId, "pipeline:development"]);

    // ---- Marker fixture for OPERATOR_DECISION_PENDING test -----------------
    const markerDir = path.join(repoPath, ".beads", "markers");
    await fs.mkdir(markerDir, { recursive: true });
    await fs.writeFile(
      path.join(markerDir, `${openBeadId}.json`),
      JSON.stringify(
        {
          version: "1",
          bead_id: openBeadId,
          status: "needs-decision",
          stage: "architect",
          started_at: "2026-05-06T00:00:00Z",
          exited_at: "2026-05-06T00:01:00Z",
          next_agent: "operator",
          blocker_class: "spec-ambiguity",
          what_was_done: "test fixture for OPERATOR_DECISION_PENDING precondition",
        },
        null,
        2,
      ),
    );
  }, 60_000); // 60s timeout for setup

  afterAll(async () => {
    // ---- Kill the dolt sql-server ------------------------------------------
    if (serverProcess && !serverProcess.killed) {
      serverProcess.kill("SIGTERM");
      // Give it a moment to clean up.
      await sleep(500);
      if (!serverProcess.killed) serverProcess.kill("SIGKILL");
    }
    // ---- Remove tmp dirs ---------------------------------------------------
    if (tmpRoot && existsSync(tmpRoot)) {
      try {
        rmSync(tmpRoot, { recursive: true, force: true });
      } catch {
        // Tolerate cleanup errors — tmp will be reaped eventually.
      }
    }
  }, 15_000);

  // ---------------------------------------------------------------------------
  // Load-bearing AC: real deferred bead → BD_STATUS_DEFERRED end-to-end
  // ---------------------------------------------------------------------------

  test("LOAD-BEARING — real deferred bead refuses with BD_STATUS_DEFERRED (372-bead defer scenario)", async () => {
    const ctx = await buildDispatchContext({
      epicId: deferredBeadId,
      repoPath,
      action: "run-architect",
    });

    // The snapshot was actually fetched via the Wave-1 reader. Verify
    // it's populated (NOT null) and reflects the real deferred state.
    expect(ctx.bead).not.toBeNull();
    expect(ctx.bead?.id).toBe(deferredBeadId);
    expect(ctx.bead?.status).toBe("deferred");

    const result = evaluatePreconditions(ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusalCode).toBe("BD_STATUS_DEFERRED");
      expect(result.failedCheck).toBe("bd-status-not-deferred");
      // BD_READ_FAILED must NOT have fired — this is the architecture-
      // level "two refusal codes are distinct" invariant.
      expect(result.refusalCode).not.toBe("BD_READ_FAILED");
    }
  }, 30_000);

  // ---------------------------------------------------------------------------
  // Real closed bead → BD_STATUS_CLOSED
  // ---------------------------------------------------------------------------

  test("real closed bead refuses with BD_STATUS_CLOSED", async () => {
    const ctx = await buildDispatchContext({
      epicId: closedBeadId,
      repoPath,
      action: "send-for-qa",
    });
    expect(ctx.bead?.status).toBe("closed");
    const result = evaluatePreconditions(ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusalCode).toBe("BD_STATUS_CLOSED");
  }, 30_000);

  // ---------------------------------------------------------------------------
  // Real open bead with no marker, no Class-C labels → ok=true
  // ---------------------------------------------------------------------------

  test("real open bead with no marker and no human-decision label → ok=true", async () => {
    // The open bead DOES have a marker fixture (for the operator-pending
    // test below). Use a brand-new bead created on the fly with no
    // marker for this test.
    const cleanBeadId = bdRun(["q", "Clean open bead with no marker"]).trim();

    const ctx = await buildDispatchContext({
      epicId: cleanBeadId,
      repoPath,
      action: "run-architect",
    });
    expect(ctx.bead?.status).toBe("open");
    expect(ctx.marker).toBeNull(); // no marker file written for cleanBeadId
    expect(evaluatePreconditions(ctx)).toEqual({ ok: true });
  }, 30_000);

  // ---------------------------------------------------------------------------
  // Real open bead + real marker file with operator/spec-ambiguity →
  // OPERATOR_DECISION_PENDING (Class C, AND-gate satisfied)
  // ---------------------------------------------------------------------------

  test("real marker file with next_agent=operator + blocker_class=spec-ambiguity → OPERATOR_DECISION_PENDING", async () => {
    const ctx = await buildDispatchContext({
      epicId: openBeadId,
      repoPath,
      action: "run-architect",
    });
    expect(ctx.bead?.status).toBe("open");
    expect(ctx.marker).not.toBeNull();
    expect(ctx.marker?.next_agent).toBe("operator");
    expect(ctx.marker?.blocker_class).toBe("spec-ambiguity");

    const result = evaluatePreconditions(ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusalCode).toBe("OPERATOR_DECISION_PENDING");
      expect(result.failedCheck).toBe("operator-decision-not-pending");
    }
  }, 30_000);

  // ---------------------------------------------------------------------------
  // Real epic labels including human-decision:required → REVIEW_NEEDS_HUMAN
  // ---------------------------------------------------------------------------

  test("real epic labels include 'human-decision:required' → REVIEW_NEEDS_HUMAN", async () => {
    // Add the gate label to a fresh open bead so we don't pollute the
    // marker test above.
    const labelBeadId = bdRun(["q", "Bead with human-decision:required label"]).trim();
    bdRun(["label", "add", labelBeadId, "human-decision:required"]);

    const ctx = await buildDispatchContext({
      epicId: labelBeadId,
      repoPath,
      action: "run-architect",
    });
    expect(ctx.bead?.status).toBe("open");
    expect(ctx.epicLabels).toContain("human-decision:required");

    const result = evaluatePreconditions(ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusalCode).toBe("REVIEW_NEEDS_HUMAN");
      expect(result.failedCheck).toBe("review-needs-human-not-set");
    }
  }, 30_000);

  // ---------------------------------------------------------------------------
  // bd-read failure (point at a non-existent bead-id) → BD_READ_FAILED
  // ---------------------------------------------------------------------------

  test("bd-read failure (non-existent bead-id) → BD_READ_FAILED via fail-closed posture", async () => {
    const ctx = await buildDispatchContext({
      epicId: "ehp3it-does-not-exist-99999",
      repoPath,
      action: "run-architect",
    });
    // The reader returns null for unknown beads (matches the spec).
    expect(ctx.bead).toBeNull();

    const result = evaluatePreconditions(ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusalCode).toBe("BD_READ_FAILED");
      expect(result.failedCheck).toBe("bd-read-succeeded");
    }
  }, 30_000);

  // ---------------------------------------------------------------------------
  // SCAFFOLDED-fields default contract (Wave-2 invariant)
  // ---------------------------------------------------------------------------

  test("SCAFFOLDED fields default cleanly even with real reader output", async () => {
    const ctx = await buildDispatchContext({
      epicId: openBeadId,
      repoPath,
      action: "run-architect",
    });
    expect(ctx.planFileExists).toBe(false);
    expect(ctx.openWaveBeadIds).toEqual([]);
    expect(ctx.stageEnteredAt).toBeNull();
  }, 30_000);

  // ---------------------------------------------------------------------------
  // Distinct refusal codes invariant: BD_STATUS_DEFERRED vs BD_READ_FAILED
  // ---------------------------------------------------------------------------

  test("distinct codes — deferred bead refuses with BD_STATUS_DEFERRED, NOT BD_READ_FAILED", async () => {
    // Architecture commentary on Seam 1: BD_READ_FAILED (null snapshot)
    // and BD_STATUS_DEFERRED (non-null snapshot with status='deferred')
    // are distinct codes. This test exercises both paths separately.
    const deferredCtx = await buildDispatchContext({
      epicId: deferredBeadId,
      repoPath,
      action: "run-architect",
    });
    expect(deferredCtx.bead).not.toBeNull();
    expect(deferredCtx.bead?.status).toBe("deferred");
    const r1 = evaluatePreconditions(deferredCtx);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.refusalCode).toBe("BD_STATUS_DEFERRED");

    const failCtx = await buildDispatchContext({
      epicId: "ehp3it-truly-missing",
      repoPath,
      action: "run-architect",
    });
    expect(failCtx.bead).toBeNull();
    const r2 = evaluatePreconditions(failCtx);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.refusalCode).toBe("BD_READ_FAILED");
  }, 30_000);
});
