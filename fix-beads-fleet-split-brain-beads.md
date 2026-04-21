# Fix beads-fleet split-brain — Bead Inventory

> Generated 2026-04-09. Tracks all beads for epic patchcycle-8d3.

## All Beads Created

| ID | Title | Status | Repo tracker | Correct repo? | Notes |
|----|-------|--------|-------------|---------------|-------|
| patchcycle-8d3 | [EPIC] beads-fleet cannot see new bd v0.62.0 issues (split-brain: Dolt vs SQLite) | in_progress | PatchCycle | Yes | Cross-repo epic, PatchCycle is the affected project |
| patchcycle-8d3.2 | Migrate 847 SQLite-only issues into Dolt | **closed** | PatchCycle | Yes | PatchCycle data migration. Done. |
| patchcycle-8d3.3 | Add dolt-reader.ts to beads-fleet (mysql2 reader) | open | PatchCycle | **No — should be beads_web** | Code lives in beads_web src/lib/ |
| patchcycle-8d3.4 | Wire Dolt reader into beads-fleet fallback chain | open | PatchCycle | **No — should be beads_web** | Code lives in beads_web src/lib/ and src/app/api/ |
| patchcycle-8d3.5 | Verify fix end-to-end: all 1054 issues visible on board | open | PatchCycle | Partially | Cross-repo verification — tests PatchCycle data via beads_web UI. Fine in PatchCycle but depends on beads_web work. |

## Beads to Create in beads_web

beads_web's tracker is currently broken (bd v0.62.0 expects Dolt but the database wasn't migrated — `metadata.json` still says `beads.db`). These beads should be created once the tracker is fixed.

### 1. Add Dolt reader module

- **Title:** Add dolt-reader.ts — mysql2-based reader for Dolt-backed projects
- **Type:** task
- **Priority:** P0
- **Description:** Create `src/lib/dolt-reader.ts` in beads_web. Exports: `readIssuesFromDolt(projectPath)`, `readCommentsFromDolt(projectPath, issueId)`, `checkIssueInDolt(projectPath, issueId)`. Detects Dolt backend from `.beads/metadata.json` (`backend === "dolt"`). Reads port from `.beads/dolt-server.port`. Connects via `mysql2/promise` pool (max 3 connections, 5s timeout). DB name from `metadata.json` field `dolt_database`. Normalises Dolt datetime to ISO 8601. Returns `null` if Dolt unavailable (graceful fallback). `mysql2` is already in `package.json`.
- **AC:**
  - Module compiles with `npm run build`
  - Exports match `BeadsIssue[]` / `BeadsComment[]` types
  - Returns `null` when Dolt server is down
  - Returns `null` when `metadata.json` doesn't specify Dolt backend
- **Branch:** `feature/dolt-reader`
- **Corresponds to:** patchcycle-8d3.3 (close that when this is created)

### 2. Wire Dolt reader into fallback chain

- **Title:** Wire Dolt reader into beads-fleet read path (Dolt > SQLite > JSONL)
- **Type:** task
- **Priority:** P0
- **Description:** Three files to modify:
  1. `src/lib/jsonl-fallback.ts` — change `readIssuesFromJSONL()` to try `readIssuesFromDolt()` first, then `readIssuesFromDB()` (SQLite), then JSONL file.
  2. `src/lib/repo-config.ts` — update `findRepoForIssue()` to check Dolt-backed repos via `checkIssueInDolt()`. For each repo, read `metadata.json` — if Dolt, query Dolt. Otherwise existing SQLite check.
  3. `src/app/api/issues/[id]/comments/route.ts` — GET handler directly reads from SQLite. Add Dolt path: check `metadata.json`, if Dolt call `readCommentsFromDolt()`, else existing SQLite path.
- **AC:**
  - Dolt-backed projects (PatchCycle) serve issues from Dolt
  - SQLite-backed projects (CycleKit) serve from SQLite unchanged
  - Comments load for both backends
  - `metadata.json` missing or malformed falls through gracefully
  - `npm run build` passes
- **Branch:** `feature/dolt-reader`
- **Depends on:** Dolt reader module (bead 1 above)
- **Corresponds to:** patchcycle-8d3.4 (close that when this is created)

### 3. (Optional) Fix beads_web's own tracker

- **Title:** Fix beads_web bd tracker — migrate from SQLite to Dolt
- **Type:** bug
- **Priority:** P2
- **Description:** beads_web's `.beads/metadata.json` says `"database": "beads.db"` but bd v0.62.0 expects Dolt. Running any `bd` command fails with "database 'beads' not found on Dolt server". Follow `docs/beads-dolt-migration-guide.md` in PatchCycle repo to migrate. This blocks creating beads in the beads_web tracker.

## Beads Not Yet Assigned to a Repo

None — all remaining work is in beads_web (beads 1 and 2 above) or cross-repo verification (patchcycle-8d3.5, staying in PatchCycle).

## Summary

- **Total beads:** 5 in PatchCycle tracker + 2-3 to create in beads_web
- **Closed:** 1 (patchcycle-8d3.2, migration)
- **Open in PatchCycle:** 3 (epic + 2 that should move to beads_web + 1 verification)
- **Blocked:** beads_web tracker is broken, so beads_web beads can't be created yet
- **Next step:** Fix beads_web tracker, create beads there, close the corresponding PatchCycle placeholders (patchcycle-8d3.3 and .4)
