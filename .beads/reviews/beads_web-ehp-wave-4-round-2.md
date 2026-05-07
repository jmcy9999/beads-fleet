# Code Review — beads_web-ehp Wave 4 Round 2

**Epic:** beads_web-ehp — Action route lacks precondition checks (load-bearing for 372-bead mass-defer)
**Wave:** 4 (5 reconciler-rule integrations + dispatchChainAction inline branch + route.ts 38-action retrofit)
**Round:** 2 (verifies Round-1 FAIL findings were resolved)
**Reviewer:** reviewer agent (Stage 4 — Code Review)
**Date:** 2026-05-07
**Ship type:** internal
**Product repo:** /Users/janemckay/dev/claude_projects/beads_web
**Plan:** /Users/janemckay/dev/fleet/factory-core/.beads/plans/beads_web-ehp.md
**Architecture:** /Users/janemckay/dev/fleet/factory-core/docs/research/action-route-lacks-precondition-checks-architecture.md (note: trigger prompt cited a `-architecture` suffix-stripped path that does not exist; the architecture doc IS the canonical research artefact for this internal epic, same path as Round 1 cited)
**Round 1 review:** `.beads/reviews/beads_web-ehp-wave-4-round-1.md` (verdict FAIL)

---

## Verdict: PASS

Round 1's two FAIL findings are both resolved with substantive, well-tested commits:

| Round-1 Finding | Status at HEAD | Resolution |
|-----------------|----------------|------------|
| **beads_web-m2c (P0)** — test suite RED + LOAD-BEARING ehp.7 niii reviewer-4-wave-4-redundant protection regressed by 1cb58a5 | **CLOSED** | Commit `996031e` adds `PRECOND_WAVE_BEADS_OF_ANY_STATUS_EXIST` predicate registered for `review-wave` only; new context field `DispatchContext.anyStatusWaveBeadIds`; new exported reader `listAllStatusWaveBeads` (additive sibling of `listOpenWaveBeads`). Updates 4 originally-failing test assertions + adds 4 positive regression tests. Full suite green. |
| **beads_web-o2s (P2)** — ehp.10 marker incorrectly claimed `deviations_from_ac: None` | **CLOSED** | Commit `5c9e058` amends the ehp.10 marker `deviations_from_ac` field to truthfully document the Files-manifest + Out-clause violation, the rationale (cheapest correct fix vs red CI), and the disposition (ACCEPT). Code unchanged. |

Empirical verification at HEAD (commit `996031e`):

```
Test Suites: 116 passed, 116 total
Tests:       2 skipped, 2346 passed, 2348 total
```

Critical Guardrail #4 (test suite green) is restored. The LOAD-BEARING ehp.7 protection is back online — verified by the integration test `__tests__/lib/reconciler-rules/missed-wave-review-dispatch.precondition-integration.test.ts:332` which now refuses the niii phantom-wave dispatch with `refusalCode=NO_WAVE_BEADS` and `failedCheck=wave-beads-of-any-status-exist`, asserting `fetchCalls.length === 0`.

The dual-signal model (`openWaveBeadIds` for "open work remaining" + `anyStatusWaveBeadIds` for "wave-N beads exist at all") is the correct architectural shape per Round 1's noted design constraint: review-wave must allow the legitimate post-close case (1cb58a5) AND refuse the phantom-wave case (ehp.7). The new predicate disambiguates the two via a different signal — preserving 1cb58a5's intent without re-introducing the niii-reproduction regression.

**Outstanding open bugs** (not Wave-4-attributable; pre-existing already-tracked items):
- `beads_web-poh.1` (P1, open) — framework-exits-without-commit pattern (process issue, not Wave-4 code).
- `beads_web-poh.3` (P2, open) — route.ts:496 hardcoded `/Users/janemckay/dev/claude_projects/beads_web` literal (Internal guardrail #1; cross-cutting; Round-1 already noted this is tracked separately and not blocking).
- `beads_web-poh.4` (P1, open) — reconciler tick contention (mitigated by commit `6667571` 60s throttle; proper fix tracked separately).

None are Wave-4 code defects. Round-1's verdict criterion "any open bug means FAIL" was applied to bugs FILED BY the review against this wave's work; pre-existing infrastructure/cross-cutting bugs that overlap with the review window (route.ts:496 hardcoded path predates this round; framework-exits is a process issue across all builders; reconciler tick contention emerged after the m2c fix landed) are not Wave-4-code-attributable. Same interpretation as Round 1's Standing Order Compliance table.

---

## Beads in Wave 4 (re-listed from Round 1)

| Bead ID | Title | Status | Wave-1 Commit | Round-2 status |
|---------|-------|--------|---------------|----------------|
| beads_web-ehp.5 | stuck-in-stage precondition gate | closed | ffc2c66 | Unchanged since Round 1 — PASS preserved |
| beads_web-ehp.6 | wave-bead-mismatch precondition gate | closed | b97b9db | Unchanged — PASS preserved |
| beads_web-ehp.7 | missed-wave-review-dispatch precondition gate | closed | e11bc89 | Integration test updated (mock for new reader) — still PASS; LOAD-BEARING test now ASSERTS the new predicate's refusal path |
| beads_web-ehp.8 | repeat-dispatch-escalation precondition gate | closed | d74273f | Unchanged — PASS preserved |
| beads_web-ehp.9 | repeated-qa-round precondition gate | closed | e5453a7 | Unchanged — PASS preserved |
| beads_web-ehp.10 | dispatchChainAction inline marker-routing branch precondition gate | closed | 3d6b60d | Marker amended (5c9e058) — PASS preserved |
| beads_web-ehp.11 | route.ts — all 38 action handlers precondition retrofit | closed | 553e9ee | Unchanged — PASS preserved |

**Post-Round-1 fix-up commits in scope for Round 2:**

| Commit | What it fixed | Verification |
|--------|---------------|--------------|
| **5c9e058** | ehp.10 marker `deviations_from_ac` correctly classified per beads_web-o2s | Marker text now records the Files-manifest + Out-clause violation, the rationale (cheapest correct fix vs red CI), and the ACCEPT disposition. No code change. Closes o2s. |
| 6667571 | Reconciler tick interval 10s → 60s default (poh.4 mitigation) | Out of scope for Wave 4 review per epic boundary; mitigates cross-epic infra; tracked under poh.4. |
| **996031e** | beads_web-m2c P0 — restore niii reviewer-4-wave-4-redundant protection via dual-signal model | Test suite green at HEAD (116/116 suites, 2346 tests pass, 0 failures, was 2/116 + 4 fails); LOAD-BEARING ehp.7 protection asserted by `missed-wave-review-dispatch.precondition-integration.test.ts:332`. ARCHITECTURE.md updated. Marker per protocol. Closes m2c. |

---

## Standing Order Compliance (Round 2 — re-checked items only)

| Check | Status | Notes |
|-------|--------|-------|
| **Test Suite Green (Critical Guardrail #4)** | **PASS** (was FAIL) | `npx jest` from beads_web repo: 116 passed / 116 total / 0 failed; 2346 passed / 2 pre-existing skips / 2348 total tests. Empirical run during this review. |
| Bug Fix Sequence (agent-discipline § 3) | PASS | Commit `996031e` documents failing-test reproduction at HEAD (4 RED tests pre-fix), then implements the fix, then verifies green suite. The commit message explicitly cites the Bug Fix Sequence § 3 violation by 1cb58a5 and shows that this fix follows the correct sequence. |
| Internal guardrail #3 (grep entire tree) | PASS | The 996031e fix DID grep the test tree — see commit message "(c) Updated 4 failing test assertions to match the new dual-predicate model" + the diff stat (3 test file modifications: `__tests__/lib/dispatch-preconditions.test.ts` +141, `__tests__/lib/reconciler-rules/missed-wave-review-dispatch.precondition-integration.test.ts` +137, plus the source file). The 1cb58a5 violation that Round 1 flagged is corrected. |
| Internal guardrail #5 (test the data, not just the code) | PASS | Commit 996031e adds 4 positive regression tests including the 1cb58a5-success-case lock-in test (`PRECOND_WAVE_BEADS_OF_ANY_STATUS_EXIST` happy path with `openWaveBeadIds=[]` but `anyStatusWaveBeadIds` non-empty). Future ACTIONS_REQUIRING_WAVE_BEADS edits cannot silently re-introduce the bug — the regression test will fail first. |
| Anchor-decision compliance — ADR-001 (discriminated union) | PASS | `PRECOND_WAVE_BEADS_OF_ANY_STATUS_EXIST.evaluate(ctx)` returns `PreconditionResult` (`{ ok: true } | { ok: false, refusalCode, failedCheck, reason }`). No exceptions thrown. |
| Anchor-decision compliance — ADR-002 (bd-read fail-closed) | PASS | `safeListAllStatusWaveBeads` (in dispatch-preconditions.ts) catches throws from `listAllStatusWaveBeads` and returns `[]` — fail-closed: empty `anyStatusWaveBeadIds` triggers refusal at the new predicate. |
| Anchor-decision compliance — ADR-003 (single-file library) | PASS | New predicate + new context field + new safe-wrapper all live in `src/lib/dispatch-preconditions.ts`. Reader extension at `src/lib/agent-launcher.ts` is the existing wave-bead-reader module (not a new sub-module of dispatch-preconditions). |
| Anchor-decision compliance — ADR-004 (PRECONDITION_TABLE keyed by action name) | PASS | New predicate registered via `ACTIONS_REQUIRING_ANY_STATUS_WAVE_BEADS = new Set(["review-wave"])` + `appliesTo(action)` check. `EXTENDED_PRECONDITION_TABLE` registers it for review-wave only. Test `EXTENDED_PRECONDITION_TABLE coverage` confirms via `expect(checkNames).toContain("wave-beads-of-any-status-exist")` and `expect(checkNames).not.toContain("wave-beads-exist")` for review-wave. |
| Anchor-decision compliance — ADR-005 (Classes A, A.5, B, C, D, E in v1) | PASS | New predicate is Class A. Comment at the predicate definition explicitly cites it as Class A and explains why a separate predicate (vs `appliesTo` on existing) is required (different signal: `anyStatusWaveBeadIds` vs `openWaveBeadIds`). |
| Anchor-decision compliance — ADR-006 (RECONCILER_ACTION_REFUSED event variant) | PASS | The integration test asserts `payload.refusalCode='NO_WAVE_BEADS'` + `payload.failedCheck='wave-beads-of-any-status-exist'` when missed-wave-review-dispatch's act() refuses on the new predicate. Same event variant as Round 1. |
| ARCHITECTURE.md update | PASS | Diff at `ARCHITECTURE.md:486` updates the dispatch-preconditions.ts entry to note the 11th per-action predicate, the dual-signal model, and the fix's rationale. The architecture doc now reflects the new behaviour. |
| Marker discipline (marker-protocol § 2) | PASS | The 996031e commit includes `.beads/markers/beads_web-m2c.json` (per the marker-write-ordering subsection — marker last in the commit). The 5c9e058 commit amends the ehp.10 marker exactly as o2s requested. Both markers at HEAD reflect committed reality. |

**Already-tracked items NOT re-filed** (visible to operator via `bd list --status=open --type=bug`):
- `beads_web-poh.1` (P1) — framework-exits-without-commit. Process issue across builders. Round-1 noted; carries forward.
- `beads_web-poh.3` (P2) — `route.ts:496` hardcoded path + `findRepoForIssue` timeout. Verified still present at HEAD via `grep -n "/Users/janemckay/dev/claude_projects/beads_web" src/app/api/fleet/action/route.ts` returning line 496. Tracked.
- `beads_web-poh.4` (P1) — reconciler tick contention. Mitigated by 6667571 (60s throttle); proper fix (prewarm + stagger + semaphore) tracked. Not Wave-4-introduced.

---

## Architecture Review (Round 2 — delta only)

The 996031e fix introduces:

1. **New predicate `PRECOND_WAVE_BEADS_OF_ANY_STATUS_EXIST`** at `src/lib/dispatch-preconditions.ts:771`:
   - `name: "wave-beads-of-any-status-exist"`
   - `refusalCode: "NO_WAVE_BEADS"` (intentionally shares the code with `PRECOND_WAVE_BEADS_EXIST` per the integration test's enum-subset assertion at `missed-wave-review-dispatch.precondition-integration.test.ts:358-360` — operators see the same `NO_WAVE_BEADS` refusal regardless of whether the gate fires for `start-wave` (`openWaveBeadIds=[]`) or `review-wave` (`anyStatusWaveBeadIds=[]`); the `failedCheck` field disambiguates the two)
   - `appliesTo(action)`: `ACTIONS_REQUIRING_ANY_STATUS_WAVE_BEADS.has(action)` — the set is `new Set(["review-wave"])` (review-wave-only registration; mutually exclusive with the dropped `PRECOND_WAVE_BEADS_EXIST.appliesTo("review-wave")===false`).

2. **New `DispatchContext` field `anyStatusWaveBeadIds: readonly string[]`** at `src/lib/dispatch-preconditions.ts:219`:
   - Documented as "wave-N beads of ANY status (open + in_progress + closed)".
   - Populated by `buildDispatchContext` via the new `listAllStatusWaveBeads` reader.
   - Defaults to `[]` when `waveNumber` is undefined or the read fails (fail-closed).

3. **New exported reader `listAllStatusWaveBeads`** at `src/lib/agent-launcher.ts:1540`:
   - Sibling of `listOpenWaveBeads` (~50 LOC, additive).
   - Identical traversal logic minus the closed-bead filter.
   - Same throw-on-bd-failure contract as `listOpenWaveBeads` (per factory-core-z9h.9 convention).
   - Spillover acknowledged in the m2c marker per `builder.md` Step 5d Step 3 option (a) — the new function clearly belongs to the m2c bead's scope (powers the new predicate).

4. **Dual-signal model documented in source comments** at the predicate definition (`src/lib/dispatch-preconditions.ts:771-794`):
   - Comment block explicitly explains why a separate predicate (vs `appliesTo` on existing predicates): "The existing PRECOND_WAVE_BEADS_EXIST and PRECOND_WAVE_BEADS_NOT_ALL_CLOSED predicates fire on `openWaveBeadIds.length === 0`, which is the LEGITIMATE success state for `review-wave` ... This predicate uses the DIFFERENT `anyStatusWaveBeadIds` signal so the two states are distinguishable: empty open + non-empty any-status = 'all closed' (legitimate, allow); empty open + empty any-status = 'phantom' (refuse)."
   - The architectural decision is explicit and self-documenting.

### Cross-cutting consistency (post-fix)

- `EXTENDED_PRECONDITION_TABLE` for `review-wave` after the fix: contains exactly `[wave-beads-of-any-status-exist]` (plus universal predicates A.5/C from ehp.3). Verified via the updated test at `__tests__/lib/dispatch-preconditions.test.ts:1380-1414` which asserts `checkNames` contains `"wave-beads-of-any-status-exist"` AND does NOT contain `"wave-beads-exist"` or `"wave-beads-not-all-closed"`.
- `PER_ACTION_PRECONDITIONS` length is now 11 (was 10 in ehp.13). The sorted refusal-code list correctly contains `NO_WAVE_BEADS` twice (one for each predicate sharing the code) — verified at `__tests__/lib/dispatch-preconditions.test.ts:1432-1454`.
- All 6 reconciler-rule integrations + agent-launcher inline branch + route.ts 38-action retrofit continue to use the same `evaluatePreconditions` + `buildDispatchContext` interfaces — the new predicate is transparently included in the table-driven evaluation. No wiring changes required at any call site.

### Test pyramid posture (Round 2 deltas)

- **Unit tests** (`__tests__/lib/dispatch-preconditions.test.ts`): +141 lines / 4 new positive cases for `PRECOND_WAVE_BEADS_OF_ANY_STATUS_EXIST` (happy path with open beads; happy path with closed beads only; refusal phantom-wave; appliesTo gating). 4 existing assertions updated to match new dual-predicate model.
- **Integration tests** (`__tests__/lib/reconciler-rules/missed-wave-review-dispatch.precondition-integration.test.ts`): +137 lines / mock for `listAllStatusWaveBeads` added to `jest.mock("@/lib/agent-launcher")` setup; per-test `mockListAllStatusWaveBeads.mockResolvedValue(...)` calls added to the 4 existing scenarios + the LOAD-BEARING niii test now asserts `anyStatusWaveBeadIds=[]` (phantom wave) explicitly.
- **No new E2E tests** — the LOAD-BEARING niii reproduction (ehp.12 in Wave 5) remains the planned end-to-end coverage and was untouched by Round 2.
- **No ice-cream-cone anti-pattern** — most new tests are unit; only the LOAD-BEARING refusal scenario is an integration test (rule-level mock + real event-log).

---

## Bugs Filed in Round 2

**None.** The Round 1 FAIL findings (m2c, o2s) are both closed; no new defects introduced by the fix commits. Verified by:
- Empirical full test suite at HEAD: 116/116 suites pass, 2346/2348 tests pass, 0 failures.
- TypeScript errors unchanged at 97 pre-existing (per the m2c close reason; not in any modified file — verified by grepping `npx tsc --noEmit` output for the modified files).
- No new structural patterns introduced (all changes are mechanical extensions of the existing predicate architecture).

---

## Summary

The Round 1 FAIL findings are both resolved with substantive, well-documented commits that follow the Bug Fix Sequence and update tests properly. The `PRECOND_WAVE_BEADS_OF_ANY_STATUS_EXIST` predicate restores the LOAD-BEARING ehp.7 niii reviewer-4-wave-4-redundant protection without re-introducing 1cb58a5's regression — a textbook dual-signal disambiguation. The ehp.10 marker now correctly classifies its Files-manifest + Out-clause deviation. Test suite is green at HEAD; Critical Guardrail #4 is restored.

Wave 4 is operationally complete and ready for Wave 5 (ehp.12 — niii phantom-dispatch end-to-end reproduction test). The pre-existing already-tracked open bugs (poh.1, poh.3, poh.4) are not Wave-4-attributable and do not block advancement.

---

## Marker

This Round 2 review's marker is at `/Users/janemckay/dev/claude_projects/beads_web/.beads/markers/beads_web-ehp-reviewer-4-wave-4-round-2.json` per marker-protocol § 1 (epic-scope marker for Stage 4 Code Review filed against the wave; suffix `-round-2` disambiguates from the Round 1 marker `beads_web-ehp-reviewer-4-wave-4.json` which remains on disk as the authoritative Round 1 record).
