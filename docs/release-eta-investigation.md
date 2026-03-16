# Release ETA Investigation (bw-3cf)

## Question

Can we show an estimated time for completion for a release based on the beads in it?

## Available Signals

### 1. Historical close times (strong signal)

PatchCycle has 940 closed beads with timestamps. Average time from created to closed:

| Dimension | Segment | Count | Avg Days to Close |
|-----------|---------|-------|-------------------|
| **Overall** | all | 940 | 0.97 |
| **By type** | bug | 308 | 0.26 |
| | task | 596 | 1.16 |
| | feature | 50 | 1.05 |
| | epic | 43 | 3.65 |
| **By priority** | P0 | 279 | 0.20 |
| | P1 | 289 | 0.46 |
| | P2 | 304 | 0.41 |
| | P3 | 103 | 5.20 |
| | P4 | 22 | 7.23 |

**Key insight:** Priority is a much stronger predictor than type. P0-P2 beads close in under half a day on average. P3-P4 beads sit for 5-7 days (likely backlog items that wait).

### 2. Daily velocity (strong signal)

Recent 30-day velocity (beads closed per active day):

- Last 14 active days: avg ~15 beads/day (range: 1-89)
- Velocity is spiky — big batch days (39-96 beads) interspersed with low days (1-5)
- This reflects agent-driven development: agents close many beads in bursts

### 3. `estimated_minutes` column (unused)

The DB schema has `estimated_minutes` but it's **never populated** (0 rows with values). Not surfaced in beads-web types either. Could be populated in future but not useful today.

### 4. `story_points` (not available)

PatchCycle's beads version doesn't have this column. The beads_web `sqlite-reader.ts` handles it optionally, but there's no data.

### 5. Dependency chains (available but complex)

Dependency data is in the DB and surfaced via `blocked_by`/`blocks` on `PlanIssue`. Could calculate critical path length, but adds significant complexity for marginal accuracy improvement.

## Current Release State

| Release | Total | Closed | Open |
|---------|-------|--------|------|
| release:2.0 | 16 | 0 | 16 |
| release:2.1 | 11 | 0 | 11 |
| release:3.0 | 1 | 0 | 1 |

Note: release:2.0 beads exist but weren't showing in the earlier investigation (they may have been tagged after).

## Recommended Approach

### Simple & useful (recommended): Priority-weighted estimate

**Formula per release:**
```
For each open bead in the release:
  estimate_days = lookup[priority]  (from historical averages)

total_bead_days = sum of all estimate_days
estimated_calendar_days = total_bead_days / daily_velocity
```

**Using PatchCycle's actual data:**

Priority-based weights (days per bead):
- P0: 0.2 days
- P1: 0.5 days
- P2: 0.4 days
- P3: 5.2 days
- P4: 7.2 days

**Example: v2.1 (11 open beads)**

If the 11 beads are mixed P1-P2, that's roughly 11 * 0.45 = ~5 bead-days. At a velocity of ~15 beads/day, that's about 0.3 calendar days — less than a day of agent work. But at a more conservative human-involved velocity of ~5 beads/day, it's ~1 day.

### What to display

On the release row, next to the progress bar:
- **"~X days remaining"** — simple, actionable
- Grey/subtle when estimate is rough, colored when high confidence (many closed beads to calibrate from)

### Where to compute

**Client-side from existing data.** The `PlanIssue` type already has `priority`, `status`, `created_at`, `closed_at`. No new API endpoint needed. The calculation is:

1. From all closed issues in the project, compute avg days-to-close per priority bucket
2. For each open bead in the release, look up its priority weight
3. Sum the weights, divide by recent velocity (beads closed in last 14 days / 14)
4. Display as "~N days"

All data is already in `issuesData.all_issues` — this is a pure client-side `useMemo`.

## Complexity Rating

**Low-medium.**

- Core estimate logic: ~50 lines of pure functions (new file in `components/releases/`)
- UI change: one `<span>` per release row showing the estimate
- No API changes, no DB changes, no new dependencies
- Tests: extend `release-helpers.test.ts` with estimate function tests
- One session of work, maybe 30 minutes

## Edge Cases to Handle

1. **No closed beads yet** — show "No estimate" (not enough history)
2. **All beads in release are closed** — show "Complete" (already handled by progress bar)
3. **Zero velocity** (no beads closed recently) — show "Stalled" or omit estimate
4. **Mixed priorities with outlier P4s** — the priority-weighted approach handles this naturally
5. **Single-project vs All Projects mode** — velocity should be per-project, not global

## Future Enhancements (not needed now)

- Use `issue_type` as secondary weight (epics take 3.6x longer)
- Factor in blocked/dependency chains for critical path
- Show confidence interval ("2-5 days") based on variance
- Populate `estimated_minutes` from agent estimates during planning
- Trend arrow showing if velocity is increasing/decreasing
