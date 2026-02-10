import { NextRequest, NextResponse } from "next/server";
import { getActiveProjectPath } from "@/lib/repo-config";
import { getTokenUsageRecords, getTokenUsageSummary } from "@/lib/token-usage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const projectPath = await getActiveProjectPath();
    const { searchParams } = request.nextUrl;
    const summary = searchParams.get("summary");
    const issueId = searchParams.get("issue_id");

    // Summary mode: return aggregated data by issue
    if (summary === "true") {
      const data = await getTokenUsageSummary(projectPath);
      return NextResponse.json(data);
    }

    // Fetch all records (optionally filtered by issue_id)
    let records = await getTokenUsageRecords(projectPath);

    if (issueId) {
      records = records.filter((r) => r.issue_id === issueId);
    }

    return NextResponse.json(records);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[API /api/token-usage]", message);
    if (message.includes("BEADS_PROJECT_PATH")) {
      return NextResponse.json(
        { error: "BEADS_PROJECT_PATH not configured", detail: message },
        { status: 503 },
      );
    }
    return NextResponse.json(
      { error: "Failed to fetch token usage", detail: message },
      { status: 500 },
    );
  }
}
