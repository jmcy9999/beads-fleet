# QA Report: beads_web-ehp (Action route precondition checks) — Round 1

## Summary
- **Flows verified:** 3 (action route HTTP path, reconciler-rule act() path, agent-launcher dispatchChainAction inline path)
- **Personas verified:** 2 (operator dispatching via dashboard; reconciler tick auto-dispatching)
- **Bugs filed:** 3 (P0: 0, P1: 2, P2: 1)
- **Verdict:** FAIL

Three real correctness/quality bugs surfaced in the precondition library's `bead-status-reader.ts` (one security, one event-loop blocking) and the route's repo-path resolution (hardcoded literal). All other end-to-end flows and persona paths verified clean.

## Flow Verification Results

### Flow 1: Action route → preconditions → label mutation → agent launch (Seam 4)

- **Status:** PASS (with bugs filed against the reader infrastructure used by the gate)
- **State transitions verified:**
  - Each of 34 dispatching action handlers in `route.ts` calls `checkPreconditionsOrRefuse` (route.ts:478) at the TOP of its case body, BEFORE any `removeAllPipelineLabels`/`addLabelsToEpic`/`launchAgent` (verified by grep — 34 of 37 case branches gated; the 3 EXEMPT cases stop-agent/human-approve/human-dismiss are intentionally excluded per `EXEMPT_ACTIONS` design).
  - `checkPreconditionsOrRefuse` builds `DispatchContext` via `buildDispatchContext({ epicId, repoPath, action, waveNumber })` (route.ts:509), evaluates predicates (line 515), and on refusal returns HTTP 412 with `{...buildPreconditionRefusalResponse(...), action, epicId}` body (lines 518-521). On pass, returns null and the case body proceeds.
  - Refused dispatches do NOT mutate labels and do NOT launch agents (verified by helper-position at top of case bodies).
- **Issues:** beads_web-hfw (shell injection in the reader the gate calls), beads_web-q8w (sync execSync blocks event loop), beads_web-cqe (hardcoded path in repo resolution).

### Flow 2: Reconciler-rule act() → preconditions → action route 412 path (Seam 5)

- **Status:** PASS
- **State transitions verified:**
  - All 6 dispatching reconciler rules integrate the gate before their fetch:
    - `marker-driven-routing.ts:400-423` (load-bearing for 372-bead defer)
    - `stuck-in-stage.ts:432-453`
    - `wave-bead-mismatch.ts:285-339` (runs `PRECOND_WAVE_BEADS_EXIST` first, then full `evaluatePreconditions`)
    - `missed-wave-review-dispatch.ts:456-485`
    - `repeat-dispatch-escalation.ts:309-330`
    - `repeated-qa-round.ts:320-340`
  - On refusal: structured warn-log + `reconciler-action-refused` event via `appendEvent` + early return WITHOUT dispatching. Verified at each rule.
  - Route-side double-gate (412 path): each rule checks `if (res.status === 412)` after fetch, logs `*_at_route` warning, emits `reconciler-action-refused` with `ROUTE_REFUSED_412` code, returns without throwing. Defense-in-depth per architecture § Seam 5.
  - Exempt rules (coherence-escalation, liveness-check, active-dispatch-probe) correctly NOT gated — verified absent from the integration list.
- **Issues:** None (rule-level integrations are clean; underlying reader bugs are filed separately).

### Flow 3: agent-launcher dispatchChainAction inline → preconditions → action route fetch (third dispatch site)

- **Status:** PASS
- **State transitions verified:**
  - `agent-launcher.ts:2169-2192` builds context, evaluates, on refusal logs + emits event + returns false (preserves existing fall-through semantics).
  - 412 handling at line 2219+ same as reconciler-rule pattern.
- **Issues:** None.

## Persona Verification Results

### Persona 1: Operator dispatches an action via dashboard (POST /api/fleet/action)

- **Path:** dashboard → POST /api/fleet/action with body `{epicId, action, ...}` → route.ts switch case → `checkPreconditionsOrRefuse({epicId, fleetCorePath, action, waveNumber})` → `buildDispatchContext` → `evaluatePreconditions` → either 412 refusal OR existing case-body label mutation + agent launch
- **Status:** PASS (logic) / FAIL (security — see bug beads_web-hfw)
- **Issues:** Crafted request body with shell metacharacters in `epicId` triggers shell injection through `readBeadStatus` (beads_web-hfw, P1). Otherwise the gate is correctly placed, response shape correct (PreconditionRefusalResponse + action + epicId).

### Persona 2: Reconciler tick auto-dispatches based on marker / state

- **Path:** reconciler.tick → rule.matches() → rule.act() → buildDispatchContext + evaluatePreconditions → either fetch /api/fleet/action OR refused-event recorded (no fetch)
- **Status:** PASS
- **Issues:** None at the rule layer. The 6 niii phantom-dispatch scenarios are reproduced end-to-end in `__tests__/integration/niii-phantom-dispatch-reproduction.test.ts` covering Class A.5, Class B (AGENT_RUNNING_NO_SESSION), Class A (NO_WAVE_BEADS), and Class C (OPERATOR_DECISION_PENDING) refusal paths.

## Architecture Failure-Mode Verification (Step 4.5)

Architecture document `docs/research/action-route-lacks-precondition-checks-architecture.md` specifies five integration seams; each is verified below.

| Seam | Failure mode | Implementation present | Reachable | Tests |
|------|--------------|------------------------|-----------|-------|
| 1: bd CLI | bd unreachable → null bead → fail-closed `BD_READ_FAILED` (ADR-002) | ✓ bead-status-reader.ts:113 returns null on any failure | ✓ universal predicates handle null bead | ✓ dispatch-preconditions.test.ts has 19+ BD_READ_FAILED assertions |
| 2: marker file | missing/unreadable → null marker → action-classified | ✓ readMarker returns null; predicates check null | ✓ tested across predicates | ✓ comprehensive null-marker tests in unit suite |
| 3: filesystem (plan file) | ENOENT → exists=false; other fs errors → exists=false + warn | ✓ readPlanFileMeta:1485-1490 | ✓ predicates use `planFileExists` flag | ✓ unit tests for ENOENT and EACCES paths |
| 4: route → label mutation → agent launch | precondition before mutation/launch | ✓ helper at TOP of each case body (verified across 34 cases) | ✓ no case body bypasses the gate (audited via grep) | ✗ no direct route-handler 412 test (transitively covered by rule integration tests) |
| 5: rule → route 412 (double-gate) | rule pre-gate AND route post-gate | ✓ both layers integrated | ✓ each rule handles 412 distinctly from generic HTTP failure | ✓ per-rule precondition-integration tests exercise both layers |

The Seam 4 test gap is a minor coverage concern but the route's behavior is mechanical (one-line `NextResponse.json` projection of a verdict computed by the well-tested library + helper). Not filed as a bug since the library is exhaustively tested at predicate and end-to-end (niii reproduction) level.

## Common Pitfall Checks (Round 1 — Correctness Fundamentals)

- [x] No hardcoded credentials or API keys — verified (no creds, no tokens).
- [x] Error handling for external calls — every bd/fs call has try/catch returning null/[]/false.
- [x] No infinite loops or unbounded recursion — predicates are total, evaluation is bounded by predicate count.
- [ ] **Configuration values externalized** — FAIL: `/Users/janemckay/dev/claude_projects/beads_web` literal in route.ts:496 (filed beads_web-cqe).
- [x] Edge cases handled at obvious boundaries — empty wave-bead lists, null markers, missing plans, etc.
- [x] Logging exists for critical operations — structured warn-logs on every refusal path; `reconciler-action-refused` events emitted.

Additional finding outside the standard checklist:

- [ ] **Shell-safe child-process invocation** — FAIL: bead-status-reader.ts:106 uses shell-interpolated `execSync` (filed beads_web-hfw). Other readers (bead-prompt.ts:62, pipeline-labels.ts:131) use safe `execFile` patterns.
- [ ] **Async I/O vs. event-loop blocking** — FAIL: bead-status-reader.ts:106 declared async but uses `execSync` (filed beads_web-q8w).

## Platform-Specific Checks

`standards/platforms/internal/` directory exists but contains no qa-testing.md. No platform-specific checks applied.

## STOP-and-Surface Check

No surfacing-protocol triggers apply at Round 1:
- No bug from a prior round (this is round 1).
- All three flows verified end-to-end.
- Findings span three different code locations (no systemic single-cause pattern).

## Bugs Filed

| ID | Priority | Wave | Description |
|----|----------|------|-------------|
| beads_web-hfw | P1 | wave:6 | Shell command injection in bead-status-reader.ts via execSync with interpolated bead ID |
| beads_web-q8w | P1 | wave:6 | readBeadStatus declared async but uses blocking execSync — stalls Next.js event loop |
| beads_web-cqe | P2 | wave:6 | Hardcoded /Users/janemckay/dev/claude_projects/beads_web path in route.ts violates configuration externalisation |

## Verdict

**FAIL** — Two P1 bugs (shell injection, event-loop blocking) and one P2 bug (hardcoded path) require fixing. Per QA principles, any open bug means FAIL regardless of priority. Re-dispatch builder for Wave 6 fix wave; re-run QA round 2 after fixes land.
