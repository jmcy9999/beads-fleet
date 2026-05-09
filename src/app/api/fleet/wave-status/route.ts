import { NextRequest, NextResponse } from "next/server";
import { getAllRepoPaths } from "@/lib/repo-config";
import { getPortfolioReadSnapshot } from "@/lib/read-model-snapshot";
import { getWaveInfo } from "@/components/fleet/fleet-utils";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const epicId = request.nextUrl.searchParams.get("epicId");
  if (!epicId) {
    return NextResponse.json({ error: "epicId query parameter is required" }, { status: 400 });
  }

  try {
    const paths = await getAllRepoPaths();
    const { plan: data } = await getPortfolioReadSnapshot(paths);

    // Find children by epic label or parent-child relationship
    const children = data.all_issues.filter(
      (i) => i.labels?.includes(`epic:${epicId}`) || i.epic === epicId,
    );

    const waveProgress = getWaveInfo(children);

    return NextResponse.json({
      epicId,
      waveProgress,
      children: {
        total: children.length,
        closed: children.filter((c) => c.status === "closed").length,
        inProgress: children.filter((c) => c.status === "in_progress").length,
        blocked: children.filter((c) => c.status === "blocked").length,
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[API /api/fleet/wave-status]", message);
    return NextResponse.json(
      { error: "Failed to fetch wave status", detail: message },
      { status: 500 },
    );
  }
}
