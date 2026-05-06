OUTCOME — phased:

Phase 1 (~30%): Land types + pure infrastructure. Define RefusalCode union, PreconditionResult, DispatchContext, Precondition interface in `src/lib/dispatch-preconditions.ts`. Implement `buildDispatchContext` (effectful aggregator over BeadSnapshot + marker + planFileExists + openWaveBeadIds + stageEnteredAt) and `evaluatePreconditions` (pure verdict). Add input validation (epicId regex, action in VALID_ACTIONS, waveNumber positive int). STOP at wave boundary; surface progress in marker before continuing.

Phase 2 (~50%): Implement all 14 predicates and the PRECONDITION_TABLE. Class A (5 predicates: plan-file-exists, plan-not-pending, wave-beads-exist, wave-beads-not-all-closed, architect-marker-not-success); Class A.5 (2: bd-status-not-deferred, bd-status-not-closed; fail-closed when bead snapshot is null per ADR-002 — emit BD_READ_FAILED); Class B (3: pipeline-label-singleton, agent-running-has-session, qa-round-monotonic); Class C (2: operator-decision-not-pending, review-needs-human-not-set); Class D (1: plan-not-modified-since-stage-entered, reads event-log for most-recent pipeline-label-set timestamp); Class E (1: action-matches-marker-next-agent, uses existing marker-routing.ts + agent-action-map.ts). Register universal predicates (BD_STATUS_DEFERRED, BD_STATUS_CLOSED, OPERATOR_DECISION_PENDING, REVIEW_NEEDS_HUMAN) against EVERY dispatching action in PRECONDITION_TABLE.

Phase 3 (~20%): Unit tests (table-driven, ~600 lines: one happy + one refusal per predicate; per-action PRECONDITION_TABLE coverage tests; type-narrowing tests). Integration tests (~200 lines: tmp bd repo + tmp marker dir + tmp plan file + tmp event-log; exercise each refusal class end-to-end against real fixtures). Add `PreconditionRefusalResponse` helper that projects ok=false result into HTTP 412 body shape.

SCOPE:
- In: dispatch-preconditions.ts (single file per ADR-003); unit tests; integration tests against real bd / fs / marker fixtures.
- Out: Caller integration (Wave 3 owns route, rules, dispatchChainAction); idempotency-window logic; UI distinction between operator vs reconciler dispatch; modification of existing readers (marker-reader.ts, pipeline-labels.ts, agent-launcher.ts's listOpenWaveBeads — the library COMPOSES them).

FILES:
- NEW: src/lib/dispatch-preconditions.ts
- NEW: __tests__/lib/dispatch-preconditions.test.ts
- NEW: __tests__/lib/dispatch-preconditions.integration.test.ts

AC ITEMS TO VERIFY:
- Phase 1 (types): all 12 RefusalCode values defined; PreconditionResult is a discriminated union per ADR-001 (NOT exceptions); DispatchContext is read-only.
- Phase 2 (predicates): each of the 14 predicates returns a refusal with the correct refusalCode + failedCheck under its trigger condition; happy path returns `{ ok: true }`.
- Phase 2 (PRECONDITION_TABLE): unit test iterates the table and asserts the universal predicates are registered against every dispatching action.
- Phase 3 (integration): tests exercise each predicate class against a real tmp bd repo + real fs + real marker dir (no library-internal mocks beyond the readers' published interfaces).
- bd-read failure (BeadSnapshot is null) refuses with `BD_READ_FAILED` per ADR-002 — load-bearing for 372-bead mass-defer.
- Class D (PLAN_INSTABILITY): if event-log read fails, treat stageEnteredAt as null → predicate skips (fail-open posture). Document this exception in the predicate's comment so reviewers don't flag it as inconsistent with ADR-002's fail-closed posture.
- Class E (ACTION_NEXT_AGENT_MISMATCH): uses existing `marker-routing.ts` `interpretMarkerForRouting` and `agent-action-map.ts` `getActionForAgent`. Do NOT duplicate that logic.

CONTEXT THE AGENT NEEDS:
- Architecture doc § Data Model — value-object shapes (BeadSnapshot, DispatchContext, Precondition) verbatim.
- Architecture doc § Component Boundaries — Contracts 1, 2, 3 are the call shapes Wave 3 will invoke; design the library's exported API to match exactly.
- Architecture doc § Failure modes Seams 1, 2, 3 — fail-closed for bd reads, action-classifying for marker reads (require / informational), fail-closed for fs reads.
- ADR-001: discriminated union, NOT exceptions.
- ADR-002: BD_READ_FAILED is fail-closed, load-bearing for 372-bead defer.
- ADR-003: single-file library, no per-action sub-modules.
- ADR-004: PRECONDITION_TABLE keyed by action name; predicates also carry `appliesTo(action)` for self-documentation.
- ADR-005: classes A, A.5, B, C, D, E ALL ship in v1 — no class deferred.
- Code-principles: no force unwraps; use discriminated-union narrowing; small focused predicates (~10-25 lines each).

RISK FLAGS:
- Watch for: scope creep into Wave 3 work. The library MUST NOT modify route.ts, any reconciler rule, or agent-launcher.ts. If you find yourself wanting to make those changes "while I'm in there", STOP — those are separate beads.
- Watch for: hand-rolling readers that duplicate existing logic. `marker-reader.readMarker`, `pipeline-labels.getEpicLabels`, `agent-launcher.listOpenWaveBeads`, and the new `bead-status-reader.readBeadStatus` (Wave 1) are the ONLY effectful primitives — `buildDispatchContext` composes them. If a predicate wants new state not in DispatchContext, the right move is to extend DispatchContext (and the builder), not to hand-roll a new read inside the predicate.
- Watch for: predicates with side effects. Predicates are pure synchronous functions over a fully-built DispatchContext. If a predicate wants to read state, that state must be in DispatchContext at predicate-evaluation time.
- Watch for: BeadSnapshot null vs deferred conflation. ADR-002 specifies BD_READ_FAILED for null (bd unreachable) and BD_STATUS_DEFERRED / BD_STATUS_CLOSED for non-null + status check. Do not collapse these into one refusalCode.
- Per architecture § Out of scope: do not introduce new files beyond the three listed in FILES. If you need a new helper, inline it or extend an existing reader (with operator approval if extension changes the reader's signature).

MARKER REQUIREMENTS:
- Standard marker.
- `what_was_done`: per-phase summary with file paths + line ranges + commit shas.
- `what_was_tested`: per-predicate verification depth — name each refusalCode tested, with the unit/integration test file:line that exercises it.
- `surprises_or_findings`: if the existing readers (`marker-reader`, `pipeline-labels`, `agent-launcher.listOpenWaveBeads`) have shapes that don't compose cleanly into DispatchContext, document the actual shapes and how the builder adapted.
- Note Phase 1 / Phase 2 / Phase 3 boundary commits separately so progress is auditable.

COMMIT REQUIREMENTS:
- Single commit prefixed `beads_web-ehp.3:`.
- Subject: `beads_web-ehp.3: dispatch-preconditions library — types, builder, predicates, table`.
- Includes: source + unit tests + integration tests + marker file.
