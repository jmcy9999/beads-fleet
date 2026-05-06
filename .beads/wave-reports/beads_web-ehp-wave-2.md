# Wave 2 Report — Action route lacks precondition checks (beads_web-ehp)

**Epic:** beads_web-ehp
**Wave:** 2
**Date:** 2026-05-06
**Branch:** main
**Commits ahead of main:** 1 (this wave)

## Beads completed

| Bead | Commit | Status | Verification depth | Notes |
|------|--------|--------|---------------------|-------|
| beads_web-ehp.3 | 13c9222 | Closed | integration | Wave-2 minimal dispatch-preconditions library (4 universal predicates + skeleton + minimal table). Real bd + real dolt integration test included; load-bearing 372-bead-defer scenario reproduced end-to-end. |

## Per-bead git discipline check

Confirmed each commit's file list matches its bead's Files: manifest.

ehp.3 (commit 13c9222) staged exactly 4 paths via literal-path `git add`:

- `src/lib/dispatch-preconditions.ts` (manifest)
- `__tests__/lib/dispatch-preconditions.test.ts` (manifest)
- `__tests__/lib/dispatch-preconditions.integration.test.ts` (manifest)
- `.beads/markers/beads_web-ehp.3.json` (per marker-write-ordering directive 2026-05-01)

No globs, no `git add -A`, no spillover. `git diff --cached --name-only` matched the manifest before committing. `git show --stat HEAD` confirmed post-commit.

## Verification summary

ehp.3 is an INTEGRATION bead (Files manifest touches the bd subprocess + dolt sql-server boundary). Per builder.md Step 5c, integration beads require BOTH unit tests AND real-instance verification.

**Unit tests (48):** every AC item covered. Type-skeleton exhaustiveness (RefusalCode union has exactly 15 codes; runtime REFUSAL_CODES exhaustiveness map matches). PreconditionResult discriminated-union narrowing (TypeScript `@ts-expect-error` on the negative case). Each universal predicate verified independently — happy path, refusal case, appliesTo. PRECONDITION_TABLE coverage (every action ehp.4 may fire has all 4 universal predicates registered; UNIVERSAL_ACTION_SET cross-checked against agent-action-map.ts AGENT_TO_ACTION). Evaluation order (BD_READ_FAILED takes precedence over Class C OPERATOR_DECISION_PENDING when both apply). buildDispatchContext input validation (TypeError on empty epicId/repoPath/action/non-positive waveNumber). SCAFFOLDED-fields default contract (planFileExists=false, openWaveBeadIds=[], stageEnteredAt=null). Predicate purity (two calls return equal results).

**Integration tests (8):** real bd 0.62.0 + real dolt sql-server 1.84.0 in a fresh tmp repo. beforeAll spawns dolt on a random high port (40000-44999), inits a tmp bd repo via `bd init --server-port=<port> --skip-agents --skip-hooks --prefix=ehp3it`, creates 3 beads via `bd q`, mutates statuses via `bd update --status=deferred|closed`, writes a real marker fixture file. Each test calls REAL `buildDispatchContext` + REAL `evaluatePreconditions` against the real repo — no mocks of `readBeadStatus`/`readMarker`/`getEpicLabels`. Coverage: load-bearing 372-bead-defer scenario (deferred bead → BD_STATUS_DEFERRED), closed bead → BD_STATUS_CLOSED, open + clean → ok=true, real marker with operator/spec-ambiguity → OPERATOR_DECISION_PENDING, real epic label `human-decision:required` → REVIEW_NEEDS_HUMAN, non-existent bead-id → BD_READ_FAILED (fail-closed), SCAFFOLDED-fields default contract end-to-end, distinct-codes invariant (BD_STATUS_DEFERRED vs BD_READ_FAILED). Test setup ~3s, total time ~5.6s. Graceful `describe.skip` when dolt or bd unavailable on PATH.

**Suite-level verification:** Full beads_web jest suite — 109 suites, 2228 tests, 1 skipped — all green. Lint clean on the 3 new files (`npx next lint`). TypeScript clean on the 3 new files (pre-existing TS errors in `__tests__/api/*` unrelated, do not touch ehp.3 manifest).

**Reviewer Stage 4 verdict (P1 bead requires reviewer subagent per builder.md Step 5e):** PASS. 0 P0/P1 findings. 3 non-blocking P2 observations:

1. Stale "12 codes" prose count in bead description vs actual 15-code roster (the bead's detailed AC enumerates 15 — implementation matches the detailed enumeration per the bead's "Define types EXHAUSTIVELY" risk flag). No code impact.
2. Sentinel-typo pattern in unit test "REFUSAL_CODES exhaustiveness map has exactly the 15 architecture-specified codes" is clever but brittle. Test passes; assertion is correct. Stylistic.
3. `BD_BIN!` force-unwrap inside `describeIfEnabled` gate at integration test line 129 — safe at runtime (gate ensures BD_BIN !== null) but technically a force-unwrap. Standing orders exempt test code.

## Deviations from AC

Two prose-only deviations from the bead description, both clarified in the marker's `deviations_from_ac` field:

1. **Action-name list:** the bead description's example list (`'run-builder'`, `'run-reviewer'`, etc.) is a placeholder pattern. The AC explicitly says "Verify the action set against agent-action-map.ts's exports." Verification produced the canonical 10-action set (`run-architect`, `generate-plan`, `start-wave`, `review-wave`, `send-for-qa`, `send-for-polish`, `run-test-spec`, `run-pm`, `send-for-review`, `run-coherence-agent`). Implementation matches the verification clause, NOT the placeholder list. Documented in the library file's UNIVERSAL_ACTIONS comment block (lines 220-244) with the concrete differences listed.
2. **Code count:** the bead description's prose says "all 12 codes" but the detailed AC enumerates 15 (the 12 plus PLAN_INSTABILITY, ACTION_NEXT_AGENT_MISMATCH, BD_READ_FAILED). Implementation matches the detailed enumeration per the bead's explicit risk flag.

No material AC items skipped. Plan's Deviations section: N/A (Wave 2 is a single bead with no scope changes from the round-2 plan).

## Carryover for next wave

Wave 3 has two parallel beads (ehp.4 + ehp.13). Both depend on ehp.3 (this bead). Carryover items:

1. **ehp.4 integration template:** the integration test pattern in `__tests__/lib/dispatch-preconditions.integration.test.ts` (real dolt sql-server + real `bd init` + real bead creation) is the proven template for ehp.4's load-bearing 372-bead-defer integration test. ehp.4 should reuse the same beforeAll/afterAll structure and add an integration test that wraps `marker-driven-routing.ts`'s `act()` end-to-end against a real deferred bead.
2. **ehp.13 cross-wave additivity:** ehp.13 must be PURELY ADDITIVE to `src/lib/dispatch-preconditions.ts`. Specifically: do NOT modify the RefusalCode union, the DispatchContext interface, the universal predicates (PRECOND_BD_STATUS_NOT_DEFERRED/CLOSED/OPERATOR/REVIEW), or the `UNIVERSAL_ACTIONS` set. ehp.13 ADDS per-action predicates (Class A: 5; B: 3; D: 1; E: 1), FILLS the SCAFFOLDED context fields (planFileExists via `fs.access`, openWaveBeadIds via wave-bead query, stageEnteredAt via event-log read), and EXTENDS `PRECONDITION_TABLE` with the additional 28 actions from `route.ts` (38 actions total per architecture). No type rework. The cross-wave invariant test (in ehp.13's diff inspection) must verify ehp.3's contributions are byte-identical pre/post.
3. **Action-name verification in ehp.13:** when ehp.13 extends the PRECONDITION_TABLE to cover all 38 actions, it must verify the action set against `route.ts`'s switch cases (NOT against the bead description's example lists, which are placeholders). The pattern is the same as ehp.3 verified UNIVERSAL_ACTIONS against `agent-action-map.ts`.
4. **OPERATOR_DECISION_PENDING precedence:** ehp.13's Class E `ACTION_NEXT_AGENT_MISMATCH` predicate should be ordered AFTER OPERATOR_DECISION_PENDING in any per-action predicate list — the test scenarios doc § Wave 3 ehp.13 line 215 specifies this priority. Document the order in ehp.13's PRECONDITION_TABLE.
5. **FOLLOW-ON (non-blocking):** investigate jest "worker process has failed to exit gracefully" warning at suite end. Appears benign (all 2228 tests pass), possibly related to dolt sql-server cleanup timing in the integration test's afterAll. Not blocking ehp.3, ehp.4, or ehp.13.

## Branch state

- typecheck: pass on the 3 new ehp.3 files; pre-existing 32 errors in `__tests__/api/*` files are unrelated (issue-detail.test.ts, fleet-action-qa.test.ts, fleet-action.test.ts, issue-action.test.ts, research.test.ts — all pre-date this wave).
- lint: pass on the 3 new ehp.3 files (`✔ No ESLint warnings or errors`).
- working tree: clean (post-commit). Committed 4 files (3 manifest + 1 marker) at SHA 13c9222.
