OUTCOME: Wrap `stuck-in-stage.ts`'s `act()` body with `buildDispatchContext` + `evaluatePreconditions` BEFORE the existing action-route fetch. On refusal: log + emit `reconciler-action-refused` event + return without dispatching. Stuck-in-stage is the most-frequent re-dispatcher and the top source of phantom dispatches when stages have not actually completed.

SCOPE:
- In: `act()` body modification; refusal logging + event emission; HTTP 412 handling; new integration test file.
- Out: Any change to `match()` logic, the 15-min idempotency window logic at `stuck-in-stage.ts:156`, or the existing stage→action lookup table.

FILES:
- src/lib/reconciler-rules/stuck-in-stage.ts (MODIFIED)
- NEW: __tests__/lib/reconciler-rules/stuck-in-stage.precondition-integration.test.ts

AC ITEMS TO VERIFY:
- Phantom wave-N dispatch (no `wave:N` open beads — niii phantom-wave-4 reproduction) → refusal with NO_WAVE_BEADS, no dispatch fires.
- Plan-pending refusal: epic stuck in `plan-review` but `plan:pending` label still set → refusal with PLAN_PENDING.
- Happy path: existing dispatch fetch fires unchanged.
- Route returns 412 → log + return without throwing.
- Tests use real bd label-set fixtures + real event-log JSONL format.

CONTEXT THE AGENT NEEDS:
- Architecture § Seam 5: defense-in-depth (rule + route both check).
- Existing 15-min idempotency window (`stuck-in-stage.ts:156`) — preserve unchanged.
- Wave 2 library import shape: see beads_web-ehp.4's pattern (it's the reference implementation for rule integrations).

RISK FLAGS:
- Watch for: idempotency window gets confused by refusal events. Refusals MUST NOT count toward `reconciler-action-taken` bucketing. If the rule's existing window logic counts refusals as "taken", it needs splitting; document as FOLLOW-ON if not addressed in this bead's scope.
- Watch for: copy-paste of beads_web-ehp.4's pattern. Each rule has its own snapshot-re-read shape; do not blindly copy without confirming the rule-specific fields (e.g., resumeAction, waveNumber, epicId derivation).

MARKER REQUIREMENTS:
- Standard marker.
- `what_was_tested`: cite the NO_WAVE_BEADS test file:line as the niii reproduction-relevant AC.

COMMIT REQUIREMENTS:
- Single commit prefixed `beads_web-ehp.5:`.
- Subject: `beads_web-ehp.5: stuck-in-stage wraps act() with dispatch-preconditions`.
- Includes: rule modification + integration test + marker file.
