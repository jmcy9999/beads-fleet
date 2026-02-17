import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { getAllRepoPaths } from "@/lib/repo-config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ISSUE_ID_PATTERN = /^[a-zA-Z0-9_.-]+$/;

/**
 * GET /api/plan/[issueId]
 *
 * Reads a markdown plan document from any configured repo at
 * .beads/plans/<issueId>.md. Searches all configured repos
 * for the file, returns the first match.
 *
 * Returns: { content: string, repoPath: string } on success
 *          404 if no plan found
 *          400 if issue ID is invalid
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: { issueId: string } },
) {
  const { issueId } = params;

  if (!issueId || !ISSUE_ID_PATTERN.test(issueId) || issueId.includes("..")) {
    return NextResponse.json(
      { error: `Invalid issue ID: ${issueId}` },
      { status: 400 },
    );
  }

  try {
    const repoPaths = await getAllRepoPaths();

    const MAX_FILE_SIZE = 1024 * 1024; // 1 MB

    for (const repoPath of repoPaths) {
      const planPath = path.join(repoPath, ".beads", "plans", `${issueId}.md`);
      try {
        const stat = await fs.stat(planPath);
        if (stat.size > MAX_FILE_SIZE) {
          return NextResponse.json(
            { error: `Plan file too large (${stat.size} bytes, max ${MAX_FILE_SIZE})` },
            { status: 413 },
          );
        }
        const content = await fs.readFile(planPath, "utf-8");
        return NextResponse.json({ content, repoPath });
      } catch {
        // Not found in this repo — try the next one
      }
    }

    return NextResponse.json(
      { error: `No plan found for issue: ${issueId}` },
      { status: 404 },
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: "Failed to fetch plan", detail: message },
      { status: 500 },
    );
  }
}
