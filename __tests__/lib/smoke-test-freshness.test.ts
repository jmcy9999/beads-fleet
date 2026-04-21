// =============================================================================
// Tests for src/lib/smoke-test-freshness.ts (factory-core-zszt.4)
// =============================================================================
// Exercise every exit class of the gate against a per-test temp repo so the
// file-system layer is real (no fs mocking). Each test sets up its own
// smoke-test.json fixture and asserts the gate's ok / class / reason.
// =============================================================================

import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";

import { checkSmokeTestFreshness } from "@/lib/smoke-test-freshness";

async function makeRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "smoke-freshness-"));
  return dir;
}

async function writeArtefact(repo: string, contents: object): Promise<void> {
  await fs.writeFile(
    path.join(repo, "smoke-test.json"),
    JSON.stringify(contents, null, 2),
    "utf-8",
  );
}

describe("checkSmokeTestFreshness", () => {
  test("non-iOS ship type passes through regardless of artefact", async () => {
    const repo = await makeRepo();
    const result = await checkSmokeTestFreshness("web-app", repo);
    expect(result.ok).toBe(true);
    expect(result.class).toBe("not-applicable");
  });

  test("wordpress-plugin passes through", async () => {
    const repo = await makeRepo();
    const result = await checkSmokeTestFreshness("wordpress-plugin", repo);
    expect(result.ok).toBe(true);
  });

  test("ios-app with no smoke-test artefact fails as artefact-missing", async () => {
    const repo = await makeRepo();
    const result = await checkSmokeTestFreshness("ios-app", repo);
    expect(result.ok).toBe(false);
    expect(result.class).toBe("artefact-missing");
    expect(result.reason).toMatch(/smoke-test artefact not found/);
  });

  test("ios-app with fresh PASS artefact succeeds", async () => {
    const repo = await makeRepo();
    await writeArtefact(repo, {
      verdict: "PASS",
      exitCode: 0,
      finishedAt: new Date().toISOString(),
    });
    const result = await checkSmokeTestFreshness("ios-app", repo);
    expect(result.ok).toBe(true);
    expect(result.ageMinutes).toBeLessThan(1);
  });

  test("macos-app with fresh PASS artefact succeeds", async () => {
    const repo = await makeRepo();
    await writeArtefact(repo, {
      verdict: "PASS",
      exitCode: 0,
      finishedAt: new Date().toISOString(),
    });
    const result = await checkSmokeTestFreshness("macos-app", repo);
    expect(result.ok).toBe(true);
  });

  test("ios-app with FAIL verdict is blocked as verdict-fail", async () => {
    const repo = await makeRepo();
    await writeArtefact(repo, {
      verdict: "FAIL",
      exitCode: 4,
      finishedAt: new Date().toISOString(),
    });
    const result = await checkSmokeTestFreshness("ios-app", repo);
    expect(result.ok).toBe(false);
    expect(result.class).toBe("verdict-fail");
    expect(result.reason).toMatch(/exitCode=4/);
  });

  test("ios-app with stale PASS (> 30 min) is blocked as stale", async () => {
    const repo = await makeRepo();
    const oneHourAgo = new Date(Date.now() - 60 * 60_000).toISOString();
    await writeArtefact(repo, {
      verdict: "PASS",
      exitCode: 0,
      finishedAt: oneHourAgo,
    });
    const result = await checkSmokeTestFreshness("ios-app", repo);
    expect(result.ok).toBe(false);
    expect(result.class).toBe("stale");
    expect(result.ageMinutes).toBeGreaterThan(30);
  });

  test("ios-app with unparseable JSON is blocked as artefact-unreadable", async () => {
    const repo = await makeRepo();
    await fs.writeFile(
      path.join(repo, "smoke-test.json"),
      "{ this is not json",
      "utf-8",
    );
    const result = await checkSmokeTestFreshness("ios-app", repo);
    expect(result.ok).toBe(false);
    expect(result.class).toBe("artefact-unreadable");
  });

  test("ios-app with missing finishedAt is blocked as verdict-missing", async () => {
    const repo = await makeRepo();
    await writeArtefact(repo, { verdict: "PASS", exitCode: 0 });
    const result = await checkSmokeTestFreshness("ios-app", repo);
    expect(result.ok).toBe(false);
    expect(result.class).toBe("verdict-missing");
  });

  test("custom maxAgeMinutes override is respected", async () => {
    const repo = await makeRepo();
    const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    await writeArtefact(repo, {
      verdict: "PASS",
      exitCode: 0,
      finishedAt: tenMinAgo,
    });
    // Default 30 min would pass
    const defaultResult = await checkSmokeTestFreshness("ios-app", repo);
    expect(defaultResult.ok).toBe(true);
    // Custom 5 min window should block
    const strictResult = await checkSmokeTestFreshness("ios-app", repo, 5);
    expect(strictResult.ok).toBe(false);
    expect(strictResult.class).toBe("stale");
  });
});
