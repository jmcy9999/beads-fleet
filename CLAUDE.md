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

1. **ALWAYS start from the beads_web directory.** Run `cd /Users/janemckay/dev/claude_projects/beads_web` before `npx next dev`. Starting from another directory (e.g., cycle-apps-factory) picks up a global Next.js version instead of the project's Next.js 14, and fails with "Couldn't find any `pages` or `app` directory".
2. **NEVER run `npx next build` while the dev server is running.** This corrupts `.next/server/webpack-runtime.js` module references, causing "Cannot find module './682.js'" or similar errors on every page load.
3. **If webpack module errors appear:** Kill the server (`lsof -ti :3000 | xargs kill -9`) → delete cache (`rm -rf .next`) → restart from beads_web directory (`npx next dev --port 3000`).
4. **Port conflicts:** If port 3000 is in use, kill the stale process first: `lsof -ti :3000 | xargs kill -9`.

## Quick Reference

- **Stack:** Next.js 14, React 18, TanStack Query 5, ReactFlow 11, better-sqlite3, Tailwind CSS 3
- **Data:** `.beads/beads.db` (SQLite, source of truth) -> bv-client.ts -> API routes -> React hooks -> UI
- **Multi-repo:** `~/.beads-web.json` config, `__all__` sentinel for aggregation mode
- **Fallback chain:** bv CLI -> SQLite -> JSONL -> empty response
- **Schema tolerance:** sqlite-reader.ts uses `PRAGMA table_info` to handle different beads DB versions
