# Wave 6 Report — Action route precondition checks (QA round 1 fix wave)

**Epic:** beads_web-ehp
**Wave:** 6 (QA round 1 fix wave)
**Date:** 2026-05-07
**Branch:** main
**Commits ahead of main:** 286 (all rebased; latest at 45badaa)

## Beads completed

| Bead | Commit | Status | Verification depth | Notes |
|------|--------|--------|---------------------|-------|
| beads_web-hfw (P1, pre-existing) | 384f832 | Closed (pre-this-dispatch) | standard | Production code: execSync(shell-string) → promisify(execFile)(argv). Closed prematurely without test update. |
| beads_web-q8w (P1, pre-existing) | 384f832 | Closed (pre-this-dispatch) | standard | Production code: blocking execSync inside async fn → non-blocking execFile via promisify. Closed prematurely without test update. |
| beads_web-cqe (P2, pre-existing) | 384f832 | Closed (pre-this-dispatch) | mechanical | Hardcoded `/Users/janemckay/dev/claude_projects/beads_web` removed; defers to `findRepoForIssue` registry lookup. |
| beads_web-rzt (P1, this dispatch) | 45badaa | Closed | standard | Test regression: execSync mock stale after 384f832; +2 shell-injection regression tests per hfw AC. |

## Per-bead git discipline check

Confirmed beads_web-rzt's commit (45badaa) staged exactly the two paths from its scope:
- `__tests__/lib/bead-status-reader.test.ts` (test mock + 2 new regression tests)
- `.beads/markers/beads_web-rzt.json` (builder marker, per the 2026-05-01 marker-write-ordering directive — marker is part of the commit)

No spillover. `git show --stat 45badaa` confirms 2 files changed, +206/-63.

## Verification summary

- bead-status-reader.test.ts: 26/26 tests pass (24 pre-existing + 2 new shell-injection regression tests).
- Full beads_web jest suite: 117 suites, 2355 tests pass, 2 skipped (unchanged from pre-commit baseline). No regressions.
- Shell-injection regression tests (rzt's primary deliverable) directly assert the spawn argv shape — verified that:
  - `cmd === '/usr/bin/bd'` (NOT `/bin/sh`)
  - `args` is an array (NOT a single shell-string)
  - `args[1]` preserves the malicious bead ID verbatim — no shell-token splitting
  - `args` does not contain chained command substrings as separate tokens

## Deviations from AC

None for rzt. The bead's AC was: (1) update mock to track execFile callback-style + promisify-custom-symbol pattern, and (2) add a shell-injection regression test per hfw's recommended fix. Both delivered in commit 45badaa.

For pre-existing wave-6 bugs (hfw/q8w/cqe): the previous closure (commit 384f832) shipped the production fix correctly, but did not satisfy hfw's full AC ("Add a unit test ... that asserts a bead ID containing shell metacharacters does NOT execute the injected command"). rzt closes that AC gap retroactively. The deviation is recorded for the wave's audit trail but does not require re-opening hfw.

## Carryover for next wave

This is the last wave of the epic. Recommendation: dispatch QA round 2 to verify the green test suite + the shell-injection regression coverage. Suggested round-2 spot checks (per rzt marker `recommendation_for_next`):

- Confirm `bead-status-reader.ts` spawns bd directly without `/bin/sh` — the new regression tests do this statically; an integration test could spawn a real bd subprocess to confirm.
- Ensure no other reader was patched with the same execSync-shell-string pattern. `reconciler-bootstrap.ts:206, 696` still carry the pre-existing anti-pattern (flagged in hfw's description as out-of-scope for this epic — not introduced or worsened by ehp).

## Branch state

- typecheck: not run as part of this dispatch (jest's tsx loader exercised the code path; type errors would have surfaced as test failures).
- lint: not run as part of this dispatch.
- working tree: dirty in expected ways — pre-existing uncommitted changes (.beads/.session-map.jsonl, .beads/issues.jsonl, .beads/token-usage.jsonl, etc.) were not touched by this dispatch. The marker file's `commit_sha` field was updated to `45badaa3...` post-commit (a non-commit-tracked update; the orchestrator reads the marker from disk).

## Process note (for lessons-learned)

Commit 384f832 (the prior wave-6 fix attempt) demonstrated the documented-degradation anti-pattern: production fix landed correctly, bug beads were closed, but the test suite regressed silently because the matching test file was never updated and `npx jest` was never re-run. The recommended hfw regression test was also never added. This dispatch's existence (rzt) is itself the corrective action; the lesson is that a fix touching a mocked API (execSync → execFile here) is a flag for re-running jest before closing the bug bead. Closure-without-jest-rerun is the same shape that the builder.md "documented degradation" rule warns against.
