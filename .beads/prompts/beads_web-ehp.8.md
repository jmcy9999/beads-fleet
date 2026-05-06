OUTCOME: Wrap `repeat-dispatch-escalation.ts`'s `act()` with `buildDispatchContext` + `evaluatePreconditions` BEFORE its escalation dispatch fetch. On refusal: log + emit `reconciler-action-refused` event + return without dispatching.

SCOPE:
- In: `act()` body modification; refusal logging + event emission; HTTP 412 handling; new integration test file.
- Out: Any change to `match()` logic or escalation threshold tuning.

FILES:
- src/lib/reconciler-rules/repeat-dispatch-escalation.ts (MODIFIED)
- NEW: __tests__/lib/reconciler-rules/repeat-dispatch-escalation.precondition-integration.test.ts

AC ITEMS TO VERIFY:
- Escalation would fire but the underlying bead is now `status=deferred` → refusal with BD_STATUS_DEFERRED, no escalation dispatch fires.
- Happy path escalation: existing dispatch fetch fires unchanged.
- Route returns 412 → log + return without throwing.

CONTEXT THE AGENT NEEDS:
- Architecture § Seam 5.
- Universal predicate BD_STATUS_DEFERRED (registered against EVERY dispatching action per ADR-005) catches the deferred case before escalation.
- Escalation actions in the table: depend on what this rule dispatches — likely `run-coherence-agent` or similar. The library's PRECONDITION_TABLE for that action key must be populated.

RISK FLAGS:
- Watch for: the rule's escalation might dispatch a different action depending on context (coherence-escalation, more-research, etc.). Each action this rule can fire MUST be in the PRECONDITION_TABLE. If a fired action has no table entry, evaluatePreconditions returns ok=true (no predicates registered means nothing to fail). Verify by enumerating the rule's possible dispatched actions and confirming each has a table entry.

MARKER REQUIREMENTS:
- Standard marker.
- `what_was_done`: list the action(s) this rule can dispatch, and confirm each is in PRECONDITION_TABLE.

COMMIT REQUIREMENTS:
- Single commit prefixed `beads_web-ehp.8:`.
- Subject: `beads_web-ehp.8: repeat-dispatch-escalation wraps act() with dispatch-preconditions`.
- Includes: rule modification + integration test + marker file.
