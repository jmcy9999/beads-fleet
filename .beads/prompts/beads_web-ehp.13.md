OUTCOME: Extend `src/lib/dispatch-preconditions.ts` (created in Wave 2 by beads_web-ehp.3) with the remaining 12 predicates (Class A/B/C/D/E), fill in the SCAFFOLDED fields of `buildDispatchContext` (planFileExists / openWaveBeadIds / stageEnteredAt), populate the FULL PRECONDITION_TABLE for all 38 dispatching actions, and add `PreconditionRefusalResponse` HTTP-412-body helper. ehp.3 already shipped the type skeleton, A.5 predicates, and minimal PRECONDITION_TABLE; this bead is purely additive within the same file.

SCOPE:
- In:
  - Class A predicates (5): plan-file-exists (PLAN_FILE_MISSING), plan-not-pending (PLAN_PENDING), wave-beads-exist (NO_WAVE_BEADS), wave-beads-not-all-closed (ALL_WAVE_BEADS_CLOSED), architect-marker-not-success (ARCHITECT_MARKER_SUCCESS).
  - Class B predicates (3): pipeline-label-singleton (PIPELINE_LABEL_CONFLICT), agent-running-has-session (AGENT_RUNNING_NO_SESSION), qa-round-monotonic (QA_ROUND_OUT_OF_ORDER).
  - Class C predicates (2): operator-decision-not-pending (OPERATOR_DECISION_PENDING), review-needs-human-not-set (REVIEW_NEEDS_HUMAN).
  - Class D predicate (1): plan-not-modified-since-stage-entered (PLAN_INSTABILITY) — reads event-log for most-recent `pipeline-label-set` event for the current epic+stage. Fail-open if event-log read fails (predicate skips with comment per ADR-002 commentary).
  - Class E predicate (1): action-matches-marker-next-agent (ACTION_NEXT_AGENT_MISMATCH) — uses existing `marker-routing.ts` `interpretMarkerForRouting` and `agent-action-map.ts` `getActionForAgent`. Do NOT duplicate that logic.
  - Fill in `buildDispatchContext`'s scaffolded fields:
    - `planFileExists` — `fs.access` against `<repoPath>/.beads/plans/<epicId>.md`.
    - `openWaveBeadIds` — call existing `listOpenWaveBeads` from `agent-launcher.ts` (when `waveNumber` is provided).
    - `stageEnteredAt` — read event-log for most-recent `pipeline-label-set` event for the current epic+stage; null if none.
  - Extend PRECONDITION_TABLE to cover ALL 38 dispatching actions (the action route's handlers + reconciler rule actions). Universal predicates (BD_STATUS_DEFERRED, BD_STATUS_CLOSED, OPERATOR_DECISION_PENDING, REVIEW_NEEDS_HUMAN) registered against EVERY dispatching action. Per-action specific predicates registered per architecture doc § PRECONDITION_TABLE shape.
  - `PreconditionRefusalResponse` helper that projects `{ ok: false, ... }` into the HTTP 412 body shape consumed by route.ts (ehp.11).
  - Extended unit tests: one happy path + one refusal scenario per predicate; per-action PRECONDITION_TABLE coverage tests; type-narrowing tests; PreconditionRefusalResponse tests.
  - Extended integration tests: build a real DispatchContext against a tmp bd repo + tmp marker dir + tmp plan file + tmp event-log; exercise each refusal class end-to-end.
- Out:
  - Modifying ehp.3's existing types or A.5 predicates. ehp.13 only ADDS — does not edit ehp.3's contributions.
  - ANY caller integration. Wave 4 owns route.ts, reconciler rules, dispatchChainAction.
  - Idempotency-window logic in reconciler core (architecture ADR-006 — flagged FOLLOW-ON in marker).

FILES:
- src/lib/dispatch-preconditions.ts (MODIFIED — extends ehp.3's file)
- __tests__/lib/dispatch-preconditions.test.ts (MODIFIED — extends ehp.3's tests)
- __tests__/lib/dispatch-preconditions.integration.test.ts (MODIFIED — extends ehp.3's integration tests)

AC ITEMS TO VERIFY:
- All 12 predicates beyond ehp.3's A.5 pair are implemented and registered. Class A (5), Class B (3), Class C (2), Class D (1), Class E (1) = 12.
- buildDispatchContext fills all scaffolded fields with REAL reads (no more stub defaults). The TODO-ehp.13 comments from ehp.3 are replaced with actual implementations.
- PRECONDITION_TABLE extension: every dispatching action (~38 total per architecture § File Structure Plan) has an entry. Every entry contains the universal predicates (BD_STATUS_DEFERRED, BD_STATUS_CLOSED, OPERATOR_DECISION_PENDING, REVIEW_NEEDS_HUMAN). Per-action specific predicates per architecture spec.
- PreconditionRefusalResponse helper: takes a `{ ok: false, ... }` PreconditionResult and a Bead snapshot, returns an object shaped for HTTP 412 response body (refusalCode + failedCheck + reason + observedState fields per architecture § Component Boundaries Contract 3).
- Class D fail-open posture documented inline (event-log read fail → predicate skips → return ok=true; comment must distinguish this from the fail-closed posture of bd reads per ADR-002).
- Class E uses existing marker-routing + agent-action-map exports; no duplication.
- ehp.3's contributions PRESERVED unmodified. Specifically: RefusalCode union is not narrowed; DispatchContext field shape is not narrowed; A.5 predicate code is not edited; ehp.3's minimal PRECONDITION_TABLE entries are not edited (only extended).
- Integration test exercises each predicate class against a real tmp bd repo + real fs + real marker dir + real event-log.

CONTEXT THE AGENT NEEDS:
- Operator directive 2026-05-06: this bead lands the FULL library v1 (Class A/B/C/D/E + universal table). ehp.4 in the same Wave 3 lands the load-bearing A.5 marker-driven-routing integration; A.5 protection of the 372-bead defer is operationally live BEFORE ehp.13 finishes (ehp.4 only depends on ehp.3's A.5 predicates, not on ehp.13).
- Architecture doc § Data Model: ehp.3 has defined the types exhaustively; do not redefine them.
- Architecture doc § Component Boundaries: Contract 1 (evaluatePreconditions call shape) is established. Contract 3 (PreconditionRefusalResponse HTTP-412 body) is what this bead adds.
- Architecture doc § Failure modes: Seam 1 (fail-closed bd reads — ehp.3 established), Seam 2 (action-classifying marker reads — applies to Class C predicates), Seam 3 (fail-closed fs reads — applies to Class A plan-file-exists), and the Class D fail-open exception (event-log read).
- ADR-001/002/003/004/005 — see ehp.3 prompt's CONTEXT section for full ADR list.
- This bead's tests file is the SAME file ehp.3 created. Append; do not rewrite ehp.3's test cases.

RISK FLAGS:
- Watch for: rewriting ehp.3's contributions. ehp.13 is purely additive within `src/lib/dispatch-preconditions.ts`. ehp.3's RefusalCode union, type definitions, A.5 predicate code, and minimal PRECONDITION_TABLE entries must remain unchanged. Add new predicate functions and extend the table; do not edit existing entries. If ehp.3's contributions appear incorrect, STOP and surface — do not silently rewrite.
- Watch for: introducing new files. ADR-003 mandates single-file library; ehp.13 must extend the existing dispatch-preconditions.ts, not create new modules.
- Watch for: hand-rolling readers that duplicate existing logic. `marker-reader.readMarker`, `pipeline-labels.getEpicLabels`, `agent-launcher.listOpenWaveBeads` are the ONLY effectful primitives — buildDispatchContext composes them.
- Watch for: predicates with side effects. Predicates are pure synchronous functions over a fully-built DispatchContext.
- Class D requires reading event-log. Use the EXISTING event-log reader exports; do not reimplement. If event-log read fails, treat as `stageEnteredAt=null` → class D predicate skips (cannot determine staleness). Document this fail-open posture in the predicate's comment so reviewers don't flag it as inconsistent with ADR-002's fail-closed posture.
- Class E uses `marker-routing.interpretMarkerForRouting` and `agent-action-map.getActionForAgent`. Do NOT duplicate that logic.

MARKER REQUIREMENTS:
- Standard marker per `standards/generic/marker-protocol.md`.
- `what_was_done`: per-class summary (A/B/C/D/E) with file paths + line ranges + commit sha.
- `what_was_tested`: per-predicate verification depth — name each refusalCode tested, with the unit/integration test file:line that exercises it. Total of 12 new predicates' refusalCodes plus the PreconditionRefusalResponse helper tests.
- `surprises_or_findings`: if the existing readers (`marker-reader`, `pipeline-labels`, `agent-launcher.listOpenWaveBeads`, event-log readers) have shapes that don't compose cleanly into DispatchContext's filled-in fields, document the actual shapes and how the implementation adapted.
- `recommendation_for_next`: explicit handoff to Wave-4 integration beads (ehp.5-11). Which actions in PRECONDITION_TABLE are most coverage-sensitive; which integrations should test which refusal classes.

COMMIT REQUIREMENTS:
- Single commit prefixed `beads_web-ehp.13:`.
- Subject: `beads_web-ehp.13: dispatch-preconditions library extension — Class A/B/C/D/E + full PRECONDITION_TABLE`.
- Includes: source extension + unit-test extension + integration-test extension + marker file.
