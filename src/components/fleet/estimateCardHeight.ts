// =============================================================================
// estimateCardHeight — pure height estimator for FleetCard inside a
// VariableSizeList row. (factory-core-3p1e.9)
// =============================================================================
//
// FleetColumn virtualises its card list with `react-window`'s VariableSizeList.
// VariableSizeList demands a per-index `itemSize(index) => height` function
// rather than measuring DOM. This module provides that function as a pure
// computation over a FleetApp's props.
//
// Design notes:
//   - Pure function, no DOM, no `useRef`. Same input → same output.
//   - Exhaustive: every conditional section in FleetCard.tsx that contributes
//     to height gets a corresponding HEIGHTS contribution here. If a section
//     is ever added or removed in FleetCard, this file MUST be updated to
//     match — the estimator is the contract.
//   - Slightly conservative. VariableSizeList tolerates small overestimates
//     (whitespace at the row tail) but underestimates clip card content.
//     We intentionally bias upward where wrapping/line-clamp could push the
//     card a hair taller than the nominal value.
//   - Returns the row height including the inter-card gap (CARD_GAP).
//     FleetColumn's pre-virtualisation layout used `space-y-1.5` (= 6px)
//     between cards; we bake that gap into the returned height so the
//     visual rhythm survives virtualisation.
//
// =============================================================================

import type { FleetApp } from "./fleet-utils";
import { isAgentRunning } from "./fleet-utils";

// ---------------------------------------------------------------------------
// Section heights — each constant maps to one rendered section in
// src/components/fleet/FleetCard.tsx. Comments cite the FleetCard line ranges
// at the time of authorship (2026-04-29).
// ---------------------------------------------------------------------------

/** p-2 padding on the card outer Link (top + bottom). */
const CARD_PADDING = 16;

/**
 * space-y-1.5 between cards baked into the row height. The card's actual
 * rendered height = returned height - CARD_GAP; the difference is empty
 * space below the card.
 */
const CARD_GAP = 6;

/**
 * Header row: epic id + ship-type pill + relative-date span +
 * agent-running indicator + priority indicator. mb-1.5 trailing margin.
 * (FleetCard.tsx ~lines 250-284)
 */
const HEADER = 28;

/**
 * App name h3 with line-clamp-2 (text-xs, mb-1.5). Two-line worst case.
 * Most epic titles fit on a single line in a 220px-wide column, but we
 * estimate for two lines to avoid clipping.
 * (FleetCard.tsx ~line 287)
 */
const APP_NAME = 38;

/**
 * Footer with status badge + per-stage stats (blocked / in-progress / owner).
 * (FleetCard.tsx ~lines 421-436)
 */
const FOOTER = 22;

/**
 * Phase history dots row (mt-2 pt-2 border-t + dot strip).
 * (FleetCard.tsx ~lines 439-468)
 */
const PHASE_HISTORY = 26;

/**
 * Progress bar (h-1.5 + mb-2). Rendered when effectiveProgress.total > 0.
 * (FleetCard.tsx ~lines 290-302)
 */
const PROGRESS_BAR = 18;

/**
 * Wave info pill row + per-wave progress bars + mb-2. Rendered when waveInfo
 * exists (i.e. waveProgress is non-empty).
 * (FleetCard.tsx ~lines 305-338)
 */
const WAVE_INFO = 48;

/**
 * Submission state pill row + mb-2. Rendered when at least one
 * submission:* label exists on the epic or any child.
 * (FleetCard.tsx ~lines 341-352)
 */
const SUBMISSION_BADGES = 26;

/**
 * Quick-link row "Research" / "Plan" + mb-2. Rendered for any non-idea
 * stage.
 * (FleetCard.tsx ~lines 355-370)
 */
const QUICK_LINKS = 22;

/**
 * "View in Langfuse" link + mb-2. Rendered when langfuseTraceUrl is set.
 * (FleetCard.tsx ~lines 373-385)
 */
const LANGFUSE = 22;

/**
 * Research-report snippet, line-clamp-3 + text-[10px] leading-relaxed +
 * mb-2. Rendered when extractSnippet found content. Three-line worst case.
 * (FleetCard.tsx ~lines 388-392)
 */
const SNIPPET = 56;

/**
 * Cost block base: border-t + label row + total. mb-2. Rendered when
 * cost && cost.totalCost > 0.
 * (FleetCard.tsx ~lines 395-417)
 */
const COST_BASE = 38;

/**
 * Phase-by-phase breakdown row inside the cost block. Added on top of
 * COST_BASE when cost.phases.length > 1.
 */
const COST_PHASES = 18;

/**
 * Each rendered AttentionBanner item (label + reason + action button).
 * Multiple items stack; we charge this per item.
 * (AttentionBanner.tsx)
 */
const ATTENTION_BANNER_PER_ITEM = 56;

/** Top margin on the action-button block (mt-2). */
const ACTION_BLOCK_MARGIN = 8;

/**
 * Per-button height including the gap-1.5 (6px) below it. Buttons render
 * with `text-xs px-3 py-1.5` (~32px) and the column has `gap-1.5` between
 * children — we charge the gap with each button so a single-button column
 * doesn't pay for a non-existent gap.
 */
const ACTION_BUTTON = 38;

/** A status line/text label rendered inline among action buttons. */
const ACTION_TEXT = 24;

/** QA-round badge pill rendered above QA action buttons. */
const QA_ROUND_BADGE = 22;

/**
 * The inline review-file link (underlined `<a>`) in plan-review sub-states.
 */
const REVIEW_FILE_LINK = 20;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Whether the Langfuse-link section will render.
 * NOTE: The estimator never has a langfuseTraceUrl — that's looked up
 * upstream by FleetBoard via a Map keyed on epic id, and only present when
 * an agent is actively running. We approximate by treating "agent-running"
 * as "Langfuse link will render". This may overestimate slightly for epics
 * whose langfuse URL hasn't loaded yet, but underestimating would clip.
 */
function rendersLangfuseLink(app: FleetApp): boolean {
  return isAgentRunning(app.epic);
}

/**
 * Whether a snippet section will render.
 * NOTE: snippet is fetched async by FleetCard. The estimator can't fetch.
 * We approximate by treating any non-idea stage as "snippet may render".
 * This bias errs toward overestimation, leaving harmless whitespace if no
 * snippet ever loads.
 */
function rendersSnippet(app: FleetApp): boolean {
  return app.stage !== "idea" && app.stage !== "bad-idea";
}

/**
 * Whether the wave-info row will render. Mirrors the FleetCard logic:
 * wave info shows when getWaveInfo(children) returns a non-empty array OR
 * crossRepoWaveData is provided. Approximated here from local children
 * only — internal epics use this path; for non-internal epics the cross-
 * repo lookup may add waves we can't see, but the estimator is bias-up so
 * a missed wave is acceptable.
 */
function rendersWaveInfo(app: FleetApp): boolean {
  const waveLabels = new Set<number>();
  for (const child of app.children) {
    for (const label of child.labels ?? []) {
      const m = label.match(/^wave:(\d+)$/);
      if (m) waveLabels.add(parseInt(m[1], 10));
    }
  }
  return waveLabels.size > 0;
}

/**
 * Whether at least one submission:* label exists on epic or children.
 */
function rendersSubmissionBadges(app: FleetApp): boolean {
  const hasOnEpic = (app.epic.labels ?? []).some((l) => l.startsWith("submission:"));
  if (hasOnEpic) return true;
  return app.children.some((c) => (c.labels ?? []).some((l) => l.startsWith("submission:")));
}

/**
 * Estimated number of action buttons rendered for this app's stage,
 * including any agent-running variant. Returns the (button-count,
 * extra-text-lines) tuple so we can charge ACTION_TEXT separately.
 */
function actionButtonShape(
  app: FleetApp,
): { buttons: number; texts: number; extras: number } {
  const agentRunning = isAgentRunning(app.epic);
  const stage = app.stage;
  const labels = app.epic.labels ?? [];

  // Helper for adding the trailing Abandon button.
  const skipAbandonStages = new Set([
    "bad-idea",
    "completed",
    "research-complete", // already has a Deprioritise button
    "product-spec",
    "architecture",
    "plan-review",
  ]);
  const addAbandon = !skipAbandonStages.has(stage) ? 1 : 0;

  let buttons = 0;
  let texts = 0;
  let extras = 0;

  switch (stage) {
    case "idea":
      buttons = 2; // start-research, skip-to-plan
      break;

    case "research":
    case "kit-management":
      buttons = agentRunning ? 1 : 0;
      break;

    case "research-complete":
      buttons = 3; // run-pm/generate-plan, more-research, deprioritise
      break;

    case "product-spec":
    case "architecture":
      buttons = agentRunning ? 1 : 3;
      break;

    case "plan-review": {
      // sub-states: reviewing / needs-revision-1or2 / needs-revision-3 /
      // reviewed / approved / pending. Each has a different shape.
      const has = (l: string) => labels.includes(l);
      if (has("plan:reviewing")) {
        texts = 1; // "Reviewing plan…"
        buttons = agentRunning ? 1 : 0;
      } else if (has("plan:revise-round-1") || has("plan:revise-round-2")) {
        texts = 1;
        extras += REVIEW_FILE_LINK;
        buttons = agentRunning ? 1 : 0;
      } else if (has("plan:revise-round-3")) {
        texts = 1;
        extras += REVIEW_FILE_LINK;
        buttons = 3;
      } else if (has("plan:reviewed")) {
        texts = 1; // "Advancing to test-spec…"
      } else if (has("plan:approved")) {
        buttons = 2;
      } else {
        // plan:pending or default
        buttons = 3;
      }
      break;
    }

    case "test-spec":
      buttons = agentRunning ? 1 : 2;
      break;

    case "development": {
      if (agentRunning) {
        buttons = 1; // stop-agent
      } else {
        // Wave CTAs: at most 2. Send-for-review: 1 (when applicable).
        // Resume-build: 1 (when applicable). Venture deploy: 1 extra.
        // Estimate the upper bound — better to overestimate.
        let dev = 0;
        // Wave CTA visibility (approximate from labels)
        const hasWaveLabels = app.children.some((c) =>
          (c.labels ?? []).some((l) => /^wave:\d+$/.test(l)),
        );
        if (hasWaveLabels) dev += 2; // either start-wave or review+start
        // Send-for-review CTA (only with pipeline:development)
        if (labels.includes("pipeline:development")) dev += 1;
        // Resume-build CTA
        const openChildren = app.children.filter((c) => c.status !== "closed").length;
        if (openChildren > 0) dev += 1;
        // Venture deploy
        if (app.shipType === "venture") dev += 1;
        buttons = dev;
      }
      break;
    }

    case "qa": {
      texts = 0;
      const qaRoundLabel = labels.find((l) => l.startsWith("qa:round-"));
      if (qaRoundLabel) extras += QA_ROUND_BADGE;
      if (agentRunning) {
        buttons = 1; // disabled "QA in progress..."
      } else {
        // run-qa, approve-submission, send-back-to-dev, optionally send-for-polish
        const round = qaRoundLabel
          ? parseInt(qaRoundLabel.replace("qa:round-", ""), 10)
          : NaN;
        buttons = 3 + (round === 1 ? 1 : 0);
      }
      break;
    }

    case "submission-prep":
      buttons = 3; // launch, send-back, revise-plan-from-launch
      break;

    case "submitted":
      buttons = 1;
      break;

    case "deploying":
      buttons = 2;
      break;

    case "live":
      buttons = 1;
      break;

    case "bad-idea":
    case "completed":
      buttons = 0;
      break;

    default: {
      // Unknown stage — render Abandon only if not in skip list.
      buttons = 0;
      break;
    }
  }

  buttons += addAbandon;
  return { buttons, texts, extras };
}

// ---------------------------------------------------------------------------
// estimateCardHeight — public API
// ---------------------------------------------------------------------------

/**
 * Estimate the rendered height of a FleetCard inside a VariableSizeList row
 * for the given FleetApp. Returns pixels (rounded up to integer). Includes
 * a 6px row-gap baked in (CARD_GAP) so VariableSizeList preserves the
 * pre-virtualisation visual rhythm.
 *
 * The estimator is exhaustive over the conditional sections in FleetCard
 * — every section that affects height has a HEIGHTS contribution. Some
 * sections cannot be inspected from the FleetApp alone (langfuse URL,
 * snippet content) and are approximated by stage / agent-running heuristic
 * with a bias toward overestimation (extra whitespace acceptable;
 * clipping is not).
 *
 * @param app the FleetApp prop passed to FleetCard
 * @returns row height in pixels including the inter-card gap
 */
export function estimateCardHeight(app: FleetApp): number {
  let h = 0;

  // Always-rendered structural sections
  h += CARD_PADDING;
  h += HEADER;
  h += APP_NAME;
  h += FOOTER;
  h += PHASE_HISTORY;

  // Optional sections
  if (app.progress.total > 0) h += PROGRESS_BAR;
  if (rendersWaveInfo(app)) h += WAVE_INFO;
  if (rendersSubmissionBadges(app)) h += SUBMISSION_BADGES;
  if (app.stage !== "idea") h += QUICK_LINKS;
  if (rendersLangfuseLink(app)) h += LANGFUSE;
  if (rendersSnippet(app)) h += SNIPPET;

  // Cost section is approximated — the estimator can't see EpicCost.
  // Cost is fetched async upstream and rendered conditionally on
  // `cost && cost.totalCost > 0`. We bias upward by always charging
  // COST_BASE for active stages where a cost block typically renders.
  // For terminal stages (bad-idea, completed) we skip it.
  const costRenderingStages = new Set([
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
    "deploying",
    "live",
  ]);
  if (costRenderingStages.has(app.stage)) {
    h += COST_BASE;
    // Phase breakdown rendered when phases.length > 1. Bias up: assume
    // research+development phases for any post-research stage.
    if (
      app.stage !== "research" &&
      app.stage !== "research-complete" &&
      app.stage !== "idea"
    ) {
      h += COST_PHASES;
    }
  }

  // Attention banners — every attention-trigger label adds one banner.
  // FleetCard renders one banner per AttentionItem. We approximate by
  // counting attention-trigger labels on the epic and on flagged children.
  let attentionBanners = 0;
  const epicLabels = app.epic.labels ?? [];
  if (epicLabels.includes("checkpoint:human-verify")) attentionBanners++;
  if (epicLabels.includes("checkpoint:decision")) attentionBanners++;
  if (epicLabels.includes("checkpoint:human-action")) attentionBanners++;
  if (epicLabels.includes("qa:needs-review")) attentionBanners++;
  if (epicLabels.includes("review:needs-human")) attentionBanners++;
  for (const c of app.children) {
    if ((c.labels ?? []).includes("human")) attentionBanners++;
  }
  h += attentionBanners * ATTENTION_BANNER_PER_ITEM;

  // Action buttons block (rendered when onPipelineAction is wired —
  // FleetColumn always wires it on /fleet so we charge unconditionally).
  const { buttons, texts, extras } = actionButtonShape(app);
  if (buttons > 0 || texts > 0 || extras > 0) {
    h += ACTION_BLOCK_MARGIN;
    h += buttons * ACTION_BUTTON;
    h += texts * ACTION_TEXT;
    h += extras;
  }

  // Inter-card gap baked in.
  h += CARD_GAP;

  return Math.ceil(h);
}

// ---------------------------------------------------------------------------
// Re-export the section constants for unit tests so tests can verify
// per-section contributions without hard-coding the literal pixel values.
// ---------------------------------------------------------------------------

export const HEIGHTS = {
  CARD_PADDING,
  CARD_GAP,
  HEADER,
  APP_NAME,
  FOOTER,
  PHASE_HISTORY,
  PROGRESS_BAR,
  WAVE_INFO,
  SUBMISSION_BADGES,
  QUICK_LINKS,
  LANGFUSE,
  SNIPPET,
  COST_BASE,
  COST_PHASES,
  ATTENTION_BANNER_PER_ITEM,
  ACTION_BLOCK_MARGIN,
  ACTION_BUTTON,
  ACTION_TEXT,
  QA_ROUND_BADGE,
  REVIEW_FILE_LINK,
} as const;
