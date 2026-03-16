# Plan: Complexity-based release estimation (bw-a4w)

## Dependency DAG

```
Wave 0 (unblocked):
  bw-a4w.4  Verify bd create supports --estimated-minutes flag [P0]

Wave 1 (after .4):
  bw-a4w.1  Add estimated_minutes to PlanIssue + sqlite-reader [P1]
  bw-a4w.3  Enhance planner agent to assign estimated_minutes [P1]

Wave 2 (after .1):
  bw-a4w.2  Modify estimateRelease to prefer estimated_minutes [P1]

Wave 3 (after .2):
  bw-a4w.5  Tests for estimated_minutes in ETA [P1]
  bw-a4w.6  Label-based risk modifiers [P2]
  bw-a4w.10 UI: estimate breakdown per bead [P2]

Wave 4 (after .6):
  bw-a4w.7  Tests for risk modifiers [P2]
  bw-a4w.8  Historical calibration engine [P3]

Wave 5 (after .8):
  bw-a4w.9  Tests for calibration engine [P3]
```

## Waves

### Wave 0: Gate check
| Bead | Title | Type | Priority |
|------|-------|------|----------|
| bw-a4w.4 | Verify `bd create --estimated-minutes` flag | task | P0 |

**Why first:** Everything depends on whether `bd create` can populate `estimated_minutes`. If not, we need a workaround before proceeding.

### Wave 1: Data layer
| Bead | Title | Type | Priority | Blocked by |
|------|-------|------|----------|------------|
| bw-a4w.1 | Add `estimated_minutes` to PlanIssue + sqlite-reader | task | P1 | .4 |
| bw-a4w.3 | Enhance planner to assign estimates during decomposition | task | P1 | .4 |

**Parallel work:** .1 (beads-web types) and .3 (planner agent) are independent — can run concurrently after .4 clears.

### Wave 2: Estimation logic
| Bead | Title | Type | Priority | Blocked by |
|------|-------|------|----------|------------|
| bw-a4w.2 | Modify estimateRelease to prefer estimated_minutes | task | P1 | .1 |

**Key change:** `estimateRelease()` checks `estimated_minutes` first, falls back to priority weights. This is where the ETA improvement actually lands.

### Wave 3: Extensions (can run in parallel)
| Bead | Title | Type | Priority | Blocked by |
|------|-------|------|----------|------------|
| bw-a4w.5 | Tests for estimated_minutes in ETA | task | P1 | .2 |
| bw-a4w.6 | Label-based risk modifiers | task | P2 | .2 |
| bw-a4w.10 | UI: estimate breakdown per bead | task | P2 | .2, .6 |

**Note:** .10 depends on .6 for the risk modifier display. .5 and .6 can run in parallel.

### Wave 4: Risk modifier tests + calibration
| Bead | Title | Type | Priority | Blocked by |
|------|-------|------|----------|------------|
| bw-a4w.7 | Tests for risk modifiers | task | P2 | .6 |
| bw-a4w.8 | Historical calibration engine | task | P3 | .6 |

**Note:** Calibration (Phase 3 of architecture) is P3 — only useful after 100+ beads close with estimates. Can be deferred indefinitely.

### Wave 5: Calibration tests
| Bead | Title | Type | Priority | Blocked by |
|------|-------|------|----------|------------|
| bw-a4w.9 | Tests for calibration engine | task | P3 | .8 |

## Checkpoint: Human review after Wave 2

After .2 lands, the release page will show estimates from `estimated_minutes` when available. This is the minimum viable improvement. Jane should verify:
- [ ] ETA changes when beads have `estimated_minutes` vs relying on priority
- [ ] Fallback to priority weights still works for beads without estimates
- [ ] Numbers feel reasonable

## Architecture reference
Full analysis: `docs/complexity-estimation-architecture.md`
