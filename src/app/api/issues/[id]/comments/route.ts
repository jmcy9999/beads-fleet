import { NextRequest, NextResponse } from "next/server";
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import { existsSync, readFileSync } from "fs";
import path from "path";
import * as mysql from "mysql2/promise";
import { findRepoForIssue, getActiveProjectPath, ALL_PROJECTS_SENTINEL } from "@/lib/repo-config";
import { invalidateCache } from "@/lib/bv-client";
import { getBdPath, getBdEnv } from "@/lib/bd-path";
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
 * GET /api/issues/[id]/comments — read comments from Dolt.
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

    const portFile = path.join(projectPath, ".beads", "dolt-server.port");
    if (!existsSync(portFile)) {
      return NextResponse.json([] as BeadsComment[]);
    }

    const port = parseInt(readFileSync(portFile, "utf-8").trim(), 10);
    if (isNaN(port)) {
      return NextResponse.json([] as BeadsComment[]);
    }

    let database = path.basename(projectPath);
    const metaFile = path.join(projectPath, ".beads", "metadata.json");
    if (existsSync(metaFile)) {
      try {
        const meta = JSON.parse(readFileSync(metaFile, "utf-8"));
        if (meta.dolt_database) database = meta.dolt_database;
      } catch {
        // Use default
      }
    }

    const conn = await mysql.createConnection({
      host: "127.0.0.1",
      port,
      user: "root",
      database,
      connectTimeout: 3000,
    });

    try {
      const [rows] = await conn.query(
        "SELECT id, issue_id, author, text, created_at FROM comments WHERE issue_id = ? ORDER BY created_at ASC",
        [issueId],
      );

      const comments: BeadsComment[] = (rows as CommentRow[]).map((r) => ({
        id: r.id,
        issue_id: r.issue_id,
        author: r.author,
        text: r.text,
        created_at: r.created_at,
      }));

      return NextResponse.json(comments);
    } finally {
      await conn.end();
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

    await execFile(getBdPath(), ["comment", issueId, text.trim()], {
      cwd: projectPath,
      timeout: 15_000,
      env: getBdEnv(),
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
