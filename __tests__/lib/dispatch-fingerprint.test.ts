// =============================================================================
// Tests for src/lib/dispatch-fingerprint.ts (factory-core-9l7q.1)
// =============================================================================
// Covers the pure-function parts of the dispatch guard. The expensive parts
// (git / bd / fs for the findings doc) are mocked through child_process and fs.
// =============================================================================

import { promises as fs } from "fs";
import os from "os";
import path from "path";

// Mock child_process.exec for git and bd calls
jest.mock("child_process", () => ({
  exec: jest.fn(),
}));

import { exec } from "child_process";

import {
  computeFingerprint,
  checkFingerprint,
  recordFingerprint,
  clearFingerprint,
  shortHash,
} from "@/lib/dispatch-fingerprint";

const FINGERPRINT_FILE = path.join(
  os.tmpdir(),
  "beads-web-dispatch-fingerprints.json",
);

async function resetStore() {
  try {
    await fs.unlink(FINGERPRINT_FILE);
  } catch {
    /* not present */
  }
}

// Returns a mock function configured to behave like promisified exec: the
// callback signature is (err, {stdout, stderr}). jest.fn() with mockImplementation
// handles this shape — but promisify needs the original 3-arg signature.
function mockExecScenario(replies: Record<string, string>) {
  (exec as unknown as jest.Mock).mockImplementation(
    (cmd: string, _opts: unknown, cb: (e: Error | null, r: { stdout: string; stderr: string }) => void) => {
      // Find a key whose substring appears in the command — simple matcher
      for (const [needle, stdout] of Object.entries(replies)) {
        if (cmd.includes(needle)) {
          cb(null, { stdout, stderr: "" });
          return;
        }
      }
      cb(new Error(`No mock reply for: ${cmd}`), { stdout: "", stderr: "" });
    },
  );
}

describe("dispatch-fingerprint", () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await resetStore();
  });

  describe("computeFingerprint", () => {
    it("produces a deterministic hash for fixed inputs", async () => {
      mockExecScenario({
        "git rev-parse HEAD": "abc123def456\n",
        "bd list --parent=factory-core-test": "", // no children
      });

      const fp1 = await computeFingerprint({
        epicId: "factory-core-test",
        repoPath: "/tmp",
      });
      const fp2 = await computeFingerprint({
        epicId: "factory-core-test",
        repoPath: "/tmp",
      });
      expect(fp1.combined).toEqual(fp2.combined);
      expect(fp1.head).toBe("abc123def456");
    });

    it("differs when HEAD changes", async () => {
      mockExecScenario({
        "git rev-parse HEAD": "aaa111\n",
        "bd list --parent=factory-core-test": "",
      });
      const before = await computeFingerprint({
        epicId: "factory-core-test",
        repoPath: "/tmp",
      });

      mockExecScenario({
        "git rev-parse HEAD": "bbb222\n",
        "bd list --parent=factory-core-test": "",
      });
      const after = await computeFingerprint({
        epicId: "factory-core-test",
        repoPath: "/tmp",
      });

      expect(before.combined).not.toEqual(after.combined);
    });

    it("differs when the open-children set changes", async () => {
      mockExecScenario({
        "git rev-parse HEAD": "same-head\n",
        "bd list --parent=factory-core-test":
          "○ factory-core-test.1: foo\n○ factory-core-test.2: bar",
      });
      const before = await computeFingerprint({
        epicId: "factory-core-test",
        repoPath: "/tmp",
      });

      mockExecScenario({
        "git rev-parse HEAD": "same-head\n",
        "bd list --parent=factory-core-test":
          "○ factory-core-test.1: foo", // .2 closed
      });
      const after = await computeFingerprint({
        epicId: "factory-core-test",
        repoPath: "/tmp",
      });

      expect(before.combined).not.toEqual(after.combined);
    });

    it("is order-independent over the open-children set", async () => {
      mockExecScenario({
        "git rev-parse HEAD": "same-head\n",
        "bd list --parent=factory-core-test":
          "○ factory-core-test.1: a\n○ factory-core-test.2: b",
      });
      const fp1 = await computeFingerprint({
        epicId: "factory-core-test",
        repoPath: "/tmp",
      });

      mockExecScenario({
        "git rev-parse HEAD": "same-head\n",
        "bd list --parent=factory-core-test":
          "○ factory-core-test.2: b\n○ factory-core-test.1: a", // order flipped
      });
      const fp2 = await computeFingerprint({
        epicId: "factory-core-test",
        repoPath: "/tmp",
      });

      expect(fp1.combined).toEqual(fp2.combined);
    });

    it("handles a repo with no git (empty HEAD) deterministically", async () => {
      mockExecScenario({
        "bd list --parent=factory-core-test": "",
      });
      // No git match means exec throws; that's expected and we return ""
      const fp = await computeFingerprint({
        epicId: "factory-core-test",
        repoPath: "/tmp",
      });
      expect(fp.head).toBe("");
      expect(fp.combined).toBeDefined();
    });
  });

  describe("checkFingerprint + recordFingerprint", () => {
    it("returns duplicate=false on first dispatch", async () => {
      mockExecScenario({
        "git rev-parse HEAD": "head-a\n",
        "bd list --parent=factory-core-k7gy": "",
      });

      const check = await checkFingerprint({
        epicId: "factory-core-k7gy",
        waveNumber: 3,
        agentType: "reviewer",
        repoPath: "/tmp",
      });

      expect(check.duplicate).toBe(false);
      expect(check.previous).toBeUndefined();
      expect(check.fingerprint).toBeDefined();
    });

    it("returns duplicate=true on second dispatch with unchanged state", async () => {
      // This is the k7gy-loop regression: same HEAD, same open children,
      // same findings doc — second dispatch must report duplicate.
      mockExecScenario({
        "git rev-parse HEAD": "c31a24c\n",
        "bd list --parent=factory-core-k7gy":
          "○ factory-core-k7gy.13: bug",
      });

      const first = await checkFingerprint({
        epicId: "factory-core-k7gy",
        waveNumber: 3,
        agentType: "reviewer",
        repoPath: "/tmp",
      });
      await recordFingerprint({
        epicId: "factory-core-k7gy",
        waveNumber: 3,
        agentType: "reviewer",
        fingerprint: first.fingerprint,
      });

      const second = await checkFingerprint({
        epicId: "factory-core-k7gy",
        waveNumber: 3,
        agentType: "reviewer",
        repoPath: "/tmp",
      });

      expect(second.duplicate).toBe(true);
      expect(second.previous?.combined).toEqual(first.fingerprint.combined);
    });

    it("returns duplicate=false when HEAD advances between dispatches", async () => {
      mockExecScenario({
        "git rev-parse HEAD": "head-a\n",
        "bd list --parent=factory-core-k7gy": "",
      });
      const first = await checkFingerprint({
        epicId: "factory-core-k7gy",
        waveNumber: 3,
        agentType: "reviewer",
        repoPath: "/tmp",
      });
      await recordFingerprint({
        epicId: "factory-core-k7gy",
        waveNumber: 3,
        agentType: "reviewer",
        fingerprint: first.fingerprint,
      });

      mockExecScenario({
        "git rev-parse HEAD": "head-b\n", // HEAD moved
        "bd list --parent=factory-core-k7gy": "",
      });
      const second = await checkFingerprint({
        epicId: "factory-core-k7gy",
        waveNumber: 3,
        agentType: "reviewer",
        repoPath: "/tmp",
      });

      expect(second.duplicate).toBe(false);
    });

    it("isolates tuples — same epic, different agent types do not collide", async () => {
      mockExecScenario({
        "git rev-parse HEAD": "head-x\n",
        "bd list --parent=factory-core-k7gy": "",
      });

      const rev = await checkFingerprint({
        epicId: "factory-core-k7gy",
        waveNumber: 3,
        agentType: "reviewer",
        repoPath: "/tmp",
      });
      await recordFingerprint({
        epicId: "factory-core-k7gy",
        waveNumber: 3,
        agentType: "reviewer",
        fingerprint: rev.fingerprint,
      });

      // Builder against same epic+wave — different agent type, must NOT
      // see a duplicate. Reviewer and builder have independent counters.
      const build = await checkFingerprint({
        epicId: "factory-core-k7gy",
        waveNumber: 3,
        agentType: "builder",
        repoPath: "/tmp",
      });

      expect(build.duplicate).toBe(false);
    });

    // factory-core-9l7q.1 fixup: regression for the 2026-04-20 incident
    // where Wave 1 of factory-core-3yqr dispatched three parallel per-bead
    // builders and only one got through — the other two were refused as
    // 'no-delta duplicates' of the first, because all three shared the
    // same (epic, wave, agent) fingerprint key. The key must include beadId.
    it("isolates tuples — same epic, wave, agent, different beadIds do not collide (parallel per-bead builders)", async () => {
      mockExecScenario({
        "git rev-parse HEAD": "head-parallel\n",
        "bd list --parent=factory-core-3yqr": "",
      });

      const b1 = await checkFingerprint({
        epicId: "factory-core-3yqr",
        waveNumber: 1,
        agentType: "builder",
        beadId: "factory-core-3yqr.1",
        repoPath: "/tmp",
      });
      expect(b1.duplicate).toBe(false);
      await recordFingerprint({
        epicId: "factory-core-3yqr",
        waveNumber: 1,
        agentType: "builder",
        beadId: "factory-core-3yqr.1",
        fingerprint: b1.fingerprint,
      });

      // Parallel sibling in the same wave — DIFFERENT bead — must NOT be
      // refused as a duplicate of 3yqr.1's dispatch.
      const b2 = await checkFingerprint({
        epicId: "factory-core-3yqr",
        waveNumber: 1,
        agentType: "builder",
        beadId: "factory-core-3yqr.2",
        repoPath: "/tmp",
      });
      expect(b2.duplicate).toBe(false);

      const b3 = await checkFingerprint({
        epicId: "factory-core-3yqr",
        waveNumber: 1,
        agentType: "builder",
        beadId: "factory-core-3yqr.3",
        repoPath: "/tmp",
      });
      expect(b3.duplicate).toBe(false);
    });

    // Belt-and-braces: re-dispatching the SAME bead against the same state
    // must still be refused — the bead-scoping doesn't weaken the guard,
    // it just scopes the namespace correctly.
    it("per-bead guard still refuses re-dispatch of the same (epic, wave, agent, bead) tuple", async () => {
      mockExecScenario({
        "git rev-parse HEAD": "head-rerun\n",
        "bd list --parent=factory-core-3yqr": "",
      });

      const first = await checkFingerprint({
        epicId: "factory-core-3yqr",
        waveNumber: 1,
        agentType: "builder",
        beadId: "factory-core-3yqr.1",
        repoPath: "/tmp",
      });
      await recordFingerprint({
        epicId: "factory-core-3yqr",
        waveNumber: 1,
        agentType: "builder",
        beadId: "factory-core-3yqr.1",
        fingerprint: first.fingerprint,
      });

      const second = await checkFingerprint({
        epicId: "factory-core-3yqr",
        waveNumber: 1,
        agentType: "builder",
        beadId: "factory-core-3yqr.1",
        repoPath: "/tmp",
      });
      expect(second.duplicate).toBe(true);
    });

    it("isolates tuples — same epic and agent, different waves do not collide", async () => {
      mockExecScenario({
        "git rev-parse HEAD": "head-y\n",
        "bd list --parent=factory-core-k7gy": "",
      });

      const w1 = await checkFingerprint({
        epicId: "factory-core-k7gy",
        waveNumber: 1,
        agentType: "builder",
        repoPath: "/tmp",
      });
      await recordFingerprint({
        epicId: "factory-core-k7gy",
        waveNumber: 1,
        agentType: "builder",
        fingerprint: w1.fingerprint,
      });

      const w2 = await checkFingerprint({
        epicId: "factory-core-k7gy",
        waveNumber: 2,
        agentType: "builder",
        repoPath: "/tmp",
      });

      expect(w2.duplicate).toBe(false);
    });
  });

  describe("clearFingerprint", () => {
    it("zeroes a tuple so the next dispatch is not a duplicate", async () => {
      mockExecScenario({
        "git rev-parse HEAD": "head-z\n",
        "bd list --parent=factory-core-test": "",
      });

      const first = await checkFingerprint({
        epicId: "factory-core-test",
        waveNumber: 1,
        agentType: "planner",
        repoPath: "/tmp",
      });
      await recordFingerprint({
        epicId: "factory-core-test",
        waveNumber: 1,
        agentType: "planner",
        fingerprint: first.fingerprint,
      });

      await clearFingerprint({
        epicId: "factory-core-test",
        waveNumber: 1,
        agentType: "planner",
      });

      const afterClear = await checkFingerprint({
        epicId: "factory-core-test",
        waveNumber: 1,
        agentType: "planner",
        repoPath: "/tmp",
      });

      expect(afterClear.duplicate).toBe(false);
    });
  });

  describe("k7gy-loop regression", () => {
    // Replay the exact loop this module exists to prevent: 5 consecutive
    // dispatches at the same HEAD with the same open children must produce
    // duplicate=true from the 2nd onwards.
    it("refuses 2nd..5th dispatch when state is unchanged", async () => {
      mockExecScenario({
        "git rev-parse HEAD": "c31a24c\n",
        "bd list --parent=factory-core-k7gy":
          "○ factory-core-k7gy.13: path derivation bug",
      });

      const results: boolean[] = [];
      for (let i = 0; i < 5; i++) {
        const check = await checkFingerprint({
          epicId: "factory-core-k7gy",
          waveNumber: 3,
          agentType: "reviewer",
          repoPath: "/tmp",
        });
        results.push(check.duplicate);
        await recordFingerprint({
          epicId: "factory-core-k7gy",
          waveNumber: 3,
          agentType: "reviewer",
          fingerprint: check.fingerprint,
        });
      }

      // 1st dispatch: not duplicate (fresh)
      // 2nd..5th dispatches: all duplicates
      expect(results).toEqual([false, true, true, true, true]);
    });
  });

  describe("shortHash", () => {
    it("truncates to 12 characters", () => {
      expect(shortHash("0123456789abcdef0123456789abcdef")).toBe(
        "0123456789ab",
      );
    });
  });
});
