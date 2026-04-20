// =============================================================================
// Tests for src/lib/fleet-config.ts — factory-core-k7gy.3
// =============================================================================
// Covers F9 acceptance criteria for the plan-review feature flag:
//   - flag true → true
//   - flag false → false
//   - absent flag → false (fail-safe default)
//   - absent features → false
//   - missing file → false (no throw)
//   - malformed JSON → false (no throw)
//   - non-boolean values → false (strict type, per regression pattern #8)
//   - empty / whitespace-only file → false (no throw)
//   - cache hit latency < 5ms (F9 non-functional AC)
//   - no hardcoded absolute path (internal guardrail #1)
// =============================================================================

import { promises as fs, readFileSync } from "fs";
import * as os from "os";
import * as path from "path";

import { readFleetConfig, resetFleetConfigCache } from "@/lib/fleet-config";

// ---------------------------------------------------------------------------
// Helpers: each test gets a fresh temp cwd with whatever fleet.json contents
// it needs (or no fleet.json at all for the missing-file test).
// ---------------------------------------------------------------------------

let tempDir: string | null = null;
let originalCwd = process.cwd();

async function withFleetJson(contents: string | null): Promise<string> {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-config-test-"));
  if (contents !== null) {
    await fs.writeFile(path.join(tempDir, "fleet.json"), contents, "utf-8");
  }
  process.chdir(tempDir);
  resetFleetConfigCache();
  return tempDir;
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
  resetFleetConfigCache();
});

describe("readFleetConfig — happy path", () => {
  it("returns plan_review_auto_chain=true when fleet.json sets it to true", async () => {
    await withFleetJson(
      JSON.stringify({ features: { plan_review_auto_chain: true } }),
    );
    expect(readFleetConfig()).toEqual({ plan_review_auto_chain: true });
  });

  it("returns plan_review_auto_chain=false when fleet.json sets it to false", async () => {
    await withFleetJson(
      JSON.stringify({ features: { plan_review_auto_chain: false } }),
    );
    expect(readFleetConfig()).toEqual({ plan_review_auto_chain: false });
  });
});

describe("readFleetConfig — fail-safe defaults (regression #13)", () => {
  it("returns false when the features key is absent entirely", async () => {
    await withFleetJson(JSON.stringify({ something_else: "x" }));
    expect(readFleetConfig().plan_review_auto_chain).toBe(false);
  });

  it("returns false when features is present but the flag key is absent", async () => {
    await withFleetJson(JSON.stringify({ features: {} }));
    expect(readFleetConfig().plan_review_auto_chain).toBe(false);
  });

  it("returns false when fleet.json does not exist — does not throw", async () => {
    await withFleetJson(null);
    expect(() => readFleetConfig()).not.toThrow();
    expect(readFleetConfig().plan_review_auto_chain).toBe(false);
  });

  it("returns false when fleet.json contains malformed JSON", async () => {
    await withFleetJson('{"features": {"plan_rev'); // truncated
    expect(() => readFleetConfig()).not.toThrow();
    expect(readFleetConfig().plan_review_auto_chain).toBe(false);
  });

  it("returns false when fleet.json is completely empty (zero bytes)", async () => {
    await withFleetJson("");
    expect(readFleetConfig().plan_review_auto_chain).toBe(false);
  });

  it("returns false when fleet.json contains only whitespace", async () => {
    await withFleetJson("   \n\t");
    expect(readFleetConfig().plan_review_auto_chain).toBe(false);
  });

  it("returns false when the root value is not an object (e.g., an array)", async () => {
    await withFleetJson(JSON.stringify(["not", "an", "object"]));
    expect(readFleetConfig().plan_review_auto_chain).toBe(false);
  });

  it("returns false when the features value is not an object (string)", async () => {
    await withFleetJson(JSON.stringify({ features: "enabled" }));
    expect(readFleetConfig().plan_review_auto_chain).toBe(false);
  });
});

describe("readFleetConfig — sanitisation (regression #8)", () => {
  it("rejects string 'true' — strict boolean only", async () => {
    await withFleetJson(
      JSON.stringify({ features: { plan_review_auto_chain: "true" } }),
    );
    expect(readFleetConfig().plan_review_auto_chain).toBe(false);
  });

  it("rejects numeric 1 — strict boolean only", async () => {
    await withFleetJson(
      JSON.stringify({ features: { plan_review_auto_chain: 1 } }),
    );
    expect(readFleetConfig().plan_review_auto_chain).toBe(false);
  });

  it("rejects null as flag value", async () => {
    await withFleetJson(
      JSON.stringify({ features: { plan_review_auto_chain: null } }),
    );
    expect(readFleetConfig().plan_review_auto_chain).toBe(false);
  });

  it("rejects object as flag value", async () => {
    await withFleetJson(
      JSON.stringify({
        features: { plan_review_auto_chain: { enabled: true } },
      }),
    );
    expect(readFleetConfig().plan_review_auto_chain).toBe(false);
  });
});

describe("readFleetConfig — caching (F9 non-functional)", () => {
  it("caches the result after the first read", async () => {
    const dir = await withFleetJson(
      JSON.stringify({ features: { plan_review_auto_chain: true } }),
    );

    // First call reads from disk.
    expect(readFleetConfig().plan_review_auto_chain).toBe(true);

    // Mutate the file underneath the cache. Without cache, this would flip
    // the return value. With cache, the first read wins.
    await fs.writeFile(
      path.join(dir, "fleet.json"),
      JSON.stringify({ features: { plan_review_auto_chain: false } }),
      "utf-8",
    );

    expect(readFleetConfig().plan_review_auto_chain).toBe(true);
  });

  it("cache hit latency is well under 5ms (accessor non-functional AC)", async () => {
    await withFleetJson(
      JSON.stringify({ features: { plan_review_auto_chain: true } }),
    );

    // Warm the cache.
    readFleetConfig();

    // Measure a generous batch of cached reads — use the p99 to avoid being
    // fooled by a single GC pause on the CI runner.
    const samples: number[] = [];
    for (let i = 0; i < 100; i += 1) {
      const t0 = performance.now();
      readFleetConfig();
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const p99 = samples[Math.floor(samples.length * 0.99)];
    expect(p99).toBeLessThan(5);
  });

  it("resetFleetConfigCache forces a re-read", async () => {
    const dir = await withFleetJson(
      JSON.stringify({ features: { plan_review_auto_chain: true } }),
    );

    expect(readFleetConfig().plan_review_auto_chain).toBe(true);

    await fs.writeFile(
      path.join(dir, "fleet.json"),
      JSON.stringify({ features: { plan_review_auto_chain: false } }),
      "utf-8",
    );
    resetFleetConfigCache();

    expect(readFleetConfig().plan_review_auto_chain).toBe(false);
  });
});

describe("readFleetConfig — no hardcoded absolute paths (internal guardrail #1)", () => {
  it("resolves fleet.json relative to process.cwd(), not /Users or /home", () => {
    const source = readFileSync(
      path.join(__dirname, "..", "..", "src", "lib", "fleet-config.ts"),
      "utf-8",
    );
    expect(source).not.toMatch(/\/Users\//);
    expect(source).not.toMatch(/\/home\//);
    expect(source).toMatch(/process\.cwd\(\)/);
  });
});
