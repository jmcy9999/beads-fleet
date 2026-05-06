OUTCOME: Implement the MINIMAL precondition-library scaffold at `src/lib/dispatch-preconditions.ts` shipping the FOUR UNIVERSAL predicates (A.5 BD_STATUS_DEFERRED + BD_STATUS_CLOSED, C OPERATOR_DECISION_PENDING + REVIEW_NEEDS_HUMAN) with the FULL type skeleton (RefusalCode union with all 12 codes, PreconditionResult, DispatchContext, Precondition interface) populated exhaustively so Wave-3 sibling beads_web-ehp.13 can extend with per-action predicate logic only — no type rework. This bead lands the load-bearing protection for the 372-bead mass-defer (operator directive 2026-05-06: A.5 protection ASAP, scope-revised from round-1 plan).

SCOPE:
- In:
  - The exhaustive type definitions: `RefusalCode` string-literal union covering ALL 12 codes (PLAN_FILE_MISSING, PLAN_PENDING, NO_WAVE_BEADS, ALL_WAVE_BEADS_CLOSED, ARCHITECT_MARKER_SUCCESS, BD_STATUS_DEFERRED, BD_STATUS_CLOSED, BD_READ_FAILED, PIPELINE_LABEL_CONFLICT, AGENT_RUNNING_NO_SESSION, QA_ROUND_OUT_OF_ORDER, OPERATOR_DECISION_PENDING, REVIEW_NEEDS_HUMAN, PLAN_INSTABILITY, ACTION_NEXT_AGENT_MISMATCH); `PreconditionResult` discriminated union; `DispatchContext` interface (all 5 fields); `Precondition` interface.
  - `buildDispatchContext({ epicId, repoPath, action, waveNumber? })` async aggregator. Wave-2 implementation populates BeadSnapshot (via Wave-1 reader) + marker (via existing `marker-reader`) + epic labels (via existing `pipeline-labels.getEpicLabels`); SCAFFOLDS the remaining fields (planFileExists=false, openWaveBeadIds=[], stageEnteredAt=null) with explicit `// TODO ehp.13: replace stub with real reader` comments. ehp.4's integration only consumes BeadSnapshot + marker + epic labels; the scaffolding is sufficient for Wave-3 ehp.4.
  - `evaluatePreconditions(ctx)` pure verdict over PRECONDITION_TABLE.
  - FOUR universal predicates:
    - A.5 `bd-status-not-deferred` → BD_STATUS_DEFERRED (load-bearing for 372-bead defer; fail-closed when `ctx.beadSnapshot === null` per ADR-002 → BD_READ_FAILED).
    - A.5 `bd-status-not-closed` → BD_STATUS_CLOSED (fail-closed null → BD_READ_FAILED).
    - C `operator-decision-not-pending` → OPERATOR_DECISION_PENDING (marker.next_agent === 'operator' AND marker.blocker_class set).
    - C `review-needs-human-not-set` → REVIEW_NEEDS_HUMAN (epic labels include 'human-decision:required').
  - Minimal PRECONDITION_TABLE: register ALL FOUR universal predicates against EVERY action invoked by `marker-driven-routing.ts`'s `act()`. Verify the action set against `agent-action-map.ts`'s exports — at minimum: `'run-architect'`, `'run-builder'`, `'run-reviewer'`, `'run-qa'`, `'run-polish'`, `'run-test-spec'`, `'run-product-manager'`, `'run-coherence-agent'`, plus any other action returned by `interpretMarkerForRouting`.
  - Universal-predicate test (table-driven): for every action ehp.3 registers, all 4 universal predicates are present.
  - Unit tests covering happy path + each of the 4 universal refusal cases + bd-read-failed refusal.
  - Integration test against real tmp bd repo: status=deferred bead refuses with BD_STATUS_DEFERRED end-to-end (the load-bearing 372-bead-defer scenario).
- Out:
  - Class A (5 predicates), Class B (3), Class D (1), Class E (1). ehp.13 owns.
  - Filling the SCAFFOLDED context fields (planFileExists, openWaveBeadIds, stageEnteredAt). ehp.13 owns.
  - Full 38-action PRECONDITION_TABLE coverage. ehp.13 extends.
  - `PreconditionRefusalResponse` HTTP-412-body helper. ehp.13 adds.
  - ANY caller integration. Wave 3+ owns route.ts, reconciler rules, dispatchChainAction integrations.

FILES:
- NEW: src/lib/dispatch-preconditions.ts
- NEW: __tests__/lib/dispatch-preconditions.test.ts
- NEW: __tests__/lib/dispatch-preconditions.integration.test.ts

AC ITEMS TO VERIFY:
- The exhaustive RefusalCode union with ALL 12 values lands in this bead, even though only 5 codes are exercised (BD_STATUS_DEFERRED, BD_STATUS_CLOSED, BD_READ_FAILED, OPERATOR_DECISION_PENDING, REVIEW_NEEDS_HUMAN). Wave-3 ehp.13 adds predicate logic referencing the remaining values; if ehp.13 had to also extend the union, it would create a cross-wave merge surface and break ADR-003's single-file invariant.
- DispatchContext defined exhaustively: BeadSnapshot, marker, planFileExists, openWaveBeadIds, stageEnteredAt — all five fields. Scaffolded fields documented with `// TODO ehp.13` comments.
- BD_STATUS_DEFERRED predicate fires when `bead.status === 'deferred'` → discriminated-union refusal per ADR-001.
- BD_STATUS_CLOSED predicate fires when `bead.status === 'closed'`.
- BD_READ_FAILED: `ctx.beadSnapshot === null` → emitted by BOTH A.5 predicates (fail-closed per ADR-002 — the load-bearing 372-bead defer protection).
- OPERATOR_DECISION_PENDING fires when marker.next_agent === 'operator' AND marker.blocker_class is set.
- REVIEW_NEEDS_HUMAN fires when epic labels include 'human-decision:required'.
- Minimal PRECONDITION_TABLE: every action registered carries ALL FOUR universal predicates. Unit test iterates the table and asserts.
- Integration test: real tmp bd repo + a deferred bead → `evaluatePreconditions(ctx)` returns BD_STATUS_DEFERRED refusal. This is the load-bearing AC for the 372-bead mass-defer protection.
- ehp.4 (Wave-3 sibling) can verify both BD_STATUS_DEFERRED AND OPERATOR_DECISION_PENDING refusal scenarios using only ehp.3's exports — no race with parallel-Wave-3 ehp.13.

CONTEXT THE AGENT NEEDS:
- Operator directive 2026-05-06 (this revision): land BD_STATUS_DEFERRED protection ASAP. Round-1 plan put A.5 inside the 9h ehp.3 mega-bead; this revision splits ehp.3 → ehp.3 (this bead, 4h, universal predicates only) + ehp.13 (Wave 3, 6h, per-action predicates A/B/D/E + table extension). Wall-clock to A.5 protection: round-1 14h → revised 9h (Wave 1 2h + Wave 2 4h + Wave 3 ehp.4 3h).
- Architecture doc § Data Model: value-object shapes (BeadSnapshot, DispatchContext, Precondition) verbatim. Define types EXACTLY per the architecture.
- Architecture doc § Component Boundaries Contract 1: `evaluatePreconditions` call shape. Wave 3+ integrations consume this.
- Architecture doc § Failure modes Seam 1 (fail-closed bd reads), Seam 2 (action-classifying marker reads). BD_READ_FAILED is load-bearing — do not collapse into BD_STATUS_DEFERRED.
- ADR-001: discriminated union, NOT exceptions.
- ADR-002: BD_READ_FAILED is fail-closed, load-bearing for 372-bead defer.
- ADR-003: single-file library. ehp.13 will extend the SAME file in Wave 3.
- ADR-005: classes A/A.5/B/C/D/E ALL ship in v1 — ehp.3 + ehp.13 together complete v1.

RISK FLAGS:
- Watch for: deferring the exhaustive type definitions to ehp.13. Scope contract: ehp.3 owns the FULL RefusalCode union and the FULL DispatchContext interface; ehp.13 only adds per-action predicate logic. If you find ehp.3's types incomplete, STOP — do not split type definitions across the two beads. (Cross-bead type splits create merge conflicts under the dep-naive dispatcher and break ADR-003's single-file invariant.)
- Watch for: scope creep into ehp.13's per-action predicates. The 12 non-universal predicates are explicitly out-of-scope. If a Wave-3 ehp.4 dependency looks tempting (e.g., "I should also add NO_WAVE_BEADS since marker-driven-routing might dispatch start-wave"), STOP — ehp.4's AC only requires BD_STATUS_DEFERRED + OPERATOR_DECISION_PENDING. Per-action predicates land in ehp.13.
- Watch for: BeadSnapshot null vs deferred conflation per ADR-002. BD_READ_FAILED (null) and BD_STATUS_DEFERRED (non-null status='deferred') are distinct refusalCodes. The integration test for the 372-bead-defer scenario MUST exercise both paths separately.
- Watch for: scaffolded fields treated as TODO. The scaffolded values (planFileExists=false, openWaveBeadIds=[], stageEnteredAt=null) are CHOSEN defaults that are SAFE for ehp.4's load-bearing path. Do not stub these to `undefined` or throw — that would break ehp.4. Use the chosen defaults and document with `// TODO ehp.13: replace stub with real reader` comments.

MARKER REQUIREMENTS:
- Standard marker per `standards/generic/marker-protocol.md`.
- `what_was_done`: file paths + line ranges for the type definitions, predicates, and PRECONDITION_TABLE entries; commit_sha.
- `what_was_tested`: name each refusalCode tested, with the unit/integration test file:line. Cite the integration-test:line for the load-bearing BD_STATUS_DEFERRED 372-bead-defer scenario.
- `surprises_or_findings`: if the action set returned by `interpretMarkerForRouting` doesn't match what's documented, surface the discrepancy — ehp.4's PRECONDITION_TABLE registration must cover all of marker-driven-routing's output actions.
- `recommendation_for_next`: explicit handoff to ehp.13's builder — what scaffolded context fields need real implementations, what PRECONDITION_TABLE shape ehp.13 should extend, which existing readers should be reused.

COMMIT REQUIREMENTS:
- Single commit prefixed `beads_web-ehp.3:`.
- Subject: `beads_web-ehp.3: dispatch-preconditions minimal library — 4 universal predicates + type skeleton (load-bearing for 372-bead defer)`.
- Includes: source + unit tests + integration tests + marker file.
