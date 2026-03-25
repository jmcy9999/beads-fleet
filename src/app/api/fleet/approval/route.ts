import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { getAllRepoPaths } from "@/lib/repo-config";
import { extractFeaturesFromPlan } from "@/lib/plan-features";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ISSUE_ID_PATTERN = /^[a-zA-Z0-9_.-]+$/;

export interface FeatureApprovalState {
  epicId: string;
  features: FeatureDecision[];
  updatedAt: string;
}

export interface FeatureDecision {
  id: string;
  name: string;
  description?: string;
  status: "pending" | "approved" | "rejected" | "deferred";
}

/**
 * Find the approval JSON path for an epic. Searches all repos for the
 * plan file and stores the approval alongside it.
 */
async function findApprovalPath(
  epicId: string,
): Promise<{ approvalPath: string; planPath: string; repoPath: string } | null> {
  const repoPaths = await getAllRepoPaths();
  for (const repoPath of repoPaths) {
    const planPath = path.join(repoPath, ".beads", "plans", `${epicId}.md`);
    try {
      await fs.stat(planPath);
      return {
        approvalPath: path.join(repoPath, ".beads", "plans", `${epicId}.approval.json`),
        planPath,
        repoPath,
      };
    } catch {
      // Not found in this repo
    }
  }
  return null;
}

/**
 * GET /api/fleet/approval?epicId=xxx
 *
 * Returns the feature approval state for an epic. If no approval file
 * exists yet, parses the plan and returns features with "pending" status.
 */
export async function GET(request: NextRequest) {
  const epicId = request.nextUrl.searchParams.get("epicId");
  if (!epicId || !ISSUE_ID_PATTERN.test(epicId) || epicId.includes("..")) {
    return NextResponse.json({ error: "Invalid epicId" }, { status: 400 });
  }

  const paths = await findApprovalPath(epicId);
  if (!paths) {
    return NextResponse.json({ error: "No plan found for this epic" }, { status: 404 });
  }

  // Check for existing approval state
  try {
    const raw = await fs.readFile(paths.approvalPath, "utf-8");
    const state: FeatureApprovalState = JSON.parse(raw);
    return NextResponse.json(state);
  } catch {
    // No approval file yet — parse plan and generate initial state
  }

  try {
    const planContent = await fs.readFile(paths.planPath, "utf-8");
    const parsed = extractFeaturesFromPlan(planContent);

    const state: FeatureApprovalState = {
      epicId,
      features: parsed.map((f) => ({
        id: f.id,
        name: f.name,
        description: f.description,
        status: "pending",
      })),
      updatedAt: new Date().toISOString(),
    };

    return NextResponse.json(state);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: "Failed to parse plan", detail: message }, { status: 500 });
  }
}

/**
 * POST /api/fleet/approval
 *
 * Save feature approval decisions. Body: FeatureApprovalState
 */
export async function POST(request: NextRequest) {
  let body: FeatureApprovalState;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { epicId, features } = body;
  if (!epicId || !ISSUE_ID_PATTERN.test(epicId) || epicId.includes("..")) {
    return NextResponse.json({ error: "Invalid epicId" }, { status: 400 });
  }
  if (!Array.isArray(features)) {
    return NextResponse.json({ error: "features must be an array" }, { status: 400 });
  }

  const paths = await findApprovalPath(epicId);
  if (!paths) {
    return NextResponse.json({ error: "No plan found for this epic" }, { status: 404 });
  }

  const state: FeatureApprovalState = {
    epicId,
    features: features.map((f) => ({
      id: f.id,
      name: f.name,
      description: f.description,
      status: f.status ?? "pending",
    })),
    updatedAt: new Date().toISOString(),
  };

  try {
    await fs.writeFile(paths.approvalPath, JSON.stringify(state, null, 2), "utf-8");
    return NextResponse.json({ success: true, state });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: "Failed to save approval", detail: message }, { status: 500 });
  }
}
