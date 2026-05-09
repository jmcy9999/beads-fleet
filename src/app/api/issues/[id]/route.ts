import { NextRequest, NextResponse } from "next/server";
import { findRepoForIssue, getActiveProjectPath, ALL_PROJECTS_SENTINEL } from "@/lib/repo-config";
import { getRepoReadSnapshot } from "@/lib/read-model-snapshot";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    let projectPath = await getActiveProjectPath();
    if (projectPath === ALL_PROJECTS_SENTINEL) {
      const resolved = await findRepoForIssue(id);
      if (!resolved) {
        return NextResponse.json(
          { error: `Issue ${id} not found in any configured repo` },
          { status: 404 },
        );
      }
      projectPath = resolved;
    }
    const snapshot = await getRepoReadSnapshot(projectPath);
    const planIssue = snapshot.plan.all_issues.find((issue) => issue.id === id);
    if (!planIssue) throw new Error(`Issue not found: ${id}`);

    const rawIssue = snapshot.issues.find((issue) => issue.id === id) ?? null;

    return NextResponse.json({
      plan_issue: planIssue,
      raw_issue: rawIssue,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    if (message.includes("not found")) {
      return NextResponse.json({ error: message }, { status: 404 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
