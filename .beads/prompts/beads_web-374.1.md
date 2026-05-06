OUTCOME: Implement two pure TypeScript utilities — `deriveMarkerId(epicId, stage, qaRound?): string` and `mapFleetStageToMarkerStage(stage: FleetStage): string` — in `src/lib/derive-marker-id.ts`, with a vitest test file in `__tests__/lib/derive-marker-id.test.ts`. No React, no fs, no fetch.

SCOPE:
- In: the two functions; the canonical FleetStage→marker-stage mapping table; tests covering every FleetStage value plus the QA-round special case.
- Out: any consumer wiring (374.4 will consume); any I/O; any React hook.

FILES:
- NEW: src/lib/derive-marker-id.ts
- NEW: __tests__/lib/derive-marker-id.test.ts

AC ITEMS TO VERIFY:
- QA + qaRound=N → `<epicId>-qa-round-<N>`.
- QA without qaRound → `<epicId>-qa`.
- `plan-review` → `<epicId>-planner` (plan-review is a dashboard column name; the writing agent is the planner).
- `product-spec` → `<epicId>-product-manager`.
- `architecture` → `<epicId>-architect`.
- All other FleetStage values map per the canonical table — verify each one against an existing marker filename in `<repoPath>/.beads/markers/` or the agent-action-map. Do NOT invent new mappings.
- Exhaustive coverage via TypeScript `never` type guard (regression #7); compile fails if a FleetStage value is missing.
- Tests run as plain TS under vitest, no jsdom, <100ms total.

CONTEXT THE AGENT NEEDS:
- Architect document at `docs/research/marker-aware-ctas-in-fleetcard-bead-card-architecture.md` § Data Model defines the mapping table.
- `agent-launcher.ts:2017-2020` is the canonical precedent for the QA-round filename — verify your code mirrors it.
- `marker-protocol.md` § 1 documents the filename convention. Read before coding.
- `src/components/fleet/fleet-utils.ts:8` defines the `FleetStage` union — import that type, do not redefine it.

RISK FLAGS:
- The mapping for `build-review` and `test-spec` is non-obvious. Search `.beads/markers/` for existing filenames written by the reviewer-stage-1/2/3 agents to confirm the suffix. If unclear, STOP and surface to operator before guessing — a wrong mapping silently produces "marker missing" results downstream.
- Do NOT write a `default:` case in the switch. The `never` type guard is the architectural defence against future enum drift (regression #7). A `default:` swallows missing cases at compile.

MARKER REQUIREMENTS:
- Standard marker per `standards/generic/marker-protocol.md`.
- If any FleetStage value resists mapping (no existing marker filename to mirror), document under `surprises_or_findings` as MAPPING-AMBIGUITY with the stage name and what you guessed.

COMMIT REQUIREMENTS:
- Single commit prefixed `beads_web-374.1: `.
- Subject: `beads_web-374.1: deriveMarkerId pure utility + FleetStage→marker-stage mapping`.
- Co-Authored-By trailer.
