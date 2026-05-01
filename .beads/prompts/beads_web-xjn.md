OUTCOME: Add the cross-repo enumeration mechanism: a Next.js route at /api/cross-repo/list that wraps the existing `getAllProjectsPlan` aggregator with label filtering, plus a thin CLI wrapper script `bd-cross-repo.ts` that planner/agents invoke to query it.

SCOPE:
- In: the new route (route.ts), its unit test (route.test.ts), the CLI wrapper script. Reuses `getAllProjectsPlan` from src/lib/bv-client.ts:815 — zero new Dolt connections.
- Out: changes to bv-client.ts itself (the aggregator is battle-tested; reuse as-is), planner.md prose updates (A.5 territory).

FILES:
- NEW: beads_web-improved/src/app/api/cross-repo/list/route.ts
- NEW: beads_web-improved/src/app/api/cross-repo/list/route.test.ts
- NEW: beads_web-improved/scripts/bd-cross-repo.ts

AC ITEMS TO VERIFY:
1. Route at `/api/cross-repo/list` accepts query params `label` (required) and `status` (optional: open/closed/all, default open).
2. Returns 400 with explicit error message if `label` is missing or empty.
3. Calls `getAllProjectsPlan(getAllRepoPaths())` (reuses the existing aggregator at bv-client.ts:815). No new Dolt connections.
4. Filters returned issues by EXACT label match: `issue.labels?.includes(label)`. Substring match is forbidden — `?label=epic:factory-core-so7` MUST NOT match issues carrying `epic:factory-core-so74`.
5. Each returned issue has a `.repo` top-level field, derived from the existing `project:<repoName>` label that `getAllProjectsPlan` adds (bv-client.ts:836-840). Strip the `project:` prefix when promoting.
6. CLI script at `scripts/bd-cross-repo.ts` accepts `--label=<label>` (required) and `--status=<open|closed|all>` (optional). Reads `BEADS_WEB_URL` env var (default `http://localhost:3000`). Fetches the route, prints JSON to stdout on success (exit 0). On orchestrator unreachable, exits 1 with error message including the attempted URL.
7. Unit tests pass:
   7a. Label-filter precision: a test fixture containing two issues, one labelled `epic:factory-core-so74` and one labelled `epic:factory-core-so7`, returns ONLY the so74 issue when filtered by `?label=epic:factory-core-so74`. Substring match would erroneously return both; exact match must return one.
   7b. Missing-label returns 400.
   7c. `status` filter applies correctly (open, closed, all).
   7d. `.repo` field is populated correctly from the `project:<repoName>` label that getAllProjectsPlan adds.

CONTEXT THE AGENT NEEDS:
- `getAllProjectsPlan` lives at `src/lib/bv-client.ts:815-884`. Already uses `Promise.allSettled` over `repoPaths.map(getPlan)` and adds `project:<repoName>` labels at lines 836-840. The route's job is filter + project — no new aggregation logic.
- The dashboard's wave-status widget already calls this aggregator (`src/app/api/fleet/wave-status/route.ts:17`), and `plan-prewarm.ts:71` warms it at boot. Reusing it has zero marginal Dolt cost — the cache is already populated by routine traffic.
- `getAllRepoPaths` is at `src/lib/repo-config.ts:87-90`. Returns `string[]`.
- The CLI script is intentionally thin — only HTTP fetch + JSON print + exit. No bd subprocess invocation, no logic. This avoids the Dolt-saturation class that motivated factory-core-8260.4 dolt-prewarm. The route does the heavy lifting via the cached aggregator.
- This bead consolidates Changes 4a, 4b, 11 from `docs/cross-repo/retrofit-feasibility.md`. The HTTP-route approach (vs CLI fanning out `bd list` calls) was specifically chosen to avoid Dolt saturation.

RISK FLAGS:
- Watch for substring matching on labels (e.g., `issue.labels.join(",").includes(label)` instead of `issue.labels.includes(label)`). The substring form silently over-matches across epics. AC item 4 plus the dedicated test (item 7a) exist to catch this. STOP and surface if a test fails on the precision case — don't relax the assertion to "make it pass."
- Watch for new Dolt connections. If the route imports from `dolt-health.ts`, `dolt-prewarm.ts`, or directly invokes `mysql.createConnection`, that's the wrong layer — the cached `getAllProjectsPlan` aggregator already handles Dolt access. STOP and surface if you find yourself reaching for Dolt directly.
- Watch for the CLI script importing from `src/`. The script is run via `node scripts/bd-cross-repo.ts` — it cannot import server-side code that depends on Next.js runtime, Webpack, or the Edge bundle. Use plain `fetch` (Node 18+ global) and stdlib only. STOP and surface if the import graph requires a build step.

MARKER REQUIREMENTS:
- Standard marker per `standards/generic/marker-protocol.md`.
- In `surprises_or_findings`: if the `project:<repoName>` label format diverges from what `getAllProjectsPlan` emits (verify against bv-client.ts:836-840 line by line), document as `LABEL-FORMAT-DRIFT` and update the route's parser before completing.
- Manual-test sanity in the marker: run `node scripts/bd-cross-repo.ts --label=epic:factory-core-so74` against the cold-started orchestrator and paste the JSON output (truncated if long) as a sample.

COMMIT REQUIREMENTS:
- Single commit prefixed `beads_web-xjn:` per builder.md § 5d Step 4.
- Subject: `beads_web-xjn: cross-repo enumeration HTTP route + CLI wrapper`.
- Body: cite AC numbers; cite the `getAllProjectsPlan` reuse rationale (zero new Dolt cost); name the env var `BEADS_WEB_URL`; quote a sample of the route's JSON output.
