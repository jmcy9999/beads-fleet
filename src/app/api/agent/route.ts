import { NextRequest, NextResponse } from "next/server";
import { launchAgent, getAgentStatus, getFleetAgentStatus, stopAgent } from "@/lib/agent-launcher";
import { getAllRepoPaths, getRepos } from "@/lib/repo-config";
import { addLabelsToEpic, removeLabelsFromEpic } from "@/lib/pipeline-labels";
import { invalidateCache } from "@/lib/bv-client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/agent -- Get agent status
 * Query params:
 *   ?repoPath=... — status of agent in specific repo
 *   ?fleet=true   — status of all running agents
 *   (none)        — backwards-compat: first running agent
 */
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const fleet = searchParams.get("fleet");
    const repoPath = searchParams.get("repoPath");

    if (fleet === "true") {
      const status = await getFleetAgentStatus();
      return NextResponse.json(status);
    }

    const status = await getAgentStatus(repoPath || undefined);
    return NextResponse.json(status);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * POST /api/agent -- Launch or stop an agent
 *
 * Body for launch:
 *   { action: "launch", repoPath: string, prompt: string, model?: string,
 *     maxTurns?: number, allowedTools?: string, epicId?: string,
 *     pipelineStage?: string }
 *
 * Body for stop:
 *   { action: "stop" }
 */
export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { action } = body;

  if (action === "stop") {
    try {
      // If we have an epicId, remove the agent:running label
      const { epicId, repoPath: stopRepoPath } = body;
      if (epicId && typeof epicId === "string") {
        const epicRepoPath = typeof stopRepoPath === "string" ? stopRepoPath : undefined;
        try {
          await removeLabelsFromEpic(epicId, ["agent:running"], epicRepoPath);
          invalidateCache();
        } catch {
          // Label removal failure should not block the stop
        }
      }
      // Pass repoPath to stop a specific repo's agent (or "all" to stop all)
      const targetRepo = typeof stopRepoPath === "string" ? stopRepoPath : undefined;
      const result = await stopAgent(targetRepo);
      return NextResponse.json(result);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }

  if (action === "launch") {
    const { repoPath, prompt, model, maxTurns, allowedTools, epicId, pipelineStage } = body;

    if (!repoPath || typeof repoPath !== "string") {
      return NextResponse.json({ error: "Missing repoPath" }, { status: 400 });
    }
    if (!prompt || typeof prompt !== "string") {
      return NextResponse.json({ error: "Missing prompt" }, { status: 400 });
    }

    // Verify the repo is in our configured list
    const repoPaths = await getAllRepoPaths();
    if (!repoPaths.includes(repoPath)) {
      return NextResponse.json(
        { error: `Repository not configured: ${repoPath}` },
        { status: 400 },
      );
    }

    // Look up repo name
    const store = await getRepos();
    const repo = store.repos.find((r) => r.path === repoPath);

    // If epicId and pipelineStage are provided, manage labels on the epic
    if (epicId && typeof epicId === "string" && pipelineStage && typeof pipelineStage === "string") {
      try {
        // Find the fleet-core repo for label management (the repo containing the epic)
        const fleetCoreRepo = store.repos.find((r) => r.name.includes("fleet-core") || r.name.includes("factory"));
        const fleetCorePath = fleetCoreRepo?.path;

        // Add pipeline stage label and agent:running
        const labelsToAdd = [`pipeline:${pipelineStage}`, "agent:running"];
        await addLabelsToEpic(epicId, labelsToAdd, fleetCorePath);
        invalidateCache();
      } catch (err) {
        // Log but don't block agent launch
        console.error("Failed to update epic labels:", err);
      }
    }

    try {
      const session = await launchAgent({
        repoPath,
        repoName: repo?.name,
        prompt: prompt as string,
        model: typeof model === "string" ? model : undefined,
        maxTurns: typeof maxTurns === "number" ? maxTurns : undefined,
        allowedTools: typeof allowedTools === "string" ? allowedTools : undefined,
        epicId: typeof epicId === "string" ? epicId : undefined,
        pipelineStage: typeof pipelineStage === "string" ? pipelineStage : undefined,
      });
      return NextResponse.json({ launched: true, session });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return NextResponse.json({ error: message }, { status: 409 });
    }
  }

  return NextResponse.json(
    { error: `Unknown action: ${action}. Must be "launch" or "stop"` },
    { status: 400 },
  );
}
