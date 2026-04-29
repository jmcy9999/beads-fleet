# Reconciler Rules

Reference for the agent-lifecycle reconciler rules in `src/lib/reconciler-rules/`. The reconciler ticks every 10 seconds (per-rule throttles further constrain expensive rules), reads recent events from `<repoPath>/.beads/events.jsonl`, and fires actions via `/api/fleet/action`.

**Source map:** rule code under `src/lib/reconciler-rules/`; bootstrap and production wiring in `src/lib/reconciler-bootstrap.ts`; loop in `src/lib/reconciler.ts`.

---

## Rule registry

| Rule | Bead | Purpose |
|------|------|---------|
| `missed-wave-review-dispatch` | factory-core-lfcf.4 | Re-fire `review-wave` when an epic exited build-review without dispatching the reviewer. |
| `stuck-in-stage` | factory-core-zsjv.1 | Generic stage-stall detector. When `agent:running` is clear and no recent events for a known stage, fire the canned resume action. |
| `wave-bead-mismatch` | factory-core-zsjv.3 | Resync wave label when bead state has advanced beyond the wave label. |
| `repeated-qa-round` | factory-core-zsjv.5 | Escalate to coherence when QA rounds repeat without resolution. |
| `coherence-escalation` | factory-core-zsjv.4 | Dispatch the coherence agent when an epic is flagged `review:needs-human`. |
| `repeat-dispatch-escalation` | factory-core-zsjv.6 (+ 3p1e.10) | Escalate to coherence when `stuck-in-stage` has fired 3+ times for the same (epic, stage) without progress. Suppresses the escalation when the latest dispatch is actively progressing — see below. |
| `liveness-check` | factory-core-vy74.1 | Clear stale `agent:running` labels when no matching tmux session exists. |

---

## `repeat-dispatch-escalation` active-progress suppression (factory-core-3p1e.10)

The rule counts `reconciler-action-taken` events with `ruleName=stuck-in-stage` for each (epicId, stage) over a 1-hour rolling window. Three or more in the window meets the count threshold. Counting alone, however, does not prove "no progress": the FIRST two firings can legitimately be no-ops (e.g. blocked-on a `needs-decision` child bead) and the THIRD firing can succeed and launch a real builder that's actively streaming tokens. Escalating to coherence in that scenario races a live agent.

**Suppression contract.** Before emitting a coherence-escalation match, the rule consults an injected probe `probeActiveDispatch(epicId, stage)`. The probe returns `active=true` iff BOTH:

1. **Tmux session alive.** A tmux session whose name starts with `shipyard-<epicId>-<stage>-` is currently in `tmux list-sessions`. This is the canonical naming convention from `agent-launcher.ts`.
2. **Recent activity.** Either (a) the agent's JSONL transcript file's mtime is within the last 5 minutes (preferred — the transcript growing means the agent is emitting tokens), OR (b) the tmux session's `session_activity` timestamp is within the last 5 minutes.

When `active=true`:
- The rule logs `[zsjv.6] repeat-dispatch suppressed: <epicId> <stage> latest dispatch active (session=<name>, jsonl_mtime=<ts>)` (or `session_activity=<ts>` if the JSONL signal was unavailable).
- The rule emits a structured audit event of type `repeat-dispatch-suppressed` with payload `{ruleName, attemptCount, sessionName, jsonlMtime?, lastActivityAt?}` to the event log so suppression is auditable.
- The rule does NOT enqueue a coherence escalation match. Idempotency is unaffected: a future tick where the probe returns `active=false` will let the escalation proceed.

**Failure-safe.** Probe failures (thrown errors, unparseable timestamps) degrade to "no signal" — the rule proceeds to escalate as before. This means a probe defect cannot accidentally suppress a real escalation. Append-event failures are logged but do not block the suppression itself.

**Production wiring.** `reconciler-bootstrap.ts` binds:
- `listTmuxSessions` to the per-tick cached `tmux list-sessions` output (5s TTL via `listTmuxSessionsCached`),
- `getTmuxSessionActivitySec` to `tmux display-message -p -t <session> '#{session_activity}'`,
- `findLatestJsonlMtimeMs` to a scan of `~/.claude/projects/<safeCwd>/*.jsonl` (gated by directory mtime to bound cost).

Tests at `__tests__/lib/repeat-dispatch-escalation.test.ts` cover: 3-events + active-true → no escalation + suppression event emitted; 3-events + active-false → escalation fires; probe-throws → degrade-to-escalate; appendSuppressedEvent-throws → suppression unaffected. Probe unit tests live in the same file (`describe("probeActiveDispatch …")`) and cover prefix matching, multi-session selection, and exact-prefix epicId discrimination (`e1` vs `e10`).
