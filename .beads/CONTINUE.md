# Continuation Notes — 2026-02-15

## What just happened

Completed all major factory integration features for beads-web across multiple sessions. The dashboard is now a full command center for the cycle-apps-factory autonomous app-building pipeline.

## Features built (in order)

1. **App Fleet Dashboard** — pipeline kanban (Idea/Research/Development/Submission/Completed)
2. **Cost Per App** — per-epic cost aggregation with phase breakdown
3. **Research Completion Signals** — `GET /api/signals` polling endpoint
4. **Auto-Registration** — watch directories for new beads projects
5. **Agent Activity Timeline** — visual session bars grouped by day
6. **Factory Workflow Buttons** — Approve & Send to Dev, Request More Research
7. **Research Report Markdown Reader** — `GET /api/research/[appName]` with react-markdown
8. **Agent Launch API** — spawn Claude Code remotely from fleet cards

## Current state

- **Branch:** `main`, last commit `626bc59`, pushed to remote
- **Tests:** 528 passing, build clean
- **No uncommitted code changes**

## Open issues (all P4 backlog)

```
bw-rx3 — tokens-per-story-point efficiency panel (ready)
bw-91h — display story points in table/detail (ready)
bw-1mx — build tokens-per-story-point panel (blocked by bw-91h)
```

These are story-point-based efficiency metrics. They require upstream beads versions that expose `story_points` — sqlite-reader.ts already handles the column dynamically via PRAGMA.

## Factory-side work pending

Two issues created in `cycle-apps-factory` repo:
- `cycle-apps-factory-57s` — Define research workflow prompt in CLAUDE.md (P2)
- `cycle-apps-factory-1gp` — Add dev/submission workflow prompts (P3, blocked by 57s)

Handoff note at: `cycle-apps-factory/docs/BEADS_WEB_INTEGRATION.md`

## Key architecture notes

- **Agent launch separation:** beads-web owns the generic spawn/stop/status API (`agent-launcher.ts`). The factory repo owns workflow instructions (CLAUDE.md prompts). The fleet page finds the factory repo by name from `~/.beads-web.json` config.
- **Fleet stage detection:** Label-driven in `fleet-utils.ts:detectStage()` — children's labels (`research`, `development`, `submission:*`) determine the epic's stage. Highest active stage wins.
- **Multi-repo:** Everything works in `__all__` aggregation mode. Issue mutations use `findRepoForIssue()` to target the correct project DB.

## Quick start for next session

```bash
bd ready              # See available work
bd show bw-rx3        # Story points efficiency panel
bd show bw-91h        # Story points in table
npx jest --no-cache   # Verify tests still pass
```
