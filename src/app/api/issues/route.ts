import { NextRequest, NextResponse } from "next/server";
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import Anthropic from "@anthropic-ai/sdk";
import { getPlan, getAllProjectsPlan, invalidateCache } from "@/lib/bv-client";
import { getActiveProjectPath, getAllRepoPaths, getRepos, ALL_PROJECTS_SENTINEL } from "@/lib/repo-config";
import { parseQuickNote } from "@/lib/parse-quick-note";

const execFile = promisify(execFileCb);

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface TitleAndEstimate {
  title: string;
  estimatedMinutes: number | null;
}

/**
 * Use Haiku to clean up a raw bead title and auto-estimate effort in minutes.
 * Returns the cleaned title and an estimated_minutes value for release ETA.
 * Falls back to the raw title and null estimate if the API key is missing
 * or the call fails.
 */
async function cleanupTitleAndEstimate(
  raw: string,
  issueType?: string,
  priority?: number
): Promise<TitleAndEstimate> {
  if (!process.env.ANTHROPIC_API_KEY) return { title: raw, estimatedMinutes: null };

  try {
    const client = new Anthropic();
    const typeHint = issueType ? ` (type: ${issueType})` : "";
    const priorityHint = priority !== undefined ? ` (priority: P${priority})` : "";

    const msg = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      system: `You process issue tracker titles. Do two things:
1. Clean the title: fix spelling/grammar, make it concise and professional. Keep as a short title (no full stop). Preserve technical terms.
2. Estimate effort in minutes based on the title, type, and priority. Use these ranges as guidance:
   - bug: 15-120 min (typo/config: 15-30, logic fix: 30-90, complex: 90-120)
   - task: 30-480 min (simple: 30-60, moderate: 120-240, complex: 240-480)
   - feature: 120-960 min (small: 120-240, medium: 240-480, large: 480-960)
   - epic: 480-2880 min (tracking overhead only)
   - chore: 15-120 min

Return ONLY valid JSON: {"title": "cleaned title", "estimated_minutes": N}`,
      messages: [
        {
          role: "user",
          content: `${raw}${typeHint}${priorityHint}`,
        },
      ],
    });

    const text =
      msg.content[0].type === "text" ? msg.content[0].text.trim() : "";

    try {
      const parsed = JSON.parse(text);
      const title = typeof parsed.title === "string" && parsed.title ? parsed.title : raw;
      const minutes = typeof parsed.estimated_minutes === "number" && parsed.estimated_minutes > 0
        ? Math.round(parsed.estimated_minutes)
        : null;
      return { title, estimatedMinutes: minutes };
    } catch {
      // If JSON parsing fails, treat the whole response as a cleaned title
      return { title: text || raw, estimatedMinutes: null };
    }
  } catch (err) {
    console.warn("[QuickCreate] Title cleanup + estimate failed, using raw:", err);
    return { title: raw, estimatedMinutes: null };
  }
}

export async function GET() {
  try {
    const projectPath = await getActiveProjectPath();

    if (projectPath === ALL_PROJECTS_SENTINEL) {
      const paths = await getAllRepoPaths();
      const data = await getAllProjectsPlan(paths);
      return NextResponse.json(data);
    }

    const data = await getPlan(projectPath);
    return NextResponse.json(data);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[API /api/issues]", message);
    if (message.includes("BEADS_PROJECT_PATH")) {
      return NextResponse.json(
        { error: "BEADS_PROJECT_PATH not configured", detail: message },
        { status: 503 },
      );
    }
    return NextResponse.json(
      { error: "Failed to fetch issues", detail: message },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  let body: { note?: string; repoPath?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { note, repoPath } = body;

  if (!note || typeof note !== "string" || !note.trim()) {
    return NextResponse.json({ error: "Note is required" }, { status: 400 });
  }

  // Resolve target repo
  let targetPath: string;
  if (repoPath) {
    const store = await getRepos();
    const match = store.repos.find((r) => r.path === repoPath);
    if (!match) {
      return NextResponse.json(
        { error: `Repo not found: ${repoPath}` },
        { status: 400 },
      );
    }
    targetPath = match.path;
  } else {
    const active = await getActiveProjectPath();
    if (active === ALL_PROJECTS_SENTINEL) {
      return NextResponse.json(
        { error: "Select a specific project (not All Projects) or pass repoPath" },
        { status: 400 },
      );
    }
    targetPath = active;
  }

  // Parse the shorthand note
  const parsed = parseQuickNote(note);

  if (!parsed.title) {
    return NextResponse.json(
      { error: "Could not extract a title from the note" },
      { status: 400 },
    );
  }

  // Clean up the title and auto-estimate effort via Haiku
  const { title: cleanedTitle, estimatedMinutes } = await cleanupTitleAndEstimate(
    parsed.title,
    parsed.type,
    parsed.priority
  );

  // Build bd create args
  const args = ["create", `--title=${cleanedTitle}`];
  if (parsed.type) args.push(`--type=${parsed.type}`);
  if (parsed.priority !== undefined) args.push(`--priority=${parsed.priority}`);
  if (parsed.parent) args.push(`--parent=${parsed.parent}`);
  // Use explicit estimate from user if provided, otherwise use AI estimate
  const finalEstimate = parsed.estimate ?? estimatedMinutes;
  if (finalEstimate != null && finalEstimate > 0) {
    args.push(`--estimate=${finalEstimate}`);
  }

  try {
    const { stdout } = await execFile("bd", args, {
      cwd: targetPath,
      timeout: 15_000,
      env: { ...process.env, NO_COLOR: "1" },
    });

    invalidateCache();

    // Try to extract the issue ID from bd output (e.g. "Created issue: cycle-apps-factory-abc")
    const idMatch = stdout.match(/([a-zA-Z0-9_-]+-[a-zA-Z0-9]+)/);
    const issueId = idMatch ? idMatch[1] : undefined;

    return NextResponse.json({
      success: true,
      issueId,
      title: cleanedTitle,
      rawTitle: parsed.title,
      estimatedMinutes: finalEstimate ?? null,
      parsed,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to create issue: ${message}` },
      { status: 500 },
    );
  }
}
