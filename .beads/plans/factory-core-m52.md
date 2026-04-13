# Dolt Reader for beads_web — Build Plan

**Date:** 2026-04-13
**Epic (fleet-core):** factory-core-m52
**Ship type:** internal
**Based on:** fleet-core docs/research/beads-visibility.md

## Approach

Replace beads_web's SQLite/JSONL reading with a Dolt-only reader. Every repo is now on Dolt. There is no fallback chain — Dolt is the single source of truth. If the Dolt server isn't running, surface an error rather than showing stale data from a legacy database. A lying dashboard is worse than no dashboard (internal guardrail 2).

## Current Data Path (being replaced)

```
readIssuesFromJSONL(projectPath)
  1. Try SQLite: readIssuesFromDB(projectPath)     → .beads/beads.db
  2. Fall back to JSONL: read .beads/issues.jsonl
```

## New Data Path

```
readIssuesFromDolt(projectPath)
  1. Read Dolt server port from .beads/dolt-server.port
  2. Read database name from .beads/metadata.json
  3. Connect via mysql2 to 127.0.0.1:<port>
  4. Query issues + labels + dependencies
  5. If Dolt not available: return error (not stale data)
```

No SQLite fallback. No JSONL fallback. Dolt only.

## Implementation Details

### New file: src/lib/dolt-reader.ts

**Discovers the Dolt server for a repo by reading:**
- `.beads/dolt-server.port` — the MySQL port
- `.beads/metadata.json` — the `dolt_database` field (database name)

**Connects via mysql2** (already in dependencies, version ^3.20.0) to `127.0.0.1:<port>`.

**Issues query** (must match sqlite-reader.ts lines 68-91 exactly):
```sql
SELECT i.id, i.title, i.description, i.status, i.priority, i.issue_type, i.owner,
       GROUP_CONCAT(l.label) as labels_csv,
       i.created_at, i.created_by, i.updated_at, i.closed_at, i.close_reason,
       i.notes, i.due_at, i.estimated_minutes
FROM issues i
LEFT JOIN labels l ON l.issue_id = i.id
WHERE i.status <> 'tombstone'
GROUP BY i.id
```

**Note:** Dolt schema has no `deleted_at` column (verified in fleet-core). Do NOT add `deleted_at IS NULL` — that was the filter mismatch that caused the reverted attempt.

**Dependencies query:**
```sql
SELECT issue_id, depends_on_id, type, created_at, created_by
FROM dependencies
```

**Returns** `BeadsIssue[]` — throws if Dolt server not available (caller shows error, not stale data).

### Modified file: src/lib/jsonl-fallback.ts

**Replace readIssuesFromJSONL** with a call to `readIssuesFromDolt`. The function name may change (it's no longer reading JSONL), but callers like `getPlan()` in bv-client.ts must still work. Options:
- Rename to `readIssues(projectPath)` and update callers
- Or keep the name and swap the implementation

sqlite-reader.ts and the JSONL reading code become dead code — can be removed or left for now.

### Tests

- Unit test: mock mysql2 connection, verify query matches expected SQL
- Integration test: point at a real Dolt server (fleet-core port 57619), verify count matches `bd list`
- Error test: verify clear error returned when Dolt server not running (not stale data)

## Beads (in beads_web repo)

| # | Title | Priority | Test Strategy | Depends On |
|---|-------|----------|---------------|------------|
| 1 | Create src/lib/dolt-reader.ts | P1 | Unit test with mocked mysql2. Query must match sqlite-reader.ts WHERE clause (minus deleted_at). | — |
| 2 | Replace SQLite/JSONL reading with Dolt reader | P1 | readIssues returns Dolt data. Clear error when Dolt unavailable (not stale data). | 1 |
| 3 | Integration test: verify fleet-core count | P1 | Dashboard API returns all_issues count matching bd list for fleet-core | 2 |
| 4 | Full verification: all repos match bd list | P1 | Per-repo counts from dashboard API match bd list --status=all for every repo. Total must reach 2,515. | 3 |

## Rollback Plan

Git revert the commit. SQLite/JSONL code still exists in git history and can be restored if needed.

## Definition of Done

1. beads_web reads from Dolt only — no SQLite, no JSONL
2. Dashboard shows fleet-core issues without manual bd export
3. Per-repo counts match bd list output
4. Total across all repos reaches 2,515
5. Existing tests still pass (npx jest --no-cache)
6. Clear error shown when Dolt server is unavailable (not stale data)
