import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { getAllRepoPaths } from "@/lib/repo-config";
import type { VenturePlan } from "@/lib/venture-plan-types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const APP_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * GET /api/venture-plan/[appName]
 *
 * Reads venture-plan.json from the factory repo at
 * apps/<appName>/venture-plan.json. Searches all configured repos
 * for the file, returns the first match.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ appName: string }> },
) {
  const { appName } = await params;

  if (!appName || !APP_NAME_PATTERN.test(appName)) {
    return NextResponse.json(
      { error: `Invalid app name: ${appName}` },
      { status: 400 },
    );
  }

  try {
    const repoPaths = await getAllRepoPaths();

    for (const repoPath of repoPaths) {
      const planPath = path.join(repoPath, "apps", appName, "venture-plan.json");
      try {
        const content = await fs.readFile(planPath, "utf-8");
        const plan = JSON.parse(content) as VenturePlan;
        return NextResponse.json({ plan, repoPath, planPath });
      } catch {
        // Not found in this repo — try the next one
      }
    }

    return NextResponse.json(
      { error: `No venture plan found for app: ${appName}` },
      { status: 404 },
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: "Failed to fetch venture plan", detail: message },
      { status: 500 },
    );
  }
}

/**
 * PUT /api/venture-plan/[appName]
 *
 * Write updated venture-plan.json back to disk.
 * Used for inline revenue edits. Accepts full JSON body, validates shape.
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ appName: string }> },
) {
  const { appName } = await params;

  if (!appName || !APP_NAME_PATTERN.test(appName)) {
    return NextResponse.json(
      { error: `Invalid app name: ${appName}` },
      { status: 400 },
    );
  }

  try {
    const body = await request.json() as VenturePlan;

    // Basic shape validation
    if (!body.startDate || !body.targetMonthly || !body.currency || !Array.isArray(body.streams) || !Array.isArray(body.actuals)) {
      return NextResponse.json(
        { error: "Invalid venture plan shape: missing required fields" },
        { status: 400 },
      );
    }

    const repoPaths = await getAllRepoPaths();

    // Find existing file to update
    for (const repoPath of repoPaths) {
      const planPath = path.join(repoPath, "apps", appName, "venture-plan.json");
      try {
        await fs.access(planPath);
        // File exists — write atomically via temp file
        const tmpPath = planPath + ".tmp";
        await fs.writeFile(tmpPath, JSON.stringify(body, null, 2) + "\n", "utf-8");
        await fs.rename(tmpPath, planPath);
        return NextResponse.json({ success: true });
      } catch {
        // Not found in this repo — try the next one
      }
    }

    return NextResponse.json(
      { error: `No venture plan found for app: ${appName}` },
      { status: 404 },
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: "Failed to update venture plan", detail: message },
      { status: 500 },
    );
  }
}
