import { NextRequest, NextResponse } from "next/server";
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import { existsSync } from "fs";
import path from "path";
import Database from "better-sqlite3";
import { findRepoForIssue, getActiveProjectPath, ALL_PROJECTS_SENTINEL } from "@/lib/repo-config";
import { invalidateCache } from "@/lib/bv-client";
import type { BeadsComment } from "@/lib/types";

const execFile = promisify(execFileCb);

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface CommentRow {
  id: number;
  issue_id: string;
  author: string;
  text: string;
  created_at: string;
}

/**
 * GET /api/issues/[id]/comments — read comments from SQLite.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: issueId } = await params;

  try {
    let projectPath = await getActiveProjectPath();
    if (projectPath === ALL_PROJECTS_SENTINEL) {
      const resolved = await findRepoForIssue(issueId);
      if (!resolved) {
        return NextResponse.json([] as BeadsComment[]);
      }
      projectPath = resolved;
    } else {
      const resolved = await findRepoForIssue(issueId);
      if (resolved) projectPath = resolved;
    }

    const dbPath = path.join(projectPath, ".beads", "beads.db");
    if (!existsSync(dbPath)) {
      return NextResponse.json([] as BeadsComment[]);
    }

    const db = new Database(dbPath, { readonly: true });
    try {
      const rows = db
        .prepare(
          "SELECT id, issue_id, author, text, created_at FROM comments WHERE issue_id = ? ORDER BY created_at ASC",
        )
        .all(issueId) as CommentRow[];

      const comments: BeadsComment[] = rows.map((r) => ({
        id: r.id,
        issue_id: r.issue_id,
        author: r.author,
        text: r.text,
        created_at: r.created_at,
      }));

      return NextResponse.json(comments);
    } finally {
      db.close();
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * POST /api/issues/[id]/comments — add a comment via `bd comment`.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: issueId } = await params;

  let body: { text?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { text } = body;
  if (!text || !text.trim()) {
    return NextResponse.json(
      { error: "Comment text is required" },
      { status: 400 },
    );
  }

  try {
    let projectPath = await getActiveProjectPath();
    if (projectPath === ALL_PROJECTS_SENTINEL) {
      const resolved = await findRepoForIssue(issueId);
      if (!resolved) {
        return NextResponse.json(
          { error: `Issue ${issueId} not found in any configured repo` },
          { status: 404 },
        );
      }
      projectPath = resolved;
    } else {
      const resolved = await findRepoForIssue(issueId);
      if (resolved) projectPath = resolved;
    }

    await execFile("bd", ["comment", issueId, text.trim()], {
      cwd: projectPath,
      timeout: 15_000,
      env: { ...process.env, NO_COLOR: "1" },
    });

    invalidateCache();

    return NextResponse.json({ success: true, issueId });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to add comment to ${issueId}: ${message}` },
      { status: 500 },
    );
  }
}
