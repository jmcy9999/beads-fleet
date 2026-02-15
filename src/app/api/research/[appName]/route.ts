import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { getAllRepoPaths } from "@/lib/repo-config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const APP_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * GET /api/research/[appName]
 *
 * Reads a markdown research report from the factory repo at
 * apps/<appName>/research/report.md. Searches all configured repos
 * for the file, returns the first match.
 *
 * Returns: { content: string, repoPath: string } on success
 *          404 if no report found
 *          400 if app name is invalid
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: { appName: string } },
) {
  const { appName } = params;

  if (!appName || !APP_NAME_PATTERN.test(appName)) {
    return NextResponse.json(
      { error: `Invalid app name: ${appName}` },
      { status: 400 },
    );
  }

  try {
    const repoPaths = await getAllRepoPaths();

    for (const repoPath of repoPaths) {
      const reportPath = path.join(repoPath, "apps", appName, "research", "report.md");
      try {
        const content = await fs.readFile(reportPath, "utf-8");
        return NextResponse.json({ content, repoPath });
      } catch {
        // Not found in this repo — try the next one
      }
    }

    return NextResponse.json(
      { error: `No research report found for app: ${appName}` },
      { status: 404 },
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: "Failed to fetch research report", detail: message },
      { status: 500 },
    );
  }
}
