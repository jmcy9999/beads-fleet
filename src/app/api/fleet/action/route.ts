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
  groupBeadsByFileConflict,
  isAgentActive,
} from "@/lib/agent-launcher";
import {
  loadBeadDetail,
  loadBeadTestScenarios,
  buildPerBeadPrompt,
} from "@/lib/bead-prompt";
import { getRepos } from "@/lib/repo-config";
import { invalidateCache } from "@/lib/bv-client";
import { extractAppName } from "@/lib/extract-app-name";
import { resolveRepoPath } from "@/lib/repo-path-resolver";
import { promises as fs } from "fs";
import path from "path";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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
  | "revise-plan-from-review";

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
]);

// Resolve fleet-core path: env var > hardcoded fallback
const FLEET_CORE_PATH = process.env.FLEET_CORE_PATH || "/Users/janemckay/dev/fleet/fleet-core";

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
 * factory-core-rgqd F8 — convert owner feedback on any send-back-style
 * action into a new bug bead under the epic. Previously feedback was
 * baked into the agent prompt as free-text and lost after the session
 * ended. Now it becomes a structured, traceable, closeable artefact.
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

  await removeLabelsFromEpic(
    epicId,
    ["pipeline:research-complete"],
    fleetCorePath,
  );
  await addLabelsToEpic(
    epicId,
    ["pipeline:product-spec", "agent:running"],
    fleetCorePath,
  );
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
  const pmPrompt = descriptionOverride
    ? `Write functional spec for epic ${epicId} (${epicTitle}). Ship type: ${shipType}. No research report — the epic description is provided inline below as your input context (skip:research bypass). Epic description:\n\n${descriptionOverride}\n\nFleet-core: ${fleetCorePath}.`
    : `Write functional spec for epic ${epicId} (${epicTitle}). Ship type: ${shipType}. Research report: ${pmResearchPath}. Fleet-core: ${fleetCorePath}.`;

  const pmSession = await launchAgent({
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

  return pmSession;
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
  const fleetCoreRepo = store.repos.find((r) => r.path === FLEET_CORE_PATH || r.name.includes("fleet-core"));
  const fleetCorePath = fleetCoreRepo?.path ?? FLEET_CORE_PATH;

  const appName = deriveAppName(epicTitle as string, epicId as string);
  const labels = Array.isArray(currentLabels) ? currentLabels as string[] : [];
  const isVenture = labels.includes("ship-type:venture");
  const shipTypeLabel = labels.find(l => l.startsWith("ship-type:"));
  const shipType = shipTypeLabel ? shipTypeLabel.replace("ship-type:", "") : "ios-app";

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
        await addLabelsToEpic(epicId, ["pipeline:research", "agent:running"], fleetCorePath);
        await updateEpicStatus(epicId, "in_progress", fleetCorePath);
        invalidateCache({ type: "epic", epicId });

        const researchPrompt = `Research epic ${epicId} (${epicTitle}). Ship type: ${shipType}. Fleet-core: ${fleetCorePath}.`;

        const session = await launchAgent({
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
          const startWavePrompt = `Build Wave ${wave} beads for epic ${epicId} (${epicTitle}). Ship type: ${shipType}. Product repo: ${repoPath}. Research report: ${researchPath}. Build plan: ${planPath}. Fleet-core: ${fleetCorePath}.${waveTestScenariosInfo} Standing orders and agent instructions are in fleet-core — read them before starting. ONLY work beads with wave:${wave} label. Do not advance to the next wave.`;

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
        const devPrompt = `Build epic ${epicId} (${epicTitle}). Ship type: ${shipType}. Product repo: ${repoPath}. Research report: ${researchPath}. Build plan: ${planPath}. Fleet-core: ${fleetCorePath}.${testScenariosInfo} Standing orders and agent instructions are in fleet-core — read them before starting.`;

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
        await removeLabelsFromEpic(epicId, ["pipeline:research-complete", "plan:pending", "plan:approved"], fleetCorePath);
        await addLabelsToEpic(epicId, ["pipeline:research", "agent:running"], fleetCorePath);
        invalidateCache({ type: "epic", epicId });

        const feedbackStr = typeof feedback === "string" && feedback.trim()
          ? ` Jane's feedback: "${feedback}".`
          : "";

        const { researchPath: prevResearchPath } = resolveRepoPath(shipType, epicTitle as string, appName, epicId as string, fleetCorePath);
        const moreResearchPrompt = `Research epic ${epicId} (${epicTitle}). Ship type: ${shipType}. Fleet-core: ${fleetCorePath}. Previous research at ${prevResearchPath}.${feedbackStr}`;

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
        await removeLabelsFromEpic(epicId, ["pipeline:product-spec"], fleetCorePath);
        await addLabelsToEpic(epicId, ["pipeline:architecture", "agent:running"], fleetCorePath);
        invalidateCache({ type: "epic", epicId });

        const { repoPath: archRepoPath, repoName: archRepoName, researchPath: archResearchPath, specPath: archSpecPath } = resolveRepoPath(
          shipType,
          epicTitle as string,
          appName,
          epicId as string,
          fleetCorePath
        );

        // Architect always runs in fleet-core — specs and research live there, product repo doesn't exist yet
        const archPrompt = `Design architecture for epic ${epicId} (${epicTitle}). Ship type: ${shipType}. Functional spec: ${archSpecPath}. Research report: ${archResearchPath}. Fleet-core: ${fleetCorePath}.`;

        const archSession = await launchAgent({
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

        return NextResponse.json({ success: true, action, epicId, session: archSession });
      }

      // -------------------------------------------------------------------
      // REVISE SPEC: Re-run PM agent with feedback (stays in Product Spec)
      // (factory-core-lxc.5)
      // -------------------------------------------------------------------
      case "revise-spec": {
        await addLabelsToEpic(epicId, ["agent:running"], fleetCorePath);
        invalidateCache({ type: "epic", epicId });

        const { repoPath: rsRepoPath, repoName: rsRepoName, researchPath: rsResearchPath } = resolveRepoPath(
          shipType,
          epicTitle as string,
          appName,
          epicId as string,
          fleetCorePath
        );

        const rsFeedbackStr = typeof feedback === "string" && feedback.trim()
          ? ` Jane's feedback: "${feedback}".`
          : "";

        const rsPrompt = `Revise functional spec for epic ${epicId} (${epicTitle}). Ship type: ${shipType}. Research report: ${rsResearchPath}. Fleet-core: ${fleetCorePath}.${rsFeedbackStr}`;

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
        await addLabelsToEpic(epicId, ["agent:running"], fleetCorePath);
        invalidateCache({ type: "epic", epicId });

        const { repoPath: raRepoPath, repoName: raRepoName, researchPath: raResearchPath, specPath: raSpecPath } = resolveRepoPath(
          shipType,
          epicTitle as string,
          appName,
          epicId as string,
          fleetCorePath
        );

        const raFeedbackStr = typeof feedback === "string" && feedback.trim()
          ? ` Jane's feedback: "${feedback}".`
          : "";

        const raPrompt = `Revise architecture for epic ${epicId} (${epicTitle}). Ship type: ${shipType}. Functional spec: ${raSpecPath}. Research report: ${raResearchPath}. Fleet-core: ${fleetCorePath}.${raFeedbackStr}`;

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
        await removeLabelsFromEpic(epicId, ["pipeline:plan-review"], fleetCorePath);
        await addLabelsToEpic(epicId, ["pipeline:test-spec", "agent:running"], fleetCorePath);
        invalidateCache({ type: "epic", epicId });

        const { repoPath: tsRepoPath, researchPath: tsResearchPath, specPath: tsSpecPath, architecturePath: tsArchPath } = resolveRepoPath(
          shipType,
          epicTitle as string,
          appName,
          epicId as string,
          fleetCorePath
        );

        const tsPrompt = `Write test scenarios for epic ${epicId} (${epicTitle}). Ship type: ${shipType}. Functional spec: ${tsSpecPath}. Architecture: ${tsArchPath}. Research: ${tsResearchPath}. Product repo: ${tsRepoPath}. Fleet-core: ${fleetCorePath}.`;

        const tsSession = await launchAgent({
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

        return NextResponse.json({ success: true, action, epicId, session: tsSession });
      }

      // -------------------------------------------------------------------
      // REVISE TEST-SPEC: Re-run test-spec agent with feedback (stays in Test Spec)
      // (factory-core-a7qf.10)
      // -------------------------------------------------------------------
      case "revise-test-spec": {
        await addLabelsToEpic(epicId, ["agent:running"], fleetCorePath);
        invalidateCache({ type: "epic", epicId });

        const { repoPath: rtsRepoPath, researchPath: rtsResearchPath, specPath: rtsSpecPath, architecturePath: rtsArchPath } = resolveRepoPath(
          shipType,
          epicTitle as string,
          appName,
          epicId as string,
          fleetCorePath
        );

        const rtsFeedbackStr = typeof feedback === "string" && feedback.trim()
          ? ` Jane's feedback: "${feedback}".`
          : "";

        const rtsPrompt = `Revise test scenarios for epic ${epicId} (${epicTitle}). Ship type: ${shipType}. Functional spec: ${rtsSpecPath}. Architecture: ${rtsArchPath}. Research: ${rtsResearchPath}. Product repo: ${rtsRepoPath}. Fleet-core: ${fleetCorePath}.${rtsFeedbackStr}`;

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

        const sendBackPrompt = `Continue building epic ${epicId} (${epicTitle}). Ship type: ${shipType}. Product repo: ${repoPath}. Research report: ${researchPath}.${feedbackStr2}${feedbackBeadStr}`;

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
        // Transition to plan-review from research-complete (ventures) or architecture (non-ventures)
        // (factory-core-lxc.5: architecture is the new pre-plan stage for non-ventures)
        await removeLabelsFromEpic(epicId, ["pipeline:research-complete", "pipeline:architecture"], fleetCorePath);
        await addLabelsToEpic(epicId, ["pipeline:plan-review", "agent:running"], fleetCorePath);
        invalidateCache({ type: "epic", epicId });

        const { repoPath, repoName, researchPath, specPath, architecturePath } = resolveRepoPath(
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
        const planPrompt = `Plan epic ${epicId} (${epicTitle}). Ship type: ${shipType}. Entry point: from-research. Product repo: ${repoPath}. Research report: ${researchPath}.${specInfo}${archInfo} Fleet-core: ${fleetCorePath}.`;

        const session = await launchAgent({
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

        return NextResponse.json({ success: true, action, epicId, session });
      }

      // -------------------------------------------------------------------
      // APPROVE PLAN: plan:pending -> plan:approved (label change only)
      // -------------------------------------------------------------------
      case "approve-plan": {
        await removeLabelsFromEpic(epicId, ["plan:pending"], fleetCorePath);
        await addLabelsToEpic(epicId, ["plan:approved"], fleetCorePath);
        invalidateCache({ type: "epic", epicId });

        return NextResponse.json({ success: true, action, epicId });
      }

      // -------------------------------------------------------------------
      // APPROVE & BUILD: Approve plan + immediately start development
      // -------------------------------------------------------------------
      case "approve-and-build": {
        // Approve the plan and route to test-spec (not development)
        // Test-spec writes test scenarios before the builder starts
        //
        // factory-core-k7gy.5 — `fromChain: true` means the orchestrator is
        // dispatching after a PASS verdict from the reviewer agent. In that
        // path the reviewer has already replaced plan:pending with
        // plan:reviewing, so we clean up plan:reviewing/plan:reviewed instead
        // of plan:pending. ADR-008 — byte-identical owner-click path preserved
        // when `fromChain` is absent or explicitly false.
        if (fromChain === true) {
          await removeLabelsFromEpic(
            epicId,
            [
              "pipeline:research-complete",
              "plan:reviewing",
              "plan:reviewed",
              "plan:needs-revision",
            ],
            fleetCorePath,
          );
        } else {
          await removeLabelsFromEpic(
            epicId,
            ["pipeline:research-complete", "plan:pending"],
            fleetCorePath,
          );
        }
        await addLabelsToEpic(epicId, ["plan:approved", "pipeline:test-spec", "agent:running"], fleetCorePath);
        invalidateCache({ type: "epic", epicId });

        const { repoPath: aabRepoPath, repoName: aabRepoName, researchPath: aabResearchPath, specPath: aabSpecPath, architecturePath: aabArchPath } = resolveRepoPath(
          shipType,
          epicTitle as string,
          appName,
          epicId as string,
          fleetCorePath
        );

        const aabSpecInfo = aabSpecPath ? ` Functional spec: ${aabSpecPath}.` : "";
        const aabArchInfo = aabArchPath ? ` Architecture: ${aabArchPath}.` : "";
        const aabPrompt = `Write test scenarios for epic ${epicId} (${epicTitle}). Ship type: ${shipType}.${aabSpecInfo}${aabArchInfo} Research report: ${aabResearchPath}. Product repo: ${aabRepoPath}. Fleet-core: ${fleetCorePath}.`;

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
        await removeLabelsFromEpic(epicId, ["plan:approved", "plan:pending"], fleetCorePath);
        await addLabelsToEpic(epicId, ["agent:running"], fleetCorePath);
        invalidateCache({ type: "epic", epicId });

        const { repoPath, repoName } = resolveRepoPath(
          shipType,
          epicTitle as string,
          appName,
          epicId as string,
          fleetCorePath
        );

        const feedbackStr3 = typeof feedback === "string" && feedback.trim()
          ? ` Jane's feedback: "${feedback}".`
          : "";

        const revisePlanPrompt = `Revise plan for epic ${epicId} (${epicTitle}). Ship type: ${shipType}. Entry point: revise-plan. Product repo: ${repoPath}. Fleet-core: ${fleetCorePath}.${feedbackStr3}`;

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

        const skipPlanPrompt = `Plan epic ${epicId} (${epicTitle}). Ship type: ${shipType}. Entry point: from-candidates. Product repo: ${repoPath}. No recon brief.`;

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
        await removeLabelsFromEpic(epicId, ["pipeline:submission-prep"], fleetCorePath);
        await addLabelsToEpic(epicId, ["pipeline:research-complete", "agent:running"], fleetCorePath);
        invalidateCache({ type: "epic", epicId });

        const { repoPath, repoName } = resolveRepoPath(
          shipType,
          epicTitle as string,
          appName,
          epicId as string,
          fleetCorePath
        );

        const feedbackStr4 = typeof feedback === "string" && feedback.trim()
          ? ` Jane's feedback: "${feedback}".`
          : "";

        const session = await launchAgent({
          repoPath: fleetCorePath,
          repoName: "fleet-core",
          prompt: `Revise plan for epic ${epicId} (${epicTitle}). Ship type: ${shipType}. Entry point: revise-plan. Product repo: ${repoPath}. Fleet-core: ${fleetCorePath}.${feedbackStr4}`,
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
          await removeLabelsFromEpic(epicId, ["pipeline:ux-polish", "agent:running"], fleetCorePath);
          await addLabelsToEpic(epicId, ["pipeline:submission-prep", "qa:needs-review"], fleetCorePath);
          invalidateCache({ type: "epic", epicId });
          return NextResponse.json({ success: true, action, epicId, dispatched: "skipped-no-polish-agent", shipType });
        }

        const polishPrompt = `Run UX polish for epic ${epicId} (${epicTitle}). Ship type: ${shipType}. Product repo: ${repoPath}. Build plan: ${planPath}. Follow .claude/agents/platforms/${polishShipKey}/polish.md. Launch the simulator, take screenshots of every screen in light and dark mode via tools/platforms/ios/snapship.sh where available, and file bug beads for any visual / runtime issues.`;

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
          // No smoke-test for this ship type — immediately advance labels
          // back so the caller's auto-chain can dispatch build-review.
          await removeLabelsFromEpic(epicId, ["pipeline:smoke-test", "agent:running"], fleetCorePath);
          await addLabelsToEpic(epicId, ["pipeline:build-review"], fleetCorePath);
          invalidateCache({ type: "epic", epicId });
          return NextResponse.json({ success: true, action, epicId, dispatched: "skipped-no-smoke-agent", shipType });
        }

        const stPrompt = `Run the iOS smoke test for epic ${epicId} (${epicTitle}). Product repo: ${repoPath}. Scheme: ${smokeAppName}. Build plan: ${planPath}. Follow .claude/agents/platforms/ios/smoke-test.md. Invoke tools/platforms/ios/smoke-test.sh. On FAIL file a bug under the epic; on PASS exit cleanly.`;

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

      case "send-for-qa": {
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
          prompt: `Run QA for epic ${epicId} (${epicTitle}). Ship type: ${shipType}. QA round: ${currentRound}. Product repo: ${repoPath}. Research report: ${researchPath}. Build plan: ${planPath}. Shipyard: ${fleetCorePath}.${totalWavesStr}`,
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
          prompt: `Fix QA bugs for epic ${epicId} (${epicTitle}). Ship type: ${shipType}. Product repo: ${repoPath}. Research report: ${researchPath}. Build plan: ${planPath}.`,
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
        await removeLabelsFromEpic(epicId, ["pipeline:development"], fleetCorePath);
        await addLabelsToEpic(epicId, ["pipeline:deploying"], fleetCorePath);
        invalidateCache({ type: "epic", epicId });
        return NextResponse.json({ success: true, action, epicId });
      }

      // -------------------------------------------------------------------
      // MARK VENTURE LIVE: Deploying -> Live (venture only, label swap)
      // -------------------------------------------------------------------
      case "mark-venture-live": {
        await removeLabelsFromEpic(epicId, ["pipeline:deploying"], fleetCorePath);
        await addLabelsToEpic(epicId, ["pipeline:live"], fleetCorePath);
        invalidateCache({ type: "epic", epicId });
        return NextResponse.json({ success: true, action, epicId });
      }

      // -------------------------------------------------------------------
      // MARK VENTURE COMPLETE: Live -> Completed (venture only, close epic)
      // -------------------------------------------------------------------
      case "mark-venture-complete": {
        await removeLabelsFromEpic(epicId, ["pipeline:live"], fleetCorePath);
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
        await addLabelsToEpic(epicId, ["agent:running"], fleetCorePath);
        invalidateCache({ type: "epic", epicId });

        const { repoPath: rbRepoPath, repoName: rbRepoName, researchPath: rbResearchPath, planPath: rbPlanPath } = resolveRepoPath(
          shipType,
          epicTitle as string,
          appName,
          epicId as string,
          fleetCorePath
        );

        const feedbackStrResume = typeof feedback === "string" && feedback.trim()
          ? ` Jane's feedback: "${feedback}".`
          : "";

        const resumePrompt = `Continue building epic ${epicId} (${epicTitle}). Ship type: ${shipType}. Product repo: ${rbRepoPath}. Research report: ${rbResearchPath}. Build plan: ${rbPlanPath}. Fix all open bugs and complete remaining tasks.${feedbackStrResume}`;

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
        const wave = typeof waveNumber === "number" ? waveNumber : parseInt(String(waveNumber), 10);
        if (isNaN(wave) || wave < 1) {
          return NextResponse.json({ error: "Invalid waveNumber" }, { status: 400 });
        }

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
          shipType,
          epicTitle as string,
          appName,
          epicId as string,
          fleetCorePath
        );

        const waveTestScenariosInfo = waveTestScenariosPath ? ` Test scenarios: ${waveTestScenariosPath}.` : "";
        const allowedTools = isVenture
          ? "Bash,Read,Write,Edit,Glob,Grep,Task,WebSearch"
          : "Bash,Read,Write,Edit,Glob,Grep,Task";

        // factory-core-z9h.9: listOpenWaveBeads now throws on bd failure
        // rather than silently returning an empty list. A bd outage must
        // surface as a 500 so the auto-chain registers the failure — we
        // must not fall through to the legacy wave-session branch with an
        // incomplete bead set (that masks unclosed work).
        let openBeads;
        try {
          openBeads = await listOpenWaveBeads(epicId as string, wave, waveRepoPath);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[start-wave] listOpenWaveBeads failed for ${epicId} wave ${wave}: ${message}`);
          return NextResponse.json(
            {
              error: `Failed to enumerate open wave beads: ${message}`,
              epicId,
              waveNumber: wave,
            },
            { status: 500 },
          );
        }

        // Legacy fallback: no enumerable open beads → launch one wave-scoped
        // session as before. Keeps pre-z9h.7 epics working.
        if (openBeads.length === 0) {
          const startWavePrompt = `Build Wave ${wave} beads for epic ${epicId} (${epicTitle}). Ship type: ${shipType}. Product repo: ${waveRepoPath}. Research report: ${waveResearchPath}. Build plan: ${wavePlanPath}. Fleet-core: ${fleetCorePath}.${waveTestScenariosInfo} Standing orders and agent instructions are in fleet-core — read them before starting. ONLY work beads with wave:${wave} label. Do not advance to the next wave.`;

          const startWaveSession = await launchAgent({
            repoPath: waveRepoPath,
            repoName: waveRepoName,
            prompt: startWavePrompt,
            model: "opus",
            maxTurns: 500,
            allowedTools,
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

            // factory-core-z9h.6: when start-wave is re-invoked by the
            // auto-chain (e.g. after a per-bead agent closes its bead),
            // skip heads that already have a live agent. This keeps the
            // re-invocation idempotent for already-launched heads while
            // still picking up any newly-unblocked tail beads.
            if (isAgentActive(waveRepoPath, head.id)) {
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
            let perBeadPrompt: string;
            try {
              const detail = loadBeadDetail(head.id, waveRepoPath);
              const testScenarios = await loadBeadTestScenarios(
                waveTestScenariosPath,
                head.id,
              );
              perBeadPrompt = buildPerBeadPrompt({
                beadId: head.id,
                beadTitle: detail.title || head.title,
                beadDescription: detail.description,
                beadAcceptanceCriteria: detail.acceptanceCriteria,
                beadFiles: detail.files.length > 0 ? detail.files : head.files,
                epicId: epicId as string,
                epicTitle: epicTitle as string,
                shipType,
                waveNumber: wave,
                repoPath: waveRepoPath,
                fleetCorePath,
                researchPath: waveResearchPath,
                planPath: wavePlanPath,
                specPath: waveSpecPath,
                architecturePath: waveArchitecturePath,
                testScenariosPath: waveTestScenariosPath,
                testScenarios,
              });
            } catch (err) {
              // Fallback to a simple prompt; log so we can investigate.
              console.error(`[start-wave] Failed to build per-bead prompt for ${head.id}:`, err);
              perBeadPrompt = `Build bead ${head.id} (${head.title}) for epic ${epicId} (${epicTitle}). Ship type: ${shipType}. Product repo: ${waveRepoPath}. Research report: ${waveResearchPath}. Build plan: ${wavePlanPath}. Fleet-core: ${fleetCorePath}.${waveTestScenariosInfo} Standing orders and agent instructions are in fleet-core — read them before starting. ONLY work bead ${head.id}. Do not start any other bead.`;
            }

            const beadSession = await launchAgent({
              repoPath: waveRepoPath,
              repoName: waveRepoName,
              prompt: perBeadPrompt,
              model: "opus",
              maxTurns: 500,
              allowedTools,
              epicId: epicId,
              epicLabels: labels,
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

        const reviewWavePrompt = `Review Wave ${rWave} changes for epic ${epicId} (${epicTitle}). Ship type: ${shipType}. Product repo: ${rRepoPath}. Research report: ${rResearchPath}. Build plan: ${rPlanPath}. Shipyard: ${fleetCorePath}. ONLY review beads with wave:${rWave} label. Check code quality, security patterns, standing order compliance.`;

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
        await removeLabelsFromEpic(epicId, ["pipeline:development"], fleetCorePath);
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

        const sendReviewPrompt = `Review all changes for epic ${epicId} (${epicTitle}). Ship type: ${shipType}. Product repo: ${reviewRepoPath}. Research report: ${reviewResearchPath}. Build plan: ${reviewPlanPath}. Shipyard: ${fleetCorePath}. Check code quality, security patterns, standing order compliance.`;

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
          await removeLabelsFromEpic(epicId, ["pipeline:qa", ...roundLabels], fleetCorePath);
          await addLabelsToEpic(epicId, ["pipeline:qa", `qa:round-${currentRound + 1}`], fleetCorePath);
          invalidateCache({ type: "epic", epicId });
          return NextResponse.json({ success: true, action, epicId, skipped: true, reason: "Non-UI ship type -- no polish needed" });
        }

        await removeLabelsFromEpic(epicId, ["pipeline:qa"], fleetCorePath);
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

        const polishPrompt = `Polish UI/UX for epic ${epicId} (${epicTitle}). Ship type: ${shipType}. Product repo: ${polishRepoPath}. Research report: ${polishResearchPath}. Build plan: ${polishPlanPath}. Shipyard: ${fleetCorePath}. Review visual quality, layout, accessibility, empty states, responsive design.`;

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
        const priorLabels = [...labels];
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
        const reviewPrompt = `Review the plan for "${epicTitle}" (epic: ${epicId}, stage: plan, platform: ${shipType}).${reviewSpecInfo}${reviewArchInfo} Product repo: ${reviewRepoPath}. Follow Stage 3 in .claude/agents/reviewer.md.`;

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
        const revisePrompt = `Revise plan for epic ${epicId} (${epicTitle}). Ship type: ${shipType}. Entry point: revise-plan. Product repo: ${reviseRepoPath}. Fleet-core: ${fleetCorePath}.${feedbackArg}`;

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
