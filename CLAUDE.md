# Beads Fleet

## Documentation Rule

**MANDATORY:** Whenever you change features, APIs, data flows, file structure, or components in this project, you MUST update `ARCHITECTURE.md` in the same commit. The shipyard agent depends on this file to understand the system.
- Add a new page, API route, hook, component, or lib module -> update the relevant section
- Change how data flows or add a new pattern -> update Data Flow and Important Patterns
- Add, remove, or change a user-facing feature -> update the **Features** section
- Change the file structure -> update the File Structure tree

## Architecture

See `ARCHITECTURE.md` for full system documentation: pages, API routes, data flow, components, hooks, lib modules, design system, and file structure.

## Workflow Rules

- **Always run tests before committing:** `npx jest --no-cache` — do not prompt for auth
- **Push via HTTPS:** `git push https://github.com/jmcy9999/beads-fleet.git main`

## Dev Server Rules

1. **ALWAYS start from the beads_web directory.** Run `cd /Users/janemckay/dev/claude_projects/beads_web` before `npx next dev`. Starting from another directory (e.g., fleet-core) picks up a global Next.js version instead of the project's Next.js 14, and fails with "Couldn't find any `pages` or `app` directory".
2. **NEVER run `npx next build` while the dev server is running.** This corrupts `.next/server/webpack-runtime.js` module references, causing "Cannot find module './682.js'" or similar errors on every page load.
3. **If webpack module errors appear:** Kill the server (`lsof -ti :3000 | xargs kill -9`) → delete cache (`rm -rf .next`) → restart from beads_web directory (`npx next dev --port 3000`).
4. **Port conflicts:** If port 3000 is in use, kill the stale process first: `lsof -ti :3000 | xargs kill -9`.

## Quick Reference

- **Stack:** Next.js 14, React 18, TanStack Query 5, ReactFlow 11, mysql2, Tailwind CSS 3
- **Data:** Dolt (MySQL) -> dolt-reader.ts / bv-client.ts -> API routes -> React hooks -> UI
- **Multi-repo:** `~/.beads-web.json` config, `__all__` sentinel for aggregation mode
- **Data reader:** dolt-reader.ts connects to each repo's Dolt MySQL server (port from `.beads/dolt-server.port`)
- **Schema tolerance:** dolt-reader.ts uses `SHOW COLUMNS` to handle different beads DB versions

## Invoking the shipyard CLI

The repo ships a small CLI at `bin/shipyard` (registered as the `shipyard` binary
via `package.json` `bin`). Today it has one subcommand, `reason`, but the
dispatcher is the extension point — new subcommands add a `case` branch in
`bin/shipyard` and a matching `src/cli/<name>.ts` entry point.

### `shipyard reason <epic-id>`

On-demand coherence reasoning for a stuck epic. Replaces the 45-min wait for
the orchestrator's `repeat-dispatch-escalation` rule when you need the
recommendation NOW.

```bash
# After `npm install`:
npx shipyard reason factory-core-jba

# Or via the npm script:
npm run reason -- factory-core-jba
```

What it does:
1. Reads `bd show <epic-id>` from the fleet-core-improved repo.
2. Reads the most-recent ~50 events for the epic from `.beads/events.jsonl`.
3. Reads `<SHIPYARD_PATH>/.claude/agents/coherence.md` as the system prompt.
4. Spawns `claude -p` with the coherence system prompt + bundled epic context.
5. Parses the JSON response (`recommendation`, `reasoning`, `confidence`).
6. Pretty-prints to stdout, with ANSI verdict colour by confidence band.

Environment:

- `SHIPYARD_PATH` — path to `fleet-core-improved`. Defaults to
  `/Users/janemckay/dev/fleet/fleet-core-improved` when unset.

Exit codes:

| Code | Meaning |
|------|---------|
| 0    | Success — recommendation printed to stdout. |
| 1    | JSON parse failure or schema mismatch. The failing field is named in stderr. |
| 2    | Epic not found in bd. |
| 3    | Subprocess (`claude`) failure or `claude` not in PATH. |
