import { NextRequest, NextResponse } from "next/server";
import { readIssuesFromJSONL } from "@/lib/jsonl-fallback";
import {
  getActiveProjectPath,
  getAllRepoPaths,
  ALL_PROJECTS_SENTINEL,
} from "@/lib/repo-config";
import type { BeadsIssue } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/signals — Polling endpoint for detecting issue state changes.
 *
 * The fleet agent polls this to detect when research tasks close, submissions
 * get approved, etc. Returns issues that changed since a given timestamp.
 *
 * Query params:
 *   since    — ISO timestamp (required). Return issues closed/updated after this time.
 *   label    — Filter to issues with this label (optional, repeatable).
 *   status   — Filter by status, defaults to "closed" (optional).
 *   field    — Which timestamp field to check: "closed_at" (default) or "updated_at".
 *
 * Response:
 *   { signals: [{ id, title, status, labels, closed_at, close_reason, epic, updated_at }] }
 *
 * Example:
 *   GET /api/signals?since=2026-02-15T00:00:00Z&label=research
 *   → returns research issues closed after Feb 15
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const since = searchParams.get("since");

    if (!since) {
      return NextResponse.json(
        { error: "Missing required 'since' parameter (ISO timestamp)" },
        { status: 400 },
      );
    }

    const sinceDate = new Date(since);
    if (isNaN(sinceDate.getTime())) {
      return NextResponse.json(
        { error: "Invalid 'since' parameter — must be a valid ISO timestamp" },
        { status: 400 },
      );
    }

    const labels = searchParams.getAll("label");
    const statusFilter = searchParams.get("status") ?? "closed";
    const field = searchParams.get("field") ?? "closed_at";

    if (field !== "closed_at" && field !== "updated_at") {
      return NextResponse.json(
        { error: "Invalid 'field' parameter — must be 'closed_at' or 'updated_at'" },
        { status: 400 },
      );
    }

    const projectPath = await getActiveProjectPath();

    let allIssues: BeadsIssue[];
    if (projectPath === ALL_PROJECTS_SENTINEL) {
      const paths = await getAllRepoPaths();
      const issueArrays = await Promise.all(
        paths.map((p) => readIssuesFromJSONL(p)),
      );
      allIssues = issueArrays.flat();
    } else {
      allIssues = await readIssuesFromJSONL(projectPath);
    }

    // Filter by status
    let filtered = allIssues.filter((i) => i.status === statusFilter);

    // Filter by timestamp field
    filtered = filtered.filter((i) => {
      const ts = field === "closed_at" ? i.closed_at : i.updated_at;
      if (!ts) return false;
      return new Date(ts) > sinceDate;
    });

    // Filter by labels (if any specified, issue must have ALL of them)
    if (labels.length > 0) {
      filtered = filtered.filter((i) =>
        labels.every((l) => i.labels?.includes(l) ?? false),
      );
    }

    // Sort by timestamp descending (newest first)
    filtered.sort((a, b) => {
      const aTs = field === "closed_at" ? a.closed_at : a.updated_at;
      const bTs = field === "closed_at" ? b.closed_at : b.updated_at;
      return (bTs ?? "").localeCompare(aTs ?? "");
    });

    // Map to minimal signal objects
    const signals = filtered.map((i) => ({
      id: i.id,
      title: i.title,
      status: i.status,
      labels: i.labels ?? [],
      closed_at: i.closed_at ?? null,
      close_reason: i.close_reason ?? null,
      epic: i.parent ?? null,
      updated_at: i.updated_at,
    }));

    return NextResponse.json({ signals, count: signals.length, since });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[API /api/signals]", message);
    if (message.includes("BEADS_PROJECT_PATH")) {
      return NextResponse.json(
        { error: "BEADS_PROJECT_PATH not configured", detail: message },
        { status: 503 },
      );
    }
    return NextResponse.json(
      { error: "Failed to fetch signals", detail: message },
      { status: 500 },
    );
  }
}
