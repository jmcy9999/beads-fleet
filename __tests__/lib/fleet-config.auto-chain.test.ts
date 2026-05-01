// =============================================================================
// Tests for src/lib/fleet-config.ts — factory-core-3yqr.1
// =============================================================================
// Covers F1 acceptance criteria for the auto-chain stage flag accessor:
//
//   Happy path
//     - Valid `true` per stage                                               → returns true
//     - Valid `false` per stage (shipped default)                            → returns false, no warn
//     - Cache refresh via `resetFleetConfigCache`                            → sees new on-disk value
//
//   Drift (internal guardrail 7)
//     - `AutoChainStage` union members match `fleet.json` default keys exactly.
//
//   Edge cases (regression patterns #7, #8, #13)
//     - Missing `features` object entirely                                   → false, never throws
//     - Missing `auto_chain_stages` object                                   → false, never throws
//     - Missing individual stage key (others unaffected)                     → false for missing
//     - Non-boolean value (string "yes" / number 1 / null / "true")          → false + warn
//     - Unknown stage name                                                   → false
//     - Empty / whitespace / wrong-case stage name                           → false
//     - Malformed JSON                                                       → false, never throws
//     - Missing fleet.json entirely                                          → false, never throws
//
//   Boundary
//     - Off-by-one — every AUTO_CHAIN_STAGES member yields a real boolean.
//     - Latency floor — cache-hit read well under 5ms (F1 non-functional AC).
//
//   Consumer contract
//     - `autoChainEnabled` signature is `(stage: string) => boolean` (no
//       extra arguments required; sanity-checked at runtime).
//
//   Regression safety
//     - Existing `plan_review_auto_chain` behaviour unchanged when the new
//       `auto_chain_stages` section is present/absent/malformed.
// =============================================================================

import { promises as fs, readFileSync } from "fs";
import * as os from "os";
import * as path from "path";

import {
  AUTO_CHAIN_STAGES,
  AutoChainStage,
  autoChainEnabled,
  isAutoChainStage,
  readFleetConfig,
  resetFleetConfigCache,
} from "@/lib/fleet-config";

// ---------------------------------------------------------------------------
// Helpers — each test gets a fresh temp cwd with whatever fleet.json contents
// it needs (or no fleet.json at all for the missing-file test). We restore
// the original cwd in afterEach so tests leave no global state behind.
// ---------------------------------------------------------------------------

let tempDir: string | null = null;
const originalCwd = process.cwd();

async function withFleetJson(contents: string | null): Promise<string> {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auto-chain-test-"));
  if (contents !== null) {
    await fs.writeFile(path.join(tempDir, "fleet.json"), contents, "utf-8");
  }
  process.chdir(tempDir);
  resetFleetConfigCache();
  return tempDir;
}

async function rewriteFleetJson(dir: string, contents: string): Promise<void> {
  await fs.writeFile(path.join(dir, "fleet.json"), contents, "utf-8");
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

// Silence the warn-on-non-boolean path during the tests that intentionally
// pass bad values. Individual assertions re-enable the spy via
// `jest.spyOn(console, "warn")` where the warning is the thing being asserted.
let warnSpy: jest.SpyInstance;
beforeEach(() => {
  warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  warnSpy.mockRestore();
});

// Builder — an `auto_chain_stages` object with all four flags preset. Lets
// each test flip exactly the flag under exam without boilerplate.
function stagesAllFalse(): Record<AutoChainStage, boolean> {
  return {
    research: false,
    "product-spec": false,
    architecture: false,
    "test-spec": false,
  };
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("autoChainEnabled — happy path (F1 AC)", () => {
  it.each(AUTO_CHAIN_STAGES)(
    "returns true when fleet.json sets %s=true (sibling stages stay false)",
    async (enabledStage) => {
      const stages = stagesAllFalse();
      stages[enabledStage] = true;
      await withFleetJson(
        JSON.stringify({ features: { auto_chain_stages: stages } }),
      );

      expect(autoChainEnabled(enabledStage)).toBe(true);

      for (const other of AUTO_CHAIN_STAGES) {
        if (other === enabledStage) continue;
        expect(autoChainEnabled(other)).toBe(false);
      }
    },
  );

  it("returns false for every stage on the shipped default (all flags false, no warnings)", async () => {
    await withFleetJson(
      JSON.stringify({
        features: { auto_chain_stages: stagesAllFalse() },
      }),
    );

    for (const stage of AUTO_CHAIN_STAGES) {
      expect(autoChainEnabled(stage)).toBe(false);
    }
    // Shipped state is not a misconfiguration — we must not log.
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("cache refresh — resetFleetConfigCache sees the new on-disk value", async () => {
    const dir = await withFleetJson(
      JSON.stringify({
        features: {
          auto_chain_stages: { ...stagesAllFalse(), research: true },
        },
      }),
    );

    // First read — caches the enabled flag.
    expect(autoChainEnabled("research")).toBe(true);

    // Flip on disk. Without reset the cache still returns true.
    await rewriteFleetJson(
      dir,
      JSON.stringify({
        features: {
          auto_chain_stages: { ...stagesAllFalse(), research: false },
        },
      }),
    );
    expect(autoChainEnabled("research")).toBe(true);

    // After reset the new value flows through.
    resetFleetConfigCache();
    expect(autoChainEnabled("research")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Drift (internal guardrail 7)
// ---------------------------------------------------------------------------

describe("drift — fleet.json keys match AutoChainStage union (guardrail 7)", () => {
  it("committed fleet.json's features.auto_chain_stages keys match AUTO_CHAIN_STAGES exactly", () => {
    // Resolve fleet-core path the same way the rest of the codebase does:
    // env var override with the documented fallback (mirrors
    // `src/lib/repo-path-resolver.ts`). The test lives in beads_web and
    // reads fleet-core's committed config directly rather than a fixture so
    // a future edit that adds a stage in one surface but not the other
    // fails CI rather than silently drifts in production.
    const fleetCorePath =
      process.env.FLEET_CORE_PATH || "/Users/janemckay/dev/fleet/factory-core";
    const fleetJsonPath = path.join(fleetCorePath, "fleet.json");

    const raw = readFileSync(fleetJsonPath, "utf-8");
    const parsed = JSON.parse(raw) as {
      features?: { auto_chain_stages?: Record<string, unknown> };
    };

    const stagesObj = parsed.features?.auto_chain_stages;
    expect(stagesObj).toBeDefined();
    expect(typeof stagesObj).toBe("object");

    const fleetKeys = Object.keys(stagesObj as Record<string, unknown>).sort();
    const unionKeys = [...AUTO_CHAIN_STAGES].sort();

    // Exact match — same cardinality, same members, no extras on either
    // side. Catches drift in both directions.
    expect(fleetKeys).toEqual(unionKeys);
  });

  it("committed fleet.json ships all four stages as boolean false (F9 bake-in)", () => {
    const fleetCorePath =
      process.env.FLEET_CORE_PATH || "/Users/janemckay/dev/fleet/factory-core";
    const fleetJsonPath = path.join(fleetCorePath, "fleet.json");

    const raw = readFileSync(fleetJsonPath, "utf-8");
    const parsed = JSON.parse(raw) as {
      features?: { auto_chain_stages?: Record<string, unknown> };
    };
    const stagesObj = parsed.features?.auto_chain_stages as Record<
      string,
      unknown
    >;

    for (const stage of AUTO_CHAIN_STAGES) {
      expect(stagesObj[stage]).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Edge cases — regression pattern #13 (fail closed, never throw)
// ---------------------------------------------------------------------------

describe("autoChainEnabled — fail-safe defaults (regression #13)", () => {
  it("returns false when features object is absent entirely", async () => {
    await withFleetJson(JSON.stringify({ something_else: "x" }));
    for (const stage of AUTO_CHAIN_STAGES) {
      expect(autoChainEnabled(stage)).toBe(false);
    }
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("returns false when features.auto_chain_stages is absent", async () => {
    await withFleetJson(
      JSON.stringify({ features: { plan_review_auto_chain: true } }),
    );
    for (const stage of AUTO_CHAIN_STAGES) {
      expect(autoChainEnabled(stage)).toBe(false);
    }
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("missing individual stage key does not poison present keys", async () => {
    await withFleetJson(
      JSON.stringify({
        features: { auto_chain_stages: { research: true } },
      }),
    );
    expect(autoChainEnabled("research")).toBe(true);
    expect(autoChainEnabled("product-spec")).toBe(false);
    expect(autoChainEnabled("architecture")).toBe(false);
    expect(autoChainEnabled("test-spec")).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("returns false and never throws when fleet.json does not exist", async () => {
    await withFleetJson(null);
    for (const stage of AUTO_CHAIN_STAGES) {
      expect(() => autoChainEnabled(stage)).not.toThrow();
      expect(autoChainEnabled(stage)).toBe(false);
    }
  });

  it("returns false and never throws when fleet.json is malformed", async () => {
    await withFleetJson('{"features": {"auto_chain_stages": {"research'); // truncated
    for (const stage of AUTO_CHAIN_STAGES) {
      expect(() => autoChainEnabled(stage)).not.toThrow();
      expect(autoChainEnabled(stage)).toBe(false);
    }
  });

  it("returns false when auto_chain_stages is not an object (string)", async () => {
    await withFleetJson(
      JSON.stringify({ features: { auto_chain_stages: "enabled" } }),
    );
    for (const stage of AUTO_CHAIN_STAGES) {
      expect(autoChainEnabled(stage)).toBe(false);
    }
  });

  it("returns false when auto_chain_stages is null", async () => {
    await withFleetJson(
      JSON.stringify({ features: { auto_chain_stages: null } }),
    );
    for (const stage of AUTO_CHAIN_STAGES) {
      expect(autoChainEnabled(stage)).toBe(false);
    }
  });

  it("returns false when auto_chain_stages is an array", async () => {
    await withFleetJson(
      JSON.stringify({
        features: { auto_chain_stages: ["research", "product-spec"] },
      }),
    );
    for (const stage of AUTO_CHAIN_STAGES) {
      expect(autoChainEnabled(stage)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Edge cases — regression pattern #8 (strict boolean; no truthy coercion)
// ---------------------------------------------------------------------------

describe("autoChainEnabled — strict boolean sanitisation (regression #8)", () => {
  it.each([
    ["string 'true'", "true"],
    ["string 'yes'", "yes"],
    ["numeric 1", 1],
    ["numeric 0", 0],
    ["null", null],
    ["object", { enabled: true }],
    ["array", [true]],
  ])("rejects %s as research flag value and warns", async (_label, badValue) => {
    await withFleetJson(
      JSON.stringify({
        features: { auto_chain_stages: { research: badValue } },
      }),
    );
    expect(autoChainEnabled("research")).toBe(false);
    // Warning naming the stage and the bad value.
    expect(warnSpy).toHaveBeenCalled();
    const warnMessages = warnSpy.mock.calls.map((args) => String(args[0]));
    expect(
      warnMessages.some((msg) => msg.includes("research") && msg.includes("auto_chain_stages")),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Edge cases — regression pattern #7 (Type Confusion on Enum Branching)
// ---------------------------------------------------------------------------

describe("autoChainEnabled — unknown / malformed stage names (regression #7)", () => {
  it("returns false for totally-made-up stage name (even if enabled keys exist)", async () => {
    await withFleetJson(
      JSON.stringify({
        features: {
          auto_chain_stages: { ...stagesAllFalse(), research: true },
        },
      }),
    );
    // Enabled flag exists for a real stage, but this stage name is unknown.
    expect(autoChainEnabled("totally-made-up-stage")).toBe(false);
  });

  it("returns false for empty string stage name", async () => {
    await withFleetJson(
      JSON.stringify({
        features: {
          auto_chain_stages: { ...stagesAllFalse(), research: true },
        },
      }),
    );
    expect(autoChainEnabled("")).toBe(false);
  });

  it("returns false for whitespace-only stage name (no implicit trim)", async () => {
    await withFleetJson(
      JSON.stringify({
        features: {
          auto_chain_stages: { ...stagesAllFalse(), research: true },
        },
      }),
    );
    expect(autoChainEnabled("   ")).toBe(false);
    expect(autoChainEnabled(" research ")).toBe(false);
  });

  it("is case-sensitive — upper-case stage names return false", async () => {
    await withFleetJson(
      JSON.stringify({
        features: {
          auto_chain_stages: { ...stagesAllFalse(), research: true },
        },
      }),
    );
    expect(autoChainEnabled("RESEARCH")).toBe(false);
    expect(autoChainEnabled("Research")).toBe(false);
  });

  it("isAutoChainStage type guard matches exactly the four supported names", () => {
    for (const stage of AUTO_CHAIN_STAGES) {
      expect(isAutoChainStage(stage)).toBe(true);
    }
    for (const bad of ["", " ", "RESEARCH", "plan", "qa", "build", "product_spec"]) {
      expect(isAutoChainStage(bad)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Boundary conditions
// ---------------------------------------------------------------------------

describe("autoChainEnabled — boundaries", () => {
  it("off-by-one — every AUTO_CHAIN_STAGES member yields a boolean regardless of config state", async () => {
    // No fleet.json at all — accessor still returns booleans for each.
    await withFleetJson(null);
    for (const stage of AUTO_CHAIN_STAGES) {
      const result = autoChainEnabled(stage);
      expect(typeof result).toBe("boolean");
    }
  });

  it("AUTO_CHAIN_STAGES contains exactly four stages in the documented order", () => {
    expect(AUTO_CHAIN_STAGES).toEqual([
      "research",
      "product-spec",
      "architecture",
      "test-spec",
    ]);
    expect(AUTO_CHAIN_STAGES).toHaveLength(4);
  });

  it("cache-hit latency is well under 5ms (F1 non-functional AC)", async () => {
    await withFleetJson(
      JSON.stringify({
        features: {
          auto_chain_stages: { ...stagesAllFalse(), research: true },
        },
      }),
    );

    // Warm the cache.
    autoChainEnabled("research");

    // Measure a generous batch of cached reads — use the p99 to avoid being
    // fooled by a single GC pause on the CI runner.
    const samples: number[] = [];
    for (let i = 0; i < 1000; i += 1) {
      const t0 = performance.now();
      autoChainEnabled("research");
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const p99 = samples[Math.floor(samples.length * 0.99)];
    expect(p99).toBeLessThan(5);
  });
});

// ---------------------------------------------------------------------------
// Consumer contract — 3yqr.4 will call `autoChainEnabled(<stage>)` as its
// first line with no other arguments. Enforce that contract here.
// ---------------------------------------------------------------------------

describe("autoChainEnabled — consumer contract for 3yqr.4", () => {
  it("accepts a single string argument and returns a boolean", async () => {
    await withFleetJson(
      JSON.stringify({
        features: { auto_chain_stages: stagesAllFalse() },
      }),
    );
    // arity/return shape sanity
    expect(typeof autoChainEnabled("research")).toBe("boolean");
    expect(autoChainEnabled.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Integration — regression pattern #1 (Write/Read round-trip)
// ---------------------------------------------------------------------------

describe("fleet-config — write/read round trip (regression #1)", () => {
  it("reads back whatever the most-recent committed fleet.json says (per stage)", async () => {
    const dir = await withFleetJson(
      JSON.stringify({
        features: { auto_chain_stages: stagesAllFalse() },
      }),
    );
    expect(autoChainEnabled("architecture")).toBe(false);

    await rewriteFleetJson(
      dir,
      JSON.stringify({
        features: {
          auto_chain_stages: { ...stagesAllFalse(), architecture: true },
        },
      }),
    );
    resetFleetConfigCache();
    expect(autoChainEnabled("architecture")).toBe(true);

    await rewriteFleetJson(
      dir,
      JSON.stringify({
        features: { auto_chain_stages: stagesAllFalse() },
      }),
    );
    resetFleetConfigCache();
    expect(autoChainEnabled("architecture")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Regression safety — existing plan_review_auto_chain still works
// ---------------------------------------------------------------------------

describe("readFleetConfig — plan_review_auto_chain regression safety", () => {
  it("still reads plan_review_auto_chain=true alongside auto_chain_stages", async () => {
    await withFleetJson(
      JSON.stringify({
        features: {
          plan_review_auto_chain: true,
          auto_chain_stages: stagesAllFalse(),
        },
      }),
    );
    const cfg = readFleetConfig();
    expect(cfg.plan_review_auto_chain).toBe(true);
    expect(cfg.auto_chain_stages).toEqual(stagesAllFalse());
  });

  it("still reads plan_review_auto_chain=false when auto_chain_stages is absent", async () => {
    await withFleetJson(
      JSON.stringify({ features: { plan_review_auto_chain: false } }),
    );
    const cfg = readFleetConfig();
    expect(cfg.plan_review_auto_chain).toBe(false);
    expect(cfg.auto_chain_stages).toEqual(stagesAllFalse());
  });

  it("still returns false when auto_chain_stages is malformed but plan_review_auto_chain is true", async () => {
    await withFleetJson(
      JSON.stringify({
        features: {
          plan_review_auto_chain: true,
          auto_chain_stages: "nope",
        },
      }),
    );
    const cfg = readFleetConfig();
    expect(cfg.plan_review_auto_chain).toBe(true);
    expect(cfg.auto_chain_stages).toEqual(stagesAllFalse());
  });
});
