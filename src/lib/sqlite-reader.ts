// =============================================================================
// Beads Fleet — SQLite Database Reader
// =============================================================================
//
// Reads issues directly from .beads/beads.db (the source of truth) using
// better-sqlite3. This replaces the JSONL fallback as the primary data source
// when bv CLI is unavailable.
//
// The JSONL file is only a sync export artifact and may be stale or incomplete.
// The SQLite database always has the full issue set.
// =============================================================================

import Database from "better-sqlite3";
import path from "path";
import { existsSync } from "fs";

import type { BeadsIssue, IssueDependency, Priority, IssueType, IssueStatus } from "./types";

interface IssueRow {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: number;
  issue_type: string;
  owner: string | null;
  labels_csv: string | null;
  created_at: string;
  created_by: string | null;
  updated_at: string;
  closed_at: string | null;
  close_reason: string | null;
  story_points: number | null;
  notes: string | null;
  due_at: string | null;
}

interface DepRow {
  issue_id: string;
  depends_on_id: string;
  type: string;
  created_at: string;
  created_by: string;
}

/**
 * Read all live issues from the beads SQLite database.
 * Returns null if the database doesn't exist (caller should fall back to JSONL).
 */
export function readIssuesFromDB(projectPath: string): BeadsIssue[] | null {
  const dbPath = path.join(projectPath, ".beads", "beads.db");
  if (!existsSync(dbPath)) return null;

  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });

    // Check which optional columns exist (schema varies across beads versions)
    const columns = db.prepare("PRAGMA table_info(issues)").all() as { name: string }[];
    const columnNames = new Set(columns.map((c) => c.name));
    const hasStoryPoints = columnNames.has("story_points");
    const hasNotes = columnNames.has("notes");
    const hasDueAt = columnNames.has("due_at");

    // Read all non-deleted, non-tombstone issues
    const issueStmt = db.prepare(`
      SELECT
        i.id,
        i.title,
        i.description,
        i.status,
        i.priority,
        i.issue_type,
        i.owner,
        GROUP_CONCAT(l.label) as labels_csv,
        i.created_at,
        i.created_by,
        i.updated_at,
        i.closed_at,
        i.close_reason
        ${hasStoryPoints ? ", i.story_points" : ""}
        ${hasNotes ? ", i.notes" : ""}
        ${hasDueAt ? ", i.due_at" : ""}
      FROM issues i
      LEFT JOIN labels l ON l.issue_id = i.id
      WHERE i.deleted_at IS NULL AND i.status <> 'tombstone'
      GROUP BY i.id
    `);

    const rows = issueStmt.all() as IssueRow[];

    // Read all dependencies in one query
    const depStmt = db.prepare(`
      SELECT issue_id, depends_on_id, type, created_at, created_by
      FROM dependencies
    `);
    const depRows = depStmt.all() as DepRow[];

    // Group dependencies by issue_id
    const depMap = new Map<string, IssueDependency[]>();
    for (const dep of depRows) {
      if (!depMap.has(dep.issue_id)) {
        depMap.set(dep.issue_id, []);
      }
      depMap.get(dep.issue_id)!.push({
        issue_id: dep.issue_id,
        depends_on_id: dep.depends_on_id,
        type: dep.type as "blocks",
        created_at: dep.created_at,
        created_by: dep.created_by,
      });
    }

    // Convert rows to BeadsIssue
    return rows.map((row): BeadsIssue => ({
      id: row.id,
      title: row.title,
      description: row.description || undefined,
      status: row.status as IssueStatus,
      priority: row.priority as Priority,
      issue_type: row.issue_type as IssueType,
      owner: row.owner || undefined,
      labels: row.labels_csv ? row.labels_csv.split(",") : undefined,
      dependencies: depMap.get(row.id),
      created_at: row.created_at,
      created_by: row.created_by || undefined,
      updated_at: row.updated_at,
      closed_at: row.closed_at || undefined,
      close_reason: row.close_reason || undefined,
      story_points: row.story_points ?? undefined,
      notes: row.notes || undefined,
      due_at: row.due_at || undefined,
    }));
  } catch {
    // If anything fails reading SQLite, return null so caller falls back
    return null;
  } finally {
    if (db) db.close();
  }
}
