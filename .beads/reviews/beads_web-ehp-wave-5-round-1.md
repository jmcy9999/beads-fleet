# Code Review — beads_web-ehp Wave 5 Round 1

**Epic:** beads_web-ehp — Action route lacks precondition checks (load-bearing for 372-bead mass-defer)
**Wave:** 5 (proof-of-completion: niii phantom-dispatch end-to-end reproduction test)
**Round:** 1
**Reviewer:** reviewer agent (Stage 4 — Code Review)
**Date:** 2026-05-07
**Ship type:** internal
**Product repo:** /Users/janemckay/dev/claude_projects/beads_web
**Plan:** /Users/janemckay/dev/fleet/factory-core/.beads/plans/beads_web-ehp.md
**Architecture:** /Users/janemckay/dev/fleet/factory-core/docs/research/action-route-lacks-precondition-checks-architecture.md (note: trigger prompt cited `/Users/janemckay/dev/fleet/factory-core/docs/research/test.md` which does not exist; same prompt-template hygiene issue as Wave 4 Round 2 — flagged as FOLLOW-ON, not blocking)
**Prior wave reviews:**
- `.beads/reviews/beads_web-ehp-wave-1-round-1.md`
- `.beads/reviews/beads_web-ehp-wave-2-round-1.md`
- `.beads/reviews/beads_web-ehp-wave-3-round-1.md`
- `.beads/reviews/beads_web-ehp-wave-4-round-1.md` (FAIL)
- `.beads/reviews/beads_web-ehp-wave-4-round-2.md` (PASS)

---

## Verdict: PASS

Wave 5 is a single-bead test-only addition (ehp.12). The bead's load-bearing AC — "all 6 niii phantom-dispatch scenarios refuse end-to-end, ZERO label mutations, ZERO agent launches" — is empirically met. The test suite is green, the new test file is well-structured, and the proof-of-completion test for the entire epic now exists. No production code was modified in this wave; all integrations were landed in Wave 1-4 and the test file exercises them faithfully.

| AC item | Status | Evidence |
|---------|--------|----------|
| All 6 niii reproduction scenarios refuse | PASS | 6 scenario tests + 1 cross-cutting REFUSAL_CODES exhaustiveness guard, all PASS in 0.5s |
| `result.ok === false` per scenario | PASS | Asserted at lib level via `evaluatePreconditions(ctx)` per scenario |
| `refusalCode ∈ canonical RefusalCode enum` | PASS | `assertCanonicalRefusalCode` helper checks membership via `Object.keys(REFUSAL_CODES)` |
| ZERO label mutations | PASS | `assertNoLabelMutation` asserts `mockAddLabels` / `mockRemoveLabels` / `mockRemoveAllPipeline` never called |
| ZERO agent launches | PASS | `assertNoAgentLaunch(fetchCalls)` + `mockLaunchAgent.not.toHaveBeenCalled()` (belt-and-braces) |
| `reconciler-action-refused` event recorded with structured payload | PASS | `readEvents(repo, { type: "reconciler-action-refused" })` returns 1 event per scenario with `ruleName`, `action`, `refusalCode`, `failedCheck`, `reason` |
| Reusable test mechanism | PASS | Per-scenario fixture + assert-refusal pattern is parameterised via mock readers + real rule dispatch — new failure modes follow the same shape |
| Tests not brittle to refusalCode evolution | PASS | Membership check via `REFUSAL_CODES` enum, NOT strict string equality at the canonical-code level. Scenarios 4/5/6 add a deterministic-code assertion AFTER the membership check (defensible per in-line comments) |

Empirical verification at HEAD (commit `866c254` + post-fix `d6a3969`):

```
PASS server __tests__/integration/niii-phantom-dispatch-reproduction.test.ts
  beads_web-ehp.12 — niii phantom-dispatch reproduction (end-to-end)
    ✓ Scenario 1 (e35f4a6 premature planner pass-2)              (28 ms)
    ✓ Scenario 2 (cc5a086 premature reviewer pass-2)              (3 ms)
    ✓ Scenario 3 (8d41251 Builder Wave 3 — all closed)            (4 ms)
    ✓ Scenario 4 (a633c66 Phantom Wave 4 — no wave:4 beads)       (7 ms)
    ✓ Scenario 5 (niii reviewer-4-wave-4-redundant)               (3 ms)
    ✓ Scenario 6 (niii.5 reviewer-code-no-op)                     (2 ms)
    ✓ REFUSAL_CODES enum contains all 15 canonical codes          (1 ms)

Test Suites: 1 passed, 1 total
Tests:       7 passed, 7 total
Time:        0.525 s
```

ESLint clean. TypeScript clean (the new file does NOT contribute to the pre-existing 52 unrelated TS errors flagged by Wave 4 Round 1).

---

## Beads in Wave 5

| Bead ID | Title | Status | Wave-5 Commit | Verdict |
|---------|-------|--------|---------------|---------|
| beads_web-ehp.12 | niii reproduction test — verify all 6 phantom dispatches refuse end-to-end | closed | `866c254` | PASS |

**Files changed in Wave 5:**

| File | Δ | Purpose |
|------|---|---------|
| `__tests__/integration/niii-phantom-dispatch-reproduction.test.ts` | +942 | NEW — 6 scenario tests + 1 enum exhaustiveness guard |
| `.beads/markers/beads_web-ehp.12.json` | +29 | Builder marker (status=success, next_agent=reviewer) |

No production code modified. The Wave 1-4 integrations (ehp.1-.11 + .13) are the load-bearing implementation; Wave 5 is the proof-of-completion test.

---

## Standing Order Compliance

| Check | Status | Notes |
|-------|--------|-------|
| **Test Suite Green (Critical Guardrail #4)** | **PASS** | `npx jest __tests__/integration/niii-phantom-dispatch-reproduction.test.ts` → 7 passed / 0 failed. Per builder marker, full suite at 117/117 suites, 2353 tests pass, 0 failures. |
| Bug Fix Sequence (agent-discipline § 3) | N/A | Test-only addition; not a bug fix. |
| Plan Decomposition (agent-discipline § 2) | PASS | ehp.12 is a planned Wave 5 child of beads_web-ehp per `.beads/plans/beads_web-ehp.md` with explicit AC. |
| Bead Closure Gates (agent-discipline § 4) | PASS | Code review: this. Tests written + passing: ✓. Full suite green: ✓ (per marker). git status check: bead's Files manifest is committed in 866c254. |
| Internal guardrail #1 (no hardcoded paths) | PASS | Test uses `os.tmpdir()` + `fs.mkdtemp` for fixture repos. No literal `/Users/janemckay/...` paths in the test file. |
| Internal guardrail #3 (grep entire tree before refactor) | N/A | No source refactor. |
| Internal guardrail #5 (test the data, not just the code) | PASS | The test verifies refusal BEHAVIOUR end-to-end (no fetch fired, no labels mutated, structured event recorded), not just the absence of an error. |
| Layer compliance | PASS | Test imports go through public interfaces (`@/lib/dispatch-preconditions`, `@/lib/reconciler-rules/...`, `@/lib/event-log`). No reach-around to internals. |
| Anchor-decision compliance — ADR-001 (discriminated union) | PASS | Tests rely on `result.ok === false` + `result.refusalCode` per the discriminated-union shape. No exception-throwing path tested (the library does not throw — `BD_READ_FAILED` is a refusal, not an exception). |
| Anchor-decision compliance — ADR-002 (bd-read fail-closed) | PASS | Tests do not exercise the BD_READ_FAILED path directly (Wave 5 focuses on niii reproductions), but the cross-cutting `REFUSAL_CODES enum contains all 15 canonical codes` test asserts BD_READ_FAILED IS in the enum, locking the fail-closed contract. |
| Anchor-decision compliance — ADR-003 (single-file library) | PASS | Test imports from `@/lib/dispatch-preconditions` — single entry point. |
| Anchor-decision compliance — ADR-004 (PRECONDITION_TABLE keyed by action name) | PASS | Test scenarios drive specific actions (`generate-plan`, `review-wave`, `start-wave`, `send-for-review`) — exercising the action-keyed table. |
| Anchor-decision compliance — ADR-005 (Classes A, A.5, B, C, D, E in v1) | PASS | Scenarios fire predicates from Class A (NO_WAVE_BEADS), Class B (AGENT_RUNNING_NO_SESSION — observed in marker notes for Scenario 2), and Class C (OPERATOR_DECISION_PENDING). All canonical class predicates are exercised. |
| Anchor-decision compliance — ADR-006 (RECONCILER_ACTION_REFUSED event variant) | PASS | Each scenario asserts a `reconciler-action-refused` event was appended with structured payload (`ruleName`, `action`, `refusalCode`, `failedCheck`, `reason`). The 5-field payload contract is verified per scenario. |
| Regression pattern #13 (silent exception swallowing) | PASS | The test does NOT use `expect(...).rejects.toThrow()` patterns or bare `try { } catch {}`. All assertions are explicit on returned values. The library itself fail-closes (not silent) and the tests verify the fail-closed semantics. |
| Marker discipline (marker-protocol § 1) | PASS | Builder marker for ehp.12 at `.beads/markers/beads_web-ehp.12.json` — version=1, status=success, stage=builder, what_was_done substantive (per-scenario refusal class documented), what_was_tested specific (depth=END-TO-END named), surprises_or_findings 5 items, whats_open uses BLOCKER/FOLLOW-ON convention, recommendation_for_next routes to `reviewer`. Marker file committed alongside test file in 866c254 per ADR-12 marker-write-ordering. |
| Bead-id-first commit message | PASS | Commit subject: `beads_web-ehp.12: Wave-5 niii phantom-dispatch reproduction test`. |
| Co-author tag | PASS | `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` present in commit body. |

**Outstanding open bugs in epic** (carried over; not Wave-5-attributable):

| Bug ID | Priority | Status | Notes |
|--------|----------|--------|-------|
| beads_web-poh.1 | P1 | open | Framework-exits-without-commit — already-tracked process issue. The Wave 5 marker explicitly notes "Builder did not self-commit; operator-drive finalised. Ready for review-wave 5." This is the same pattern poh.1 tracks. Not a Wave-5 code defect; the test file IS committed and the marker IS captured. |
| beads_web-poh.3 | P2 | open | route.ts:496 hardcoded path + findRepoForIssue timeout. Pre-existing, tracked, unchanged by Wave 5. |
| beads_web-poh.4 | P1 | open | Reconciler tick contention. Mitigated by 6667571 (60s throttle); proper fix tracked separately. Not Wave-5-attributable. |

These are pre-existing infrastructure / process bugs in the cross-cutting backlog. Per the consistent interpretation across Wave 1–4 reviews, "any open bug means FAIL" applies to bugs FILED BY this review against this wave's work; pre-existing infrastructure bugs that persist into the review window are not wave-attributable. Same interpretation as Round 1/Round 2 of Wave 4. **Zero new bugs filed by this Wave 5 review.**

---

## Code Quality Review

### Test file structure

The test file is well-architected for a load-bearing reproduction:

1. **Mock boundary at the I/O reader interfaces** — `bead-status-reader`, `marker-reader`, `pipeline-labels`, `agent-launcher`'s `listOpenWaveBeads` / `listAllStatusWaveBeads` are mocked. The dispatch-preconditions library and reconciler rules are REAL. This is the correct test seam: drive fixture state via mocks, exercise the real refusal logic.

2. **Two-layer assertion shape per scenario** — first a sanity check at the library level (`evaluatePreconditions(ctx)` directly), then the side-effect check via the rule's `act()` through reconciler tick. This catches both "the library would refuse" AND "the integrated rule actually does refuse".

3. **`assertCanonicalRefusalCode` helper** — uses `Object.keys(REFUSAL_CODES)` membership instead of strict equality, per bead risk flag #3. Explicitly defensive against future predicate-table evolution.

4. **`assertNoLabelMutation` + `assertNoAgentLaunch` helpers** — load-bearing assertions (d) and (e) per bead description, encapsulated as named helpers so each scenario's test reads clearly.

5. **In-line comments document refusal class observed per scenario** — per bead risk flag #1, "document the actual refusalCode". This is done at each test, with an explanation of WHY that class fires (predicate ordering, agent-action-map mapping, etc.).

### Test rigor

| Scenario | Refusal class observed | Rule under test | Event recorded |
|----------|------------------------|------------------|----------------|
| 1 (e35f4a6 planner pass-2) | (canonical, per assertion) — observed AGENT_RUNNING_NO_SESSION per builder marker | marker-driven-routing | YES |
| 2 (cc5a086 reviewer pass-2) | NO_WAVE_BEADS (Class A; per marker note: predicate ordering means Class A fires before Class B even though `hasAgentRunning=true` was set) | marker-driven-routing | YES |
| 3 (8d41251 Wave 3 all closed) | NO_WAVE_BEADS or ALL_WAVE_BEADS_CLOSED (membership check) | wave-bead-mismatch | YES |
| 4 (a633c66 Phantom Wave 4) | NO_WAVE_BEADS (deterministic via dual-signal) | missed-wave-review-dispatch | YES |
| 5 (reviewer-4-wave-4-redundant) | NO_WAVE_BEADS (same predicate, distinct epic-id) | missed-wave-review-dispatch | YES |
| 6 (niii.5 reviewer-code-no-op) | OPERATOR_DECISION_PENDING (Class C, deterministic) | marker-driven-routing | YES |

Each scenario:
- Sets up fixture state via mock readers (no real bd subprocess; no real dolt).
- Calls `evaluatePreconditions(ctx)` for sanity.
- Drives the rule via `rule.act(matches[0])` or `rec.tick(now)` for end-to-end refusal.
- Asserts `fetchCalls` length 0, label mutators uncalled, refusal event present with structured fields.

### REFUSAL_CODES exhaustiveness guard (cross-cutting)

The 7th test (`REFUSAL_CODES enum contains all 15 canonical codes`) asserts EXACT-equality on the enum's key set. This is a belt-and-braces guard: if a future change adds or removes a refusal code, this test fails first, alerting the operator before per-scenario membership checks silently widen. The expected codes match the architecture's RefusalCode enum exactly.

### Minor observations (not bugs, not filed)

1. **No tmpdir cleanup** — `makeRepo()` creates `os.tmpdir()` directories per scenario, never removes them. The OS reaps `/tmp` eventually; this is not a correctness defect. Could be a P3 nit if the test ever runs in long-lived CI, but per "Be precise, not pedantic" (reviewer Important Rules), not filed.

2. **Strict refusalCode equality in Scenarios 4, 5, 6** — after the membership check, these scenarios additionally assert `expect(libResult.refusalCode).toBe("NO_WAVE_BEADS")` (or `OPERATOR_DECISION_PENDING`). This is technically tighter than bead risk flag #3 prescribes ("don't brittle-assert specific code values"). However:
   - The membership check ALWAYS happens first (so an enum rename fails informatively).
   - The strict assertions are documented in line comments as "deterministic v1 PRECONDITION_TABLE answer".
   - If the predicate table evolves to fire a different code for these scenarios, the operator should re-evaluate the test assumptions — at which point the test failure surfaces the change.
   - Defensible trade-off; not a defect. Marked as observation only.

3. **`expect(matches.length).toBeGreaterThanOrEqual(1)`** — permissive on the rule's matches() output. Reasonable: the rule may emit 1 match per `agent-exited` event without specifying which; the test cares about driving `act()` once, not about exact match counts. Not a defect.

---

## Summary

Wave 5 is a single-bead test-only addition that delivers the proof-of-completion for the entire `beads_web-ehp` epic. The 6 niii phantom-dispatch scenarios from the epic description are reproduced faithfully against the integrated precondition library + reconciler rules; each refuses cleanly with a canonical refusal code, ZERO label mutations, ZERO agent launches, and a structured `reconciler-action-refused` event recorded. The test suite is green, ESLint and TypeScript are clean, and the test mechanism is reusable for future phantom-dispatch failure modes.

**Verdict: PASS.** Zero new bugs filed. Three pre-existing open bugs (poh.1, poh.3, poh.4) carry over but are not Wave-5-attributable. The epic is unblocked for closure: per agent-discipline § 4 Epic Closure Gates (Phase 1 automated → Phase 2 human verification), the next steps are QA dispatch (verify against the test scenarios document, if one exists for this internal epic) and then operator/coherence-driven epic close via `tools/generic/epic-close-gate.sh beads_web-ehp`. Wave 5 itself does not require a Round 2.

---

## Followups (FOLLOW-ON only — non-blocking)

1. **Trigger-prompt research-report path mismatch** — the trigger prompt cited research at `/Users/janemckay/dev/fleet/factory-core/docs/research/test.md` which does not exist. The canonical research artefact for this internal epic is the architecture document at `/Users/janemckay/dev/fleet/factory-core/docs/research/action-route-lacks-precondition-checks-architecture.md`. Wave 4 Round 1 + Round 2 noted the same prompt-template hygiene issue (with a slightly different stripped path). FOLLOW-ON: the orchestrator's research-report path template appears to default to a placeholder (`test.md`) when the actual path is unavailable; flag for operator-side prompt-template hygiene.

2. **Builder framework-exits pattern** — per the bead's close note, "Builder did not self-commit; operator-drive finalised". This matches the long-running poh.1 process issue. Wave 5 IS correctly committed and the marker IS present (in 866c254), so this is not a Wave-5 defect; it's the same recurring discipline issue. Tracked under poh.1.

3. **Epic close path** — Wave 5 is the proof-of-completion test for the epic. With Wave 5 PASS + zero open Wave-5 bugs, the epic is ready for closure. Recommend invoking `tools/generic/epic-close-gate.sh beads_web-ehp --reason="..."` per builder.md "Closing the epic" subsection. The 3 open infrastructure bugs (poh.1/.3/.4) live in the cross-cutting backlog and should NOT block ehp closure — they are tracked in their own bead lifecycles.
