// =============================================================================
// Beads Fleet — Marker Reader
// =============================================================================
//
// Centralized marker-reading logic. Reads and parses marker files from
// <repoPath>/.beads/markers/<markerId>.json.
//
// Previously marker-reading was inline at QA dispatch sites (mejh commit
// 931d8e2). This module centralizes the logic for reuse across
// detectAgentDone, dispatchChainAction, and reconciler rules.
//
// Design source: factory-core-o4lx architect memo section 5 + 10 Bead 2.
// Schema: factory-core/docs/architecture/marker-schema.md (commit ed9d3b4).
//
// Error handling (loose schema per o4lx memo section 4 Q2):
//   - Missing file -> return null (no throw).
//   - Malformed JSON -> return null + log warning (no throw).
//   - Valid JSON but missing required fields -> return null + log warning.
//   - Valid JSON with extra fields -> preserve all fields (forward compat).
// =============================================================================

import { promises as fs } from "fs";
import path from "path";

/**
 * Marker data structure covering all schema fields.
 *
 * Required + optional + routing-aware per factory-core-o4lx.1 schema doc
 * (marker-schema.md). Uses index signature for forward compatibility
 * (loose schema discipline — preserves extra fields without validation).
 */
export interface MarkerData {
  // Required (6 fields per marker-schema.md Required fields)
  version: string;
  bead_id?: string; // per-bead agents
  epic_id?: string; // epic-scope agents
  status: "success" | "failure" | "needs-decision" | "blocked";
  stage: string;
  started_at: string; // ISO-8601
  exited_at: string; // ISO-8601

  // Strongly encouraged (4 fields per marker-schema.md Strongly encouraged)
  what_was_done?:
    | string
    | Array<{ action: string; result: string; evidence: string }>;
  what_was_tested?: string;
  deviations_from_ac?: string;
  recommendation_for_next?: string;

  // Optional
  surprises_or_findings?: string;
  whats_open?: string[];
  ac_items_NOT_verified?: string;

  // Routing-aware (optional, per factory-core-o4lx.1 schema extension)
  next_agent?: string;
  blocker_class?: string;
  dispatch_context?: Record<string, unknown>;

  // QA-specific (per mejh/0kkt)
  verdict?: string;
  open_bugs?: number;

  // Allow extra fields (loose schema per umbrella memo section 4 Q2)
  [key: string]: unknown;
}

/**
 * Read and parse a marker file for a given bead/epic.
 *
 * @param repoPath - Absolute path to the repo
 *   (e.g., /Users/janemckay/dev/claude_projects/beads_web)
 * @param markerId - Bead ID or epic-stage identifier
 *   (e.g., "beads_web-28k" or "factory-core-o4lx-planner")
 * @returns Parsed marker data, or null if file missing/unparseable/invalid.
 *
 * Error handling (loose schema per o4lx memo section 4 Q2):
 * - Missing file: return null (AC 3).
 * - Malformed JSON: return null + log warning (AC 4).
 * - Valid JSON but missing required fields: return null + log warning (AC 5).
 * - Valid JSON with extra fields: preserve all fields (loose schema discipline).
 */
export async function readMarker(
  repoPath: string,
  markerId: string,
): Promise<MarkerData | null> {
  const markerPath = path.join(
    repoPath,
    ".beads",
    "markers",
    `${markerId}.json`,
  );

  try {
    const content = await fs.readFile(markerPath, "utf-8");
    const parsed = JSON.parse(content);

    // beads_web-poh.20 — best-effort timestamp override per marker-protocol §1
    // and marker-schema.md ADR-002. Agents do NOT author started_at / exited_at;
    // orchestrator stamps them at ingest. When the agent-written value is null
    // or missing, fall back to the marker file's mtime (the atomic *.tmp →
    // *.json rename guarantees mtime reflects the moment writing finished).
    // Yields zero duration on the orphan path; honest signal for downstream
    // filtering rather than a fabricated value.
    if (!parsed.started_at || !parsed.exited_at) {
      try {
        const stat = await fs.stat(markerPath);
        const mtimeIso = stat.mtime.toISOString();
        if (!parsed.started_at) parsed.started_at = mtimeIso;
        if (!parsed.exited_at) parsed.exited_at = mtimeIso;
      } catch {
        // stat failed — fall through to validation, which will reject
      }
    }

    // Validate required fields (AC 5)
    if (!parsed.version) {
      console.warn(
        `[marker-reader] Missing required field 'version' in ${markerPath}`,
      );
      return null;
    }
    if (!parsed.status) {
      console.warn(
        `[marker-reader] Missing required field 'status' in ${markerPath}`,
      );
      return null;
    }
    // At least one of bead_id or epic_id must be present
    if (!parsed.bead_id && !parsed.epic_id) {
      console.warn(
        `[marker-reader] Missing both 'bead_id' and 'epic_id' in ${markerPath}`,
      );
      return null;
    }
    if (!parsed.stage) {
      console.warn(
        `[marker-reader] Missing required field 'stage' in ${markerPath}`,
      );
      return null;
    }
    if (!parsed.started_at) {
      console.warn(
        `[marker-reader] Missing required field 'started_at' in ${markerPath}`,
      );
      return null;
    }
    if (!parsed.exited_at) {
      console.warn(
        `[marker-reader] Missing required field 'exited_at' in ${markerPath}`,
      );
      return null;
    }

    // Loose schema — preserve all fields including extras
    return parsed as MarkerData;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // Missing file — silent return null (AC 3)
      return null;
    }
    if (err instanceof SyntaxError) {
      // Malformed JSON (AC 4)
      console.warn(
        `[marker-reader] Malformed JSON in ${markerPath}: ${err.message}`,
      );
      return null;
    }
    // Unexpected error — log and return null
    console.warn(
      `[marker-reader] Unexpected error reading ${markerPath}: ${err}`,
    );
    return null;
  }
}
