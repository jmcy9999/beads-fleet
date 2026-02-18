# Beads Fleet Architecture

> **Keep this document current.** Update it whenever features, data flows, APIs, or file structure change. Agents working on this codebase depend on it for context.

## What This Is

A Next.js 14 dark-themed web dashboard for the **Beads** git-backed issue tracker. It visualizes issues, dependencies, graph analytics, token usage, and project health across multiple beads-enabled repositories.

**Tech stack:** Next.js 14, React 18, TanStack React Query 5, ReactFlow 11, better-sqlite3, Tailwind CSS 3, TypeScript 5.

## Beads Data Model

### Storage

Each beads-enabled project has a `.beads/` directory containing:
- **`beads.db`** — SQLite database (source of truth). Tables: `issues`, `labels`, `dependencies`, `comments`, `events`, `config`, `metadata`, and others.
- **`issues.jsonl`** — JSON Lines export (one issue per line). Created by `bd sync`. May be stale — always prefer SQLite.
- **`token-usage.jsonl`** — JSON Lines with per-session token/cost records.

### Issue Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique ID with project prefix (e.g. `PatchCycle-9m2`, `beads-abc`) |
| `title` | string | Short summary |
| `description` | string? | Detailed description |
| `status` | string | See statuses below |
| `priority` | 0-4 | 0=critical, 1=high, 2=medium, 3=low, 4=backlog |
| `issue_type` | string | `bug`, `feature`, `task`, `epic`, `chore` |
| `owner` | string? | Assigned person/agent |
| `labels` | string[]? | Arbitrary tags. Dashboard uses `project:<name>` for multi-repo filtering |
| `story_points` | number? | Optional, not present in all beads DB versions |
| `dependencies` | array? | See dependencies below |
| `parent` | string? | Parent epic ID (from parent-child dependencies) |
| `created_at` | ISO timestamp | |
| `updated_at` | ISO timestamp | |
| `closed_at` | ISO timestamp? | Set when status becomes `closed` |
| `close_reason` | string? | Why it was closed |
| `created_by` | string? | Who created it |
| `notes` | string? | Research reports, extended notes. Optional, detected via PRAGMA |

### Statuses

| Status | Meaning | Dashboard Display |
|--------|---------|-------------------|
| `open` | Ready to work | Green dot |
| `in_progress` | Actively being worked | Amber dot |
| `blocked` | Waiting on a dependency | Red dot |
| `deferred` | Postponed | Purple dot |
| `closed` | Done | Gray checkmark |
| `pinned` | Permanently visible | Blue pin |

### Dependencies

Stored in the `dependencies` table / `dependencies[]` array on each issue:

```json
{
  "issue_id": "app-123",       // this issue...
  "depends_on_id": "app-456",  // ...depends on this one
  "type": "blocks",            // or "parent-child" for epic membership
  "created_at": "...",
  "created_by": "..."
}
```

- **`blocks` type:** `depends_on_id` blocks `issue_id`. Issue can't proceed until dependency is resolved.
- **`parent-child` type:** `depends_on_id` is the parent epic, `issue_id` is a child task.

The dashboard computes two derived fields per issue:
- `blocked_by[]` — all issues this one depends on
- `blocks[]` — all issues that depend on this one

### Token Usage Records

Each line in `token-usage.jsonl`:

| Field | Type | Description |
|-------|------|-------------|
| `timestamp` | ISO timestamp | When the session ended |
| `session_id` | string | Claude session ID |
| `issue_id` | string | Which beads issue this work was for |
| `project` | string | Project name |
| `model` | string | Model used (e.g. `claude-sonnet-4-5-20250929`) |
| `input_tokens` | number | |
| `output_tokens` | number | |
| `cache_read_tokens` | number | |
| `cache_creation_tokens` | number | |
| `total_cost_usd` | number | |
| `duration_ms` | number | Session duration |
| `num_turns` | number | Agent turns in session |

### How the Dashboard Reads Beads

1. `sqlite-reader.ts` opens `.beads/beads.db` in readonly mode. Uses `PRAGMA table_info` to detect which columns exist (handles schema differences across beads versions).
2. If SQLite fails or DB is missing, falls back to parsing `.beads/issues.jsonl` line by line.
3. `bv-client.ts` tries the `bv` CLI first (richer graph analytics), falls back to the SQLite/JSONL path.
4. Issues are converted to `PlanIssue` objects with resolved dependency cross-references, epic associations, and `project:` labels.
5. API routes serve this data as JSON. React hooks poll every 30-60 seconds.

### Creating Beads for Different Workflows

Use the `bd` CLI to create issues. The dashboard will pick them up automatically.

**App builds:**
```bash
bd create --title="Build MyApp v1.0" --type=epic --priority=1
bd create --title="Set up Xcode project" --type=task --priority=1
bd create --title="Implement core UI" --type=feature --priority=1
bd create --title="Add CycleKit integration" --type=task --priority=2
bd dep add <ui-task> <setup-task>  # UI depends on project setup
```

**Research phases:**
```bash
bd create --title="Investigate auth approaches" --type=task --priority=2
bd create --title="Evaluate SwiftData vs CoreData" --type=task --priority=2
# Close with findings as the close_reason
bd close <id> --reason="SwiftData chosen - simpler API, sufficient for our needs"
```

**Kit enhancements (CycleKit, etc.):**
```bash
bd create --title="Add hormone level tracking to CycleKit" --type=feature --priority=2
bd create --title="Write tests for hormone tracking" --type=task --priority=2
bd dep add <tests-id> <feature-id>  # Tests depend on feature
```

**Bootstrap tasks (new project setup):**
```bash
bd create --title="Initialize project from template" --type=task --priority=1
bd create --title="Configure CI/CD" --type=chore --priority=2
bd create --title="Register with beads_fleet dashboard" --type=chore --priority=3
```

**Registering a new project with the dashboard:**
```bash
# From within the new project directory (must have .beads/ already):
curl -X POST http://localhost:3000/api/repos \
  -H "Content-Type: application/json" \
  -d '{"action": "add", "path": "/absolute/path/to/project", "name": "MyApp"}'
```

Or add it directly to `~/.beads-web.json`:
```json
{
  "repos": [
    { "name": "MyApp", "path": "/absolute/path/to/project" }
  ]
}
```

## Features

### Issue Tracking Dashboard
- Full issue table with sort by 9 columns (id, project, title, status, priority, owner, epic, blockers, cost)
- Status summary cards (total, open, in_progress, blocked, closed)
- Highest-impact issue highlight ("What's Next")
- Recent activity feed (new/closed/modified/reopened from git diff)
- Mobile-responsive: table on desktop, card grid on mobile

### Kanban Board
- Columns by status: open, in_progress, blocked, closed
- Sorted by priority within each column
- Click-to-open slide-in detail panel with full issue info, dependencies, and **workflow action buttons**

### Graph Analytics (Insights)
- Bottlenecks (betweenness centrality) — issues that are gateway dependencies
- Keystones (critical path impact) — issues that transitively unblock the most work
- Influencers (eigenvector centrality) — most connected issues
- Hubs/Authorities (HITS algorithm) — issues that depend on many vs are depended on by many
- Dependency cycle detection (Tarjan's SCC)
- Graph density metric with color-coded badge
- Interactive dependency graph (ReactFlow) with status-colored nodes and cycle-highlighted edges

### Time Travel Diff
- Compare current issue state against any git ref (HEAD~1, HEAD~5, HEAD~10, HEAD~20, or custom)
- Shows new/closed/modified/reopened issue counts
- Field-level diffs (what changed on modified issues)
- Density delta and cycle change tracking

### Multi-Project Support
- Switch between beads-enabled repos via header dropdown
- "All Projects" aggregation mode merges issues across all repos
- Issues labeled with `project:<repoName>` for filtering
- Token usage aggregated across projects
- Config stored in `~/.beads-web.json`

### Filtering & Saved Views
- Filter by: status, priority, type, owner, labels, label prefix, project, epic, has blockers, is stale, is recent, search text
- Built-in views: All Issues, Actionable, In Progress, Blocked, High Priority, Bugs, **Submissions**
- **Submissions view:** Filters issues with `submission:*` labels (ready, in-review, approved, rejected)
- Save custom filter combinations as named views (localStorage)

### Research Report Display
- **API endpoint:** `GET /api/research/[appName]` reads markdown reports from factory repo at `apps/<appName>/research/report.md`
- **Multi-repo search:** Searches all configured repos for the report file, returns first match
- **Markdown rendering:** Uses `react-markdown` with `remark-gfm` for full GitHub-flavored markdown (tables, task lists, strikethrough, etc.)
- **Issue detail integration:** When viewing a `research`-labeled issue, the app name is derived from the parent epic title (e.g., "LensCycle: Market research" -> epic "LensCycle: Contact lens app" -> appName "LensCycle")
- **Styled for dark mode:** Custom Tailwind prose classes for dark theme rendering
- **Security:** App name validated against `^[a-zA-Z0-9_-]+$` to prevent path traversal

### Plan Viewer
- **API endpoint:** `GET /api/plan/[issueId]` reads markdown plan documents from `.beads/plans/<issueId>.md` in configured repos
- **Multi-repo search:** Searches all configured repos for the plan file, returns first match
- **Keyed by issue ID:** Plans use the issue ID directly (e.g., `bw-0i9.1.md`), not app name
- **Markdown rendering:** Uses `react-markdown` with `remark-gfm`, same dark-mode prose styling as research reports
- **Issue detail integration:** Plan section appears for any issue that has a matching plan file. Gracefully hidden when no plan exists (404/empty)
- **Visual distinction:** Plan heading uses purple color (`text-purple-400`) and purple-tinted blockquote borders, distinguishing it from the research report section
- **Security:** Issue ID validated against `^[a-zA-Z0-9_.-]+$` to prevent path traversal
- **Hook:** `usePlanReport(issueId)` — mirrors `useResearchReport` structure with TanStack Query, 60s staleTime, `keepPreviousData`

### Token Usage Tracking
- Dashboard summary: total tokens, total cost, session count, total turns
- Per-issue detail: sessions table with model, tokens, cost, duration, turns
- Reads from `.beads/token-usage.jsonl`

### Cost Per App (Epic Cost Aggregation)
- **Fleet cards:** Each app card shows total cost with phase breakdown (research/development/submission/other)
- **Fleet page header:** Shows fleet-wide total cost across all apps
- **Issue detail page:** Epic-type issues show an "App Cost" section with total cost, session count, and per-phase cost bars with percentages
- **Phase classification:** Children's labels determine phase — `research` label = research, `development` label = development, `submission:*` labels = submission, anything else = other
- **Data flow:** Client-side aggregation — `useTokenUsageSummary()` provides per-issue costs, `computeEpicCosts()` in `fleet-utils.ts` maps children costs up to their parent epic
- **Phase ordering:** research → development → submission → other (pipeline order)

### Priority Intelligence
- Detects misaligned priorities (current vs recommended based on graph position)
- Shows confidence score and reason for each recommendation
- Up to 3 alerts on dashboard

### Issue Detail Page
- Full description, status, priority, owner, labels, type
- **Notes section:** Displays research reports and extended notes from `notes` field (only when non-empty)
- **Plan section:** Displays plan documents from `.beads/plans/<issueId>.md` with purple-themed heading. Shown for any issue with a matching plan file, gracefully hidden otherwise
- **Workflow action buttons:** Start Work (open), Close with reason (in_progress/blocked/deferred), Reopen (closed), Comment (adds comment to issue)
- **Factory research workflow:** When an issue has the `research` label, additional buttons appear: "Approve & Send to Development" (closes with approval reason) and "Request More Research" (adds a comment with feedback text). Available on both the issue detail page and kanban slide-in panel.
- **Planning phase buttons:** At Research Complete, the issue detail page shows the same three-state button logic as FleetCard based on `plan:pending`/`plan:approved` labels: Generate Plan / More Research / Deprioritise (no plan), Approve Plan / Revise Plan / Deprioritise (plan:pending), Begin Construction / Revise Plan / Deprioritise (plan:approved). At Candidates, "Skip to Plan" is available. At Prepare for Launch, "Revise Plan" sends the app back to planning with feedback.
- Dependency tree: blocked by / unblocks (with titles resolved)
- **Epic children with progress:** For epic issues, lists all child issues with a progress bar showing completion percentage (closed/total)
- **Parent epic link:** For child issues, sidebar shows clickable link to parent epic
- **App Cost section:** For epic-type issues, shows aggregated cost across the epic and all children, with per-phase breakdown bars (research/development/submission/other)
- Token usage sessions table
- Timestamps (created, updated, closed) and close reason

### Epic Progress Bars
- **IssueCard (card variant):** Epic-type issues show a progress bar below the title (closed/total children)
- **IssueCard (row variant):** Epic column shows progress bar below the epic link
- **IssueDetailPanel:** Epic issues show a progress bar in the slide-in panel
- **Issue detail page:** Children section header shows "Children (X/Y — Z%)" with progress bar
- Progress computed from `allIssues` where `issue.epic === epicId`, counting `status === "closed"` as complete

### App Store Submission Tracking
- Uses existing label system: `submission:ready`, `submission:in-review`, `submission:approved`, `submission:rejected`
- **Colored badges:** IssueCard renders `submission:*` labels with colored badges (ready=blue, in-review=amber, approved=green, rejected=red)
- **Built-in "Submissions" view:** Filters for any issue with a `submission:*` label using the `labelPrefix` filter
- Factory agent labels issues via `bd label add <id> submission:ready` etc.

### App Fleet Dashboard
- **Pipeline view:** Epics displayed as "ships" in a fleet voyage kanban with 9 stages: Harbour | Recon | Charted | Under Construction | Sea Trials | Launched | Refit | Deployed | Scuttled
- **Compact layout:** Columns are 180-220px wide with tight gaps (gap-2), small card padding (p-2), 10px IDs, xs-size titles, uppercase column headers — optimized for fitting all stages on screen
- **Stage detection:** Automatic based on `pipeline:*` labels on epics — `pipeline:idea`, `pipeline:research`, `pipeline:research-complete`, `pipeline:development`, `pipeline:submission-prep`, `pipeline:submitted`, `pipeline:kit-management`, `pipeline:completed`, `pipeline:bad-idea`
- **Fleet cards:** Each app shows epic title, progress bar (closed/total children), priority, active/blocked task counts, submission status badges, cost breakdown by phase, phase history dots, stage-specific action buttons, and owner
- **Zoom controls:** User-controlled CSS transform scaling (50%-150%) via magnifying glass +/-/reset buttons in the toolbar. Uses `transform: scale(X)` with `transformOrigin: "top left"` and compensating `width: ${100/scale}%`
- **Column filter:** Funnel icon dropdown with checkboxes for each pipeline stage. Toggle individual columns on/off (minimum one must remain visible). "Show all" link when filtered. Filter state persisted in localStorage (`beads-fleet-visible-columns`). Funnel icon turns blue when columns are hidden
- **Pipeline actions:** Stage-specific action buttons on each card — Start Research / Skip to Plan (Candidates), Stop Agent (Research/Development/Refit when agent running), Generate Plan / More Research / Deprioritise (Research Complete, no plan), Approve Plan / Revise Plan / Deprioritise (Research Complete, plan:pending), Begin Construction / Revise Plan / Deprioritise (Research Complete, plan:approved), Launch / Send Back / Revise Plan (Prepare for Launch), Mark Deployed (Launched). Actions dispatched via `onPipelineAction` callback to the fleet page
- **Planning phase:** At Research Complete, the card shows three sub-states based on `plan:pending` and `plan:approved` labels. "Generate Plan" launches a planning agent in the app repo; `plan:pending` is added automatically on agent exit (not at launch). "Approve Plan" is a label-only change (removes `plan:pending`, adds `plan:approved`). "Revise Plan" re-launches the planning agent with optional feedback (clears plan labels, `plan:pending` re-added on exit). "Skip to Plan" from Candidates bypasses research entirely. "Revise Plan" from Prepare for Launch returns to the planning phase
- **Phase history:** Each card shows a row of colored dots representing all pipeline stages — past stages solid, current stage pulsing, future stages dimmed
- **Empty state:** Guidance on how to create epics and label children to use the fleet view
- **Navigation:** Sidebar link + keyboard shortcut `f`
- **Components:** `FleetBoard` (client component with zoom/filter state) -> `FleetColumn` -> `FleetCard`, with `fleet-utils.ts` for stage detection, fleet data extraction, and phase history

### Research Completion Signals (Polling API)
- **`GET /api/signals`** — Polling endpoint for detecting issue state changes
- **Required param:** `since` (ISO timestamp) — returns issues changed after this time
- **Optional params:** `label` (filter by label, repeatable, AND logic), `status` (default "closed"), `field` (check "closed_at" or "updated_at")
- **Response:** `{ signals: [{ id, title, status, labels, closed_at, close_reason, epic, updated_at }], count, since }`
- **Factory use case:** Agent polls `GET /api/signals?since=<last-check>&label=research` to detect when research tasks close, then prompts Jane for review
- **Multi-repo:** Supports `__all__` aggregation mode — merges signals across all projects

### Auto-Registration (Watch Directories)
- **Watch directories:** Configure parent directories in Settings. The dashboard scans each for subdirectories containing `.beads/` and auto-registers new projects.
- **Auto-scan on load:** `GET /api/repos` automatically runs `scanWatchDirs()` on every call, so new projects appear as soon as you refresh.
- **Manual scan:** "Scan Now" button in Settings triggers an immediate scan and reports newly found projects.
- **API actions:** `POST /api/repos` supports `scan` (trigger scan) and `set-watch-dirs` (set watch directory list) actions.
- **Config:** `watchDirs` array stored in `~/.beads-web.json` alongside `repos` and `activeRepo`.
- **Factory use case:** Factory sets a watch directory (e.g., `~/dev/apps/`) and every new app project created by the factory auto-appears in the dashboard.

### Agent Activity Timeline
- **Visual timeline:** Sessions displayed as horizontal color-coded bars on a time axis, grouped by day
- **Day groups:** Each day shows a bar chart of sessions with time axis, plus a session list with issue links, duration, tokens, and cost
- **Color coding:** Sessions colored by issue phase — research (blue), development (amber), submission (purple), epic (green), other (cyan)
- **Tooltips:** Hovering over a timeline bar shows session details: issue, time range, duration, tokens, cost, turns, model
- **Summary stats:** Total sessions, duration, tokens, cost, and unique issues across the timeline
- **Fleet page:** Full timeline below the pipeline board, showing all agent activity across all issues
- **Issue detail page:** Per-issue timeline showing all sessions that worked on that specific issue
- **Data source:** `TokenUsageRecord[]` from `useTokenUsage()` — each record has `timestamp` (session end), `duration_ms` (used to compute start time), `session_id`, `issue_id`, `total_cost_usd`, token counts, and `model`
- **Utilities:** `timeline-utils.ts` provides pure functions: `buildTimelineEntries()`, `groupByDay()`, `formatDuration()`, `formatTokens()`, `computeBarPosition()`, `getEntryColor()`
- **Expandable:** Shows most recent 5-7 days by default with "Show more" to expand

### Agent Launch (Remote Claude Execution)
- **Generic API:** `GET /api/agent` returns current status; `POST /api/agent` with `action: "launch"` or `action: "stop"` manages a background Claude Code process
- **Backend:** `agent-launcher.ts` spawns `claude -p "<prompt>"` as a detached subprocess via `child_process.spawn()`, tracks PID, pipes output to log file
- **Safety:** Only one agent can run at a time. Repo path must be in `~/.beads-web.json` config. `CLAUDECODE` env var unset to avoid "nested session" error
- **Agent status:** Polls every 5 seconds via `useAgentStatus()`. Shows animated `AgentStatusBanner` on fleet page when running (model, elapsed time, PID, stop button)
- **Fleet integration:** Idea-stage app cards show a "Start Research" button. Clicking launches Claude in the factory repo with a research prompt. Button disabled while an agent is already running.
- **Hooks:** `useAgentLaunch()` (mutation), `useAgentStop()` (mutation), `useAgentStatus()` (polling query)
- **Launch params:** `repoPath`, `prompt`, `model` (default: sonnet), `maxTurns` (default: 200), `allowedTools` (default: common tools)
- **Process management:** Detached process (`child.unref()`) survives API restarts. Stop sends `SIGTERM` to process group. On exit, session state auto-clears.
- **Exit transitions:** On clean exit (code 0), the launcher removes `agent:running` and applies stage-specific transitions: research -> `pipeline:research-complete`, development -> `pipeline:submission-prep`, submission-prep -> `pipeline:submitted`, kit-management -> `pipeline:completed`. Planning agents add `plan:pending` on exit (via `EXIT_LABELS` mapping) without advancing the pipeline stage.
- **Logs:** Written to `$TMPDIR/beads-web-agent-logs/agent-<repo>-<timestamp>.log`. Status endpoint returns last 2KB of log.

### Collapsible Sidebar
- **Toggle:** Double chevron button at the bottom of the sidebar toggles between expanded (w-64) and collapsed (w-16) states
- **Collapsed mode:** Icon-only navigation with tooltip titles on each nav link. Brand text, nav labels, version text, and bv status text are hidden
- **Smooth animation:** CSS `transition-all duration-200` for width change
- **Logo:** Always visible in both states (icon only in collapsed mode)
- **Tests:** 17 tests in `__tests__/components/Sidebar.test.tsx` covering expanded state, collapsed state, toggle round-trip, and logo visibility

### System Health & Setup
- Health check: bv CLI availability, project path validity
- Setup wizard for first-time users (prerequisites check, add first repo)
- Keyboard shortcuts: d(ashboard), b(oard), f(leet), i(nsights), t(ime travel), s(ettings), /(search), ?(help)
- Live indicator with auto-polling (30s issues, 60s insights/tokens)

### Graceful Degradation
- Works without `bv` CLI installed (falls back to SQLite/JSONL for basic data)
- Schema-tolerant SQLite reader (handles different beads DB versions)
- Graph metrics computed locally when bv unavailable (approximate but functional)

## Data Flow

```
.beads/beads.db (SQLite)   ─┐
.beads/issues.jsonl         ─┤── sqlite-reader.ts / jsonl-fallback.ts ──┐
.beads/token-usage.jsonl    ─┘                                          │
                                                                        v
bv CLI (--robot-plan/insights/priority/diff)                            │
        │                                                               │
        v                                                               v
  bv-client.ts  <── graph-metrics.ts (fallback analytics)
  (normalizes bv output + 10s TTL cache)
        │
        v
  API Routes (src/app/api/**)
        │
        v
  React Hooks (useIssues, useInsights, etc.)
  (TanStack Query, 15s stale, 30-60s polling)
        │
        v
  UI Components (pages, dashboard, board, insights)
```

**Fallback chain:** bv CLI -> SQLite DB -> JSONL file -> empty response. The app works without `bv` installed.

**Multi-repo aggregation:** When `activeRepo === "__all__"`, API routes fetch each repo's data in parallel directly from each project's `.beads/beads.db`, merge results, and add `project:<repoName>` labels for filtering. There is no hub or intermediary database — every read goes to the real project DB.

**Issue mutations:** The action route (`POST /api/issues/[id]/action`) uses `findRepoForIssue()` to resolve which project DB contains the issue, then runs `bd` in that project directory. This works in both single-project and `__all__` aggregation mode.

## Pages

| Route | Page | What It Shows |
|-------|------|---------------|
| `/` | Dashboard | Summary cards (open/in_progress/blocked/closed counts), token usage totals, highest-impact issue, priority misalignment alerts, full issue table with sort/filter, recent activity feed |
| `/board` | Kanban Board | Issues grouped by status columns (open, in_progress, blocked, closed), click-to-open detail panel |
| `/fleet` | App Fleet | Fleet voyage kanban — epics as ships across 9 stages (Harbour through Deployed), with zoom controls, column filter, and pipeline action buttons |
| `/insights` | Graph Analytics | Bottlenecks, keystones, influencers, hubs, authorities (top-5 bar charts), dependency cycles, graph density, interactive ReactFlow dependency graph |
| `/diff` | Time Travel | Compare current state against a git ref (HEAD~1/5/10/20 or custom), shows new/closed/modified/reopened issues with field-level diffs |
| `/settings` | Settings | Add/remove/switch repos, stored in `~/.beads-web.json` |
| `/issue/[id]` | Issue Detail | Full issue: description, dependency tree, status/priority/owner/labels, token usage per session |

## API Routes

| Endpoint | Method | Returns | Notes |
|----------|--------|---------|-------|
| `/api/issues` | GET | `RobotPlan` (all_issues, tracks, summary) | Supports `__all__` aggregation |
| `/api/issues/[id]` | GET | `{ plan_issue, raw_issue }` | Single issue with raw JSONL data |
| `/api/issues/[id]/action` | POST | `{ success, action, issueId }` | Body: `{ action: "start"\|"close"\|"reopen"\|"comment", reason? }`. Shells out to `bd` CLI. Comment requires `reason` (text). |
| `/api/insights` | GET | `RobotInsights` (bottlenecks, keystones, etc.) | Graph metrics |
| `/api/priority` | GET | `RobotPriority` (recommendations[]) | Priority misalignment detection |
| `/api/diff?since=REF` | GET | `RobotDiff` (changes[]) | Git ref validated against safe pattern |
| `/api/health` | GET | `{ bv_available, project_path, project_valid }` | System health check |
| `/api/repos` | GET | `RepoStore` (repos[], activeRepo) | Repo config |
| `/api/repos` | POST | `RepoStore` | Actions: `add`, `remove`, `set-active` (path required); `scan` (trigger watch dir scan); `set-watch-dirs` (dirs[] required) |
| `/api/token-usage` | GET | `TokenUsageRecord[]` or summary | Params: `summary=true`, `issue_id=X`. Supports `__all__` |
| `/api/research/[appName]` | GET | `{ content, repoPath }` | Reads `apps/<appName>/research/report.md` from configured repos. 404 if not found |
| `/api/plan/[issueId]` | GET | `{ content, repoPath }` | Reads `.beads/plans/<issueId>.md` from configured repos. 404 if not found |
| `/api/signals` | GET | `{ signals[], count, since }` | Params: `since` (required), `label`, `status`, `field`. Polling for state changes. Supports `__all__` |
| `/api/agent` | GET | `AgentStatus` (running, session, recentLog) | Current agent process status |
| `/api/agent` | POST | `{ launched, session }` or `{ stopped, pid }` | Body: `{ action: "launch", repoPath, prompt, model?, maxTurns?, allowedTools? }` or `{ action: "stop" }`. 409 if already running |
| `/api/fleet/action` | POST | `{ success, action, epicId, session? }` | Body: `{ epicId, epicTitle, action, feedback?, currentLabels? }`. Actions: `start-research`, `send-for-development`, `more-research`, `deprioritise`, `approve-submission`, `send-back-to-dev`, `mark-as-live`, `stop-agent`, `generate-plan`, `approve-plan`, `revise-plan`, `skip-to-plan`, `revise-plan-from-launch` |

## Core Library Modules

### `src/lib/bv-client.ts` (central data layer)
Wraps `bv --robot-*` CLI commands via `execFile`. Normalizes PascalCase bv output to TypeScript types. 10-second TTL cache. Falls back to SQLite/JSONL when bv unavailable.

Key exports:
- `getPlan(projectPath?)` -> `RobotPlan`
- `getInsights(projectPath?)` -> `RobotInsights`
- `getPriority(projectPath?)` -> `RobotPriority`
- `getDiff(since, projectPath?)` -> `RobotDiff`
- `getIssueById(issueId, projectPath?)` -> `{ plan_issue, raw_issue }`
- `getAllProjectsPlan(repoPaths)` -> merged `RobotPlan` with `project:` labels
- `invalidateCache()` -> clears all cached responses

### `src/lib/sqlite-reader.ts`
Reads `.beads/beads.db` via `better-sqlite3` (readonly). Dynamically detects optional columns (e.g. `story_points`) via `PRAGMA table_info` to handle schema differences across beads versions. Returns `null` if DB missing (triggers JSONL fallback).

### `src/lib/jsonl-fallback.ts`
- `readIssuesFromJSONL(projectPath)` -> tries SQLite first, then `.beads/issues.jsonl`
- `issuesToPlan(issues, projectPath)` -> converts `BeadsIssue[]` to `RobotPlan` with dependency cross-references

### `src/lib/graph-metrics.ts`
Computes approximate graph metrics when bv unavailable: betweenness centrality (bottlenecks), transitive unblock count (keystones), degree centrality (hubs/authorities/influencers), Tarjan's SCC (cycles).

### `src/lib/repo-config.ts`
Manages `~/.beads-web.json`. `ALL_PROJECTS_SENTINEL = "__all__"` enables aggregation mode. Exports: `getActiveProjectPath()`, `getAllRepoPaths()`, `addRepo()`, `removeRepo()`, `setActiveRepo()`, `getRepos()`, `findRepoForIssue()`.

- **`findRepoForIssue(issueId)`** — Resolves which repo an issue belongs to by checking each configured repo's SQLite DB. Used by the action route to run `bd` in the correct project directory, even in `__all__` aggregation mode.

### `src/lib/recipes.ts`
Filter engine. `FilterCriteria` supports: statuses, priorities, types, owner, labels, labelPrefix, projects, epic, hasBlockers, isStale, isRecent, search text. Built-in views: All Issues, Actionable, In Progress, Blocked, High Priority, Bugs, Submissions. Custom views saved to localStorage.

### `src/lib/token-usage.ts`
Reads `.beads/token-usage.jsonl`. Provides raw records and per-issue aggregated summaries (tokens, cost, sessions, duration, turns).

### `src/lib/agent-launcher.ts`
Spawns Claude Code CLI as a detached background subprocess. Manages one active session at a time. Exports: `launchAgent(options)`, `getAgentStatus()`, `stopAgent()`. Types: `AgentSession`, `LaunchOptions`, `AgentStatus`.

### `src/lib/cache.ts`
Simple TTL cache (10-second default). Used by bv-client to avoid redundant subprocess calls.

### `src/lib/types.ts`
All TypeScript types:
- **Core:** `BeadsIssue`, `IssueDependency`, `IssueStatus`, `IssueType`, `Priority` (0-4)
- **Robot protocol:** `RobotPlan`, `RobotInsights`, `RobotPriority`, `RobotDiff`, `PlanIssue`, `PlanSummary`, `PlanTrack`
- **UI config:** `STATUS_CONFIG`, `PRIORITY_CONFIG`, `KANBAN_COLUMNS`
- **Token:** `TokenUsageRecord`, `IssueTokenSummary`

## React Hooks

| Hook | Fetches | Polling |
|------|---------|---------|
| `useIssues()` | `/api/issues` -> `RobotPlan` | 30s |
| `useIssueDetail(id)` | `/api/issues/[id]` | 30s |
| `useInsights()` | `/api/insights` -> `RobotInsights` | 60s |
| `usePriority()` | `/api/priority` -> `RobotPriority` | 60s |
| `useDiff(since)` | `/api/diff?since=X` -> `RobotDiff` | none |
| `useHealth()` | `/api/health` | 60s |
| `useRepos()` | `/api/repos` -> `RepoStore` | none (60s stale) |
| `useIssueAction()` | POST `/api/issues/[id]/action` | invalidates issues, issue, insights, priority |
| `useResearchReport(appName)` | `/api/research/[appName]` | 60s stale, enabled only when appName non-null |
| `usePlanReport(issueId)` | `/api/plan/[issueId]` | 60s stale, enabled only when issueId non-null |
| `useRepoMutation()` | POST `/api/repos` | invalidates all queries |
| `useTokenUsage(issueId?)` | `/api/token-usage` | 60s |
| `useTokenUsageSummary()` | `/api/token-usage?summary=true` | 60s |
| `useAgentStatus()` | GET `/api/agent` | 5s (while agent may be running) |
| `useAgentLaunch()` | POST `/api/agent` (launch) | invalidates agent-status |
| `useAgentStop()` | POST `/api/agent` (stop) | invalidates agent-status |
| `usePipelineAction()` | POST `/api/fleet/action` | Pipeline stage transitions (start-research, send-for-development, generate-plan, approve-plan, revise-plan, skip-to-plan, revise-plan-from-launch, etc.) |
| `useKeyboardShortcuts()` | -- | d/b/f/i/t/s navigation, / search, ? help |

## Component Tree

```
layout.tsx (server)
  QueryProvider
    ClientShell (ErrorBoundary + SetupWizard + ShortcutsHelp)
      Sidebar (collapsible: nav links, RepoSelector, health indicator; collapsed = icon-only with tooltips)
      Header (breadcrumb with project selector dropdown)
      <main> (page content)
```

### Key Components
- **Dashboard:** `SummaryCards`, `TokenUsageSummary`, `WhatsNext`, `PriorityAlerts`, `IssueTable` (with `FilterBar`), `ActivityFeed`
- **Board:** `KanbanBoard` -> `KanbanColumn` -> `IssueCard`, `IssueDetailPanel` (slide-in)
- **Fleet:** `FleetBoard` (client component: zoom controls, column filter, compact layout) -> `FleetColumn` (compact 180-220px, uppercase headers) -> `FleetCard` (compact p-2, pipeline actions, phase history dots, cost breakdown), `AgentStatusBanner` (running agent indicator), `ActivityTimeline` (agent session visualization), `fleet-utils.ts` (stage detection, data extraction, phase history), `timeline-utils.ts` (timeline data processing)
- **Insights:** `MetricPanel` (bar charts), `CyclesPanel`, `GraphDensityBadge`, `DependencyGraph` (ReactFlow)
- **Filters:** `FilterBar`, `RecipeSelector`
- **UI primitives:** `StatusBadge`, `PriorityIndicator`, `IssueTypeIcon`, `SummaryCard`, `IssueCard` (row/card variants), `EmptyState`, `ErrorState`, `LoadingSkeleton`

## Multi-Repo Support

Config stored in `~/.beads-web.json`:
```json
{
  "repos": [
    { "name": "PatchCycle", "path": "/path/to/PatchCycle" },
    { "name": "beads_fleet", "path": "/path/to/beads_fleet" }
  ],
  "activeRepo": "/path/to/PatchCycle"  // or "__all__" for aggregation
}
```

- Header shows project selector dropdown when 2+ repos configured
- "All Projects" option sets `activeRepo` to `"__all__"`
- API routes detect `__all__` and aggregate across all repo paths
- Issues get `project:<repoName>` labels for filtering in the UI
- `useRepoMutation()` invalidates all data queries on project switch

## Design System

Dark mode with 4-tier surface palette:
- `surface-0` (#0f1117) -> `surface-3` (#2f323c)
- Status colors: open (green), progress (amber), blocked (red), closed (gray), deferred (purple), pinned (blue)
- Priority: critical (red), high (orange), medium (amber), low (green), minimal (gray)
- Font: Inter (UI), JetBrains Mono (monospace)
- Border: `border-default` (#353845)

## Important Patterns

1. **Schema tolerance:** SQLite reader checks which columns exist via `PRAGMA table_info` before querying. Different beads versions have different schemas (e.g. `story_points` is optional).
2. **Graceful degradation:** Every data path has a fallback chain. Never crashes on missing data.
3. **Security:** CLI calls use `execFile` (not `exec`). Diff `since` param validated against safe regex. Issue mutations go through `bd` CLI (validated issue ID + action). Mutations resolve the correct project via `findRepoForIssue()` so they always target the real project DB.
4. **Cache invalidation:** bv-client has 10s server TTL. React Query has 15s stale time + polling. Repo switch invalidates everything.

## Claude Code Hooks

Three global hooks installed at `~/.claude/hooks/` (canonical copies tracked in `scripts/hooks/`):

### `beads-collect-tokens.sh` (Stop hook)
Fires when a Claude Code session ends. Extracts token usage from the session transcript and writes a normalized record to `.beads/token-usage.jsonl`.

- **Token extraction:** Sums `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` from all assistant entries in the transcript JSONL.
- **Model:** Reads `.message.model` from the first non-synthetic assistant entry.
- **Cost calculation:** Multiplies token counts by model pricing (Opus: $15/$75/$1.875/$18.75 per M; Sonnet: $3/$15/$0.375/$3.75; Haiku: $0.80/$4/$0.10/$1).
- **Duration:** Computed from first to last timestamp in the transcript.
- **Turns:** Count of `user`-type entries in the transcript.
- **Issue attribution:** Looks up `issue_id` from `.beads/.session-map.jsonl` (keyed by `session_id`), falls back to `.beads/.current-issue`.
- **Deduplication:** If a record for the same `session_id` already exists, removes it before writing (the Stop hook can fire multiple times per session on resume/clear).

### `beads-session-start.sh` (SessionStart hook)
Fires when a Claude Code session starts or resumes. Detects beads-enabled projects (checks for `.beads/` directory), finds the active `in_progress` issue via `bd list`, and writes a session-to-issue mapping to `.beads/.session-map.jsonl`. Also sets OTEL environment variables.

### `beads-track-issue.sh` (PostToolUse hook)
Fires after Bash tool calls. Watches for `bd update <id> --status=in_progress` commands to track mid-session issue switches. Updates `.beads/.current-issue` and appends an `issue_switch` event to `.beads/.session-map.jsonl`.

### Data files written by hooks
| File | Written by | Purpose |
|------|-----------|---------|
| `.beads/token-usage.jsonl` | collect-tokens | One record per session with token counts, cost, model, duration, turns |
| `.beads/.session-map.jsonl` | session-start, track-issue | Maps session_id to issue_id (session_start and issue_switch events) |
| `.beads/.current-issue` | session-start, track-issue | Current active issue ID (single line, used as fallback for attribution) |

## File Structure

```
src/
  app/
    layout.tsx              # Root layout (server component)
    page.tsx                # Dashboard
    globals.css             # Custom scrollbar, card classes, animations
    board/page.tsx          # Kanban board
    fleet/page.tsx          # App fleet pipeline dashboard
    insights/page.tsx       # Graph analytics
    diff/page.tsx           # Time travel diff
    settings/page.tsx       # Repo management
    issue/[id]/page.tsx     # Issue detail
    api/
      issues/route.ts       # GET issues (supports __all__)
      issues/[id]/route.ts  # GET single issue
      issues/[id]/action/route.ts  # POST start/close/reopen
      insights/route.ts     # GET graph metrics
      priority/route.ts     # GET priority recommendations
      diff/route.ts         # GET diff since git ref
      health/route.ts       # GET system health
      repos/route.ts        # GET/POST repo config
      token-usage/route.ts  # GET token usage (supports __all__)
      research/[appName]/route.ts  # GET research report markdown
      plan/[issueId]/route.ts     # GET plan document markdown
      signals/route.ts      # GET polling endpoint for state changes
      agent/route.ts        # GET/POST agent launch/stop/status
      fleet/action/route.ts # POST pipeline actions (plan, research, dev transitions)
  lib/
    bv-client.ts            # Central data layer (bv CLI wrapper)
    types.ts                # All TypeScript types
    sqlite-reader.ts        # SQLite DB reader
    jsonl-fallback.ts       # JSONL fallback + issuesToPlan
    graph-metrics.ts        # Fallback graph analytics
    repo-config.ts          # Multi-repo config (~/.beads-web.json)
    recipes.ts              # Filter engine + saved views
    token-usage.ts          # Token usage reader
    cache.ts                # TTL cache
  hooks/
    useIssues.ts            # Issues data hook
    useIssueDetail.ts       # Single issue hook
    useInsights.ts          # Graph metrics hook
    usePriority.ts          # Priority recommendations hook
    useDiff.ts              # Diff hook
    useHealth.ts            # Health check hook
    useIssueAction.ts       # Issue status mutation (start/close/reopen)
    useRepos.ts             # Repo config + mutation hook
    useTokenUsage.ts        # Token usage hooks
    useResearchReport.ts    # Research report fetcher
    usePlanReport.ts        # Plan document fetcher
    useAgent.ts             # Agent launch/stop/status hooks
    usePipelineAction.ts    # Fleet pipeline stage transition mutation
    useKeyboardShortcuts.ts # Keyboard navigation
  components/
    providers/              # QueryProvider, ClientShell
    layout/                 # Sidebar, Header
    dashboard/              # SummaryCards, WhatsNext, PriorityAlerts, IssueTable, ActivityFeed, TokenUsageSummary
    board/                  # KanbanBoard, KanbanColumn, IssueDetailPanel
    fleet/                  # FleetBoard, FleetColumn, FleetCard, AgentStatusBanner, ActivityTimeline, fleet-utils, timeline-utils
    insights/               # MetricPanel, CyclesPanel, GraphDensityBadge, DependencyGraph
    filters/                # FilterBar, RecipeSelector
    ui/                     # StatusBadge, PriorityIndicator, IssueTypeIcon, SummaryCard, IssueCard, EmptyState, ErrorState, LoadingSkeleton, ErrorBoundary, ShortcutsHelp, SetupWizard
__tests__/
  components/
    Sidebar.test.tsx        # 17 tests for collapsible sidebar
scripts/
  hooks/
    beads-collect-tokens.sh   # Stop hook: token usage collection (canonical copy)
    beads-session-start.sh    # SessionStart hook: issue attribution setup
    beads-track-issue.sh      # PostToolUse hook: mid-session issue tracking
  install-bv.sh               # Install bv CLI
```
