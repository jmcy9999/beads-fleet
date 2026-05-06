OUTCOME: Wrap `missed-wave-review-dispatch.ts`'s `act()` with `buildDispatchContext` + `evaluatePreconditions` BEFORE its dispatch fetch. On refusal: log + emit `reconciler-action-refused` event + return without dispatching.

SCOPE:
- In: `act()` body modification; refusal logging + event emission; HTTP 412 handling; new integration test file.
- Out: Any change to `match()` logic.

FILES:
- src/lib/reconciler-rules/missed-wave-review-dispatch.ts (MODIFIED)
- NEW: __tests__/lib/reconciler-rules/missed-wave-review-dispatch.precondition-integration.test.ts

AC ITEMS TO VERIFY:
- review-wave dispatch but no plan file at `.beads/plans/<epic>.md` → refusal with PLAN_FILE_MISSING.
- review-wave for wave N where ALL `wave:N` beads are closed (review redundant — niii reviewer-4-wave-4-redundant reproduction) → refusal with ALL_WAVE_BEADS_CLOSED.
- Happy path: existing dispatch fetch fires unchanged.
- Route returns 412 → log + return without throwing.

CONTEXT THE AGENT NEEDS:
- Architecture § Seam 5.
- DispatchContext.planFileExists + openWaveBeadIds are the relevant fields. NOTE: openWaveBeadIds is empty when no OPEN beads exist for the wave; the predicate must distinguish "no beads at all" (NO_WAVE_BEADS) from "all closed" (ALL_WAVE_BEADS_CLOSED). The library's PRECONDITION_TABLE for review-wave should register both.

RISK FLAGS:
- Watch for: NO_WAVE_BEADS vs ALL_WAVE_BEADS_CLOSED disambiguation at predicate level. If the library registers only one, the niii reproduction may pass under one refusalCode but the test asserting the OTHER would fail. Coordinate with the library bead's PRECONDITION_TABLE for `review-wave` — both predicates should be registered.

MARKER REQUIREMENTS:
- Standard marker.
- `what_was_tested`: cite the niii reviewer-4-wave-4-redundant reproduction test file:line.

COMMIT REQUIREMENTS:
- Single commit prefixed `beads_web-ehp.7:`.
- Subject: `beads_web-ehp.7: missed-wave-review-dispatch wraps act() with dispatch-preconditions`.
- Includes: rule modification + integration test + marker file.
