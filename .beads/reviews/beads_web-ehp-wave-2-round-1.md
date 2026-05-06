# Code Review — beads_web-ehp Wave 2 Round 1

**Epic:** beads_web-ehp — Action route lacks precondition checks
**Wave:** 2 (minimal dispatch-preconditions library — load-bearing for 372-bead defer)
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

Wave 2's single bead (`beads_web-ehp.3`) ships a clean, well-tested minimal scaffold of `src/lib/dispatch-preconditions.ts`. The load-bearing 372-bead-defer protection is verified end-to-end against a real bd 0.62.0 + dolt sql-server 1.84.0 instance — when a bead's actual `bd show --json` status is `deferred`, `evaluatePreconditions` refuses with `BD_STATUS_DEFERRED`; when bd is unreachable, it refuses with `BD_READ_FAILED` (ADR-002 fail-closed). 48 unit tests + 8 integration tests all pass; full beads_web suite stays green; tsc and ESLint are clean within Wave 2 scope. The bead's per-bead commit (13c9222) carries the correct prefix and Co-Authored-By tag, and the marker is part of the commit per the 2026-05-01 ordering directive.

Zero bugs filed. Nine non-blocking observations recorded for operator awareness (see § Observations) — six overlap with the builder's self-review and three are fresh-eyes findings on architectural-deviation surfaces that are documented in the marker but not in code. None blocks Wave 3 dispatch.

---

## Scope-of-Review Note (Surfacing Protocol)

The trigger prompt directed: "ONLY review beads with `wave:2` label." The `wave:2` bd label is NOT actually applied to `beads_web-ehp.3` — `bd show beads_web-ehp.3 --json` reports labels `["epic:beads_web-ehp", "ship-type:internal"]`. This continues the planner-stage convention gap noted in Wave-1 Round 1's Observation 2 (no `wave:1` label on Wave 1 beads either).

The build plan unambiguously identifies `beads_web-ehp.3` as the only Wave-2 bead ("Wave 2 = beads_web-ehp.3 — Minimal library — load-bearing for 372-bead defer"; Bead Summary table row 3 carries `Wave=2`). Per surfacing-protocol § 1, I am completing the review against the named bead from the plan, with this scope discrepancy explicitly documented. Operator may want to backfill `wave:N` labels on all child beads before launching downstream waves through the dep-naive `start-wave` dispatcher (the dispatcher reads wave labels at runtime — see `agent-launcher.ts:1370`).

---

## Beads in Wave 2

| Bead ID | Title | Status | Commit |
|---------|-------|--------|--------|
| beads_web-ehp.3 | (Wave-2 minimal) dispatch-preconditions library — 4 universal predicates (A.5 + C) + type skeleton + minimal table | closed | 13c9222 (work + marker), 75ab5b0 (wave-2 report) |

---

## Standing Order Compliance

| Check | Status | Notes |
|-------|--------|-------|
| Investigation-Before-Code (agent-discipline § 1) | PASS | Marker documents upfront cross-checks: AGENT_TO_ACTION canonical 10-action set verified against `agent-action-map.ts` (yielding the surprise that `builder` → `start-wave`, not `run-builder`); marker schema verified against `marker-reader.ts`'s MarkerData interface; reader interfaces (`readBeadStatus`, `readMarker`, `getEpicLabels`) confirmed to exist with the expected signatures. |
| Plan Decomposition (agent-discipline § 2) | PASS | Plan exists at `.beads/plans/beads_web-ehp.md`. Bead has explicit AC, Files manifest (3 files), epic label, and ship-type label. Wave 2 has zero intra-wave deps (single-bead wave); cross-wave dep `ehp.3 → ehp.1, ehp.2` honoured (ehp.3 imports BeadSnapshot from ehp.1 and references RECONCILER_ACTION_REFUSED indirectly via test fixtures from ehp.2). |
| Tests Written (agent-discipline § 4) | PASS | 48 unit tests (`__tests__/lib/dispatch-preconditions.test.ts`, 737 lines) covering every AC item: type-skeleton exhaustiveness, discriminated-union narrowing, each universal predicate (happy + refusal + appliesTo), evaluation order (BD_READ_FAILED priority over Class C), table coverage, input validation, SCAFFOLDED-fields contract, end-to-end happy + deferred + bd-read-failed. 8 integration tests (`__tests__/lib/dispatch-preconditions.integration.test.ts`, 430 lines) against real bd 0.62.0 + real dolt sql-server 1.84.0 in a fresh tmp repo on a random high port. |
| Test Suite Green | PASS | Re-ran locally during this review: 48/48 unit + 8/8 integration pass. Unit tests in 0.226s; integration tests in 5.564s (server spawn dominates). Pre-existing failures in `__tests__/api/*` are TypeScript-error noise unrelated to this Wave (pre-date ehp.3; were also flagged in Wave-1 review). |
| TypeScript clean (in scope) | PASS | `npx tsc --noEmit` reports 0 errors related to `dispatch-preconditions.ts` or its tests. Pre-existing TS errors in `__tests__/api/issue-action.test.ts` and `__tests__/api/fleet-action*.test.ts` are unrelated to this Wave (Next.js param-shape drift; pre-dates ehp.3). |
| ESLint clean (in scope) | PASS | `npx eslint src/lib/dispatch-preconditions.ts __tests__/lib/dispatch-preconditions.test.ts __tests__/lib/dispatch-preconditions.integration.test.ts` reports 0 errors / 0 warnings. |
| Bead-id-first commit policy (agent-discipline § 7) | PASS | 13c9222 starts with `beads_web-ehp.3:`; 75ab5b0 starts with `beads_web-ehp.3:`. Both include the Co-Authored-By tag. |
| Marker write LAST + part of commit (marker-protocol § 1, 2026-05-01 directive) | PASS | `git show --stat 13c9222` confirms `.beads/markers/beads_web-ehp.3.json` is in the same commit as the source/test files. `status=success`, no BLOCKERs, `next_agent=reviewer`. |
| Marker quality discipline (marker-protocol § 2) | PASS | Builder marker carries evidence-primary content: 3 per-AC entries with action/result/evidence, integration-vs-unit verification depth declared explicitly per Step 5c, two prose-only deviations from bead description acknowledged with cross-references (action-name list placeholder; "12 codes" → 15 codes), 4 surprises_or_findings recorded with concrete causes, 3 FOLLOW-ONs labelled. |
| Layer compliance (architecture § Layer Mapping) | PASS | `dispatch-preconditions.ts` sits in Application: imports Domain types (`BeadSnapshot`, `MarkerData`) and Infrastructure adapters (`readBeadStatus`, `readMarker`, `getEpicLabels`). No SwiftUI / React / Next.js framework imports. Pure-where-possible: predicates are synchronous, side-effect-free; only `buildDispatchContext` performs I/O. No layer violations. |
| No force-unwrap / null-safety (code-principles) | PASS in source / OBSERVATION in test | Source has zero force-unwraps. Optional-chaining used correctly for `marker?.next_agent`. Empty-string blocker_class trimmed before comparison. Bead snapshot null-check is the FIRST line of every A.5 predicate (preserves ADR-002 fail-closed). Test file has two `BD_BIN!` and `DOLT_BIN!` force-unwraps inside the `describeIfEnabled` gate (lines 129-130) — see Observation 2. |
| No hardcoded credentials | PASS | No tokens, secrets, or PII in source. The test file's `bd init --skip-agents --skip-hooks` invocation uses test-local config; the dolt sql-server runs on a random high port; the env block (`BEADS_DOLT_SERVER_PORT/HOST`) is constructed from generated values. |
| External-call error handling | PASS | `buildDispatchContext` calls three readers via `Promise.all`. Each reader documents a null/empty fallback contract (readBeadStatus → null on any failure per Wave-1 spec; readMarker → null on missing/malformed file; getEpicLabels → [] on bd error per pipeline-labels.ts:144). buildDispatchContext does NOT wrap reader errors itself — it relies on the readers' published null contracts. This is the correct posture per the architecture's "Pure where possible" + Seam-1 fail-closed combination. |
| Naming conventions | PASS | `RefusalCode` (string-literal union), `PreconditionResult` (discriminated union), `DispatchContext`, `Precondition`, `PRECOND_BD_STATUS_NOT_DEFERRED`, `UNIVERSAL_ACTIONS`, `PRECONDITION_TABLE`, `evaluatePreconditions`, `buildDispatchContext` — all idiomatic TypeScript / consistent with project style (e.g., RoutingDecision in marker-routing.ts uses the same shape). |
| Anchor-decision compliance — ADR-001 (discriminated union, NOT exceptions) | PASS | `PreconditionResult = { ok: true } \| { ok: false; refusalCode; failedCheck; reason }`. No `throw new PreconditionRefusalError` anywhere. Type narrows on `ok` per ADR-001's "+ trivially testable" consequence. |
| Anchor-decision compliance — ADR-002 (bd-read fail-closed → BD_READ_FAILED) | PASS | Both A.5 predicates check `ctx.bead === null` FIRST and refuse with `BD_READ_FAILED`. Verified end-to-end in integration test "bd-read failure (non-existent bead-id) → BD_READ_FAILED via fail-closed posture" against real bd. The 372-bead-defer scenario is reproduced separately (test `LOAD-BEARING — real deferred bead refuses with BD_STATUS_DEFERRED`); the architecture's "two refusal codes are distinct" invariant is asserted in test `distinct codes — deferred bead refuses with BD_STATUS_DEFERRED, NOT BD_READ_FAILED`. |
| Anchor-decision compliance — ADR-003 (single-file library) | PASS | All Wave-2 deliverables in `src/lib/dispatch-preconditions.ts`. No sub-modules under `src/lib/dispatch-preconditions/`. ehp.13 will extend this same file. |
| Anchor-decision compliance — ADR-004 (PRECONDITION_TABLE keyed by action name) | PASS | `PRECONDITION_TABLE: ReadonlyMap<string, readonly Precondition[]>` built at module load via `buildTable()`. `appliesTo(action)` exists on each predicate for self-documentation per ADR-004. Lookup is O(1). |
| Anchor-decision compliance — ADR-005 (classes A, A.5, B, C, D, E all in v1) | PASS for ehp.3's portion | RefusalCode union ships ALL codes for all six classes — A (5), A.5 (3), B (3), C (2), D (1), E (1) = 15 total. ehp.3 implements the 4 universal A.5+C predicates; ehp.13 (Wave 3 sibling) implements A/B/D/E per the cross-wave producer-consumer dep. Consistent with ADR-005's "split across two beads" sequencing. |
| Anchor-decision compliance — ADR-006 (new event-log variant for refusals) | N/A for ehp.3 | ehp.2 (Wave 1) added the `reconciler-action-refused` variant; ehp.3 references it indirectly via RefusalCode strings consumed downstream. Wave-3+ caller integrations will emit the events. |
| Regression-pattern #1 Write/Read Disconnect | N/A | No persistence introduced; library reads through to existing readers. |
| Regression-pattern #2 Unguarded Range | N/A | No range constructions. |
| Regression-pattern #3 State Reset Missing | N/A | No multi-step flows; predicates are pure. |
| Regression-pattern #4 Validation Scattered | PARTIAL — see Observation 5 | The library IS the single source per ADR-003. A drift-guard test exists (`Validation Scattered drift guard — universal predicates live ONLY in dispatch-preconditions.ts`) but only spot-checks the names array; it does NOT grep src/ for inline duplications of these checks. The marker correctly defers the cross-tree drift-guard sweep to ehp.13's table-completeness test. Acceptable for Wave 2's minimal scope; flagged so ehp.13 actually delivers it. |
| Regression-pattern #7 Type Confusion | PASS | RefusalCode is a closed string-literal union with all 15 codes; REFUSAL_CODES exhaustiveness map mirrors at runtime. PreconditionResult discriminated union narrows on `ok`. The unit test `REFUSAL_CODES exhaustiveness map has exactly the 15 architecture-specified codes` asserts the keys. (See Observation 4 for the brittle "sentinel typo" pattern in this same test.) |
| Regression-pattern #13 Silent Exception Swallowing | PASS | `buildDispatchContext` does not wrap reader errors. Each reader has its own null/empty contract verified in unit tests. The library NEVER does `catch { return ok: true }` — every refusal carries refusalCode + failedCheck + reason. The unregistered-action pass-through (Observation 7) does emit a `console.warn`, not a silent skip. |

---

## Architecture Review

`src/lib/dispatch-preconditions.ts` (577 lines including JSDoc and section banners; ~250 lines of substance):

**Surface (verified against architecture § Component Boundaries):**
- Public exports: `RefusalCode` type, `REFUSAL_CODES` runtime exhaustiveness map, `PreconditionResult` type, `DispatchContext` interface, `Precondition` interface, four named predicate constants (`PRECOND_BD_STATUS_NOT_DEFERRED`, `_NOT_CLOSED`, `_OPERATOR_DECISION_NOT_PENDING`, `_REVIEW_NEEDS_HUMAN_NOT_SET`), `UNIVERSAL_PRECONDITIONS` array, `UNIVERSAL_ACTION_SET`, `PRECONDITION_TABLE`, `evaluatePreconditions(ctx)`, `BuildDispatchContextInput` interface, `buildDispatchContext(input)`.
- This matches the architecture's diagram exports (page 174-205): `PRECONDITION_TABLE`, `Precondition[]`, `buildDispatchContext`, `evaluatePreconditions`. The architecture's `PreconditionRefusalResponse` HTTP-412-body helper is correctly NOT in this Wave (deferred to ehp.13 per scope).

**Layer Mapping cross-check:**
- Domain: `RefusalCode`, `PreconditionResult`, `DispatchContext`, `Precondition` — pure types, zero framework imports. ✓
- Application: `evaluatePreconditions`, `PRECONDITION_TABLE`, `UNIVERSAL_ACTIONS`, `buildTable()`. ✓
- Infrastructure dependencies: `readBeadStatus` (Wave-1 thin wrapper), `readMarker` (existing), `getEpicLabels` (existing). ✓ No direct fs/exec calls in this file.

**Predicate semantics (each verified against architecture):**
1. `bd-status-not-deferred` (line 267-293): null-check first → BD_READ_FAILED; status check → BD_STATUS_DEFERRED. The reason string includes the bead id and the "load-bearing for 372-bead mass-defer" annotation — useful for log forensics. ✓
2. `bd-status-not-closed` (line 301-327): identical fail-closed posture. ✓
3. `operator-decision-not-pending` (line 345-368): AND-gated on `next_agent === "operator"` AND `blocker_class` set (with `.trim()` to reject whitespace-only). Optional chaining for null-marker case. ✓ correctly tested with all 5 truth-table cases (operator+blocker → refuse; operator+no-blocker → ok; operator+empty-blocker → ok; non-operator → ok; null-marker → ok).
4. `review-needs-human-not-set` (line 381-399): exact label match `"human-decision:required"` (NOT `review:needs-human`, which is BeadSnapshot.hasReviewNeedsHuman's label — comment correctly notes the distinction). ✓

**Evaluation order (line 408-413):** `[BD_STATUS_NOT_DEFERRED, BD_STATUS_NOT_CLOSED, OPERATOR_DECISION_NOT_PENDING, REVIEW_NEEDS_HUMAN_NOT_SET]`. The order ensures bd-state checks fire before marker-derived and label-derived checks — consistent with the architecture's "BD_READ_FAILED is more fundamental than any marker decision" priority commentary. The unit test "evaluation ORDER — null bead AND operator-pending marker → BD_READ_FAILED first" verifies this directly.

**Single-file simplicity gate (architecture-principles §):**
- 577 lines including ~280 lines of JSDoc and section banners. Substance: ~250 lines, well within the architecture's "~250 lines library" estimate.
- One file, no sub-modules. ✓
- No DTO chains: DispatchContext is read by predicates directly; no Model→ViewModel→View hops. ✓
- No new repositories. The library composes existing readers; it does not abstract them. ✓
- No event bus / NotificationCenter. ✓
- No protocols (interfaces) introduced where one implementation suffices: `Precondition` is an interface because there ARE multiple implementations (4 in this Wave; 10+ in ehp.13). ✓ justified.

---

## Code Quality Review

| Area | Source LOC | Test LOC | Coverage | Real-instance verification |
|------|-----------|----------|----------|----------------------------|
| dispatch-preconditions.ts | 577 (≈250 substance) | 737 unit + 430 integration | 48 unit + 8 integration tests | bd 0.62.0 + dolt 1.84.0 in fresh tmp repo, 5 distinct bead-state scenarios + 3 marker/label scenarios |

**Failure-mode discipline:** The library never silently swallows. The two distinct null paths (bd unreachable → BD_READ_FAILED; bead.status === "deferred" → BD_STATUS_DEFERRED) are documented in code comments and asserted independently by integration tests. The architecture's Seam 1 fail-closed posture is preserved without ambiguity.

**Round-trip discipline:** N/A — library doesn't persist. The integration test's marker-fixture writeFile + buildDispatchContext + evaluatePreconditions IS a write→read→evaluate round-trip on the marker file path; that exercises Seam 2 (action-classifying for marker reads).

**Type-narrowing rigour:** The unit test `PreconditionResult discriminated union narrows on ok` uses `@ts-expect-error` to assert the narrowing rejects `ok=true` access of `refusalCode`. This is the strongest TypeScript narrowing assertion possible. ✓

**Test pyramid distribution:** 48 unit + 8 integration = 86% unit / 14% integration. No E2E. Healthy pyramid. The integration tests exercise the load-bearing seams (bd subprocess + real marker file + real bd labels) per builder.md Step 5c verification depth.

---

## Bugs Filed

None.

---

## Observations (non-blocking, no bugs filed)

These are recorded for operator awareness only. They do not affect the verdict. Items 1, 2, 4, 5, 6, 7 overlap with the builder's self-review observations; items 3, 8, 9 are fresh-eyes findings.

### Observation 1 — `wave:2` label not present on Wave 2 bead

`beads_web-ehp.3` carries only `epic:beads_web-ehp` and `ship-type:internal` labels. The build plan documents it as Wave 2 (and the bd update wave-label step appears in agent-discipline § 2 step 6) but the planner's commits (8741eca, f54693e) and the per-bead build commit did not add wave labels. The dep-naive `start-wave` dispatcher reads wave labels at runtime; missing labels could silently exclude beads from being dispatched to a wave even when the plan considers them in scope. This is a continuation of Wave-1 Round-1's Observation 2; the operator may wish to backfill `wave:N` labels on every child bead before launching downstream waves through `start-wave`.

### Observation 2 — `BD_BIN!` / `DOLT_BIN!` force-unwraps inside `describeIfEnabled` gate

`__tests__/lib/dispatch-preconditions.integration.test.ts:129-130` uses non-null assertions:
```typescript
const BD = BD_BIN!;
const DOLT = DOLT_BIN!;
```
The `describeIfEnabled = ENABLED ? describe : describe.skip` gate at line 112 ensures these are only used when `BD_BIN` / `DOLT_BIN` are non-null, but TypeScript can't see through the closure. The force-unwrap is functionally safe; the alternative would be `if (BD_BIN === null) return;` inside each test (verbose) or capturing into module-scope const after the null check (also fine). Builder's marker self-review flagged this; not blocking. Future hardening could refactor to a type guard helper.

### Observation 3 — `DispatchContext` shape deviates from architecture; deviation documented in marker but not in code

The architecture's `DispatchContext` interface (architecture doc § Data Model line 120-133) specifies fields: `epicId, repoPath, action, waveNumber?, bead, marker, planFileExists, openWaveBeadIds, contextBuiltAt`.

The implementation's `DispatchContext` (line 156-183) is: `action, bead, marker, epicLabels, planFileExists, openWaveBeadIds, stageEnteredAt`.

Differences:
- DROPPED: `epicId`, `repoPath`, `waveNumber`, `contextBuiltAt`. (epicId/repoPath/waveNumber moved to `BuildDispatchContextInput` per the builder's separation of input from snapshot — defensible. contextBuiltAt — staleness telemetry — silently dropped.)
- ADDED: `epicLabels`, `stageEnteredAt`. (epicLabels is reasonable — the architecture's data-model `BeadSnapshot.labels` is the bead's labels; epic-scope label semantics deserve a dedicated field. stageEnteredAt replaces contextBuiltAt with a different semantic — Class D's "stage-entered-at" reference per ADR-005.)

The builder's marker enumerates these deviations under `deviations_from_ac` and the code comments explain the SCAFFOLDED-fields rationale, but the DispatchContext-shape divergence from architecture is not flagged in code — the field-set differences could surprise ehp.4/ehp.13 readers who consult the architecture doc rather than the source. Consider a JSDoc comment on the interface noting "Field set adapted from architecture § Data Model — see deviations summary" so the next reader doesn't burn time cross-referencing.

### Observation 4 — Sentinel-typo pattern in `REFUSAL_CODES` exhaustiveness test is brittle and doesn't test what it claims

`__tests__/lib/dispatch-preconditions.test.ts:142-158`:
```typescript
"OPERATUE_DECISION_PENDING" as RefusalCode,    // intentional typo
...
const realExpected = expected.map((c) =>
  c === ("OPERATUE_DECISION_PENDING" as RefusalCode)
    ? "OPERATOR_DECISION_PENDING"
    : c,
);
```
The comment claims the typo "exercises the keys-in-but-not-equal failure mode" but the test maps the typo back to the correct value before comparing — so the test never actually exercises a typo failure. If a future refactor changed the mapping, the test would still pass. Effectively this is dead code wrapped in misleading commentary. Either remove the sentinel pattern (the simple `expect(actualKeys).toEqual([15 real codes].sort())` already covers exhaustiveness) or genuinely use the typo by asserting `expect(...).not.toContain(typoValue)`. Builder's self-review flagged this; not blocking.

### Observation 5 — Validation-Scattered drift-guard test is incomplete

The test `Validation Scattered drift guard — universal predicates live ONLY in dispatch-preconditions.ts` (line 530-545) asserts the four universal predicate names against UNIVERSAL_PRECONDITIONS — but it does NOT grep the rest of `src/` for inline duplications of bd-status / operator-decision / review-needs-human checks. The architecture's ADR-003 (single source of truth) is enforceable only with a real cross-tree sweep. The marker correctly defers this to ehp.13's "table-completeness test" but the deferral creates a window where ehp.4–11 builders could re-implement these checks inline before ehp.13's drift guard catches them. ehp.13's test must actually deliver the cross-tree sweep, not just the table-completeness assertion.

### Observation 6 — Stale "12 codes" prose in module-level comment vs actual 15-code roster

Line 63 module-level comment says "RefusalCode — exhaustive 12-code union (per architecture § Refusal Codes)" but `REFUSAL_CODES` ships 15 keys (the architecture's 12 plus PLAN_INSTABILITY, ACTION_NEXT_AGENT_MISMATCH, BD_READ_FAILED — the latter two added by ADR-005 / ADR-002 amendments). The detailed enumeration immediately below the comment lists all 15 correctly. Builder's self-review flagged this; minor. A two-character edit (`12` → `15`) eliminates the inconsistency.

### Observation 7 — Fail-OPEN policy for unregistered actions diverges from architecture's implication

`evaluatePreconditions` at line 470-486 returns `{ ok: true }` (with `console.warn`) when an action is not registered in the table. The in-file comment at line 425 acknowledges this is a "Wave-2 minimal pass-through policy" deliberately chosen to avoid breaking in-flight dispatches while ehp.13's table extension lands.

The architecture's ADR-004 wording ("predicates are independent; PRECONDITION_TABLE keyed by action name") doesn't strictly mandate fail-CLOSED on missing entries, but ADR-002 (fail-closed on bd-read) and the bug's first failure mode (phantom dispatches from stale state) push the project's posture toward fail-closed defaults. This is a transitional fail-OPEN; ehp.13 is responsible for closing it. Not blocking; flagged so ehp.13's table-completeness test is treated as load-bearing rather than nice-to-have.

The minimal table covers the canonical 10-action set verified against `agent-action-map.ts`'s `AGENT_TO_ACTION` — sufficient for ehp.4's load-bearing scope (marker-driven-routing's `act()` resolves only those 10). Any action not in that set passes through with warn until ehp.13 ships, generating one log line per unregistered dispatch.

### Observation 8 — Marker filename derivation reads only per-bead markers; epic-scope markers (`<epicId>-<stage>.json`) are not consulted

`buildDispatchContext` calls `readMarker(input.repoPath, input.epicId)` (line 563), which reads `<repoPath>/.beads/markers/<epicId>.json`. Per the architecture's marker schema (§ Failure modes Seam 2 + line 128), epic-scope markers (`architect`, `planner`, `coherence`, etc.) are stored as `<epicId>-<stage>.json` and are the markers most likely to carry `next_agent=operator` after an architect/planner STOP-and-Surface or coherence escalation.

The Wave-2 implementation's per-bead-only read is documented in code (lines 502-512) and explicitly defers epic-scope marker reading to ehp.13. As a consequence, the OPERATOR_DECISION_PENDING predicate in Wave 2 will fire ONLY for per-bead markers that have `next_agent=operator + blocker_class set` (i.e., the loop-agent-contract-violation-after-rewrite scenario, which should be rare per the stage-aware rewrite at marker-driven-routing.ts).

This is not a bug — it's the documented Wave-2 minimal scope — but it bears flagging because the `OPERATOR_DECISION_PENDING` test cases in the unit suite all use per-bead markers. The "real" scenario the architecture describes (coherence escalation parking the epic) is not exercised by this Wave's tests because coherence's marker is at `<epicId>-coherence.json` and would not be read by Wave-2's `buildDispatchContext`. ehp.13's responsibility: action-classify the marker filename per Seam 2 so coherence-escalation markers actually gate downstream auto-progression.

### Observation 9 — `epicLabels` and `bead.labels` are populated via two reader paths that produce the same data

`getEpicLabels(issueId, repoPath)` (`src/lib/pipeline-labels.ts:127`) parses the LABELS line from `bd show <issueId>` output. `readBeadStatus(epicId, repoPath)` reads `bd show <id> --json` and pulls the `labels` array. For the same `issueId === epicId`, these return the same data via two separate bd subprocess calls. `buildDispatchContext` reads both in parallel via `Promise.all`, so the wall-clock cost is bounded by the slower call, but the bd CPU + dolt round-trip is doubled.

This is not a correctness issue — `BeadSnapshot.labels` and `DispatchContext.epicLabels` are wired through to different predicates (REVIEW_NEEDS_HUMAN reads epicLabels; A.5 predicates read `bead.status` only). But for performance, ehp.13 could derive `epicLabels` from `bead.labels` and drop the `getEpicLabels` call. The architectural redundancy is worth flagging now while the seam is fresh; once ehp.13 lands and predicates are cemented, refactoring becomes higher-risk.

---

## Summary

Wave 2 ships clean. `src/lib/dispatch-preconditions.ts` is a focused, well-typed Application-layer library that composes existing Infrastructure readers and exposes four pure universal predicates plus a discriminated-union verdict path. The load-bearing 372-bead-mass-defer protection is verified end-to-end against a real bd + real dolt instance, including the architecture's "BD_READ_FAILED is distinct from BD_STATUS_DEFERRED" invariant. Tests pass, lint/tsc clean in scope, the per-bead commit carries the marker, and the marker reflects post-mutation state with evidence-primary content per the 2026-04-28 protocol. Wave 3 (`ehp.4` integrating into `marker-driven-routing.ts`'s `act()` + `ehp.13` extending the library) can dispatch in parallel: ehp.4 consumes only the exports this bead ships; ehp.13 extends the file purely additively per the cross-wave invariant the builder asserts.

The nine non-blocking observations are split between (a) self-review continuity (six items the builder also flagged — code-comment polish, test brittleness, deferred drift-guards) and (b) architectural-deviation surfaces that are documented in the marker but not in code (DispatchContext shape divergence, marker-filename per-bead-only scope, redundant epicLabels read path). None blocks Wave-3 dispatch. Operator may want to address Observation 1 (missing `wave:2` label) before launching Wave 3 through the dep-naive `start-wave` dispatcher.
