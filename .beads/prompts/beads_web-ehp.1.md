OUTCOME: Create `src/lib/bead-status-reader.ts` (~25 lines) — a thin async wrapper around the `bd show <id> --json` invocation pattern that returns a typed `BeadSnapshot` value object (id, status, labels, type, plus derived fields: pipelineStage, currentQaRound, currentWave, hasAgentRunning, hasReviewNeedsHuman) or `null` on any failure mode (binary missing, exit non-zero, JSON parse failure, schema mismatch). Plus thorough unit tests against fixtures matching the real `bd show --json` output shape.

SCOPE:
- In: BeadSnapshot type definition; readBeadStatus(beadId, repoPath) async function; failure-mode handling matching `reconciler-bootstrap.ts:626-628` convention; derived field computation from labels.
- Out: ANY caller integration (Wave 2 library consumes this; Wave 3 rule integrations downstream); modification to existing `reconciler-bootstrap.ts:611-628` inline call site.

FILES:
- NEW: src/lib/bead-status-reader.ts
- NEW: __tests__/lib/bead-status-reader.test.ts

AC ITEMS TO VERIFY:
- Happy path: bd show --json returns fully-populated BeadSnapshot.
- Failure modes (binary missing, non-zero exit, malformed JSON, partial output) → returns null without throwing.
- Derived fields: pipeline:* label → pipelineStage; agent:running label → hasAgentRunning; qa:round-N label → currentQaRound (max); wave:N label → currentWave (lowest open); review:needs-human → hasReviewNeedsHuman.
- BeadSnapshot.status mirrors bd's enum: `open | in_progress | blocked | closed | deferred`.
- Tests use a recorded fixture from a real `bd show --json` invocation (not a hand-written fictional shape).

CONTEXT THE AGENT NEEDS:
- Existing inline pattern at `src/lib/reconciler-bootstrap.ts:611-628` is the precedent — read it for the spawn shape and timeout (~15s).
- This is the Infrastructure layer per architecture doc § Layer Mapping. No business logic.
- Architecture doc § Persistence Strategy: no caching; each call is a fresh bd read.

RISK FLAGS:
- Watch for: JSON parse failure when bd returns a partial or empty payload (per architecture § Failure modes Seam 1). STOP and surface if real bd output diverges from the documented shape — do not fabricate fields. Architecture ADR-002 is load-bearing on this reader returning null cleanly.
- Watch for: SQLite/Dolt-driver quirks where label arrays come back as a comma-joined string vs JSON array. Use a real bd --json fixture; if the parse fails, document the actual shape observed and surface to operator before working around.

MARKER REQUIREMENTS:
- Standard marker per `standards/generic/marker-protocol.md`.
- `what_was_tested`: explicitly list which failure modes were exercised (binary missing, malformed JSON, partial output, deferred status, closed status).
- `surprises_or_findings`: if `bd show --json` shape differs from architecture doc's documented BeadSnapshot fields, document the actual shape and how the reader was adapted.

COMMIT REQUIREMENTS:
- Single commit prefixed `beads_web-ehp.1:`.
- Subject: `beads_web-ehp.1: bead-status-reader.ts thin wrapper for dispatch precondition library`.
- Includes: source file + test file + marker file (per standards/generic/marker-protocol.md § 1 marker-write-ordering).
