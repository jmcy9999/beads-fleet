// =============================================================================
// Tests for src/lib/pipeline-routes.ts (factory-core-373o.1)
// =============================================================================
// Three tests enforce the acceptance criteria for the registry:
//
//   1. Golden-file equivalence — every non-venture ship type's stages match
//      today's IOS_PIPELINE_ORDER pre-platform-specific tail; venture matches
//      VENTURE_PIPELINE_ORDER verbatim. Proves the registry is behaviour-
//      preserving before any consumer migrates (ADR-005).
//
//   2. CLAUDE.md table mirror — an inline snapshot of CLAUDE.md § Platform-
//      Specific Stages asserts each ship type's stages match the documented
//      sequence at FleetStage resolution. Any divergence fails with a diff
//      (F7 AC-2).
//
//   3. Checklist-file existence — for every ship type in the registry, asserts
//      <fleet-core>/.beads/checklists/epic-${closureChecklistId}.md exists
//      on disk. Prevents drift between the registry and the checklist files
//      (ADR-001 consequence).
//
// Edge cases (compile-time @ts-expect-error):
//   - Bad ship-type key into PIPELINE_ROUTES is a type error (F1 AC-2).
//   - AutoChainRule with both or neither field is a type error (discriminated
//     union).
//
// Guardrail 5 (standards/platforms/internal/guardrails.md): test the data,
// not just the code — these assertions run against the actual registry values
// and the actual checklist files on disk.
// =============================================================================

import * as fs from "fs";
import * as path from "path";

import {
  PIPELINE_ROUTES,
  type AutoChainRule,
  type CTAId,
  type FleetStage,
  type PipelineRoute,
  type ShipType,
} from "@/lib/pipeline-routes";
import {
  IOS_PIPELINE_ORDER,
  VENTURE_PIPELINE_ORDER,
} from "@/components/fleet/fleet-utils";

// ---------------------------------------------------------------------------
// Fleet-core path resolution — matches repo-path-resolver.ts convention so
// the checklist-existence test works in CI and locally.
// ---------------------------------------------------------------------------

const FLEET_CORE_PATH =
  process.env.FLEET_CORE_PATH || "/Users/janemckay/dev/fleet/fleet-core";

// ---------------------------------------------------------------------------
// Complete list of ship types, sourced from the registry itself. Typed as
// ShipType[] (not readonly) so individual tests can iterate.
// ---------------------------------------------------------------------------

const ALL_SHIP_TYPES: ShipType[] = [
  "ios-app",
  "macos-app",
  "web-app",
  "wordpress-plugin",
  "python-tool",
  "game",
  "internal",
  "venture",
];

// The set of ship types that previously (pre-373o) routed through the iOS
// pipeline shape — IOS_PIPELINE_ORDER in fleet-utils.ts. All non-venture ship
// types. The prefix up through `qa` must match IOS_PIPELINE_ORDER exactly
// (test 1 below).
const IOS_SHAPED_SHIP_TYPES: readonly ShipType[] = [
  "ios-app",
  "macos-app",
  "web-app",
  "wordpress-plugin",
  "python-tool",
  "game",
  "internal",
];

// ---------------------------------------------------------------------------
// Test 1: Golden-file equivalence (ADR-005)
// ---------------------------------------------------------------------------

describe("PIPELINE_ROUTES — golden-file equivalence", () => {
  // The shared pre-platform prefix every non-venture ship type must begin
  // with. This is IOS_PIPELINE_ORDER up to and including "qa". Beyond "qa",
  // each ship type's stages tail is platform-specific (submission vs deploy).
  const qaIndexInIos = IOS_PIPELINE_ORDER.indexOf("qa");
  const PRE_PLATFORM_PREFIX = IOS_PIPELINE_ORDER.slice(0, qaIndexInIos + 1);

  test.each(IOS_SHAPED_SHIP_TYPES)(
    "%s's stages start with the pre-platform prefix from IOS_PIPELINE_ORDER",
    (shipType) => {
      const route = PIPELINE_ROUTES[shipType];
      const prefix = route.stages.slice(0, PRE_PLATFORM_PREFIX.length);
      expect(prefix).toEqual(PRE_PLATFORM_PREFIX);
    },
  );

  it("ios-app's stages equal IOS_PIPELINE_ORDER verbatim (behaviour preservation)", () => {
    // ios-app is the reference shape: the ship type every other non-venture
    // ship type previously defaulted to. Preserving IOS_PIPELINE_ORDER
    // exactly for ios-app guarantees iOS behaviour is unchanged by this
    // refactor (F2 AC-2).
    expect(PIPELINE_ROUTES["ios-app"].stages).toEqual(IOS_PIPELINE_ORDER);
  });

  it("venture's stages equal VENTURE_PIPELINE_ORDER verbatim", () => {
    // Venture keeps its existing research-only shape. Golden-file guard
    // against accidental divergence from fleet-utils.ts.
    expect(PIPELINE_ROUTES.venture.stages).toEqual(VENTURE_PIPELINE_ORDER);
  });
});

// ---------------------------------------------------------------------------
// Test 2: CLAUDE.md table mirror (F7 AC-2)
// ---------------------------------------------------------------------------

describe("PIPELINE_ROUTES — CLAUDE.md § Platform-Specific Stages mirror", () => {
  // Inline snapshot of the CLAUDE.md § Platform-Specific Stages table, at
  // FleetStage-column resolution. Many documented pipeline labels collapse
  // to a single FleetStage column (see fleet-utils.ts#detectStage):
  //
  //   - compliance-check, submission-prep, package   → "submission-prep"
  //   - submitted, awaiting-review, in-review        → "submitted"
  //   - qa-round-1..N, ux-polish, qa-review,
  //     security-review                              → "qa"
  //
  // The snapshot captures the expected FleetStage sequence for each ship
  // type. When CLAUDE.md changes (e.g., a new stage is introduced in the
  // Platform-Specific Stages table) this snapshot must be updated in lock-
  // step. That is the point of the test — documentation and code stay
  // bound together.
  const CLAUDE_MD_SNAPSHOT: Record<ShipType, readonly FleetStage[]> = {
    "ios-app": [
      "idea",
      "research",
      "research-complete",
      "product-spec",
      "architecture",
      "plan-review",
      "test-spec",
      "development",
      "qa",
      "submission-prep",
      "submitted",
      "kit-management",
      "completed",
    ],
    "macos-app": [
      "idea",
      "research",
      "research-complete",
      "product-spec",
      "architecture",
      "plan-review",
      "test-spec",
      "development",
      "qa",
      "submission-prep",
      "submitted",
      "kit-management",
      "completed",
    ],
    "wordpress-plugin": [
      "idea",
      "research",
      "research-complete",
      "product-spec",
      "architecture",
      "plan-review",
      "test-spec",
      "development",
      "qa",
      "submission-prep",
      "submitted",
      "kit-management",
      "completed",
    ],
    "web-app": [
      "idea",
      "research",
      "research-complete",
      "product-spec",
      "architecture",
      "plan-review",
      "test-spec",
      "development",
      "qa",
      "deploying",
      "live",
      "kit-management",
      "completed",
    ],
    "python-tool": [
      "idea",
      "research",
      "research-complete",
      "product-spec",
      "architecture",
      "plan-review",
      "test-spec",
      "development",
      "qa",
      "deploying",
      "live",
      "kit-management",
      "completed",
    ],
    game: [
      "idea",
      "research",
      "research-complete",
      "product-spec",
      "architecture",
      "plan-review",
      "test-spec",
      "development",
      "qa",
      "deploying",
      "live",
      "kit-management",
      "completed",
    ],
    // F1 AC-5 — internal skips compliance-check / submission-prep /
    // submitted / awaiting-review / in-review.
    internal: [
      "idea",
      "research",
      "research-complete",
      "product-spec",
      "architecture",
      "plan-review",
      "test-spec",
      "development",
      "qa",
      "deploying",
      "live",
      "kit-management",
      "completed",
    ],
    venture: [
      "idea",
      "research",
      "research-complete",
      "plan-review",
      "development",
      "deploying",
      "live",
      "completed",
    ],
  };

  test.each(ALL_SHIP_TYPES)(
    "%s's stages match the CLAUDE.md snapshot",
    (shipType) => {
      const expected = CLAUDE_MD_SNAPSHOT[shipType];
      const actual = PIPELINE_ROUTES[shipType].stages;
      // Using toEqual gives a diff in the failure output, which points to
      // the exact stage that drifted (F7 AC-2).
      expect(actual).toEqual(expected);
    },
  );

  it("internal route does NOT contain iOS-submission stages (F1 AC-5)", () => {
    const internalStages = PIPELINE_ROUTES.internal.stages;
    // The stages CLAUDE.md says internal must skip. At FleetStage column
    // resolution, awaiting-review and in-review collapse into "submitted";
    // compliance-check collapses into "submission-prep". The assertion on
    // "submission-prep" and "submitted" covers all five listed stages.
    expect(internalStages).not.toContain("submission-prep");
    expect(internalStages).not.toContain("submitted");
  });

  it("every ship type's stages start with 'idea' and end with 'completed'", () => {
    for (const shipType of ALL_SHIP_TYPES) {
      const stages = PIPELINE_ROUTES[shipType].stages;
      expect(stages[0]).toBe("idea");
      expect(stages[stages.length - 1]).toBe("completed");
    }
  });

  it("no ship type's stages contain duplicates", () => {
    for (const shipType of ALL_SHIP_TYPES) {
      const stages = PIPELINE_ROUTES[shipType].stages;
      const unique = new Set(stages);
      expect(unique.size).toBe(stages.length);
    }
  });
});

// ---------------------------------------------------------------------------
// Test 3: Checklist-file existence (ADR-001 consequence)
// ---------------------------------------------------------------------------

describe("PIPELINE_ROUTES — closure checklist files exist on disk", () => {
  test.each(ALL_SHIP_TYPES)(
    "%s has a checklist file at .beads/checklists/epic-<id>.md",
    (shipType) => {
      const route = PIPELINE_ROUTES[shipType];
      const checklistPath = path.join(
        FLEET_CORE_PATH,
        ".beads",
        "checklists",
        `epic-${route.closureChecklistId}.md`,
      );
      // Using fs.existsSync here — the test is intentionally data-level
      // (Guardrail 5). If this fails, the fix is to add the checklist
      // file, not to silence the test.
      const exists = fs.existsSync(checklistPath);
      expect({ shipType, checklistPath, exists }).toEqual({
        shipType,
        checklistPath,
        exists: true,
      });
    },
  );

  it("closureChecklistId matches the ship type (1:1, no aliasing)", () => {
    // ADR-001: "one checklist per ship type, no aliasing, no fallback." The
    // closureChecklistId type is `ShipType` itself, so this is enforced at
    // compile time, but we double-check the actual value here in case a
    // future edit introduces an alias (e.g., closureChecklistId: "ios-app"
    // on a wordpress-plugin row).
    for (const shipType of ALL_SHIP_TYPES) {
      expect(PIPELINE_ROUTES[shipType].closureChecklistId).toBe(shipType);
    }
  });
});

// ---------------------------------------------------------------------------
// Edge-case: compile-time exhaustiveness (F1 AC-2)
// ---------------------------------------------------------------------------

describe("PIPELINE_ROUTES — compile-time exhaustiveness", () => {
  it("rejects unknown ship-type keys at compile time", () => {
    // The TS directive below is the test. The test passes if TypeScript
    // reports an error on the line (and the directive suppresses it). If a
    // future edit breaks the Record<ShipType, ...> typing, the directive
    // becomes unused and ts-jest fails the build with TS2578.
    // @ts-expect-error -- "not-a-ship-type" is not a valid ShipType key.
    const _unknown = PIPELINE_ROUTES["not-a-ship-type"];
    // Reference _unknown to silence no-unused-vars linters.
    expect(typeof _unknown).toBe("undefined");
  });

  it("rejects AutoChainRule with both nextStage and chainAction", () => {
    // @ts-expect-error — AutoChainRule is a discriminated union; setting
    // both fields is forbidden (the `never` side of each variant rejects
    // the opposite field).
    const _both: AutoChainRule = { nextStage: "qa", chainAction: "run-pm" };
    expect(_both).toBeDefined();
  });

  it("rejects AutoChainRule with neither nextStage nor chainAction", () => {
    // @ts-expect-error — AutoChainRule requires exactly one of the two
    // fields. An empty object satisfies neither variant.
    const _neither: AutoChainRule = {};
    expect(_neither).toBeDefined();
  });

  it("PipelineRoute.closureChecklistId must be a ShipType literal", () => {
    const _bad: PipelineRoute = {
      stages: ["idea", "completed"],
      autoChain: {},
      ctas: {},
      // @ts-expect-error -- "arbitrary-string" is not a ShipType.
      closureChecklistId: "arbitrary-string",
    };
    expect(_bad).toBeDefined();
  });

  it("CTAId is a closed string union (unknown IDs rejected)", () => {
    // @ts-expect-error — "not-a-cta" is not in the CTAId union.
    const _bad: CTAId = "not-a-cta";
    expect(_bad).toBeDefined();
  });
});
