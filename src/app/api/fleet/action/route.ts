import { NextRequest, NextResponse } from "next/server";
import {
  addLabelsToEpic,
  removeLabelsFromEpic,
  removeAllPipelineLabels,
  closeEpic,
  updateEpicStatus,
} from "@/lib/pipeline-labels";
import { launchAgent, stopAgent } from "@/lib/agent-launcher";
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
  | "mark-venture-complete";

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
]);

const FLEET_CORE_PATH = "/Users/janemckay/dev/fleet/fleet-core";

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

  const { epicId, epicTitle, action, feedback, currentLabels } = body;

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
      // -------------------------------------------------------------------
      case "start-research": {
        await addLabelsToEpic(epicId, ["pipeline:research", "agent:running"], fleetCorePath);
        await updateEpicStatus(epicId, "in_progress", fleetCorePath);
        invalidateCache();

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
      // -------------------------------------------------------------------
      case "send-for-development": {
        await removeLabelsFromEpic(epicId, ["pipeline:research-complete", "plan:pending", "plan:approved"], fleetCorePath);
        await addLabelsToEpic(epicId, ["pipeline:development", "agent:running"], fleetCorePath);
        invalidateCache();

        const { repoPath, repoName, researchPath, planPath } = resolveRepoPath(
          shipType,
          epicTitle as string,
          appName,
          epicId as string,
          fleetCorePath
        );

        const devPrompt = `Build epic ${epicId} (${epicTitle}). Ship type: ${shipType}. Product repo: ${repoPath}. Research report: ${researchPath}. Build plan: ${planPath}.`;

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

        return NextResponse.json({ success: true, action, epicId, session });
      }

      // -------------------------------------------------------------------
      // MORE RESEARCH: Research Complete -> In Research (loop)
      // -------------------------------------------------------------------
      case "more-research": {
        await removeLabelsFromEpic(epicId, ["pipeline:research-complete", "plan:pending", "plan:approved"], fleetCorePath);
        await addLabelsToEpic(epicId, ["pipeline:research", "agent:running"], fleetCorePath);
        invalidateCache();

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
        invalidateCache();

        return NextResponse.json({ success: true, action, epicId });
      }

      // -------------------------------------------------------------------
      // APPROVE SUBMISSION: Prepare for Submission -> Submitted
      // -------------------------------------------------------------------
      case "approve-submission": {
        await addLabelsToEpic(epicId, ["agent:running"], fleetCorePath);
        invalidateCache();

        const session = await launchAgent({
          repoPath: fleetCorePath,
          repoName: "fleet-core",
          prompt: `Prepare submission for "${epicTitle}" (epic: ${epicId}). Follow the submission workflow instructions in CLAUDE.md.`,
          model: "sonnet",
          maxTurns: 100,
          allowedTools: "Bash,Read,Write,Edit,Glob,Grep",
          epicId: epicId,
          epicLabels: labels,
          pipelineStage: "submission-prep",
          agentName: "builder",
        });

        return NextResponse.json({ success: true, action, epicId, session });
      }

      // -------------------------------------------------------------------
      // SEND BACK TO DEVELOPMENT: Prepare for Submission -> In Development
      // -------------------------------------------------------------------
      case "send-back-to-dev": {
        // Remove whichever "from" stage label is present (submission-prep, deploying, or qa)
        await removeLabelsFromEpic(epicId, ["pipeline:submission-prep", "pipeline:deploying", "pipeline:qa"], fleetCorePath);
        await addLabelsToEpic(epicId, ["pipeline:development", "agent:running"], fleetCorePath);
        invalidateCache();

        const { repoPath, repoName, researchPath } = resolveRepoPath(
          shipType,
          epicTitle as string,
          appName,
          epicId as string,
          fleetCorePath
        );

        const feedbackStr2 = typeof feedback === "string" && feedback.trim()
          ? ` Jane's feedback: "${feedback}".`
          : "";

        const sendBackPrompt = `Continue building epic ${epicId} (${epicTitle}). Ship type: ${shipType}. Product repo: ${repoPath}. Research report: ${researchPath}.${feedbackStr2}`;

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
        invalidateCache();

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
        // Keep research-complete label, add agent:running (plan:pending added on agent exit)
        await addLabelsToEpic(epicId, ["pipeline:research-complete", "agent:running"], fleetCorePath);
        invalidateCache();

        const { repoPath, repoName, researchPath } = resolveRepoPath(
          shipType,
          epicTitle as string,
          appName,
          epicId as string,
          fleetCorePath
        );

        const planPrompt = `Plan epic ${epicId} (${epicTitle}). Ship type: ${shipType}. Entry point: from-research. Product repo: ${repoPath}. Research report: ${researchPath}.`;

        const session = await launchAgent({
          repoPath: repoPath,
          repoName: repoName,
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
        invalidateCache();

        return NextResponse.json({ success: true, action, epicId });
      }

      // -------------------------------------------------------------------
      // APPROVE & BUILD: Approve plan + immediately start development
      // -------------------------------------------------------------------
      case "approve-and-build": {
        await removeLabelsFromEpic(epicId, ["pipeline:research-complete", "plan:pending"], fleetCorePath);
        await addLabelsToEpic(epicId, ["plan:approved", "pipeline:development", "agent:running"], fleetCorePath);
        invalidateCache();

        const { repoPath, repoName, researchPath, planPath } = resolveRepoPath(
          shipType,
          epicTitle as string,
          appName,
          epicId as string,
          fleetCorePath
        );

        // Read feature approval state if it exists, to scope the build
        let featureScopeNote = "";
        try {
          const approvalPath = path.join(repoPath, ".beads", "plans", `${epicId}.approval.json`);
          const raw = await fs.readFile(approvalPath, "utf-8");
          const approval = JSON.parse(raw);
          const approved = (approval.features ?? []).filter((f: { status: string }) => f.status === "approved");
          const rejected = (approval.features ?? []).filter((f: { status: string }) => f.status === "rejected");
          const deferred = (approval.features ?? []).filter((f: { status: string }) => f.status === "deferred");
          if (approved.length > 0 || rejected.length > 0) {
            const parts: string[] = [];
            if (approved.length > 0) {
              parts.push(`APPROVED features (build these): ${approved.map((f: { name: string }) => f.name).join(", ")}`);
            }
            if (rejected.length > 0) {
              parts.push(`REJECTED features (do NOT build): ${rejected.map((f: { name: string }) => f.name).join(", ")}`);
            }
            if (deferred.length > 0) {
              parts.push(`DEFERRED features (skip for now): ${deferred.map((f: { name: string }) => f.name).join(", ")}`);
            }
            featureScopeNote = ` Feature scope: ${parts.join(". ")}.`;
          }
        } catch {
          // No approval file — build everything in the plan
        }

        const approveDevPrompt = `Build epic ${epicId} (${epicTitle}). Ship type: ${shipType}. Product repo: ${repoPath}. Research report: ${researchPath}. Build plan: ${planPath}.${featureScopeNote}`;

        const session = await launchAgent({
          repoPath: repoPath,
          repoName: repoName,
          prompt: approveDevPrompt,
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
      // REVISE PLAN: Re-launch planning agent with feedback
      // -------------------------------------------------------------------
      case "revise-plan": {
        await removeLabelsFromEpic(epicId, ["plan:approved", "plan:pending"], fleetCorePath);
        await addLabelsToEpic(epicId, ["agent:running"], fleetCorePath);
        invalidateCache();

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

        const revisePlanPrompt = `Revise plan for epic ${epicId} (${epicTitle}). Ship type: ${shipType}. Entry point: revise-plan. Product repo: ${repoPath}.${feedbackStr3}`;

        const session = await launchAgent({
          repoPath: repoPath,
          repoName: repoName,
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
        invalidateCache();

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
        invalidateCache();

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
          repoPath: repoPath,
          repoName: repoName,
          prompt: `Revise plan for epic ${epicId} (${epicTitle}). Ship type: ${shipType}. Entry point: revise-plan. Product repo: ${repoPath}.${feedbackStr4}`,
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
      case "send-for-qa": {
        // Determine QA round from labels
        const roundLabels = labels.filter(l => l.startsWith("qa:round-"));
        const currentRound = roundLabels.length > 0
          ? Math.max(...roundLabels.map(l => parseInt(l.split("-")[1]))) + 1
          : 1;

        // Remove old labels, add QA labels
        await removeLabelsFromEpic(epicId, ["pipeline:development", ...roundLabels], fleetCorePath);
        await addLabelsToEpic(epicId, ["pipeline:qa", `qa:round-${currentRound}`, "agent:running"], fleetCorePath);
        invalidateCache();

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

        const session = await launchAgent({
          repoPath: repoPath,
          repoName: repoName,
          prompt: `Run QA for epic ${epicId} (${epicTitle}). Ship type: ${shipType}. QA round: ${currentRound}. Product repo: ${repoPath}. Research report: ${researchPath}. Build plan: ${planPath}. Shipyard: ${fleetCorePath}.`,
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
        invalidateCache();

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
        invalidateCache();
        return NextResponse.json({ success: true, action, epicId });
      }

      // -------------------------------------------------------------------
      // MARK VENTURE LIVE: Deploying -> Live (venture only, label swap)
      // -------------------------------------------------------------------
      case "mark-venture-live": {
        await removeLabelsFromEpic(epicId, ["pipeline:deploying"], fleetCorePath);
        await addLabelsToEpic(epicId, ["pipeline:live"], fleetCorePath);
        invalidateCache();
        return NextResponse.json({ success: true, action, epicId });
      }

      // -------------------------------------------------------------------
      // MARK VENTURE COMPLETE: Live -> Completed (venture only, close epic)
      // -------------------------------------------------------------------
      case "mark-venture-complete": {
        await removeLabelsFromEpic(epicId, ["pipeline:live"], fleetCorePath);
        await addLabelsToEpic(epicId, ["pipeline:completed"], fleetCorePath);
        await closeEpic(epicId, "Venture complete", fleetCorePath);
        invalidateCache();
        return NextResponse.json({ success: true, action, epicId });
      }

      // -------------------------------------------------------------------
      // STOP AGENT: Kill the currently running agent
      // -------------------------------------------------------------------
      case "stop-agent": {
        await removeLabelsFromEpic(epicId, ["agent:running"], fleetCorePath);
        invalidateCache();
        const result = await stopAgent();
        return NextResponse.json({ success: true, action, epicId, ...result });
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
