# QA Report: beads_web Repo Path Resolver — Round 1

## Summary
- **Flows verified:** 11
- **Personas verified:** 3 (venture, internal, product)
- **Bugs filed:** 0 (P0: 0, P1: 0, P2: 0)
- **Verdict:** PASS

## Flow Verification Results

### send-for-development
- **Status:** PASS
- **State transitions verified:** Hardcoded path replaced with resolveRepoPath; repoPath/repoName/researchPath/planPath all sourced from resolver; prompt uses resolved paths
- **Issues:** None

### send-back-to-dev
- **Status:** PASS
- **State transitions verified:** resolveRepoPath replaces hardcoded path; feedback handling preserved in feedbackStr2; prompt includes resolved researchPath
- **Issues:** None

### generate-plan
- **Status:** PASS
- **State transitions verified:** resolveRepoPath replaces hardcoded path; researchPath included in prompt; agentName "planner" preserved
- **Issues:** None

### approve-plan
- **Status:** PASS (no path resolution needed, label-only action)
- **Issues:** None

### approve-and-build
- **Status:** PASS
- **State transitions verified:** resolveRepoPath replaces hardcoded path; feature approval JSON reads from repoPath/.beads/plans/<id>.approval.json (correct); approved/rejected/deferred feature filtering preserved; featureScopeNote appended to prompt
- **Issues:** None

### revise-plan
- **Status:** PASS
- **State transitions verified:** resolveRepoPath replaces hardcoded path; feedback handling preserved; agentName "planner" preserved
- **Issues:** None

### skip-to-plan
- **Status:** PASS
- **State transitions verified:** resolveRepoPath replaces hardcoded path; "from-candidates" entry point preserved; "No recon brief" message preserved
- **Issues:** None

### revise-plan-from-launch
- **Status:** PASS
- **State transitions verified:** resolveRepoPath replaces hardcoded path; feedback handling preserved; "revise-plan" entry point preserved
- **Issues:** None

### send-for-qa
- **Status:** PASS
- **State transitions verified:** resolveRepoPath replaces hardcoded path; QA round counting logic preserved (label parsing via split("-")[1]); extractAppName fallback preserved; platform-specific QA agent selection preserved
- **Issues:** None

### qa-fix-and-retest
- **Status:** PASS
- **State transitions verified:** resolveRepoPath replaces hardcoded path; extractAppName fallback preserved; prompt includes researchPath and planPath
- **Issues:** None

### start-research (NOT CHANGED)
- **Status:** PASS
- **Verified:** Does not appear in git diff. Correctly hardcodes fleetCorePath as the repo. No research path reference needed (first research has no previous report).
- **Issues:** None

### more-research (CHANGED — correctly fixed via beads_web-6hz)
- **Status:** PASS
- **Verified:** The research path prompt was updated from hardcoded `products/${appName}/research/report.md` to `resolveRepoPath().researchPath`. The agent still correctly launches in fleet-core (research always runs in fleet-core). Only the prompt's "Previous research at" path was fixed to handle ventures (docs/research/<topic>.md) and internal epics.
- **Issues:** None

## Persona Verification Results

### Venture epic (e.g., "LensCycle Opportunity")
- **Path:** resolveRepoPath("venture", ...) -> fleet-core repo, docs/research/<topic>.md, no planPath
- **Status:** PASS
- **Issues:** None

### Internal epic targeting beads_web (e.g., "Dashboard: Add resolver")
- **Path:** resolveRepoPath("internal", ...) -> /dev/claude_projects/beads_web, research in fleet-core, plan in beads_web
- **Status:** PASS
- **Issues:** None

### Product epic (e.g., "LensCycle: Contact lens tracker" with ios-app)
- **Path:** resolveRepoPath("ios-app", ...) -> /dev/claude_projects/LensCycle, research at fleet-core/products/LensCycle/research/report.md, plan at product repo
- **Status:** PASS
- **Issues:** None

## Test Suite Results
- **41 test suites, 764 tests — ALL PASS**
- **repo-path-resolver.test.ts:** 11 tests covering sanitizeTopicName (4 tests) + resolveRepoPath for all 8 ship types (7 test blocks covering venture, internal x4 variants, ios-app, macos-app, web-app, wordpress-plugin, python-tool, game)

## Common Pitfall Checks
- [x] No hardcoded credentials
- [x] Error handling present (try/catch around JSON parse, fs.readFile, all agent launches)
- [x] No infinite loops
- [x] No race conditions
- [x] Configuration externalized (FLEET_CORE_PATH as constant, fleet-core path resolved from repo config)
- [x] Logging present (console.error in catch blocks)
- [x] Edge cases handled (empty labels array defaults, missing approval file caught, QA round defaults to 1)

## Platform-Specific Checks (Internal)
- [x] Test suite passes (764/764)
- [x] No hardcoded product paths remain in route.ts (verified via grep)
- [x] All 8 ship types covered in resolver tests
- [x] start-research untouched; more-research correctly fixed for research path resolution

## Bugs Filed
None.

## Hardcoded Path Elimination Verification
Grep for `claude_projects/${` in route.ts: **0 matches** (previously 9 occurrences)
All product path construction now flows through `src/lib/repo-path-resolver.ts`.
