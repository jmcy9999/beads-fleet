# Beads Web User Guide

## 1. Introduction

### What is Beads Web?

Beads Web is a browser-based dashboard for the **Beads** issue tracker. It gives you a visual, interactive interface to view and analyze your project's issues without leaving the browser. Think of it as the web companion to the existing command-line tools.

### What is Beads?

Beads is a git-backed issue tracker created by Steve Yegge. Issues live directly inside your repository in the `.beads/` directory, tracked alongside your code. You manage issues through the `bd` CLI:

```bash
bd add "Fix login timeout"       # Create an issue
bd ready                         # Find available work
bd show bd-a1b2                  # View issue details
bd update bd-a1b2 --status in_progress
bd close bd-a1b2                 # Complete work
bd sync                          # Sync with git
```

### What is beads_viewer / bv?

`bv` (beads_viewer) is a terminal TUI that reads your Beads data and computes graph-theoretic metrics on the dependency relationships between issues. It calculates PageRank, Betweenness Centrality, HITS scores, cycle detection, and more. Its "Robot Protocol" (`bv --robot-*` commands) outputs structured JSON that Beads Web consumes.

### How They Relate

These three tools form a pipeline:

1. **bd** manages issues -- creating, updating, closing, and syncing them in your git repo.
2. **bv** analyzes issues -- reading the dependency graph and computing metrics that reveal bottlenecks, critical paths, and circular dependencies.
3. **Beads Web** displays issues visually -- presenting the data from bd and the analytics from bv in an interactive browser dashboard.

You do not need `bv` installed to use Beads Web. Without it, you get all issue data (from the SQLite database or JSONL file) but no graph-based metrics. With it, you get the full analytics experience.

---

## 2. Getting Started

### Prerequisites

- **Node.js 18+** -- required to run the Next.js application
- **Git** -- your Beads data lives in a git repository
- **bd CLI** installed -- the Beads issue tracker must be initialized in at least one project (the project should contain a `.beads/` directory)
- **bv CLI** (optional) -- install beads_viewer to enable graph metrics on the Insights page

### Installation

```bash
git clone <repository-url> beads-web
cd beads-web
npm install
```

### Configuration

Create a `.env.local` file in the project root:

```bash
# Required: path to a Beads-enabled git repository
BEADS_PROJECT_PATH=/path/to/your/project

# Optional: explicit path to bv binary (if not on PATH)
BV_PATH=

# Optional: polling interval in ms (default 30000)
POLL_INTERVAL_MS=30000
```

The `BEADS_PROJECT_PATH` must point to a directory that contains a `.beads/` subdirectory. This is your primary Beads-enabled project.

### Starting the Application

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### First-Run Wizard

If no repositories are configured, Beads Web displays a setup wizard on first launch. The wizard walks you through three steps:

1. **Welcome** -- introduces the application.
2. **Prerequisites Check** -- verifies that Node.js is running and whether `bv` is available. If bv is not installed, you will see a note that the app will operate in basic mode (no graph metrics).
3. **Add a Repository** -- prompts you to enter the absolute path to your Beads-enabled project. The app validates that a `.beads/` directory exists at that path before accepting it.

After completing the wizard, the dashboard loads with your issue data.

---

## 3. Dashboard (/)

The Dashboard is the main landing page and the first thing you see after setup.

### Summary Cards

At the top of the page, four (or five) summary cards show counts at a glance:

- **Open** -- issues ready for work
- **In Progress** -- issues currently being worked on
- **Blocked** -- issues waiting on dependencies
- **Closed** -- completed issues

### "What's Next?" Panel

When the data includes a highest-impact actionable task (determined by `bv`), a "What's Next?" panel appears below the summary cards. It highlights the single most impactful thing you can work on right now, including how many other issues it would unblock.

### Priority Alerts

If `bv` detects issues where the human-assigned priority diverges significantly from the computed impact score, priority alert cards appear. These help you spot issues that may be under- or over-prioritized.

### Issue Table

Below the panels, a sortable table lists all issues with these columns:

- **ID** -- the Beads issue identifier (e.g., `bd-a1b2`)
- **Title** -- the issue title
- **Status** -- current status badge
- **Priority** -- priority level indicator
- **Owner** -- the assigned person
- **Blocked By** -- count of blocking dependencies

Click any column header to sort by that column. Click again to reverse the sort direction. The table defaults to sorting by priority (highest first).

Click any issue row to navigate to its detail view at `/issue/[id]`.

### Filter Bar

The issue table includes a full filter bar (see Section 10 for details on filtering and saved views).

### Activity Feed

At the bottom, a recent activity feed shows issues that were created, closed, or modified in recent commits. This is powered by the diff API.

---

## 4. Board (/board)

The Board page presents your issues in a Kanban-style layout.

### Columns

Issues are organized into four columns:

- **Open** -- issues available to start
- **In Progress** -- issues someone is actively working on
- **Blocked** -- issues waiting on a dependency to be resolved
- **Closed** -- completed issues

### Issue Cards

Each card in a column displays:

- **Type badge** -- an icon indicating whether the issue is a bug, feature, task, epic, or chore
- **Issue ID** -- the Beads identifier
- **Title** -- the issue title
- **Priority indicator** -- a visual priority level
- **Owner** -- the assigned person (if any)
- **Dependency count** -- how many issues block this one

Cards within each column are sorted by priority, with P0 (Critical) issues at the top.

### Filter Bar

A filter bar sits at the top of the Board page. You can search issues by text, filter by status, priority, or type, and apply saved views. The board shows how many issues match the current filter out of the total count.

### Issue Detail Panel

Click any card to open a slide-in detail panel on the right side of the screen. The panel shows the full issue information including description, dependencies, and metadata. Click the close button or click outside the panel to dismiss it.

---

## 5. Insights (/insights)

The Insights page surfaces graph-based analytics about your issue dependency network. This is where Beads Web differentiates itself from a simple task board -- it shows you the structural properties of your work graph.

### Metric Panels

The page displays a 2-column grid of metric panels:

- **Bottlenecks** (Betweenness Centrality) -- Issues that sit on many shortest paths between other issues. Resolving these removes the most friction from your dependency graph.
- **Keystones** (Critical Path Impact) -- Issues whose resolution unblocks the most downstream work.
- **Influencers** (Eigenvector Centrality) -- Issues connected to other highly-connected issues. These have outsized structural importance.
- **Hubs** (HITS Hub Score) -- Issues that depend on many important issues. Typically epics or features that aggregate dependencies.
- **Authorities** (HITS Authority Score) -- Issues depended on by many important issues. Typically infrastructure or utility tasks.

Each panel shows the top-ranked issues with their ID, title, and metric score. Scores are displayed with colored bars for quick visual scanning.

### Cycle Detection

The **Cycles** panel lists any circular dependency chains found in your issue graph. Circular dependencies (A blocks B blocks C blocks A) are problematic because none of the issues in the cycle can be completed without breaking the loop. Each cycle shows the chain of issue IDs involved.

### Graph Density

Next to the page title, a density badge shows the overall density of your dependency graph:

- **Low density** (under 0.05) -- healthy, not too many cross-dependencies
- **Medium density** (0.05 to 0.15) -- getting complex
- **High density** (above 0.15) -- very interconnected, may indicate overly coupled work items

### Dependency Graph Visualization

At the bottom of the page, an interactive dependency graph renders all issues and their blocking relationships using ReactFlow. Features include:

- **Nodes** represent issues, colored by status
- **Edges** represent blocking relationships
- **Zoom and pan** controls for navigating large graphs
- **Minimap** for orientation in complex graphs

### Without bv

If the `bv` CLI is not installed, the Insights page still loads but all metric panels will be empty. A notice explains that `bv` is needed for graph-based insights. The total issue count is still displayed.

---

## 6. Time Travel / Diff (/diff)

The Time Travel page lets you see how your issues have changed relative to a previous point in your git history.

### Selecting a Reference Point

At the top of the page, choose what to compare against:

- **Preset buttons**: `HEAD~1`, `HEAD~5`, `HEAD~10`, `HEAD~20` -- quick shortcuts for common lookback distances
- **Custom ref input**: Enter any valid git ref -- a commit SHA, a branch name, a tag, or a relative reference like `main~50` or `v1.0.0`

Click a preset button or type a custom ref and click "Compare" to load the diff.

### Summary Statistics

Four cards show the aggregate change counts:

- **New** -- issues that did not exist at the reference point
- **Closed** -- issues that have been closed since then
- **Modified** -- issues that had field changes (status, priority, title, etc.)
- **Reopened** -- issues that were closed at the reference point but are now open

When `bv` provides additional metrics, you may also see:

- **Density Delta** -- how the graph density changed (negative is healthier)
- **Cycles Resolved** -- dependency cycles that no longer exist
- **Cycles Introduced** -- new circular dependencies since the reference point

### Per-Issue Changes

Below the summary, each changed issue is listed with:

- A **change type badge** (NEW, CLOSED, MODIFIED, REOPENED) color-coded for quick scanning
- The **issue ID** (linked to its detail page) and **title**
- For modified issues, a **field-level diff** showing exactly what changed -- the old value crossed out and the new value highlighted

---

## 7. Issue Detail (/issue/[id])

The Issue Detail page shows the complete view of a single issue.

### Header

The header row displays the issue type icon, the issue ID in monospace font, and the issue title.

### Left Column (Main Content)

- **Description** -- the full issue description rendered as text. If no description exists, a placeholder note is shown.
- **Dependencies** section with two lists:
  - **Blocked By** -- issues that must be resolved before this one can proceed. Each shows the ID (linked), title, and current status badge.
  - **Unblocks** -- issues that this issue is blocking. Same format as above.

### Right Sidebar (Metadata)

- **Status** -- current status badge
- **Priority** -- priority indicator with label
- **Owner** -- the assigned person, or "Unassigned"
- **Labels** -- tag badges for any labels on the issue
- **Impact Score** -- when available from `bv`, a progress bar and percentage showing the computed impact score
- **Created** -- creation timestamp and creator
- **Updated** -- last modification timestamp
- **Closed** -- closure timestamp (only shown for closed issues)
- **Close Reason** -- why the issue was closed (only shown if present)

### Navigation

A **Back** button at the top of the page returns you to whatever page you navigated from (Dashboard, Board, Insights, or Diff).

---

## 8. Settings (/settings)

The Settings page lets you manage which Beads-enabled repositories Beads Web tracks.

### Repository List

All configured repositories are listed with their name and absolute path. The currently active repository is highlighted with an "Active" badge and a green border.

For each non-active repository, you can:

- **Set Active** -- make this repo the one all dashboard pages pull data from
- **Remove** -- remove this repo from the configuration

### Add a Repository

Use the form at the bottom to add a new repository:

1. Enter the **absolute path** to the project directory (required). The directory must contain a `.beads/` subdirectory.
2. Optionally enter a **display name**. If omitted, the directory name is used.
3. Click **Add**.

The app validates that a `.beads/` directory exists at the given path before accepting it.

### System Information

At the bottom of the sidebar (visible on all pages), a status indicator shows:

- A green dot and "bv connected" when the `bv` CLI is available
- An amber dot and "JSONL fallback" when `bv` is not found

---

## 9. Multi-Repo Workflow

Beads Web supports working with multiple Beads-enabled projects.

### Adding Repositories

You can add repositories in two ways:

- **Settings page** -- use the "Add Repository" form (see Section 8)
- **BEADS_PROJECT_PATH env var** -- on first launch, if no repos are configured, the path from this environment variable is automatically seeded as the first repository

### Switching Repositories

When you have two or more repositories configured, a **repo selector dropdown** appears in the sidebar (below the Beads Web logo). Click it to see all your repos, then click one to switch. The active repo gets a checkmark.

Switching repos immediately refreshes all data across the entire application -- Dashboard, Board, Insights, and Time Travel all update to reflect the newly selected project.

### Configuration Storage

Multi-repo configuration is stored in `~/.beads-web.json`. This file tracks:

- The list of all configured repositories (name and path)
- Which repository is currently active

This file is created automatically when you add your first repository through the Settings page or the setup wizard.

---

## 10. Filtering and Saved Views

### Filter Bar

The filter bar appears on both the Dashboard (in the issue table) and the Board page. It provides several ways to narrow down what you see.

### Search

A text search field matches against issue IDs, titles, and owner names. Type to filter in real time.

### Status Filter

A multi-select dropdown lets you filter by one or more statuses:

- Open
- In Progress
- Blocked
- Deferred
- Closed
- Pinned

### Priority Filter

A multi-select dropdown lets you filter by priority level:

- P0 Critical
- P1 High
- P2 Medium
- P3 Low
- P4 Minimal

### Type Filter

A multi-select dropdown lets you filter by issue type:

- Bug
- Feature
- Task
- Epic
- Chore

### Built-In Saved Views (Recipes)

Beads Web ships with six built-in views that apply common filter combinations with one click:

| View | What it shows |
|------|---------------|
| **All Issues** | All non-closed issues (open, in progress, blocked, deferred, pinned) |
| **Actionable** | Open issues with no blockers |
| **In Progress** | Only issues with in_progress status |
| **Blocked** | Only blocked issues that have dependencies |
| **High Priority** | P0 and P1 issues that are open, in progress, or blocked |
| **Bugs** | All open bugs (open, in progress, or blocked with type "bug") |

### Custom Saved Views

When you have an active filter combination you want to reuse:

1. Apply your desired filters using the dropdowns and search.
2. A **Save View** button appears on the right side of the filter bar.
3. Click it, enter a name for your view, and click **Save**.

Custom views are stored in your browser's localStorage and appear alongside the built-in views in the recipe selector dropdown.

### Clearing Filters

When any filters are active, a **Clear** button appears that resets all filters to show everything.

---

## 11. Keyboard Shortcuts

Beads Web supports keyboard shortcuts for fast navigation, matching the key bindings from `bv` where applicable.

| Key | Action |
|-----|--------|
| `d` | Go to Dashboard |
| `b` | Go to Board |
| `i` | Go to Insights |
| `t` | Go to Time Travel |
| `s` | Go to Settings |
| `/` | Focus the search input (if a filter bar is present on the current page) |
| `?` | Show / hide the keyboard shortcuts help overlay |
| `Esc` | Close open panels and overlays |

All shortcuts are **disabled** when your cursor is in a text input, textarea, or select field, so they will not interfere with typing.

Modifier key combinations (Ctrl, Cmd, Alt) are also ignored, so browser shortcuts like Ctrl+C continue to work normally.

Press `?` at any time to see the shortcuts help overlay as a reminder.

---

## 12. Data Sources

Beads Web uses a layered data strategy, automatically selecting the best available source.

### Primary: bv Robot Protocol

When the `bv` CLI is installed and reachable, Beads Web calls `bv --robot-*` commands to get structured JSON with full graph metrics:

| Command | Data Returned |
|---------|---------------|
| `bv --robot-plan` | All issues with execution tracks, summary counts, highest impact item |
| `bv --robot-insights` | PageRank, Betweenness, HITS, Eigenvector, cycles, graph density |
| `bv --robot-priority` | Priority recommendations and misalignment detection |
| `bv --robot-diff --diff-since <ref>` | New, closed, modified, reopened issues since a git reference |

This is the richest data source and powers all features including the Insights page metrics.

### Fallback 1: SQLite Database

When `bv` is not available, the app reads directly from `.beads/beads.db` -- the SQLite database that Beads maintains as its fast local cache. This provides:

- Complete issue data (title, description, status, priority, type, owner, labels, timestamps)
- Full dependency information (blocked_by, blocks)
- Accurate issue counts

It does **not** provide graph-based metrics (PageRank, Betweenness, HITS, cycles, etc.), so the Insights page metric panels will be empty.

### Fallback 2: JSONL File

If the SQLite database is also unavailable, the app falls back to reading `.beads/issues.jsonl`, the git-tracked export file. This is a line-delimited JSON file with one issue per line. It may be incomplete or stale if `bd sync` has not been run recently.

### Automatic Selection

You do not need to configure which data source to use. The app tries them in order:

1. `bv` Robot Protocol (if `bv` is on PATH or at `BV_PATH`)
2. SQLite database (if `.beads/beads.db` exists)
3. JSONL file (if `.beads/issues.jsonl` exists)

### Data Refresh

Data refreshes automatically through React Query polling. The default interval is 30 seconds, configurable via the `POLL_INTERVAL_MS` environment variable. Results from `bv` are also cached with a 10-second TTL to avoid redundant subprocess calls during rapid UI refreshes.

---

## 13. Docker Deployment

Beads Web includes a Dockerfile and Docker Compose configuration for containerized deployment.

### Building the Image

```bash
docker build -t beads-web .
```

### Running with Docker

```bash
docker run -p 3000:3000 \
  -v /path/to/your/project:/data/project:ro \
  -e BEADS_PROJECT_PATH=/data/project \
  beads-web
```

This mounts your Beads-enabled project directory as a read-only volume inside the container and tells the app where to find it.

### Running with Docker Compose

Set the `PROJECT_DIR` environment variable to point to your project directory, then start the service:

```bash
PROJECT_DIR=/path/to/your/project docker compose up
```

Or export it first:

```bash
export PROJECT_DIR=/path/to/your/project
docker compose up
```

If `PROJECT_DIR` is not set, Docker Compose defaults to mounting the current directory.

The compose configuration runs on port 3000 and restarts automatically unless explicitly stopped.

### Notes on Docker Deployment

- The project directory is mounted read-only (`:ro`), so the container cannot modify your repository.
- The `bv` CLI is not included in the Docker image by default. The container operates in SQLite/JSONL fallback mode unless you install `bv` in a custom image layer.
- The container runs as a non-root user (`nextjs`) for security.

---

## 14. Troubleshooting

### "No issues showing"

- Verify that `BEADS_PROJECT_PATH` in `.env.local` points to a directory containing a `.beads/` subdirectory.
- Check that the `.beads/beads.db` SQLite database or `.beads/issues.jsonl` file exists and is not empty.
- If using multi-repo configuration, make sure the active repository path is correct on the Settings page.

### "Only a few issues showing"

- The JSONL file (`.beads/issues.jsonl`) may be stale or incomplete. Run `bd sync` in your project to refresh it.
- The app reads from SQLite (`.beads/beads.db`) by default, which should have the full issue set. If both SQLite and JSONL show fewer issues than expected, check that `bd` has synced recently.

### "No graph metrics on Insights page"

- The `bv` (beads_viewer) CLI is not installed or not found on your PATH.
- Install beads_viewer to enable full graph analytics.
- Alternatively, set the `BV_PATH` environment variable to the absolute path of the `bv` binary.
- You can confirm `bv` availability by checking the sidebar status indicator (green dot = connected, amber dot = fallback mode).

### "404 on API routes"

- The Next.js build cache may be corrupted. Delete the `.next/` directory and restart:

```bash
rm -rf .next && npm run dev
```

### Health Check

Visit [http://localhost:3000/api/health](http://localhost:3000/api/health) in your browser to see a JSON response with system status:

```json
{
  "bv_available": true,
  "project_path": "/path/to/your/project",
  "project_valid": true
}
```

- `bv_available` -- whether the bv CLI was found and responded
- `project_path` -- the currently active project path
- `project_valid` -- whether the path exists and contains a `.beads/` directory

### Common Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `BEADS_PROJECT_PATH` | Yes (for first setup) | none | Path to your Beads-enabled project |
| `BV_PATH` | No | `bv` (from PATH) | Explicit path to the bv binary |
| `POLL_INTERVAL_MS` | No | `30000` | Auto-refresh interval in milliseconds |
