OUTCOME: Implement `useEpicMarker(epicId, stage, repoPath, qaRound?): { marker, isStale, isLoading }` as a TanStack Query hook in `src/hooks/useEpicMarker.ts`. Fetches the marker via the route at 374.2. Implements stale-marker filter (ADR-005) and fail-degraded policy. Tests in `__tests__/components/useEpicMarker.test.tsx` (mirrors `useAttentionItems.test.tsx` location).

SCOPE:
- In: hook implementation; queryKey design with `repoPath` baked in; staleTime/refetchOnWindowFocus config; stale-marker filter; fail-degraded handling; tests.
- Out: any React component (374.5); any precedence interpretation (374.3 owns it); any direct fs imports (route is the only fs boundary).

FILES:
- NEW: src/hooks/useEpicMarker.ts
- NEW: __tests__/components/useEpicMarker.test.tsx

AC ITEMS TO VERIFY:
- Mounting fetches `/api/markers/[epicId]/[stage]?repoPath=<path>` and returns `{ marker, isStale: false, isLoading: false }` on success.
- queryKey includes BOTH `repoPath` AND `markerId` (cross-repo cache safety per architect Watch-fors + o4lx Risk 5).
- Stale-marker filter: `isStale = mapFleetStageToMarkerStage(currentStage) !== marker.stage` returns `{ marker: null, isStale: true }` when stage mismatches.
- QA exception: `qa-round-<N>` markers count as fresh on the QA stage.
- Fail-degraded: route 500 / fetch reject / malformed JSON → `{ marker: null, isStale: false, isLoading: false }`.
- a6o-defence test: epic with multiple `pipeline:*` labels + a marker for stage X matching `currentStage=X` → marker returned (not filtered).
- staleTime=30000, refetchOnWindowFocus=true.
- Tests use mocked `fetch` matching the route's response shape.

CONTEXT THE AGENT NEEDS:
- ADR-005 (in architect doc) is the rationale for stale-marker filtering belonging here, not in the component or route handler.
- Architect § Failure modes at integration seams documents the fail-degraded policy and why outage must not break operator capability.
- `src/hooks/useAttentionItems.ts` and `src/hooks/useResearchReport.ts` (if it exists; otherwise the closest TanStack Query hook in `src/hooks/`) are the patterns to mirror — read before coding.
- `deriveMarkerId` and `mapFleetStageToMarkerStage` from 374.1 are the inputs. Type-only import of `MarkerData` from `marker-reader.ts` is OK (erases at compile); runtime import is forbidden.

RISK FLAGS:
- Watch for omitting `repoPath` from the queryKey. Two epics in different repos with the same epicId-prefix would otherwise share a cache entry — a real risk per o4lx Risk 5 because the fleet has overlapping epic-id namespaces across repos. STOP and surface if you find yourself simplifying the queryKey to just `markerId`.
- Watch for the QA round special case. `qa-round-3` marker on QA stage MUST NOT be filtered as stale — the dashboard's `currentStage = qa` and the marker's `stage = qa` (the round is in the filename, not the stage field). If your `isStale` check mishandles this, AC #4 fails.
- Watch for the fail-degraded contract. `useQuery`'s `isError` should NOT propagate to the caller as a rendered error — the hook MUST return `marker: null` so the component falls through to default CTAs. The dashboard remains operable on outage. STOP and surface if any code path lets `isError` reach the consumer.
- Type-only imports vs runtime imports of `marker-reader.ts`: TypeScript's `import type { MarkerData }` is OK; `import { MarkerData }` (or anything that triggers a runtime resolution) will leak `fs` into the React tree and break `next build`. Verify with the type-only syntax.

MARKER REQUIREMENTS:
- Standard marker.
- Document under `whats_open` as FOLLOW-ON if `next build` was not run (only unit tests) — type-only imports must be verified by the build, not just by vitest.

COMMIT REQUIREMENTS:
- Single commit prefixed `beads_web-374.4: `.
- Subject: `beads_web-374.4: useEpicMarker TanStack Query hook with stale-marker filter`.
- Co-Authored-By trailer.
