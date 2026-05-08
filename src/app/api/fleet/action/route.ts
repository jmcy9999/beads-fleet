import { NextRequest, NextResponse } from "next/server";
import {
  addLabelsToEpic,
  removeLabelsFromEpic,
  removeLabelsFromEpicStrict,
  removeAllPipelineLabels,
  closeEpic,
  updateEpicStatus,
  getEpicLabels,
  dismissHumanItem,
} from "@/lib/pipeline-labels";
import {
  launchAgent,
  stopAgent,
  getWaveStatus,
  listOpenWaveBeads,
  listOpenWaveBeadsAllRepos,
  groupBeadsByFileConflict,
  isAgentActive,
} from "@/lib/agent-launcher";
import {
  loadBeadDetail,
  loadBeadTestScenarios,
  loadCheckpointEntries,
  loadBuildPromptOverride,
  buildPerBeadPrompt,
  formatBuilderStandingOrdersDirective,
  formatAgentStandingOrdersDirective,
} from "@/lib/bead-prompt";
import { getRepos, findRepoForIssue } from "@/lib/repo-config";
import { invalidateCache } from "@/lib/bv-client";
import { getDefaultActionUrl } from "@/lib/orchestrator-url";
import { extractAppName } from "@/lib/extract-app-name";
import { FLEET_CORE_PATH, resolveRepoPath } from "@/lib/repo-path-resolver";
// beads_web-ehp.11: dispatch-preconditions gate — every DISPATCHING action
// (34 of 37 cases; EXEMPT = stop-agent / human-approve / human-dismiss)
// runs `checkPreconditionsOrRefuse` at the TOP of its case body BEFORE any
// label mutation or agent launch. On refusal: HTTP 412 with structured
// PreconditionRefusalResponse body + action + epicId. See ehp.13 library
// (src/lib/dispatch-preconditions.ts) for predicate / table contracts.
import {
  buildDispatchContext,
  evaluatePreconditions,
  buildPreconditionRefusalResponse,
} from "@/lib/dispatch-preconditions";
import { promises as fs } from "fs";
import path from "path";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ---------------------------------------------------------------------------
// beads_web-poh.9 — revert helper for failed launches.
//
// Action handlers historically mutate labels + status BEFORE calling
// launchAgent. If the launch throws (fingerprint refusal, in-process
// collision, file-system error, etc.) the mutations are NOT reverted —
// leaving the bead with stale `agent:running` + a half-applied pipeline
// label that requires manual operator cleanup before the next dispatch
// can fire (empirically blocked C2 V1+V2 retests, 2026-05-07).
//
// Per the bead's recommended Option B (transactional revert), each
// affected handler now wraps its launchAgent call in a try/catch that
// invokes this helper on failure. The helper is best-effort: a revert
// failure is logged but does NOT mask the original launch error
// (the route's outer catch returns the launch error verbatim).
//
// Scope of this fix: the six C2 critical-path handlers
// (start-research, run-pm, run-architect, run-planner, run-test-spec,
// start-wave). The remaining ~20 handlers carry the same risk shape
// and are tracked under beads_web-poh as a follow-on.
// ---------------------------------------------------------------------------
async function revertLaunchSideEffects(
  epicId: string,
  fleetCorePath: string,
  reverts: {
    addedLabels?: string[];
    statusReverted?: "open" | "in_progress";
  },
): Promise<void> {
  try {
    if (reverts.addedLabels && reverts.addedLabels.length > 0) {
      await removeLabelsFromEpic(epicId, reverts.addedLabels, fleetCorePath);
    }
    if (reverts.statusReverted) {
      await updateEpicStatus(epicId, reverts.statusReverted, fleetCorePath);
    }
    invalidateCache({ type: "epic", epicId });
  } catch (revertErr) {
    console.error(
      `[poh.9] revertLaunchSideEffects failed for ${epicId}: ${revertErr instanceof Error ? revertErr.message : revertErr}`,
    );
  }
}

type PipelineAction =
  | "start-research"
  | "send-for-development"
  | "more-research"
  | "deprioritise"
  | "approve-submission"
  | "send-back-to-dev"
  | "mark-as-live"
  | "stop-agent"
  | "generate-plan"
  | "approve-plan"
  | "approve-and-build"
  | "revise-plan"
  | "skip-to-plan"
  | "revise-plan-from-launch"
  | "send-for-qa"
  | "qa-fix-and-retest"
  | "mark-ready-to-deploy"
  | "mark-venture-live"
  | "mark-venture-complete"
  | "start-wave"
  | "review-wave"
  | "resume-build"
  | "send-for-review"
  | "send-for-polish"
  | "run-pm"
  | "run-architect"
  | "run-smoke-test"
  | "run-polish"
  | "revise-spec"
  | "revise-architecture"
  | "run-test-spec"
  | "revise-test-spec"
  | "human-approve"
  | "human-dismiss"
  // factory-core-k7gy.5 — plan-review auto-chain actions (F5/F6/F7)
  | "review-plan"
  | "revise-plan-from-review"
  // factory-core-zsjv.4 — coherence agent escalation
  | "run-coherence-agent";

const VALID_ACTIONS = new Set<PipelineAction>([
  "start-research",
  "send-for-development",
  "more-research",
  "deprioritise",
  "approve-submission",
  "send-back-to-dev",
  "mark-as-live",
  "stop-agent",
  "generate-plan",
  "approve-plan",
  "approve-and-build",
  "revise-plan",
  "skip-to-plan",
  "revise-plan-from-launch",
  "send-for-qa",
  "qa-fix-and-retest",
  "mark-ready-to-deploy",
  "mark-venture-live",
  "mark-venture-complete",
  "start-wave",
  "review-wave",
  "resume-build",
  "send-for-review",
  "send-for-polish",
  "run-pm",
  "run-architect",
  "run-smoke-test",
  "run-polish",
  "revise-spec",
  "revise-architecture",
  "run-test-spec",
  "revise-test-spec",
  "human-approve",
  "human-dismiss",
  // factory-core-k7gy.5 — plan-review auto-chain actions
  "review-plan",
  "revise-plan-from-review",
  // factory-core-zsjv.4 — coherence agent escalation
  "run-coherence-agent",
]);

// Resolve fleet-core path: env var > hardcoded fallback.
// factory-core-so74 A.8 deferred-AC fix: fallback updated to
// factory-core (the active fork). Without this, the registry-fallback
// `find` at lines 416-419 hits the legacy fleet-core entry first when the env
// var is unset, and the bounding rule at line 1792 (path.basename ===
// "factory-core") silently returns false, disabling cross-repo
// dispatch. See docs/aspirational-pipeline/a8-deferred-fixes.md (architect's
// design originally targeted only repo-path-resolver.ts and agent-launcher.ts;
// this third location was discovered during retest).
// FLEET_CORE_PATH now imported from @/lib/repo-path-resolver (beads_web-63g).

/**
 * Derive the app name from the epic title. Strips common suffixes and extracts
 * the PascalCase app name. Falls back to the epic ID if no clear name found.
 */
function deriveAppName(epicTitle: string, epicId: string): string {
  // Split on first colon to get the "name" portion
  const beforeColon = epicTitle.split(":")[0].trim();

  // If before-colon is a single PascalCase word (e.g., "LensCycle", "MindStack", "GutCycle")
  if (/^[A-Z][a-zA-Z]+$/.test(beforeColon) && !beforeColon.includes(" ")) {
    return beforeColon;
  }

  // If before-colon has multiple words, PascalCase them and strip non-alpha
  // e.g., "Landing Page" -> "LandingPage", "Shipyard-as-a-Product" -> "ShipyardAsAProduct"
  if (beforeColon.includes(" ") || beforeColon.includes("-")) {
    const words = beforeColon.split(/[\s-]+/);
    return words
      .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join("");
  }

  // Single word before colon (e.g., "Shipyard:")
  if (epicTitle.includes(":")) {
    return beforeColon;
  }

  // No colon — try PascalCase word in the title
  const pascalMatch = epicTitle.match(/\b([A-Z][a-z]+(?:[A-Z][a-z]+)+)\b/);
  if (pascalMatch) return pascalMatch[1];

  // Fallback: PascalCase first two meaningful words
  const words = epicTitle.split(/\s+/).filter((w) => w.length > 2);
  if (words.length >= 2) {
    return words.slice(0, 2).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join("");
  }
  return words[0] ?? epicId;
}

/**
 * factory-core-rgqd F8 + factory-core-zszt.3 — convert owner feedback on any
 * send-back-style action into a new bug bead under the epic. Previously
 * feedback was baked into the agent prompt as free-text and lost after the
 * session ended. Now it becomes a structured, traceable, closeable artefact.
 *
 * Returns the bead ID on success, or null if creation failed (non-fatal —
 * callers should still dispatch the agent; the feedback lives in the
 * prompt as before).
 */
async function createFeedbackBead(params: {
  epicId: string;
  feedback: string;
  stage: string; // e.g., "qa-round-1", "ux-polish", "submission-prep"
  shipType: string;
  fleetCorePath: string;
}): Promise<string | null> {
  const { epicId, feedback, stage, shipType, fleetCorePath } = params;
  const trimmed = feedback.trim();
  if (!trimmed || trimmed.length < 30) return null; // skip trivial feedback

  // Derive a short title from the first line, truncated to 60 chars
  const firstLine = trimmed.split("\n")[0].slice(0, 60);
  const title = `send-back(${stage}): ${firstLine}`;

  try {
    const { execSync } = await import("child_process");
    const { getBdPath, getBdEnv } = await import("@/lib/bd-path");
    const bd = getBdPath();
    const env = getBdEnv();
    // Use --parent to nest under the epic
    const output = execSync(
      `${bd} create --title=${JSON.stringify(title)} --type=bug --priority=1 --parent=${epicId} --description=${JSON.stringify(trimmed)}`,
      { cwd: fleetCorePath, encoding: "utf-8", env, timeout: 10000 },
    );
    // bd create output contains "Created issue: <id> — ..."
    const match = output.match(/Created issue:\s*(\S+)/);
    const beadId = match ? match[1] : null;
    if (!beadId) {
      console.warn("[createFeedbackBead] could not parse bead id from bd output");
      return null;
    }
    // Label it with stage + ship type + feedback origin
    try {
      execSync(`${bd} label add ${beadId} -- review:feedback from-send-back stage:${stage} ship-type:${shipType}`, {
        cwd: fleetCorePath, encoding: "utf-8", env, timeout: 10000,
      });
    } catch (err) {
      console.warn("[createFeedbackBead] label add failed:", err instanceof Error ? err.message : err);
    }
    return beadId;
  } catch (err) {
    console.warn(
      "[createFeedbackBead] bd create failed — feedback will only appear in the agent prompt",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * factory-core-zszt.3 — shared shape for every send-back path that takes
 * free-text owner feedback and re-dispatches an agent. Pairs the prompt
 * string (for the agent's immediate context) with the feedback-bead
 * contract (for durable acceptance). If feedback is absent or trivial
 * (<30 chars), no bead is created and the caller's prompt gets only the
 * plain feedback string.
 *
 * Returns:
 *   feedbackStr      — legacy prompt snippet: ' Jane's feedback: "<text>".'
 *   feedbackBeadStr  — contract snippet naming the bead id and acceptance
 *                      requirement (empty when no bead was created)
 *   feedbackBeadId   — the bead id if one was created, else null
 */
async function materialiseFeedback(params: {
  feedback: unknown;
  stage: string;
  epicId: string;
  shipType: string;
  fleetCorePath: string;
}): Promise<{
  feedbackStr: string;
  feedbackBeadStr: string;
  feedbackBeadId: string | null;
}> {
  const { feedback, stage, epicId, shipType, fleetCorePath } = params;
  const hasFeedback = typeof feedback === "string" && feedback.trim().length > 0;
  if (!hasFeedback) {
    return { feedbackStr: "", feedbackBeadStr: "", feedbackBeadId: null };
  }
  const feedbackText = feedback as string;
  const feedbackStr = ` Jane's feedback: "${feedbackText}".`;
  if (feedbackText.trim().length < 30) {
    // Non-trivial threshold keeps micro-feedback ("typo in AC") from
    // polluting the epic's bead list while still preserving the text in
    // the prompt. Same threshold used by the original F8 path.
    return { feedbackStr, feedbackBeadStr: "", feedbackBeadId: null };
  }
  const feedbackBeadId = await createFeedbackBead({
    epicId,
    feedback: feedbackText,
    stage,
    shipType,
    fleetCorePath,
  });
  const feedbackBeadStr = feedbackBeadId
    ? ` A feedback bug bead ${feedbackBeadId} has been filed under this epic with the full feedback as its description and acceptance criteria — you MUST close that bead as part of your fix. Do not simply read the feedback and move on; the bead is the contract.`
    : "";
  return { feedbackStr, feedbackBeadStr, feedbackBeadId };
}

/**
 * Shared PM-agent launch used by both the `run-pm` action and the
 * `start-research` + `skip:research` bypass branch (factory-core-3yqr.2 ADR-004).
 *
 * Responsibilities (unchanged from the original `case "run-pm"` body):
 *   1. Remove `pipeline:research-complete` (no-op when absent, so the skip
 *      path can also call this without first transitioning through research).
 *   2. Add `pipeline:product-spec` + `agent:running`.
 *   3. Invalidate the epic's cache scope.
 *   4. Build a PM-agent prompt and launch the agent in fleet-core.
 *
 * When `descriptionOverride` is provided (skip:research branch), the PM
 * prompt inlines the epic description VERBATIM in place of the research-
 * report path. Per F7 AC bullet 5 / ADR-004 there is no interpretation of
 * URLs or paths — the PM agent decides what to do with what's there.
 *
 * External behaviour of `run-pm` (request body shape, response shape, label
 * flow, prompt template for the non-skip path) is preserved byte-for-byte
 * per 3yqr.2 non-functional requirements (ADR-003).
 */
async function launchPmAgent(params: {
  epicId: string;
  epicTitle: string;
  shipType: string;
  appName: string;
  labels: string[];
  fleetCorePath: string;
  /**
   * When set, the PM prompt inlines this text in place of the research-report
   * path (skip:research bypass). Caller is responsible for validating length
   * and ship-type compatibility before invoking the helper (F7 AC).
   */
  descriptionOverride?: string;
}) {
  const {
    epicId,
    epicTitle,
    shipType,
    appName,
    labels,
    fleetCorePath,
    descriptionOverride,
  } = params;

  // zsjv.4 fix: clear ALL pipeline:* labels first to prevent doubles.
  const pmLabelsNow = await getEpicLabels(epicId, fleetCorePath);
  await removeAllPipelineLabels(epicId, pmLabelsNow, fleetCorePath);
  const pmAddedLabels = ["pipeline:product-spec", "agent:running"];
  await addLabelsToEpic(epicId, pmAddedLabels, fleetCorePath);
  // factory-core-g5sa: ensure bd status transitions to in_progress on EVERY
  // path into PM. The non-skip `start-research` case also calls this (line
  // 385 in its own branch for the pre-research transition), but the skip:
  // research bypass previously skipped straight to launchPmAgent without
  // setting status — leaving the epic at `status=open` while labels and
  // `agent:running` progressed. updateEpicStatus is idempotent on already-
  // in-progress epics, so the existing `case "run-pm"` path (which relied on
  // start-research having set it) stays byte-for-byte correct.
  await updateEpicStatus(epicId, "in_progress", fleetCorePath);
  invalidateCache({ type: "epic", epicId });

  const { researchPath: pmResearchPath } = resolveRepoPath(
    shipType,
    epicTitle,
    appName,
    epicId,
    fleetCorePath,
  );

  // PM always runs in fleet-core — specs and research live there, the
  // product repo may not exist yet.
  // beads_web-y9u: apply standing-orders directive (Phase 2 Item 4 scope completion).
  const pmPrompt = descriptionOverride
    ? `Write functional spec for epic ${epicId} (${epicTitle}). Ship type: ${shipType}. No research report — the epic description is provided inline below as your input context (skip:research bypass). Epic description:\n\n${descriptionOverride}\n\nFleet-core: ${fleetCorePath}.\n\n${formatAgentStandingOrdersDirective(fleetCorePath, shipType, "product-manager")}`
    : `Write functional spec for epic ${epicId} (${epicTitle}). Ship type: ${shipType}. Research report: ${pmResearchPath}. Fleet-core: ${fleetCorePath}.\n\n${formatAgentStandingOrdersDirective(fleetCorePath, shipType, "product-manager")}`;

  // beads_web-poh.9: revert pipeline + agent:running labels and the
  // status transition if launchAgent throws — keeps the bead clean
  // for the next attempt.
  let pmSession;
  try {
    pmSession = await launchAgent({
      repoPath: fleetCorePath,
      repoName: "fleet-core",
      prompt: pmPrompt,
      model: "opus",
      maxTurns: 150,
      allowedTools: "Bash,Read,Write,Edit,Glob,Grep,Task",
      epicId: epicId,
      epicLabels: labels,
      pipelineStage: "product-spec",
      agentName: "product-manager",
    });
  } catch (launchErr) {
    await revertLaunchSideEffects(epicId, fleetCorePath, {
      addedLabels: pmAddedLabels,
      statusReverted: "open",
    });
    throw launchErr;
  }

  return pmSession;
}

// factory-core-2r2m: Read maxRounds from qa.md YAML frontmatter.
// Uses regex (not a parser library) to avoid adding an npm dependency.
// Falls back to DEFAULT_MAX_ROUNDS with a structured warning if frontmatter
// is missing or malformed.
const DEFAULT_MAX_ROUNDS = 20;

async function getQaMaxRounds(fleetCorePath: string): Promise<number> {
  const qaAgentPath = path.join(fleetCorePath, ".claude", "agents", "qa.md");
  try {
    const content = await fs.readFile(qaAgentPath, "utf-8");
    // Extract the YAML frontmatter block (between --- delimiters)
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!frontmatterMatch) {
      console.warn(
        JSON.stringify({
          level: "WARN",
          event: "qa_maxrounds_frontmatter_missing",
          filePath: qaAgentPath,
          fallback: DEFAULT_MAX_ROUNDS,
          message: `qa.md at ${qaAgentPath} has no YAML frontmatter block. Using default maxRounds=${DEFAULT_MAX_ROUNDS}.`,
        })
      );
      return DEFAULT_MAX_ROUNDS;
    }
    const frontmatter = frontmatterMatch[1];
    const maxRoundsMatch = frontmatter.match(/^maxRounds:\s*(\d+)$/m);
    if (!maxRoundsMatch) {
      console.warn(
        JSON.stringify({
          level: "WARN",
          event: "qa_maxrounds_key_missing",
          filePath: qaAgentPath,
          fallback: DEFAULT_MAX_ROUNDS,
          message: `qa.md at ${qaAgentPath} frontmatter has no maxRounds key. Using default maxRounds=${DEFAULT_MAX_ROUNDS}.`,
        })
      );
      return DEFAULT_MAX_ROUNDS;
    }
    const parsed = parseInt(maxRoundsMatch[1], 10);
    if (isNaN(parsed) || parsed < 1) {
      console.warn(
        JSON.stringify({
          level: "WARN",
          event: "qa_maxrounds_invalid_value",
          filePath: qaAgentPath,
          rawValue: maxRoundsMatch[1],
          fallback: DEFAULT_MAX_ROUNDS,
          message: `qa.md at ${qaAgentPath} has invalid maxRounds value '${maxRoundsMatch[1]}'. Using default maxRounds=${DEFAULT_MAX_ROUNDS}.`,
        })
      );
      return DEFAULT_MAX_ROUNDS;
    }
    return parsed;
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: "WARN",
        event: "qa_maxrounds_read_failure",
        filePath: qaAgentPath,
        fallback: DEFAULT_MAX_ROUNDS,
        error: err instanceof Error ? err.message : String(err),
        message: `Failed to read qa.md at ${qaAgentPath}. Using default maxRounds=${DEFAULT_MAX_ROUNDS}.`,
      })
    );
    return DEFAULT_MAX_ROUNDS;
  }
}

/**
 * beads_web-ehp.11 — precondition gate for every DISPATCHING action.
 *
 * Builds DispatchContext via `buildDispatchContext` (re-uses the published
 * readers — readBeadStatus / readMarker / getEpicLabels / listOpenWaveBeads /
 * readEvents — so the TOCTOU window is unchanged from today per architecture
 * § Failure modes Seam 4), evaluates the registered predicates, and returns:
 *
 *   - `null`                          → preconditions pass; caller proceeds.
 *   - `NextResponse` (HTTP 412 body)  → refusal; caller MUST `return` it
 *                                       BEFORE any label mutation or agent
 *                                       launch.
 *
 * 412 body shape (per AC + library Contract 3): merges
 * `buildPreconditionRefusalResponse` (refused, refusalCode, failedCheck,
 * reason, observedState) with `action` and `epicId` so coherence reasoning
 * has both the structured refusal and the request identifiers.
 *
 * Helper is invoked ONLY from the 34 DISPATCHING case bodies. The 3 EXEMPT
 * cases (stop-agent / human-approve / human-dismiss) deliberately do NOT
 * call this helper — see the per-case `EXEMPT per beads_web-ehp.11` comment.
 */
async function checkPreconditionsOrRefuse(params: {
  epicId: string;
  fleetCorePath: string;
  action: PipelineAction;
  waveNumber?: number;
}): Promise<NextResponse | null> {
  // Cross-repo epic resolution (2c2cab5 + 32c76b8 + cqe-fix): beads_web-* lives in
  // beads_web's bd repo, not factory-core. Without this, readBeadStatus runs from
  // the wrong cwd → null → BD_READ_FAILED fail-closed refuses every legitimate dispatch.
  //
  // Fast-path by ID prefix for factory-core (the orchestrator's own repo). For all
  // other prefixes, defer to findRepoForIssue which probes registered repos via
  // (already-async) MySQL queries. The historical 5s timeout shim was needed when
  // event-loop contention from reconciler ticks made findRepoForIssue slow; the
  // root cause (poh.4 throttle + q8w execFile fix) makes the timeout unnecessary.
  // cqe (2026-05-07): hardcoded "/Users/janemckay/dev/claude_projects/beads_web"
  // removed — use registry lookup instead.
  let repoPath = params.fleetCorePath;
  if (!params.epicId.startsWith("factory-core-")) {
    try {
      const homeRepo = await findRepoForIssue(params.epicId);
      if (homeRepo) repoPath = homeRepo;
    } catch {
      // Fall through to fleetCorePath default; downstream readBeadStatus will fail-closed
      // if the resolved path is wrong, which is the correct ADR-002 posture.
    }
  }
  const ctx = await buildDispatchContext({
    epicId: params.epicId,
    repoPath,
    action: params.action,
    waveNumber: params.waveNumber,
  });
  const result = evaluatePreconditions(ctx);
  if (result.ok) return null;
  const refusal = buildPreconditionRefusalResponse(result, ctx.bead);
  return NextResponse.json(
    { ...refusal, action: params.action, epicId: params.epicId },
    { status: 412 },
  );
}

/**
 * POST /api/fleet/action -- Execute a pipeline action on a fleet-core epic.
 *
 * Body: { epicId: string, epicTitle: string, action: PipelineAction, feedback?: string, currentLabels?: string[] }
 */
export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const {
    epicId,
    epicTitle,
    action,
    feedback,
    currentLabels,
    waveNumber,
    targetLabel,
    targetBeadId,
    // factory-core-k7gy.5 — plan-review auto-chain fields
    fromChain,
    reviewFilePath,
    currentRound,
  } = body;

  if (!epicId || typeof epicId !== "string") {
    return NextResponse.json({ error: "Missing epicId" }, { status: 400 });
  }
  if (!epicTitle || typeof epicTitle !== "string") {
    return NextResponse.json({ error: "Missing epicTitle" }, { status: 400 });
  }
  if (!action || !VALID_ACTIONS.has(action as PipelineAction)) {
    return NextResponse.json(
      { error: `Invalid action: ${action}` },
      { status: 400 },
    );
  }

  const store = await getRepos();
  // factory-core-ap56: env-var precedence — try exact path equality first,
  // then fall back to name substring. Without splitting the predicate, find()
  // returns the first match regardless of branch, which means a substring hit
  // on STABLE's "fleet-core" entry wins over an env-var pointed at
  // factory-core.
  const fleetCoreRepo =
    store.repos.find((r) => r.path === FLEET_CORE_PATH) ??
    store.repos.find((r) => r.name.includes("fleet-core"));
  const fleetCorePath = fleetCoreRepo?.path ?? FLEET_CORE_PATH;

  const appName = deriveAppName(epicTitle as string, epicId as string);
  const labels = Array.isArray(currentLabels) ? currentLabels as string[] : [];
  const isVenture = labels.includes("ship-type:venture");
  const shipTypeLabel = labels.find(l => l.startsWith("ship-type:"));
  const shipType = shipTypeLabel ? shipTypeLabel.replace("ship-type:", "") : "ios-app";

  // beads_web-ehp.11: coerce optional waveNumber once for the precondition
  // gate. Keep coercion lenient (accept number OR string) so the downstream
  // case-body validation (start-wave / review-wave) still owns the strict
  // 400 path. `undefined` here just means "no wave context".
  const parsedWaveNumber: number | undefined = (() => {
    if (typeof waveNumber === "number" && Number.isFinite(waveNumber) && waveNumber > 0) {
      return waveNumber;
    }
    if (typeof waveNumber === "string" && waveNumber.trim() !== "") {
      const n = parseInt(waveNumber, 10);
      if (!isNaN(n) && n > 0) return n;
    }
    return undefined;
  })();

  try {
    switch (action as PipelineAction) {
      // -------------------------------------------------------------------
      // START RESEARCH: Ideas -> In Research
      //
      // factory-core-3yqr.2 (F7 / ADR-004): `skip:research` bypass.
      // When the epic carries the `skip:research` label we must:
      //   1. Reject 400 if `ship-type:venture` is also present (ventures are
      //      research-only — ADR-007).
      //   2. Reject 400 if the epic description is shorter than 50 characters
      //      after trim (F7 AC; enforcement point is here, ADR-004 — NOT at
      //      `bd create`, NOT in the research-agent prompt).
      //   3. Otherwise dispatch the `run-pm` code path in-process via the
      //      shared `launchPmAgent` helper (option A), passing the epic
      //      description verbatim as PM input. The research agent is NOT
      //      launched; the pipeline label transitions directly to
      //      `pipeline:product-spec`.
      //
      // Rejection paths MUST NOT mutate epic labels (bead AC bullets 2 & 4 —
      // "the epic remains at its starting state"). All three skip:research
      // branches are distinct (regression pattern #7 Type Confusion): venture
      // rejection, short-description rejection, happy-path dispatch.
      // -------------------------------------------------------------------
      case "start-research": {
        // beads_web-ehp.11: precondition gate (DISPATCHING).
        const refusal = await checkPreconditionsOrRefuse({ epicId, fleetCorePath, action: "start-research", waveNumber: parsedWaveNumber });
        if (refusal) return refusal;

        if (labels.includes("skip:research")) {
          if (shipType === "venture") {
            return NextResponse.json(
              {
                error:
                  "skip:research is not valid for ventures; ventures are research-only",
              },
              { status: 400 },
            );
          }

          // Read the epic description via the existing bd-show helper used
          // elsewhere in route.ts (loadBeadDetail in the per-bead wave
          // launcher). No new query infrastructure — per 3yqr.2 NFR.
          let description = "";
          try {
            const detail = loadBeadDetail(epicId, fleetCorePath);
            description = (detail.description ?? "").trim();
          } catch (err) {
            // Surface, don't swallow (regression pattern #13). We do NOT
            // mutate the epic state on this path — the owner can fix the bd
            // issue and click Start again.
            console.error(
              `[start-research] skip:research bypass: failed to read description for ${epicId}:`,
              err,
            );
            return NextResponse.json(
              {
                error: `skip:research requires reading the epic description, but bd show failed: ${err instanceof Error ? err.message : String(err)}`,
              },
              { status: 500 },
            );
          }

          if (description.length < 50) {
            return NextResponse.json(
              {
                error:
                  "skip:research requires a description of at least 50 characters",
              },
              { status: 400 },
            );
          }

          // Log the bypass so it's visible in logs / Langfuse traces.
          console.info(
            `[start-research] skip:research bypass active for epic ${epicId} — dispatching run-pm inline (F7).`,
          );

          const skipPmSession = await launchPmAgent({
            epicId,
            epicTitle: epicTitle as string,
            shipType,
            appName,
            labels,
            fleetCorePath,
            descriptionOverride: description,
          });

          return NextResponse.json({
            success: true,
            action,
            epicId,
            dispatched: "run-pm",
            bypass: "skip:research",
            session: skipPmSession,
          });
        }

        // Default (non-skip:research) path — preserved byte-for-byte per
        // F7 AC bullet 3 / 3yqr.2 acceptance criteria.
        const startResearchAddedLabels = ["pipeline:research", "agent:running"];
        await addLabelsToEpic(epicId, startResearchAddedLabels, fleetCorePath);
        await updateEpicStatus(epicId, "in_progress", fleetCorePath);
        invalidateCache({ type: "epic", epicId });

        // beads_web-y9u: apply standing-orders directive.
        const researchPrompt = `Research epic ${epicId} (${epicTitle}). Ship type: ${shipType}. Fleet-core: ${fleetCorePath}.\n\n${formatAgentStandingOrdersDirective(fleetCorePath, shipType, "research")}`;

        // beads_web-poh.9: revert labels + status if launchAgent throws,
        // so a refused/failed launch does not leave the bead with a
        // stuck `agent:running` that blocks the next attempt.
        let session;
        try {
          session = await launchAgent({
            repoPath: fleetCorePath,
            repoName: "fleet-core",
            prompt: researchPrompt,
            model: "opus",
            maxTurns: 200,
            allowedTools: "Bash,Read,Write,Edit,Glob,Grep,Task,WebSearch",
            epicId: epicId,
            epicLabels: labels,
            pipelineStage: "research",
            agentName: "research",
          });
        } catch (launchErr) {
          await revertLaunchSideEffects(epicId, fleetCorePath, {
            addedLabels: startResearchAddedLabels,
            statusReverted: "open",
          });
          throw launchErr;
        }

        return NextResponse.json({ success: true, action, epicId, session });
      }

      // -------------------------------------------------------------------
      // SEND FOR DEVELOPMENT: Research Complete -> In Development
      //
      // factory-core-z9h.4: when every child bead carries a wave:N label,
      // route to start-wave with the lowest open wave so each wave gets a
      // fresh builder session (see z9h.2). When no children have wave
      // labels we fall back to the legacy single-session-for-all-waves
      // behaviour. Mixed labelling is an explicit error.
      // -------------------------------------------------------------------
      case "send-for-development": {
        // beads_web-ehp.11: precondition gate (DISPATCHING).
        const refusal = await checkPreconditionsOrRefuse({ epicId, fleetCorePath, action: "send-for-development", waveNumber: parsedWaveNumber });
        if (refusal) return refusal;

        const {
          repoPath,
          repoName,
          researchPath,
          planPath,
          testScenariosPath,
        } = resolveRepoPath(
          shipType,
          epicTitle as string,
          appName,
          epicId as string,
          fleetCorePath,
        );

        // Inspect wave labels on the epic's children BEFORE transitioning
        // labels — if we detect an inconsistency we reject without mutating
        // epic state. (Regression #7 Type Confusion: all-labelled vs
        // none-labelled vs UNKNOWN must be three explicit branches.)
        const waveStatus = await getWaveStatus(epicId as string, repoPath);

        // factory-core-z9h.10: before this guard, getWaveStatus tolerated
        // bd errors by returning hasWaves=false + totalChildren=0, which
        // silently fell through to the legacy single-session path — a
        // wave-labelled epic would bypass the whole z9h parallel-builder
        // mechanism because one `bd list` flaked. We now surface an error
        // on the WaveStatus and refuse to proceed when wave state is
        // unknown (regression patterns #13 / #7).
        if (waveStatus.error) {
          return NextResponse.json(
            {
              error: `Cannot determine wave state for epic ${epicId}: ${waveStatus.error}. Epic state not mutated. Re-run once bd is reachable.`,
            },
            { status: 500 },
          );
        }

        // Closed beads without wave labels (e.g. research tasks created before
        // the planner ran) are excluded from the consistency check — they don't
        // need wave assignments to proceed.
        const relevantChildren = waveStatus.totalChildren - (waveStatus.closedWithoutWaveLabel ?? 0);
        const allHaveWaves =
          relevantChildren > 0 &&
          waveStatus.childrenWithWaveLabels === relevantChildren;
        const mixedLabelling =
          waveStatus.childrenWithWaveLabels > 0 &&
          waveStatus.childrenWithWaveLabels < relevantChildren;

        if (mixedLabelling) {
          return NextResponse.json(
            {
              error: `Inconsistent wave labelling on epic ${epicId}: ${waveStatus.childrenWithWaveLabels} of ${waveStatus.totalChildren} children have wave:N labels. All children must either have wave labels or none must.`,
            },
            { status: 400 },
          );
        }

        if (allHaveWaves && waveStatus.allWavesComplete) {
          return NextResponse.json(
            {
              error: `Epic ${epicId} has no open beads to build — all ${waveStatus.totalChildren} children are closed.`,
            },
            { status: 400 },
          );
        }

        await removeLabelsFromEpic(
          epicId,
          [
            "pipeline:research-complete",
            "pipeline:test-spec",
            "plan:pending",
            "plan:approved",
          ],
          fleetCorePath,
        );
        await addLabelsToEpic(
          epicId,
          ["pipeline:development", "agent:running"],
          fleetCorePath,
        );
        invalidateCache({ type: "epic", epicId });

        // Wave routing: dispatch to the same per-wave launch logic as
        // start-wave — same prompt shape, same pipelineStage, same wave
        // scoping through launchAgent (z9h.2).
        if (allHaveWaves) {
          const wave = waveStatus.currentWave;
          const waveTestScenariosInfo = testScenariosPath
            ? ` Test scenarios: ${testScenariosPath}.`
            : "";
          const startWavePrompt = `Build Wave ${wave} beads for epic ${epicId} (${epicTitle}). Ship type: ${shipType}. Product repo: ${repoPath}. Research report: ${researchPath}. Build plan: ${planPath}. Fleet-core: ${fleetCorePath}.${waveTestScenariosInfo} ${formatBuilderStandingOrdersDirective(fleetCorePath, shipType)} ONLY work beads with wave:${wave} label. Do not advance to the next wave.`;

          const session = await launchAgent({
            repoPath: repoPath,
            repoName: repoName,
            prompt: startWavePrompt,
            model: "opus",
            maxTurns: 500,
            allowedTools: isVenture
              ? "Bash,Read,Write,Edit,Glob,Grep,Task,WebSearch"
              : "Bash,Read,Write,Edit,Glob,Grep,Task",
            epicId: epicId,
            epicLabels: labels,
            pipelineStage: "development",
            agentName: "builder",
            waveNumber: wave,
          });

          return NextResponse.json({
            success: true,
            action,
            epicId,
            dispatched: "start-wave",
            waveNumber: wave,
            session,
          });
        }

        // Legacy fallback: epic has no wave labels on any child (pre-z9h
        // epics). Single builder session works all beads in the plan.
        const testScenariosInfo = testScenariosPath
          ? ` Test scenarios: ${testScenariosPath}.`
          : "";
        const devPrompt = `Build epic ${epicId} (${epicTitle}). Ship type: ${shipType}. Product repo: ${repoPath}. Research report: ${researchPath}. Build plan: ${planPath}. Fleet-core: ${fleetCorePath}.${testScenariosInfo} ${formatBuilderStandingOrdersDirective(fleetCorePath, shipType)}`;

        const session = await launchAgent({
          repoPath: repoPath,
          repoName: repoName,
          prompt: devPrompt,
          model: "opus",
          maxTurns: 500,
          allowedTools: isVenture
            ? "Bash,Read,Write,Edit,Glob,Grep,Task,WebSearch"
            : "Bash,Read,Write,Edit,Glob,Grep,Task",
          epicId: epicId,
          epicLabels: labels,
          pipelineStage: "development",
          agentName: "builder",
        });

        return NextResponse.json({
          success: true,
          action,
          epicId,
          dispatched: "legacy",
          session,
        });
      }

      // -------------------------------------------------------------------
      // MORE RESEARCH: Research Complete -> In Research (loop)
      // -------------------------------------------------------------------
      case "more-research": {
        // beads_web-ehp.11: precondition gate (DISPATCHING).
        const refusal = await checkPreconditionsOrRefuse({ epicId, fleetCorePath, action: "more-research", waveNumber: parsedWaveNumber });
        if (refusal) return refusal;

        // zsjv.4 fix: clear ALL pipeline:* labels before adding the new
        // one so the epic never ends up with multiple simultaneously.
        const mrLabels = await getEpicLabels(epicId as string, fleetCorePath);
        await removeAllPipelineLabels(epicId as string, mrLabels, fleetCorePath);
        await removeLabelsFromEpic(epicId, ["plan:pending", "plan:approved"], fleetCorePath);
        await addLabelsToEpic(epicId, ["pipeline:research", "agent:running"], fleetCorePath);
        invalidateCache({ type: "epic", epicId });

        // factory-core-zszt.3: materialise non-trivial feedback into a
        // structured bug bead under the epic so the researcher has a
        // closeable contract, not just free text in a prompt.
        const { feedbackStr, feedbackBeadStr } = await materialiseFeedback({
          feedback,
          stage: "research",
          epicId,
          shipType,
          fleetCorePath,
        });

        const { researchPath: prevResearchPath } = resolveRepoPath(shipType, epicTitle as string, appName, epicId as string, fleetCorePath);
        // beads_web-y9u: apply standing-orders directive.
        const moreResearchPrompt = `Research epic ${epicId} (${epicTitle}). Ship type: ${shipType}. Fleet-core: ${fleetCorePath}. Previous research at ${prevResearchPath}.${feedbackStr}${feedbackBeadStr}\n\n${formatAgentStandingOrdersDirective(fleetCorePath, shipType, "research")}`;

        const session = await launchAgent({
          repoPath: fleetCorePath,
          repoName: "fleet-core",
          prompt: moreResearchPrompt,
          model: "opus",
          maxTurns: 200,
          allowedTools: "Bash,Read,Write,Edit,Glob,Grep,Task,WebSearch",
          epicId: epicId,
          epicLabels: labels,
          pipelineStage: "research",
          agentName: "research",
        });

        return NextResponse.json({ success: true, action, epicId, session });
      }

      // -------------------------------------------------------------------
      // RUN PM: Research Complete -> Product Spec (launch PM agent)
      // (factory-core-lxc.5; factory-core-3yqr.2 extracted the body into
      // `launchPmAgent` so the skip:research branch can share it without
      // changing the request/response shape — ADR-003.)
      // -------------------------------------------------------------------
      case "run-pm": {
        // beads_web-ehp.11: precondition gate (DISPATCHING).
        const refusal = await checkPreconditionsOrRefuse({ epicId, fleetCorePath, action: "run-pm", waveNumber: parsedWaveNumber });
        if (refusal) return refusal;

        const pmSession = await launchPmAgent({
          epicId,
          epicTitle: epicTitle as string,
          shipType,
          appName,
          labels,
          fleetCorePath,
        });

        return NextResponse.json({ success: true, action, epicId, session: pmSession });
      }

      // -------------------------------------------------------------------
      // RUN ARCHITECT: Product Spec -> Architecture (launch Architect agent)
      // (factory-core-lxc.5)
      // -------------------------------------------------------------------
      case "run-architect": {
        // beads_web-ehp.11: precondition gate (DISPATCHING).
        const refusal = await checkPreconditionsOrRefuse({ epicId, fleetCorePath, action: "run-architect", waveNumber: parsedWaveNumber });
        if (refusal) return refusal;

        // zsjv.4 fix: clear ALL pipeline:* labels first.
        const raLabelsNow = await getEpicLabels(epicId as string, fleetCorePath);
        await removeAllPipelineLabels(epicId as string, raLabelsNow, fleetCorePath);
        const runArchitectAddedLabels = ["pipeline:architecture", "agent:running"];
        await addLabelsToEpic(epicId, runArchitectAddedLabels, fleetCorePath);
        invalidateCache({ type: "epic", epicId });

        const { researchPath: archResearchPath, specPath: archSpecPath } = resolveRepoPath(
          shipType,
          epicTitle as string,
          appName,
          epicId as string,
          fleetCorePath
        );

        // Architect always runs in fleet-core — specs and research live there, product repo doesn't exist yet
        // beads_web-y9u: apply standing-orders directive.
        const archPrompt = `Design architecture for epic ${epicId} (${epicTitle}). Ship type: ${shipType}. Functional spec: ${archSpecPath}. Research report: ${archResearchPath}. Fleet-core: ${fleetCorePath}.\n\n${formatAgentStandingOrdersDirective(fleetCorePath, shipType, "architect")}`;

        // beads_web-poh.9: revert on launch failure.
        let archSession;
        try {
          archSession = await launchAgent({
          repoPath: fleetCorePath,
          repoName: "fleet-core",
          prompt: archPrompt,
          model: "opus",
          maxTurns: 150,
          allowedTools: "Bash,Read,Write,Edit,Glob,Grep,Task",
          epicId: epicId,
          epicLabels: labels,
          pipelineStage: "architecture",
          agentName: "architect",
          });
        } catch (launchErr) {
          await revertLaunchSideEffects(epicId, fleetCorePath, {
            addedLabels: runArchitectAddedLabels,
          });
          throw launchErr;
        }

        return NextResponse.json({ success: true, action, epicId, session: archSession });
      }

      // -------------------------------------------------------------------
      // REVISE SPEC: Re-run PM agent with feedback (stays in Product Spec)
      // (factory-core-lxc.5)
      // -------------------------------------------------------------------
      case "revise-spec": {
        // beads_web-ehp.11: precondition gate (DISPATCHING).
        const refusal = await checkPreconditionsOrRefuse({ epicId, fleetCorePath, action: "revise-spec", waveNumber: parsedWaveNumber });
        if (refusal) return refusal;

        await addLabelsToEpic(epicId, ["agent:running"], fleetCorePath);
        invalidateCache({ type: "epic", epicId });

        const { repoPath: rsRepoPath, repoName: rsRepoName, researchPath: rsResearchPath } = resolveRepoPath(
          shipType,
          epicTitle as string,
          appName,
          epicId as string,
          fleetCorePath
        );

        // factory-core-zszt.3
        const { feedbackStr: rsFeedbackStr, feedbackBeadStr: rsFeedbackBeadStr } =
          await materialiseFeedback({
            feedback,
            stage: "product-spec",
            epicId,
            shipType,
            fleetCorePath,
          });

        // beads_web-y9u: apply standing-orders directive.
        const rsPrompt = `Revise functional spec for epic ${epicId} (${epicTitle}). Ship type: ${shipType}. Research report: ${rsResearchPath}. Fleet-core: ${fleetCorePath}.${rsFeedbackStr}${rsFeedbackBeadStr}\n\n${formatAgentStandingOrdersDirective(fleetCorePath, shipType, "product-manager")}`;

        const rsSession = await launchAgent({
          repoPath: rsRepoPath,
          repoName: rsRepoName,
          prompt: rsPrompt,
          model: "opus",
          maxTurns: 150,
          allowedTools: "Bash,Read,Write,Edit,Glob,Grep,Task",
          epicId: epicId,
          epicLabels: labels,
          pipelineStage: "product-spec",
          agentName: "product-manager",
        });

        return NextResponse.json({ success: true, action, epicId, session: rsSession });
      }

      // -------------------------------------------------------------------
      // REVISE ARCHITECTURE: Re-run Architect agent with feedback (stays in Architecture)
      // (factory-core-lxc.5)
      // -------------------------------------------------------------------
      case "revise-architecture": {
        // beads_web-ehp.11: precondition gate (DISPATCHING).
        const refusal = await checkPreconditionsOrRefuse({ epicId, fleetCorePath, action: "revise-architecture", waveNumber: parsedWaveNumber });
        if (refusal) return refusal;

        await addLabelsToEpic(epicId, ["agent:running"], fleetCorePath);
        invalidateCache({ type: "epic", epicId });

        const { repoPath: raRepoPath, repoName: raRepoName, researchPath: raResearchPath, specPath: raSpecPath } = resolveRepoPath(
          shipType,
          epicTitle as string,
          appName,
          epicId as string,
          fleetCorePath
        );

        // factory-core-zszt.3
        const { feedbackStr: raFeedbackStr, feedbackBeadStr: raFeedbackBeadStr } =
          await materialiseFeedback({
            feedback,
            stage: "architecture",
            epicId,
            shipType,
            fleetCorePath,
          });

        // beads_web-y9u: apply standing-orders directive.
        const raPrompt = `Revise architecture for epic ${epicId} (${epicTitle}). Ship type: ${shipType}. Functional spec: ${raSpecPath}. Research report: ${raResearchPath}. Fleet-core: ${fleetCorePath}.${raFeedbackStr}${raFeedbackBeadStr}\n\n${formatAgentStandingOrdersDirective(fleetCorePath, shipType, "architect")}`;

        const raSession = await launchAgent({
          repoPath: raRepoPath,
          repoName: raRepoName,
          prompt: raPrompt,
          model: "opus",
          maxTurns: 150,
          allowedTools: "Bash,Read,Write,Edit,Glob,Grep,Task",
          epicId: epicId,
          epicLabels: labels,
          pipelineStage: "architecture",
          agentName: "architect",
        });

        return NextResponse.json({ success: true, action, epicId, session: raSession });
      }

      // -------------------------------------------------------------------
      // RUN TEST-SPEC: Plan Review -> Test Spec (launch test-spec agent)
      // (factory-core-a7qf.10)
      // -------------------------------------------------------------------
      case "run-test-spec": {
        // beads_web-ehp.11: precondition gate (DISPATCHING).
        const refusal = await checkPreconditionsOrRefuse({ epicId, fleetCorePath, action: "run-test-spec", waveNumber: parsedWaveNumber });
        if (refusal) return refusal;

        // zsjv.4 fix: clear ALL pipeline:* labels first.
        const rtsLabelsNow = await getEpicLabels(epicId as string, fleetCorePath);
        await removeAllPipelineLabels(epicId as string, rtsLabelsNow, fleetCorePath);
        const runTestSpecAddedLabels = ["pipeline:test-spec", "agent:running"];
        await addLabelsToEpic(epicId, runTestSpecAddedLabels, fleetCorePath);
        invalidateCache({ type: "epic", epicId });

        const { repoPath: tsRepoPath, researchPath: tsResearchPath, specPath: tsSpecPath, architecturePath: tsArchPath } = resolveRepoPath(
          shipType,
          epicTitle as string,
          appName,
          epicId as string,
          fleetCorePath
        );

        // beads_web-y9u: apply standing-orders directive.
        const tsPrompt = `Write test scenarios for epic ${epicId} (${epicTitle}). Ship type: ${shipType}. Functional spec: ${tsSpecPath}. Architecture: ${tsArchPath}. Research: ${tsResearchPath}. Product repo: ${tsRepoPath}. Fleet-core: ${fleetCorePath}.\n\n${formatAgentStandingOrdersDirective(fleetCorePath, shipType, "test-spec")}`;

        // beads_web-poh.9: revert on launch failure.
        let tsSession;
        try {
          tsSession = await launchAgent({
            repoPath: fleetCorePath,
            repoName: "fleet-core",
            prompt: tsPrompt,
            model: "opus",
            maxTurns: 200,
            allowedTools: "Bash,Read,Write,Edit,Glob,Grep,Task",
            epicId: epicId,
            epicLabels: labels,
            pipelineStage: "test-spec",
            agentName: "test-spec",
          });
        } catch (launchErr) {
          await revertLaunchSideEffects(epicId, fleetCorePath, {
            addedLabels: runTestSpecAddedLabels,
          });
          throw launchErr;
        }

        return NextResponse.json({ success: true, action, epicId, session: tsSession });
      }

      // -------------------------------------------------------------------
      // REVISE TEST-SPEC: Re-run test-spec agent with feedback (stays in Test Spec)
      // (factory-core-a7qf.10)
      // -------------------------------------------------------------------
      case "revise-test-spec": {
        // beads_web-ehp.11: precondition gate (DISPATCHING).
        const refusal = await checkPreconditionsOrRefuse({ epicId, fleetCorePath, action: "revise-test-spec", waveNumber: parsedWaveNumber });
        if (refusal) return refusal;

        await addLabelsToEpic(epicId, ["agent:running"], fleetCorePath);
        invalidateCache({ type: "epic", epicId });

        const { repoPath: rtsRepoPath, researchPath: rtsResearchPath, specPath: rtsSpecPath, architecturePath: rtsArchPath } = resolveRepoPath(
          shipType,
          epicTitle as string,
          appName,
          epicId as string,
          fleetCorePath
        );

        // factory-core-zszt.3
        const { feedbackStr: rtsFeedbackStr, feedbackBeadStr: rtsFeedbackBeadStr } =
          await materialiseFeedback({
            feedback,
            stage: "test-spec",
            epicId,
            shipType,
            fleetCorePath,
          });

        // beads_web-y9u: apply standing-orders directive.
        const rtsPrompt = `Revise test scenarios for epic ${epicId} (${epicTitle}). Ship type: ${shipType}. Functional spec: ${rtsSpecPath}. Architecture: ${rtsArchPath}. Research: ${rtsResearchPath}. Product repo: ${rtsRepoPath}. Fleet-core: ${fleetCorePath}.${rtsFeedbackStr}${rtsFeedbackBeadStr}\n\n${formatAgentStandingOrdersDirective(fleetCorePath, shipType, "test-spec")}`;

        const rtsSession = await launchAgent({
          repoPath: fleetCorePath,
          repoName: "fleet-core",
          prompt: rtsPrompt,
          model: "opus",
          maxTurns: 200,
          allowedTools: "Bash,Read,Write,Edit,Glob,Grep,Task",
          epicId: epicId,
          epicLabels: labels,
          pipelineStage: "test-spec",
          agentName: "test-spec",
        });

        return NextResponse.json({ success: true, action, epicId, session: rtsSession });
      }

      // -------------------------------------------------------------------
      // ABANDON: Any stage -> Bad Ideas
      // -------------------------------------------------------------------
      case "deprioritise": {
        // beads_web-ehp.11: precondition gate (DISPATCHING — mutates pipeline:* + closes epic).
        const refusal = await checkPreconditionsOrRefuse({ epicId, fleetCorePath, action: "deprioritise", waveNumber: parsedWaveNumber });
        if (refusal) return refusal;

        // Stop any running agent before abandoning
        await stopAgent();
        await removeAllPipelineLabels(epicId, labels, fleetCorePath);
        await removeLabelsFromEpic(epicId, ["plan:pending", "plan:approved", "agent:running"], fleetCorePath);
        await addLabelsToEpic(epicId, ["pipeline:bad-idea"], fleetCorePath);
        const reason = typeof feedback === "string" && feedback.trim()
          ? feedback
          : "Abandoned from fleet board";
        await closeEpic(epicId, reason, fleetCorePath);
        invalidateCache({ type: "epic", epicId });

        return NextResponse.json({ success: true, action, epicId });
      }

      // -------------------------------------------------------------------
      // APPROVE SUBMISSION: Prepare for Submission -> Submitted
      // -------------------------------------------------------------------
      case "approve-submission": {
        // beads_web-ehp.11: precondition gate (DISPATCHING).
        const refusal = await checkPreconditionsOrRefuse({ epicId, fleetCorePath, action: "approve-submission", waveNumber: parsedWaveNumber });
        if (refusal) return refusal;

        await addLabelsToEpic(epicId, ["agent:running"], fleetCorePath);
        invalidateCache({ type: "epic", epicId });

        const session = await launchAgent({
          repoPath: fleetCorePath,
          repoName: "fleet-core",
          prompt: `Prepare submission for "${epicTitle}" (epic: ${epicId}). Follow the submission workflow in .claude/agents/submitter.md. Ship type: ${shipType}.`,
          model: "opus",
          maxTurns: 100,
          allowedTools: "Bash,Read,Write,Edit,Glob,Grep,Task",
          epicId: epicId,
          epicLabels: labels,
          pipelineStage: "submission-prep",
          agentName: "submitter",
        });

        return NextResponse.json({ success: true, action, epicId, session });
      }

      // -------------------------------------------------------------------
      // SEND BACK TO DEVELOPMENT: Prepare for Submission -> In Development
      // -------------------------------------------------------------------
      case "send-back-to-dev": {
        // beads_web-ehp.11: precondition gate (DISPATCHING).
        const refusal = await checkPreconditionsOrRefuse({ epicId, fleetCorePath, action: "send-back-to-dev", waveNumber: parsedWaveNumber });
        if (refusal) return refusal;

        // Remove ALL pipeline:* labels to prevent orphans (factory-core-hnv.24)
        // Previously only removed submission-prep/deploying/qa, missing ux-polish etc.
        const sendBackLabels = await getEpicLabels(epicId as string, fleetCorePath);

        // factory-core-rgqd F8: capture the stage we're sending back FROM
        // so the feedback bead is properly tagged. Do this before label
        // mutation strips the pipeline:* labels we need for tagging.
        const originStageLabel = sendBackLabels.find((l) => l.startsWith("pipeline:"));
        const originStage = originStageLabel
          ? originStageLabel.replace("pipeline:", "")
          : "unknown";

        await removeAllPipelineLabels(epicId as string, sendBackLabels, fleetCorePath);
        await addLabelsToEpic(epicId, ["pipeline:development", "agent:running"], fleetCorePath);
        invalidateCache({ type: "epic", epicId });

        const { repoPath, repoName, researchPath } = resolveRepoPath(
          shipType,
          epicTitle as string,
          appName,
          epicId as string,
          fleetCorePath
        );

        // factory-core-rgqd F8: materialise non-trivial feedback as a bug
        // bead so the builder has a concrete, closeable artefact to resolve
        // — not just free-text lost after the session ends.
        let feedbackBeadId: string | null = null;
        if (typeof feedback === "string" && feedback.trim().length >= 30) {
          feedbackBeadId = await createFeedbackBead({
            epicId: epicId as string,
            feedback,
            stage: originStage,
            shipType,
            fleetCorePath,
          });
        }

        const feedbackStr2 = typeof feedback === "string" && feedback.trim()
          ? ` Jane's feedback: "${feedback}".`
          : "";
        const feedbackBeadStr = feedbackBeadId
          ? ` A feedback bug bead ${feedbackBeadId} has been filed under this epic with the full feedback as its description and acceptance criteria — you MUST close that bead as part of your fix. Do not simply read the feedback and move on; the bead is the contract.`
          : "";

        const sendBackPrompt = `Continue building epic ${epicId} (${epicTitle}). Ship type: ${shipType}. Product repo: ${repoPath}. Research report: ${researchPath}.${feedbackStr2}${feedbackBeadStr}\n\n${formatBuilderStandingOrdersDirective(fleetCorePath, shipType)}`;

        const session = await launchAgent({
          repoPath: repoPath,
          repoName: repoName,
          prompt: sendBackPrompt,
          model: "opus",
          maxTurns: 500,
          allowedTools: isVenture
            ? "Bash,Read,Write,Edit,Glob,Grep,Task,WebSearch"
            : "Bash,Read,Write,Edit,Glob,Grep,Task",
          epicId: epicId,
          epicLabels: labels,
          pipelineStage: "development",
          agentName: "builder",
        });

        return NextResponse.json({ success: true, action, epicId, session });
      }

      // -------------------------------------------------------------------
      // MARK AS LIVE: Submitted -> Kit Management
      // -------------------------------------------------------------------
      case "mark-as-live": {
        // beads_web-ehp.11: precondition gate (DISPATCHING).
        const refusal = await checkPreconditionsOrRefuse({ epicId, fleetCorePath, action: "mark-as-live", waveNumber: parsedWaveNumber });
        if (refusal) return refusal;

        // Remove submitted and submission:* labels
        const submissionLabels = labels.filter(
          (l) => l === "pipeline:submitted" || l.startsWith("submission:"),
        );
        await removeLabelsFromEpic(epicId, submissionLabels, fleetCorePath);
        await addLabelsToEpic(epicId, ["pipeline:kit-management", "agent:running"], fleetCorePath);
        invalidateCache({ type: "epic", epicId });

        const session = await launchAgent({
          repoPath: fleetCorePath,
          repoName: "fleet-core",
          prompt: `Analyze "${epicTitle}" for kit enhancements (epic: ${epicId}). Follow the kit analysis workflow in CLAUDE.md.`,
          model: "opus",
          maxTurns: 200,
          allowedTools: "Bash,Read,Write,Edit,Glob,Grep,Task",
          epicId: epicId,
          epicLabels: labels,
          pipelineStage: "kit-management",
          agentName: "kit-analyzer",
        });

        return NextResponse.json({ success: true, action, epicId, session });
      }

      // -------------------------------------------------------------------
      // GENERATE PLAN: Research Complete -> Planning (launch planning agent)
      // -------------------------------------------------------------------
      case "generate-plan": {
        // beads_web-ehp.11: precondition gate (DISPATCHING).
        const refusal = await checkPreconditionsOrRefuse({ epicId, fleetCorePath, action: "generate-plan", waveNumber: parsedWaveNumber });
        if (refusal) return refusal;

        // beads_web-poh.19: strip ALL pipeline:* labels before adding
        // the new one. Pre-fix this handler only removed pipeline:research
        // -complete + pipeline:architecture explicitly, so an epic that had
        // drifted into a different pipeline:* state (e.g. coherence
        // fast-forward from an earlier stage) would carry both the prior
        // label and pipeline:plan-review after dispatch.
        const generatePlanLabelsNow = await getEpicLabels(epicId as string, fleetCorePath);
        await removeAllPipelineLabels(epicId as string, generatePlanLabelsNow, fleetCorePath);
        const generatePlanAddedLabels = ["pipeline:plan-review", "agent:running"];
        await addLabelsToEpic(epicId, generatePlanAddedLabels, fleetCorePath);
        invalidateCache({ type: "epic", epicId });

        const { repoPath, researchPath, specPath, architecturePath } = resolveRepoPath(
          shipType,
          epicTitle as string,
          appName,
          epicId as string,
          fleetCorePath
        );

        // Non-ventures have functional spec and architecture doc from PM/Architect stages
        const specInfo = specPath ? ` Functional spec: ${specPath}.` : "";
        const archInfo = architecturePath ? ` Architecture: ${architecturePath}.` : "";
        // Planner runs in fleet-core (where specs/research live) but creates beads in the product repo
        // beads_web-y9u: apply standing-orders directive.
        const planPrompt = `Plan epic ${epicId} (${epicTitle}). Ship type: ${shipType}. Entry point: from-research. Product repo: ${repoPath}. Research report: ${researchPath}.${specInfo}${archInfo} Fleet-core: ${fleetCorePath}.\n\n${formatAgentStandingOrdersDirective(fleetCorePath, shipType, "planner")}`;

        // beads_web-poh.9: revert on launch failure.
        let session;
        try {
          session = await launchAgent({
            repoPath: fleetCorePath,
            repoName: "fleet-core",
            prompt: planPrompt,
            model: "opus",
            maxTurns: 200,
            allowedTools: "Bash,Read,Write,Edit,Glob,Grep,Task",
            epicId: epicId,
            epicLabels: labels,
            pipelineStage: "planning",
            agentName: "planner",
          });
        } catch (launchErr) {
          await revertLaunchSideEffects(epicId, fleetCorePath, {
            addedLabels: generatePlanAddedLabels,
          });
          throw launchErr;
        }

        return NextResponse.json({ success: true, action, epicId, session });
      }

      // -------------------------------------------------------------------
      // APPROVE PLAN: plan:pending -> plan:approved (label change only)
      // -------------------------------------------------------------------
      case "approve-plan": {
        // beads_web-ehp.11: precondition gate (DISPATCHING per library —
        // plan-label mutation gates downstream dispatch; see ehp.13's
        // DISPATCHING_ACTIONS classification).
        const refusal = await checkPreconditionsOrRefuse({ epicId, fleetCorePath, action: "approve-plan", waveNumber: parsedWaveNumber });
        if (refusal) return refusal;

        await removeLabelsFromEpic(epicId, ["plan:pending"], fleetCorePath);
        await addLabelsToEpic(epicId, ["plan:approved"], fleetCorePath);
        invalidateCache({ type: "epic", epicId });

        return NextResponse.json({ success: true, action, epicId });
      }

      // -------------------------------------------------------------------
      // APPROVE & BUILD: Approve plan + immediately start development
      // -------------------------------------------------------------------
      case "approve-and-build": {
        // beads_web-ehp.11: precondition gate (DISPATCHING).
        const refusal = await checkPreconditionsOrRefuse({ epicId, fleetCorePath, action: "approve-and-build", waveNumber: parsedWaveNumber });
        if (refusal) return refusal;

        // Approve the plan and route to test-spec (not development)
        // Test-spec writes test scenarios before the builder starts
        //
        // factory-core-k7gy.5 — `fromChain: true` means the orchestrator is
        // dispatching after a PASS verdict from the reviewer agent. In that
        // path the reviewer has already replaced plan:pending with
        // plan:reviewing, so we clean up plan:reviewing/plan:reviewed instead
        // of plan:pending. ADR-008 — byte-identical owner-click path preserved
        // when `fromChain` is absent or explicitly false.
        //
        // zsjv.4 fix (2026-04-21): clear ALL pipeline:* labels first. The
        // previous implementation only removed pipeline:research-complete,
        // which left pipeline:plan-review behind for fromChain=true path —
        // epic ended up with both pipeline:plan-review AND pipeline:test-spec.
        const aabLabelsNow = await getEpicLabels(epicId as string, fleetCorePath);
        await removeAllPipelineLabels(epicId as string, aabLabelsNow, fleetCorePath);
        if (fromChain === true) {
          await removeLabelsFromEpic(
            epicId,
            [
              "plan:reviewing",
              "plan:reviewed",
              "plan:needs-revision",
            ],
            fleetCorePath,
          );
        } else {
          await removeLabelsFromEpic(
            epicId,
            ["plan:pending"],
            fleetCorePath,
          );
        }
        await addLabelsToEpic(epicId, ["plan:approved", "pipeline:test-spec", "agent:running"], fleetCorePath);
        invalidateCache({ type: "epic", epicId });

        const { repoPath: aabRepoPath, researchPath: aabResearchPath, specPath: aabSpecPath, architecturePath: aabArchPath } = resolveRepoPath(
          shipType,
          epicTitle as string,
          appName,
          epicId as string,
          fleetCorePath
        );

        const aabSpecInfo = aabSpecPath ? ` Functional spec: ${aabSpecPath}.` : "";
        const aabArchInfo = aabArchPath ? ` Architecture: ${aabArchPath}.` : "";
        // beads_web-y9u: apply standing-orders directive (approve-and-build dispatches test-spec).
        const aabPrompt = `Write test scenarios for epic ${epicId} (${epicTitle}). Ship type: ${shipType}.${aabSpecInfo}${aabArchInfo} Research report: ${aabResearchPath}. Product repo: ${aabRepoPath}. Fleet-core: ${fleetCorePath}.\n\n${formatAgentStandingOrdersDirective(fleetCorePath, shipType, "test-spec")}`;

        const session = await launchAgent({
          repoPath: fleetCorePath,
          repoName: "fleet-core",
          prompt: aabPrompt,
          model: "opus",
          maxTurns: 200,
          allowedTools: "Bash,Read,Write,Edit,Glob,Grep,Task",
          epicId: epicId,
          epicLabels: labels,
          pipelineStage: "test-spec",
          agentName: "test-spec",
        });

        return NextResponse.json({ success: true, action, epicId, session });
      }

      // -------------------------------------------------------------------
      // REVISE PLAN: Re-launch planning agent with feedback
      // -------------------------------------------------------------------
      case "revise-plan": {
        // beads_web-ehp.11: precondition gate (DISPATCHING).
        const refusal = await checkPreconditionsOrRefuse({ epicId, fleetCorePath, action: "revise-plan", waveNumber: parsedWaveNumber });
        if (refusal) return refusal;

        await removeLabelsFromEpic(epicId, ["plan:approved", "plan:pending"], fleetCorePath);
        await addLabelsToEpic(epicId, ["agent:running"], fleetCorePath);
        invalidateCache({ type: "epic", epicId });

        const { repoPath } = resolveRepoPath(
          shipType,
          epicTitle as string,
          appName,
          epicId as string,
          fleetCorePath
        );

        // factory-core-zszt.3
        const { feedbackStr: feedbackStr3, feedbackBeadStr: feedbackBeadStr3 } =
          await materialiseFeedback({
            feedback,
            stage: "plan-review",
            epicId,
            shipType,
            fleetCorePath,
          });

        // beads_web-y9u: apply standing-orders directive.
        const revisePlanPrompt = `Revise plan for epic ${epicId} (${epicTitle}). Ship type: ${shipType}. Entry point: revise-plan. Product repo: ${repoPath}. Fleet-core: ${fleetCorePath}.${feedbackStr3}${feedbackBeadStr3}\n\n${formatAgentStandingOrdersDirective(fleetCorePath, shipType, "planner")}`;

        const session = await launchAgent({
          repoPath: fleetCorePath,
          repoName: "fleet-core",
          prompt: revisePlanPrompt,
          model: "opus",
          maxTurns: 200,
          allowedTools: "Bash,Read,Write,Edit,Glob,Grep,Task",
          epicId: epicId,
          epicLabels: labels,
          pipelineStage: "planning",
          agentName: "planner",
        });

        return NextResponse.json({ success: true, action, epicId, session });
      }

      // -------------------------------------------------------------------
      // SKIP TO PLAN: Candidates -> Planning (no research, straight to plan)
      // -------------------------------------------------------------------
      case "skip-to-plan": {
        // beads_web-ehp.11: precondition gate (DISPATCHING).
        const refusal = await checkPreconditionsOrRefuse({ epicId, fleetCorePath, action: "skip-to-plan", waveNumber: parsedWaveNumber });
        if (refusal) return refusal;

        // zsjv.4 fix: clear any existing pipeline:* labels first.
        const stpLabelsNow = await getEpicLabels(epicId as string, fleetCorePath);
        await removeAllPipelineLabels(epicId as string, stpLabelsNow, fleetCorePath);
        await addLabelsToEpic(epicId, ["pipeline:research-complete", "agent:running"], fleetCorePath);
        await updateEpicStatus(epicId, "in_progress", fleetCorePath);
        invalidateCache({ type: "epic", epicId });

        const { repoPath, repoName } = resolveRepoPath(
          shipType,
          epicTitle as string,
          appName,
          epicId as string,
          fleetCorePath
        );

        // beads_web-y9u: apply standing-orders directive.
        const skipPlanPrompt = `Plan epic ${epicId} (${epicTitle}). Ship type: ${shipType}. Entry point: from-candidates. Product repo: ${repoPath}. No recon brief.\n\n${formatAgentStandingOrdersDirective(fleetCorePath, shipType, "planner")}`;

        const session = await launchAgent({
          repoPath: repoPath,
          repoName: repoName,
          prompt: skipPlanPrompt,
          model: "opus",
          maxTurns: 200,
          allowedTools: "Bash,Read,Write,Edit,Glob,Grep,Task",
          epicId: epicId,
          epicLabels: labels,
          pipelineStage: "planning",
          agentName: "planner",
        });

        return NextResponse.json({ success: true, action, epicId, session });
      }

      // -------------------------------------------------------------------
      // REVISE PLAN FROM LAUNCH: Submission Prep -> Planning (with feedback)
      // -------------------------------------------------------------------
      case "revise-plan-from-launch": {
        // beads_web-ehp.11: precondition gate (DISPATCHING).
        const refusal = await checkPreconditionsOrRefuse({ epicId, fleetCorePath, action: "revise-plan-from-launch", waveNumber: parsedWaveNumber });
        if (refusal) return refusal;

        // zsjv.4 fix: clear ALL pipeline:* labels.
        const rpflLabelsNow = await getEpicLabels(epicId as string, fleetCorePath);
        await removeAllPipelineLabels(epicId as string, rpflLabelsNow, fleetCorePath);
        await addLabelsToEpic(epicId, ["pipeline:research-complete", "agent:running"], fleetCorePath);
        invalidateCache({ type: "epic", epicId });

        const { repoPath } = resolveRepoPath(
          shipType,
          epicTitle as string,
          appName,
          epicId as string,
          fleetCorePath
        );

        // factory-core-zszt.3
        const { feedbackStr: feedbackStr4, feedbackBeadStr: feedbackBeadStr4 } =
          await materialiseFeedback({
            feedback,
            stage: "submission-prep",
            epicId,
            shipType,
            fleetCorePath,
          });

        const session = await launchAgent({
          repoPath: fleetCorePath,
          repoName: "fleet-core",
          // beads_web-y9u: apply standing-orders directive.
          prompt: `Revise plan for epic ${epicId} (${epicTitle}). Ship type: ${shipType}. Entry point: revise-plan. Product repo: ${repoPath}. Fleet-core: ${fleetCorePath}.${feedbackStr4}${feedbackBeadStr4}\n\n${formatAgentStandingOrdersDirective(fleetCorePath, shipType, "planner")}`,
          model: "opus",
          maxTurns: 200,
          allowedTools: "Bash,Read,Write,Edit,Glob,Grep,Task",
          epicId: epicId,
          epicLabels: labels,
          pipelineStage: "planning",
          agentName: "planner",
        });

        return NextResponse.json({ success: true, action, epicId, session });
      }

      // -------------------------------------------------------------------
      // SEND FOR QA: Development Complete -> QA Verification
      // -------------------------------------------------------------------
      // -------------------------------------------------------------------
      // RUN POLISH: QA-round-N -> UX-polish (iOS / macOS only)
      // factory-core-rgqd F2 — wires the existing ux-polish agent into the
      // auto-chain. After QA passes with no bugs and ship type has a polish
      // agent, boot simulator, install, screenshot every screen in light and
      // dark mode. Files bugs or passes to next QA round.
      // -------------------------------------------------------------------
      case "run-polish": {
        // beads_web-ehp.11: precondition gate (DISPATCHING).
        const refusal = await checkPreconditionsOrRefuse({ epicId, fleetCorePath, action: "run-polish", waveNumber: parsedWaveNumber });
        if (refusal) return refusal;

        const actualLabels = await getEpicLabels(epicId as string, fleetCorePath);
        await removeAllPipelineLabels(epicId as string, actualLabels, fleetCorePath);
        await addLabelsToEpic(epicId, ["pipeline:ux-polish", "agent:running"], fleetCorePath);
        invalidateCache({ type: "epic", epicId });

        const polishAppName = extractAppName(epicTitle as string) ?? appName;
        const { repoPath, repoName, planPath } = resolveRepoPath(
          shipType,
          epicTitle as string,
          polishAppName,
          epicId as string,
          fleetCorePath,
        );

        const polishShipKey = shipType.replace("-app", "");
        const polishAgentName = (polishShipKey === "ios" || polishShipKey === "macos")
          ? `platforms/${polishShipKey}/polish`
          : null;

        if (!polishAgentName) {
          // Defensive — handleChainAction should only call us for ship types
          // with a polish agent. But if it does misfire, skip through to
          // submission-prep rather than throwing.
          // factory-core-zszt.4: even in this defensive branch, enforce the
          // smoke-test freshness gate for iOS/macOS epics. If we got here
          // with shipType=ios-app but no polish agent, something is
          // misconfigured — better to stay at ux-polish and surface the
          // issue than silently submit without runtime verification.
          const { checkSmokeTestFreshness } = await import(
            "@/lib/smoke-test-freshness"
          );
          const freshness = await checkSmokeTestFreshness(shipType, repoPath);
          if (!freshness.ok) {
            console.error(
              `[smoke-test-freshness] blocking polish-fallback -> submission-prep for ${epicId}: ${freshness.reason}`,
            );
            return NextResponse.json({
              success: false,
              action,
              epicId,
              dispatched: "blocked-smoke-test-stale-or-failed",
              shipType,
              reason: freshness.reason,
              smokeTestClass: freshness.class,
            }, { status: 409 });
          }
          await removeLabelsFromEpic(epicId, ["pipeline:ux-polish", "agent:running"], fleetCorePath);
          await addLabelsToEpic(epicId, ["pipeline:submission-prep", "qa:needs-review"], fleetCorePath);
          invalidateCache({ type: "epic", epicId });
          return NextResponse.json({ success: true, action, epicId, dispatched: "skipped-no-polish-agent", shipType });
        }

        const polishPrompt = `Run UX polish for epic ${epicId} (${epicTitle}). Ship type: ${shipType}. Product repo: ${repoPath}. Build plan: ${planPath}. Launch the simulator, take screenshots of every screen in light and dark mode via tools/platforms/ios/snapship.sh where available, and file bug beads for any visual / runtime issues.\n\n${formatAgentStandingOrdersDirective(fleetCorePath, shipType, polishAgentName)}`;

        const polishSession = await launchAgent({
          repoPath: repoPath,
          repoName: repoName,
          prompt: polishPrompt,
          model: "opus",
          maxTurns: 150,
          allowedTools: "Bash,Read,Write,Glob,Grep,Task",
          epicId: epicId,
          epicLabels: labels,
          pipelineStage: "ux-polish",
          agentName: polishAgentName,
        });

        return NextResponse.json({ success: true, action, epicId, session: polishSession });
      }

      // -------------------------------------------------------------------
      // RUN SMOKE-TEST: Development -> Smoke-test (iOS / macOS only)
      // factory-core-rgqd F1 — runs the runtime smoke test after wave
      // completion, BEFORE build-review/QA. Catches the "compiles but
      // crashes on launch" class of failure that BreathCycle exposed.
      // Ship types without a smoke-test skip straight to build-review.
      // -------------------------------------------------------------------
      case "run-smoke-test": {
        // beads_web-ehp.11: precondition gate (DISPATCHING).
        const refusal = await checkPreconditionsOrRefuse({ epicId, fleetCorePath, action: "run-smoke-test", waveNumber: parsedWaveNumber });
        if (refusal) return refusal;

        const actualLabels = await getEpicLabels(epicId as string, fleetCorePath);
        await removeAllPipelineLabels(epicId as string, actualLabels, fleetCorePath);
        await addLabelsToEpic(epicId, ["pipeline:smoke-test", "agent:running"], fleetCorePath);
        invalidateCache({ type: "epic", epicId });

        const smokeAppName = extractAppName(epicTitle as string) ?? appName;
        const { repoPath, repoName, planPath } = resolveRepoPath(
          shipType,
          epicTitle as string,
          smokeAppName,
          epicId as string,
          fleetCorePath,
        );

        // Only iOS has a smoke-test agent today. Follow-on work will add
        // macos / web / python variants. For other ship types this action
        // is a no-op passthrough — the caller should skip straight to
        // build-review (auto-chain handles that branch, see handleChainAction).
        const stShipKey = shipType.replace("-app", "");
        const smokeAgentName = stShipKey === "ios"
          ? "platforms/ios/smoke-test"
          : null;

        if (!smokeAgentName) {
          // beads_web-poh.15: pre-fix this branch set pipeline:build-review
          // and returned, expecting "the caller's auto-chain" to dispatch
          // send-for-review. No such auto-chain existed — handleChainAction
          // only fires on agent EXIT, and no agent was launched here. Every
          // internal-ship-type epic (and any non-iOS ship type) silently
          // stalled at pipeline:build-review (factory-core-jcit reproducer).
          //
          // Fix: clear the smoke-test labels and fire send-for-review
          // inline. send-for-review's own handler sets
          // pipeline:build-review + agent:running and launches the
          // reviewer — same shape as the iOS smoke-test exit chain when
          // the smoke-test agent actually runs and exits.
          await removeLabelsFromEpic(epicId, ["pipeline:smoke-test", "agent:running"], fleetCorePath);
          invalidateCache({ type: "epic", epicId });

          let sendReviewStatus: number | null = null;
          let sendReviewError: string | null = null;
          try {
            const sendReviewRes = await fetch(getDefaultActionUrl(), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                action: "send-for-review",
                epicId,
                epicTitle,
                // send-for-review reads labels live; pass current ones for
                // event-log payloads but the route does its own getEpicLabels.
                currentLabels: await getEpicLabels(epicId as string, fleetCorePath),
              }),
            });
            sendReviewStatus = sendReviewRes.status;
            if (!sendReviewRes.ok) {
              sendReviewError = await sendReviewRes
                .text()
                .catch(() => "<unreadable>");
              console.warn(
                `[poh.15] passthrough send-for-review dispatch returned HTTP ${sendReviewRes.status} for ${epicId}: ${sendReviewError}`,
              );
            }
          } catch (err) {
            sendReviewError = err instanceof Error ? err.message : String(err);
            console.warn(
              `[poh.15] passthrough send-for-review fetch threw for ${epicId}: ${sendReviewError}`,
            );
          }

          return NextResponse.json({
            success: true,
            action,
            epicId,
            dispatched: "passthrough-to-send-for-review",
            shipType,
            sendReviewStatus,
            ...(sendReviewError && { sendReviewError }),
          });
        }

        const stPrompt = `Run the iOS smoke test for epic ${epicId} (${epicTitle}). Product repo: ${repoPath}. Scheme: ${smokeAppName}. Build plan: ${planPath}. Invoke tools/platforms/ios/smoke-test.sh. On FAIL file a bug under the epic; on PASS exit cleanly.\n\n${formatAgentStandingOrdersDirective(fleetCorePath, shipType, smokeAgentName)}`;

        const stSession = await launchAgent({
          repoPath: repoPath,
          repoName: repoName,
          prompt: stPrompt,
          model: "sonnet",
          maxTurns: 30,
          allowedTools: "Bash,Read,Glob,Grep",
          epicId: epicId,
          epicLabels: labels,
          pipelineStage: "smoke-test",
          agentName: smokeAgentName,
        });

        return NextResponse.json({ success: true, action, epicId, session: stSession });
      }

      // -------------------------------------------------------------------
      // RUN COHERENCE AGENT: factory-core-zsjv.4 — dispatch coherence.md
      // agent on an incoherent epic. Called by the coherence-escalation
      // reconciler rule when rule-level mechanical recovery isn't
      // appropriate (e.g. repeated-QA-round patterns require judgment).
      //
      // The coherence agent reads state, forms a diagnosis, dispatches
      // ONE action from its finite vocabulary, and exits. This action
      // handler just builds the prompt + launches — the agent does the
      // actual work.
      // -------------------------------------------------------------------
      case "run-coherence-agent": {
        // beads_web-ehp.11: precondition gate (DISPATCHING). Note: coherence
        // operates at the meta-layer and only adds agent:running (no
        // pipeline:* mutation), but it DOES launch an agent — so the
        // dispatching classification stands.
        const refusal = await checkPreconditionsOrRefuse({ epicId, fleetCorePath, action: "run-coherence-agent", waveNumber: parsedWaveNumber });
        if (refusal) return refusal;

        // Read current epic state so the agent has a compact summary
        // alongside the raw tools it'll use to dig deeper.
        const actualLabels = await getEpicLabels(
          epicId as string,
          fleetCorePath,
        );

        // Extract anomaly class + any context from request body. Not
        // strictly required (agent can infer from state), but including
        // when available sharpens the diagnosis prompt.
        const anomalyClass =
          typeof (body as Record<string, unknown>)?.anomalyClass === "string"
            ? ((body as Record<string, unknown>).anomalyClass as string)
            : "unspecified";

        // zsjv.6: optional coherenceContext — structured payload from
        // escalation rules (e.g. repeat-dispatch-escalation includes
        // stuckStage + attemptCount + recentActions). When present,
        // serialise into the prompt so the agent doesn't need to
        // re-derive it from bd queries + event log.
        //
        // wlsr.20: also forward escalationContext — the ADR-015 § 3 field
        // sent by Phase B reconciler rules (stuck-in-stage,
        // missed-wave-review-dispatch, wave-bead-mismatch). Both fields
        // are serialised into the prompt independently; coherence.md
        // documents both shapes.
        const coherenceContext = (body as Record<string, unknown>)
          ?.coherenceContext;
        const escalationContext = (body as Record<string, unknown>)
          ?.escalationContext;
        const contextParts: string[] = [];
        if (coherenceContext) {
          contextParts.push(
            `\n- coherenceContext: ${JSON.stringify(coherenceContext)}`,
          );
        }
        if (escalationContext) {
          contextParts.push(
            `\n- escalationContext: ${JSON.stringify(escalationContext)}`,
          );
        }
        const contextBlock = contextParts.join("");

        // beads_web-y9u: apply standing-orders directive (coherence — universal off-ramp).
        const cohPrompt = `You are the Coherence agent. Diagnose why epic ${epicId} is in an incoherent state and dispatch ONE action from your finite vocabulary.\n\nContext:\n- epicId: ${epicId}\n- epicTitle: ${epicTitle}\n- anomalyClass: ${anomalyClass}\n- currentLabels: ${JSON.stringify(actualLabels)}\n- shipType: ${shipType}\n- fleetCorePath: ${fleetCorePath}${contextBlock}\n\nFollow .claude/agents/coherence.md exactly. Append the required [COHERENCE] / [ACTION] / [REASONING] note to the epic before dispatching. Exit immediately after dispatch.\n\n${formatAgentStandingOrdersDirective(fleetCorePath, shipType, "coherence")}`;

        // agent:running label so the dashboard reflects the live
        // coherence session. We do NOT change pipeline:* — the coherence
        // agent operates at the meta-layer and should not disturb the
        // epic's pipeline stage.
        await addLabelsToEpic(
          epicId as string,
          ["agent:running"],
          fleetCorePath,
        );
        invalidateCache({ type: "epic", epicId });

        const cohSession = await launchAgent({
          repoPath: fleetCorePath,
          repoName: "fleet-core",
          prompt: cohPrompt,
          model: "opus",
          maxTurns: 60,
          allowedTools: "Bash,Read,Glob,Grep",
          epicId: epicId as string,
          epicLabels: actualLabels,
          // beads_web-poh.23 (2026-05-08): set pipelineStage="coherence" so the
          // resulting agent-exited event carries stage="coherence" (matching the
          // marker filename <epic>-coherence.json + STAGE_TO_AGENT_NAME identity
          // entry). Without this, agent-exited.stage was undefined and
          // marker-driven-routing's event-based path filtered the event out
          // entirely (matches() requires stage); the coherence marker was only
          // discoverable via the 5-min filesystem-walk fallback.
          pipelineStage: "coherence",
          agentName: "coherence",
        });

        return NextResponse.json({
          success: true,
          action,
          epicId,
          session: cohSession,
        });
      }

      case "send-for-qa": {
        // beads_web-ehp.11: precondition gate (DISPATCHING).
        const refusal = await checkPreconditionsOrRefuse({ epicId, fleetCorePath, action: "send-for-qa", waveNumber: parsedWaveNumber });
        if (refusal) return refusal;

        // Read actual labels from the epic (not stale request body labels)
        // to correctly determine QA round (factory-core-hnv.19)
        const actualLabels = await getEpicLabels(epicId as string, fleetCorePath);
        const roundLabels = actualLabels.filter(l => l.startsWith("qa:round-"));
        const currentRound = roundLabels.length > 0
          ? Math.max(...roundLabels.map(l => parseInt(l.split("-")[1]))) + 1
          : 1;

        // Remove ALL pipeline:* labels to prevent orphans (factory-core-hnv.24)
        // Previously only removed pipeline:development, missing ux-polish/build-review/etc.
        await removeAllPipelineLabels(epicId as string, actualLabels, fleetCorePath);
        await removeLabelsFromEpic(epicId, roundLabels, fleetCorePath);
        await addLabelsToEpic(epicId, ["pipeline:qa", `qa:round-${currentRound}`, "agent:running"], fleetCorePath);
        invalidateCache({ type: "epic", epicId });

        const qaAppName = extractAppName(epicTitle as string) ?? appName;
        const { repoPath, repoName, researchPath, planPath } = resolveRepoPath(
          shipType,
          epicTitle as string,
          qaAppName,
          epicId as string,
          fleetCorePath
        );

        // factory-core-mejh: Marker-read gate — check previous round's marker
        // before dispatching next QA round. Prevents the 3p1e dispatch-loop
        // (21 rounds, 34 ignored markers, operator hard-suppress only exit).
        if (currentRound > 1) {
          const previousRound = currentRound - 1;

          // Check review:needs-human label — dispatcher must not refire QA
          if (actualLabels.includes("review:needs-human")) {
            console.error(
              JSON.stringify({
                level: "ERROR",
                event: "qa_dispatch_halted",
                epicId,
                round: currentRound,
                reason: "review:needs-human present",
                message: `QA dispatch halted for ${epicId} round ${currentRound}: epic carries review:needs-human label. Operator intervention required.`,
              })
            );
            return NextResponse.json(
              {
                error: "QA dispatch halted",
                epicId,
                round: currentRound,
                reason: "review:needs-human present — operator intervention required",
              },
              { status: 500 }
            );
          }

          // Read the previous round's marker file
          const markerPath = path.join(
            repoPath,
            ".beads",
            "markers",
            `${epicId}-qa-round-${previousRound}.json`
          );
          let markerJson: string;
          try {
            markerJson = await fs.readFile(markerPath, "utf-8");
          } catch (err) {
            console.error(
              JSON.stringify({
                level: "ERROR",
                event: "qa_marker_read_failure",
                epicId,
                round: currentRound,
                previousRound,
                markerPath,
                error: err instanceof Error ? err.message : String(err),
                message: `QA dispatch halted for ${epicId} round ${currentRound}: cannot read marker for round ${previousRound} at ${markerPath}. Missing marker file.`,
              })
            );
            return NextResponse.json(
              {
                error: "QA dispatch halted — marker file missing",
                epicId,
                round: currentRound,
                previousRound,
                markerPath,
              },
              { status: 500 }
            );
          }

          let marker: { whats_open?: string[]; verdict?: string; open_bugs?: number; [key: string]: unknown };
          try {
            marker = JSON.parse(markerJson);
          } catch (err) {
            console.error(
              JSON.stringify({
                level: "ERROR",
                event: "qa_marker_parse_failure",
                epicId,
                round: currentRound,
                previousRound,
                markerPath,
                error: err instanceof Error ? err.message : String(err),
                message: `QA dispatch halted for ${epicId} round ${currentRound}: malformed JSON in marker for round ${previousRound} at ${markerPath}.`,
              })
            );
            return NextResponse.json(
              {
                error: "QA dispatch halted — malformed marker JSON",
                epicId,
                round: currentRound,
                previousRound,
                markerPath,
              },
              { status: 500 }
            );
          }

          // Check for BLOCKER directives in whats_open
          const whatsOpen = Array.isArray(marker.whats_open) ? marker.whats_open : [];
          const blockers = whatsOpen.filter(
            (item) => typeof item === "string" && item.startsWith("BLOCKER:")
          );
          if (blockers.length > 0) {
            console.error(
              JSON.stringify({
                level: "ERROR",
                event: "qa_dispatch_halted_blocker",
                epicId,
                round: currentRound,
                previousRound,
                blockers,
                message: `QA dispatch halted for ${epicId} round ${currentRound}: marker for round ${previousRound} contains BLOCKER directive(s): ${blockers.join("; ")}. Operator intervention required.`,
              })
            );
            return NextResponse.json(
              {
                error: "QA dispatch halted — BLOCKER directive in marker",
                epicId,
                round: currentRound,
                previousRound,
                blockers,
              },
              { status: 500 }
            );
          }

          // factory-core-0kkt: Verdict + open-bugs transition predicate.
          // Pre-fix: qa:round-N label exists → unconditionally advance to round-(N+1).
          // Post-fix: verdict=PASS AND openBugs=0 → TERMINATE (clear pipeline:qa, no next round).
          // Only FAIL/SKIP/UNKNOWN verdicts OR openBugs>0 advance to next round.
          // Empirical grounding: 3p1e rounds 3-21 all verdict=PASS, 0 bugs, yet advanced.
          const markerVerdict = marker.verdict;
          const markerOpenBugs = typeof marker.open_bugs === "number" ? marker.open_bugs : undefined;

          if (markerVerdict === "PASS" && markerOpenBugs === 0) {
            // QA loop complete — terminate. Remove the pipeline:qa, qa:round-N,
            // and agent:running labels that were already added at line ~1585
            // (before the marker gate runs). Do NOT add qa:round-(N+1).
            await removeLabelsFromEpic(
              epicId,
              ["pipeline:qa", `qa:round-${currentRound}`, "agent:running"],
              fleetCorePath
            );
            invalidateCache({ type: "epic", epicId });

            console.log(
              JSON.stringify({
                level: "INFO",
                event: "qa_loop_terminated",
                epicId,
                round: currentRound,
                previousRound,
                verdict: markerVerdict,
                openBugs: markerOpenBugs,
                message: `QA loop terminated for ${epicId}: round ${previousRound} verdict=PASS, 0 open bugs. No round ${currentRound} dispatched.`,
              })
            );
            return NextResponse.json({
              success: true,
              action,
              epicId,
              terminated: true,
              reason: "QA loop terminated: PASS verdict, 0 open bugs",
              lastRound: previousRound,
            });
          }
        }

        // factory-core-2r2m: QA ceiling check — defence-in-depth.
        // Even if 0kkt's verdict predicate says "advance" (verdict=FAIL or openBugs>0),
        // halt if the round about to be dispatched exceeds maxRounds from qa.md.
        // currentRound is the round about to dispatch (already incremented).
        // Check: currentRound > maxRounds (strict >, NOT >=). maxRounds=20 allows round 20.
        const maxRounds = await getQaMaxRounds(fleetCorePath);
        if (currentRound > maxRounds) {
          await addLabelsToEpic(epicId, ["review:needs-human"], fleetCorePath);
          invalidateCache({ type: "epic", epicId });

          console.error(
            JSON.stringify({
              level: "ERROR",
              event: "qa_ceiling_breached",
              epicId,
              attemptedRound: currentRound,
              maxRounds,
              message: `[qa-ceiling] Epic ${epicId} breached ceiling: attempted round ${currentRound} > maxRounds ${maxRounds}. Dispatch halted. review:needs-human set.`,
            })
          );
          return NextResponse.json(
            {
              success: false,
              reason: "QA ceiling breached",
              epicId,
              attemptedRound: currentRound,
              maxRounds,
            },
            { status: 200 }
          );
        }

        // Select platform-specific QA agent if available
        const platformQA = ["ios", "macos"];
        const qaAgentName = platformQA.includes(shipType.replace("-app", ""))
          ? `platforms/${shipType.replace("-app", "")}/qa`
          : "qa";

        // Get wave count so QA agent can assign wave:N+1 labels to bugs (factory-core-cur.1.18)
        let totalWavesStr = '';
        try {
          const waveStatus = await getWaveStatus(epicId as string, repoPath);
          if (waveStatus.hasWaves) {
            totalWavesStr = ` Total waves: ${waveStatus.totalWaves}.`;
          }
        } catch {
          // Wave count is optional; QA agent will fall back to checking labels
        }

        const session = await launchAgent({
          repoPath: repoPath,
          repoName: repoName,
          prompt: `Run QA for epic ${epicId} (${epicTitle}). Ship type: ${shipType}. QA round: ${currentRound}. Product repo: ${repoPath}. Research report: ${researchPath}. Build plan: ${planPath}.${totalWavesStr}\n\n${formatAgentStandingOrdersDirective(fleetCorePath, shipType, qaAgentName)}`,
          model: "opus",
          maxTurns: 200,
          allowedTools: "Bash,Read,Glob,Grep,Task",
          epicId: epicId,
          epicLabels: labels,
          pipelineStage: "qa",
          agentName: qaAgentName,
        });

        return NextResponse.json({ success: true, action, epicId, session, qaRound: currentRound });
      }

      // -------------------------------------------------------------------
      // QA FIX AND RETEST: QA found bugs -> Back to dev, then auto-retest
      // -------------------------------------------------------------------
      case "qa-fix-and-retest": {
        // beads_web-ehp.11: precondition gate (DISPATCHING).
        const refusal = await checkPreconditionsOrRefuse({ epicId, fleetCorePath, action: "qa-fix-and-retest", waveNumber: parsedWaveNumber });
        if (refusal) return refusal;

        // Called internally when QA finds bugs -- sends back to dev then auto-retests
        await removeLabelsFromEpic(epicId, ["pipeline:qa"], fleetCorePath);
        await addLabelsToEpic(epicId, ["pipeline:development", "agent:running"], fleetCorePath);
        invalidateCache({ type: "epic", epicId });

        const fixAppName = extractAppName(epicTitle as string) ?? appName;
        const { repoPath, repoName, researchPath, planPath } = resolveRepoPath(
          shipType,
          epicTitle as string,
          fixAppName,
          epicId as string,
          fleetCorePath
        );

        const session = await launchAgent({
          repoPath: repoPath,
          repoName: repoName,
          prompt: `Fix QA bugs for epic ${epicId} (${epicTitle}). Ship type: ${shipType}. Product repo: ${repoPath}. Research report: ${researchPath}. Build plan: ${planPath}.\n\n${formatBuilderStandingOrdersDirective(fleetCorePath, shipType)}`,
          model: "opus",
          maxTurns: 300,
          allowedTools: "Bash,Read,Write,Edit,Glob,Grep,Task",
          epicId: epicId,
          epicLabels: labels,
          pipelineStage: "qa-fixes",
          agentName: "builder",
        });

        return NextResponse.json({ success: true, action, epicId, session });
      }

      // -------------------------------------------------------------------
      // MARK READY TO DEPLOY: Building -> Deploying (venture only, label swap)
      // -------------------------------------------------------------------
      case "mark-ready-to-deploy": {
        // beads_web-ehp.11: precondition gate (DISPATCHING — label-only mutation).
        const refusal = await checkPreconditionsOrRefuse({ epicId, fleetCorePath, action: "mark-ready-to-deploy", waveNumber: parsedWaveNumber });
        if (refusal) return refusal;

        // zsjv.4 fix: clear ALL pipeline:* labels first.
        const mrtdLabelsNow = await getEpicLabels(epicId as string, fleetCorePath);
        await removeAllPipelineLabels(epicId as string, mrtdLabelsNow, fleetCorePath);
        await addLabelsToEpic(epicId, ["pipeline:deploying"], fleetCorePath);
        invalidateCache({ type: "epic", epicId });
        return NextResponse.json({ success: true, action, epicId });
      }

      // -------------------------------------------------------------------
      // MARK VENTURE LIVE: Deploying -> Live (venture only, label swap)
      // -------------------------------------------------------------------
      case "mark-venture-live": {
        // beads_web-ehp.11: precondition gate (DISPATCHING — label-only mutation).
        const refusal = await checkPreconditionsOrRefuse({ epicId, fleetCorePath, action: "mark-venture-live", waveNumber: parsedWaveNumber });
        if (refusal) return refusal;

        // zsjv.4 fix: clear ALL pipeline:* labels first.
        const mvlLabelsNow = await getEpicLabels(epicId as string, fleetCorePath);
        await removeAllPipelineLabels(epicId as string, mvlLabelsNow, fleetCorePath);
        await addLabelsToEpic(epicId, ["pipeline:live"], fleetCorePath);
        invalidateCache({ type: "epic", epicId });
        return NextResponse.json({ success: true, action, epicId });
      }

      // -------------------------------------------------------------------
      // MARK VENTURE COMPLETE: Live -> Completed (venture only, close epic)
      // -------------------------------------------------------------------
      case "mark-venture-complete": {
        // beads_web-ehp.11: precondition gate (DISPATCHING — pipeline mutation + closeEpic).
        const refusal = await checkPreconditionsOrRefuse({ epicId, fleetCorePath, action: "mark-venture-complete", waveNumber: parsedWaveNumber });
        if (refusal) return refusal;

        // zsjv.4 fix: clear ALL pipeline:* labels first.
        const mvcLabelsNow = await getEpicLabels(epicId as string, fleetCorePath);
        await removeAllPipelineLabels(epicId as string, mvcLabelsNow, fleetCorePath);
        await addLabelsToEpic(epicId, ["pipeline:completed"], fleetCorePath);
        await closeEpic(epicId, "Venture complete", fleetCorePath);
        invalidateCache({ type: "epic", epicId });
        return NextResponse.json({ success: true, action, epicId });
      }

      // -------------------------------------------------------------------
      // RESUME BUILD: Re-launch builder to fix open bugs/tasks
      // (factory-core-cur.1.17)
      // -------------------------------------------------------------------
      case "resume-build": {
        // beads_web-ehp.11: precondition gate (DISPATCHING).
        const refusal = await checkPreconditionsOrRefuse({ epicId, fleetCorePath, action: "resume-build", waveNumber: parsedWaveNumber });
        if (refusal) return refusal;

        await addLabelsToEpic(epicId, ["agent:running"], fleetCorePath);
        invalidateCache({ type: "epic", epicId });

        const { repoPath: rbRepoPath, repoName: rbRepoName, researchPath: rbResearchPath, planPath: rbPlanPath } = resolveRepoPath(
          shipType,
          epicTitle as string,
          appName,
          epicId as string,
          fleetCorePath
        );

        // factory-core-zszt.3: qa-fix-and-retest is the QA bug-fix loop.
        // Stage tag is "qa" (we don't know the round here without extra bd
        // reads; the bead's own notes + labels capture the round).
        const { feedbackStr: feedbackStrResume, feedbackBeadStr: feedbackBeadStrResume } =
          await materialiseFeedback({
            feedback,
            stage: "qa",
            epicId,
            shipType,
            fleetCorePath,
          });

        const resumePrompt = `Continue building epic ${epicId} (${epicTitle}). Ship type: ${shipType}. Product repo: ${rbRepoPath}. Research report: ${rbResearchPath}. Build plan: ${rbPlanPath}. Fix all open bugs and complete remaining tasks.${feedbackStrResume}${feedbackBeadStrResume}\n\n${formatBuilderStandingOrdersDirective(fleetCorePath, shipType)}`;

        const resumeSession = await launchAgent({
          repoPath: rbRepoPath,
          repoName: rbRepoName,
          prompt: resumePrompt,
          model: "opus",
          maxTurns: 500,
          allowedTools: isVenture
            ? "Bash,Read,Write,Edit,Glob,Grep,Task,WebSearch"
            : "Bash,Read,Write,Edit,Glob,Grep,Task",
          epicId: epicId,
          epicLabels: labels,
          pipelineStage: "development",
          agentName: "builder",
        });

        return NextResponse.json({ success: true, action, epicId, session: resumeSession });
      }

      // -------------------------------------------------------------------
      // START WAVE: Launch builders scoped to a specific wave.
      //
      // factory-core-z9h.3: one agent per bead in the wave. Beads with
      // disjoint Files: manifests launch in parallel; beads that share
      // any file are grouped together and launched sequentially (the
      // first bead in a conflict group launches now, later ones launch
      // when their predecessor closes — see handleChainAction, z9h.6).
      //
      // When the wave has only one open bead, or no open beads have a
      // Files: manifest yet (pre-z9h.7 epics), behaviour collapses to a
      // single launch — preserving the original start-wave contract
      // with just the per-bead scoping layered on top.
      //
      // If we can't enumerate beads (bd error, no children, no wave
      // labels), fall back to the legacy single-wave-session launch so
      // existing epics still work.
      // -------------------------------------------------------------------
      case "start-wave": {
        // beads_web-ehp.11: precondition gate (DISPATCHING). Wave-bead
        // predicates need the wave number — already coerced into
        // parsedWaveNumber at the top of POST.
        const refusal = await checkPreconditionsOrRefuse({ epicId, fleetCorePath, action: "start-wave", waveNumber: parsedWaveNumber });
        if (refusal) return refusal;

        const wave = typeof waveNumber === "number" ? waveNumber : parseInt(String(waveNumber), 10);
        if (isNaN(wave) || wave < 1) {
          return NextResponse.json({ error: "Invalid waveNumber" }, { status: 400 });
        }

        // beads_web-bot: re-read fresh labels for shipType. The currentLabels
        // payload forwarded by chainToNextStage (agent-launcher.ts:2054) is
        // session.epicLabels captured at the previous agent's launch time —
        // if any upstream dispatcher fired the epic without ship-type:<x> in
        // currentLabels, that staleness propagates through every auto-chain
        // hop. Earlier stages (research/PM/architect/planner/test-spec)
        // tolerate this because their launchAgent cwd is hardcoded to
        // fleetCorePath (e.g. route.ts:1198, 1461); start-wave is the first
        // handler whose cwd derivation depends on shipType via
        // resolveRepoPath. Re-reading from bd is the only fail-safe — mirrors
        // the rtsLabelsNow / raLabelsNow / pmLabelsNow / generatePlanLabelsNow
        // pattern already used in this route. swLabelsNow is also propagated
        // forward as the launched builder's epicLabels so downstream chain
        // hops don't inherit the inbound staleness.
        const swLabelsNow = await getEpicLabels(epicId as string, fleetCorePath);
        const swShipTypeLabel = swLabelsNow.find((l) =>
          l.startsWith("ship-type:"),
        );
        const swShipType = swShipTypeLabel
          ? swShipTypeLabel.replace("ship-type:", "")
          : shipType;

        await addLabelsToEpic(epicId, ["agent:running"], fleetCorePath);
        invalidateCache({ type: "epic", epicId });

        const {
          repoPath: waveRepoPath,
          repoName: waveRepoName,
          researchPath: waveResearchPath,
          planPath: wavePlanPath,
          specPath: waveSpecPath,
          architecturePath: waveArchitecturePath,
          testScenariosPath: waveTestScenariosPath,
        } = resolveRepoPath(
          swShipType,
          epicTitle as string,
          appName,
          epicId as string,
          fleetCorePath
        );

        const waveTestScenariosInfo = waveTestScenariosPath ? ` Test scenarios: ${waveTestScenariosPath}.` : "";
        const allowedTools = isVenture
          ? "Bash,Read,Write,Edit,Glob,Grep,Task,WebSearch"
          : "Bash,Read,Write,Edit,Glob,Grep,Task";

        // beads_web-4jb (AC 1): Bounding-rule gate — only factory-core
        // epics get cross-repo enumeration. Product epics use the existing
        // single-repo fast path.
        const isCrossRepoEpic = path.basename(waveRepoPath) === "factory-core";

        // beads_web-4jb (AC 7, emission point 1): log the bounding-rule decision.
        console.info(
          `[cross-repo] Epic ${epicId} resolved to ${waveRepoPath} (isCrossRepoEpic: ${isCrossRepoEpic})`,
        );

        // factory-core-z9h.9: listOpenWaveBeads / listOpenWaveBeadsAllRepos
        // now throws on bd failure rather than silently returning an empty
        // list. A bd outage must surface as a 500 so the auto-chain
        // registers the failure — we must not fall through to the legacy
        // wave-session branch with an incomplete bead set (that masks
        // unclosed work).
        //
        // beads_web-4jb (AC 2 + AC 3): cross-repo epics use the all-repos
        // enumerator; product epics use the existing single-repo call
        // (zero change in behaviour).
        let openBeads;
        try {
          openBeads = isCrossRepoEpic
            ? await listOpenWaveBeadsAllRepos(epicId as string, wave)
            : await listOpenWaveBeads(epicId as string, wave, waveRepoPath);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[start-wave] ${isCrossRepoEpic ? "listOpenWaveBeadsAllRepos" : "listOpenWaveBeads"} failed for ${epicId} wave ${wave}: ${message}`);
          return NextResponse.json(
            {
              error: `Failed to enumerate open wave beads: ${message}`,
              epicId,
              waveNumber: wave,
            },
            { status: 500 },
          );
        }

        // beads_web-4jb (AC 4): Request-lifetime cache — resolve each bead's
        // home repo via parallelised findRepoForIssue before the dispatch
        // loop. The cache ensures per-bead dispatch uses the correct cwd.
        //
        // RISK: if findRepoForIssue rejects for any bead, the cache has a
        // missing entry and `cache.get(beadId) ?? waveRepoPath` silently
        // falls back to the wrong repo. We must NOT swallow failures —
        // propagate as 500 (same pattern as the z9h.9 contract above).
        const beadRepoCache = new Map<string, string>();
        if (openBeads.length > 0) {
          try {
            const cacheResults = await Promise.all(
              openBeads.map(async (bead) => {
                const resolvedRepo = await findRepoForIssue(bead.id);
                return { beadId: bead.id, repoPath: resolvedRepo };
              }),
            );

            for (const { beadId, repoPath: resolvedRepo } of cacheResults) {
              if (resolvedRepo) {
                beadRepoCache.set(beadId, resolvedRepo);
                // beads_web-4jb (AC 7, emission point 2): log each cache entry.
                console.info(
                  `[cross-repo] Bead ${beadId} resolved to ${resolvedRepo} (cache: miss)`,
                );
              } else {
                // findRepoForIssue returned null — bead not found in any repo.
                // Fall back to waveRepoPath (the epic's repo).
                beadRepoCache.set(beadId, waveRepoPath);
                console.info(
                  `[cross-repo] Bead ${beadId} resolved to ${waveRepoPath} (cache: miss, fallback to waveRepoPath)`,
                );
              }
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(
              `[start-wave] Cache pre-populate failed for ${epicId} wave ${wave}: ${message}`,
            );
            return NextResponse.json(
              {
                error: `Failed to resolve bead repos (cache pre-populate): ${message}`,
                epicId,
                waveNumber: wave,
              },
              { status: 500 },
            );
          }

          // beads_web-4jb (AC 6): Bounding-rule runtime assertion — if a
          // product epic (isCrossRepoEpic === false) has any bead whose
          // home repo is NOT waveRepoPath, the handler throws. This catches
          // misconfigured product epics loudly rather than silently
          // dispatching a builder to the wrong cwd.
          if (!isCrossRepoEpic) {
            for (const [beadId, beadRepo] of beadRepoCache) {
              if (beadRepo !== waveRepoPath) {
                const msg = `Bounding-rule violation: product epic ${epicId} has cross-repo child ${beadId} (resolved to ${beadRepo}, expected ${waveRepoPath}). Product epics must not have cross-repo children — this indicates operator misconfiguration or a planner bug.`;
                console.error(`[cross-repo] ${msg}`);
                return NextResponse.json(
                  {
                    error: msg,
                    epicId,
                    waveNumber: wave,
                  },
                  { status: 500 },
                );
              }
            }
          }

          // beads_web-4jb (AC 7, emission point 3): bounding rule check passed.
          console.info(
            `[cross-repo] Bounding rule check passed for epic ${epicId}`,
          );
        }

        // Legacy fallback: no enumerable open beads → launch one wave-scoped
        // session as before. Keeps pre-z9h.7 epics working.
        if (openBeads.length === 0) {
          // beads_web-bot: swShipType + swLabelsNow used so the prompt and
          // forwarded epicLabels reflect bd ground truth, not the inbound
          // (possibly stale) currentLabels payload.
          const startWavePrompt = `Build Wave ${wave} beads for epic ${epicId} (${epicTitle}). Ship type: ${swShipType}. Product repo: ${waveRepoPath}. Research report: ${waveResearchPath}. Build plan: ${wavePlanPath}. Fleet-core: ${fleetCorePath}.${waveTestScenariosInfo} ${formatBuilderStandingOrdersDirective(fleetCorePath, swShipType)} ONLY work beads with wave:${wave} label. Do not advance to the next wave.`;

          const startWaveSession = await launchAgent({
            repoPath: waveRepoPath,
            repoName: waveRepoName,
            prompt: startWavePrompt,
            model: "opus",
            maxTurns: 500,
            allowedTools,
            epicId: epicId,
            epicLabels: swLabelsNow,
            pipelineStage: "development",
            agentName: "builder",
            waveNumber: wave,
          });

          return NextResponse.json({
            success: true,
            action,
            epicId,
            waveNumber: wave,
            dispatched: "wave-session",
            session: startWaveSession,
          });
        }

        // Group beads into parallel-safe clusters. Each group is launched
        // from its HEAD bead; when the head closes, handleChainAction (z9h.6)
        // launches the next bead in the group. Groups themselves launch in
        // parallel here.
        const groups = groupBeadsByFileConflict(openBeads);

        const launched: Array<{
          beadId: string;
          group: number;
          groupIndex: number;
          sessionId?: string;
          sessionName?: string;
        }> = [];
        const deferred: Array<{ beadId: string; group: number; groupIndex: number }> = [];
        const skipped: Array<{ beadId: string; group: number; reason: string }> = [];

        for (let g = 0; g < groups.length; g++) {
          const group = groups[g];
          // Launch the head of each group now. Tail beads wait.
          for (let i = 0; i < group.length; i++) {
            if (i > 0) {
              deferred.push({ beadId: group[i].id, group: g, groupIndex: i });
              continue;
            }
            const head = group[0];

            // beads_web-4jb (AC 5): resolve the bead's home repo from the
            // request-lifetime cache. Falls back to waveRepoPath when the
            // cache has no entry (defensive — the cache should always be
            // populated for every bead in openBeads).
            const beadRepoPath = beadRepoCache.get(head.id) ?? waveRepoPath;

            // factory-core-z9h.6: when start-wave is re-invoked by the
            // auto-chain (e.g. after a per-bead agent closes its bead),
            // skip heads that already have a live agent. This keeps the
            // re-invocation idempotent for already-launched heads while
            // still picking up any newly-unblocked tail beads.
            if (isAgentActive(beadRepoPath, head.id)) {
              skipped.push({
                beadId: head.id,
                group: g,
                reason: "agent already active",
              });
              continue;
            }

            // Build the focused per-bead prompt (factory-core-z9h.5).
            // Any failure in bd show / fs read degrades gracefully to a
            // generic prompt so a single broken bead doesn't break the
            // whole wave launch.
            //
            // beads_web-4jb (AC 5): all repo-path-dependent calls use
            // beadRepoPath (from cache) instead of waveRepoPath — this
            // ensures cross-repo beads load detail, checkpoint entries,
            // and build_prompt overrides from their home repo, not the
            // epic's repo.
            let perBeadPrompt: string;
            try {
              const detail = loadBeadDetail(head.id, beadRepoPath);
              const testScenarios = await loadBeadTestScenarios(
                waveTestScenariosPath,
                head.id,
              );
              const priorProgress = await loadCheckpointEntries(
                beadRepoPath,
                epicId as string,
                wave,
                head.id,
              );
              const buildPromptOverride = await loadBuildPromptOverride(
                beadRepoPath,
                head.id,
              );
              if (buildPromptOverride) {
                console.info(
                  `[start-wave] Using planner-authored build_prompt override for ${head.id} from .beads/prompts/${head.id}.md (bypassing auto-generated prompt)`,
                );
              }
              perBeadPrompt = buildPerBeadPrompt({
                beadId: head.id,
                beadTitle: detail.title || head.title,
                beadDescription: detail.description,
                beadAcceptanceCriteria: detail.acceptanceCriteria,
                beadFiles: detail.files.length > 0 ? detail.files : head.files,
                epicId: epicId as string,
                epicTitle: epicTitle as string,
                shipType: swShipType,
                waveNumber: wave,
                repoPath: beadRepoPath,
                fleetCorePath,
                researchPath: waveResearchPath,
                planPath: wavePlanPath,
                specPath: waveSpecPath,
                architecturePath: waveArchitecturePath,
                testScenariosPath: waveTestScenariosPath,
                testScenarios,
                priorProgress,
                buildPromptOverride: buildPromptOverride ?? undefined,
              });
            } catch (err) {
              // Fallback to a simple prompt; log so we can investigate.
              // beads_web-bot: swShipType used so the fallback prompt reflects
              // bd ground truth, mirroring the buildPerBeadPrompt path above.
              console.error(`[start-wave] Failed to build per-bead prompt for ${head.id}:`, err);
              perBeadPrompt = `Build bead ${head.id} (${head.title}) for epic ${epicId} (${epicTitle}). Ship type: ${swShipType}. Product repo: ${beadRepoPath}. Research report: ${waveResearchPath}. Build plan: ${wavePlanPath}. Fleet-core: ${fleetCorePath}.${waveTestScenariosInfo} ${formatBuilderStandingOrdersDirective(fleetCorePath, swShipType)} ONLY work bead ${head.id}. Do not start any other bead.`;
            }

            const beadSession = await launchAgent({
              repoPath: beadRepoPath,
              repoName: waveRepoName,
              prompt: perBeadPrompt,
              model: "opus",
              maxTurns: 500,
              allowedTools,
              epicId: epicId,
              epicLabels: swLabelsNow,
              pipelineStage: "development",
              agentName: "builder",
              waveNumber: wave,
              beadId: head.id,
            });
            launched.push({
              beadId: head.id,
              group: g,
              groupIndex: 0,
              sessionId: beadSession.tmuxSessionName,
              sessionName: beadSession.tmuxSessionName,
            });
          }
        }

        return NextResponse.json({
          success: true,
          action,
          epicId,
          waveNumber: wave,
          dispatched: "per-bead",
          groups: groups.map((g) => g.map((b) => b.id)),
          launched,
          deferred,
          skipped,
          totalBeads: openBeads.length,
          totalGroups: groups.length,
        });
      }

      // -------------------------------------------------------------------
      // REVIEW WAVE: Launch reviewer scoped to a specific wave's changes
      // -------------------------------------------------------------------
      case "review-wave": {
        // beads_web-ehp.11: precondition gate (DISPATCHING).
        const refusal = await checkPreconditionsOrRefuse({ epicId, fleetCorePath, action: "review-wave", waveNumber: parsedWaveNumber });
        if (refusal) return refusal;

        const rWave = typeof waveNumber === "number" ? waveNumber : parseInt(String(waveNumber), 10);
        if (isNaN(rWave) || rWave < 1) {
          return NextResponse.json({ error: "Invalid waveNumber" }, { status: 400 });
        }

        await addLabelsToEpic(epicId, ["agent:running"], fleetCorePath);
        invalidateCache({ type: "epic", epicId });

        const { repoPath: rRepoPath, repoName: rRepoName, researchPath: rResearchPath, planPath: rPlanPath } = resolveRepoPath(
          shipType,
          epicTitle as string,
          appName,
          epicId as string,
          fleetCorePath
        );

        // Select platform-specific reviewer if available
        const platformReview = ["ios", "macos"];
        const reviewerAgentName = platformReview.includes(shipType.replace("-app", ""))
          ? `platforms/${shipType.replace("-app", "")}/reviewer`
          : "reviewer";

        const reviewWavePrompt = `Review Wave ${rWave} changes for epic ${epicId} (${epicTitle}). Ship type: ${shipType}. Product repo: ${rRepoPath}. Research report: ${rResearchPath}. Build plan: ${rPlanPath}. ONLY review beads with wave:${rWave} label. Check code quality, security patterns, standing order compliance.\n\n${formatAgentStandingOrdersDirective(fleetCorePath, shipType, reviewerAgentName)}`;

        const reviewWaveSession = await launchAgent({
          repoPath: rRepoPath,
          repoName: rRepoName,
          prompt: reviewWavePrompt,
          model: "opus",
          maxTurns: 200,
          allowedTools: "Bash,Read,Glob,Grep,Task",
          epicId: epicId,
          epicLabels: labels,
          pipelineStage: "build-review",
          agentName: reviewerAgentName,
        });

        return NextResponse.json({ success: true, action, epicId, waveNumber: rWave, session: reviewWaveSession });
      }

      // -------------------------------------------------------------------
      // SEND FOR REVIEW: Development -> Build Review (launch reviewer)
      // (factory-core-hnv.10)
      // -------------------------------------------------------------------
      case "send-for-review": {
        // beads_web-ehp.11: precondition gate (DISPATCHING).
        const refusal = await checkPreconditionsOrRefuse({ epicId, fleetCorePath, action: "send-for-review", waveNumber: parsedWaveNumber });
        if (refusal) return refusal;

        // zsjv.4 fix: clear ALL pipeline:* labels first.
        const sfrLabelsNow = await getEpicLabels(epicId as string, fleetCorePath);
        await removeAllPipelineLabels(epicId as string, sfrLabelsNow, fleetCorePath);
        await addLabelsToEpic(epicId, ["pipeline:build-review", "agent:running"], fleetCorePath);
        invalidateCache({ type: "epic", epicId });

        const { repoPath: reviewRepoPath, repoName: reviewRepoName, researchPath: reviewResearchPath, planPath: reviewPlanPath } = resolveRepoPath(
          shipType,
          epicTitle as string,
          appName,
          epicId as string,
          fleetCorePath
        );

        // Select platform-specific reviewer if available
        const reviewPlatforms = ["ios", "macos"];
        const sendReviewAgentName = reviewPlatforms.includes(shipType.replace("-app", ""))
          ? `platforms/${shipType.replace("-app", "")}/reviewer`
          : "reviewer";

        const sendReviewPrompt = `Review all changes for epic ${epicId} (${epicTitle}). Ship type: ${shipType}. Product repo: ${reviewRepoPath}. Research report: ${reviewResearchPath}. Build plan: ${reviewPlanPath}. Check code quality, security patterns, standing order compliance.\n\n${formatAgentStandingOrdersDirective(fleetCorePath, shipType, sendReviewAgentName)}`;

        const sendReviewSession = await launchAgent({
          repoPath: reviewRepoPath,
          repoName: reviewRepoName,
          prompt: sendReviewPrompt,
          model: "opus",
          maxTurns: 200,
          allowedTools: "Bash,Read,Glob,Grep,Task",
          epicId: epicId,
          epicLabels: labels,
          pipelineStage: "build-review",
          agentName: sendReviewAgentName,
        });

        return NextResponse.json({ success: true, action, epicId, session: sendReviewSession });
      }

      // -------------------------------------------------------------------
      // SEND FOR POLISH: QA Round 1 -> UX Polish (launch polish agent)
      // (factory-core-hnv.11)
      // -------------------------------------------------------------------
      case "send-for-polish": {
        // beads_web-ehp.11: precondition gate (DISPATCHING).
        const refusal = await checkPreconditionsOrRefuse({ epicId, fleetCorePath, action: "send-for-polish", waveNumber: parsedWaveNumber });
        if (refusal) return refusal;

        // Check if this is a non-UI ship type that should skip polish
        const noPolishTypes = ["python-tool"];
        const isNonUI = noPolishTypes.includes(shipType) ||
          (shipType === "internal" && !labels.some(l => l.includes("beads_web")));

        if (isNonUI) {
          // Skip polish -- advance directly to next QA round
          // Read fresh labels to determine current round dynamically (factory-core-hnv.22)
          const actualLabels = await getEpicLabels(epicId as string, fleetCorePath);
          const roundLabels = actualLabels.filter(l => l.startsWith("qa:round-"));
          const currentRound = roundLabels.length > 0
            ? Math.max(...roundLabels.map(l => parseInt(l.split("-")[1]))) : 1;

          // factory-core-mejh: Marker-read gate — check current round's marker
          // before advancing to next QA round. This is the second dispatch site
          // (skip-polish-advance for non-UI types). Same gate as send-for-qa.
          // Off-by-one note: this path fires round currentRound+1, so read
          // marker for currentRound (the round that just completed).
          const skipPolishAppName = extractAppName(epicTitle as string) ?? appName;
          const { repoPath: skipPolishRepoPath } = resolveRepoPath(
            shipType,
            epicTitle as string,
            skipPolishAppName,
            epicId as string,
            fleetCorePath
          );

          // Check review:needs-human label
          if (actualLabels.includes("review:needs-human")) {
            console.error(
              JSON.stringify({
                level: "ERROR",
                event: "qa_dispatch_halted",
                epicId,
                round: currentRound + 1,
                reason: "review:needs-human present",
                message: `QA dispatch halted for ${epicId} round ${currentRound + 1} (skip-polish-advance): epic carries review:needs-human label. Operator intervention required.`,
              })
            );
            return NextResponse.json(
              {
                error: "QA dispatch halted",
                epicId,
                round: currentRound + 1,
                reason: "review:needs-human present — operator intervention required",
              },
              { status: 500 }
            );
          }

          // Read the current round's marker file (the round that just completed)
          const skipPolishMarkerPath = path.join(
            skipPolishRepoPath,
            ".beads",
            "markers",
            `${epicId}-qa-round-${currentRound}.json`
          );
          let skipPolishMarkerJson: string;
          try {
            skipPolishMarkerJson = await fs.readFile(skipPolishMarkerPath, "utf-8");
          } catch (err) {
            console.error(
              JSON.stringify({
                level: "ERROR",
                event: "qa_marker_read_failure",
                epicId,
                round: currentRound + 1,
                previousRound: currentRound,
                markerPath: skipPolishMarkerPath,
                error: err instanceof Error ? err.message : String(err),
                message: `QA dispatch halted for ${epicId} round ${currentRound + 1} (skip-polish-advance): cannot read marker for round ${currentRound} at ${skipPolishMarkerPath}. Missing marker file.`,
              })
            );
            return NextResponse.json(
              {
                error: "QA dispatch halted — marker file missing",
                epicId,
                round: currentRound + 1,
                previousRound: currentRound,
                markerPath: skipPolishMarkerPath,
              },
              { status: 500 }
            );
          }

          let skipPolishMarker: { whats_open?: string[]; verdict?: string; open_bugs?: number; [key: string]: unknown };
          try {
            skipPolishMarker = JSON.parse(skipPolishMarkerJson);
          } catch (err) {
            console.error(
              JSON.stringify({
                level: "ERROR",
                event: "qa_marker_parse_failure",
                epicId,
                round: currentRound + 1,
                previousRound: currentRound,
                markerPath: skipPolishMarkerPath,
                error: err instanceof Error ? err.message : String(err),
                message: `QA dispatch halted for ${epicId} round ${currentRound + 1} (skip-polish-advance): malformed JSON in marker for round ${currentRound} at ${skipPolishMarkerPath}.`,
              })
            );
            return NextResponse.json(
              {
                error: "QA dispatch halted — malformed marker JSON",
                epicId,
                round: currentRound + 1,
                previousRound: currentRound,
                markerPath: skipPolishMarkerPath,
              },
              { status: 500 }
            );
          }

          // Check for BLOCKER directives in whats_open
          const skipPolishWhatsOpen = Array.isArray(skipPolishMarker.whats_open)
            ? skipPolishMarker.whats_open
            : [];
          const skipPolishBlockers = skipPolishWhatsOpen.filter(
            (item) => typeof item === "string" && item.startsWith("BLOCKER:")
          );
          if (skipPolishBlockers.length > 0) {
            console.error(
              JSON.stringify({
                level: "ERROR",
                event: "qa_dispatch_halted_blocker",
                epicId,
                round: currentRound + 1,
                previousRound: currentRound,
                blockers: skipPolishBlockers,
                message: `QA dispatch halted for ${epicId} round ${currentRound + 1} (skip-polish-advance): marker for round ${currentRound} contains BLOCKER directive(s): ${skipPolishBlockers.join("; ")}. Operator intervention required.`,
              })
            );
            return NextResponse.json(
              {
                error: "QA dispatch halted — BLOCKER directive in marker",
                epicId,
                round: currentRound + 1,
                previousRound: currentRound,
                blockers: skipPolishBlockers,
              },
              { status: 500 }
            );
          }

          // factory-core-0kkt: Verdict + open-bugs transition predicate.
          // Same logic as send-for-qa site. This path fires round currentRound+1,
          // so the round-just-completed is currentRound.
          // verdict=PASS AND openBugs=0 → TERMINATE. Otherwise → advance.
          const skipPolishVerdict = skipPolishMarker.verdict;
          const skipPolishOpenBugs = typeof skipPolishMarker.open_bugs === "number" ? skipPolishMarker.open_bugs : undefined;

          if (skipPolishVerdict === "PASS" && skipPolishOpenBugs === 0) {
            // QA loop complete — terminate. Clear pipeline:qa and round labels.
            // Do NOT add qa:round-(N+1).
            await removeLabelsFromEpic(epicId, ["pipeline:qa", ...roundLabels], fleetCorePath);
            invalidateCache({ type: "epic", epicId });

            console.log(
              JSON.stringify({
                level: "INFO",
                event: "qa_loop_terminated",
                epicId,
                round: currentRound + 1,
                previousRound: currentRound,
                verdict: skipPolishVerdict,
                openBugs: skipPolishOpenBugs,
                message: `QA loop terminated for ${epicId} (skip-polish-advance): round ${currentRound} verdict=PASS, 0 open bugs. No round ${currentRound + 1} dispatched.`,
              })
            );
            return NextResponse.json({
              success: true,
              action,
              epicId,
              terminated: true,
              reason: "QA loop terminated: PASS verdict, 0 open bugs",
              lastRound: currentRound,
              skipped: true,
            });
          }

          // factory-core-2r2m: QA ceiling check — defence-in-depth (skip-polish-advance site).
          // This path fires round currentRound+1. Check: currentRound + 1 > maxRounds.
          // Same logic as send-for-qa site. maxRounds=20 allows round 20, blocks round 21.
          const skipPolishMaxRounds = await getQaMaxRounds(fleetCorePath);
          if (currentRound + 1 > skipPolishMaxRounds) {
            await addLabelsToEpic(epicId, ["review:needs-human"], fleetCorePath);
            invalidateCache({ type: "epic", epicId });

            console.error(
              JSON.stringify({
                level: "ERROR",
                event: "qa_ceiling_breached",
                epicId,
                attemptedRound: currentRound + 1,
                maxRounds: skipPolishMaxRounds,
                message: `[qa-ceiling] Epic ${epicId} breached ceiling: attempted round ${currentRound + 1} > maxRounds ${skipPolishMaxRounds}. Dispatch halted (skip-polish-advance). review:needs-human set.`,
              })
            );
            return NextResponse.json(
              {
                success: false,
                reason: "QA ceiling breached",
                epicId,
                attemptedRound: currentRound + 1,
                maxRounds: skipPolishMaxRounds,
                skipped: true,
              },
              { status: 200 }
            );
          }

          await removeLabelsFromEpic(epicId, ["pipeline:qa", ...roundLabels], fleetCorePath);
          await addLabelsToEpic(epicId, ["pipeline:qa", `qa:round-${currentRound + 1}`], fleetCorePath);
          invalidateCache({ type: "epic", epicId });
          return NextResponse.json({ success: true, action, epicId, skipped: true, reason: "Non-UI ship type -- no polish needed" });
        }

        // zsjv.4 fix: clear ALL pipeline:* labels first.
        const sfpLabelsNow = await getEpicLabels(epicId as string, fleetCorePath);
        await removeAllPipelineLabels(epicId as string, sfpLabelsNow, fleetCorePath);
        await addLabelsToEpic(epicId, ["pipeline:ux-polish", "agent:running"], fleetCorePath);
        invalidateCache({ type: "epic", epicId });

        const { repoPath: polishRepoPath, repoName: polishRepoName, researchPath: polishResearchPath, planPath: polishPlanPath } = resolveRepoPath(
          shipType,
          epicTitle as string,
          appName,
          epicId as string,
          fleetCorePath
        );

        // Select platform-specific polish agent if available
        const polishPlatforms = ["ios", "macos"];
        const polishAgentName = polishPlatforms.includes(shipType.replace("-app", ""))
          ? `platforms/${shipType.replace("-app", "")}/polish`
          : "polish";

        const polishPrompt = `Polish UI/UX for epic ${epicId} (${epicTitle}). Ship type: ${shipType}. Product repo: ${polishRepoPath}. Research report: ${polishResearchPath}. Build plan: ${polishPlanPath}. Review visual quality, layout, accessibility, empty states, responsive design.\n\n${formatAgentStandingOrdersDirective(fleetCorePath, shipType, polishAgentName)}`;

        const polishSession = await launchAgent({
          repoPath: polishRepoPath,
          repoName: polishRepoName,
          prompt: polishPrompt,
          model: "opus",
          maxTurns: 200,
          allowedTools: "Bash,Read,Glob,Grep,Task",
          epicId: epicId,
          epicLabels: labels,
          pipelineStage: "ux-polish",
          agentName: polishAgentName,
        });

        return NextResponse.json({ success: true, action, epicId, session: polishSession });
      }

      // -------------------------------------------------------------------
      // STOP AGENT: Kill the currently running agent
      // -------------------------------------------------------------------
      case "stop-agent": {
        // EXEMPT per beads_web-ehp.11: only removes agent:running + stops a running agent — no pipeline:* mutation, no agent launch.
        await removeLabelsFromEpic(epicId, ["agent:running"], fleetCorePath);
        invalidateCache({ type: "epic", epicId });
        const result = await stopAgent();
        return NextResponse.json({ success: true, action, epicId, ...result });
      }

      // -------------------------------------------------------------------
      // HUMAN APPROVE: Clear a checkpoint:human-verify (or similar) label
      // from an epic. No agent launched, no pipeline transition — this only
      // removes the attention flag so it disappears from the fleet board.
      // (factory-core-509.2)
      // -------------------------------------------------------------------
      case "human-approve": {
        // EXEMPT per beads_web-ehp.11: only mutates a human-decision-class label (targetLabel) — no pipeline:* mutation, no agent launch.
        if (!targetLabel || typeof targetLabel !== "string") {
          return NextResponse.json(
            { error: "human-approve requires targetLabel" },
            { status: 400 },
          );
        }
        // Strict: bd CLI failures propagate so the UI shows an error toast
        // instead of lying "approve completed" while the label remains.
        // (factory-core-509.9)
        await removeLabelsFromEpicStrict(epicId, [targetLabel], fleetCorePath);
        invalidateCache({ type: "epic", epicId });
        return NextResponse.json({ success: true, action, epicId, targetLabel });
      }

      // -------------------------------------------------------------------
      // HUMAN DISMISS: Clear an attention indicator. Two variants:
      //   a. targetLabel provided → remove that label from the epic
      //      (checkpoint:decision, checkpoint:human-action, qa:needs-review)
      //   b. targetBeadId provided → run `bd human dismiss <beadId>` on the
      //      child bead to clear the `human` flag
      // (factory-core-509.2)
      // -------------------------------------------------------------------
      case "human-dismiss": {
        // EXEMPT per beads_web-ehp.11: only mutates a human-decision-class label OR clears the per-bead human flag — no pipeline:* mutation, no agent launch.
        const hasLabel = typeof targetLabel === "string" && targetLabel.length > 0;
        const hasBeadId = typeof targetBeadId === "string" && targetBeadId.length > 0;
        if (!hasLabel && !hasBeadId) {
          return NextResponse.json(
            { error: "human-dismiss requires either targetLabel or targetBeadId" },
            { status: 400 },
          );
        }
        if (hasLabel) {
          // Strict: bd CLI failures propagate so the UI shows an error toast
          // instead of lying "dismiss completed" while the label remains.
          // (factory-core-509.9)
          await removeLabelsFromEpicStrict(
            epicId,
            [targetLabel as string],
            fleetCorePath,
          );
          invalidateCache({ type: "epic", epicId });
          return NextResponse.json({ success: true, action, epicId, targetLabel });
        }
        // hasBeadId case: resolve the repo that owns the bead (child beads
        // may live in a different repo than fleet-core).
        const { repoPath: beadRepoPath } = resolveRepoPath(
          shipType,
          epicTitle as string,
          appName,
          epicId as string,
          fleetCorePath,
        );
        await dismissHumanItem(targetBeadId as string, beadRepoPath);
        invalidateCache({ type: "epic", epicId });
        return NextResponse.json({ success: true, action, epicId, targetBeadId });
      }

      // -------------------------------------------------------------------
      // REVIEW PLAN: Launch the reviewer agent against a drafted plan.
      // factory-core-k7gy.5 (F5) — called by the orchestrator after planner
      // exit, or directly by curl for manual dry-runs.
      //
      // Labels: plan:pending → plan:reviewing. pipeline:plan-review stays.
      // Fail-closed (regression #13): if the reviewer launch errors, we roll
      // back plan:reviewing and restore plan:pending so the owner-click path
      // is still available.
      // -------------------------------------------------------------------
      case "review-plan": {
        // beads_web-ehp.11: precondition gate (DISPATCHING).
        const refusal = await checkPreconditionsOrRefuse({ epicId, fleetCorePath, action: "review-plan", waveNumber: parsedWaveNumber });
        if (refusal) return refusal;

        const priorLabels = [...labels];
        // zsjv.4 fix: clear ALL pipeline:* labels first. Previously only
        // plan:pending was removed, so an epic at pipeline:product-spec
        // that received a stray review-plan dispatch ended up with both
        // pipeline:product-spec AND pipeline:plan-review (observed on rfu).
        const rpLabelsNow = await getEpicLabels(epicId as string, fleetCorePath);
        await removeAllPipelineLabels(epicId as string, rpLabelsNow, fleetCorePath);
        await removeLabelsFromEpic(epicId, ["plan:pending"], fleetCorePath);
        await addLabelsToEpic(
          epicId,
          ["plan:reviewing", "pipeline:plan-review", "agent:running"],
          fleetCorePath,
        );
        invalidateCache({ type: "epic", epicId });

        const {
          repoPath: reviewRepoPath,
          specPath: reviewSpecPath,
          architecturePath: reviewArchPath,
        } = resolveRepoPath(
          shipType,
          epicTitle as string,
          appName,
          epicId as string,
          fleetCorePath,
        );

        // factory-core-k7gy.15: The reviewer writes its findings file to
        // the PRODUCT repo (reviewer.md Stage 3 Phase 4). For internal
        // epics product repo == fleet-core; for ios-app / web-app / etc.
        // it's under productRepoBase/<appName>/. Compute the path here
        // using resolveRepoPath's authoritative repo root and stash it
        // on the session so the plan-review chain handler can hand it
        // to the planner on NEEDS REVISION — previously the handler
        // derived it from session.repoPath, which is always fleet-core
        // for reviewer launches.
        const reviewFilePath = `${reviewRepoPath}/.beads/plans/${epicId}-review.md`;

        const reviewSpecInfo = reviewSpecPath ? ` Spec: ${reviewSpecPath}.` : "";
        const reviewArchInfo = reviewArchPath ? ` Architecture: ${reviewArchPath}.` : "";
        // beads_web-y9u: apply standing-orders directive (review-plan dispatches reviewer).
        const reviewPrompt = `Review the plan for "${epicTitle}" (epic: ${epicId}, stage: plan, platform: ${shipType}).${reviewSpecInfo}${reviewArchInfo} Product repo: ${reviewRepoPath}. Follow Stage 3 in .claude/agents/reviewer.md.\n\n${formatAgentStandingOrdersDirective(fleetCorePath, shipType, "reviewer")}`;

        try {
          const reviewSession = await launchAgent({
            repoPath: fleetCorePath,
            repoName: "fleet-core",
            prompt: reviewPrompt,
            model: "opus",
            maxTurns: 200,
            allowedTools: "Bash,Read,Write,Edit,Glob,Grep,Task",
            epicId: epicId,
            epicLabels: priorLabels,
            pipelineStage: "plan-review",
            agentName: "reviewer",
            reviewFilePath,
          });
          return NextResponse.json({ success: true, action, epicId, session: reviewSession });
        } catch (launchError: unknown) {
          // Fail-closed rollback — restore plan:pending so the owner-click
          // path is still reachable and the dashboard doesn't strand at
          // plan:reviewing without a running agent.
          await removeLabelsFromEpic(
            epicId,
            ["plan:reviewing", "agent:running"],
            fleetCorePath,
          );
          await addLabelsToEpic(epicId, ["plan:pending"], fleetCorePath);
          invalidateCache({ type: "epic", epicId });
          const msg = launchError instanceof Error ? launchError.message : "Unknown error";
          return NextResponse.json(
            { error: `review-plan launch failed: ${msg}` },
            { status: 500 },
          );
        }
      }

      // -------------------------------------------------------------------
      // REVISE PLAN FROM REVIEW: Re-launch the planner with the reviewer's
      // feedback file. factory-core-k7gy.5 (F7) — called by the orchestrator
      // when the reviewer exits with open review:plan bugs and currentRound
      // is within 1..3 (the cap at round 3 is enforced upstream by the
      // orchestrator).
      //
      // Labels: plan:reviewing → plan:needs-revision + plan:revise-round-N
      // (cumulative per ADR-004). Planner re-launches with --feedback=<path>.
      // Fail-closed (regression #13): launch errors roll back the labels so
      // the owner-click override path is still reachable.
      // -------------------------------------------------------------------
      case "revise-plan-from-review": {
        // beads_web-ehp.11: precondition gate (DISPATCHING).
        const refusal = await checkPreconditionsOrRefuse({ epicId, fleetCorePath, action: "revise-plan-from-review", waveNumber: parsedWaveNumber });
        if (refusal) return refusal;

        if (typeof reviewFilePath !== "string" || reviewFilePath.trim() === "") {
          return NextResponse.json(
            { error: "revise-plan-from-review requires reviewFilePath" },
            { status: 400 },
          );
        }
        const roundRaw = typeof currentRound === "number" ? currentRound : Number(currentRound);
        if (!Number.isInteger(roundRaw) || roundRaw < 1 || roundRaw > 3) {
          return NextResponse.json(
            { error: `revise-plan-from-review currentRound must be 1, 2, or 3 (got ${currentRound})` },
            { status: 400 },
          );
        }
        const roundLabel = `plan:revise-round-${roundRaw}`;

        const priorLabels = [...labels];
        await removeLabelsFromEpic(
          epicId,
          ["plan:reviewing", "plan:reviewed"],
          fleetCorePath,
        );
        await addLabelsToEpic(
          epicId,
          [
            "plan:needs-revision",
            roundLabel,
            "pipeline:plan-review",
            "agent:running",
          ],
          fleetCorePath,
        );
        invalidateCache({ type: "epic", epicId });

        const { repoPath: reviseRepoPath } = resolveRepoPath(
          shipType,
          epicTitle as string,
          appName,
          epicId as string,
          fleetCorePath,
        );

        const feedbackArg = ` --feedback=${reviewFilePath}`;
        // beads_web-y9u: apply standing-orders directive (revise-plan-from-review dispatches planner).
        const revisePrompt = `Revise plan for epic ${epicId} (${epicTitle}). Ship type: ${shipType}. Entry point: revise-plan. Product repo: ${reviseRepoPath}. Fleet-core: ${fleetCorePath}.${feedbackArg}\n\n${formatAgentStandingOrdersDirective(fleetCorePath, shipType, "planner")}`;

        try {
          const reviseSession = await launchAgent({
            repoPath: fleetCorePath,
            repoName: "fleet-core",
            prompt: revisePrompt,
            model: "opus",
            maxTurns: 200,
            allowedTools: "Bash,Read,Write,Edit,Glob,Grep,Task",
            epicId: epicId,
            epicLabels: priorLabels,
            pipelineStage: "planning",
            agentName: "planner",
          });
          return NextResponse.json({ success: true, action, epicId, session: reviseSession });
        } catch (launchError: unknown) {
          // Fail-closed rollback.
          await removeLabelsFromEpic(
            epicId,
            ["plan:needs-revision", roundLabel, "agent:running"],
            fleetCorePath,
          );
          invalidateCache({ type: "epic", epicId });
          const msg = launchError instanceof Error ? launchError.message : "Unknown error";
          return NextResponse.json(
            { error: `revise-plan-from-review launch failed: ${msg}` },
            { status: 500 },
          );
        }
      }

      default:
        return NextResponse.json(
          { error: `Unhandled action: ${action}` },
          { status: 400 },
        );
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to execute ${action} on ${epicId}: ${message}` },
      { status: 500 },
    );
  }
}
