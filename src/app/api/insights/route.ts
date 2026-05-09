import { NextResponse } from "next/server";
import { getInsights } from "@/lib/bv-client";
import { getActiveProjectPath, getAllRepoPaths, ALL_PROJECTS_SENTINEL } from "@/lib/repo-config";
import { computeInsightsFromIssues } from "@/lib/graph-metrics";
import { emptyInsights } from "@/lib/plan-builder";
import { getPortfolioReadSnapshot } from "@/lib/read-model-snapshot";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const projectPath = await getActiveProjectPath();

    if (projectPath === ALL_PROJECTS_SENTINEL) {
      // Aggregate insights across all repos
      const paths = await getAllRepoPaths();
      const snapshot = await getPortfolioReadSnapshot(paths);
      const allIssues = snapshot.issues;

      if (allIssues.length === 0) {
        return NextResponse.json(emptyInsights("__all__"));
      }

      const data = computeInsightsFromIssues(allIssues, "__all__");
      return NextResponse.json(data);
    }

    const data = await getInsights(projectPath);
    return NextResponse.json(data);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[API /api/insights]", message);
    if (message.includes("BEADS_PROJECT_PATH")) {
      return NextResponse.json(
        { error: "BEADS_PROJECT_PATH not configured", detail: message },
        { status: 503 },
      );
    }
    return NextResponse.json(
      { error: "Failed to fetch insights", detail: message },
      { status: 500 },
    );
  }
}
