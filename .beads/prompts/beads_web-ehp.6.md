OUTCOME: Wrap `wave-bead-mismatch.ts`'s `act()` with precondition check BEFORE its existing label-rollback at line 142 and BEFORE the subsequent dispatch fetch. On refusal: log + emit `reconciler-action-refused` event + return WITHOUT rolling back labels and WITHOUT dispatching. Today's rule rolls back labels at line 142 BEFORE checking wave-bead existence — that's exactly the phantom-wave-4 redispatch loop in niii (28+ marker churn).

SCOPE:
- In: `act()` body modification; precondition check inserted BEFORE label rollback; refusal logging + event emission; HTTP 412 handling; new integration test file.
- Out: Any change to `match()` logic; any change to the rule's underlying decision about WHICH wave to roll back to (if dispatch is permitted).

FILES:
- src/lib/reconciler-rules/wave-bead-mismatch.ts (MODIFIED)
- NEW: __tests__/lib/reconciler-rules/wave-bead-mismatch.precondition-integration.test.ts

AC ITEMS TO VERIFY:
- niii phantom-wave-4 reproduction (epic at wave:4 but no `wave:4` open beads exist) → refusal with NO_WAVE_BEADS, NO label rollback occurs, NO dispatch fires.
- Happy path (mismatch genuinely needs reconciling AND beads exist for the corrected wave): existing rollback + dispatch behaviour is unchanged.
- Route returns 412 → log + return without throwing.

CONTEXT THE AGENT NEEDS:
- Architecture § Seam 5 + this rule's specific case at line 142 (rollback runs before existence check). The integration MUST place the precondition check BEFORE the rollback.
- Wave 1 BeadSnapshot.currentWave + DispatchContext.openWaveBeadIds are the relevant fields for the NO_WAVE_BEADS predicate.

RISK FLAGS:
- LOAD-BEARING: today's rule rolls back labels at line 142 BEFORE checking wave-bead existence. If the precondition check is placed AFTER the rollback, the no-side-effect contract of refusal is defeated AND this bead does not fix the niii phantom-wave-4 redispatch loop. Verify by integration test: refusal scenario MUST assert that labels were not mutated (compare pre- and post-state).
- Watch for: the rule's existing logic might compute the rollback-target wave AS PART OF deciding which precondition to check. If so, surface to operator — the rollback-target computation may need refactoring before the precondition check can run cleanly.

MARKER REQUIREMENTS:
- Standard marker.
- `what_was_tested`: explicitly cite the assertion that labels were not mutated on refusal — this is the load-bearing distinction from the broken pre-fix behaviour.

COMMIT REQUIREMENTS:
- Single commit prefixed `beads_web-ehp.6:`.
- Subject: `beads_web-ehp.6: wave-bead-mismatch gates rollback + dispatch on dispatch-preconditions`.
- Includes: rule modification + integration test + marker file.
