OUTCOME: Add a Next.js Node-runtime API route at `src/app/api/markers/[epicId]/[stage]/route.ts` that GETs a marker by `(epicId, stage)` URL params + `repoPath` query string, validates inputs and the repo whitelist, then wraps the existing `readMarker(repoPath, markerId)` from `src/lib/marker-reader.ts`. Returns `200 { marker: MarkerData | null }` or `400` on validation failure. Tests in `__tests__/api/markers-route.test.ts`.

SCOPE:
- In: GET handler; input validation regex + closed-set checks; `getAllRepoPaths()` whitelist enforcement; runtime declarations; tests.
- Out: any modification to `marker-reader.ts` or `repo-config.ts`; any caching (TanStack Query handles it client-side per 374.4); per-bead marker reads (out of scope for the whole epic per ADR-006).

FILES:
- NEW: src/app/api/markers/[epicId]/[stage]/route.ts
- NEW: __tests__/api/markers-route.test.ts

AC ITEMS TO VERIFY:
- Valid request + existing marker → 200 `{ marker: MarkerData }`.
- Valid request + missing file → 200 `{ marker: null }` (NOT 404 — null is a valid value per architect's Interface Contracts table).
- Valid request + malformed JSON → 200 `{ marker: null }` (readMarker handles it; route does not surface).
- `repoPath` not in `getAllRepoPaths()` whitelist → 400.
- `epicId` failing `/^[a-zA-Z0-9_.-]+$/` → 400.
- `stage` not in the closed FleetStage / marker-stage-suffix set → 400.
- Route file declares `export const runtime = "nodejs"` AND `export const dynamic = "force-dynamic"`.
- `next build` succeeds (no Edge Runtime build error).
- Tests use mocked `fs.readFile` + mocked `getAllRepoPaths` returning a whitelist fixture (mocking pattern matches existing API route tests in `__tests__/api/`).

CONTEXT THE AGENT NEEDS:
- Architect doc § Security Architecture is the canonical threat model — read before validating inputs.
- ADR-002 (in the architect doc) explains why Node runtime + dynamic are required.
- `code-principles.md` § Next.js Edge Runtime Constraints cites the `beads_web-8wh` regression — `fs/promises` is unresolvable at edge build time, the build fails. Read before coding.
- `/api/research/[appName]` is the closest pattern in the codebase — its route handler + tests are the precedent. Mirror its security posture.
- `src/lib/marker-reader.ts` exports `readMarker` and `MarkerData`. Do NOT re-implement.
- `src/lib/repo-config.ts:138` exports `getAllRepoPaths(): Promise<string[]>`. Do NOT cache or shadow it.

RISK FLAGS:
- Watch for path traversal: `path.join(repoPath, ".beads", "markers", "<markerId>.json")` is safe ONLY AFTER repoPath is whitelisted AND epicId/stage are validated. Do NOT skip the whitelist; an attacker-controlled repoPath query string could otherwise read any file the server process can access. STOP and surface if the whitelist behaviour is ambiguous (e.g., what if `getAllRepoPaths` returns an empty list?).
- Watch for the Edge Runtime trap: any import path that pulls `fs` into a non-Node-runtime callsite will fail `next build`. Verify by running the build, not just unit tests. Per regression `beads_web-8wh`.
- Do NOT return 404 for missing markers. Null is a valid value per the Interface Contracts table — the hook (374.4) uses null to fall through to default CTAs. A 404 would surface as an error in TanStack Query and trigger the fail-degraded path unnecessarily.

MARKER REQUIREMENTS:
- Standard marker.
- If `next build` was not run (only unit tests), document under `whats_open` as FOLLOW-ON: verify build passes — never claim AC #9 is satisfied without running the build.
- If you discover any `fs` import path that leaks into the React tree (e.g., a transitive import through a shared util), document as EDGE-RUNTIME-LEAK with the import chain.

COMMIT REQUIREMENTS:
- Single commit prefixed `beads_web-374.2: `.
- Subject: `beads_web-374.2: Node-runtime API route /api/markers/[epicId]/[stage]`.
- Co-Authored-By trailer.
