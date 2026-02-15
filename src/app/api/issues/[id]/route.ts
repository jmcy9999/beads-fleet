import { NextRequest, NextResponse } from "next/server";
import { getIssueById } from "@/lib/bv-client";
import { findRepoForIssue, getActiveProjectPath, ALL_PROJECTS_SENTINEL } from "@/lib/repo-config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    let projectPath = await getActiveProjectPath();
    if (projectPath === ALL_PROJECTS_SENTINEL) {
      const resolved = await findRepoForIssue(params.id);
      if (!resolved) {
        return NextResponse.json(
          { error: `Issue ${params.id} not found in any configured repo` },
          { status: 404 },
        );
      }
      projectPath = resolved;
    }
    const data = await getIssueById(params.id, projectPath);
    return NextResponse.json(data);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    if (message.includes("not found")) {
      return NextResponse.json({ error: message }, { status: 404 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
