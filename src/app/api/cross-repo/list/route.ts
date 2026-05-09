import { NextRequest, NextResponse } from "next/server";
import { getAllRepoPaths } from "@/lib/repo-config";
import { getPortfolioReadSnapshot } from "@/lib/read-model-snapshot";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/cross-repo/list
 *
 * Enumerates beads across all configured repos, filtered by exact label match.
 * Reuses the portfolio read snapshot so concurrent dashboard endpoints share
 * one repo fan-out.
 *
 * Query params:
 *   - label  (required) — exact label to filter by (e.g. "epic:factory-core-so74")
 *   - status (optional) — "open" | "closed" | "all" (default: "open")
 *
 * Each returned issue includes a top-level `.repo` field derived from the
 * `project:<repoName>` label that the portfolio snapshot adds.
 */
export async function GET(request: NextRequest) {
  const label = request.nextUrl.searchParams.get("label");
  if (!label || label.trim() === "") {
    return NextResponse.json(
      { error: "label query parameter is required" },
      { status: 400 },
    );
  }

  const statusParam = request.nextUrl.searchParams.get("status") ?? "open";
  const validStatuses = ["open", "closed", "all"];
  if (!validStatuses.includes(statusParam)) {
    return NextResponse.json(
      { error: `Invalid status "${statusParam}". Must be one of: ${validStatuses.join(", ")}` },
      { status: 400 },
    );
  }

  try {
    const paths = await getAllRepoPaths();
    const { plan: data } = await getPortfolioReadSnapshot(paths);

    // Filter by EXACT label match — Array.includes uses strict equality,
    // not substring matching. This is critical: "epic:factory-core-so7"
    // must NOT match issues labelled "epic:factory-core-so74".
    let filtered = data.all_issues.filter(
      (issue) => issue.labels?.includes(label) === true,
    );

    // Apply status filter
    if (statusParam !== "all") {
      filtered = filtered.filter((issue) => issue.status === statusParam);
    }

    // Promote repo name from the `project:<repoName>` label to a top-level field
    const results = filtered.map((issue) => {
      const projectLabel = issue.labels?.find((l) => l.startsWith("project:"));
      const repo = projectLabel ? projectLabel.slice("project:".length) : undefined;
      return { ...issue, repo };
    });

    return NextResponse.json({
      label,
      status: statusParam,
      count: results.length,
      issues: results,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[API /api/cross-repo/list]", message);
    return NextResponse.json(
      { error: "Failed to enumerate cross-repo issues", detail: message },
      { status: 500 },
    );
  }
}
