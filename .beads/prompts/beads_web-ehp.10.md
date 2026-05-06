OUTCOME: Wrap the inline marker-routing branch inside `dispatchChainAction` at `agent-launcher.ts:~2055` (the `if (routingDecision.override && routingDecision.nextAgent)` block) with `buildDispatchContext` + `evaluatePreconditions` BEFORE the `fetch(getDefaultActionUrl(), …)` call. On refusal: log + record `reconciler-action-refused` event + `return false` (preserves existing fall-through semantics).

SCOPE:
- In: inline-branch precondition wrap inside `dispatchChainAction`; refusal log + event emission; HTTP 412 handling; tests covering refusal + happy-path + 412.
- Out: ANY change to per-stage branches BELOW the inline override block (those route through route.ts and beads_web-ehp.11 covers them); ANY change to `handleChainAction` itself or its caller signature.

FILES:
- src/lib/agent-launcher.ts (MODIFIED)

AC ITEMS TO VERIFY:
- Inline-branch dispatch with `routingDecision.override && routingDecision.nextAgent` set, but bead is `status=deferred` → refusal with BD_STATUS_DEFERRED, function returns `false` (existing fall-through path preserved).
- Happy path inline dispatch: behaviour unchanged AND function returns existing truthy value.
- Route returns 412 → log + return false without throwing.
- Tests added or extended in `__tests__/lib/agent-launcher.test.ts` (or one of the `agent-launcher.*` test files that already covers `dispatchChainAction`) covering refusal + happy-path + 412.

CONTEXT THE AGENT NEEDS:
- Architecture § Component Boundaries Contract 3 — the call shape inside the inline override block.
- `dispatchChainAction` is shared infrastructure with multiple branches. The PRECONDITION wrap goes ONLY inside the `routingDecision.override && routingDecision.nextAgent` branch; per-stage branches are out of scope (route.ts integration covers them indirectly).

RISK FLAGS:
- Watch for: breaking existing per-stage branches below the inline block. Test discipline: do NOT rewrite the function; insert the precondition wrap surgically inside the override branch only. Existing tests for per-stage branches must continue to pass unchanged.
- Watch for: return-value semantics. `dispatchChainAction` returns `false` from the override branch when the dispatch did NOT fire (existing semantics). Refusal preserves this — log + return false.
- Watch for: this is the THIRD dispatch site. Skipping or under-covering this site re-opens a phantom-dispatch surface invisible to route.ts and reconciler-rules tests.

MARKER REQUIREMENTS:
- Standard marker.
- `what_was_tested`: explicitly list which existing `agent-launcher.*` test files were extended vs which ran unchanged.

COMMIT REQUIREMENTS:
- Single commit prefixed `beads_web-ehp.10:`.
- Subject: `beads_web-ehp.10: dispatchChainAction inline branch wraps with dispatch-preconditions`.
- Includes: agent-launcher.ts modification + test changes + marker file.
