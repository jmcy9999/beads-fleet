# Complexity Estimation Architecture (bw-gop)

## Problem

Release ETA uses priority as a proxy for effort, which conflates importance with complexity. A P0 typo fix (5 min) and a P0 architecture rewrite (3 days) get the same weight.

## Options Evaluated

### Option A: Rule-based heuristic
Score from structured fields: `base_weight[issue_type] + (AC_count * 0.3) + (dep_count * 0.5) + label_modifiers`.
- **Accuracy:** Low-medium. Misses context.
- **Complexity:** Low. ~50 lines, no dependencies.
- **Works for:** All beads (CLI, quick-create, planner).

### Option B: AI-scored (Haiku)
Extend existing Haiku call in quick-create to output `{"complexity": 1-5, "estimated_hours": N}`.
- **Accuracy:** Medium. Context-aware but generic (no project history).
- **Complexity:** Low. Already have Haiku in the create flow.
- **Works for:** Web quick-create only. CLI needs separate service.

### Option C: Planning-phase estimation
Planner agent assigns `estimated_minutes` during decomposition — this is where the most context exists.
- **Accuracy:** High. Planner has full spec, domain knowledge, dependency graph.
- **Complexity:** Low. Add instruction to planner.md, add `--estimated-minutes` to `bd create`.
- **Works for:** Planner-created beads only. Manual beads need fallback.

### Option D: Historical pattern matching
Train simple model from 940+ closed beads: `(issue_type, priority, desc_length, dep_count) → days_to_close`.
- **Accuracy:** Medium-high for typical beads. Poor for novel scenarios.
- **Complexity:** Medium. Feature engineering, periodic retraining.
- **Works for:** All beads with enough history per bucket.

### Option E: Hybrid (RECOMMENDED)
Combine C + A + D: Planner assigns initial estimate, rule-based risk adjustments, historical calibration corrects drift.
- **Accuracy:** High. Best of all approaches.
- **Complexity:** Medium-high across 3 phases.
- **Works for:** All beads (planner provides, rules fill gaps, calibration improves).

## Recommended Approach: Hybrid (Option E)

### Phase 1: Planner Estimates (1-2 sessions)
- Enhance planner agent to assign `estimated_minutes` during decomposition
- Modify beads-web to prefer `estimated_minutes` over priority weights in ETA
- Store in existing `estimated_minutes` DB column (already exists, unpopulated)
- **Files:** planner.md, estimate.ts, types.ts, sqlite-reader.ts

### Phase 2: Risk Modifiers (1 session)
- Label-based adjustments: `external-api` (+36h), `architecture-change` (+24h), `ui-polish` (+48h), `needs-testing` (+24h)
- Applied post-create when labels are added
- Backfill endpoint for existing beads
- **New file:** estimate-rules.ts

### Phase 3: Historical Calibration (2-3 sessions, after 100+ beads close with estimates)
- Compare estimated vs actual minutes for closed beads
- Compute per-bucket calibration factors (e.g., "P1 tasks are underestimated by 32%")
- Auto-apply multiplier to future estimates
- **New files:** calibration.ts, calibration API route

### Phase 4: UI (1 session)
- Show estimated hours per bead in expanded release view
- Tooltip with breakdown: "Planner: 4h, Risk: +36h, Calibration: 1.2x"
- Settings page: recalibration button, current factors

## Key Complexity Factors to Capture

| Factor | Signal | Where Captured |
|--------|--------|---------------|
| UI polishing / design iteration | Label or planner judgment | Phase 1 (planner), Phase 2 (label) |
| User testing required | Label `needs-testing` | Phase 2 |
| Complex calculations / algorithms | Planner reads acceptance criteria | Phase 1 |
| Risk: touches multiple areas | Dependency count, planner judgment | Phase 1 + Phase 2 |
| Code complexity in affected areas | Planner reads standing orders | Phase 1 |
| External API integration | Label `external-api` | Phase 2 |
| Architecture changes | Label `architecture-change` | Phase 2 |

## Storage

Use existing `estimated_minutes` column in beads DB. Already exists, never populated. No schema change needed. The sqlite-reader already handles optional columns via PRAGMA check.

## PatchCycle Historical Data (for calibration)

| Type | Count | Avg Days |
|------|-------|----------|
| bug | 308 | 0.26 |
| task | 596 | 1.16 |
| feature | 50 | 1.05 |
| epic | 43 | 3.65 |

| Priority | Count | Avg Days |
|----------|-------|----------|
| P0 | 279 | 0.20 |
| P1 | 289 | 0.46 |
| P2 | 304 | 0.41 |
| P3 | 103 | 5.20 |
| P4 | 22 | 7.23 |

## Decision: Skip Multi-Dimensional Complexity

Considered `{effort, risk, uncertainty}` triple instead of single number. Rejected: adds UI and maintenance complexity for marginal ETA improvement. Single `estimated_minutes` is sufficient. Revisit if Jane wants risk-aware prioritization.
