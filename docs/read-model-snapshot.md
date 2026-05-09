# Read Model Snapshot

## Purpose

`src/lib/read-model-snapshot.ts` is the fast read boundary for dashboard and polling routes. It reads each repo's Dolt issue data once per cache window, normalizes it into existing `RobotPlan` responses, and shares the same portfolio snapshot across hot endpoints such as `/api/issues`, `/api/fleet/wave-status`, `/api/signals`, and `/api/cross-repo/list`.

This layer does not replace the command side. Pipeline dispatch, precondition checks, agent launch, and issue mutations still use the existing live paths.

## Interfaces

- `getRepoReadSnapshot(repoPath)` returns `{ repoPath, repoName, issues, plan, generatedAt, refreshDurationMs }`.
- `getPortfolioReadSnapshot(repoPaths)` returns `{ repoPaths, repos, issues, plan, offline_repos, generatedAt, refreshDurationMs }`.
- `invalidateReadModelSnapshots(scope?)` clears snapshots after mutations. It is called from `bv-client.invalidateCache()` so existing mutation routes keep one invalidation surface.

`plan` is still the existing `RobotPlan` shape. No public route fields are removed or renamed.

## Cache Semantics

- Fresh TTL defaults to 15 seconds (`BEADS_READ_MODEL_TTL_MS` override).
- Stale window defaults to 5 minutes (`BEADS_READ_MODEL_STALE_MS` override).
- Concurrent cold reads single-flight onto one refresh per snapshot key.
- Dashboard reads may receive stale data while a background refresh is running.
- If refresh fails inside the stale window, the previous snapshot is served.
- In-flight refreshes cannot repopulate the cache after invalidation.

## Boundaries

- Uses `dolt-reader.ts` for raw issue reads and `plan-builder.ts` for existing `RobotPlan` conversion.
- Does not call `bv`; graph/priority/diff analytics remain behind `bv-client.ts`.
- Does not drive command or precondition decisions where stale reads would be unsafe.
- The startup bead-ID collision scan reads through the portfolio snapshot so boot diagnostics do not create a second `bv --robot-plan` fan-out.
