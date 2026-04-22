// =============================================================================
// Ship-type-aware pipeline routing registry — single source of truth.
// =============================================================================
// Every consumer of pipeline routing (auto-chain, phase history, FleetCard,
// action endpoints, closure gate) reads from this registry. No consumer may
// hardcode a stage sequence, a next-stage transition, or a ship-type-specific
// branch outside this file.
//
// Epic: factory-core-373o — Ship-type-aware pipeline routing
// Bead: factory-core-373o.1 — Create pipeline-routes.ts registry
//
// See:
//   - docs/research/ship-type-aware-pipeline-routing-architecture.md (ADR-001, 003, 006)
//   - docs/research/ship-type-aware-pipeline-routing-functional-spec.md (F1)
//   - CLAUDE.md § Platform-Specific Stages
//
// Layer: Domain (pure config). ZERO non-type imports — if a value needs to be
// computed from the registry, it belongs in pipeline-router.ts (B2), not here.
//
// Guardrails (standards/platforms/internal/guardrails.md):
// - Guardrail 2 (no silent data drift): this file is the only place ship-type
//   stage sequences are declared. Consumers import from here.
// - Guardrail 5 (test the data, not just the code): companion test file
//   pipeline-routes.test.ts verifies every ship-type row against the golden
//   files (IOS_PIPELINE_ORDER, VENTURE_PIPELINE_ORDER) and the CLAUDE.md
//   table, plus asserts every closureChecklistId has a file on disk.
// =============================================================================

import type { ShipType, FleetStage } from "@/components/fleet/fleet-utils";
import type { PipelineActionType } from "@/hooks/usePipelineAction";

export type { ShipType, FleetStage };

// ---------------------------------------------------------------------------
// CTAId — string-literal union of every button the Dashboard can render on a
// FleetCard. Each ID maps 1:1 to a render function in FleetCard-ctas.tsx
// (added by factory-core-373o.5). Keeping these as string IDs — not JSX —
// preserves the Domain-layer rule that this module has no React dependency
// (ADR-003).
// ---------------------------------------------------------------------------

export type CTAId =
  | "launch"
  | "send-back-to-dev"
  | "revise-plan-from-launch"
  | "mark-as-live"
  | "mark-deployed"
  | "mark-venture-live"
  | "mark-venture-complete"
  | "approve-plan"
  | "approve-and-build"
  | "skip-to-plan"
  | "run-pm"
  | "run-architect"
  | "revise-spec"
  | "revise-architecture"
  | "start-wave"
  | "review-wave"
  | "start-research"
  | "more-research"
  | "deprioritise"
  | "send-for-qa"
  | "resume-build";

// ---------------------------------------------------------------------------
// AutoChainRule — one transition rule at one stage.
//
// Discriminated union: exactly one of `nextStage` / `chainAction` MUST be set.
// Setting both, or neither, is a compile-time error — the `never` side of each
// variant rejects the opposite field, and the required field forces a value.
// The router (factory-core-373o.2) adds a runtime assertion as defence in
// depth for untyped callers.
//
//   { nextStage: "submitted" }                       // OK — transition only
//   { chainAction: "run-pm" }                        // OK — agent dispatch only
//   { nextStage: "x", chainAction: "y" }             // ✗ compile error
//   {}                                               // ✗ compile error
//
// Semantics: `nextStage` removes the current `pipeline:*` label and adds
// `pipeline:<nextStage>`. `chainAction` POSTs to /api/fleet/action — used when
// the transition requires spawning an agent (e.g., research-complete → run-pm).
// ---------------------------------------------------------------------------

export type AutoChainRule =
  | { readonly nextStage: FleetStage; readonly chainAction?: never }
  | { readonly chainAction: PipelineActionType; readonly nextStage?: never };

// ---------------------------------------------------------------------------
// PipelineRoute — one per ship type. Describes how the pipeline runs for that
// ship type: which stages render, what auto-chain does at each stage, which
// CTAs are legal at each stage, and which closure-checklist file the shell
// gates load.
// ---------------------------------------------------------------------------

export interface PipelineRoute {
  /**
   * Ordered stages the board renders for this ship type. Must be a subset of
   * FleetStage. Must start with "idea" and end with "completed". Must not
   * contain duplicates.
   */
  readonly stages: readonly FleetStage[];

  /**
   * Per-stage auto-chain rule. Absence means "stop at this stage for human
   * review" (today's EXIT_LABELS behaviour). Present entries replace today's
   * NEXT_STAGE constant in agent-launcher.ts (factory-core-373o.3).
   */
  readonly autoChain: Partial<Record<FleetStage, AutoChainRule>>;

  /**
   * Per-stage CTA list. Absence means "no CTAs at this stage" — the card does
   * not fall through to a default CTA set (F4 AC-4). Empty array means
   * "terminal stage, show nothing". Populated by factory-core-373o.5 when
   * FleetCard migrates to registry-driven CTAs.
   */
  readonly ctas: Partial<Record<FleetStage, readonly CTAId[]>>;

  /**
   * Identifies which `<fleet-core>/.beads/checklists/epic-<id>.md` file the
   * closure gate prints. Typed as ShipType (not an arbitrary string) to
   * guarantee one checklist per ship type, no aliasing, no fallback.
   */
  readonly closureChecklistId: ShipType;
}

// ---------------------------------------------------------------------------
// Shared stage prefixes — kept as module-internal constants.
//
// Composing from shared prefixes (rather than duplicating long arrays in each
// ship-type row) reduces the chance of per-row drift. The golden-file test
// (pipeline-routes.test.ts test 1) asserts the resulting stages arrays remain
// equivalent to today's IOS_PIPELINE_ORDER / VENTURE_PIPELINE_ORDER pre-
// platform-specific stages (ADR-005).
// ---------------------------------------------------------------------------

/** Stages every non-venture ship type shares, up to and including `qa`. */
const UNIVERSAL_PRE_PLATFORM_STAGES = [
  "idea",
  "research",
  "research-complete",
  "product-spec",
  "architecture",
  "plan-review",
  "test-spec",
  "development",
  "qa",
] as const satisfies readonly FleetStage[];

/** Platform tail for ship types that go through App-Store-style submission. */
const SUBMISSION_TAIL = [
  "submission-prep",
  "submitted",
  "kit-management",
  "completed",
] as const satisfies readonly FleetStage[];

/** Platform tail for ship types that deploy directly (no store submission). */
const DEPLOY_TAIL = [
  "deploying",
  "live",
  "kit-management",
  "completed",
] as const satisfies readonly FleetStage[];

// ---------------------------------------------------------------------------
// Shared auto-chain rules.
//
// These mirror today's auto-chain behaviour documented in CLAUDE.md §
// Pipeline Labels (research-complete → run-pm, product-spec → run-architect,
// architecture → generate-plan, test-spec → start-wave). Consumer migration
// (factory-core-373o.3) will update agent-launcher.ts to read from here
// rather than from the inline NEXT_STAGE / chain-action map.
// ---------------------------------------------------------------------------

const UNIVERSAL_AUTO_CHAIN_PRE_QA: Partial<Record<FleetStage, AutoChainRule>> = {
  "research-complete": { chainAction: "run-pm" },
  "product-spec": { chainAction: "run-architect" },
  architecture: { chainAction: "generate-plan" },
  "test-spec": { chainAction: "start-wave" },
};

/** Tail auto-chain for submission-style pipelines (mirrors today's NEXT_STAGE). */
const SUBMISSION_TAIL_AUTO_CHAIN: Partial<Record<FleetStage, AutoChainRule>> = {
  qa: { nextStage: "submission-prep" },
  "submission-prep": { nextStage: "submitted" },
  "kit-management": { nextStage: "completed" },
};

/** Tail auto-chain for deploy-style pipelines. */
const DEPLOY_TAIL_AUTO_CHAIN: Partial<Record<FleetStage, AutoChainRule>> = {
  qa: { nextStage: "deploying" },
  deploying: { nextStage: "live" },
  live: { nextStage: "kit-management" },
  "kit-management": { nextStage: "completed" },
};

// ---------------------------------------------------------------------------
// PIPELINE_ROUTES — the registry.
//
// Typed as Record<ShipType, PipelineRoute> so TypeScript fails the build if a
// new ship type is added to the ShipType union without a corresponding row
// (F1 AC-2, ADR-006). A caller attempting PIPELINE_ROUTES["not-a-type"]
// without casting gets a compile-time error rather than undefined at runtime.
// ---------------------------------------------------------------------------

export const PIPELINE_ROUTES: Record<ShipType, PipelineRoute> = {
  "ios-app": {
    stages: [...UNIVERSAL_PRE_PLATFORM_STAGES, ...SUBMISSION_TAIL],
    autoChain: {
      ...UNIVERSAL_AUTO_CHAIN_PRE_QA,
      ...SUBMISSION_TAIL_AUTO_CHAIN,
    },
    // B2 seeds the iOS submission-prep CTAs so `isActionAllowed` can
    // discriminate "approve-submission for ios-app at submission-prep"
    // (legal) from "approve-submission for internal" (illegal). B5 will
    // extend CTA coverage to every stage × ship type; until then other
    // stages legitimately declare no CTAs (ctas[stage] === undefined),
    // which `getCTAsForStage` surfaces as `[]` (never iOS-default).
    ctas: {
      "submission-prep": [
        "launch",
        "send-back-to-dev",
        "revise-plan-from-launch",
      ],
    },
    closureChecklistId: "ios-app",
  },

  "macos-app": {
    stages: [...UNIVERSAL_PRE_PLATFORM_STAGES, ...SUBMISSION_TAIL],
    autoChain: {
      ...UNIVERSAL_AUTO_CHAIN_PRE_QA,
      ...SUBMISSION_TAIL_AUTO_CHAIN,
    },
    ctas: {},
    closureChecklistId: "macos-app",
  },

  "wordpress-plugin": {
    // CLAUDE.md: compliance-check → package → submitted. These collapse to
    // the submission-prep / submitted FleetStage columns today (see
    // fleet-utils.ts#detectStage). FleetStage-level route mirrors ios-app.
    stages: [...UNIVERSAL_PRE_PLATFORM_STAGES, ...SUBMISSION_TAIL],
    autoChain: {
      ...UNIVERSAL_AUTO_CHAIN_PRE_QA,
      ...SUBMISSION_TAIL_AUTO_CHAIN,
    },
    ctas: {},
    closureChecklistId: "wordpress-plugin",
  },

  "web-app": {
    stages: [...UNIVERSAL_PRE_PLATFORM_STAGES, ...DEPLOY_TAIL],
    autoChain: {
      ...UNIVERSAL_AUTO_CHAIN_PRE_QA,
      ...DEPLOY_TAIL_AUTO_CHAIN,
    },
    ctas: {},
    closureChecklistId: "web-app",
  },

  "python-tool": {
    // CLAUDE.md: package (PyPI) → deploying. `package` collapses to
    // submission-prep today; at FleetStage-column level this product type
    // goes qa → deploying (future v2 will split `package` out per D1).
    stages: [...UNIVERSAL_PRE_PLATFORM_STAGES, ...DEPLOY_TAIL],
    autoChain: {
      ...UNIVERSAL_AUTO_CHAIN_PRE_QA,
      ...DEPLOY_TAIL_AUTO_CHAIN,
    },
    ctas: {},
    closureChecklistId: "python-tool",
  },

  game: {
    // CLAUDE.md: playtest → deploying. `playtest` is not yet in FleetStage
    // (added when the game dock is built, D3); FleetStage-level route is the
    // deploy tail.
    stages: [...UNIVERSAL_PRE_PLATFORM_STAGES, ...DEPLOY_TAIL],
    autoChain: {
      ...UNIVERSAL_AUTO_CHAIN_PRE_QA,
      ...DEPLOY_TAIL_AUTO_CHAIN,
    },
    ctas: {},
    closureChecklistId: "game",
  },

  internal: {
    // CLAUDE.md: internal skips compliance-check / submission-prep /
    // submitted / awaiting-review / in-review — goes qa → deploying → live.
    // F1 AC-5 asserts those stages are absent from this route.
    stages: [...UNIVERSAL_PRE_PLATFORM_STAGES, ...DEPLOY_TAIL],
    autoChain: {
      ...UNIVERSAL_AUTO_CHAIN_PRE_QA,
      ...DEPLOY_TAIL_AUTO_CHAIN,
    },
    ctas: {},
    closureChecklistId: "internal",
  },

  venture: {
    // Matches VENTURE_PIPELINE_ORDER in fleet-utils.ts (preserved verbatim
    // for golden-file equivalence — test 1 asserts equality). Venture is
    // research-only; if the recon decision is "go", a product epic is
    // spawned with a real ship type.
    stages: [
      "idea",
      "research",
      "research-complete",
      "plan-review",
      "development",
      "deploying",
      "live",
      "completed",
    ],
    autoChain: {},
    ctas: {},
    closureChecklistId: "venture",
  },
};
