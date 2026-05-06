OUTCOME — phased:

Phase 1 (~20%): Audit. Walk the 38 case branches at `src/app/api/fleet/action/route.ts:526-2868`. Classify each as DISPATCHING (mutates `pipeline:*` labels OR launches an agent) or EXEMPT (only mutates `human-decision:*` labels OR sets observability flags OR stops a running agent — currently: stop-agent, human-approve, human-dismiss, possibly others; verify by code inspection, do not assume). STOP at this phase boundary; surface the audit list in the marker before proceeding to wrap.

Phase 2 (~70%): Wrap each DISPATCHING case at the TOP of its case body, BEFORE any label mutation or agent launch. Pattern: `const ctx = await buildDispatchContext({ epicId, repoPath: fleetCorePath, action, waveNumber }); const result = evaluatePreconditions(ctx); if (!result.ok) return NextResponse.json({ refused: true, action, epicId, refusalCode: result.refusalCode, failedCheck: result.failedCheck, reason: result.reason }, { status: 412 });`. Optionally factor into a small helper at the top of the file (must NOT change return semantics). Add a one-line `// EXEMPT per beads_web-ehp.11: <reason>` comment at the top of each EXEMPT case body.

Phase 3 (~10%): Tests. Extend existing route-test files (or add new tests if not present) covering the 412 refusal path for at least 5 representative cases: start-wave with no wave beads (NO_WAVE_BEADS); review-plan with no plan file (PLAN_FILE_MISSING); run-architect with success marker (ARCHITECT_MARKER_SUCCESS); send-for-qa with operator-decision-pending (OPERATOR_DECISION_PENDING); qa-fix-and-retest with QA_ROUND_OUT_OF_ORDER. Tests use real fixture shapes.

SCOPE:
- In: Wrapping all DISPATCHING cases; classifying + commenting EXEMPT cases; 5 representative test cases.
- Out: Modification of existing handler bodies BELOW the precondition wrapper; modification of input validation at lines 479-484 (VALID_ACTIONS — already exists); new action types; UI distinction between operator and reconciler dispatch (out-of-scope per operator NOTES point 4).

FILES:
- src/app/api/fleet/action/route.ts (MODIFIED)

AC ITEMS TO VERIFY:
- All DISPATCHING action cases call `buildDispatchContext` + `evaluatePreconditions` BEFORE label mutation or agent launch.
- HTTP 412 returned with structured body `{ refused: true, action, epicId, refusalCode, failedCheck, reason }` on refusal.
- No labels mutated on refusal; no agent launched.
- EXEMPT cases (stop-agent, human-approve, human-dismiss, plus any others identified in Phase 1) have a one-line comment citing this bead.
- 5 representative refusal test cases pass against real fixture shapes.
- Existing 200 OK paths preserved unchanged for happy paths (regression-test by running existing route test suite).

CONTEXT THE AGENT NEEDS:
- Architecture § Component Boundaries Contract 1 — the call shape and HTTP 412 body shape.
- Architecture § Failure modes Seam 4 — TOCTOU mitigation: place precondition check INSIDE the existing handler's pre-mutation block, AFTER any pre-existing reads (e.g., `await getEpicLabels(...)`) — re-using the same read primitives keeps the race window the same as today.
- The 38 cases enumerated by line: 526, 629, 782, 827, 844, 882, 926, 970, 1007, 1050, 1068, 1091, 1160, 1188, 1228, 1239, 1307, 1351, 1388, 1439, 1517, 1579, 1640, 1896, 1930, 1942, 1954, 1968, 2030, 2351, 2396, 2439, 2698, 2711, 2734, 2779, 2868. The classifier must walk all 38.

RISK FLAGS:
- Watch for: silent regression of existing 4xx/5xx response shapes. The wrapper inserts a 412 path; existing 4xx/5xx paths must remain unchanged. Run the existing route test suite after Phase 2 and before Phase 3 to catch shape drift.
- Watch for: classifying a dispatching case as exempt by mistake. If a case mutates `pipeline:*` labels OR launches an agent in any code path, it is dispatching. STOP and surface if classification is ambiguous; do not guess.
- Watch for: PRECONDITION_TABLE coverage gaps. If a dispatching action has NO entry in PRECONDITION_TABLE, evaluatePreconditions returns ok=true (nothing to fail). That's not a defect of THIS bead, but flag any such gap to the operator as FOLLOW-ON for the library bead.
- Watch for: the wrap helper introducing a new lock or a different read pattern. Architecture § Seam 4 explicitly requires re-using existing read primitives to keep the TOCTOU window unchanged.

MARKER REQUIREMENTS:
- Standard marker.
- `what_was_done`: per-case audit table (action | dispatching/exempt | wrapped/skipped | reason). 38 rows.
- `what_was_tested`: list which 5 representative cases were tested at the route level + which existing tests were preserved unchanged.
- `surprises_or_findings`: any case with ambiguous classification (was it surfaced to operator? what was the resolution?). Any PRECONDITION_TABLE gaps observed.

COMMIT REQUIREMENTS:
- Single commit prefixed `beads_web-ehp.11:`.
- Subject: `beads_web-ehp.11: route.ts wraps all 38 action handlers with dispatch-preconditions`.
- Includes: route.ts modification + test changes + marker file.
