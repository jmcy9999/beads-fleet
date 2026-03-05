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

/**
 * Use Haiku to clean up a raw bead title: fix spelling, grammar, make it
 * concise and readable. Preserves meaning. Falls back to the raw title
 * if the API key is missing or the call fails.
 */
async function cleanupTitle(raw: string): Promise<string> {
  if (!process.env.ANTHROPIC_API_KEY) return raw;

  try {
    const client = new Anthropic();
    const msg = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 150,
      system: `You clean up issue tracker titles. Fix spelling and grammar. Make it concise, readable, and professional. Keep it as a short title (not a sentence with a full stop). Do not add quotes. Preserve any technical terms. Return ONLY the cleaned title, nothing else.`,
      messages: [{ role: "user", content: raw }],
    });

    const cleaned =
      msg.content[0].type === "text" ? msg.content[0].text.trim() : raw;
    return cleaned || raw;
  } catch (err) {
    console.warn("[QuickCreate] Title cleanup failed, using raw:", err);
    return raw;
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

  // Clean up the title via Haiku (gracefully falls back to raw if no API key)
  const cleanedTitle = await cleanupTitle(parsed.title);

  // Build bd create args
  const args = ["create", `--title=${cleanedTitle}`];
  if (parsed.type) args.push(`--type=${parsed.type}`);
  if (parsed.priority !== undefined) args.push(`--priority=${parsed.priority}`);
  if (parsed.parent) args.push(`--parent=${parsed.parent}`);

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
