// =============================================================================
// Tests for src/lib/git/commit-manager.ts (factory-core-ppx.2)
// =============================================================================
// Uses real git in a throwaway scratch repo under os.tmpdir(). Tests both
// happy-path behaviour (staged files round-trip to HEAD SHA) and the
// retry / stash / conflict paths by manipulating the real repo state.
// =============================================================================

import { execFile } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";

import {
  commitWithRetry,
  MAX_COMMIT_ATTEMPTS,
  type CommitResult,
} from "@/lib/git/commit-manager";

const execFileAsync = promisify(execFile);

// Helper — quick git runner rooted at `cwd`.
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

async function initScratchRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "commit-manager-"));
  await git(dir, ["init", "-b", "main"]);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "user.name", "Test User"]);
  await git(dir, ["config", "commit.gpgsign", "false"]);
  // One initial commit so HEAD exists.
  await fs.writeFile(path.join(dir, "README.md"), "init\n");
  await git(dir, ["add", "README.md"]);
  await git(dir, ["commit", "-m", "init"]);
  return dir;
}

async function rmRepo(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

describe("commitWithRetry — happy path", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await initScratchRepo();
  });
  afterEach(async () => {
    await rmRepo(repo);
  });

  it("stages the named file, commits, and returns {status:'ok', sha}", async () => {
    await fs.writeFile(path.join(repo, "foo.ts"), "export const x = 1;\n");
    const res = await commitWithRetry(repo, "msg: test", ["foo.ts"]);
    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    expect(res.sha).toMatch(/^[0-9a-f]{40}$/);
    // Round-trip: git rev-parse HEAD matches the returned SHA.
    const head = (await git(repo, ["rev-parse", "HEAD"])).trim();
    expect(res.sha).toBe(head);
    // And the commit message is preserved exactly.
    const msg = (
      await git(repo, ["log", "-1", "--pretty=%B"])
    ).trim();
    expect(msg).toBe("msg: test");
  });

  it("stages ONLY the named files — other dirty files stay unstaged (no git add -A)", async () => {
    await fs.writeFile(path.join(repo, "a.ts"), "a\n");
    await fs.writeFile(path.join(repo, "b.ts"), "b\n");
    const res = await commitWithRetry(repo, "only-a", ["a.ts"]);
    expect(res.status).toBe("ok");
    // a.ts in the commit, b.ts unstaged.
    const committed = (
      await git(repo, ["show", "--stat", "--name-only", "--pretty=", "HEAD"])
    )
      .trim()
      .split("\n");
    expect(committed).toContain("a.ts");
    expect(committed).not.toContain("b.ts");
    // Verify b.ts is still untracked.
    const status = await git(repo, ["status", "--porcelain"]);
    expect(status).toMatch(/\?\? b\.ts/);
  });

  it("supports a commit with 100 files (boundary — no 'argument list too long')", async () => {
    const files: string[] = [];
    for (let i = 0; i < 100; i++) {
      const name = `f${i}.ts`;
      await fs.writeFile(path.join(repo, name), `// ${i}\n`);
      files.push(name);
    }
    const res = await commitWithRetry(repo, "bulk", files);
    expect(res.status).toBe("ok");
    const count = (
      await git(repo, ["diff", "--name-only", "HEAD~1..HEAD"])
    )
      .trim()
      .split("\n")
      .filter((s) => s.length > 0).length;
    expect(count).toBe(100);
  });

  it("discriminated union narrows to {status:'ok', sha} when status is ok (compile-time check)", async () => {
    await fs.writeFile(path.join(repo, "x.ts"), "x\n");
    const res: CommitResult = await commitWithRetry(repo, "m", ["x.ts"]);
    if (res.status === "ok") {
      // TypeScript narrows here — `sha` is required, not optional.
      const sha: string = res.sha;
      expect(sha.length).toBe(40);
    } else {
      fail(`expected ok, got ${res.status}`);
    }
  });

  it("round-trip: returned sha equals git log -1 --format=%H (Internal Guardrail 2)", async () => {
    await fs.writeFile(path.join(repo, "g2.ts"), "g\n");
    const res = await commitWithRetry(repo, "guardrail-2", ["g2.ts"]);
    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    const logSha = (
      await git(repo, ["log", "-1", "--format=%H"])
    ).trim();
    expect(res.sha).toBe(logSha);
  });
});

describe("commitWithRetry — validation (fail fast)", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await initScratchRepo();
  });
  afterEach(async () => {
    await rmRepo(repo);
  });

  it("rejects empty files list with descriptive error BEFORE any git call", async () => {
    await expect(commitWithRetry(repo, "m", [])).rejects.toThrow(
      /files list must be non-empty/,
    );
  });

  it("rejects non-existent repoPath BEFORE any git invocation", async () => {
    await expect(
      commitWithRetry("/does/not/exist-abc123", "m", ["a.ts"]),
    ).rejects.toThrow(/repoPath does not exist/);
  });

  it("rejects repoPath that is a file, not a directory", async () => {
    const filePath = path.join(repo, "not-a-dir.txt");
    await fs.writeFile(filePath, "hi");
    await expect(commitWithRetry(filePath, "m", ["a.ts"])).rejects.toThrow(
      /repoPath is not a directory/,
    );
  });

  it("rejects a file that does not exist in the repo", async () => {
    await expect(
      commitWithRetry(repo, "m", ["no-such-file.ts"]),
    ).rejects.toThrow(/file not found/);
  });

  it("rejects empty / non-string entries in files list", async () => {
    // @ts-expect-error — runtime guard for JS callers passing bad input
    await expect(commitWithRetry(repo, "m", [""])).rejects.toThrow(/non-empty/);
    // @ts-expect-error
    await expect(commitWithRetry(repo, "m", [null])).rejects.toThrow(/non-empty/);
  });

  it("rejects empty message", async () => {
    await fs.writeFile(path.join(repo, "foo.ts"), "x\n");
    await expect(commitWithRetry(repo, "", ["foo.ts"])).rejects.toThrow(
      /message must be a non-empty string/,
    );
  });

  it("MAX_COMMIT_ATTEMPTS is exactly 3 (ADR-003)", () => {
    expect(MAX_COMMIT_ATTEMPTS).toBe(3);
  });
});

describe("commitWithRetry — retry path (transient index.lock)", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await initScratchRepo();
  });
  afterEach(async () => {
    await rmRepo(repo);
  });

  it("recovers from a transient .git/index.lock that disappears within timeout", async () => {
    await fs.writeFile(path.join(repo, "t.ts"), "t\n");
    // Create a stale index.lock — git will refuse to run git add or commit
    // while this exists. Schedule removal after 80ms so the retry path
    // gets past it on a subsequent attempt.
    const lockFile = path.join(repo, ".git", "index.lock");
    await fs.writeFile(lockFile, "");
    setTimeout(() => {
      fs.unlink(lockFile).catch(() => {});
    }, 80);

    const res = await commitWithRetry(repo, "t", ["t.ts"]);
    expect(res.status).toBe("ok");
  }, 5000);
});

describe("commitWithRetry — conflict / retry exhaustion", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await initScratchRepo();
  });
  afterEach(async () => {
    // If any index.lock got left behind by a hung test, remove it so
    // cleanup doesn't fail.
    await fs
      .unlink(path.join(repo, ".git", "index.lock"))
      .catch(() => {});
    await rmRepo(repo);
  });

  it("returns {status:'conflict', conflicts} after 3 exhausted attempts (persistent .git/index.lock)", async () => {
    await fs.writeFile(path.join(repo, "c.ts"), "c\n");
    // Hold the index.lock for longer than 3 retries' total wallclock. Each
    // recovery attempt sleeps 50ms; three attempts is ~200ms. We keep the
    // lock for 2s to guarantee exhaustion.
    const lockFile = path.join(repo, ".git", "index.lock");
    await fs.writeFile(lockFile, "");
    const clearLock = setTimeout(() => {
      fs.unlink(lockFile).catch(() => {});
    }, 2000);

    const res = await commitWithRetry(repo, "c", ["c.ts"]);
    clearTimeout(clearLock);
    await fs.unlink(lockFile).catch(() => {});

    expect(res.status).toBe("conflict");
    // conflicts may be empty since the lock isn't a merge-conflict state,
    // but the status is the right discriminator.
    if (res.status === "conflict") {
      expect(Array.isArray(res.conflicts)).toBe(true);
    }
  }, 10000);

  it("retry path preserves the original commit message across attempts", async () => {
    await fs.writeFile(path.join(repo, "m.ts"), "m\n");
    // Transient lock — retry should succeed on attempt 2 or 3.
    const lockFile = path.join(repo, ".git", "index.lock");
    await fs.writeFile(lockFile, "");
    setTimeout(() => {
      fs.unlink(lockFile).catch(() => {});
    }, 100);

    const unique = "my-unique-message-abcxyz-42";
    const res = await commitWithRetry(repo, unique, ["m.ts"]);
    expect(res.status).toBe("ok");
    const logMsg = (await git(repo, ["log", "-1", "--pretty=%B"])).trim();
    expect(logMsg).toBe(unique);
  }, 5000);
});
