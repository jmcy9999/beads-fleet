# Beads Web

**A browser-based dashboard for the [Beads](https://github.com/steveyegge/beads) issue tracker.**

[![CI](https://github.com/jmcy9999/beads-web/actions/workflows/ci.yml/badge.svg)](https://github.com/jmcy9999/beads-web/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Next.js](https://img.shields.io/badge/Next.js-14-black)](https://nextjs.org/)

The first web frontend for Beads. Until now, interaction with Beads has been limited to the CLI (`bd`) and the terminal TUI (`bv` / beads_viewer). Beads Web gives teams visual, real-time access to their issue data -- dependencies, priorities, graph-based insights, and more -- through a dark-themed web UI.

<!-- screenshot -->

---

## Features

- **Dashboard** -- Sortable issue table with summary stats, quick status overview, and full-text search
- **Kanban Board** -- Issues grouped by status columns (Open, In Progress, Blocked, Closed)
- **Insights** -- Interactive dependency graph with PageRank bottlenecks, keystone detection, HITS influencer/authority analysis, cycle detection, and graph density metrics
- **Time Travel** -- Git-based diff view showing issue changes since any ref (`HEAD~1`, `HEAD~5`, a branch name, etc.)
- **Issue Detail** -- Full issue view with description, dependency tree, and metadata sidebar
- **Settings** -- Add, remove, and switch between multiple Beads-enabled repositories
- **Filter Bar** -- Search, status, priority, and type multi-select filters across all views
- **Saved Views** -- 6 built-in presets (All Issues, Actionable, In Progress, Blocked, High Priority, Bugs) plus custom saved views
- **Keyboard Shortcuts** -- Single-key navigation throughout the app
- **First-Run Wizard** -- Guides new users through prerequisites check and adding their first repo
- **Error Boundary** -- Catches React errors with a retry option

---

## Quick Start

```bash
git clone https://github.com/jmcy9999/beads-web.git
cd beads-web
npm install
```

Set the path to a Beads-enabled project:

```bash
echo 'BEADS_PROJECT_PATH=/path/to/your/beads-enabled-project' > .env.local
```

Start the dev server:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

---

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| **Node.js 18+** | Runtime for Next.js |
| **Git** | Required for Time Travel diffs and Beads itself |
| **Beads CLI (`bd`)** | Must be installed and initialized (`bd init`) in at least one project. [Install Beads](https://github.com/steveyegge/beads) |
| **beads_viewer (`bv`)** | *Optional but recommended.* Enables full graph metrics (PageRank, HITS, cycle detection). Without it, the app falls back to direct SQLite reads. |

---

## Installation

### npm

```bash
git clone https://github.com/jmcy9999/beads-web.git
cd beads-web
npm install
npm run dev
```

### Docker

```bash
# Using docker compose with a specific project directory
PROJECT_DIR=/path/to/your/beads/project docker compose up

# Or build and run detached
PROJECT_DIR=/path/to/your/beads/project docker compose up -d
```

The container mounts your project directory as a read-only volume and serves on port 3000.

### Standalone Build

```bash
npm run build
node .next/standalone/server.js
```

---

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `BEADS_PROJECT_PATH` | Yes | Absolute path to a Beads-enabled repo (must contain a `.beads/` directory) |
| `BV_PATH` | No | Path to the `bv` binary. If omitted, the app searches `$PATH`. |

Set these in `.env.local` for development or pass them as environment variables in production.

### Multi-Repo Support

Beads Web can manage multiple Beads-enabled repositories. Configuration is stored in `~/.beads-web.json`.

- **Add repos** via the Settings page or the first-run wizard
- **Switch repos** using the sidebar dropdown or the Settings page
- **API-driven**: `POST /api/repos` to add/remove repos programmatically

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `d` | Go to Dashboard |
| `b` | Go to Board |
| `i` | Go to Insights |
| `t` | Go to Time Travel |
| `s` | Go to Settings |
| `/` | Focus search |
| `?` | Show help |

Shortcuts are disabled when a text input is focused.

---

## Architecture

Beads Web is a thin wrapper over the existing Beads data layer. It does not duplicate data or maintain its own database.

```
Browser  -->  Next.js API Routes  -->  bv CLI (Robot Protocol)
                                   |
                                   +->  SQLite fallback (.beads/beads.db)
                                   +->  JSONL fallback (.beads/issues.jsonl)
```

**Data flow:** The browser calls Next.js API routes. Each route shells out to `bv --robot-*` commands that return structured JSON. When `bv` is unavailable, the route reads directly from the Beads SQLite database via `better-sqlite3`. If the database is also missing, it parses `.beads/issues.jsonl` as a final fallback.

Responses are cached in memory with a short TTL to keep the UI responsive without hammering the filesystem.

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Framework | Next.js 14 (App Router) |
| Language | TypeScript |
| Styling | Tailwind CSS v3 |
| Data Fetching | TanStack Query v5 (React Query) |
| Graph Visualization | ReactFlow v11 |
| Database Access | better-sqlite3 |
| Testing | Jest + React Testing Library |
| CI | GitHub Actions |

---

## API Routes

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | `GET` | System status -- bv availability, project path validity |
| `/api/issues` | `GET` | All issues with summary counts and track grouping |
| `/api/issues/:id` | `GET` | Single issue detail with full metadata |
| `/api/insights` | `GET` | Graph metrics: bottlenecks, keystones, hubs, cycles, density |
| `/api/priority` | `GET` | Priority recommendations with confidence scores |
| `/api/diff?since=REF` | `GET` | Issue changes since a git reference (e.g. `HEAD~5`) |
| `/api/repos` | `GET` | List configured repositories |
| `/api/repos` | `POST` | Add, remove, or set the active repository |

---

## Development

```bash
npm run dev          # Start dev server with hot reload (port 3000)
npm run build        # Production build
npm run lint         # ESLint
npx tsc --noEmit     # TypeScript type check
npx jest             # Run tests
```

### Project Structure

```
src/
  app/                     # Next.js App Router pages
    api/                   # API route handlers
      diff/                # GET /api/diff?since=HEAD~5
      health/              # GET /api/health
      insights/            # GET /api/insights
      issues/              # GET /api/issues
        [id]/              # GET /api/issues/:id
      priority/            # GET /api/priority
      repos/               # GET/POST /api/repos
    board/                 # Kanban board page
    diff/                  # Time Travel page
    insights/              # Graph insights page
    issue/[id]/            # Issue detail page
    settings/              # Repository settings page
  components/
    dashboard/             # Dashboard-specific components
    filters/               # FilterBar, RecipeSelector
    insights/              # MetricPanel, DependencyGraph, ActivityFeed
    layout/                # Sidebar, Header
    providers/             # QueryProvider, ClientShell
    ui/                    # IssueCard, ErrorBoundary, SetupWizard
  hooks/                   # React Query hooks
  lib/                     # Core data access and utilities
    bv-client.ts           # bv CLI wrapper + fallback chain
    sqlite-reader.ts       # Direct SQLite DB reader
    jsonl-fallback.ts      # JSONL parser (final fallback)
    repo-config.ts         # Multi-repo configuration (~/.beads-web.json)
    recipes.ts             # Saved view / filter presets
    cache.ts               # TTL cache for bv responses
    types.ts               # Shared TypeScript types
```

---

## Deployment

### Docker

The included `Dockerfile` produces a minimal production image using Next.js standalone output tracing.

```bash
PROJECT_DIR=/path/to/your/beads/project docker compose up -d
```

### Netlify

A `netlify.toml` is included. Connect the repository to Netlify and it will build automatically using the `@netlify/plugin-nextjs` plugin.

> **Note:** SQLite-based features require a server runtime. Netlify deployments will depend on `bv` being accessible or the API routes being adapted for edge/serverless constraints.

### Standalone Node.js

```bash
npm run build
BEADS_PROJECT_PATH=/path/to/project node .next/standalone/server.js
```

---

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines on branching, commit conventions, code style, and pull request process.

---

## License

MIT License. See [LICENSE](LICENSE) for details.

---

## Acknowledgments

- [Beads](https://github.com/steveyegge/beads) by Steve Yegge -- the issue tracker this dashboard visualizes
- [beads_viewer (`bv`)](https://github.com/steveyegge/beads) -- the terminal TUI whose Robot Protocol powers the backend
- Built with [Next.js](https://nextjs.org/), [ReactFlow](https://reactflow.dev/), [TanStack Query](https://tanstack.com/query), [Tailwind CSS](https://tailwindcss.com/), and [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)
