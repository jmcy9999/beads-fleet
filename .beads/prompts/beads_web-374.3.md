OUTCOME: Implement `deriveMarkerCtaIntent(marker, snapshot, currentStage): MarkerCtaIntent` as a pure TS function in `src/lib/derive-marker-cta-intent.ts`, defining the `MarkerCtaIntent` discriminated union (4 cases). REUSE `interpretMarkerForRouting` (do NOT duplicate the precedence rule). Tests in `__tests__/lib/derive-marker-cta-intent.test.ts` cover all 5 precedence branches AND each `MarkerCtaIntent` kind.

SCOPE:
- In: `MarkerCtaIntent` type; `deriveMarkerCtaIntent` function; helpers (BLOCKER-line extraction from `whats_open`; failure-stage→re-run-action mapping); tests.
- Out: any React rendering (374.5 owns it); any I/O; any precedence-rule re-implementation (REUSE the shipped function per ADR-001).

FILES:
- NEW: src/lib/derive-marker-cta-intent.ts
- NEW: __tests__/lib/derive-marker-cta-intent.test.ts

AC ITEMS TO VERIFY:
- All 5 precedence branches from `interpretMarkerForRouting` are exercised AND produce the correct `MarkerCtaIntent` kind:
  1. `next_agent: <agent>` (explicit) → `{ kind: "marker-driven", nextAgent, action, reason }`.
  2. `status: blocked + blocker_class: design-question` → `{ kind: "needs-decision", coherenceAction: "run-coherence-agent", blockerMessage }`.
  3. `status: blocked + blocker_class: <other>` → `{ kind: "marker-driven" }` with the agent from the blocker-class table.
  4. `status: needs-decision + BLOCKER:` → `{ kind: "needs-decision", blockerMessage: <first BLOCKER line> }`.
  5. `status: success + no next_agent` → `{ kind: "default" }`.
  6. `status: failure` → `{ kind: "failure", stage: marker.stage, action, recommendation, reason }`.
- `marker === null` → `{ kind: "default" }`.
- TypeScript exhaustive switch via `never` type guard (no `default:` swallow — regression #7).
- Tests pass against in-memory `MarkerData` fixtures (no fs, no network).

CONTEXT THE AGENT NEEDS:
- Architect doc § Data Model defines the `MarkerCtaIntent` union shape. Read before defining the type.
- ADR-001 (in architect doc) is the structural rule: REUSE `interpretMarkerForRouting`. Do NOT write a second precedence rule. The dashboard becomes a third caller alongside `dispatchChainAction` and the `marker-driven-routing.ts` reconciler rule.
- ADR-004 (in architect doc) is why this is a separate file from the component — testability + separation of computation from JSX (regression #5).
- `src/lib/marker-routing.ts:104` exports `interpretMarkerForRouting`. Read its full implementation before writing the post-process logic. The 5 precedence rules are at lines 104-202.
- `src/lib/agent-action-map.ts:31` exports `getActionForAgent`. Use for the failure-stage→action mapping.

RISK FLAGS:
- Watch for re-implementing the precedence rule in this file. The structural defence against bead-description failure mode #1 ("dashboard shows happy-path → operator clicks → wrong dispatch fires") is that the dashboard and orchestrator call the SAME function. If you find yourself writing `if (marker.status === "blocked" && marker.blocker_class === ...)` you are duplicating the rule — STOP and refactor to call `interpretMarkerForRouting` instead.
- Watch for forgetting the `marker === null` case. The hook returns null when stale or missing; a non-null check at the top of `deriveMarkerCtaIntent` is required.
- The `failure` case requires mapping `marker.stage` to a re-run action. Verify `getActionForAgent` accepts the FleetStage values that appear in `marker.stage` — if the stage is something unusual (e.g., `polish`), the mapping may need a special case. STOP and surface if you can't find a clean mapping.

MARKER REQUIREMENTS:
- Standard marker.
- Document under `surprises_or_findings` if any precedence branch in `interpretMarkerForRouting` does NOT have a corresponding test case here — gap means AC #6 of the bead description is not fully satisfied.

COMMIT REQUIREMENTS:
- Single commit prefixed `beads_web-374.3: `.
- Subject: `beads_web-374.3: deriveMarkerCtaIntent pure function + MarkerCtaIntent union`.
- Co-Authored-By trailer.
