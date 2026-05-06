/**
 * Type contracts for the dashboard's "Close Epic" CTA pipeline.
 *
 * Owned by:
 * - Bead: factory-core-niii.6.2
 * - Architecture: docs/research/follow-on-niii-dashboard-close-epic-architecture.md
 *   (§ Data Model, lines 79-167) in the fleet-core repo.
 *
 * Pure types + a single runtime constant. NO framework imports — this file
 * must remain isomorphic so both the server-side runner (niii.6.3) and the
 * client-side panel (niii.6.5) can consume it.
 *
 * MIRROR of the JSON contract emitted by `tools/generic/epic-close-gate.sh --json`
 * (the script is bash; this is its TypeScript shadow). Keep in sync with the
 * script. The sync is verified by the integration assertion in niii.6.3.
 */

/**
 * Schema version for the JSON envelope emitted by `epic-close-gate.sh --json`.
 *
 * The runner in niii.6.3 asserts `output.version === GATE_JSON_VERSION` and
 * fails closed otherwise. Bumping this constant is a breaking change for the
 * runner — coordinate with the script author before changing.
 */
export const GATE_JSON_VERSION = "1";

/**
 * Categorisation of why a gate refused to close. Used by the route handler to
 * pick a UI affordance (the dashboard renders different copy + CTAs per
 * category) without forcing the React layer to inspect the raw `blocked`
 * arrays.
 *
 *  - "checklist":         checklistFailures non-empty (and others empty).
 *  - "parent-open":       parentOpenChildren non-empty (and others empty).
 *  - "label-open":        labelOpenChildren non-empty (and others empty).
 *  - "unreachable-repos": unreachableRepos non-empty (some indeterminate; treat as soft-block).
 *  - "multiple":          more than one of the above non-empty (the UI shows a combined panel).
 */
export type GateBlockedReason =
  | "checklist"
  | "parent-open"
  | "label-open"
  | "unreachable-repos"
  | "multiple";

/**
 * The shape `epic-close-gate.sh --json` emits to stdout. This is the
 * integration contract between the script and the route handler. **Schema is
 * owned by the script** (it is bash; this TS interface is a mirror that must
 * be kept in sync via tests).
 */
export interface GateJsonOutput {
  /** Schema version. Must be "1" for this design. Bump for breaking changes. */
  version: "1";
  /** Epic id the gate ran against. Echoed for debugging; never trust over the request. */
  epicId: string;
  /** Detected ship-type label (or "generic" if none). */
  shipType: string;
  /**
   * Outcome of the gate. Mirrors exit codes:
   *   - "passed":  exit 0; epic closed (or --force succeeded). bd close was invoked.
   *   - "blocked": exit 1; epic remains open. Notes appended.
   *   - "invalid": exit 2; argument error or non-epic target. No state mutation.
   *   - "error":   exit code != 0/1/2 (subprocess crash). No JSON; route synthesises this case.
   */
  outcome: "passed" | "blocked" | "invalid" | "error";
  /** True if this run was --force. The gate appends an audit-trail note before closing. */
  forced: boolean;
  /**
   * The reason argument passed through to bd close (if any), echoed for the dashboard's
   * confirmation toast. Empty string when not provided.
   */
  reason: string;
  /**
   * Per-gate failures. Empty arrays when outcome != "blocked". Always present (never
   * undefined) so consumers don't NPE on optional access.
   */
  blocked: {
    /** Checklist items that failed (e.g., "Lessons-learned file not committed"). */
    checklistFailures: string[];
    /** --parent children still open ("factory-core-xyz"). */
    parentOpenChildren: string[];
    /** label-children still open across registered repos ("repo-name:bead-id"). */
    labelOpenChildren: string[];
    /** Repos that could not be queried (path or "config missing"). */
    unreachableRepos: string[];
  };
  /**
   * Human-readable diagnostic message. For "invalid" or "error" cases, this is the
   * primary surface (e.g., "EPIC_ID has issue_type=task, not epic"). For "blocked"
   * it is a short summary; the structured `blocked` arrays are the operative data.
   */
  message: string;
}

/**
 * The shape the route returns to the React client. Discriminated union to
 * enforce exhaustive switching in the UI (regression #7: type confusion on
 * enum branching). DO NOT add a `default:` case in consumers — that defeats
 * the exhaustiveness check.
 *
 * The route always responds with HTTP 200 carrying one of these four kinds
 * (matching the dashboard's existing convention for action endpoints — see
 * `case "deprioritise"`; gate-blocked is not an HTTP error). HTTP 4xx/5xx
 * are reserved for transport-layer failures (malformed request body, server
 * crash before subprocess spawn).
 */
export type CloseEpicGateResult =
  | {
      kind: "passed";
      epicId: string;
      forced: boolean;
      reason: string;
      /** "Epic factory-core-xyz closed." */
      message: string;
    }
  | {
      kind: "blocked";
      epicId: string;
      blockedReason: GateBlockedReason;
      blocked: GateJsonOutput["blocked"];
      message: string;
      // The complete JSON output is intentionally NOT forwarded to the client.
      // The UI gets only the structured fields it renders, which keeps the
      // contract surface narrow.
    }
  | {
      kind: "invalid";
      epicId: string;
      /** e.g., "factory-core-xyz is not an epic" */
      message: string;
    }
  | {
      kind: "error";
      epicId: string;
      /** e.g., "epic-close-gate.sh exited with code 137 (SIGKILL)" */
      message: string;
      // Server-only diagnostics (stderr tail, exit code) are logged but not
      // returned. The UI shows a generic retry affordance.
    };
