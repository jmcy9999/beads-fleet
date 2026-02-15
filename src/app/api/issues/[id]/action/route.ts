import { NextRequest, NextResponse } from "next/server";
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import { findRepoForIssue, getActiveProjectPath, ALL_PROJECTS_SENTINEL } from "@/lib/repo-config";
import { invalidateCache } from "@/lib/bv-client";

const execFile = promisify(execFileCb);

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type IssueAction = "start" | "close" | "reopen" | "comment";

const VALID_ACTIONS = new Set<IssueAction>(["start", "close", "reopen", "comment"]);
const ISSUE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  const issueId = params.id;

  // Validate issue ID format
  if (!issueId || !ISSUE_ID_PATTERN.test(issueId)) {
    return NextResponse.json(
      { error: `Invalid issue ID: ${issueId}` },
      { status: 400 },
    );
  }

  let body: { action?: string; reason?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const { action, reason } = body;

  // Validate action
  if (!action || !VALID_ACTIONS.has(action as IssueAction)) {
    return NextResponse.json(
      { error: `Invalid action: ${action}. Must be one of: start, close, reopen, comment` },
      { status: 400 },
    );
  }

  // Comment action requires text
  if (action === "comment" && !reason) {
    return NextResponse.json(
      { error: "Comment text is required" },
      { status: 400 },
    );
  }

  // Build bd CLI args
  let args: string[];
  switch (action as IssueAction) {
    case "start":
      args = ["update", issueId, "--status=in_progress"];
      break;
    case "close":
      args = ["close", issueId];
      if (reason) {
        args.push("--reason", reason);
      }
      break;
    case "reopen":
      args = ["update", issueId, "--status=open"];
      break;
    case "comment":
      args = ["comment", issueId, reason!];
      break;
  }

  try {
    // Resolve the correct project for this issue.
    // In __all__ mode (or any mode), look up which DB contains the issue.
    let projectPath = await getActiveProjectPath();
    if (projectPath === ALL_PROJECTS_SENTINEL) {
      const resolved = await findRepoForIssue(issueId);
      if (!resolved) {
        return NextResponse.json(
          { error: `Issue ${issueId} not found in any configured repo` },
          { status: 404 },
        );
      }
      projectPath = resolved;
    } else {
      // Even in single-project mode, verify the issue lives here;
      // if not, search all repos as a fallback.
      const resolved = await findRepoForIssue(issueId);
      if (resolved) projectPath = resolved;
    }

    await execFile("bd", args, {
      cwd: projectPath,
      timeout: 15_000,
      env: { ...process.env, NO_COLOR: "1" },
    });

    // Bust server-side cache so subsequent reads reflect the change
    invalidateCache();

    return NextResponse.json({ success: true, action, issueId });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to ${action} issue ${issueId}: ${message}` },
      { status: 500 },
    );
  }
}
