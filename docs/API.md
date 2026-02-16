# Beads Web API Reference

Full reference for all 13 API endpoints. All routes are Next.js App Router API handlers under `/src/app/api/`.

Base URL: `http://localhost:3000` (development)

---

## Table of Contents

1. [Core](#1-core)
   - [GET /api/health](#get-apihealth)
   - [GET /api/issues](#get-apiissues)
   - [GET /api/issues/:id](#get-apiissuesid)
   - [GET /api/insights](#get-apiinsights)
   - [GET /api/priority](#get-apipriority)
   - [GET /api/diff](#get-apidiff)
2. [Repository Management](#2-repository-management)
   - [GET /api/repos](#get-apirepos)
   - [POST /api/repos](#post-apirepos)
3. [Issue Actions](#3-issue-actions)
   - [POST /api/issues/:id/action](#post-apiissuesidaction)
4. [Token Usage & Analytics](#4-token-usage--analytics)
   - [GET /api/token-usage](#get-apitoken-usage)
5. [Agent Orchestration](#5-agent-orchestration)
   - [GET /api/agent](#get-apiagent)
   - [POST /api/agent](#post-apiagent)
   - [GET /api/signals](#get-apisignals)
6. [Pipeline Management](#6-pipeline-management)
   - [POST /api/fleet/action](#post-apifleetaction)
   - [GET /api/research/:name](#get-apiresearchname)

---

## 1. Core

### GET /api/health

System health check. Reports whether `bv` is available and whether the active project path is valid.

**Query Parameters:** None

**Response Body:**

```typescript
interface HealthResponse {
  bv_available: boolean;
  project_path: string;
  project_valid: boolean;
}
```

**Example:**

```bash
curl http://localhost:3000/api/health
```

```json
{
  "bv_available": true,
  "project_path": "/home/user/my-project",
  "project_valid": true
}
```

---

### GET /api/issues

Returns all issues from the active repository (or all configured repositories in aggregation mode), including summary counts and track grouping.

**Query Parameters:** None

**Response Body:**

```typescript
interface RobotPlan {
  timestamp: string;
  project_path: string;
  summary: {
    open_count: number;
    in_progress_count: number;
    blocked_count: number;
    closed_count: number;
    highest_impact?: {
      issue_id: string;
      title: string;
      impact_score: number;
      unblocks_count?: number;
    };
  };
  tracks: Array<{
    track_number: number;
    label?: string;
    issues: PlanIssue[];
  }>;
  all_issues: PlanIssue[];
}

interface PlanIssue {
  id: string;
  title: string;
  status: "open" | "in_progress" | "blocked" | "deferred" | "closed" | "pinned";
  priority: 0 | 1 | 2 | 3 | 4;
  issue_type: "bug" | "feature" | "task" | "epic" | "chore";
  owner?: string;
  labels?: string[];
  blocked_by: string[];
  blocks: string[];
  impact_score?: number;
  story_points?: number;
  epic?: string;
  epic_title?: string;
}
```

**Example:**

```bash
curl http://localhost:3000/api/issues
```

```json
{
  "timestamp": "2026-02-16T10:30:00.000Z",
  "project_path": "/home/user/my-project",
  "summary": {
    "open_count": 12,
    "in_progress_count": 3,
    "blocked_count": 1,
    "closed_count": 45,
    "highest_impact": {
      "issue_id": "my-project-42",
      "title": "Refactor auth module",
      "impact_score": 0.85,
      "unblocks_count": 4
    }
  },
  "tracks": [
    {
      "track_number": 1,
      "label": "Critical path",
      "issues": []
    }
  ],
  "all_issues": [
    {
      "id": "my-project-42",
      "title": "Refactor auth module",
      "status": "open",
      "priority": 1,
      "issue_type": "task",
      "owner": "alice",
      "labels": ["backend"],
      "blocked_by": [],
      "blocks": ["my-project-43", "my-project-44"],
      "impact_score": 0.85
    }
  ]
}
```

---

### GET /api/issues/:id

Returns a single issue by ID, including both the plan-level view and the full raw issue data (description, notes, timestamps). In aggregation mode, searches all configured repositories.

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | `string` | The issue ID |

**Response Body:**

```typescript
interface IssueDetailResponse {
  plan_issue: PlanIssue;
  raw_issue: BeadsIssue | null;
}

interface BeadsIssue {
  id: string;
  title: string;
  description?: string;
  status: "open" | "in_progress" | "blocked" | "deferred" | "closed" | "pinned";
  priority: 0 | 1 | 2 | 3 | 4;
  issue_type: "bug" | "feature" | "task" | "epic" | "chore";
  owner?: string;
  parent?: string;
  story_points?: number;
  labels?: string[];
  dependencies?: Array<{
    issue_id: string;
    depends_on_id: string;
    type: string;
    created_at: string;
    created_by: string;
  }>;
  created_at: string;
  created_by?: string;
  updated_at: string;
  closed_at?: string;
  close_reason?: string;
  notes?: string;
}
```

**Example:**

```bash
curl http://localhost:3000/api/issues/my-project-42
```

```json
{
  "plan_issue": {
    "id": "my-project-42",
    "title": "Refactor auth module",
    "status": "open",
    "priority": 1,
    "issue_type": "task",
    "blocked_by": [],
    "blocks": ["my-project-43"]
  },
  "raw_issue": {
    "id": "my-project-42",
    "title": "Refactor auth module",
    "description": "Extract auth logic into a separate service layer.",
    "status": "open",
    "priority": 1,
    "issue_type": "task",
    "owner": "alice",
    "labels": ["backend", "refactor"],
    "created_at": "2026-02-10T09:00:00.000Z",
    "updated_at": "2026-02-15T14:30:00.000Z"
  }
}
```

**Error Responses:**

- `404` -- Issue not found
- `500` -- Server error

---

### GET /api/insights

Graph-based analytics for the active project. Returns bottleneck scores, keystone issues, HITS influencer/authority rankings, dependency cycles, and graph density. Falls back to an in-process graph computation when `bv` is unavailable.

**Query Parameters:** None

**Response Body:**

```typescript
interface RobotInsights {
  timestamp: string;
  project_path: string;
  total_issues: number;
  graph_density: number;
  bottlenecks: GraphMetricEntry[];
  keystones: GraphMetricEntry[];
  influencers: GraphMetricEntry[];
  hubs: GraphMetricEntry[];
  authorities: GraphMetricEntry[];
  cycles: CycleInfo[];
  topological_order?: string[];
}

interface GraphMetricEntry {
  issue_id: string;
  title: string;
  score: number;
}

interface CycleInfo {
  cycle_id: number;
  issues: string[];
  length: number;
}
```

**Example:**

```bash
curl http://localhost:3000/api/insights
```

```json
{
  "timestamp": "2026-02-16T10:30:00.000Z",
  "project_path": "/home/user/my-project",
  "total_issues": 61,
  "graph_density": 0.042,
  "bottlenecks": [
    { "issue_id": "my-project-42", "title": "Refactor auth module", "score": 0.15 }
  ],
  "keystones": [
    { "issue_id": "my-project-10", "title": "Core data model", "score": 0.32 }
  ],
  "influencers": [],
  "hubs": [],
  "authorities": [],
  "cycles": [
    { "cycle_id": 1, "issues": ["my-project-7", "my-project-12"], "length": 2 }
  ]
}
```

---

### GET /api/priority

Priority recommendations from graph analysis. Compares each issue's current priority with a recommended priority based on dependency impact, and provides a confidence score and reason.

**Query Parameters:** None

**Response Body:**

```typescript
interface RobotPriority {
  timestamp: string;
  project_path: string;
  recommendations: PriorityRecommendation[];
  aligned_count: number;
  misaligned_count: number;
}

interface PriorityRecommendation {
  issue_id: string;
  title: string;
  current_priority: 0 | 1 | 2 | 3 | 4;
  recommended_priority: 0 | 1 | 2 | 3 | 4;
  confidence: number;
  reason: string;
  impact_score?: number;
}
```

**Example:**

```bash
curl http://localhost:3000/api/priority
```

```json
{
  "timestamp": "2026-02-16T10:30:00.000Z",
  "project_path": "/home/user/my-project",
  "recommendations": [
    {
      "issue_id": "my-project-42",
      "title": "Refactor auth module",
      "current_priority": 2,
      "recommended_priority": 1,
      "confidence": 0.87,
      "reason": "Blocks 4 downstream issues; raising priority would unblock the critical path.",
      "impact_score": 0.85
    }
  ],
  "aligned_count": 48,
  "misaligned_count": 5
}
```

---

### GET /api/diff

Shows issue changes since a given git reference. Compares the current issue state with a historical snapshot from git, detecting new, closed, modified, and reopened issues. Falls back to a git-based JSONL snapshot comparison when `bv` returns empty results.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `since` | `string` | `HEAD~5` | Git reference to diff against (e.g. `HEAD~1`, `HEAD~10`, a branch name, a commit SHA) |

The `since` parameter is validated against the pattern `/^[a-zA-Z0-9~^._\-/]+$/`. Invalid refs are rejected with a `400` response.

**Response Body:**

```typescript
interface RobotDiff {
  timestamp: string;
  project_path: string;
  since_ref: string;
  new_count: number;
  closed_count: number;
  modified_count: number;
  reopened_count: number;
  changes: DiffIssueChange[];
  density_delta?: number;
  cycles_resolved?: number;
  cycles_introduced?: number;
}

interface DiffIssueChange {
  issue_id: string;
  title: string;
  change_type: "new" | "closed" | "modified" | "reopened";
  changed_fields?: string[];
  previous_values?: Record<string, unknown>;
  new_values?: Record<string, unknown>;
}
```

**Example:**

```bash
curl "http://localhost:3000/api/diff?since=HEAD~3"
```

```json
{
  "timestamp": "2026-02-16T10:30:00.000Z",
  "project_path": "/home/user/my-project",
  "since_ref": "HEAD~3",
  "new_count": 2,
  "closed_count": 1,
  "modified_count": 3,
  "reopened_count": 0,
  "changes": [
    {
      "issue_id": "my-project-60",
      "title": "Add dark mode toggle",
      "change_type": "new"
    },
    {
      "issue_id": "my-project-42",
      "title": "Refactor auth module",
      "change_type": "modified",
      "changed_fields": ["status", "priority"],
      "previous_values": { "status": "open", "priority": 2 },
      "new_values": { "status": "in_progress", "priority": 1 }
    },
    {
      "issue_id": "my-project-15",
      "title": "Fix login timeout",
      "change_type": "closed"
    }
  ]
}
```

---

## 2. Repository Management

### GET /api/repos

Lists all configured repositories, the currently active repo, and configured watch directories. Automatically scans watch directories for new Beads-enabled projects on each call.

**Query Parameters:** None

**Response Body:**

```typescript
interface ReposResponse {
  repos: Array<{
    name: string;
    path: string;
  }>;
  activeRepo?: string;
  watchDirs: string[];
}
```

**Example:**

```bash
curl http://localhost:3000/api/repos
```

```json
{
  "repos": [
    { "name": "my-project", "path": "/home/user/my-project" },
    { "name": "other-project", "path": "/home/user/other-project" }
  ],
  "activeRepo": "/home/user/my-project",
  "watchDirs": ["/home/user/projects"]
}
```

### POST /api/repos

Manage repositories: add, remove, set active, scan watch directories, or update watch directory configuration.

**Request Body:**

```typescript
interface ReposPostRequest {
  action: "add" | "remove" | "set-active" | "scan" | "set-watch-dirs";
  path?: string;      // Required for add, remove, set-active
  name?: string;      // Optional display name (used with add)
  dirs?: string[];     // Required for set-watch-dirs
}
```

**Actions:**

| Action | Required Fields | Description |
|--------|----------------|-------------|
| `add` | `path` | Register a new Beads-enabled repository. Must contain a `.beads/` directory. |
| `remove` | `path` | Remove a repository from the configuration. |
| `set-active` | `path` | Set the active repository. Pass `"__all__"` for aggregation mode. |
| `scan` | (none) | Scan watch directories for new projects. Returns newly discovered paths. |
| `set-watch-dirs` | `dirs` | Set the list of directories to watch for auto-discovery. |

**Response Body:**

For `add`, `remove`, `set-active`, `set-watch-dirs`:

```typescript
interface RepoStore {
  repos: Array<{ name: string; path: string }>;
  activeRepo?: string;
  watchDirs?: string[];
}
```

For `scan`:

```typescript
interface ScanResponse extends RepoStore {
  newlyRegistered: string[];  // Paths of newly discovered projects
}
```

**Examples:**

```bash
# Add a repository
curl -X POST http://localhost:3000/api/repos \
  -H "Content-Type: application/json" \
  -d '{"action": "add", "path": "/home/user/new-project", "name": "New Project"}'

# Switch to aggregation mode
curl -X POST http://localhost:3000/api/repos \
  -H "Content-Type: application/json" \
  -d '{"action": "set-active", "path": "__all__"}'

# Scan for new projects
curl -X POST http://localhost:3000/api/repos \
  -H "Content-Type: application/json" \
  -d '{"action": "scan"}'

# Set watch directories
curl -X POST http://localhost:3000/api/repos \
  -H "Content-Type: application/json" \
  -d '{"action": "set-watch-dirs", "dirs": ["/home/user/projects", "/home/user/work"]}'
```

```json
{
  "repos": [
    { "name": "my-project", "path": "/home/user/my-project" },
    { "name": "New Project", "path": "/home/user/new-project" }
  ],
  "activeRepo": "/home/user/my-project"
}
```

---

## 3. Issue Actions

### POST /api/issues/:id/action

Perform lifecycle actions on an issue by shelling out to the `bd` CLI. Supported actions: start (set to in_progress), close, reopen (set to open), and comment. In aggregation mode, the endpoint automatically resolves which repository contains the issue.

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | `string` | The issue ID. Must match `/^[a-zA-Z0-9_-]+$/`. |

**Request Body:**

```typescript
interface IssueActionRequest {
  action: "start" | "close" | "reopen" | "comment";
  reason?: string;  // Required for "comment"; optional close reason for "close"
}
```

**Response Body (success):**

```typescript
interface IssueActionResponse {
  success: true;
  action: string;
  issueId: string;
}
```

**Examples:**

```bash
# Start working on an issue
curl -X POST http://localhost:3000/api/issues/my-project-42/action \
  -H "Content-Type: application/json" \
  -d '{"action": "start"}'

# Close an issue with a reason
curl -X POST http://localhost:3000/api/issues/my-project-42/action \
  -H "Content-Type: application/json" \
  -d '{"action": "close", "reason": "Completed in PR #87"}'

# Add a comment
curl -X POST http://localhost:3000/api/issues/my-project-42/action \
  -H "Content-Type: application/json" \
  -d '{"action": "comment", "reason": "Waiting on upstream dependency."}'

# Reopen an issue
curl -X POST http://localhost:3000/api/issues/my-project-42/action \
  -H "Content-Type: application/json" \
  -d '{"action": "reopen"}'
```

```json
{
  "success": true,
  "action": "close",
  "issueId": "my-project-42"
}
```

**Error Responses:**

- `400` -- Invalid issue ID format, invalid JSON body, invalid action, or missing comment text
- `404` -- Issue not found in any configured repo (aggregation mode)
- `500` -- `bd` CLI execution failed

---

## 4. Token Usage & Analytics

### GET /api/token-usage

Reads token usage records from `.beads/token-usage.jsonl` in the active project (or all configured projects in aggregation mode). Supports returning raw records or aggregated per-issue summaries.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `summary` | `string` | (none) | Set to `"true"` to return aggregated per-issue summaries instead of raw records |
| `issue_id` | `string` | (none) | Filter raw records to a specific issue ID (ignored when `summary=true`) |

**Response Body (raw records, default):**

```typescript
type TokenUsageResponse = TokenUsageRecord[];

interface TokenUsageRecord {
  timestamp: string;
  session_id: string;
  issue_id: string;
  project: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  total_cost_usd: number;
  duration_ms: number;
  num_turns: number;
}
```

**Response Body (summary mode, `?summary=true`):**

```typescript
interface TokenUsageSummary {
  byIssue: Record<string, IssueTokenSummary>;
  totals: IssueTokenSummary;
}

interface IssueTokenSummary {
  issue_id: string;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_creation_tokens: number;
  total_tokens: number;
  total_cost_usd: number;
  session_count: number;
  total_duration_ms: number;
  total_turns: number;
  first_session: string;
  last_session: string;
}
```

**Examples:**

```bash
# Get all raw token usage records
curl http://localhost:3000/api/token-usage

# Get aggregated summary
curl "http://localhost:3000/api/token-usage?summary=true"

# Get records for a specific issue
curl "http://localhost:3000/api/token-usage?issue_id=my-project-42"
```

Raw records response:

```json
[
  {
    "timestamp": "2026-02-15T14:30:00.000Z",
    "session_id": "sess-abc123",
    "issue_id": "my-project-42",
    "project": "my-project",
    "model": "claude-opus-4-6",
    "input_tokens": 15000,
    "output_tokens": 3200,
    "cache_read_tokens": 8000,
    "cache_creation_tokens": 500,
    "total_cost_usd": 0.42,
    "duration_ms": 120000,
    "num_turns": 15
  }
]
```

Summary response:

```json
{
  "byIssue": {
    "my-project-42": {
      "issue_id": "my-project-42",
      "total_input_tokens": 45000,
      "total_output_tokens": 9600,
      "total_cache_read_tokens": 24000,
      "total_cache_creation_tokens": 1500,
      "total_tokens": 80100,
      "total_cost_usd": 1.26,
      "session_count": 3,
      "total_duration_ms": 360000,
      "total_turns": 45,
      "first_session": "2026-02-14T09:00:00.000Z",
      "last_session": "2026-02-15T14:30:00.000Z"
    }
  },
  "totals": {
    "issue_id": "_totals",
    "total_input_tokens": 120000,
    "total_output_tokens": 25000,
    "total_cache_read_tokens": 60000,
    "total_cache_creation_tokens": 4000,
    "total_tokens": 209000,
    "total_cost_usd": 3.85,
    "session_count": 10,
    "total_duration_ms": 900000,
    "total_turns": 120,
    "first_session": "2026-02-10T09:00:00.000Z",
    "last_session": "2026-02-15T14:30:00.000Z"
  }
}
```

---

## 5. Agent Orchestration

### GET /api/agent

Returns the current status of the managed Claude Code agent process. Only one agent can run at a time. Includes the last 2KB of log output when an agent is active.

**Query Parameters:** None

**Response Body:**

```typescript
interface AgentStatus {
  running: boolean;
  session: AgentSession | null;
  recentLog?: string;
}

interface AgentSession {
  pid: number;
  repoPath: string;
  repoName: string;
  prompt: string;
  model: string;
  startedAt: string;
  logFile: string;
  epicId?: string;
  pipelineStage?: string;
}
```

**Example:**

```bash
curl http://localhost:3000/api/agent
```

When an agent is running:

```json
{
  "running": true,
  "session": {
    "pid": 54321,
    "repoPath": "/home/user/my-project",
    "repoName": "my-project",
    "prompt": "Implement the auth refactor described in issue my-project-42.",
    "model": "opus",
    "startedAt": "2026-02-16T10:00:00.000Z",
    "logFile": "/tmp/beads-web-agent-logs/agent-my-project-2026-02-16T10-00-00-000Z.log",
    "epicId": "my-project-1",
    "pipelineStage": "development"
  },
  "recentLog": "... last 2KB of agent output ..."
}
```

When no agent is running:

```json
{
  "running": false,
  "session": null
}
```

### POST /api/agent

Launch or stop a Claude Code agent. Only one agent can run at a time; attempting to launch while another is active returns `409 Conflict`.

**Request Body (launch):**

```typescript
interface AgentLaunchRequest {
  action: "launch";
  repoPath: string;          // Must be a configured repository path
  prompt: string;             // The prompt/instructions for the agent
  model?: string;             // Claude model to use (default: "sonnet")
  maxTurns?: number;          // Maximum conversation turns (default: 200)
  allowedTools?: string;      // Comma-separated tool list (default: "Bash,Read,Write,Edit,Glob,Grep")
  epicId?: string;            // Optional epic ID for pipeline label management
  pipelineStage?: string;     // Optional pipeline stage (e.g. "research", "development")
}
```

**Request Body (stop):**

```typescript
interface AgentStopRequest {
  action: "stop";
  epicId?: string;           // Optional: remove agent:running label from this epic
  repoPath?: string;         // Optional: repo path for label resolution
}
```

**Response Body (launch success):**

```typescript
interface AgentLaunchResponse {
  launched: true;
  session: AgentSession;
}
```

**Response Body (stop success):**

```typescript
interface AgentStopResponse {
  stopped: boolean;
  pid?: number;
}
```

**Examples:**

```bash
# Launch an agent
curl -X POST http://localhost:3000/api/agent \
  -H "Content-Type: application/json" \
  -d '{
    "action": "launch",
    "repoPath": "/home/user/my-project",
    "prompt": "Fix the failing tests in the auth module.",
    "model": "opus",
    "maxTurns": 100,
    "allowedTools": "Bash,Read,Write,Edit,Glob,Grep"
  }'

# Stop the running agent
curl -X POST http://localhost:3000/api/agent \
  -H "Content-Type: application/json" \
  -d '{"action": "stop"}'
```

Launch response:

```json
{
  "launched": true,
  "session": {
    "pid": 54321,
    "repoPath": "/home/user/my-project",
    "repoName": "my-project",
    "prompt": "Fix the failing tests in the auth module.",
    "model": "opus",
    "startedAt": "2026-02-16T10:00:00.000Z",
    "logFile": "/tmp/beads-web-agent-logs/agent-my-project-2026-02-16T10-00-00-000Z.log"
  }
}
```

Stop response:

```json
{
  "stopped": true,
  "pid": 54321
}
```

**Error Responses:**

- `400` -- Missing repoPath/prompt, unknown action, or repository not configured
- `409` -- Agent already running (must stop first)
- `500` -- Launch/stop failed

---

### GET /api/signals

Polling endpoint for detecting issue state changes. Returns issues that changed since a given timestamp, with optional filtering by label and status. Useful for automation scripts, CI pipelines, and orchestration systems that need to react to issue transitions.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `since` | `string` | (required) | ISO 8601 timestamp. Returns issues changed after this time. |
| `label` | `string` | (none) | Filter to issues with this label. Repeatable -- when multiple labels are specified, the issue must have ALL of them. |
| `status` | `string` | `"closed"` | Filter by issue status. |
| `field` | `string` | `"closed_at"` | Which timestamp field to check: `"closed_at"` or `"updated_at"`. |

**Response Body:**

```typescript
interface SignalsResponse {
  signals: Signal[];
  count: number;
  since: string;
}

interface Signal {
  id: string;
  title: string;
  status: string;
  labels: string[];
  closed_at: string | null;
  close_reason: string | null;
  epic: string | null;
  updated_at: string;
}
```

**Examples:**

```bash
# Get issues closed since a specific time
curl "http://localhost:3000/api/signals?since=2026-02-15T00:00:00Z"

# Get closed issues with a specific label
curl "http://localhost:3000/api/signals?since=2026-02-15T00:00:00Z&label=research"

# Get issues updated (not just closed) since a time
curl "http://localhost:3000/api/signals?since=2026-02-15T00:00:00Z&field=updated_at&status=in_progress"

# Filter by multiple labels (AND logic)
curl "http://localhost:3000/api/signals?since=2026-02-15T00:00:00Z&label=research&label=high-priority"
```

```json
{
  "signals": [
    {
      "id": "my-project-55",
      "title": "Research competitor landscape",
      "status": "closed",
      "labels": ["research"],
      "closed_at": "2026-02-15T18:30:00.000Z",
      "close_reason": "Research complete. Report saved.",
      "epic": "my-project-1",
      "updated_at": "2026-02-15T18:30:00.000Z"
    }
  ],
  "count": 1,
  "since": "2026-02-15T00:00:00Z"
}
```

**Error Responses:**

- `400` -- Missing or invalid `since` parameter, or invalid `field` value
- `503` -- `BEADS_PROJECT_PATH` not configured

---

## 6. Pipeline Management

### POST /api/fleet/action

Execute pipeline actions on epics, moving them through configurable project stages. Each action updates labels on the epic issue and may launch or stop a Claude Code agent to perform automated work. The pipeline stages and their transitions are fully customizable.

**Request Body:**

```typescript
interface FleetActionRequest {
  epicId: string;                  // The epic issue ID
  epicTitle: string;               // The epic title (used for agent prompts and name derivation)
  action: PipelineAction;          // The action to perform
  feedback?: string;               // Optional feedback text (used by some actions)
  currentLabels?: string[];        // Current labels on the epic (used for cleanup)
}

type PipelineAction =
  | "start-research"         // Move to research stage, launch research agent
  | "send-for-development"   // Move to development stage, launch dev agent
  | "more-research"          // Loop back to research with optional feedback
  | "deprioritise"           // Move to deprioritised/closed state
  | "approve-submission"     // Move to submission stage, launch submission agent
  | "send-back-to-dev"       // Loop back to development with optional feedback
  | "mark-as-live"           // Move to post-launch stage, launch analysis agent
  | "stop-agent";            // Stop the currently running agent for this epic
```

**Response Body (success):**

```typescript
// For actions that launch an agent:
interface FleetActionAgentResponse {
  success: true;
  action: string;
  epicId: string;
  session: AgentSession;
}

// For actions that don't launch an agent (deprioritise, stop-agent):
interface FleetActionSimpleResponse {
  success: true;
  action: string;
  epicId: string;
}
```

**Examples:**

```bash
# Start research on an epic
curl -X POST http://localhost:3000/api/fleet/action \
  -H "Content-Type: application/json" \
  -d '{
    "epicId": "project-100",
    "epicTitle": "MyFeature: Add export functionality",
    "action": "start-research"
  }'

# Send for development after research is complete
curl -X POST http://localhost:3000/api/fleet/action \
  -H "Content-Type: application/json" \
  -d '{
    "epicId": "project-100",
    "epicTitle": "MyFeature: Add export functionality",
    "action": "send-for-development"
  }'

# Request more research with feedback
curl -X POST http://localhost:3000/api/fleet/action \
  -H "Content-Type: application/json" \
  -d '{
    "epicId": "project-100",
    "epicTitle": "MyFeature: Add export functionality",
    "action": "more-research",
    "feedback": "Needs competitive analysis of similar tools."
  }'

# Deprioritise an epic
curl -X POST http://localhost:3000/api/fleet/action \
  -H "Content-Type: application/json" \
  -d '{
    "epicId": "project-100",
    "epicTitle": "MyFeature: Add export functionality",
    "action": "deprioritise",
    "feedback": "Market too small.",
    "currentLabels": ["pipeline:research-complete"]
  }'

# Stop the running agent for an epic
curl -X POST http://localhost:3000/api/fleet/action \
  -H "Content-Type: application/json" \
  -d '{
    "epicId": "project-100",
    "epicTitle": "MyFeature: Add export functionality",
    "action": "stop-agent"
  }'
```

```json
{
  "success": true,
  "action": "start-research",
  "epicId": "project-100",
  "session": {
    "pid": 54321,
    "repoPath": "/home/user/my-project",
    "repoName": "my-project",
    "prompt": "Research the idea \"MyFeature: Add export functionality\" (epic: project-100).",
    "model": "opus",
    "startedAt": "2026-02-16T10:00:00.000Z",
    "logFile": "/tmp/beads-web-agent-logs/agent-my-project-2026-02-16T10-00-00-000Z.log",
    "epicId": "project-100",
    "pipelineStage": "research"
  }
}
```

**Pipeline Stage Transitions:**

| Action | From Stage | To Stage | Agent Launched? |
|--------|-----------|----------|----------------|
| `start-research` | (new) | `research` | Yes |
| `send-for-development` | `research-complete` | `development` | Yes |
| `more-research` | `research-complete` | `research` | Yes |
| `deprioritise` | any | `bad-idea` (closed) | No |
| `approve-submission` | `submission-prep` | `submitted` | Yes |
| `send-back-to-dev` | `submission-prep` | `development` | Yes |
| `mark-as-live` | `submitted` | `kit-management` | Yes |
| `stop-agent` | any | (unchanged) | No (stops running agent) |

When an agent finishes (exit code 0), it automatically advances the epic to the next pipeline stage via label transitions:

| Agent Stage | Auto-Advances To |
|------------|-----------------|
| `research` | `research-complete` |
| `development` | `submission-prep` |
| `submission-prep` | `submitted` |
| `kit-management` | `completed` |

**Error Responses:**

- `400` -- Missing epicId/epicTitle, or invalid action
- `500` -- Pipeline action or agent launch failed

---

### GET /api/research/:name

Reads a markdown research report for a given project name. Searches through all configured repositories for a file at `apps/<name>/research/report.md` and returns the first match. This is a generic endpoint for retrieving structured markdown reports stored in a conventional location within any repository.

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | `string` | The project name. Must match `/^[a-zA-Z0-9_-]+$/`. |

**Response Body (success):**

```typescript
interface ResearchReportResponse {
  content: string;     // Raw markdown content of the report
  repoPath: string;    // Path to the repository where the report was found
}
```

**Example:**

```bash
curl http://localhost:3000/api/research/MyFeature
```

```json
{
  "content": "# MyFeature Research Report\n\n## Market Analysis\n\n...",
  "repoPath": "/home/user/my-project"
}
```

**Error Responses:**

- `400` -- Invalid project name format
- `404` -- No research report found for the given name in any configured repository
- `500` -- File read error

---

## Error Response Format

All endpoints use a consistent error format:

```typescript
interface ErrorResponse {
  error: string;
  detail?: string;
}
```

Common HTTP status codes:

| Code | Meaning |
|------|---------|
| `400` | Bad request -- invalid parameters or request body |
| `404` | Not found -- issue or resource does not exist |
| `409` | Conflict -- agent already running |
| `500` | Internal server error |
| `503` | Service unavailable -- `BEADS_PROJECT_PATH` not configured |
