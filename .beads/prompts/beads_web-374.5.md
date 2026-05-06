OUTCOME — phased:

Phase 1 (~40%): Build `MarkerAwareCtaBlock.tsx` against mocked hook + mocked dispatch. All four `intent.kind` branches render correctly. Component-level tests pass. STOP at end of phase; surface progress in marker before proceeding.

Phase 2 (~40%): Integrate ADDITIVELY into `FleetCard.tsx`. Existing `FleetCard.attention.test.tsx` still passes unmodified. Integration tests cover the 5 precedence branches end-to-end via FleetCard.

Phase 3 (~20%): Verify `next build` succeeds with no Edge Runtime errors. The integration test suite must exercise the full module graph so any inadvertent `fs` import in the React tree fails the build. STOP if the build fails — do NOT mask the failure with type-only patches without understanding the import chain.

SCOPE:
- In: `MarkerAwareCtaBlock.tsx` (new ~150 lines); FleetCard.tsx (modified ADDITIVELY ~25 new lines, no removals); component unit tests; FleetCard integration tests.
- Out: per-bead marker reads (out of scope per ADR-006); marker schema changes; reconciler-side changes; niii.6 "Close Epic" button (sequence after this bead — see plan summary).

FILES:
- NEW: src/components/fleet/MarkerAwareCtaBlock.tsx
- MODIFIED: src/components/fleet/FleetCard.tsx
- NEW: __tests__/components/MarkerAwareCtaBlock.test.tsx
- NEW: __tests__/components/FleetCard.marker-aware.test.tsx

AC ITEMS TO VERIFY:
- Phase 1 — component renders correctly per `intent.kind`:
  - `marker-driven`: primary CTA + 10×10 inline marker badge before action text + tooltip = intent.reason.
  - `needs-decision`: amber-bordered amber-tinted banner + BLOCKER message inline + "Run coherence" button dispatching `run-coherence-agent`.
  - `failure`: orange/red-tinted banner + recommendation text inline + "Re-run <stage>" button dispatching `intent.action`.
  - `default`: returns `null` (FleetCard's existing CTAs render).
  - Switch is exhaustive via `never` type guard; no `default:` swallow (regression #7).
- Phase 2 — FleetCard integration:
  - Existing FleetCard.attention.test.tsx passes unmodified.
  - Epic without a marker → existing default CTAs render, no new visual elements.
  - a6o-defence: epic with multiple `pipeline:*` labels + marker for stage X → marker-driven CTA renders.
  - All 5 precedence branches covered end-to-end (epic+marker fixture → FleetCard render → CTA visible) per AC #6 of bead description.
  - Marker-driven CTA click → `onPipelineAction` fires with action name from `agent-action-map.ts` AGENT_ACTION_MAP (no fabricated names).
- Phase 3 — build verification:
  - `next build` succeeds.
  - No fs imports leak into the React tree (per architect Watch-fors, ADR-002, regression beads_web-8wh).

CONTEXT THE AGENT NEEDS:
- Architect ADR-003 (single component for three visual states) and ADR-007 (badge inline, not banner) define the rendering rules.
- `__tests__/components/FleetCard.attention.test.tsx` is the precedent for FleetCard tests + RTL mocking patterns. Mirror it.
- `src/components/fleet/AttentionBanner.tsx` is the visual reference for amber styling — COPY the Tailwind classes, do NOT import the component.
- `src/components/fleet/FleetCard.tsx` is currently 1192 lines. Adding ~25 lines is acceptable; this bead does NOT refactor FleetCard. (A FleetCard decomposition would be a separate epic; per `code-principles.md` file-length warning at 500 / error at 1000, FleetCard is already over the error threshold. Do NOT use 374.5 to refactor — out of scope.)
- 374.3's `MarkerCtaIntent` discriminated union drives the switch. 374.4's `useEpicMarker` provides the marker data. Both must be merged before this bead starts.
- `onPipelineAction` callback already exists on FleetBoard — reuse the existing `PipelineActionPayload` shape.
- `agent-action-map.ts` AGENT_ACTION_MAP is the source of truth for valid action names. The dispatcher rejects unknown actions; verify every dispatched name against the map.

RISK FLAGS:
- Watch for the Edge Runtime trap. `next build` is the gate, not vitest. If you import `marker-reader.ts` for runtime (anywhere in the React tree's import graph, even transitively), the build fails. Use `import type { MarkerData }` syntax. STOP and surface if the build fails after Phase 2 — diagnose the import chain before patching.
- Watch for FleetCard merge conflicts with `beads_web-5nv` (P3, populate pipeline-routes CTAs). 374.5 is the only 374-bead touching FleetCard.tsx. If 5nv has shipped first, rebase carefully; if it hasn't, document in marker for 5nv's planner to coordinate.
- Watch for fabricating action names. The amber "Run coherence" button MUST dispatch `run-coherence-agent` exactly (verify the string exists in AGENT_ACTION_MAP). The "Re-run <stage>" failure button must use `getActionForAgent(intent.stage)` — do NOT hardcode action names.
- Watch for breaking existing FleetCard.attention.test.tsx. The integration is ADDITIVE only. If the existing test fails, the integration is wrong — STOP and revert before continuing.
- Watch for niii.6 scope creep. Per operator preference (2026-05-06), niii.6 sequences AFTER 374.5; it is NOT folded in. If you find yourself adding a "Close Epic" button to MarkerAwareCtaBlock, STOP — that's niii.6 territory.

MARKER REQUIREMENTS:
- Standard marker.
- Document under `surprises_or_findings` if you found any architectural issue with the underlying 374.3/374.4 contracts during integration (these are signs that the dependency beads were under-spec'd).
- Document under `whats_open` as FOLLOW-ON if any phase's verification was not run (e.g., `next build` skipped because of time pressure).

COMMIT REQUIREMENTS:
- Single commit prefixed `beads_web-374.5: `.
- Subject: `beads_web-374.5: MarkerAwareCtaBlock + FleetCard integration`.
- Co-Authored-By trailer.
