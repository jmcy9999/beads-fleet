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
import { launchAgent, stopAgent, getWaveStatus } from "@/lib/agent-launcher";
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
  | "revise-spec"
  | "revise-architecture"
  | "run-test-spec"
  | "revise-test-spec"
  | "human-approve"
  | "human-dismiss";

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
  "revise-spec",
  "revise-architecture",
  "run-test-spec",
  "revise-test-spec",
  "human-approve",
  "human-dismiss",
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
        await removeLabelsFromEpic(epicId, ["pipeline:research-complete", "pipeline:test-spec", "plan:pending", "plan:approved"], fleetCorePath);
        await addLabelsToEpic(epicId, ["pipeline:development", "agent:running"], fleetCorePath);
        invalidateCache();

        const { repoPath, repoName, researchPath, planPath, testScenariosPath } = resolveRepoPath(
          shipType,
          epicTitle as string,
          appName,
          epicId as string,
          fleetCorePath
        );

        const testScenariosInfo = testScenariosPath ? ` Test scenarios: ${testScenariosPath}.` : "";
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
      // RUN PM: Research Complete -> Product Spec (launch PM agent)
      // (factory-core-lxc.5)
      // -------------------------------------------------------------------
      case "run-pm": {
        await removeLabelsFromEpic(epicId, ["pipeline:research-complete"], fleetCorePath);
        await addLabelsToEpic(epicId, ["pipeline:product-spec", "agent:running"], fleetCorePath);
        invalidateCache();

        const { repoPath: pmRepoPath, repoName: pmRepoName, researchPath: pmResearchPath } = resolveRepoPath(
          shipType,
          epicTitle as string,
          appName,
          epicId as string,
          fleetCorePath
        );

        // PM always runs in fleet-core — research and specs live there, product repo doesn't exist yet
        const pmPrompt = `Write functional spec for epic ${epicId} (${epicTitle}). Ship type: ${shipType}. Research report: ${pmResearchPath}. Fleet-core: ${fleetCorePath}.`;

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

        return NextResponse.json({ success: true, action, epicId, session: pmSession });
      }

      // -------------------------------------------------------------------
      // RUN ARCHITECT: Product Spec -> Architecture (launch Architect agent)
      // (factory-core-lxc.5)
      // -------------------------------------------------------------------
      case "run-architect": {
        await removeLabelsFromEpic(epicId, ["pipeline:product-spec"], fleetCorePath);
        await addLabelsToEpic(epicId, ["pipeline:architecture", "agent:running"], fleetCorePath);
        invalidateCache();

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
        invalidateCache();

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
        invalidateCache();

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
        invalidateCache();

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
        invalidateCache();

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
        await removeAllPipelineLabels(epicId as string, sendBackLabels, fleetCorePath);
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
        // Transition to plan-review from research-complete (ventures) or architecture (non-ventures)
        // (factory-core-lxc.5: architecture is the new pre-plan stage for non-ventures)
        await removeLabelsFromEpic(epicId, ["pipeline:research-complete", "pipeline:architecture"], fleetCorePath);
        await addLabelsToEpic(epicId, ["pipeline:plan-review", "agent:running"], fleetCorePath);
        invalidateCache();

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
        invalidateCache();

        return NextResponse.json({ success: true, action, epicId });
      }

      // -------------------------------------------------------------------
      // APPROVE & BUILD: Approve plan + immediately start development
      // -------------------------------------------------------------------
      case "approve-and-build": {
        // Approve the plan and route to test-spec (not development)
        // Test-spec writes test scenarios before the builder starts
        await removeLabelsFromEpic(epicId, ["pipeline:research-complete", "plan:pending"], fleetCorePath);
        await addLabelsToEpic(epicId, ["plan:approved", "pipeline:test-spec", "agent:running"], fleetCorePath);
        invalidateCache();

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
      // RESUME BUILD: Re-launch builder to fix open bugs/tasks
      // (factory-core-cur.1.17)
      // -------------------------------------------------------------------
      case "resume-build": {
        await addLabelsToEpic(epicId, ["agent:running"], fleetCorePath);
        invalidateCache();

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
      // START WAVE: Launch builder scoped to a specific wave
      // -------------------------------------------------------------------
      case "start-wave": {
        const wave = typeof waveNumber === "number" ? waveNumber : parseInt(String(waveNumber), 10);
        if (isNaN(wave) || wave < 1) {
          return NextResponse.json({ error: "Invalid waveNumber" }, { status: 400 });
        }

        await addLabelsToEpic(epicId, ["agent:running"], fleetCorePath);
        invalidateCache();

        const { repoPath: waveRepoPath, repoName: waveRepoName, researchPath: waveResearchPath, planPath: wavePlanPath, testScenariosPath: waveTestScenariosPath } = resolveRepoPath(
          shipType,
          epicTitle as string,
          appName,
          epicId as string,
          fleetCorePath
        );

        const waveTestScenariosInfo = waveTestScenariosPath ? ` Test scenarios: ${waveTestScenariosPath}.` : "";
        const startWavePrompt = `Build Wave ${wave} beads for epic ${epicId} (${epicTitle}). Ship type: ${shipType}. Product repo: ${waveRepoPath}. Research report: ${waveResearchPath}. Build plan: ${wavePlanPath}. Fleet-core: ${fleetCorePath}.${waveTestScenariosInfo} Standing orders and agent instructions are in fleet-core — read them before starting. ONLY work beads with wave:${wave} label. Do not advance to the next wave.`;

        const startWaveSession = await launchAgent({
          repoPath: waveRepoPath,
          repoName: waveRepoName,
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
        });

        return NextResponse.json({ success: true, action, epicId, waveNumber: wave, session: startWaveSession });
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
        invalidateCache();

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
        invalidateCache();

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
          invalidateCache();
          return NextResponse.json({ success: true, action, epicId, skipped: true, reason: "Non-UI ship type -- no polish needed" });
        }

        await removeLabelsFromEpic(epicId, ["pipeline:qa"], fleetCorePath);
        await addLabelsToEpic(epicId, ["pipeline:ux-polish", "agent:running"], fleetCorePath);
        invalidateCache();

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
        invalidateCache();
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
        invalidateCache();
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
          invalidateCache();
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
        invalidateCache();
        return NextResponse.json({ success: true, action, epicId, targetBeadId });
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
