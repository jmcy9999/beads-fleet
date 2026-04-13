// =============================================================================
// Beads Fleet — Dolt Database Reader
// =============================================================================
//
// Reads issues directly from a repo's Dolt MySQL server. Every repo is on Dolt
// as of 2026-04-13. This is the primary (and only) data reader — there is no
// fallback to SQLite or JSONL. If the Dolt server isn't running, this throws
// rather than returning stale data.
//
// Connection details come from the repo's .beads/ directory:
//   - .beads/dolt-server.port  → MySQL port
//   - .beads/metadata.json     → dolt_database field (database name)
//
// See fleet-core standards/platforms/internal/development.md "Dolt Server
// Structure" for the directory layout.
// =============================================================================

import * as mysql from "mysql2/promise";
import * as path from "path";
import { readFileSync, existsSync } from "fs";

import type { BeadsIssue, IssueDependency, Priority, IssueType, IssueStatus } from "./types";

interface DoltIssueRow {
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
  notes: string | null;
  due_at: string | null;
  estimated_minutes: number | null;
  story_points: number | null;
}

interface DoltDepRow {
  issue_id: string;
  depends_on_id: string;
  type: string;
  created_at: string;
  created_by: string;
}

/**
 * Read the Dolt server port for a project.
 * Returns null if no port file exists (repo not on Dolt or server not started).
 */
function getDoltPort(projectPath: string): number | null {
  const portFile = path.join(projectPath, ".beads", "dolt-server.port");
  if (!existsSync(portFile)) return null;
  const port = parseInt(readFileSync(portFile, "utf-8").trim(), 10);
  return isNaN(port) ? null : port;
}

/**
 * Read the Dolt database name from metadata.json.
 * Falls back to the repo directory name if not specified.
 */
function getDoltDatabase(projectPath: string): string {
  const metaFile = path.join(projectPath, ".beads", "metadata.json");
  if (existsSync(metaFile)) {
    try {
      const meta = JSON.parse(readFileSync(metaFile, "utf-8"));
      if (meta.dolt_database) return meta.dolt_database;
    } catch {
      // Fall through to default
    }
  }
  return path.basename(projectPath);
}

/**
 * Discover which optional columns exist in the issues table.
 * Different repos may have different schema versions.
 */
async function getOptionalColumns(
  conn: mysql.Connection,
): Promise<Set<string>> {
  const [rows] = await conn.query("SHOW COLUMNS FROM issues");
  return new Set((rows as Array<{ Field: string }>).map((r) => r.Field));
}

/**
 * Read all live issues from a repo's Dolt server.
 *
 * Throws if the Dolt server is not available — callers should surface the
 * error rather than falling back to stale data.
 */
export async function readIssuesFromDolt(
  projectPath: string,
): Promise<BeadsIssue[]> {
  const port = getDoltPort(projectPath);
  if (port === null) {
    throw new Error(
      `No Dolt server port found for ${projectPath}. ` +
        `Expected .beads/dolt-server.port to exist. ` +
        `Run any bd command in the repo to auto-start the server.`,
    );
  }

  const database = getDoltDatabase(projectPath);

  const conn = await mysql.createConnection({
    host: "127.0.0.1",
    port,
    user: "root",
    database,
    // Short timeout — if server is down, fail fast
    connectTimeout: 3000,
  });

  try {
    // Check which optional columns exist
    const columns = await getOptionalColumns(conn);
    const hasStoryPoints = columns.has("story_points");
    const hasNotes = columns.has("notes");
    const hasDueAt = columns.has("due_at");
    const hasEstimatedMinutes = columns.has("estimated_minutes");

    // Read all non-tombstone issues with labels
    // NOTE: Dolt schema has no deleted_at column. Do NOT add deleted_at IS NULL.
    const issueQuery = `
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
        ${hasEstimatedMinutes ? ", i.estimated_minutes" : ""}
      FROM issues i
      LEFT JOIN labels l ON l.issue_id = i.id
      WHERE i.status <> 'tombstone'
      GROUP BY i.id
    `;

    const [issueRows] = await conn.query(issueQuery);
    const rows = issueRows as DoltIssueRow[];

    // Read all dependencies
    const [depRows] = await conn.query(
      "SELECT issue_id, depends_on_id, type, created_at, created_by FROM dependencies",
    );
    const deps = depRows as DoltDepRow[];

    // Group dependencies by issue_id
    const depMap = new Map<string, IssueDependency[]>();
    for (const dep of deps) {
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
    return rows.map(
      (row): BeadsIssue => ({
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
        estimated_minutes: row.estimated_minutes ?? undefined,
      }),
    );
  } finally {
    await conn.end();
  }
}
