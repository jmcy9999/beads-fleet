# Beads Web — Build Plan for Claude Code

## Project Overview

Build **Beads Web** — a browser-based dashboard for the Beads issue tracker (by Steve Yegge) that gives teams visual, browser-based access to their Beads task data. This is the first web frontend for Beads — currently only a CLI (`bd`) and a terminal TUI (`bv` / beads_viewer) exist.

### Architecture Decision: Thin Web Wrapper over beads_viewer

Rather than reimplementing Beads' data parsing and graph analysis from scratch, this project wraps the existing `bv` (beads_viewer) tool's **Robot Protocol** — a set of CLI commands that output structured JSON containing pre-computed graph metrics (PageRank, Betweenness, HITS, Critical Path, Cycle Detection, Topological Sort, and more).

**Why this approach:**
- `bv` already computes 9 graph-theoretic metrics with battle-tested algorithms
- The `--robot-*` flags return structured JSON designed for programmatic consumption
- Avoids reimplementing PageRank, Betweenness Centrality, HITS, etc. in JavaScript
- Dramatically faster to build — the entire analytics engine is already done
- Can always replace with native implementation later if needed

### Key Data Sources (bv Robot Protocol)

| Command | Returns | Used For |
|---------|---------|----------|
| `bv --robot-insights` | PageRank, Betweenness, HITS, Critical Path, Cycles, Density | Dashboard metrics, Insights panels |
| `bv --robot-plan` | Parallel execution tracks, unblocks lists, actionable items | Kanban board, "What's next?" view |
| `bv --robot-priority` | Priority recommendations with confidence scores | Priority misalignment alerts |
| `bv --robot-diff --diff-since <ref>` | New/closed/modified issues, cycle changes, metric deltas | Activity feed, sprint review |
| `bv --robot-recipes` | Available filter presets | Saved views / quick filters |

### Beads Data Model (from .beads/issues.jsonl)

Each issue is a JSON object stored one-per-line in `.beads/issues.jsonl`:

```json
{
  "id": "bd-a1b2",
  "title": "Implement user auth",
  "status": "open|in_progress|blocked|deferred|closed|pinned",
  "type": "bug|feature|task|epic|chore",
  "priority": 0-4,
  "blocked_by": ["bd-e9b1"],
  "assignee": "@jane",
  "labels": ["frontend", "v1.0"],
  "created_at": "ISO8601",
  "updated_at": "ISO8601",
  "description": "markdown content",
  "comments": []
}
```

The SQLite database (`.beads/beads.db`) is the fast local cache; JSONL is the git-tracked source of truth.

---

## Tech Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| **Frontend** | Next.js 14+ (App Router) | React ecosystem, SSR for initial load, API routes built-in |
| **Styling** | Tailwind CSS | Fast iteration, consistent design system |
| **Charts** | Recharts or Chart.js | Dependency graphs, metric visualisations |
| **Graph Viz** | D3.js or react-flow | Interactive dependency DAG rendering |
| **Backend** | Next.js API Routes | Shells out to `bv --robot-*` commands, returns JSON |
| **State** | React Query (TanStack Query) | Caching, polling, background refresh |
| **Auth** | NextAuth.js (Phase 3) | GitHub OAuth for team features |
| **Hosting** | Netlify or Vercel | Your existing Netlify account works |
| **Database** | None initially (Phase 1-2) | Data comes from git repo via bv |

### Prerequisites on Host Machine

- `bd` (Beads CLI) installed and initialised in at least one project
- `bv` (beads_viewer) installed — provides the robot protocol
- Node.js 18+
- Git

---

## Phase 1 — Core MVP (Week 1, Days 1-3)

**Goal:** A working local web dashboard that reads from a single Beads-enabled repository and displays task status visually. Prove the concept works.

### 1.1 Project Scaffold

- [ ] Initialise Next.js 14 project with App Router, TypeScript, Tailwind
- [ ] Create project structure:
  ```
  beads-web/
  ├── app/
  │   ├── layout.tsx          # Shell with sidebar nav
  │   ├── page.tsx            # Dashboard (default view)
  │   ├── board/page.tsx      # Kanban board view
  │   ├── insights/page.tsx   # Graph metrics view
  │   └── api/
  │       ├── issues/route.ts       # Proxy to bv --robot-plan
  │       ├── insights/route.ts     # Proxy to bv --robot-insights
  │       └── priority/route.ts     # Proxy to bv --robot-priority
  ├── components/
  │   ├── IssueCard.tsx
  │   ├── KanbanColumn.tsx
  │   ├── StatusBadge.tsx
  │   ├── PriorityIndicator.tsx
  │   ├── DependencyGraph.tsx
  │   └── MetricPanel.tsx
  ├── lib/
  │   ├── bv-client.ts        # Wrapper to exec bv commands
  │   └── types.ts            # TypeScript interfaces for Beads data
  └── .env.local              # BEADS_PROJECT_PATH=/path/to/your/project
  ```

### 1.2 Backend: bv Command Wrapper

- [ ] Create `lib/bv-client.ts` that:
  - Accepts a project path (from env var or config)
  - Executes `bv --robot-insights`, `bv --robot-plan`, `bv --robot-priority`, `bv --robot-diff` via `child_process.execSync` or `exec`
  - Parses JSON output, handles errors gracefully (bv not installed, no .beads dir, etc.)
  - Caches results with a short TTL (5-10 seconds) to avoid hammering the filesystem
  - Falls back to reading `.beads/issues.jsonl` directly if bv is unavailable (basic mode without graph metrics)

```typescript
// lib/bv-client.ts — conceptual interface
export interface BvClient {
  getInsights(): Promise<RobotInsights>;
  getPlan(): Promise<RobotPlan>;
  getPriority(): Promise<RobotPriority>;
  getDiff(since: string): Promise<RobotDiff>;
  getRecipes(): Promise<RobotRecipes>;
}
```

### 1.3 API Routes

- [ ] `GET /api/issues` — returns `bv --robot-plan` output (all issues with execution tracks)
- [ ] `GET /api/insights` — returns `bv --robot-insights` output (graph metrics)
- [ ] `GET /api/priority` — returns `bv --robot-priority` output (recommendations)
- [ ] `GET /api/diff?since=HEAD~5` — returns `bv --robot-diff --diff-since <ref>` output
- [ ] All routes should handle errors gracefully and return appropriate HTTP status codes

### 1.4 Dashboard Page (Home)

- [ ] **Summary cards** at top: Total Issues, Open, In Progress, Blocked, Closed (counts from robot-plan)
- [ ] **"What's Next?" panel** — shows the highest-impact actionable task from `robot-plan.summary.highest_impact` with unblocks count
- [ ] **Issue list** — sortable table of all open issues with columns: ID, Title, Status, Priority, Type, Blocked By
- [ ] **Priority alerts** — show issues where computed impact diverges from human priority (from robot-priority recommendations)
- [ ] Auto-refresh every 30 seconds using React Query polling

### 1.5 Kanban Board Page

- [ ] Four columns: Open, In Progress, Blocked, Closed
- [ ] Issue cards showing: type icon, ID, title, priority flames, assignee, dependency count
- [ ] Cards sorted by priority within each column (P0 first)
- [ ] Empty columns collapse (adaptive layout from bv's design)
- [ ] Click card to expand detail panel (slide-in from right)

### 1.6 Basic Styling & Layout

- [ ] Sidebar navigation: Dashboard, Board, Insights
- [ ] Dark theme by default (matches developer aesthetic and bv's Dracula theme)
- [ ] Responsive layout — works on laptop screens at minimum
- [ ] Use status colours consistently: Open=Green, In Progress=Amber, Blocked=Red, Closed=Grey

### Phase 1 Acceptance Criteria

- Can point it at any Beads-enabled git repo via env var
- Dashboard loads and shows real issue data from the repo
- Kanban board renders issues in correct columns
- Auto-refreshes when issues change (via polling)
- Works locally on `localhost:3000`

---

## Phase 2 — Insights & Visualisation (Week 1-2, Days 3-5)

**Goal:** Surface the graph intelligence that makes this more than just "another task board". This is the differentiator — no web-based tool currently shows Beads' dependency graph metrics.

### 2.1 Insights Dashboard

Replicate bv's 6-panel insights layout for the web:

- [ ] **Bottlenecks panel** — Top 5 issues by Betweenness Centrality with score bars
- [ ] **Keystones panel** — Top 5 by Critical Path Impact Depth
- [ ] **Influencers panel** — Top 5 by Eigenvector Centrality
- [ ] **Hubs panel** — Top 5 by HITS Hub Score (epics/features that aggregate dependencies)
- [ ] **Authorities panel** — Top 5 by HITS Authority Score (utility/infrastructure tasks)
- [ ] **Cycles panel** — List all circular dependency loops with issue IDs and visual warning

Each panel should:
- Show issue ID, title, and metric score
- Colour-code scores using a heatmap (low=grey, mid=blue, high=purple, peak=pink — matching bv's scheme)
- Click an issue to navigate to its detail view

### 2.2 Dependency Graph Visualisation

- [ ] Interactive DAG using D3.js or react-flow
- [ ] Nodes = issues, coloured by status (open/blocked/closed)
- [ ] Edges = blocking relationships (thick for direct blocks, dashed for loose)
- [ ] Node size proportional to PageRank score
- [ ] Highlight critical path in a distinct colour
- [ ] Highlight cycles with red pulsing edges
- [ ] Click node to see issue details
- [ ] Zoom/pan controls
- [ ] Layout: topological layering (dependencies flow top-to-bottom)

### 2.3 Composite Impact Score Display

Implement bv's scoring formula visually:

```
Impact = 0.30 × PageRank + 0.30 × Betweenness + 0.20 × BlockerRatio + 0.10 × Staleness + 0.10 × PriorityBoost
```

- [ ] Show impact score on each issue card as a small bar/badge
- [ ] Issue detail view shows score breakdown (which components contributed what)
- [ ] Sort-by-impact option on the issue list

### 2.4 Graph Health Indicator

- [ ] Overall graph density metric displayed in header/sidebar
- [ ] Colour-coded: Low (<0.05) = healthy green, Medium (0.05-0.15) = amber, High (>0.15) = red warning
- [ ] Cycle count badge — 0 cycles = green checkmark, any cycles = red warning with count

### 2.5 Activity Feed / Diff View

- [ ] "Recent Changes" panel on dashboard showing issues created/closed/modified in last N commits
- [ ] Powered by `bv --robot-diff --diff-since HEAD~10`
- [ ] Show: [NEW] / [CLOSED] / [MODIFIED] / [REOPENED] badges per issue
- [ ] Summary stats: "+3 new, 2 closed, 1 modified"

### Phase 2 Acceptance Criteria

- All 6 insight panels render with real data from bv
- Dependency graph is interactive and navigable
- Cycles are visually flagged
- Impact scores visible on issue cards
- Activity feed shows recent changes

---

## Phase 3 — Multi-Repo & Team Features (Week 2-3)

**Goal:** Move from single-user local tool to something a team can share. Add GitHub OAuth, multi-repo support, and persistent configuration.

### 3.1 Multi-Repository Support

- [ ] Configuration page to add multiple Beads-enabled repositories (local paths)
- [ ] Repository selector in sidebar/header
- [ ] Cross-repo view option (unified issue list across repos — mirrors bv's workspace.yaml concept)
- [ ] Issues namespaced by repo prefix (e.g., `api-AUTH-123`, `web-UI-456`)

### 3.2 GitHub OAuth Authentication

- [ ] NextAuth.js with GitHub provider
- [ ] Login/logout flow
- [ ] User avatar and name in sidebar
- [ ] Protected routes (require auth for write operations in future)

### 3.3 Saved Views / Recipes

- [ ] Implement bv's recipe concept as saved filter presets
- [ ] Built-in presets: Actionable, High Impact, Blocked, Stale (30+ days), Recent (7 days)
- [ ] Custom saved views with filter criteria (status, priority, tags, date ranges)
- [ ] Recipe selector dropdown in the toolbar
- [ ] Persist recipes in localStorage initially, later to user preferences

### 3.4 Issue Detail View

- [ ] Full-page or slide-out panel for issue details
- [ ] Markdown-rendered description
- [ ] Comment history (if available in JSONL)
- [ ] Dependency tree — what this blocks, what blocks this
- [ ] Metric breakdown (PageRank, Betweenness, Impact Score)
- [ ] Labels, assignee, created/updated timestamps

### 3.5 Time-Travel / Snapshot Comparison

- [ ] UI for comparing current state against any git revision
- [ ] Powered by `bv --robot-diff --diff-since <revision>`
- [ ] Visual diff badges on issue list (matching bv's [NEW]/[CLOSED]/[MODIFIED] system)
- [ ] Summary panel: changes count, health trend (density change, cycles resolved)
- [ ] Useful for sprint retrospectives and progress tracking

### Phase 3 Acceptance Criteria

- Can switch between multiple repos
- GitHub login works
- Saved views persist and filter correctly
- Full issue detail view with dependency tree
- Time-travel diff comparison functional

---

## Phase 4 — Deployment & Documentation (Week 3)

**Goal:** Make it deployable and documented so others can use it. Consider open-source release.

### 4.1 Deployment Configuration

- [ ] Dockerfile for self-hosted deployment
- [ ] Docker Compose with the web app + volume mount for git repos
- [ ] Environment variable documentation (repo paths, auth secrets, etc.)
- [ ] Netlify/Vercel deployment option for the frontend (with API routes pointing to a backend server)

### 4.2 Setup Wizard

- [ ] First-run experience that guides user through:
  - Verifying `bd` and `bv` are installed
  - Selecting repository path(s)
  - Optional GitHub OAuth configuration
  - First data load with loading indicator

### 4.3 Documentation

- [ ] README with screenshots, quick start, architecture overview
- [ ] CONTRIBUTING.md for open source
- [ ] API documentation for the backend routes
- [ ] Deployment guides (Docker, Netlify, local dev)

### 4.4 Polish

- [ ] Loading states and skeleton screens for all data-dependent views
- [ ] Error boundaries with helpful messages (bv not installed, no .beads directory, etc.)
- [ ] Empty states for new repos with no issues
- [ ] Keyboard shortcuts (matching bv where possible: `/` for search, `b` for board, `i` for insights)
- [ ] Light/dark theme toggle

### Phase 4 Acceptance Criteria

- Deployable via Docker with a single command
- README has clear setup instructions
- New user can go from zero to working dashboard in under 10 minutes
- Error states are handled gracefully

---

## Claude Code Instructions

### How to Use This Plan

1. **Read this entire document first** before writing any code
2. Work through phases sequentially — each phase builds on the previous
3. Create Beads issues for each task using `bd add` with `--blocked-by` for dependencies
4. Use tags: `[FEATURE]`, `[TASK]`, `[UI]`, `[API]`, `[CONFIG]`, `[DOCS]`
5. Check `bd ready` to find the next unblocked task

### Architecture Constraints

- **bv is the analytics engine.** Do not reimplement graph algorithms. Shell out to `bv --robot-*` commands for all metric computation.
- **JSONL is the source of truth.** If bv is unavailable, fall back to parsing `.beads/issues.jsonl` directly for basic issue listing (without graph metrics).
- **No database in Phase 1-2.** All data comes from the git repository via bv. State is derived, not stored.
- **TypeScript throughout.** Strong typing for all bv JSON response schemas.
- **Server Components where possible.** Use Next.js App Router server components for initial data fetching, client components only for interactivity.

### Key Dependencies

```json
{
  "dependencies": {
    "next": "^14",
    "react": "^18",
    "react-dom": "^18",
    "@tanstack/react-query": "^5",
    "d3": "^7",
    "recharts": "^2",
    "tailwindcss": "^3",
    "next-auth": "^4"
  }
}
```

### Environment Variables

```env
# Required
BEADS_PROJECT_PATH=/path/to/your/beads-enabled/project

# Optional (Phase 3)
GITHUB_CLIENT_ID=your_github_oauth_client_id
GITHUB_CLIENT_SECRET=your_github_oauth_client_secret
NEXTAUTH_SECRET=random_secret_string
NEXTAUTH_URL=http://localhost:3000

# Optional
BV_PATH=/usr/local/bin/bv          # Path to bv binary if not in PATH
POLL_INTERVAL_MS=30000              # Auto-refresh interval (default 30s)
```

### File Size Guidance

- Keep components under 200 lines each
- Extract shared types to `lib/types.ts`
- Extract bv command execution to `lib/bv-client.ts`
- One API route per file in `app/api/`

### Testing Approach

- Unit tests for `lib/bv-client.ts` with mocked `child_process.exec`
- Component tests for `IssueCard`, `KanbanColumn`, `MetricPanel`
- Integration test: API route returns expected shape when bv output is mocked
- E2E test: Dashboard loads with sample data

---

## Estimated Effort

| Phase | Scope | With AI (your velocity) | Traditional |
|-------|-------|------------------------|-------------|
| 1 — Core MVP | Scaffold, API wrapper, Dashboard, Kanban | 2-3 days | 2-3 weeks |
| 2 — Insights & Viz | 6 metric panels, dependency graph, impact scores | 2-3 days | 2-3 weeks |
| 3 — Multi-Repo & Team | Auth, multi-repo, saved views, time-travel | 3-4 days | 3-4 weeks |
| 4 — Deploy & Docs | Docker, README, polish, error handling | 1-2 days | 1-2 weeks |
| **Total** | | **8-12 days** | **8-12 weeks** |

---

## Open Source & Strategic Value

This project fills a gap in the Beads ecosystem — Steve Yegge's tool has CLI and TUI but no web interface. An open-source web dashboard could:

- Build reputation in the AI tooling community
- Drive traffic to your other projects (xcuitest-goblin, PatchCycle)
- Attract contributors and GitHub stars
- Potentially become the "official" web frontend if Beads adoption grows
- Demonstrate your rapid AI-augmented development capability

**Recommended license:** MIT (matching beads_viewer)

**Relationship to beads_viewer:** This is a complementary project, not a competitor. bv is the TUI for terminal power users; this is the web dashboard for team visibility and non-terminal users. Both use the same underlying Beads data. Credit Jeffrey Emanuel's beads_viewer as the source of the robot protocol API you're wrapping.
