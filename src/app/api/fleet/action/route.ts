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
  | "qa-fix-and-retest";

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
]);

const FACTORY_REPO_PATH = "/Users/janemckay/dev/claude_projects/cycle-apps-factory";

/**
 * Derive the app name from the epic title. Strips common suffixes and extracts
 * the PascalCase app name. Falls back to the epic ID if no clear name found.
 */
function deriveAppName(epicTitle: string, epicId: string): string {
  // Try to extract an AppName-style identifier (e.g., "LensCycle" from "LensCycle: ...")
  const colonMatch = epicTitle.match(/^(\w+):/);
  if (colonMatch) return colonMatch[1];

  // Try PascalCase word
  const pascalMatch = epicTitle.match(/\b([A-Z][a-z]+(?:[A-Z][a-z]+)+)\b/);
  if (pascalMatch) return pascalMatch[1];

  // Fallback: first meaningful word
  const words = epicTitle.split(/\s+/).filter((w) => w.length > 2);
  return words[0] ?? epicId;
}

/**
 * POST /api/fleet/action -- Execute a pipeline action on a factory epic.
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
  const factoryRepo = store.repos.find((r) => r.path === FACTORY_REPO_PATH || r.name.includes("factory"));
  const factoryPath = factoryRepo?.path ?? FACTORY_REPO_PATH;

  const appName = deriveAppName(epicTitle as string, epicId as string);
  const labels = Array.isArray(currentLabels) ? currentLabels as string[] : [];

  try {
    switch (action as PipelineAction) {
      // -------------------------------------------------------------------
      // START RESEARCH: Ideas -> In Research
      // -------------------------------------------------------------------
      case "start-research": {
        await addLabelsToEpic(epicId, ["pipeline:research", "agent:running"], factoryPath);
        await updateEpicStatus(epicId, "in_progress", factoryPath);
        invalidateCache();

        // Launch research agent
        const session = await launchAgent({
          repoPath: factoryPath,
          repoName: "cycle-apps-factory",
          prompt: `Research the app idea "${epicTitle}" (epic: ${epicId}). Follow the research workflow instructions in CLAUDE.md.`,
          model: "opus",
          maxTurns: 200,
          allowedTools: "Bash,Read,Write,Edit,Glob,Grep,Task,WebSearch",
          epicId: epicId,
          pipelineStage: "research",
        });

        return NextResponse.json({ success: true, action, epicId, session });
      }

      // -------------------------------------------------------------------
      // SEND FOR DEVELOPMENT: Research Complete -> In Development
      // -------------------------------------------------------------------
      case "send-for-development": {
        await removeLabelsFromEpic(epicId, ["pipeline:research-complete", "plan:pending", "plan:approved"], factoryPath);
        await addLabelsToEpic(epicId, ["pipeline:development", "agent:running"], factoryPath);
        invalidateCache();

        // Launch development agent in the app's own repo
        const appRepoPath = `/Users/janemckay/dev/claude_projects/${appName}`;
        const session = await launchAgent({
          repoPath: appRepoPath,
          repoName: appName,
          prompt: `Develop the app "${epicTitle}" (epic: ${epicId}). Follow the development workflow instructions in /Users/janemckay/dev/claude_projects/cycle-apps-factory/CLAUDE.md. Research report is at /Users/janemckay/dev/claude_projects/cycle-apps-factory/apps/${appName}/research/report.md. Build plan is at /Users/janemckay/dev/claude_projects/${appName}/.beads/plans/${epicId}.md — read this first for the UX walkthrough, personas, assumption flags, and conditional logic maps.`,
          model: "opus",
          maxTurns: 500,
          allowedTools: "Bash,Read,Write,Edit,Glob,Grep,Task",
          epicId: epicId,
          pipelineStage: "development",
        });

        return NextResponse.json({ success: true, action, epicId, session });
      }

      // -------------------------------------------------------------------
      // MORE RESEARCH: Research Complete -> In Research (loop)
      // -------------------------------------------------------------------
      case "more-research": {
        await removeLabelsFromEpic(epicId, ["pipeline:research-complete", "plan:pending", "plan:approved"], factoryPath);
        await addLabelsToEpic(epicId, ["pipeline:research", "agent:running"], factoryPath);
        invalidateCache();

        const feedbackStr = typeof feedback === "string" && feedback.trim()
          ? ` Jane's feedback: "${feedback}". Revise and extend the research.`
          : "";

        const session = await launchAgent({
          repoPath: factoryPath,
          repoName: "cycle-apps-factory",
          prompt: `Research the app idea "${epicTitle}" (epic: ${epicId}). Previous research exists at apps/${appName}/research/report.md.${feedbackStr} Follow the research workflow instructions in CLAUDE.md.`,
          model: "opus",
          maxTurns: 200,
          allowedTools: "Bash,Read,Write,Edit,Glob,Grep,Task,WebSearch",
          epicId: epicId,
          pipelineStage: "research",
        });

        return NextResponse.json({ success: true, action, epicId, session });
      }

      // -------------------------------------------------------------------
      // DEPRIORITISE: Research Complete -> Bad Ideas
      // -------------------------------------------------------------------
      case "deprioritise": {
        await removeAllPipelineLabels(epicId, labels, factoryPath);
        await removeLabelsFromEpic(epicId, ["plan:pending", "plan:approved"], factoryPath);
        await addLabelsToEpic(epicId, ["pipeline:bad-idea"], factoryPath);
        const reason = typeof feedback === "string" && feedback.trim()
          ? feedback
          : "Deprioritised from fleet board";
        await closeEpic(epicId, reason, factoryPath);
        invalidateCache();

        return NextResponse.json({ success: true, action, epicId });
      }

      // -------------------------------------------------------------------
      // APPROVE SUBMISSION: Prepare for Submission -> Submitted
      // -------------------------------------------------------------------
      case "approve-submission": {
        await addLabelsToEpic(epicId, ["agent:running"], factoryPath);
        invalidateCache();

        const session = await launchAgent({
          repoPath: factoryPath,
          repoName: "cycle-apps-factory",
          prompt: `Prepare submission for "${epicTitle}" (epic: ${epicId}). Follow the submission workflow instructions in CLAUDE.md.`,
          model: "sonnet",
          maxTurns: 100,
          allowedTools: "Bash,Read,Write,Edit,Glob,Grep",
          epicId: epicId,
          pipelineStage: "submission-prep",
        });

        return NextResponse.json({ success: true, action, epicId, session });
      }

      // -------------------------------------------------------------------
      // SEND BACK TO DEVELOPMENT: Prepare for Submission -> In Development
      // -------------------------------------------------------------------
      case "send-back-to-dev": {
        await removeLabelsFromEpic(epicId, ["pipeline:submission-prep"], factoryPath);
        await addLabelsToEpic(epicId, ["pipeline:development", "agent:running"], factoryPath);
        invalidateCache();

        const appRepoPath = `/Users/janemckay/dev/claude_projects/${appName}`;
        const feedbackStr2 = typeof feedback === "string" && feedback.trim()
          ? ` Jane's feedback on the current build: "${feedback}". Address these issues.`
          : "";

        const session = await launchAgent({
          repoPath: appRepoPath,
          repoName: appName,
          prompt: `Develop the app "${epicTitle}" (epic: ${epicId}). Follow the development workflow instructions in /Users/janemckay/dev/claude_projects/cycle-apps-factory/CLAUDE.md. Research report is at /Users/janemckay/dev/claude_projects/cycle-apps-factory/apps/${appName}/research/report.md.${feedbackStr2}`,
          model: "opus",
          maxTurns: 500,
          allowedTools: "Bash,Read,Write,Edit,Glob,Grep,Task",
          epicId: epicId,
          pipelineStage: "development",
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
        await removeLabelsFromEpic(epicId, submissionLabels, factoryPath);
        await addLabelsToEpic(epicId, ["pipeline:kit-management", "agent:running"], factoryPath);
        invalidateCache();

        const session = await launchAgent({
          repoPath: factoryPath,
          repoName: "cycle-apps-factory",
          prompt: `Analyze "${epicTitle}" for kit enhancements (epic: ${epicId}). Follow the kit analysis workflow in CLAUDE.md.`,
          model: "opus",
          maxTurns: 200,
          allowedTools: "Bash,Read,Write,Edit,Glob,Grep,Task",
          epicId: epicId,
          pipelineStage: "kit-management",
        });

        return NextResponse.json({ success: true, action, epicId, session });
      }

      // -------------------------------------------------------------------
      // GENERATE PLAN: Research Complete -> Planning (launch planning agent)
      // -------------------------------------------------------------------
      case "generate-plan": {
        // Keep research-complete label, add agent:running (plan:pending added on agent exit)
        await addLabelsToEpic(epicId, ["pipeline:research-complete", "agent:running"], factoryPath);
        invalidateCache();

        const appRepoPath3 = `/Users/janemckay/dev/claude_projects/${appName}`;
        const session = await launchAgent({
          repoPath: appRepoPath3,
          repoName: appName,
          prompt: `Plan the app build for "${epicTitle}" (epic: ${epicId}, entry: from-research). Follow the planning workflow instructions in /Users/janemckay/dev/claude_projects/cycle-apps-factory/CLAUDE.md. Recon brief is at /Users/janemckay/dev/claude_projects/cycle-apps-factory/apps/${appName}/research/report.md.`,
          model: "opus",
          maxTurns: 200,
          allowedTools: "Bash,Read,Write,Edit,Glob,Grep,Task",
          epicId: epicId,
          pipelineStage: "planning",
        });

        return NextResponse.json({ success: true, action, epicId, session });
      }

      // -------------------------------------------------------------------
      // APPROVE PLAN: plan:pending -> plan:approved (label change only)
      // -------------------------------------------------------------------
      case "approve-plan": {
        await removeLabelsFromEpic(epicId, ["plan:pending"], factoryPath);
        await addLabelsToEpic(epicId, ["plan:approved"], factoryPath);
        invalidateCache();

        return NextResponse.json({ success: true, action, epicId });
      }

      // -------------------------------------------------------------------
      // APPROVE & BUILD: Approve plan + immediately start development
      // -------------------------------------------------------------------
      case "approve-and-build": {
        await removeLabelsFromEpic(epicId, ["pipeline:research-complete", "plan:pending"], factoryPath);
        await addLabelsToEpic(epicId, ["plan:approved", "pipeline:development", "agent:running"], factoryPath);
        invalidateCache();

        const appRepoPath7 = `/Users/janemckay/dev/claude_projects/${appName}`;
        const session = await launchAgent({
          repoPath: appRepoPath7,
          repoName: appName,
          prompt: `Develop the app "${epicTitle}" (epic: ${epicId}). Follow the development workflow instructions in /Users/janemckay/dev/claude_projects/cycle-apps-factory/CLAUDE.md. Research report is at /Users/janemckay/dev/claude_projects/cycle-apps-factory/apps/${appName}/research/report.md. Build plan is at /Users/janemckay/dev/claude_projects/${appName}/.beads/plans/${epicId}.md — read this first for the UX walkthrough, personas, assumption flags, and conditional logic maps.`,
          model: "opus",
          maxTurns: 500,
          allowedTools: "Bash,Read,Write,Edit,Glob,Grep,Task",
          epicId: epicId,
          pipelineStage: "development",
        });

        return NextResponse.json({ success: true, action, epicId, session });
      }

      // -------------------------------------------------------------------
      // REVISE PLAN: Re-launch planning agent with feedback
      // -------------------------------------------------------------------
      case "revise-plan": {
        await removeLabelsFromEpic(epicId, ["plan:approved", "plan:pending"], factoryPath);
        await addLabelsToEpic(epicId, ["agent:running"], factoryPath);
        invalidateCache();

        const appRepoPath4 = `/Users/janemckay/dev/claude_projects/${appName}`;
        const feedbackStr3 = typeof feedback === "string" && feedback.trim()
          ? ` Jane's feedback: "${feedback}".`
          : "";

        const session = await launchAgent({
          repoPath: appRepoPath4,
          repoName: appName,
          prompt: `Revise the build plan for "${epicTitle}" (epic: ${epicId}, entry: revise-plan). Follow the planning workflow instructions in /Users/janemckay/dev/claude_projects/cycle-apps-factory/CLAUDE.md.${feedbackStr3}`,
          model: "opus",
          maxTurns: 200,
          allowedTools: "Bash,Read,Write,Edit,Glob,Grep,Task",
          epicId: epicId,
          pipelineStage: "planning",
        });

        return NextResponse.json({ success: true, action, epicId, session });
      }

      // -------------------------------------------------------------------
      // SKIP TO PLAN: Candidates -> Planning (no research, straight to plan)
      // -------------------------------------------------------------------
      case "skip-to-plan": {
        await addLabelsToEpic(epicId, ["pipeline:research-complete", "agent:running"], factoryPath);
        await updateEpicStatus(epicId, "in_progress", factoryPath);
        invalidateCache();

        const appRepoPath5 = `/Users/janemckay/dev/claude_projects/${appName}`;
        const session = await launchAgent({
          repoPath: appRepoPath5,
          repoName: appName,
          prompt: `Plan the app build for "${epicTitle}" (epic: ${epicId}, entry: from-candidates). Follow the planning workflow instructions in /Users/janemckay/dev/claude_projects/cycle-apps-factory/CLAUDE.md. No recon brief -- use the epic description as the spec.`,
          model: "opus",
          maxTurns: 200,
          allowedTools: "Bash,Read,Write,Edit,Glob,Grep,Task",
          epicId: epicId,
          pipelineStage: "planning",
        });

        return NextResponse.json({ success: true, action, epicId, session });
      }

      // -------------------------------------------------------------------
      // REVISE PLAN FROM LAUNCH: Submission Prep -> Planning (with feedback)
      // -------------------------------------------------------------------
      case "revise-plan-from-launch": {
        await removeLabelsFromEpic(epicId, ["pipeline:submission-prep"], factoryPath);
        await addLabelsToEpic(epicId, ["pipeline:research-complete", "agent:running"], factoryPath);
        invalidateCache();

        const appRepoPath6 = `/Users/janemckay/dev/claude_projects/${appName}`;
        const feedbackStr4 = typeof feedback === "string" && feedback.trim()
          ? ` Jane's feedback: "${feedback}".`
          : "";

        const session = await launchAgent({
          repoPath: appRepoPath6,
          repoName: appName,
          prompt: `Revise the build plan for "${epicTitle}" (epic: ${epicId}, entry: revise-plan). Follow the planning workflow instructions in /Users/janemckay/dev/claude_projects/cycle-apps-factory/CLAUDE.md.${feedbackStr4}`,
          model: "opus",
          maxTurns: 200,
          allowedTools: "Bash,Read,Write,Edit,Glob,Grep,Task",
          epicId: epicId,
          pipelineStage: "planning",
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
        await removeLabelsFromEpic(epicId, ["pipeline:development", ...roundLabels], factoryPath);
        await addLabelsToEpic(epicId, ["pipeline:qa", `qa:round-${currentRound}`, "agent:running"], factoryPath);
        invalidateCache();

        const qaAppName = extractAppName(epicTitle as string) ?? appName;
        const qaAppPath = `/Users/janemckay/dev/claude_projects/${qaAppName}`;

        const session = await launchAgent({
          repoPath: qaAppPath,
          repoName: qaAppName,
          prompt: `Run QA verification for "${epicTitle}" (epic: ${epicId}, round: ${currentRound}). Follow the QA workflow in /Users/janemckay/dev/claude_projects/cycle-apps-factory/.claude/agents/qa.md. App repo: ${qaAppPath}. Recon brief: /Users/janemckay/dev/claude_projects/cycle-apps-factory/apps/${qaAppName}/research/report.md. Build plan: ${qaAppPath}/.beads/plans/${epicId}.md. QA round: ${currentRound}. Shipyard repo: /Users/janemckay/dev/claude_projects/cycle-apps-factory.`,
          model: "opus",
          maxTurns: 200,
          allowedTools: "Bash,Read,Glob,Grep,Task",
          epicId: epicId,
          pipelineStage: "qa",
        });

        return NextResponse.json({ success: true, action, epicId, session, qaRound: currentRound });
      }

      // -------------------------------------------------------------------
      // QA FIX AND RETEST: QA found bugs -> Back to dev, then auto-retest
      // -------------------------------------------------------------------
      case "qa-fix-and-retest": {
        // Called internally when QA finds bugs -- sends back to dev then auto-retests
        await removeLabelsFromEpic(epicId, ["pipeline:qa"], factoryPath);
        await addLabelsToEpic(epicId, ["pipeline:development", "agent:running"], factoryPath);
        invalidateCache();

        const fixAppName = extractAppName(epicTitle as string) ?? appName;
        const fixAppPath = `/Users/janemckay/dev/claude_projects/${fixAppName}`;

        const session = await launchAgent({
          repoPath: fixAppPath,
          repoName: fixAppName,
          prompt: `Fix QA bugs for "${epicTitle}" (epic: ${epicId}). The QA crew found bugs — check bd list --status=open --type=bug for bug beads. Fix each bug, close the bead, and commit. Follow the development workflow in /Users/janemckay/dev/claude_projects/cycle-apps-factory/CLAUDE.md. After fixing all bugs, verify end-to-end flows per step 11. Research: /Users/janemckay/dev/claude_projects/cycle-apps-factory/apps/${fixAppName}/research/report.md. Plan: ${fixAppPath}/.beads/plans/${epicId}.md.`,
          model: "opus",
          maxTurns: 300,
          allowedTools: "Bash,Read,Write,Edit,Glob,Grep,Task",
          epicId: epicId,
          pipelineStage: "qa-fixes",
        });

        return NextResponse.json({ success: true, action, epicId, session });
      }

      // -------------------------------------------------------------------
      // STOP AGENT: Kill the currently running agent
      // -------------------------------------------------------------------
      case "stop-agent": {
        await removeLabelsFromEpic(epicId, ["agent:running"], factoryPath);
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
