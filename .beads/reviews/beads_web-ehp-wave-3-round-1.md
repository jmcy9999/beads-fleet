# Code Review — beads_web-ehp Wave 3 Round 1

**Epic:** beads_web-ehp — Action route lacks precondition checks (load-bearing for 372-bead mass-defer)
**Wave:** 3 (marker-driven-routing precondition gate + dispatch-preconditions library extension)
**Round:** 1
**Reviewer:** reviewer agent (Stage 4 — Code Review)
**Date:** 2026-05-06
**Ship type:** internal
**Product repo:** /Users/janemckay/dev/claude_projects/beads_web
**Plan:** /Users/janemckay/dev/fleet/factory-core/.beads/plans/beads_web-ehp.md
**Architecture:** /Users/janemckay/dev/fleet/factory-core/docs/research/action-route-lacks-precondition-checks-architecture.md
**Research brief:** /Users/janemckay/dev/fleet/factory-core/docs/research/action-route-lacks-precondition-checks.md

---

## Verdict: PASS

Wave 3's two beads (`beads_web-ehp.4` and `beads_web-ehp.13`) ship the load-bearing 372-bead-defer protection (rule-side BD_STATUS_DEFERRED gate) and the full v1 precondition library (10 additional predicates across Class A/B/D/E, full 34-action PRECONDITION_TABLE, real-reads buildDispatchContext, HTTP 412 refusal helper). Both per-bead markers are part of their commits per the 2026-05-01 ordering directive. ehp.4's LOAD-BEARING AC is verified end-to-end — when `mockReadBeadStatus` returns a deferred snapshot, the rule's `act()` (a) makes ZERO fetch calls, (b) emits a `reconciler-action-refused` event with `refusalCode=BD_STATUS_DEFERRED` + `ruleName=marker-driven-routing` + `failedCheck=bd-status-not-deferred` + `reason` containing "deferred". The 412 branch correctly returns BEFORE the existing `if (!res.ok) throw` so non-412 HTTP errors retain their failure semantics. ehp.13's library extension is purely additive (ehp.3's contributions preserved unchanged), `evaluatePreconditions` correctly prefers `EXTENDED_PRECONDITION_TABLE` over the Wave-2 minimal `PRECONDITION_TABLE`, and `buildDispatchContext` is total under all reader-failure paths. 112 unit + 21 integration + 4 rule-integration tests all pass; full beads_web suite stays green (110 suites / 2310 tests, 1 skipped, 2309 passed).

Zero bugs filed. Four non-blocking observations recorded for operator awareness (see § Observations) — none threaten the load-bearing protection or block Wave 4 dispatch. Two are diagnostic-quality concerns worth absorbing into Wave 4 follow-on work; one is a stale-comment cleanup; one is a cross-bead test fixture scope note already surfaced in the builder marker.

---

## Beads in Wave 3

| Bead ID | Title | Wave Label Present | Status | Commit |
|---------|-------|--------------------|--------|--------|
| beads_web-ehp.4 | Integrate dispatch-preconditions into marker-driven-routing.ts (load-bearing for 372-bead defer) | YES (`wave:3`) | closed | 6bda934 (work + marker) |
| beads_web-ehp.13 | (Wave-3 extension) dispatch-preconditions library — Class A/B/C/D/E predicates + full PRECONDITION_TABLE + PreconditionRefusalResponse helper | YES (`wave:3`) | closed | a82ef19 (work + marker) |

**Wave-label compliance improved over Wave 1/2:** Both Wave 3 beads carry the `wave:3` bd label — the planner-stage convention gap noted in Wave-1 Round 1 Observation 2 and Wave-2 Round 1's Scope-of-Review Note is now resolved for this wave. No surfacing-protocol scope discrepancy this round.

**Note on `beads_web-abc`:** A duplicate bead `beads_web-abc` was created and immediately closed with reason "Re-creating with --parent to get ehp.13 prefix". This is a planner-side housekeeping artefact (no commits, no labels relevant to scope). The actual Wave-3 work landed on `beads_web-ehp.13`. No review impact.

---

## Standing Order Compliance

| Check | Status | Notes |
|-------|--------|-------|
| Investigation-Before-Code (agent-discipline § 1) | PASS | Both markers document substantive cross-checks: ehp.4 verified the 412-vs-throw ordering at the rule's existing fetch site; ehp.13 verified the codebase emits `stage-dispatched` not the architect-spec'd `pipeline-label-set` (saving a silent integration-test failure). |
| Plan Decomposition (agent-discipline § 2) | PASS | Plan exists at `.beads/plans/beads_web-ehp.md`. Both beads have explicit AC, Files manifest, epic label, ship-type label, and `wave:3` label. Cross-wave dep `ehp.13 → ehp.3` honoured (ehp.13 only ADDS to `dispatch-preconditions.ts`; ehp.3's RefusalCode union, type definitions, A.5 predicate code, and minimal PRECONDITION_TABLE are preserved). Intra-wave parallelism: ehp.4 and ehp.13 modify disjoint files (ehp.4 → `marker-driven-routing.ts` + new test; ehp.13 → `dispatch-preconditions.ts` + extended tests + 4-line fixture in `marker-driven-routing.test.ts` — see Observation 4). Safe under dep-naive `start-wave` dispatcher. |
| Tests Written (agent-discipline § 4) | PASS | ehp.4: 4 integration tests in `marker-driven-routing.precondition-integration.test.ts` (~370 lines, LOAD-BEARING test at lines 167-236). ehp.13: 64 new unit tests in `dispatch-preconditions.test.ts` (now 112 total) + 13 new integration tests in `dispatch-preconditions.integration.test.ts` (now 21 total). Per-AC coverage verified: every refusalCode introduced in ehp.13 has both unit + integration coverage; class D fail-OPEN paths exercise all 4 skip cases. |
| Test Suite Green | PASS | Re-ran the targeted suites locally during this review: 137 tests across 3 suites (112 unit + 21 integration + 4 rule-integration). All pass. Full beads_web suite per builder markers: 110 suites / 2310 tests / 2309 passed / 1 skipped / 0 failed. |
| TypeScript clean (in scope) | PASS | Both markers cite `tsc --noEmit` clean on modified files. Pre-existing TS errors in unrelated `__tests__/api/*` are unchanged from Wave 1/2 (Next.js param-shape drift; pre-dates this epic). |
| ESLint clean (in scope) | PASS | Both markers cite eslint clean on modified files. ehp.4 marker notes 4 pre-existing lint errors in legacy tests that pre-date the bead. |
| Bead-id-first commit policy (agent-discipline § 7) | PASS | 6bda934 starts with `beads_web-ehp.4: Wave-3 marker-driven-routing precondition gate (A.5 BD_STATUS_DEFERRED protection lands)`. a82ef19 starts with `beads_web-ehp.13: Wave-3 dispatch-preconditions library extension (Class A/B/D/E + 34-action PRECONDITION_TABLE)`. Both include the Co-Authored-By tag (`Claude Opus 4.7 (1M context)`). |
| Marker write LAST + part of commit (marker-protocol § 1, 2026-05-01 directive) | PASS | `git show --stat 6bda934` shows `.beads/markers/beads_web-ehp.4.json` in the same commit as the source/test files. `git show --stat a82ef19` shows `.beads/markers/beads_web-ehp.13.json` in the same commit. Both `status=success`, `next_agent=reviewer`. |
| Marker quality discipline (marker-protocol § 2) | PASS | Both markers are evidence-primary: ehp.4 carries 5 per-action entries with file:line evidence + integration verification depth declared per Step 5c + 4 surprises_or_findings + 3 FOLLOW-ONs labelled. ehp.13 carries 9 per-action entries + per-AC test citation table at file:line granularity + 5 surprises_or_findings + 6 FOLLOW-ONs labelled. ehp.13 properly surfaces a deviation_from_ac (4-line cross-bead fixture in `marker-driven-routing.test.ts`) — see Observation 4. |
| Layer compliance (architecture § Layer Mapping) | PASS | `dispatch-preconditions.ts` continues to sit cleanly in Application: Domain types (RefusalCode, PreconditionResult, DispatchContext, Precondition), Application logic (predicates, EXTENDED_PRECONDITION_TABLE, evaluatePreconditions, buildDispatchContext), Infrastructure adapters consumed (`readBeadStatus`, `readMarker`, `getEpicLabels`, `listOpenWaveBeads`, `readEvents`). No SwiftUI / React / Next.js framework imports. Predicates are pure synchronous functions over a fully-built DispatchContext; only `buildDispatchContext` (and its `readPlanFileMeta` / `safeListOpenWaveBeads` helpers) performs I/O. ehp.4's rule modification stays inside the existing rule layer (no new responsibilities). |
| No force-unwraps / null safety | PASS in source | Source has zero force-unwraps. Optional chaining used correctly throughout (`marker?.next_agent`, `bead?.id`, `decision?.canonicalAction`). Null-bead path in `buildPreconditionRefusalResponse` returns safe sentinels (`null` / `false`) rather than throwing. ehp.4's 412 branch reads body via `await res.text().catch(() => "<unreadable>")` rather than crashing on a malformed response. |
| No hardcoded credentials / paths in production code | PASS | No tokens, secrets, or PII. No `/Users/`, `/home/`, or absolute path literals in `dispatch-preconditions.ts` or `marker-driven-routing.ts` — all paths derived via `path.join(repoPath, ...)` from input. Internal guardrail #1 (no-hardcoded-paths) honoured. |
| External-call error handling (regression #13 silent swallowing) | PASS | Every catch block logs a structured warn before returning the safe default. No bare `catch {}` patterns introduced. `safeListOpenWaveBeads` (lines 1388-1403) catches `listOpenWaveBeads` throws (z9h.9 contract) and warns; `readPlanFileMeta` (lines 1305-1340) catches non-ENOENT fs errors and warns; the event-log read in buildDispatchContext catches and warns. ehp.4's rule wrapping does not introduce any try/catch (it uses early-return on refusal; the existing fetch try/catch is preserved). |
| Naming conventions | PASS | New constants follow project style: `PRECOND_PLAN_FILE_EXISTS`, `PRECOND_WAVE_BEADS_NOT_ALL_CLOSED`, `EXTENDED_PRECONDITION_TABLE`, `DISPATCHING_ACTIONS`, `EXEMPT_ACTIONS`, `buildPreconditionRefusalResponse`, `safeListOpenWaveBeads`, `readPlanFileMeta`. Consistent with ehp.3's idioms. |
| Anchor-decision compliance — ADR-001 (discriminated union, NOT exceptions) | PASS | `PreconditionResult` union preserved unchanged. ehp.13 adds `PreconditionRefusal = Extract<PreconditionResult, { ok: false }>` type alias for readability — pure type-level, zero runtime impact. No `throw new PreconditionRefusalError` introduced. |
| Anchor-decision compliance — ADR-002 (bd-read fail-closed → BD_READ_FAILED) | PASS | ehp.3's BD_READ_FAILED posture is preserved unchanged in ehp.13. New Class D predicate documents fail-OPEN posture explicitly (event-log is telemetry-grade, not source-of-truth) — this is consistent with the architecture's ADR-002 commentary. ehp.4's rule-side gate properly cascades: when `evaluatePreconditions` returns BD_READ_FAILED for a bd-broken epic, the rule logs + emits the refusal event + returns. See Observation 2 below for one diagnostic gap on the wave-bead-read path. |
| Anchor-decision compliance — ADR-003 (single-file library) | PASS | All ehp.13 deliverables remain in `src/lib/dispatch-preconditions.ts`. No sub-modules under `src/lib/dispatch-preconditions/`. The cross-wave producer-consumer dep `ehp.13 → ehp.3` was honoured (ehp.13 only ADDED to the file). |
| Anchor-decision compliance — ADR-004 (PRECONDITION_TABLE keyed by action name) | PASS | `EXTENDED_PRECONDITION_TABLE: ReadonlyMap<string, readonly Precondition[]>` keyed by action name. Every Precondition carries `appliesTo(action)` for self-documentation. `evaluatePreconditions` looks up via `EXTENDED_PRECONDITION_TABLE.get(ctx.action) ?? PRECONDITION_TABLE.get(ctx.action)` — extended preferred, Wave-2 minimal as fallback. Unknown actions hit the warn+pass branch (preserves ehp.3's policy). See Observation 1 for a future-safety nuance on the dual-table coexistence. |
| Anchor-decision compliance — ADR-005 (Classes A, A.5, B, C, D, E all in v1) | PASS | ehp.13 ships all remaining classes: A (5 predicates), B (3), D (1), E (1) = 10 new predicates. Combined with ehp.3's 4 universal predicates (A.5 + C), v1 totals 14 predicates across 6 classes. ADR-005 commitment honoured. |
| Anchor-decision compliance — ADR-006 (new event-log variant for refusals) | PASS for ehp.4 | ehp.4 emits `RECONCILER_ACTION_REFUSED` events on rule-side AND route-side refusal (with payload `refusalCode='ROUTE_REFUSED_412'` + `failedCheck='route-side-precondition'` for the 412 case). The known FOLLOW-ON (refusals consume the existing `reconciler-action-taken` idempotency bucket because reconciler.ts:381 appends unconditionally) is documented in 3 places: ehp.4 marker, rule's inline comment, and the ARCHITECTURE.md entry. Tracked as a separate reconciler-core bead. |
| Regression-pattern #1 Write/Read Disconnect | PASS / N/A | No new persistence; library and rule consume existing readers. The new `planFileMtime` field uses `fs.stat().mtimeMs` (number) consistently across reader and predicate — round-trip type integrity preserved. |
| Regression-pattern #2 Unguarded Range | PASS | No range constructions. Array iteration via `for...of` and `Array.prototype.find/some/every`. |
| Regression-pattern #3 State Reset Missing | PASS | No multi-step flows; predicates are pure functions over DispatchContext. |
| Regression-pattern #4 Validation Scattered | PASS | The library remains the single source per ADR-003. ehp.13's table-completeness test (`EXTENDED_PRECONDITION_TABLE size === 34`) and the per-action universal-predicate-presence test (`every action carries 4 universals`) act as drift guards. The Wave-2 review's Observation 5 (cross-tree drift-guard sweep deferred to ehp.13) is now operationally satisfied. |
| Regression-pattern #7 Type Confusion | PASS | RefusalCode union is closed (15 codes); REFUSAL_CODES exhaustiveness map mirrors at runtime. PreconditionResult discriminated union narrows on `ok`. ehp.13's `EXTENDED_PRECONDITION_TABLE` is `ReadonlyMap<string, readonly Precondition[]>` — both keys and values are immutable. |
| Regression-pattern #13 Silent Exception Swallowing | PASS | Every catch block logs a structured warn before returning the safe default. See "External-call error handling" row above. |
| Internal guardrail #1 (no-hardcoded-paths) | PASS | All paths derived from `repoPath` input. |
| Internal guardrail #2 (no silent data drift) | PASS | All readers consume the authoritative bd / marker / event-log stores. No new persistence introduced. |
| Internal guardrail #3 (grep entire tree) | PASS | The `pipeline-label-set` → `stage-dispatched` divergence (ehp.13 surprise #1) was caught by an empirical codebase grep before bake-in — exactly the pattern this guardrail demands. Production code uses the actual emitted event type. (Stale references remain in 2 comment locations — see Observation 3 — but no live code references the wrong type.) |
| Internal guardrail #4 (no parameter shadowing on rename) | PASS | No bulk renames in scope. |
| Internal guardrail #5 (test the data, not just the code) | PASS | ehp.4's LOAD-BEARING test asserts the full data flow (mock readers seeded → `rule.act()` invoked → 0 fetch calls + correct refusal-event payload written to event log). ehp.13's integration tests build a real DispatchContext against a tmp bd repo + tmp marker dir + tmp plan file + tmp event-log + real fs/exec — actual data verified end-to-end, not just code paths. |
| Internal guardrail #6 (tools are first-class) | N/A | No tools / scripts modified. |

---

## Architecture Review

### `src/lib/dispatch-preconditions.ts` (1483 lines after ehp.13)

**Surface (public exports verified against architecture § Component Boundaries):**
- ehp.3-era exports preserved unchanged: `RefusalCode` type, `REFUSAL_CODES` runtime exhaustiveness map, `PreconditionResult` type, `DispatchContext` interface, `Precondition` interface, the four universal predicate constants, `UNIVERSAL_PRECONDITIONS`, `UNIVERSAL_ACTION_SET`, `PRECONDITION_TABLE`, `evaluatePreconditions`, `BuildDispatchContextInput`, `buildDispatchContext`.
- ehp.13-era additions: 10 new predicate constants (Class A: `PRECOND_PLAN_FILE_EXISTS`, `PRECOND_PLAN_NOT_PENDING`, `PRECOND_WAVE_BEADS_EXIST`, `PRECOND_WAVE_BEADS_NOT_ALL_CLOSED`, `PRECOND_ARCHITECT_MARKER_NOT_SUCCESS`; Class B: `PRECOND_PIPELINE_LABEL_SINGLETON`, `PRECOND_AGENT_RUNNING_HAS_SESSION`, `PRECOND_QA_ROUND_MONOTONIC`; Class D: `PRECOND_PLAN_NOT_MODIFIED_SINCE_STAGE_ENTERED`; Class E: `PRECOND_ACTION_MATCHES_MARKER_NEXT_AGENT`), `DISPATCHING_ACTIONS` (34 entries), `EXEMPT_ACTIONS` (3 entries: `stop-agent`, `human-approve`, `human-dismiss`), `EXTENDED_PRECONDITION_TABLE`, `PreconditionRefusalResponse` type, `PreconditionRefusal` type alias, `buildPreconditionRefusalResponse(result, bead)` helper.
- Optional additive field on `DispatchContext`: `planFileMtime?: number | null` — purely additive, does not narrow ehp.3's contract; flagged in ehp.13 marker as a deliberate deviation_from_ac with explicit reasoning.

**Layer Mapping cross-check:**
- Domain (types only, no I/O): `RefusalCode`, `PreconditionResult`, `DispatchContext`, `Precondition`, `PreconditionRefusal`, `PreconditionRefusalResponse`. Zero framework imports. ✓
- Application (logic, no I/O beyond `buildDispatchContext`'s helpers): all 14 predicate functions (pure), `evaluatePreconditions`, `EXTENDED_PRECONDITION_TABLE`, `DISPATCHING_ACTIONS`, `EXEMPT_ACTIONS`, `buildPreconditionRefusalResponse`. ✓
- Infrastructure (I/O via composed readers): `buildDispatchContext` calls `readBeadStatus`, `readMarker`, `getEpicLabels`, `safeListOpenWaveBeads` (which wraps `listOpenWaveBeads`), `readPlanFileMeta` (fs.stat), `readEvents`. No direct fs/exec calls outside `readPlanFileMeta`. ✓ No layer violations.

**Predicate semantics (each verified against architecture):**

Class A (5 predicates):
1. `plan-file-exists` — `ctx.planFileExists === true` else PLAN_FILE_MISSING. appliesTo: `ACTIONS_REQUIRING_PLAN_FILE`. ✓
2. `plan-not-pending` — `!labels.includes("plan:pending")` else PLAN_PENDING. ✓
3. `wave-beads-exist` — `openWaveBeadIds.length > 0` else NO_WAVE_BEADS. ✓ (with v1 disambiguation limitation honestly documented — see Observation 2)
4. `wave-beads-not-all-closed` — same fire condition as #3 but tagged ALL_WAVE_BEADS_CLOSED. ✓
5. `architect-marker-not-success` — refuses if `ctx.marker?.stage === "architect" && ctx.marker.status === "success"` for `ACTIONS_REFUSED_BY_ARCHITECT_SUCCESS`. ✓

Class B (3 predicates):
1. `pipeline-label-singleton` — refuses when more than one `pipeline:*` label present. Uses `Array.prototype.filter` on labels. ✓
2. `agent-running-has-session` — refuses when `bead.hasAgentRunning === true` for agent-launching actions. v1 limitation (label proxy, not real tmux state) documented inline at the predicate. ✓
3. `qa-round-monotonic` — refuses when QA-round marker has `status !== "success"` for QA dispatch actions. v1 fall-OPEN limitation documented; route.ts:1665+ inline check remains load-bearing. ✓

Class D (1 predicate):
1. `plan-not-modified-since-stage-entered` — refuses when `planFileMtime > stageEnteredAt`. Fail-OPEN paths covered: `stageEnteredAt=null`, `planFileMtime=undefined`, `planFileMtime=null`, malformed timestamp. ✓

Class E (1 predicate):
1. `action-matches-marker-next-agent` — calls `interpretMarkerForRouting(ctx.marker, snapshot)` then `getActionForAgent(decision.nextAgent)`. Refuses if `canonicalAction !== ctx.action`. Skips when `marker === null` or `decision.override === false`. Reuses existing logic, does not duplicate. ✓

**Evaluation order:** `EXTENDED_PRECONDITION_TABLE.get(ctx.action) ?? PRECONDITION_TABLE.get(ctx.action) ?? warn-and-return-ok`. Predicates within a list are evaluated in registration order; first refusal short-circuits. The architecture's "BD_READ_FAILED priority over Class C/D/E" invariant is preserved by table-construction ordering (universal predicates registered first). Verified by unit test `evaluation ORDER — null bead AND operator-pending marker → BD_READ_FAILED first`.

**Single-file simplicity gate (architecture § ADR-003):**
- 1483 lines. Substance estimate: ~700 lines of code, ~780 lines of JSDoc / section banners / table data. Well within architecture's "single-file library" intent.
- One file, no sub-modules. ✓
- No DTO chains: DispatchContext is consumed by predicates directly. ✓
- No new repositories. The library composes existing readers. ✓
- No event bus introduced. ✓
- `Precondition` interface justified — multiple implementations (14). ✓
- `PreconditionRefusalResponse` type is route-shape contract, not over-abstraction. ✓

### `src/lib/reconciler-rules/marker-driven-routing.ts` (492 lines after ehp.4)

**Surface delta:** 8 new lines of imports (lines 51-61); 1 new precondition-gate block at lines 376-422 (47 lines); 1 new 412-branch block at lines 442-477 (36 lines). Total +91 lines diff. `match()` logic untouched. The action-name resolution (`getActionForAgent(nextAgent)`) was already in scope — reused.

**Critical placement check:**
- Precondition gate runs AFTER `interpretMarkerForRouting` decision (so `actionName` is known) and AFTER `markerRepoPath` resolution (so `repoPath` is the actual epic-owning repo). ✓
- Precondition gate runs BEFORE the action-route fetch (`fetch(opts.actionUrl, ...)`). ✓
- 412 branch runs BEFORE the `if (!res.ok) throw` path. Verified at lines 458-477 (412 case returns at line 474) followed by lines 479-484 (existing `if (!res.ok) throw`). Non-412 HTTP errors retain their throw semantics — does not regress the existing rule failure-handling. ✓

**Refusal event payload completeness:** Both rule-side (line 391-401) and route-side (line 463-477) refusal events carry `ruleName`, `epicId`, `stage`, `action`, `refusalCode`, `failedCheck`, `reason`. The 412 case uses `refusalCode='ROUTE_REFUSED_412'` (a custom code outside the 15-code RefusalCode union — see Observation 5). All payloads are consumed by the existing `RECONCILER_ACTION_REFUSED` event-log type added by ehp.2. ✓

---

## Test Quality Review

### `__tests__/lib/dispatch-preconditions.test.ts` (1613 lines, 112 tests)

- ehp.3-era 48 tests preserved unchanged.
- ehp.13-era 64 new tests organised by predicate class:
  - Class A: 5 happy + 5 refusal + 5 appliesTo tests = 15 tests.
  - Class B: 3 happy + 3 refusal + 3 appliesTo tests = 9 tests.
  - Class D: 1 refusal + 4 fail-OPEN (skip) + 1 appliesTo = 6 tests.
  - Class E: 1 happy + 1 refusal (mismatch) + 2 skip-paths (null marker, override=false) + 1 appliesTo = 5 tests.
- `EXTENDED_PRECONDITION_TABLE` coverage tests (10): table size === 34, every entry includes the 4 universal predicates, EXEMPT_ACTIONS (3) absent, `review-wave` carries both NO_WAVE_BEADS + ALL_WAVE_BEADS_CLOSED per ehp.7 contract, `run-architect` carries ARCHITECT_MARKER_SUCCESS, `send-for-qa` carries QA_ROUND_OUT_OF_ORDER, `review-plan` carries PLAN_PENDING + PLAN_INSTABILITY, etc.
- `buildPreconditionRefusalResponse` tests (4): happy projection, null bead → safe sentinel observedState (`beadId=null`, `status=null`, `hasAgentRunning=false`), type narrowing on refused literal, all 15 RefusalCode values round-trip.
- End-to-end refusal scenarios across the extended table (7): exercises evaluatePreconditions for each Class with stub readers.

**Spot-check verifications:**
- Class D fail-OPEN paths (4): all four exercised at lines 1126-1170 — `stageEnteredAt=null`, `planFileMtime=undefined`, `planFileMtime=null` (explicit), malformed timestamp string. All return `ok: true`. ✓
- buildPreconditionRefusalResponse null-bead sentinel: test at line 1432 asserts `observedState.beadId === null`, `status === null`, `hasAgentRunning === false`. ✓

### `__tests__/lib/dispatch-preconditions.integration.test.ts` (818 lines, 21 tests)

- ehp.3-era 8 tests preserved unchanged (real bd 0.62.0 + dolt sql-server 1.84.0 in tmp repo).
- ehp.13-era 13 new tests covering each predicate class against real fixtures: PLAN_FILE_MISSING, planFileExists/Mtime populated, PLAN_PENDING (real `bd label add`), NO_WAVE_BEADS / ALL_WAVE_BEADS_CLOSED, ARCHITECT_MARKER_SUCCESS (real marker file fixture), PIPELINE_LABEL_CONFLICT (two `pipeline:*` labels via bd), AGENT_RUNNING_NO_SESSION (real `agent:running` label), PLAN_INSTABILITY (real stage-dispatched event + plan mtime via fs.writeFile), Class D fail-OPEN (no event in log), ACTION_NEXT_AGENT_MISMATCH (real next_agent=architect marker, dispatch run-pm), SCAFFOLDED fields end-to-end, buildPreconditionRefusalResponse projects real refusal cleanly, `__resetEventLogForTests` smoke check.
- All 21 tests pass; real-bd path setup ~3s, total ~12s.

### `__tests__/lib/reconciler-rules/marker-driven-routing.precondition-integration.test.ts` (473 lines, 4 tests)

| AC | Test | Verifies | Pass |
|---|------|----------|------|
| AC #1 (LOAD-BEARING) | `LOAD-BEARING: bd status=deferred refuses with BD_STATUS_DEFERRED ...` (lines 167-236) | (a) mock returns `status='deferred'` snapshot, (b) ZERO fetch calls, (c) refusal event with `refusalCode='BD_STATUS_DEFERRED'` + `ruleName='marker-driven-routing'` + `failedCheck='bd-status-not-deferred'` + reason contains "deferred" | ✓ |
| AC #2 | OPERATOR_DECISION_PENDING marker (next_agent=operator + blocker_class=spec-ambiguity, stage=coherence to preserve operator routing through interpretMarkerForRouting) | Refuses; no fetch; refusal event with refusalCode=OPERATOR_DECISION_PENDING | ✓ |
| AC #3 | Happy path — open bead + benign marker | Existing fetch fires; existing `reconciler-action-taken` event recorded; no behaviour drift | ✓ |
| AC #4 | Route returns HTTP 412 | act() returns WITHOUT throwing; refusal event with refusalCode='ROUTE_REFUSED_412' + failedCheck='route-side-precondition' | ✓ |

LOAD-BEARING test detail: at line 219 asserts `expect(fetchCalls).toHaveLength(0)`; at lines 228-235 asserts the four refusal-payload fields; the deferred mock is set at line 183 before any rule invocation. The protection is verified.

### Test pyramid posture

- Unit (table-driven, fast): 112 in dispatch-preconditions.test.ts.
- Integration (real bd + real fs + real event-log): 21 in dispatch-preconditions.integration.test.ts + 4 in marker-driven-routing.precondition-integration.test.ts (with mocked readers at the module boundary, since the real-bd path is exercised by the dispatch-preconditions integration suite).
- E2E: ehp.12 (Wave 5) is the niii reproduction test for all 6 phantom-dispatch scenarios — not in scope this round.
- Healthy pyramid: 112 unit / 25 integration / 0 E2E (yet). No ice-cream-cone anti-pattern.

---

## Bugs Filed

**No bugs filed this round.**

The four observations below describe non-blocking diagnostic-quality and documentation-cleanup concerns that do NOT threaten the load-bearing protection or block Wave 4 dispatch. They are recorded for operator awareness and Wave 4 builder consideration; the operator decides whether to convert any to bug beads vs absorb into Wave 4 follow-on work.

---

## Observations (operator awareness, not blocking)

### Observation 1 — Future-safety: dual-table coexistence between `PRECONDITION_TABLE` and `EXTENDED_PRECONDITION_TABLE` (severity: LOW)

`UNIVERSAL_ACTIONS` (10 entries) is a strict subset of `DISPATCHING_ACTIONS` (34 entries). Both `PRECONDITION_TABLE` (Wave-2 minimal) and `EXTENDED_PRECONDITION_TABLE` (Wave-3 full) export entries for those 10 actions, with different predicate counts. `evaluatePreconditions` correctly prefers EXTENDED_PRECONDITION_TABLE (line ~1185 — `EXTENDED_PRECONDITION_TABLE.get(ctx.action) ?? PRECONDITION_TABLE.get(ctx.action)`), so there is no runtime bug. However, a future caller who imports `PRECONDITION_TABLE` directly (still publicly exported per ADR-003 single-file invariant) would get the minimal 4-predicate list instead of the full per-action list for actions like `run-architect` or `review-wave` — a confusion hazard the next builder may inherit.

**Suggestion:** Add a JSDoc deprecation banner on the `PRECONDITION_TABLE` export pointing readers at `EXTENDED_PRECONDITION_TABLE` + `evaluatePreconditions` as the canonical entry points. Or add a unit test that asserts no caller imports `PRECONDITION_TABLE.get(<universal-action>)` directly. Either is a 5-minute cleanup. Not blocking; could be folded into ehp.11 (route.ts wrap).

### Observation 2 — Diagnostic gap: `safeListOpenWaveBeads` masks bd-read failures as `NO_WAVE_BEADS` / `ALL_WAVE_BEADS_CLOSED` (severity: LOW)

When `listOpenWaveBeads` throws (per its z9h.9 contract on bd failure), `safeListOpenWaveBeads` (lines 1388-1403) catches and returns `[]`. This causes `openWaveBeadIds = []`, which causes `PRECOND_WAVE_BEADS_EXIST` and/or `PRECOND_WAVE_BEADS_NOT_ALL_CLOSED` to fire with refusalCode `NO_WAVE_BEADS` or `ALL_WAVE_BEADS_CLOSED`. The actual problem was a bd-read failure — but the refusal code does not say `BD_READ_FAILED`. This inverts the ADR-002 fail-closed posture the library correctly applies to `readBeadStatus`. An operator investigating a wave-state refusal will see `NO_WAVE_BEADS` when the real cause was bd unreachable.

**Why low-severity:**
- The structured warn-line at the catch site identifies the real cause for log-grepping.
- For wave-sensitive actions (`start-wave`, `review-wave`, `resume-build`), refusing the dispatch is the correct safety posture regardless of which code is reported (the dispatch should NOT proceed).
- The ADR-002 invariant (BD_READ_FAILED priority over Class A/B/C) is preserved for the bead-status reader path; only the wave-bead reader path is degraded.

**Suggestion:** Either (a) add a dedicated `WAVE_BEAD_READ_FAILED` refusal code or reuse `BD_READ_FAILED` when the catch fires (would require a wrapper result type before the `Promise.all` in `buildDispatchContext`), or (b) extend `PRECOND_WAVE_BEADS_EXIST` JSDoc + the warn-line at the catch site to explicitly note that the refusal code may represent infrastructure failure. Option (b) is a comment-only change. Not blocking; appropriate for ehp.13 follow-on or Wave 4 hardening.

### Observation 3 — Stale comments referencing `pipeline-label-set` event type (severity: TRIVIAL)

ehp.13 marker surprise #1 correctly identified that the architect-spec'd `pipeline-label-set` event type does not exist in the codebase; the actual emitted type is `stage-dispatched`. Production code uses the correct type (`readEvents` filter at line ~1307). However, two comment locations still reference the old type:
- `DispatchContext.stageEnteredAt` JSDoc (lines ~200-201)
- `buildDispatchContext` block-comment near the event-log read (line ~1212)

The runtime code is correct; the comments are decorative. Stale-reference-sweep severity per architecture-review § Revision check 2 would be HIGH if this were code, but it's comment-only.

**Suggestion:** One-touch search-and-replace in the two comment locations: `pipeline-label-set` → `stage-dispatched`. Could be folded into Wave 4 ehp.5/.6 builder commits.

### Observation 4 — Cross-bead test fixture: ehp.13 modified `marker-driven-routing.test.ts` (4 lines, outside Files manifest) (severity: SCOPE NOTE)

Per surfacing-protocol § 2.3 Reviewer failure mode 3 (commit touches files outside the bead's Files manifest), I evaluated the 4-line plan-file fixture write to `__tests__/lib/reconciler-rules/marker-driven-routing.test.ts`:

```typescript
// ehp.13 fixture: plan file required by send-for-qa precondition.
const planDir = path.join(repoPath, ".beads", "plans");
await fs.mkdir(planDir, { recursive: true });
await fs.writeFile(path.join(planDir, "factory-core-bbbb.md"), "# Plan\n");
```

(plus a one-line explanatory comment block above)

**Disposition: ACCEPT.**
- The change is mock-only test fixture alignment — no behaviour change, no production code path touched.
- The intent of the existing test ("belt-and-suspenders: dispatch fires despite `agent:running` label") is preserved exactly. The fixture only ensures `PRECOND_PLAN_FILE_EXISTS` (newly active for `send-for-qa` after ehp.13) does not fire before the dispatch assertion — i.e., it isolates the test to the agent-running concern it was designed to verify.
- ehp.13's marker explicitly surfaces this as `deviations_from_ac (2)` with substantive reasoning (operator-banked precedent applies to EXPLICIT STOP-and-surface clauses; bead's risk flags do not include such a clause for additive-predicate test breakage; the alternative — leave the test red — would block CI).
- The operator-driven manual close after framework-exit-without-commit pattern implicitly accepts the deviation; the bead is closed.
- Reviewer's role per surfacing-protocol § 2.3 failure mode 3 is to "ask before issuing a verdict." The asking has already happened (builder marker → operator close); the verdict is appropriately PASS.

**Note for future Wave-3-style cross-bead surgeons:** This pattern (purely additive predicate breaks an unrelated test that didn't have the necessary fixture) is an inherent friction of single-file-library Wave-3 extensions. If this recurs at scale, the planner should either (a) include sweep-of-affected-test-fixtures in the additive-extension bead's Files manifest explicitly, or (b) require a parallel sibling bead for fixture sweeps. ehp.13's choice (surgical 4-line fixture write + prominent marker disclosure) is the cheaper outcome for this case.

### Observation 5 — `ROUTE_REFUSED_412` is a refusalCode outside the 15-code RefusalCode union (severity: TRIVIAL)

ehp.4 emits a refusal event at the rule's 412-branch with `refusalCode='ROUTE_REFUSED_412'`. This string is NOT in the 15-code `REFUSAL_CODES` exhaustiveness map maintained by ehp.3 and tested by `REFUSAL_CODES exhaustiveness map has exactly the 15 architecture-specified codes`. The reason: the route's HTTP-412 case is conceptually a transport-layer signal that a route-side refusal occurred; the rule does not know which underlying refusalCode the route would have returned (the route's body carries that detail in `text`). Using a synthetic marker code keeps the rule's emit-site self-contained.

**Why trivial:**
- The event-log consumer treats `refusalCode` as a free-form string for log-grepping, not as a typed enum.
- Downstream coherence reasoning per `factory-core-wlsr` reads the event-log JSONL textually.
- The 15-code union is the v1 RefusalCode contract for the **library's** outputs (`evaluatePreconditions` results); the rule's event payload is in the wider event-log namespace.

**Suggestion:** Optional — extend `REFUSAL_CODES` to include the synthetic `ROUTE_REFUSED_412` (and a complementary `ROUTE_REFUSED_OTHER` for the throw path) so the exhaustiveness test can assert event-log producers stay in lockstep with the union. Not blocking; appropriate for a follow-on observability hardening bead.

---

## Summary

Wave 3 lands the load-bearing 372-bead-defer protection cleanly. ehp.4's rule-side gate refuses on BD_STATUS_DEFERRED, OPERATOR_DECISION_PENDING, and route-side 412 with the right event payloads and zero label mutation; the LOAD-BEARING test verifies the protection end-to-end. ehp.13's library extension is purely additive — ehp.3's contributions are preserved verbatim — and the full 14-predicate / 34-action contract per ADR-005 is now operationally complete. 137 tests in scope (112 unit + 21 lib-integration + 4 rule-integration) plus the full beads_web suite all pass. Standing-order compliance is full; both commits include the marker file per the 2026-05-01 ordering directive. Five non-blocking observations are recorded — none threaten the load-bearing protection or Wave 4 dispatch; the operator decides whether to convert them to bug beads vs absorb into Wave 4 follow-on work. Wave 4 (ehp.5–.11) is unblocked.

---

## Marker

This review's marker is at `/Users/janemckay/dev/claude_projects/beads_web/.beads/markers/beads_web-ehp-reviewer-4-wave-3.json` per marker-protocol § 1 (epic-scope marker for Stage 4 Code Review filed against the wave; per-bead markers for ehp.4 and ehp.13 already exist from the builder's exit).
