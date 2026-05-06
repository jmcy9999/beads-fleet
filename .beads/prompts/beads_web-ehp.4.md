OUTCOME: Wrap `marker-driven-routing.ts`'s `act()` body with `buildDispatchContext` + `evaluatePreconditions` BEFORE the existing dispatch fetch. On refusal: emit `reconciler-action-refused` event-log entry + structured warn-log + return WITHOUT dispatching. This is the load-bearing integration: A.5 BD_STATUS_DEFERRED protects the 372-bead mass-defer.

SCOPE:
- In: `act()` body modification only; structured warn-log + event emission on refusal; HTTP-412-from-route handling per architecture § Seam 5; new integration test file.
- Out: Any change to `match()` logic; any rewriting of `marker-routing.ts`'s `interpretMarkerForRouting`; cutting over from "decide" to "escalate" (wlsr ADR-015 Phase B owns that and ships independently).

FILES:
- src/lib/reconciler-rules/marker-driven-routing.ts (MODIFIED)
- NEW: __tests__/lib/reconciler-rules/marker-driven-routing.precondition-integration.test.ts

AC ITEMS TO VERIFY:
- bd `status=deferred` (the 372-bead mass-defer scenario) → refusal with BD_STATUS_DEFERRED, no dispatch fires, `reconciler-action-refused` event recorded.
- Marker has `next_agent='operator'` and `blocker_class='spec-ambiguity'` → refusal with OPERATOR_DECISION_PENDING.
- Happy path: existing dispatch fetch fires unchanged AND existing `reconciler-action-taken` event is recorded as today.
- Route returns HTTP 412 → log `reconciler_dispatch_refused_at_route` event AND return without throwing (do not raise as HTTP failure).
- Tests use fixtures matching the real marker schema, real bd label set, real event-log JSONL format.

CONTEXT THE AGENT NEEDS:
- Architecture doc § Component Boundaries Contract 2 — the call shape (after snapshot re-read, before dispatch fetch).
- Architecture doc § Seam 5 — defense-in-depth (rule + route both check); 412 handling distinguishes refusal from genuine HTTP failure.
- Wave 1 (beads_web-ehp.2) added the `reconciler-action-refused` event-log variant — use it.
- Wave 2 (beads_web-ehp.3) library exports `buildDispatchContext`, `evaluatePreconditions`, `RefusalCode`. Import these.
- This rule is currently "the most permissive" of the dispatching rules per the operator's dispatch pointer NOTES (2026-05-06).

RISK FLAGS:
- Watch for: regression on the load-bearing AC (BD_STATUS_DEFERRED catches 372-bead defer). If the integration test for `status=deferred` does not refuse, STOP and surface — do not document degradation. The 372-bead defer is operationally protected by THIS bead.
- Watch for: throwing on HTTP 412. The existing `if (!res.ok) throw` pattern at the rule's fetch site must be modified to recognise 412 as a refusal (log + return) rather than an HTTP failure (throw). Architecture § Seam 5 explicitly calls this out.
- Watch for: idempotency-key collision. Today's rules record `reconciler-action-taken` on dispatch with bucketing; refusals MUST NOT count toward that bucket. The bucketing for refusals is `(epicId, ruleName, refusalCode, 15-min window)` per architecture ADR-006 — defer to reconciler.ts's existing window helper or document the gap as FOLLOW-ON.

MARKER REQUIREMENTS:
- Standard marker.
- `what_was_tested`: explicitly cite the BD_STATUS_DEFERRED integration test file:line as the load-bearing AC verification.
- `recommendation_for_next`: if the bucketing for refusals (ADR-006 15-min window) was deferred, list it as FOLLOW-ON for a separate reconciler-core bead.

COMMIT REQUIREMENTS:
- Single commit prefixed `beads_web-ehp.4:`.
- Subject: `beads_web-ehp.4: marker-driven-routing wraps act() with dispatch-preconditions`.
- Includes: rule modification + integration test + marker file.
