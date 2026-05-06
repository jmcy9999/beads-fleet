OUTCOME: Wrap `repeated-qa-round.ts`'s `act()` with `buildDispatchContext` + `evaluatePreconditions`. The class B QA_ROUND_OUT_OF_ORDER predicate is the canonical guard against round-N+1 dispatch when round-N marker is missing.

SCOPE:
- In: `act()` body modification; refusal logging + event emission; HTTP 412 handling; new integration test file.
- Out: Any change to `match()` logic.

FILES:
- src/lib/reconciler-rules/repeated-qa-round.ts (MODIFIED)
- NEW: __tests__/lib/reconciler-rules/repeated-qa-round.precondition-integration.test.ts

AC ITEMS TO VERIFY:
- Epic has `qa:round-3` label but no marker exists for round 3 yet (round-2 marker is the latest), and the rule would advance to round 4 dispatch → refusal with QA_ROUND_OUT_OF_ORDER.
- Happy path (prior round marker exists with status=success): existing dispatch fetch fires unchanged.
- Route returns 412 → log + return without throwing.

CONTEXT THE AGENT NEEDS:
- Architecture § Seam 5.
- The QA round monotonicity predicate reads the marker for the current round-N and refuses if absent or status != success. Wave 2 library implements this; this bead invokes it.
- `qa:round-N` label parsing pattern: same as in pipeline-labels.ts; do not duplicate.

RISK FLAGS:
- Watch for: marker filename ambiguity. QA marker filenames have shape `<epic-id>-qa-round-<N>.json`. The library's predicate must read the right filename pattern. If the library's PRECONDITION_TABLE for `qa-fix-and-retest` or `send-for-qa` checks the wrong filename, this bead's tests will pass on a stub but fail in production. Verify against a real marker fixture.

MARKER REQUIREMENTS:
- Standard marker.
- `what_was_tested`: cite the QA_ROUND_OUT_OF_ORDER test file:line.

COMMIT REQUIREMENTS:
- Single commit prefixed `beads_web-ehp.9:`.
- Subject: `beads_web-ehp.9: repeated-qa-round wraps act() with dispatch-preconditions`.
- Includes: rule modification + integration test + marker file.
