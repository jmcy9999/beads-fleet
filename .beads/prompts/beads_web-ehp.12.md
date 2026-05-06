OUTCOME: Add an end-to-end reproduction test (`__tests__/integration/niii-phantom-dispatch-reproduction.test.ts`) that replays each of the 6 phantom-dispatch scenarios from the epic description against a real (test-fixture) bd repo + marker dir + reconciler tick. Each scenario MUST refuse at precondition with no label mutation and no agent launch. This is the load-bearing AC of the entire epic.

SCOPE:
- In: One self-contained integration test file with 6 scenario fixtures + assertions.
- Out: Modification of any other test file; live re-run of the actual niii pipeline (reproduction is via fixture-replay).

FILES:
- NEW: __tests__/integration/niii-phantom-dispatch-reproduction.test.ts

AC ITEMS TO VERIFY (all 6 scenarios):
1. Premature planner pass-2 (e35f4a6): refusal occurs; no dispatch; document actual refusalCode.
2. Premature reviewer pass-2 (cc5a086): refusal; no dispatch; document refusalCode.
3. Builder Wave 3 (8d41251) — all wave:3 beads closed: refusal with ALL_WAVE_BEADS_CLOSED (or NO_WAVE_BEADS); no dispatch.
4. Phantom Wave 4 (a633c66) — no wave:4 beads exist: refusal with NO_WAVE_BEADS; no dispatch.
5. Reviewer-4-wave-4-redundant: refusal (NO_WAVE_BEADS or ALL_WAVE_BEADS_CLOSED); no dispatch.
6. niii.5 reviewer-code-no-op (bead not built): refusal; document actual refusal class.

For each: assert (a) refusal occurred, (b) `result.ok === false`, (c) refusalCode is one of the canonical RefusalCode enum values, (d) ZERO label mutations, (e) ZERO agent launches, (f) `reconciler-action-refused` event recorded with structured fields.

CONTEXT THE AGENT NEEDS:
- The 6 scenarios are documented in the epic description (`bd show beads_web-ehp`).
- All Wave 1/2/3 beads MUST be merged before this bead can verify end-to-end. If any are absent, the test will produce false positives (refusals from wrong reasons) or false negatives (dispatches still firing).
- Test fixtures: build real-shape bd snapshot + real-shape marker file + real-shape plan file (or absence thereof, per scenario). Use the same fixture shapes as the per-rule integration tests (Wave 3 beads).
- Use real (not stubbed) instances of `dispatch-preconditions.ts` library + integrated rule modules + integrated route handler.

RISK FLAGS:
- LOAD-BEARING: this bead is the proof-of-completion for the whole epic. If any scenario still fires a dispatch after Wave 1-3 land, STOP and surface — do NOT document degradation, do NOT skip the scenario.
- Watch for: scenario 6 (niii.5 reviewer-code-no-op) may not have a single canonical refusalCode in v1 PRECONDITION_TABLE. Document the actual refusal observed; if refusal is "the dispatch did not fire because of an unrelated precondition", that is acceptable as long as no dispatch fires. Primary assertion is no-side-effect; secondary is structured refusal logged.
- Watch for: brittle assertions on specific refusalCode values. Tests should assert refusalCode ∈ canonical enum, not specific code === "FOO" — the PRECONDITION_TABLE may evolve (new predicates, ordering changes); the load-bearing claim is "no dispatch fired", not "this exact code fired".

MARKER REQUIREMENTS:
- Standard marker, status `success` ONLY if all 6 scenarios refuse cleanly.
- If any scenario still fires a dispatch, status `needs-decision` with `next_agent=operator`, BLOCKER in `whats_open` listing the scenario(s) that did not refuse.
- `what_was_tested`: per-scenario summary — refusal class observed, where refusal occurred (rule's act() vs route 412), event-log entry recorded yes/no.
- `recommendation_for_next`: if all 6 pass, recommend epic close. If not, recommend follow-on bead for the failing scenario(s).

COMMIT REQUIREMENTS:
- Single commit prefixed `beads_web-ehp.12:`.
- Subject: `beads_web-ehp.12: end-to-end niii phantom-dispatch reproduction tests`.
- Includes: test file + marker file.
