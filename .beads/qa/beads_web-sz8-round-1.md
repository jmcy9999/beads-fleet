# QA Report: beads_web (Fleet Action Prompt Fixes) — Round 1

## Summary
- **Flows verified:** 10 (all actions in design scope)
- **Personas verified:** 2 (manual Dashboard user, auto-chain pipeline)
- **Bugs filed:** 2 (P0: 0, P1: 1, P2: 1)
- **Verdict:** FAIL

## Flow Verification Results

### start-research
- **Status:** PASS
- **State transitions verified:** Labels added (pipeline:research, agent:running), status updated to in_progress
- **Agent config:** agentName="research", ship type in prompt, WebSearch in tools
- **Issues:** None

### more-research
- **Status:** PASS
- **State transitions verified:** Labels removed (research-complete, plan:pending, plan:approved), added (pipeline:research, agent:running)
- **Agent config:** agentName="research", ship type in prompt, feedback included when provided
- **Issues:** None

### generate-plan
- **Status:** PASS
- **State transitions verified:** Labels added (pipeline:research-complete, agent:running)
- **Agent config:** agentName="planner", entry point "from-research", ship type in prompt
- **Issues:** None

### skip-to-plan
- **Status:** PASS
- **State transitions verified:** Labels added (pipeline:research-complete, agent:running), status updated to in_progress
- **Agent config:** agentName="planner", entry point "from-candidates", "No recon brief" in prompt
- **Issues:** None

### revise-plan
- **Status:** PASS
- **State transitions verified:** Labels removed (plan:approved, plan:pending), added (agent:running)
- **Agent config:** agentName="planner", entry point "revise-plan", feedback included when provided
- **Issues:** None

### revise-plan-from-launch
- **Status:** PASS
- **State transitions verified:** Labels removed (pipeline:submission-prep), added (pipeline:research-complete, agent:running)
- **Agent config:** agentName="planner", entry point "revise-plan", feedback included when provided
- **Issues:** None

### send-for-development
- **Status:** PASS
- **State transitions verified:** Labels removed (research-complete, plan:pending, plan:approved), added (pipeline:development, agent:running)
- **Agent config:** No agentName (correct per design), ship type in prompt
- **Issues:** None

### approve-and-build
- **Status:** PASS
- **State transitions verified:** Labels removed (research-complete, plan:pending), added (plan:approved, pipeline:development, agent:running)
- **Agent config:** No agentName (correct per design), ship type in prompt, feature scope handling
- **Issues:** None

### send-for-qa
- **Status:** PASS (when invoked from Dashboard with currentLabels)
- **State transitions verified:** QA round detection from labels, labels removed/added correctly
- **Agent config:** Platform-specific QA agent selection (ios-app -> platforms/ios/qa, macos-app -> platforms/macos/qa, others -> qa)
- **Issues:** beads_web-4ju (P1 — when auto-chained, ship type defaults to ios-app)

### qa-fix-and-retest
- **Status:** PASS
- **State transitions verified:** Labels removed (pipeline:qa), added (pipeline:development, agent:running)
- **Agent config:** No agentName (correct per design), pipelineStage="qa-fixes"
- **Issues:** None

## Persona Verification Results

### Dashboard User (manual action)
- **Path:** Click action button -> POST /api/fleet/action with currentLabels from epic -> ship type extracted from labels -> correct agent launched
- **Status:** PASS
- **Issues:** None

### Auto-Chain Pipeline (automated transitions)
- **Path:** Agent exits -> handleChainAction -> fetch /api/fleet/action WITHOUT currentLabels -> ship type defaults to "ios-app"
- **Status:** FAIL
- **Issues:** beads_web-4ju — All five chain action fetch calls in agent-launcher.ts (lines 199, 221, 243, 286, 306) omit currentLabels, causing ship type to default to "ios-app" for all non-iOS products

## Common Pitfall Checks
- [x] No hardcoded credentials (CLAUDE_BIN path is a local tool path, not a credential)
- [x] Error handling present (try/catch in all action handlers, route.ts:608-614)
- [x] No infinite loops (QA round capped at 3 in agent-launcher.ts:278)
- [x] No race conditions (single agent per repo enforced in launchAgent)
- [x] Configuration externalized (fleet-core path resolved from repo config)
- [x] Logging present (console.error on failures in chain actions)
- [x] Edge cases handled (empty labels array, missing feedback, missing currentLabels)

## Platform-Specific Checks (Internal)
- [x] Test suite passes: 749/749 tests pass (40 suites)
- [ ] Fleet board visual check: Not performed (static analysis only)
- [ ] Pipeline flow check: Not performed (static analysis only)
- [x] No console errors in code paths (error handling wraps all external calls)

## Bugs Filed
| ID | Priority | Description |
|----|----------|-------------|
| beads_web-4ju | P1 | Auto-chain actions in agent-launcher.ts omit currentLabels, defaulting ship type to ios-app for all chained pipeline stages. Affects QA agent selection for non-iOS products. |
| beads_web-dex | P2 | Missing test coverage for send-for-qa, qa-fix-and-retest, and approve-and-build — 3 of 10 in-scope actions have zero tests. |
