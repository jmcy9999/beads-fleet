# Beads Web

**A browser-based dashboard for the [Beads](https://github.com/steveyegge/beads) issue tracker.**

[![CI](https://github.com/jmcy9999/beads-web/actions/workflows/ci.yml/badge.svg)](https://github.com/jmcy9999/beads-web/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Next.js](https://img.shields.io/badge/Next.js-14-black)](https://nextjs.org/)

The first web frontend for Beads. Until now, interaction with Beads has been limited to the CLI (`bd`) and the terminal TUI (`bv` / beads_viewer). Beads Web gives teams visual, real-time access to their issue data -- dependencies, priorities, graph-based insights, and more -- through a dark-themed web UI.

Beyond issue visualization, Beads Web includes a **pipeline orchestration layer** for managing epics through multi-stage workflows. Track projects from idea through research, development, and delivery on a kanban board, with one-click agent launches that spawn [Claude Code](https://claude.ai/claude-code) sessions to do the work. Pipeline labels are managed automatically as agents start and finish, and token usage is tracked per-project and per-phase. If [Gastown](https://github.com/steveyegge/gastown) is overkill for your requirements, you can use Beads Web to build your own factory backend for autonomous project delivery.

<!-- screenshot -->
<img width="1368" height="651" alt="Screenshot 2026-02-09 at 01 20 22" src="https://github.com/user-attachments/assets/6f9c0bf4-3fa8-4f26-b45c-45f0adcc01e8" />

---

## Contents

- [Features](#features)
  - [Core Issue Management](#core-issue-management)
  - [Analysis & Insights](#analysis--insights)
  - [Pipeline & Agent Orchestration](#pipeline--agent-orchestration)
  - [Multi-Repo & Navigation](#multi-repo--navigation)
- [Quick Start](#quick-start)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuration](#configuration)
- [Pages](#pages)
- [Keyboard Shortcuts](#keyboard-shortcuts)
- [Architecture](#architecture)
- [Tech Stack](#tech-stack)
- [API Routes](#api-routes)
- [Development](#development)
- [Deployment](#deployment)
- [Contributing](#contributing)
- [License](#license)

---

## Features

### Core Issue Management

- **Dashboard** -- Sortable issue table with summary stats, quick status overview, and full-text search
- **Kanban Board** -- Issues grouped by status columns (Open, In Progress, Blocked, Closed)
- **Issue Detail** -- Full issue view with description, dependency tree, and metadata sidebar
- **Issue Actions** -- Start, close, reopen, and comment on issues directly from the UI

### Analysis & Insights

- **Insights** -- Interactive dependency graph with PageRank bottlenecks, keystone detection, HITS influencer/authority analysis, cycle detection, and graph density metrics
- **Time Travel** -- Git-based diff view showing issue changes since any ref (`HEAD~1`, `HEAD~5`, a branch name, etc.)
- **Token Usage Tracking** -- Per-issue and aggregate token/cost analytics for Claude Code agent sessions, with summary roll-ups across all repositories

### Pipeline & Agent Orchestration

- **Fleet** -- Pipeline kanban board for tracking epics through configurable project stages (e.g. research, development, review, submission). Epics are visualized as cards moving through pipeline columns, with per-epic cost tracking and agent status indicators.
- **Activity** -- Timeline view of agent sessions across all tracked issues, correlating token usage records with issue metadata
- **Agent Orchestration** -- Launch and stop Claude Code agents directly from the dashboard. Agents run as background subprocesses, with live status polling and log tailing. Pipeline labels are automatically managed when agents start and finish.
- **Signals Polling** -- Query endpoint for detecting issue state changes since a given timestamp, filterable by label and status. Useful for automation scripts and CI integrations that need to react to issue transitions.

### Multi-Repo & Navigation

- **Multi-Repo Support** -- Manage multiple Beads-enabled repositories from a single dashboard. Switch between repos or view all projects aggregated. Watch directories auto-discover new projects.
- **Settings** -- Add, remove, and switch between multiple Beads-enabled repositories. Configure watch directories for auto-discovery.
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
| **Beads CLI (`bd`) and beads_viewer (`bv`)** | Both installed automatically by `npm install` -- no separate or global install needed. `bd` is bundled as the `@beads/bd` npm dependency. `bv` is downloaded from GitHub releases by the `scripts/install-bv.sh` postinstall script. If the `bv` download fails (no internet, unsupported platform), the app falls back to SQLite-based analytics. At least one project must be initialized with `bd init`. The `BV_PATH` env var can override the `bv` binary path. |
| **Claude Code CLI** (optional) | Required only for agent orchestration features (Fleet, agent launch/stop). Install from [claude.ai](https://claude.ai). Not needed for core issue management. |

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
| `BV_PATH` | No | Override path to the `bv` binary. If omitted, the version downloaded by the postinstall script is used. |

Set these in `.env.local` for development or pass them as environment variables in production.

### Multi-Repo Support

Beads Web can manage multiple Beads-enabled repositories. Configuration is stored in `~/.beads-web.json`.

- **Add repos** via the Settings page or the first-run wizard
- **Switch repos** using the sidebar dropdown or the Settings page
- **Aggregate mode**: Select "All Projects" to view issues from every configured repo in a single dashboard
- **Watch directories**: Configure parent directories to auto-discover new Beads-enabled projects
- **API-driven**: `POST /api/repos` to add/remove repos programmatically

---

## Pages

| Page | Path | Description |
|------|------|-------------|
| **Dashboard** | `/` | Sortable issue table with summary stats and full-text search |
| **Board** | `/board` | Kanban board with issues grouped by status columns |
| **Insights** | `/insights` | Interactive dependency graph with graph metrics |
| **Time Travel** | `/diff` | Git-based diff view for issue changes since any ref |
| **Issue Detail** | `/issue/:id` | Full issue view with description and dependency tree |
| **Fleet** | `/fleet` | Pipeline kanban for tracking epics through project stages |
| **Activity** | `/activity` | Timeline of agent sessions across all tracked issues |
| **Settings** | `/settings` | Repository management and configuration |

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
| `/api/issues/:id/action` | `POST` | Perform actions on an issue (start, close, reopen, comment) |
| `/api/insights` | `GET` | Graph metrics: bottlenecks, keystones, hubs, cycles, density |
| `/api/priority` | `GET` | Priority recommendations with confidence scores |
| `/api/diff?since=REF` | `GET` | Issue changes since a git reference (e.g. `HEAD~5`) |
| `/api/repos` | `GET`, `POST` | List, add, remove, or set the active repository |
| `/api/token-usage` | `GET` | Token usage records and per-issue cost summaries |
| `/api/agent` | `GET`, `POST` | Get agent status, launch or stop a Claude Code agent |
| `/api/signals` | `GET` | Poll for issue state changes since a timestamp |
| `/api/fleet/action` | `POST` | Execute pipeline actions on epics (stage transitions) |
| `/api/research/:name` | `GET` | Retrieve a markdown research report by project name |

Full API documentation with request/response schemas: [docs/API.md](docs/API.md)

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
      agent/               # GET/POST /api/agent
      diff/                # GET /api/diff?since=HEAD~5
      fleet/action/        # POST /api/fleet/action
      health/              # GET /api/health
      insights/            # GET /api/insights
      issues/              # GET /api/issues
        [id]/              # GET /api/issues/:id
          action/          # POST /api/issues/:id/action
      priority/            # GET /api/priority
      repos/               # GET/POST /api/repos
      research/[appName]/  # GET /api/research/:name
      signals/             # GET /api/signals
      token-usage/         # GET /api/token-usage
    activity/              # Agent activity timeline page
    board/                 # Kanban board page
    diff/                  # Time Travel page
    fleet/                 # Pipeline fleet board page
    insights/              # Graph insights page
    issue/[id]/            # Issue detail page
    settings/              # Repository settings page
  components/
    dashboard/             # Dashboard-specific components
    filters/               # FilterBar, RecipeSelector
    fleet/                 # FleetBoard, AgentStatusBanner, ActivityTimeline
    insights/              # MetricPanel, DependencyGraph, ActivityFeed
    layout/                # Sidebar, Header
    providers/             # QueryProvider, ClientShell
    ui/                    # IssueCard, ErrorBoundary, SetupWizard
  hooks/                   # React Query hooks
  lib/                     # Core data access and utilities
    agent-launcher.ts      # Claude Code agent subprocess management
    bv-client.ts           # bv CLI wrapper + fallback chain
    cache.ts               # TTL cache for bv responses
    graph-metrics.ts       # In-process graph analytics fallback
    jsonl-fallback.ts      # JSONL parser (final fallback)
    pipeline-labels.ts     # Pipeline label management for epics
    recipes.ts             # Saved view / filter presets
    repo-config.ts         # Multi-repo configuration (~/.beads-web.json)
    sqlite-reader.ts       # Direct SQLite DB reader
    token-usage.ts         # Token usage JSONL reader and aggregation
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
- [beads_viewer (`bv`)](https://github.com/Dicklesworthstone/beads_viewer) by Dicklesworthstone (MIT) -- the terminal TUI / graph analytics engine whose Robot Protocol powers the backend
- Built with [Next.js](https://nextjs.org/), [ReactFlow](https://reactflow.dev/), [TanStack Query](https://tanstack.com/query), [Tailwind CSS](https://tailwindcss.com/), and [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)
