# Code Review — beads_web-ehp Wave 4 Round 1

**Epic:** beads_web-ehp — Action route lacks precondition checks (load-bearing for 372-bead mass-defer)
**Wave:** 4 (5 reconciler-rule integrations + dispatchChainAction inline branch + route.ts 38-action retrofit)
**Round:** 1
**Reviewer:** reviewer agent (Stage 4 — Code Review)
**Date:** 2026-05-07
**Ship type:** internal
**Product repo:** /Users/janemckay/dev/claude_projects/beads_web
**Plan:** /Users/janemckay/dev/fleet/factory-core/.beads/plans/beads_web-ehp.md
**Architecture:** /Users/janemckay/dev/fleet/factory-core/docs/research/action-route-lacks-precondition-checks.md

---

## Verdict: FAIL

The 7 Wave-4 beads (ehp.5/.6/.7/.8/.9/.10/.11) are individually well-implemented: each ships its precondition gate at the correct call-site placement (BEFORE label mutation, BEFORE dispatch fetch), each emits structured `reconciler-action-refused` events, each handles HTTP 412 from the route as defense-in-depth without throwing, each has a per-rule integration test asserting the LOAD-BEARING refusal scenario, and `reconciler-bootstrap.ts` correctly wires `repoPath` into all 5 reconciler rules so the production path is fully gated.

**However,** a post-Wave-4 fix (commit `1cb58a5`, "fix(dispatch-preconditions): remove review-wave from ACTIONS_REQUIRING_WAVE_BEADS") shipped without updating its own tests. Running `npx jest` against HEAD now produces:

- **Test Suites: 2 failed, 114 passed, 116 total**
- **Tests: 4 failed, 2 skipped, 2336 passed, 2342 total**

The 4 failing tests include the **LOAD-BEARING ehp.7 test** that proves the niii reviewer-4-wave-4-redundant phantom dispatch is refused (`__tests__/lib/reconciler-rules/missed-wave-review-dispatch.precondition-integration.test.ts:342`). The exact protection ehp.7 was designed to deliver is **regressed at HEAD**.

This is a Critical Guardrail #4 violation (`standards/generic/agent-discipline.md` § 10: "Never merge without full test suite green — no exceptions, no 'it's just a small change'") and a Bug Fix Sequence § 3 violation (no failing test was written first, no full suite run was performed).

**Bugs filed:**
- **beads_web-m2c** (P0) — test suite RED + ehp.7 LOAD-BEARING protection regressed.
- **beads_web-o2s** (P2) — ehp.10 marker incorrectly claims `deviations_from_ac: None` despite Files-manifest + Out-scope violation.

Wave 4 cannot be marked complete until **m2c** is resolved. **o2s** is a marker-discipline note (the underlying code is correct).

---

## Beads in Wave 4

| Bead ID | Title | `wave:4` Label | Status | Commit |
|---------|-------|----------------|--------|--------|
| beads_web-ehp.5 | stuck-in-stage precondition gate | YES | closed | ffc2c66 |
| beads_web-ehp.6 | wave-bead-mismatch precondition gate (gates rollback + dispatch) | YES | closed | b97b9db |
| beads_web-ehp.7 | missed-wave-review-dispatch precondition gate | YES | closed | e11bc89 (re-dispatched after Goodbye-without-marker on first run) |
| beads_web-ehp.8 | repeat-dispatch-escalation precondition gate | YES | closed | d74273f |
| beads_web-ehp.9 | repeated-qa-round precondition gate (label-add gated) | YES | closed | e5453a7 |
| beads_web-ehp.10 | dispatchChainAction inline marker-routing branch precondition gate | YES | closed | 3d6b60d |
| beads_web-ehp.11 | route.ts — all 38 action handlers precondition retrofit (34 DISPATCHING + 3 EXEMPT) | YES | closed | 553e9ee |

**Post-Wave-4 fix-up commits (not bead-attributable but in scope for Wave 4 review):**

| Commit | What it fixed | New issue introduced |
|--------|---------------|----------------------|
| 32c76b8 | ehp.11's route.ts precondition gate hardcoded `repoPath: fleetCorePath` — broke EVERY cross-repo epic dispatch (BD_READ_FAILED for `beads_web-*` epics). | None on its own. |
| 2c2cab5 | 32c76b8 caused route handlers to hang for 60s on `findRepoForIssue` parallel probe. Adds prefix fast-path + 5s timeout. | Hardcoded literal `/Users/janemckay/dev/claude_projects/beads_web` at `route.ts:496` (Internal guardrail #1 violation; tracked as part of `beads_web-poh.3`). |
| e11bc89 | ehp.7's first dispatch builder exited without writing a marker (Goodbye-without-marker pattern); required start-wave 4 re-dispatch + several intervening route fixes. | None on the rule code — second builder ran cleanly + self-committed. Process issue tracked under `beads_web-poh.1`. |
| **1cb58a5** | **review-wave incorrectly listed in ACTIONS_REQUIRING_WAVE_BEADS — empirically reproduced 2026-05-07 00:17 BST when review-wave 4 returned HTTP 412 with refusalCode=NO_WAVE_BEADS despite all 7 Wave-4 beads being correctly closed.** | **4 unit + integration tests broken at HEAD; ehp.7 LOAD-BEARING niii reviewer-4-wave-4-redundant test now fails. Filed as `beads_web-m2c` P0.** |

---

## Standing Order Compliance

| Check | Status | Notes |
|-------|--------|-------|
| Investigation-Before-Code (agent-discipline § 1) | PASS for all 7 beads | Each marker documents substantive cross-checks (architecture references, sibling-rule pattern verification, predicate ordering, action-name resolution). |
| Plan Decomposition (agent-discipline § 2) | PASS | Plan exists at `.beads/plans/beads_web-ehp.md` (round 2). All 7 beads have explicit AC, Files manifest, epic label, ship-type label, and `wave:4` label. Cross-wave dep `Wave-4 → ehp.13/ehp.3` honoured. Intra-wave parallelism: per the Wave-4 Parallelism summary, all 7 beads modify disjoint files (5 distinct rule files + agent-launcher.ts + route.ts). Safe under dep-naive `start-wave` dispatcher. |
| Tests Written (agent-discipline § 4) | PARTIAL — see Bug `beads_web-m2c` | Wave-4 beads added 6 new precondition-integration test files (3,162 lines, ~40 tests) covering the LOAD-BEARING refusal scenarios for each rule + the route. **HOWEVER**: post-Wave-4 fix `1cb58a5` shipped without test updates and broke 4 existing tests. |
| **Test Suite Green (Critical Guardrail #4)** | **FAIL — see Bug `beads_web-m2c`** | **`npx jest` against HEAD: 2 suites fail, 4 tests fail, including ehp.7's load-bearing niii reviewer-4-wave-4-redundant test. The fix author shipped the broken state.** |
| TypeScript clean (in scope) | PARTIAL | Per ehp.7, ehp.9, ehp.10, ehp.11 markers: zero new TS errors in their modified files. Pre-existing TS errors in `__tests__/api/*` route tests (Next.js param-shape drift) are unchanged from prior waves. |
| Bead-id-first commit policy (agent-discipline § 7) | PASS | Every Wave-4 commit message starts with `beads_web-ehp.<n>:`. All include `Co-Authored-By: Claude Opus 4.7`. |
| Marker write LAST + part of commit (marker-protocol § 1, 2026-05-01 directive) | PARTIAL | ehp.7/.8/.10/.11 markers are in their builders' commits (per `git show --stat`). ehp.5/.6/.9 markers are in their commits BUT the close reasons all note "Builder did NOT self-commit; operator-drive finalised" or "Builder did not self-commit" — the operator finalised the commit on the builder's behalf. Tracked under `beads_web-poh.1` (framework-exits-without-commit). The marker file IS in the commit, but the commit ordering+attribution is non-canonical. Not a Wave-4-attributable defect. |
| Marker quality discipline (marker-protocol § 2) | PARTIAL — see Bug `beads_web-o2s` | ehp.5/.6/.7/.8/.9/.11 markers are evidence-primary, with file:line citations + per-AC verification + surprises + FOLLOW-ONs. **ehp.10 marker incorrectly claims `deviations_from_ac: None`** despite the bead's Files manifest specifying a NEW test file `__tests__/lib/agent-launcher.dispatch-preconditions.test.ts` (not created) and the Out scope explicitly forbidding "ANY modification to existing agent-launcher.*.test.ts files" (violated by extending `__tests__/lib/agent-launcher-marker-routing.test.ts`). The deviation itself is ACCEPT-able (the Out clause was infeasible — adding a precondition gate breaks every existing test unless the file is modified for a top-level mock); the marker's "None" claim is the discipline issue. |
| Layer compliance (architecture § Layer Mapping) | PASS | All 5 reconciler rules use the dispatch-preconditions library through its public interface (`buildDispatchContext` + `evaluatePreconditions`). agent-launcher.ts dispatchChainAction calls the same library at the inline branch. route.ts factors the wrap into a private `checkPreconditionsOrRefuse` helper (lines 478-522) that returns `NextResponse | null`. No layer violations. |
| No force-unwraps / null safety | PASS | All readers consume optional chaining safely. `safeListOpenWaveBeads` (in dispatch-preconditions.ts) catches throws and returns `[]`. `routes.ts:checkPreconditionsOrRefuse` catches `findRepoForIssue` throws and falls back. The 412 branches all use `await res.text().catch(() => "<unreadable>")`. |
| **No hardcoded credentials / paths in production code (Internal guardrail #1)** | **FAIL** (already tracked under `beads_web-poh.3`) | `src/app/api/fleet/action/route.ts:496` contains the literal `/Users/janemckay/dev/claude_projects/beads_web` as the resolved path for `beads_web-*` epics (added in commit 2c2cab5 as a fast-path workaround for findRepoForIssue's 60s parallel-probe stall). The fix author themselves notes "the hard-coded beads_web path is brittle if the registry path changes. The proper long-term fix is to make findRepoForIssue itself non-hanging" — tracked under `beads_web-poh.3`. Not a duplicate filing; recorded here for Wave-4 review awareness. |
| External-call error handling (regression #13 silent swallowing) | PASS | Every catch block logs structured warn before returning safe default. No bare `catch {}` patterns introduced. The 412 branches log `dispatch_refused_inline_at_route` / `reconciler_dispatch_refused_at_route` with full context. |
| Naming conventions | PASS | All 5 rules use `RULE_NAME` constants. All emit `ruleName=<rule-name>` payloads on refusal. `dispatchChainAction:inline-marker-routing` is the agreed namespaced ruleName for the inline branch (operator can grep refusal events by dispatch site). `checkPreconditionsOrRefuse` and `parsedWaveNumber` (route.ts) follow project camelCase style. |
| Anchor-decision compliance — ADR-001 (discriminated union, NOT exceptions) | PASS | All 7 beads consume `evaluatePreconditions` results via `if (!result.ok)` discriminated-union narrowing. No throws on refusal. |
| Anchor-decision compliance — ADR-002 (bd-read fail-closed) | PASS | All 5 rules + agent-launcher inline branch + route helper preserve fail-closed semantics: when `buildDispatchContext` returns a null bead snapshot, `evaluatePreconditions` returns `BD_READ_FAILED` and the call site refuses. |
| Anchor-decision compliance — ADR-003 (single-file library) | PASS | All 7 beads import `buildDispatchContext` + `evaluatePreconditions` from `@/lib/dispatch-preconditions`. No new sub-modules. |
| Anchor-decision compliance — ADR-004 (PRECONDITION_TABLE keyed by action name) | PASS for the architecture; PARTIAL for the FIX | All 7 beads pass `action: <action-name>` to `buildDispatchContext`. The PRECONDITION_ACTION vs DISPATCH_ACTION split (stuck-in-stage's `precondAction = context.resumeAction`, missed-wave-review-dispatch's `PRECONDITION_ACTION = 'review-wave'` vs `DISPATCH_ACTION = 'run-coherence-agent'`) is correctly applied — gate uses the LOGICAL action the rule is recovering, not the action it actually dispatches. **Post-fix concern**: 1cb58a5 silently changed which actions the wave-beads predicates apply to — see Bug `beads_web-m2c`. |
| Anchor-decision compliance — ADR-005 (Classes A, A.5, B, C, D, E all in v1) | PASS | All 6 classes are exercised across the Wave-4 integration tests: stuck-in-stage's NO_WAVE_BEADS + PLAN_PENDING (Class A); wave-bead-mismatch's NO_WAVE_BEADS (Class A); missed-wave-review-dispatch's PLAN_FILE_MISSING + ALL_WAVE_BEADS_CLOSED (Class A); repeat-dispatch-escalation's BD_STATUS_DEFERRED (Class A.5); repeated-qa-round's QA_ROUND_OUT_OF_ORDER (Class B); ehp.10's BD_STATUS_DEFERRED + happy path (Class A.5); route.ts representative cases for Classes A/A.5/B/C/D/E. |
| Anchor-decision compliance — ADR-006 (new event-log variant for refusals) | PASS | All 7 beads emit `RECONCILER_ACTION_REFUSED` events on rule-side AND route-side refusal. The route 412 case emits with `payload.refusalCode='ROUTE_REFUSED_412'` and `failedCheck='route-side-precondition'`. The known FOLLOW-ON (refusals consume the existing `reconciler-action-taken` idempotency bucket because reconciler.ts:381 appends unconditionally) is documented in 5 markers + ARCHITECTURE.md. Tracked as a separate reconciler-core bead. |
| Regression-pattern #1 Write/Read Disconnect | N/A | No new persistence in scope. |
| Regression-pattern #3 State Reset Missing | N/A | No multi-step flows; predicates are pure functions. |
| Regression-pattern #4 Validation Scattered | PASS | Library remains the single source per ADR-003. The Wave-4 retrofit DOES NOT introduce ad-hoc validation in any of the 7 call sites — all delegate to `evaluatePreconditions`. |
| Regression-pattern #7 Type Confusion | PASS | RefusalCode union closed. PreconditionResult discriminated. The PRECONDITION_ACTION vs DISPATCH_ACTION split is the only branching pattern in the rules; both constants are pinned at the top of each rule file. |
| Regression-pattern #13 Silent Exception Swallowing | PASS | All catch blocks log structured warn before returning safe default. |
| Internal guardrail #1 (no-hardcoded-paths) | FAIL — see above + `beads_web-poh.3` | route.ts:496 hardcoded `beads_web` path. Tracked under poh.3. |
| Internal guardrail #2 (no silent data drift) | PASS | All readers consume the authoritative bd / marker / event-log stores. |
| Internal guardrail #3 (grep entire tree) | PARTIAL — see Bug `beads_web-m2c` | The 1cb58a5 fix did NOT grep the test tree for `ACTIONS_REQUIRING_WAVE_BEADS` consumers — if it had, the 4 broken tests would have surfaced before commit. Internal guardrail #3 violation. |
| Internal guardrail #4 (no parameter shadowing on rename) | PASS | No bulk renames in scope. |
| Internal guardrail #5 (test the data, not just the code) | PASS for Wave-4 builder code; FAIL for fix `1cb58a5` | Each Wave-4 bead's integration test exercises the actual data flow (mock readers seed → rule.act() / dispatchChainAction / route handler invoked → 0 fetch calls + correct refusal-event payload + correct ruleName/action). The 1cb58a5 fix added zero new tests for the new behaviour. |

---

## Architecture Review

### Per-rule placement check (each verified against architecture § Seam 5 / Component Boundaries Contract 2 + 3)

| Rule | Precondition gate position | Refusal path | 412 handling | Matches architecture? |
|------|----------------------------|--------------|--------------|----------------------|
| stuck-in-stage (ehp.5) | AFTER snapshot re-read at line 363, BEFORE fetch at line 511 | warn-line + RECONCILER_ACTION_REFUSED event + early return | 412 branch at line 549 BEFORE the existing `if (!res.ok) throw` (line 571) | ✓ |
| wave-bead-mismatch (ehp.6) | AFTER snapshot re-read at line 225, BEFORE both label-rollback (commented out post-wlsr.16) AND fetch at line 351; runs PRECOND_WAVE_BEADS_EXIST FIRST then evaluatePreconditions for the rest | warn-line + event + early return; rule does NOT mutate labels (rollback commented out post-wlsr.16) | 412 branch at line 379 BEFORE `if (!res.ok) throw` (line 399) | ✓ — critical: gate runs BEFORE rollback per ehp.6 risk flag, even though rollback is currently commented out, so re-uncommenting it later cannot regress the no-side-effect contract. |
| missed-wave-review-dispatch (ehp.7) | AFTER snapshot re-read at line 337 + EscalationContext build at line 391, BEFORE fetch at line 512; uses PRECONDITION_ACTION='review-wave' (the logical recovery action) NOT DISPATCH_ACTION='run-coherence-agent' (per the precondAction pattern) | warn-line + event + early return | 412 branch at line 546 BEFORE `if (!res.ok) throw` (line 568) | ✓ — second-builder dispatch (e11bc89) runs cleanly; first dispatch (Goodbye-without-marker) tracked under poh.1, not Wave-4 code defect. |
| repeat-dispatch-escalation (ehp.8) | AFTER snapshot re-read at line 278, BEFORE fetch at line 343 | warn-line + event + early return | 412 branch at line 380 BEFORE `if (!res.ok) throw` (line 402) | ✓ |
| repeated-qa-round (ehp.9) | BEFORE addLabelsToEpic at line 347. The rule does NOT make an HTTP fetch — it adds review:needs-human label. Per the bead's deviations_from_ac, AC #3 about "route returns 412" is N/A by code structure. | warn-line + event + early return; preserves legacy unconditional label-add when opts.repoPath is absent (backwards-compat) | N/A (no fetch in rule) | ✓ — deviation properly surfaced in marker. |
| dispatchChainAction inline (ehp.10) | AFTER `routingDecision.override && routingDecision.nextAgent` branch entry at line 2039, AFTER the structured marker_overrode_default_chain JSON event (lines 2049-2057), BEFORE fetch at line 2103. Uses ruleName='dispatchChainAction:inline-marker-routing' on refusal events (distinct from the reconciler rule's 'marker-driven-routing'). | warn-line + event + return false (preserves existing fall-through semantics — override branch returns false when dispatch did NOT fire) | 412 branch at line 2126 BEFORE the existing `if (!res.ok)` console.error path (line 2146) | ✓ |
| route.ts 38 case branches (ehp.11) | TOP of each case body BEFORE any label mutation or agent launch (verified via `grep -n "checkPreconditionsOrRefuse" src/app/api/fleet/action/route.ts` returning 34 case-body call sites + 1 helper definition + 1 doc-comment) | HTTP 412 with structured `PreconditionRefusalResponse` body via `NextResponse.json({...refusal, action, epicId}, { status: 412 })` | N/A (this IS the route side) | ✓ — 34 DISPATCHING wraps + 3 EXEMPT cases (stop-agent / human-approve / human-dismiss) each carry an `// EXEMPT per beads_web-ehp.11` comment per the bead's exempt-classification requirement. |

### Cross-cutting consistency

- **ruleName values** are distinct across the 5 rules + the inline branch + the route, so operators can grep refusal events by dispatch site:
  - `marker-driven-routing` (ehp.4 — Wave 3)
  - `stuck-in-stage` (ehp.5)
  - `wave-bead-mismatch` (ehp.6)
  - `missed-wave-review-dispatch` (ehp.7)
  - `repeat-dispatch-escalation` (ehp.8)
  - `repeated-qa-round` (ehp.9)
  - `dispatchChainAction:inline-marker-routing` (ehp.10)
  - (route.ts ehp.11 emits `refused: true` directly — no ruleName field; the route is the source-of-truth refusal site, not a rule)
- **`refusalCode='ROUTE_REFUSED_412'`** is the consistent synthetic code used by all 5 rules + the inline branch when the route refuses with HTTP 412. Wave-3 review's Observation 5 (this code is outside the 15-code RefusalCode union) is preserved as a follow-on observability hardening; not blocking.
- **`failedCheck='route-side-precondition'`** is the consistent failedCheck value for the same case.
- **`opts.repoPath` is OPTIONAL** for stuck-in-stage / missed-wave-review-dispatch / repeat-dispatch-escalation / repeated-qa-round (backwards-compat with legacy tests pre-dating the gate, falls open with warn-line when absent), and **REQUIRED** for wave-bead-mismatch (ehp.6's stricter pattern). reconciler-bootstrap.ts unconditionally passes the production repoPath to all 5 rules, so the production path is fully gated regardless. Verified at `src/lib/reconciler-bootstrap.ts:267,292,326,396,537`.

### Test pyramid posture (Wave 4 additions)

- **Unit (table-driven, fast)**: dispatch-preconditions.test.ts unchanged in count (still 112) — Wave 4 didn't add unit tests; they're upstream in ehp.13.
- **Integration (real fs + real event-log + mocked readers at module boundary)**: 6 new precondition-integration test files for the 5 rules + agent-launcher inline branch (3,162 lines added). Plus 1 new route-level test file (`__tests__/api/fleet-action-preconditions.test.ts`, 463 lines, 9 tests covering 5 representative refusal cases + happy-path proceed + 3 EXEMPT-cases-do-not-call-gate sanity tests).
- **E2E**: ehp.12 (Wave 5) is the niii reproduction test for all 6 phantom-dispatch scenarios — not in scope this round.
- **Healthy pyramid**: 112 unit / ~50+ integration / 0 E2E (yet). No ice-cream-cone anti-pattern. **HOWEVER**: the suite is currently RED (4 failing tests at HEAD due to 1cb58a5).

---

## Bugs Filed

| ID | Priority | Description | File:Line |
|----|----------|-------------|-----------|
| beads_web-m2c | P0 | Test suite RED after fix 1cb58a5 — 4 tests failing including LOAD-BEARING niii reviewer-4-wave-4-redundant. Critical Guardrail #4 + Internal guardrail #3 + Bug Fix Sequence § 3 violations. | src/lib/dispatch-preconditions.ts:520; __tests__/lib/dispatch-preconditions.test.ts:885,1313,1513; __tests__/lib/reconciler-rules/missed-wave-review-dispatch.precondition-integration.test.ts:342 |
| beads_web-o2s | P2 | ehp.10 marker incorrectly claims `deviations_from_ac: None` — Files manifest specified NEW file (not created) AND Out scope explicitly forbade modifying existing agent-launcher test files (modified `agent-launcher-marker-routing.test.ts` to add top-level bead-status mock). Code is correct; only the marker field is misclassified. | .beads/markers/beads_web-ehp.10.json line 31 |

**Already-tracked items NOT re-filed (visible to operator via `bd list --status=open --type=bug`):**
- `beads_web-poh.1` — framework-exits-without-commit (manifested in ehp.5/.6/.9 builder commits being operator-finalised)
- `beads_web-poh.3` — dispatch-preconditions hardcoded path + findRepoForIssue timeout (manifested in route.ts:496 literal)

---

## Summary

The 7 Wave-4 beads ship the precondition library's defense-in-depth across all dispatch sites (5 reconciler rules + agent-launcher inline branch + route.ts 38-action retrofit), with consistent placement, refusal events, 412 handling, and per-rule integration tests covering the LOAD-BEARING refusal scenarios. The architecture's "Seam 5 defense-in-depth" pattern is operationally complete at end of Wave 4.

**However**, a post-Wave-4 fix commit (`1cb58a5`) shipped without test updates and at HEAD the test suite is RED — including the LOAD-BEARING ehp.7 niii reviewer-4-wave-4-redundant test. This is a Critical Guardrail #4 violation. The Wave 4 verdict is **FAIL** until `beads_web-m2c` (P0) is resolved by either (a) restoring the failing-test green state via the new "wave-N beads of ANY status" predicate (already tracked under `beads_web-poh.3`) PLUS regression-test coverage, OR (b) updating the test assertions to match the new behaviour AND adding a positive regression test for review-wave dispatch when all wave-N beads are closed.

The marker discipline issue with ehp.10 (`beads_web-o2s`, P2) is non-blocking but should be amended for downstream operator clarity.

---

## Marker

This review's marker is at `/Users/janemckay/dev/claude_projects/beads_web/.beads/markers/beads_web-ehp-reviewer-4-wave-4.json` per marker-protocol § 1 (epic-scope marker for Stage 4 Code Review filed against the wave; per-bead markers for ehp.5/.6/.7/.8/.9/.10/.11 already exist from the builders' exits).
