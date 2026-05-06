# Code Review — beads_web-ehp Wave 1 Round 1

**Epic:** beads_web-ehp — Action route lacks precondition checks
**Wave:** 1 (foundations)
**Round:** 1
**Reviewer:** reviewer agent (Stage 4 — Code Review)
**Date:** 2026-05-06
**Ship type:** internal
**Product repo:** /Users/janemckay/dev/claude_projects/beads_web
**Plan:** /Users/janemckay/dev/fleet/factory-core/.beads/plans/beads_web-ehp.md
**Architecture:** /Users/janemckay/dev/fleet/factory-core/docs/research/action-route-lacks-precondition-checks-architecture.md

## Verdict: PASS

Both Wave 1 beads (`beads_web-ehp.1`, `beads_web-ehp.2`) ship clean foundation modules with thorough test coverage and zero standing-order violations. Tests pass (42/42 in scope; 2154/2155 project-wide), tsc and ESLint are clean within Wave 1 scope, and both commits land per-bead with the proper `<bead-id>:` prefix and Co-Authored-By tag. The work is purely foundational — no caller integration, no behavioural changes to existing dispatch sites — so the runtime impact on existing production paths is zero. Wave 2 (`ehp.3`) can build on this with confidence.

Zero bugs filed. Two minor non-blocking observations recorded for operator awareness (see § Observations).

---

## Beads in Wave 1

| Bead ID | Title | Status | Commit |
|---------|-------|--------|--------|
| beads_web-ehp.1 | dispatch-preconditions: bead-status-reader.ts thin wrapper around `bd show --json` | closed | fd4ce89 |
| beads_web-ehp.2 | event-log: add reconciler-action-refused event type to PipelineEvent union | closed | 0476117 |

Both beads were named as Wave 1 by the build plan (`Wave 1 = beads_web-ehp.1, beads_web-ehp.2 — Foundations — bead-status reader … and event-log addition`). The bd labels currently on each bead are `epic:beads_web-ehp` + `ship-type:internal` only — see § Observations item 2.

---

## Standing Order Compliance

| Check | Status | Notes |
|-------|--------|-------|
| Investigation-Before-Code (agent-discipline § 1) | PASS | Both markers document upfront investigation: ehp.1 verified live `bd show --json` shape and the inline precedent at reconciler-bootstrap.ts:669–687; ehp.2 grep'd src/ for switch-over-PipelineEvent sites and audited every equality consumer. |
| Plan Decomposition (agent-discipline § 2) | PASS | Plan exists at `.beads/plans/beads_web-ehp.md`; both beads have AC, Files manifest, ship-type label, and parent epic. Wave 1 has no intra-wave deps (parallel cohort A: ehp.1, ehp.2 — disjoint Files). |
| Tests Written (agent-discipline § 4 — bead closure gates) | PASS | ehp.1: 24 unit tests (3 real-fixture happy paths, 5 status-enum cases, 9 failure modes, 6 derived-field tests, 1 spawn-shape contract). ehp.2: 6 new unit tests added alongside 12 pre-existing event-log tests (constant identity, round-trip with typed shapes, JSONL on-disk shape, filter exclusivity bidirectional, compound filter). |
| Test suite green | PASS | 42/42 Wave-1 tests pass (`__tests__/lib/bead-status-reader.test.ts` + `__tests__/lib/event-log.test.ts`) in 1.277s. Project: 2154 pass / 1 skip / 2155 total / 106 suites all pass; ZERO regressions. (2 pre-existing failures in `__tests__/lib/stuck-in-stage.test.ts` are stale tests from the wlsr.14 ADR-015 cutover; ehp.2 marker confirms via stash-baseline that they pre-date this work.) |
| TypeScript clean (in scope) | PASS | `npx tsc --noEmit` shows 0 errors in `bead-status-reader` and `event-log` scope. |
| ESLint clean (in scope) | PASS | 0 errors / 0 warnings on `src/lib/bead-status-reader.ts`, `src/lib/event-log.ts`, and the corresponding test files. |
| Bead-id-first commit policy (agent-discipline § 7) | PASS | fd4ce89 starts with `beads_web-ehp.1:`; 0476117 starts with `beads_web-ehp.2:`. Both include the Co-Authored-By tag. |
| Marker write LAST + part of commit (marker-protocol § 1) | PASS | Both markers are inside their respective per-bead commits (verified via `git show --stat`). Status=success on both, 0 BLOCKERs. |
| Marker quality discipline (marker-protocol § 2) | PASS | Both markers carry evidence-primary content: per-AC entries with action/result/evidence, switch-grep audits, equality-consumer audits, file-modification lists, test summaries, and labelled BLOCKER/FOLLOW-ON `whats_open` items. No padding. |
| Layer compliance (architecture doc § Layer Mapping) | PASS | `bead-status-reader.ts` is correctly Infrastructure (sole adapter to `bd` CLI; no business logic). `event-log.ts` additions are pure schema extension at the existing layer; no new responsibilities introduced to existing consumers. |
| No force-unwrap / null-safety (code-principles) | PASS | bead-status-reader returns `null` on every failure mode (binary missing, non-zero exit, timeout, malformed JSON, empty stdout, empty array, missing id, missing status, unknown status enum, non-object payload). `Number.isFinite` guards on label-derived integers. No `as` casts beyond narrow `as Record<string, unknown>` after isObject check. |
| No hardcoded credentials | PASS | Neither file references secrets; bd binary path is resolved via existing `bd-path.ts` helper which reads `BD_PATH` env var with Homebrew fallback. |
| External-call error handling | PASS | execSync wrapped in try/catch returning null; appendEvent's existing failure contract (swallow + console.error) preserved unchanged. |
| Naming conventions | PASS | `BeadSnapshot`, `BeadStatus`, `RECONCILER_ACTION_REFUSED`, `ReconcilerActionRefusedPayload`, `ReconcilerActionRefusedEvent` — clear, follow project conventions. |
| Anchor-decision compliance (architecture ADR-002 fail-closed; ADR-006 new event variant) | PASS | bead-status-reader returns `null` on bd-unreachable per ADR-002 ("load-bearing for 372-bead mass-defer protection") — verified by 9 failure-mode tests. event-log adds a NEW event variant rather than flagging the existing one per ADR-006 — verified by switch-grep audit and bidirectional filter tests. |

---

## Architecture Review

**`src/lib/bead-status-reader.ts` (185 lines):**
- Layer: Infrastructure (correct per architecture § Layer Mapping; the architecture explicitly lists "`readBeadStatus(epicId, repoPath)` (NEW thin wrapper around `bd show --json` — returns `BeadSnapshot | null`)" as Infrastructure).
- Spawn shape mirrors the inline precedent at `src/lib/reconciler-bootstrap.ts:673` (`${bd} show ${beadId} --json`, cwd=repoPath, encoding=utf-8, env from `getBdEnv()`, `stdio: ['ignore', 'pipe', 'ignore']`). Builder went with `timeout: 15_000` instead of the precedent's 10s with documented rationale ("wider window absorbs cold-start daemon RPC latency on first read"). Surfaced under § Observations.
- Wire-shape verification: ehp.1 builder recorded 3 REAL `bd show --json` fixtures (open task, closed task, deferred bug) from the live factory-core Dolt server and exercises the parse path against actual bd output (Risk Flag 2 cleared per marker).
- Schema-tolerant: missing `labels` field maps to `[]` (not null); `issue_type` primary, `type` fallback for forward-compat; unknown status enum → null; `Number.isFinite` guards on `qa:round-N` and `wave:N` parses.
- Derived-field semantics:
  - `pipelineStage` = suffix of first `pipeline:*` label.
  - `currentQaRound` = MAX N over `qa:round-N` labels (highest round = current).
  - `currentWave` = LOWEST N over `wave:N` labels (foundation wave = current open wave).
  - `hasAgentRunning` / `hasReviewNeedsHuman` = label presence flags.
  - All 5 derived fields tested individually + together with a rich-label set.
- No caching — fresh bd read each call (architecture § Persistence Strategy).

**`src/lib/event-log.ts` (+74 lines, no removals):**
- Pure additive: 1 const (`RECONCILER_ACTION_REFUSED`), 1 type alias (`ReconcilerActionRefusedPayload`), 1 interface (`ReconcilerActionRefusedEvent extends PipelineEvent`).
- Field mapping documented inline: architecture's `at` → existing `timestamp` (no double-write); `epicId` / `correlationId` inherited from PipelineEvent; `ruleName` / `action` / `refusalCode` / `failedCheck` / `reason` live in `payload`.
- Type-alias-not-interface design rationale documented (TS interfaces are declaration-mergeable and don't satisfy closed `Record<string, unknown>` index signature on `PipelineEvent.payload`; type alias is closed and assigns cleanly). Documented inline at lines 104–109 to prevent accidental revert.
- `refusalCode` typed as `string` (not the canonical `RefusalCode` enum from ehp.3) — deliberately to avoid forward-coupling to a Wave 2 module that doesn't exist yet. JSONL round-trip is lossless because both ends speak strings.
- Schema parity with `reconciler-action-taken` (top-level `epicId`/`correlationId`, payload-nested rule-specific fields) preserves downstream-consumer pattern symmetry.
- Switch-grep audit recorded in marker: 0 exhaustive switches over PipelineEvent variants in src/. Equality consumers (6 sites) audited individually:
  - `reconciler.ts:309` `e.type !== 'reconciler-action-taken'` — unchanged
  - `stuck-in-stage.ts:123` `e.type !== 'reconciler-action-taken'` — unchanged (refusals will count as activity once Wave 3 emits, semantically correct, flagged as FOLLOW-ON-DOWNSTREAM)
  - `repeat-dispatch-escalation.ts:142` — unchanged (counts only dispatches; refusals correctly excluded)
  - `marker-driven-routing.ts:127` — unchanged (selects `agent-exited` only)
  - `missed-wave-review-dispatch.ts:119` — unchanged (selects `stage-dispatched` only)
  - `reconciler/coherence/route.ts:29` — unchanged (filters to `reconciler-action-taken` only)

No layer violations. No DTO-chain creep. No new repositories or event-bus abstractions. Simplicity gate: both modules are minimal — bead-status-reader is ~165 lines incl. JSDoc; event-log additions are 74 lines. The architecture's File Structure Plan listed bead-status-reader (Infrastructure) and event-log additions (existing file) as the Wave-1 deliverables; both shipped exactly as specified.

---

## Code Quality Review

| Bead | LOC | Test Coverage | Failure Modes | Real Fixtures |
|------|-----|---------------|---------------|----------------|
| ehp.1 | 185 source / 342 test | 24 tests | 9 distinct failure paths | 3 live `bd show` captures |
| ehp.2 | 74 source-add / 228 test-add | 6 new tests (18 total in suite) | covers JSONL round-trip + filter semantics | n/a (uses existing test patterns) |

**Failure-mode discipline (regression-pattern #13 Silent Exception Swallowing):** ehp.1's `readBeadStatus` distinguishes ALL failure paths into a single `null` return WITHOUT silently swallowing data. Each failure mode is exercised by an explicit unit test, and the contract is documented in JSDoc ("Never throws"). This is the correct posture per ADR-002 fail-closed. Compare to a hypothetical `catch { return null }` that hid the failure source — here the failure surface is deliberately narrowed and tested. Marker discipline is preserved: when bd is unreachable, callers can distinguish "bd unreachable" (null) from "bead in known state" (BeadSnapshot).

**Round-trip discipline (regression-pattern #1 Write/Read Disconnect):** ehp.2's "JSONL line is greppable + has stable shape" test reads the on-disk JSONL bytes after `appendEvent` and asserts every payload field appears as a raw JSON key. This is the right shape for the operator-grep contract documented in event-log's design-decision ADR ("JSONL, not SQLite — greppable by operators"). Round-trip preservation of all 5 payload fields + 3 top-level fields is verified.

**Type Confusion (regression-pattern #7):** Not applicable — PipelineEvent uses `type: string` (open-ended), not a discriminated union. ehp.2 marker confirms 0 exhaustive switches across the repo. Adding a new variant cannot break exhaustiveness.

**Build-Before-Architect (regression-pattern #10):** Not applicable — architecture doc exists and was honoured. Wave 1 deliverables (bead-status-reader Infrastructure + event-log additive variant) match the architecture's File Structure Plan exactly.

---

## Bugs Filed

None.

---

## Observations (non-blocking, no bugs filed)

These are recorded for operator awareness only. They do not affect the verdict.

### Observation 1 — Shell-injection surface area in execSync (existing precedent)

`bead-status-reader.ts:106` invokes `execSync(\`${bd} show ${beadId} --json\`, ...)` with the bead ID interpolated into the command string. The JSDoc disclaims responsibility ("Caller is responsible for shell-safe bead IDs — they should never contain whitespace or shell metacharacters under bd's id grammar"). This pattern is consistent with the existing `reconciler-bootstrap.ts:673` precedent the bead description references, so this is not a regression introduced by ehp.1. A future hardening pass could migrate both call sites to `execFileSync` with an arg array (defense in depth), but the bd id grammar appears to make the practical risk near-zero today. Not in scope for this epic; if anyone files a follow-on bead, both this module AND `reconciler-bootstrap.ts:669–687` should be migrated together.

### Observation 2 — `wave:1` label not present on Wave 1 beads

Both `beads_web-ehp.1` and `beads_web-ehp.2` carry only `epic:beads_web-ehp` and `ship-type:internal` labels (verified via `bd show <id> --json`). The build plan documents them as Wave 1, and the planner's `Bead Summary` table assigns wave 1 to both, but the `wave:1` label was not applied in bd. The plan's commits (8741eca, f54693e — planner) and the per-bead build commits did not add wave labels to either bead. This is a planner-stage concern (per agent-discipline § 2 step 6), not a code defect introduced by Wave 1's builders. I am completing this Wave-1 review against the beads named in the plan; the operator may wish to (a) backfill `wave:1` on ehp.1 and ehp.2 and (b) verify wave labels are present on Waves 2–5 before the dep-naive `start-wave` dispatcher runs against them.

### Observation 3 — bd timeout discrepancy between bead description and live precedent

The ehp.1 bead description's CONTEXT line cited "~15s timeout" referencing the existing inline pattern. The live precedent at `reconciler-bootstrap.ts:677` is actually `timeout: 10_000` (10s). The builder went with 15_000ms with documented rationale (cold-start daemon RPC absorption) and surfaced the discrepancy under `surprises_or_findings`. This is correctly flagged in the marker per the architect-pattern-empirical-verify discipline; no action needed.

---

## Test Discovery — Pre-existing Failures (out of scope)

`__tests__/lib/stuck-in-stage.test.ts` has 2 stale failures that the ehp.2 builder confirmed via stash-baseline are unrelated to this Wave's work. They were introduced by the wlsr.14 ADR-015 cutover where `act()` now dispatches `run-coherence-agent` instead of STAGE_RESUME_ACTIONS-keyed actions, but the test expectations were not updated. The owner is whoever shipped wlsr.14's source change. Tracked in the ehp.2 marker's `whats_open` as `PRE-EXISTING:`. No action by this Wave-1 review.

---

## Summary

Wave 1 ships clean. `bead-status-reader.ts` is a thin, well-tested Infrastructure adapter that returns `BeadSnapshot | null` against the live `bd show --json` wire shape (verified by 3 real fixtures); its null-on-every-failure contract is the load-bearing primitive for Wave 3's A.5 BD_STATUS_DEFERRED predicate. `event-log.ts` gains a pure-additive `reconciler-action-refused` variant with typed payload + typed event interface; the switch-grep + equality-consumer audit confirms zero behavioural regression on existing 6 PipelineEvent consumers. Tests pass, lint clean, tsc clean, both per-bead commits include their markers, both markers carry evidence-primary content with no padding. Wave 2 (`ehp.3`) can import `readBeadStatus`, `BeadSnapshot`, `RECONCILER_ACTION_REFUSED`, `ReconcilerActionRefusedPayload`, and `ReconcilerActionRefusedEvent` immediately; nothing in Wave 1 needs revision. Operator may want to address Observation 2 (missing `wave:1` labels) before launching downstream waves through the dep-naive `start-wave` dispatcher.
