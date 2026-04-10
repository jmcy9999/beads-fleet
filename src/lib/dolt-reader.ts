// =============================================================================
// Beads Fleet — Dolt Database Reader
// =============================================================================
//
// Reads issues directly from a Dolt server's MySQL-compatible interface.
// This is the preferred data source for Dolt-backed repos — no sync lag,
// no stale JSONL. Falls back gracefully if the Dolt server isn't running.
//
// Dolt server connection info comes from .beads/metadata.json (database name)
// and .beads/dolt-server.port (TCP port). User is always "root", no password.
// =============================================================================

import { promises as fs } from "fs";
import path from "path";
import { existsSync } from "fs";

import type { BeadsIssue, IssueDependency, Priority, IssueType, IssueStatus } from "./types";

interface DoltMetadata {
  database?: string;
  backend?: string;
  dolt_mode?: string;
  dolt_database?: string;
}

/**
 * Read all live issues from a Dolt server via MySQL protocol.
 * Returns null if Dolt is not configured, not running, or query fails.
 */
export async function readIssuesFromDolt(projectPath: string): Promise<BeadsIssue[] | null> {
  const metadataPath = path.join(projectPath, ".beads", "metadata.json");
  const portPath = path.join(projectPath, ".beads", "dolt-server.port");

  // Check if this is a Dolt-backed repo with a running server
  if (!existsSync(metadataPath) || !existsSync(portPath)) return null;

  let metadata: DoltMetadata;
  try {
    const raw = await fs.readFile(metadataPath, "utf-8");
    metadata = JSON.parse(raw) as DoltMetadata;
  } catch {
    return null;
  }

  if (metadata.backend !== "dolt" || !metadata.dolt_database) return null;

  let port: number;
  try {
    const portStr = await fs.readFile(portPath, "utf-8");
    port = parseInt(portStr.trim(), 10);
    if (isNaN(port)) return null;
  } catch {
    return null;
  }

  // Lazy-import mysql2 to avoid loading it for SQLite-only repos
  let mysql;
  try {
    mysql = await import("mysql2/promise");
  } catch {
    return null;
  }

  let conn;
  try {
    conn = await mysql.createConnection({
      host: "127.0.0.1",
      port,
      user: "root",
      database: metadata.dolt_database,
      connectTimeout: 3000,
    });

    // Read all non-deleted, non-tombstone issues with labels
    const [issueRows] = await conn.execute(`
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
        i.close_reason,
        i.notes,
        i.due_at,
        i.estimated_minutes
      FROM issues i
      LEFT JOIN labels l ON l.issue_id = i.id
      WHERE i.status <> 'tombstone'
      GROUP BY i.id
    `);

    // Read all dependencies
    const [depRows] = await conn.execute(`
      SELECT issue_id, depends_on_id, type, created_at, created_by
      FROM dependencies
    `);

    // Group dependencies by issue_id
    const depMap = new Map<string, IssueDependency[]>();
    for (const dep of depRows as Array<Record<string, string>>) {
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

    // Convert to BeadsIssue
    return (issueRows as Array<Record<string, unknown>>).map((row): BeadsIssue => ({
      id: row.id as string,
      title: row.title as string,
      description: (row.description as string) || undefined,
      status: row.status as IssueStatus,
      priority: row.priority as Priority,
      issue_type: row.issue_type as IssueType,
      owner: (row.owner as string) || undefined,
      labels: row.labels_csv ? (row.labels_csv as string).split(",") : undefined,
      dependencies: depMap.get(row.id as string),
      created_at: row.created_at as string,
      created_by: (row.created_by as string) || undefined,
      updated_at: row.updated_at as string,
      closed_at: (row.closed_at as string) || undefined,
      close_reason: (row.close_reason as string) || undefined,
      notes: (row.notes as string) || undefined,
      due_at: (row.due_at as string) || undefined,
      estimated_minutes: row.estimated_minutes as number ?? undefined,
    }));
  } catch {
    // Dolt server not reachable or query failed — fall back
    return null;
  } finally {
    if (conn) await conn.end();
  }
}
