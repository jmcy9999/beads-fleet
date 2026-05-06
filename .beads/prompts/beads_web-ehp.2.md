OUTCOME: Add a new variant `reconciler-action-refused` to the `PipelineEvent` discriminated union in `src/lib/event-log.ts`, with structured fields (epicId, ruleName, action, refusalCode, failedCheck, reason, correlationId, at). Pure additive change — no existing variants altered. Plus tests verifying the variant can be recorded, serialised, and read back without breaking existing event filters.

SCOPE:
- In: New event-log variant + serialisation parity with `reconciler-action-taken` shape; ensure recordEvent / appendEvent accept the new variant; unit tests for record + read round-trip.
- Out: Emitting the event from any rule's `act()` (Wave 3 rule-integration beads own that); idempotency-window logic in `reconciler.ts` (architecture ADR-006 notes 15-min bucketing as a downstream concern); dashboard rendering.

FILES:
- src/lib/event-log.ts (MODIFIED)
- __tests__/lib/event-log.test.ts (MODIFIED)

AC ITEMS TO VERIFY:
- Existing filter `e.type === "reconciler-action-taken"` (e.g., at `stuck-in-stage.ts:122`) continues to work unchanged — verify by running the existing event-log test suite.
- TypeScript exhaustiveness checks at switch sites compile cleanly without modification (additive variant per ADR-006).
- The new event records correctly via existing event-log writer; round-trip through JSONL preserves all fields including the discriminant.
- Filter `e.type === "reconciler-action-refused"` reads only the new variant, not the existing `reconciler-action-taken` events.

CONTEXT THE AGENT NEEDS:
- Architecture ADR-006: NEW event type, NOT a flag on existing `reconciler-action-taken`. Single Responsibility — `reconciler-action-taken` semantically means dispatch fired; do not muddy.
- Existing event-log shape is JSONL; reuse the existing serialisation helper.

RISK FLAGS:
- Watch for: TypeScript exhaustiveness checks failing in switch statements that case over PipelineEvent variants. If any switch becomes non-exhaustive, that's a downstream consumer that must add a no-op branch for the new variant. Locate every such switch via grep and add minimal no-op handling — do NOT silently change downstream behaviour.
- Watch for: refusalCode coupling. Wave 2 library (beads_web-ehp.3) defines the canonical RefusalCode enum. This bead's tests should reference RefusalCode strings as plain string literals (e.g., "BD_STATUS_DEFERRED") to avoid forward-coupling to the unbuilt library.

MARKER REQUIREMENTS:
- Standard marker.
- `what_was_done`: list every grep-discovered switch site that cases over PipelineEvent and how each was handled (added branch / already-exhaustive / no-op-fallthrough). Evidence = file path + line number for each.

COMMIT REQUIREMENTS:
- Single commit prefixed `beads_web-ehp.2:`.
- Subject: `beads_web-ehp.2: event-log adds reconciler-action-refused variant`.
- Includes: source + test changes + marker file.
