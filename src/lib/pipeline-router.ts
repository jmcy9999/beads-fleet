// =============================================================================
// pipeline-router.ts — Application layer: pure, stateless helpers that expose
// the `pipeline-routes.ts` registry to consumers.
// =============================================================================
// Epic: factory-core-373o — Ship-type-aware pipeline routing
// Bead: factory-core-373o.2 — Router helpers + per-(shipType, stage) transition
//   test
//
// Layer: Application. No React imports. No I/O. No global state. Every public
// function is pure with respect to its arguments plus the compile-time-frozen
// `PIPELINE_ROUTES` constant.
//
// Exhaustiveness (ADR-006):
//   - Where dispatch on `shipType` is required, we use
//     `switch (shipType) { case "ios-app": ...; default: const _: never = ... }`
//     so adding a ninth ship type to the `ShipType` union without updating the
//     switch is a compile-time error on the `_: never` line (F1 AC-3).
//   - Where only a data lookup is needed, we rely on `Record<ShipType, ...>`
//     typing of `PIPELINE_ROUTES` — which ALSO makes an unhandled ship type a
//     compile error at lookup time.
//   - Both layers are complemented by a runtime `UnknownShipTypeError` throw
//     defending against untyped callers (ADR-004 — no iOS default anywhere).
//
// Consumers (added in Wave 3 — none in this bead):
//   - agent-launcher.ts (B3) — auto-chain via `nextStage` / `getNextChainAction`.
//   - fleet-utils.ts (B4) — `getStagesForShipType` powers `getPhaseHistory`.
//   - FleetCard.tsx (B5) — `getCTAsForStage` drives the CTA render map.
//   - route.ts (B6) — `isActionAllowed` gates every stage-specific API action.
//   - beads-close-gate.sh (B7, via the `closureChecklistId` filename contract).
//
// Regression patterns prevented:
//   - #7 Type Confusion on Enum Branching — exhaustiveness switches kill the
//     "switch missed a ship type" class (motivates factory-core-o13/bto).
//   - #13 Silent Exception Swallowing — unknown ship type never falls through
//     to an iOS default; it throws (ADR-004).
//   - #4 Validation Scattered — the router is the single validation site for
//     "is this action legal at (stage, shipType)?" (F5 AC-1..4).
// =============================================================================

import {
  PIPELINE_ROUTES,
  type AutoChainRule,
  type CTAId,
  type FleetStage,
  type PipelineRoute,
  type ShipType,
} from "./pipeline-routes";

// ---------------------------------------------------------------------------
// Re-exports so consumers import from one place (the router) rather than
// reaching into `pipeline-routes.ts` directly. Types only — this module has no
// dependency cycle with the registry.
// ---------------------------------------------------------------------------

export type { AutoChainRule, CTAId, FleetStage, PipelineRoute, ShipType };

// ---------------------------------------------------------------------------
// PipelineActionType — superset of what the Dashboard API accepts. The router
// accepts both `CTAId` and `PipelineActionType` values for `isActionAllowed`
// because the CTA button ID (clicked in FleetCard) and the API action name
// (posted to /api/fleet/action) are related but not always identical
// (e.g., the `launch` CTA at iOS submission-prep POSTs `approve-submission`).
//
// Re-exported as a type-only import — we do NOT import the React hook file's
// value exports here (that file is "use client" and ts-jest should not load
// React-only code into lib tests).
// ---------------------------------------------------------------------------

import type { PipelineActionType } from "@/hooks/usePipelineAction";
export type { PipelineActionType };

// ---------------------------------------------------------------------------
// UnknownShipTypeError — thrown by every router function when it receives a
// ship type not in `PIPELINE_ROUTES`. ADR-004: "no iOS default anywhere." The
// error message names the bad input so diagnostics land on the actual cause.
// ---------------------------------------------------------------------------

const VALID_SHIP_TYPES: readonly ShipType[] = Object.freeze([
  "ios-app",
  "macos-app",
  "web-app",
  "wordpress-plugin",
  "python-tool",
  "game",
  "internal",
  "venture",
]);

export class UnknownShipTypeError extends Error {
  /** The offending value, preserved for structured logging in consumers. */
  readonly shipType: unknown;

  constructor(shipType: unknown) {
    const display =
      shipType === ""
        ? "<empty string>"
        : shipType === undefined
          ? "<undefined>"
          : shipType === null
            ? "<null>"
            : String(shipType);
    super(
      `Unknown ship type: ${display}. Must be one of: ${VALID_SHIP_TYPES.join(", ")}.`,
    );
    this.name = "UnknownShipTypeError";
    this.shipType = shipType;
  }
}

// ---------------------------------------------------------------------------
// NoRouteError — defensive throw used when a runtime dispatch on `shipType`
// reaches a state that should have been unreachable per the exhaustive switch.
// Kept distinct from `UnknownShipTypeError` so consumers can tell "bad input"
// from "router invariant violated" in logs.
// ---------------------------------------------------------------------------

export class NoRouteError extends Error {
  readonly shipType: ShipType;
  readonly stage: FleetStage;
  constructor(shipType: ShipType, stage: FleetStage, reason: string) {
    super(
      `No route: shipType=${shipType} stage=${stage}: ${reason}. This should be unreachable — the registry guarantees a route per (shipType, stage) where one exists.`,
    );
    this.name = "NoRouteError";
    this.shipType = shipType;
    this.stage = stage;
  }
}

// ---------------------------------------------------------------------------
// assertShipType — runtime exhaustiveness guard.
//
// Every public function that accepts a `ShipType` calls this first. The
// switch-over-union pattern (`case "ios-app": ...; default: const _: never
// = shipType`) is the compile-time side of ADR-006: adding a ninth ship type
// to the `ShipType` union without updating this switch fails the build on
// the `const _: never = shipType` line (F1 AC-3 canary test covers this).
//
// The runtime throw is the defence-in-depth side: an untyped caller (e.g.,
// a raw HTTP body field) cannot silently default to iOS.
// ---------------------------------------------------------------------------

function assertShipType(shipType: ShipType): void {
  switch (shipType) {
    case "ios-app":
    case "macos-app":
    case "web-app":
    case "wordpress-plugin":
    case "python-tool":
    case "game":
    case "internal":
    case "venture":
      return;
    default: {
      // Exhaustiveness check — `shipType` is `never` here if the switch
      // covers every member of `ShipType`. A missing case turns this line
      // into TS2322 at compile time.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const _exhaustive: never = shipType;
      throw new UnknownShipTypeError(shipType);
    }
  }
}

// ---------------------------------------------------------------------------
// nextStage(stage, shipType)
//
// Reads the per-(shipType, stage) `nextStage` transition from the registry's
// `autoChain` map. Returns `undefined` when the registry does not declare a
// transition — the "stop for human review" equivalent of today's
// EXIT_LABELS behaviour (F2 AC-5). Never returns an iOS-default stage for a
// non-iOS ship type.
//
// If the autoChain rule at this stage is a `chainAction` (no `nextStage`),
// returns `undefined` — the caller must also call `getNextChainAction` when
// it needs to distinguish "transition to new stage" from "dispatch agent".
// ---------------------------------------------------------------------------

export function nextStage(
  stage: FleetStage,
  shipType: ShipType,
): FleetStage | undefined {
  assertShipType(shipType);
  const rule: AutoChainRule | undefined =
    PIPELINE_ROUTES[shipType].autoChain[stage];
  if (!rule) return undefined;
  // Narrow via the discriminated union — `nextStage` is only present on the
  // `{ nextStage, chainAction?: never }` variant. We check presence rather
  // than relying on structural typing so a future edit that (incorrectly)
  // sets both fields doesn't silently prefer one over the other.
  if ("nextStage" in rule && typeof rule.nextStage === "string") {
    return rule.nextStage;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// getNextChainAction(stage, shipType)
//
// Reads the per-(shipType, stage) `chainAction` dispatch rule. Returns
// `undefined` when the registry does not declare an agent dispatch — either
// because this stage transitions to a next stage (use `nextStage` instead)
// or because the registry declares no auto-chain at all.
// ---------------------------------------------------------------------------

export function getNextChainAction(
  stage: FleetStage,
  shipType: ShipType,
): PipelineActionType | undefined {
  assertShipType(shipType);
  const rule: AutoChainRule | undefined =
    PIPELINE_ROUTES[shipType].autoChain[stage];
  if (!rule) return undefined;
  if ("chainAction" in rule && typeof rule.chainAction === "string") {
    return rule.chainAction;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// getStagesForShipType(shipType)
//
// The ordered stages the board renders for this ship type. Used by B4 as the
// `order` input to `getPhaseHistory`, replacing today's
// `shipType === "venture" ? VENTURE_PIPELINE_ORDER : IOS_PIPELINE_ORDER`
// branch (F3 AC-1..4).
// ---------------------------------------------------------------------------

export function getStagesForShipType(
  shipType: ShipType,
): readonly FleetStage[] {
  assertShipType(shipType);
  return PIPELINE_ROUTES[shipType].stages;
}

// ---------------------------------------------------------------------------
// getCTAsForStage(stage, shipType)
//
// The CTA IDs legal at (stage, shipType) per the registry. Returns `[]` (a
// fresh, never-shared empty array) when the registry declares no CTAs — F4
// AC-4: "no fallback to a default CTA set." Callers iterate the returned
// array and look up renderers by ID (B5 `CTA_RENDERERS` map).
// ---------------------------------------------------------------------------

export function getCTAsForStage(
  stage: FleetStage,
  shipType: ShipType,
): readonly CTAId[] {
  assertShipType(shipType);
  return PIPELINE_ROUTES[shipType].ctas[stage] ?? [];
}

// ---------------------------------------------------------------------------
// ACTION_TO_CTA — map PipelineActionType values to their corresponding CTAId.
//
// Today's button layer uses `CTAId`s as the render-key space, while the
// server-side action layer uses `PipelineActionType`s. For most names the two
// are identical (`mark-as-live`, `send-back-to-dev`, `approve-plan`, …) and
// direct lookup in the registry's `ctas[stage]` suffices. A few legitimately
// differ — e.g., the iOS "Launch" button (CTAId `"launch"`) POSTs
// `approve-submission`, and the "Send back to dev" aliases resolve to the
// canonical `send-back-to-dev` CTAId.
//
// `isActionAllowed` tries the direct lookup first, then falls through to this
// map. Unmapped `PipelineActionType`s with no matching CTAId return `false`
// (unless stage-agnostic — see STAGE_AGNOSTIC_ACTIONS below).
// ---------------------------------------------------------------------------

const ACTION_TO_CTA: Partial<Record<PipelineActionType, CTAId>> = {
  "approve-submission": "launch",
  "send-to-development": "send-back-to-dev",
  "send-back-to-development": "send-back-to-dev",
};

// ---------------------------------------------------------------------------
// STAGE_AGNOSTIC_ACTIONS — actions that are legal at any stage for any ship
// type so long as the epic exists. `stop-agent` kills a running agent;
// `deprioritise` marks any epic bad-idea; `human-approve` / `human-dismiss`
// resolve human-decision labels regardless of pipeline position.
//
// These bypass the `ctas[stage]` check. B6 (route.ts guards) wraps these in
// a separate code path that requires ship type to be known (so a missing
// `ship-type:*` label still returns 400) but does not require the action to
// appear in the registry's CTA list.
// ---------------------------------------------------------------------------

const STAGE_AGNOSTIC_ACTIONS: readonly (PipelineActionType | CTAId)[] =
  Object.freeze([
    "stop-agent",
    "deprioritise",
    "human-approve",
    "human-dismiss",
  ]);

// ---------------------------------------------------------------------------
// isActionAllowed(action, shipType, stage)
//
// The single validation site for "is this API action / CTA click legal at
// (stage, shipType)?" (F5 AC-1..4). Used server-side by route.ts (B6) and
// client-side can mirror by calling the same function — both paths source
// their decision from the same helper, eliminating drift (regression pattern
// #4 Validation Scattered).
//
// Algorithm:
//   1. Validate shipType (throws UnknownShipTypeError on unknown input —
//      ADR-004, F5 AC-3).
//   2. Stage-agnostic actions (stop-agent, deprioritise, …) => true.
//   3. Direct CTAId lookup in `ctas[stage]` — covers actions whose
//      PipelineActionType matches a CTAId 1:1.
//   4. PipelineActionType → CTAId via ACTION_TO_CTA, then look up.
//   5. Otherwise => false.
//
// Crucially, `false` is never caused by "this ship type is iOS-shaped and we
// forgot to declare the CTA" — the registry is the source of truth and
// consumers that need a new legal action must add it there.
// ---------------------------------------------------------------------------

export function isActionAllowed(
  action: PipelineActionType | CTAId,
  shipType: ShipType,
  stage: FleetStage,
): boolean {
  assertShipType(shipType);

  if (STAGE_AGNOSTIC_ACTIONS.includes(action)) return true;

  const ctasAtStage = PIPELINE_ROUTES[shipType].ctas[stage] ?? [];

  // Direct lookup — handles actions whose names are also CTAIds
  // (e.g., "mark-as-live", "send-back-to-dev", "approve-plan").
  if ((ctasAtStage as readonly string[]).includes(action)) return true;

  // Indirect lookup — e.g., "approve-submission" → "launch".
  const mappedCtaId = ACTION_TO_CTA[action as PipelineActionType];
  if (mappedCtaId && ctasAtStage.includes(mappedCtaId)) return true;

  return false;
}

// ---------------------------------------------------------------------------
// getClosureChecklistId(shipType)
//
// Returns the checklist-id bound to this ship type. The registry's
// `closureChecklistId` is typed as `ShipType` (not a free-form string) so the
// filename `.beads/checklists/epic-<id>.md` is always derivable from the ship
// type alone — no JSON sidecar, no shared config file (ADR-001, ADR-002).
// Used by B7's shell rewrite.
// ---------------------------------------------------------------------------

export function getClosureChecklistId(shipType: ShipType): ShipType {
  assertShipType(shipType);
  return PIPELINE_ROUTES[shipType].closureChecklistId;
}
