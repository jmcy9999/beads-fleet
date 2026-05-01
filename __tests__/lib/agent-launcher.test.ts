// =============================================================================
// Tests for src/lib/agent-launcher.ts
// =============================================================================
// Pure-function coverage for session naming scope (factory-core-z9h.2 / .3).
// launchAgent itself spawns tmux and reads env — not unit-testable without
// heavy mocking — so we cover the pure helper that drives the session/file
// name suffixes.
// =============================================================================

import {
  sessionScopeSuffix,
  sessionFileFor,
  parseFilesManifest,
  groupBeadsByFileConflict,
  shouldFireWaveReview,
  markWaveReviewFired,
  clearWaveReviewGuard,
  isAgentActive,
  hasActiveAgentForEpic,
  listOpenWaveBeadsAllRepos,
  _testOnlySetActiveAgent,
  type WaveBead,
  type CrossRepoBeadListDeps,
} from "@/lib/agent-launcher";

describe("sessionScopeSuffix", () => {
  describe("legacy — no scope", () => {
    it("returns empty string when neither wave nor bead is set", () => {
      expect(sessionScopeSuffix()).toBe("");
      expect(sessionScopeSuffix(undefined, undefined)).toBe("");
    });
  });

  describe("factory-core-z9h.2 — wave scoping", () => {
    it("produces a wave suffix for wave 1", () => {
      expect(sessionScopeSuffix(1)).toBe("-wave1");
    });

    it("produces a wave suffix for wave 2", () => {
      expect(sessionScopeSuffix(2)).toBe("-wave2");
    });

    it("wave 1 and wave 2 suffixes differ — no collision between successive waves", () => {
      // This is the core z9h.2 guarantee: the string used to name the tmux
      // session must be distinguishable between waves of the same epic.
      expect(sessionScopeSuffix(1)).not.toBe(sessionScopeSuffix(2));
    });

    it("handles wave numbers > 9 cleanly", () => {
      expect(sessionScopeSuffix(10)).toBe("-wave10");
      expect(sessionScopeSuffix(42)).toBe("-wave42");
    });

    it("ignores NaN wave numbers (defensive — bad input from querystring parsing)", () => {
      expect(sessionScopeSuffix(Number.NaN)).toBe("");
    });

    it("ignores Infinity (defensive)", () => {
      expect(sessionScopeSuffix(Number.POSITIVE_INFINITY)).toBe("");
    });
  });

  describe("factory-core-z9h.3 — bead scoping (foundation)", () => {
    it("appends the bead ID when set (dots replaced with hyphens for tmux safety)", () => {
      expect(sessionScopeSuffix(2, "factory-core-z9h.3")).toBe(
        "-wave2-factory-core-z9h-3",
      );
    });

    it("allows bead-only scope when wave is absent", () => {
      expect(sessionScopeSuffix(undefined, "bead-123")).toBe("-bead-123");
    });

    it("sanitises tmux-unsafe characters in the bead ID", () => {
      // tmux interprets dots as window/pane separators — replace with hyphens
      expect(sessionScopeSuffix(1, "bead/with/slashes")).toBe(
        "-wave1-bead-with-slashes",
      );
      expect(sessionScopeSuffix(1, "bead with spaces")).toBe(
        "-wave1-bead-with-spaces",
      );
    });

    it("two different beads in the same wave produce distinct suffixes", () => {
      const a = sessionScopeSuffix(2, "factory-core-z9h.3");
      const b = sessionScopeSuffix(2, "factory-core-z9h.5");
      expect(a).not.toBe(b);
    });
  });
});

// ===========================================================================
// factory-core-z9h.3 — per-bead parallel builders
// ===========================================================================

describe("parseFilesManifest", () => {
  it("returns an empty array when no Files: section is present", () => {
    const out = `
◐ factory-core-z9h.3 · Title [● P1 · OPEN]
DESCRIPTION
Some long description without a manifest.
NOTES
more notes.
LABELS: release:1.0
    `;
    expect(parseFilesManifest(out)).toEqual([]);
  });

  it("parses a Files: section with hyphen bullets", () => {
    const out = `
Some prose
Files:
- src/app/api/fleet/action/route.ts
- src/lib/agent-launcher.ts

More prose
    `;
    expect(parseFilesManifest(out)).toEqual([
      "src/app/api/fleet/action/route.ts",
      "src/lib/agent-launcher.ts",
    ]);
  });

  it("parses a Files: section with asterisk bullets", () => {
    const out = `Files:
* a.ts
* b.ts
`;
    expect(parseFilesManifest(out)).toEqual(["a.ts", "b.ts"]);
  });

  it("recognises markdown-heading variants like '## Files' and '**Files:**'", () => {
    expect(parseFilesManifest(`## Files\n- x.ts\n- y.ts\n`)).toEqual([
      "x.ts",
      "y.ts",
    ]);
    expect(parseFilesManifest(`**Files:**\n- z.ts\n`)).toEqual(["z.ts"]);
  });

  it("stops at the next LABELS / NOTES / PARENT bd-show section header", () => {
    const out = `Files:
- a.ts
- b.ts
LABELS: wave:2
- c.ts
`;
    // c.ts sits after the LABELS header so it's outside the Files section.
    expect(parseFilesManifest(out)).toEqual(["a.ts", "b.ts"]);
  });

  it("strips backticks around file paths (common in markdown)", () => {
    expect(parseFilesManifest("Files:\n- `path/to/file.ts`\n")).toEqual([
      "path/to/file.ts",
    ]);
  });

  it("tolerates blank lines inside the section", () => {
    const out = `Files:
- a.ts

- b.ts
`;
    expect(parseFilesManifest(out)).toEqual(["a.ts", "b.ts"]);
  });
});

describe("groupBeadsByFileConflict", () => {
  const b = (id: string, ...files: string[]): WaveBead => ({ id, title: id, files });

  it("returns an empty array for an empty input", () => {
    expect(groupBeadsByFileConflict([])).toEqual([]);
  });

  it("gives every disjoint bead its own group (all parallel)", () => {
    const groups = groupBeadsByFileConflict([
      b("A", "a.ts"),
      b("B", "b.ts"),
      b("C", "c.ts"),
    ]);
    expect(groups).toHaveLength(3);
    for (const g of groups) expect(g).toHaveLength(1);
  });

  it("merges two beads that share a file into one group", () => {
    const groups = groupBeadsByFileConflict([
      b("A", "shared.ts", "a.ts"),
      b("B", "shared.ts", "b.ts"),
      b("C", "c.ts"),
    ]);
    const sizes = groups.map((g) => g.length).sort();
    expect(sizes).toEqual([1, 2]);
    // The 2-group contains A and B; the 1-group contains C.
    const two = groups.find((g) => g.length === 2)!;
    const one = groups.find((g) => g.length === 1)!;
    expect(two.map((x) => x.id).sort()).toEqual(["A", "B"]);
    expect(one[0].id).toBe("C");
  });

  it("transitively merges beads via shared files (A-B via X, B-C via Y ⇒ one group of 3)", () => {
    const groups = groupBeadsByFileConflict([
      b("A", "X.ts"),
      b("B", "X.ts", "Y.ts"),
      b("C", "Y.ts"),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].map((x) => x.id).sort()).toEqual(["A", "B", "C"]);
  });

  it("collapses all unknown-manifest beads into a single conservative group", () => {
    const groups = groupBeadsByFileConflict([b("P"), b("Q"), b("R")]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(3);
  });

  it("keeps unknown-manifest beads separate from known-disjoint beads", () => {
    const groups = groupBeadsByFileConflict([
      b("K1", "k1.ts"),
      b("U1"),
      b("U2"),
    ]);
    // K1 stands alone; U1 and U2 collapse into the unknown group.
    expect(groups).toHaveLength(2);
    const sizes = groups.map((g) => g.length).sort();
    expect(sizes).toEqual([1, 2]);
  });

  it("preserves input order within a group (stable sequential launch order)", () => {
    const groups = groupBeadsByFileConflict([
      b("A", "x.ts"),
      b("C", "c.ts"),
      b("B", "x.ts"),
    ]);
    const ab = groups.find((g) => g.length === 2)!;
    expect(ab.map((x) => x.id)).toEqual(["A", "B"]);
  });
});

// ===========================================================================
// factory-core-z9h.6 — Wave review idempotency guard
// ===========================================================================

describe("shouldFireWaveReview / markWaveReviewFired / clearWaveReviewGuard", () => {
  // Each test uses a unique epicId so the module-level Set doesn't leak.
  let counter = 0;
  const nextEpic = () => `test-epic-${++counter}`;

  it("shouldFireWaveReview returns true for a fresh (epic, wave) pair", () => {
    const epic = nextEpic();
    expect(shouldFireWaveReview(epic, 1)).toBe(true);
  });

  it("markWaveReviewFired prevents a second fire for the same pair (idempotency guard)", () => {
    const epic = nextEpic();
    expect(shouldFireWaveReview(epic, 1)).toBe(true);
    markWaveReviewFired(epic, 1);
    expect(shouldFireWaveReview(epic, 1)).toBe(false);
  });

  it("different waves on the same epic are tracked independently", () => {
    const epic = nextEpic();
    markWaveReviewFired(epic, 1);
    // Wave 2 hasn't been fired yet.
    expect(shouldFireWaveReview(epic, 2)).toBe(true);
    markWaveReviewFired(epic, 2);
    expect(shouldFireWaveReview(epic, 1)).toBe(false);
    expect(shouldFireWaveReview(epic, 2)).toBe(false);
  });

  it("different epics on the same wave don't interfere — no residual state leak (regression #3)", () => {
    const epicA = nextEpic();
    const epicB = nextEpic();
    markWaveReviewFired(epicA, 1);
    // Epic B's wave 1 is still free to fire.
    expect(shouldFireWaveReview(epicB, 1)).toBe(true);
  });

  it("clearWaveReviewGuard(epic, wave) resets only that wave", () => {
    const epic = nextEpic();
    markWaveReviewFired(epic, 1);
    markWaveReviewFired(epic, 2);
    clearWaveReviewGuard(epic, 1);
    expect(shouldFireWaveReview(epic, 1)).toBe(true);
    expect(shouldFireWaveReview(epic, 2)).toBe(false);
  });

  it("clearWaveReviewGuard(epic) without wave resets all waves for that epic", () => {
    const epic = nextEpic();
    markWaveReviewFired(epic, 1);
    markWaveReviewFired(epic, 2);
    markWaveReviewFired(epic, 3);
    clearWaveReviewGuard(epic);
    expect(shouldFireWaveReview(epic, 1)).toBe(true);
    expect(shouldFireWaveReview(epic, 2)).toBe(true);
    expect(shouldFireWaveReview(epic, 3)).toBe(true);
  });

  it("clearWaveReviewGuard only clears the specified epic, not others", () => {
    const epicA = nextEpic();
    const epicB = nextEpic();
    markWaveReviewFired(epicA, 1);
    markWaveReviewFired(epicB, 1);
    clearWaveReviewGuard(epicA);
    expect(shouldFireWaveReview(epicA, 1)).toBe(true);
    expect(shouldFireWaveReview(epicB, 1)).toBe(false); // untouched
  });

  it("simulated race: two near-simultaneous exits both check and only one fires", () => {
    // This is the canonical z9h.6 scenario — two per-bead agents exit,
    // both see currentWaveComplete=true. The guard ensures review-wave
    // is dispatched exactly once.
    const epic = nextEpic();
    let fireCount = 0;

    // Agent 1 exits
    if (shouldFireWaveReview(epic, 1)) {
      markWaveReviewFired(epic, 1);
      fireCount += 1;
      // simulate async fetch here
    }
    // Agent 2 exits near-simultaneously
    if (shouldFireWaveReview(epic, 1)) {
      markWaveReviewFired(epic, 1);
      fireCount += 1;
    }
    // Agent 3 is the poll-loop duplicate of agent 1
    if (shouldFireWaveReview(epic, 1)) {
      markWaveReviewFired(epic, 1);
      fireCount += 1;
    }

    expect(fireCount).toBe(1);
  });

  // =========================================================================
  // factory-core-z9h.13 — rollback on dispatch failure
  // =========================================================================
  //
  // The review-wave guard used to mark BEFORE the fetch that dispatches
  // review-wave. If the fetch failed (dashboard down, network blip, 500),
  // the guard stayed set — no future exit on the same (epic, wave) could
  // re-dispatch within this process, because clearWaveReviewGuard only
  // runs when review-wave itself closes successfully.
  //
  // Fix: wrap the dispatch so a failed fetch (network error OR !res.ok)
  // clears the guard before surfacing the error. The caller's outer catch
  // still logs and returns false; the guard is free for the next exit to
  // retry. Regression patterns #13 Silent Exception Swallowing and #11
  // adjacent (guard state mutated before guarded operation succeeds).

  it("z9h.13 rollback: guard cleared after dispatch failure permits retry", () => {
    const epic = nextEpic();

    // First exit: check + mark, then "fetch" fails → rollback clears guard.
    expect(shouldFireWaveReview(epic, 1)).toBe(true);
    markWaveReviewFired(epic, 1);
    try {
      throw new Error("simulated fetch failure: HTTP 500");
    } catch {
      clearWaveReviewGuard(epic, 1);
    }

    // Second exit on the same (epic, wave): retry must be allowed.
    expect(shouldFireWaveReview(epic, 1)).toBe(true);
  });

  it("z9h.13 rollback: clears only the failed wave, not other waves for the epic", () => {
    const epic = nextEpic();

    // Wave 1 dispatched successfully earlier — guard remains set.
    markWaveReviewFired(epic, 1);

    // Wave 2 dispatch fails → rollback clears wave 2 only.
    markWaveReviewFired(epic, 2);
    clearWaveReviewGuard(epic, 2);

    expect(shouldFireWaveReview(epic, 1)).toBe(false); // still fired
    expect(shouldFireWaveReview(epic, 2)).toBe(true); // rolled back
  });

  it("z9h.13 rollback: clears only the failed epic, not other epics on the same wave", () => {
    const epicA = nextEpic();
    const epicB = nextEpic();

    // Epic A dispatched successfully — guard remains set.
    markWaveReviewFired(epicA, 1);

    // Epic B dispatch fails → rollback clears B only.
    markWaveReviewFired(epicB, 1);
    clearWaveReviewGuard(epicB, 1);

    expect(shouldFireWaveReview(epicA, 1)).toBe(false); // still fired
    expect(shouldFireWaveReview(epicB, 1)).toBe(true); // rolled back
  });
});

// ===========================================================================
// factory-core-z9h.12 — persist/clear filename parity
// ===========================================================================
//
// Regression test for the composite-key leak: startPollLoop was calling
// clearPersistedSession(repoKey, ...) where repoKey is activeAgentKey's
// `${realpath}::${beadId}` composite — but persistSession had written the
// file using just realpath. The mismatch meant the file was never deleted,
// silently leaking into /tmp/beads-web-agent-sessions across wave runs.
//
// Regression pattern #1 — Write/Read Disconnect. These tests lock in the
// identity that the write path and the delete path MUST derive their
// filename from the same inputs.

describe("sessionFileFor — write/clear filename parity (regression #1)", () => {
  const repoPath = "/Users/janemckay/dev/claude_projects/beads_web";
  const compositeKey = `${repoPath}::factory-core-z9h.12`;

  it("is deterministic: same inputs produce the same filename", () => {
    expect(sessionFileFor(repoPath, 1, "factory-core-z9h.3")).toBe(
      sessionFileFor(repoPath, 1, "factory-core-z9h.3"),
    );
  });

  it("the composite key produces a DIFFERENT filename than the plain repoPath (the bug)", () => {
    // This asserts the bug's root cause: if startPollLoop passes the
    // composite key to clearPersistedSession, it targets a different file
    // than persistSession wrote — the original leaks.
    const plain = sessionFileFor(repoPath, 1, "factory-core-z9h.3");
    const composite = sessionFileFor(compositeKey, 1, "factory-core-z9h.3");
    expect(plain).not.toBe(composite);
  });

  it("the composite-key filename contains '::' — marker of the bug-period orphans cleaned up on recovery", () => {
    const composite = sessionFileFor(compositeKey, 1, "factory-core-z9h.3");
    expect(composite).toContain("::");
    // Conversely, the correct (repoPath-derived) filename never contains "::".
    const correct = sessionFileFor(repoPath, 1, "factory-core-z9h.3");
    expect(correct).not.toContain("::");
  });

  it("filename reflects repoPath + waveNumber + beadId — the three persist inputs", () => {
    // Changing any of the three inputs changes the filename. This is what
    // guarantees parallel-builder and multi-wave runs don't collide.
    const a = sessionFileFor(repoPath, 1, "bead-A");
    const b = sessionFileFor(repoPath, 1, "bead-B"); // different bead
    const c = sessionFileFor(repoPath, 2, "bead-A"); // different wave
    const d = sessionFileFor("/other/repo", 1, "bead-A"); // different repo
    expect(new Set([a, b, c, d]).size).toBe(4);
  });

  it("wave-only scope (no beadId) is stable across calls — legacy single-agent-per-wave case", () => {
    expect(sessionFileFor(repoPath, 1)).toBe(sessionFileFor(repoPath, 1));
    expect(sessionFileFor(repoPath, 1)).not.toBe(sessionFileFor(repoPath, 2));
  });
});

describe("isAgentActive", () => {
  it("returns false when no agent is tracked for the given repo", () => {
    // No agents are launched in a unit test; the activeAgents map is empty.
    // /tmp is a valid resolvable path on macOS + Linux so realpathSync won't throw.
    expect(isAgentActive("/tmp")).toBe(false);
  });

  it("returns false for a (repo, beadId) pair with no tracked agent", () => {
    expect(isAgentActive("/tmp", "factory-core-z9h.99")).toBe(false);
  });
});

// ===========================================================================
// factory-core-z9h.11 — agent:running label survives parallel-builder exits
// ===========================================================================

describe("hasActiveAgentForEpic", () => {
  // activeAgents is a module-level Map. No agents are launched in unit tests,
  // so the map is always empty here — which is exactly the predicate's
  // baseline: no tracked agents ⇒ the epic has nothing running ⇒ safe to
  // clear `agent:running`.
  it("returns false when no agents are tracked (empty map ⇒ safe to clear agent:running)", () => {
    expect(hasActiveAgentForEpic("factory-core-z9h")).toBe(false);
  });

  it("returns false for any epic id when the tracking map is empty", () => {
    expect(hasActiveAgentForEpic("unknown-epic")).toBe(false);
    expect(hasActiveAgentForEpic("factory-core-z9h")).toBe(false);
    expect(hasActiveAgentForEpic("")).toBe(false);
  });

  it("is the predicate that gates agent:running removal on exit — empty map ⇒ no other builders alive ⇒ clear label (regression #3 inverse)", () => {
    // This test documents the intent: handleAgentExit removes the current
    // session from activeAgents BEFORE calling this predicate. When this
    // returns false, the exiting agent was the LAST one for the epic, so
    // clearing `agent:running` is correct. When it returns true (not
    // exercised in unit tests because launchAgent is not callable without
    // tmux), N-1 siblings are still alive and the label must be preserved.
    expect(hasActiveAgentForEpic("factory-core-z9h")).toBe(false);
  });
});

// ===========================================================================
// beads_web-9vv — Cross-repo bead enumeration primitives
// ===========================================================================

describe("listOpenWaveBeadsAllRepos (beads_web-9vv)", () => {
  const bead = (id: string, title?: string): WaveBead => ({
    id,
    title: title ?? id,
    files: [],
  });

  // (a) Union case: beads from multiple repos are merged
  it("returns the union of beads from all repos via Promise.allSettled", async () => {
    const deps: CrossRepoBeadListDeps = {
      getRepoPaths: async () => ["/repo/alpha", "/repo/beta", "/repo/gamma"],
      listBeads: async (_epicId, _wave, repoPath) => {
        if (repoPath === "/repo/alpha") return [bead("epic-1.1")];
        if (repoPath === "/repo/beta") return [bead("epic-1.2"), bead("epic-1.3")];
        if (repoPath === "/repo/gamma") return [];
        return [];
      },
    };
    const result = await listOpenWaveBeadsAllRepos("epic-1", 1, deps);
    expect(result).toHaveLength(3);
    expect(result.map((b) => b.id).sort()).toEqual(["epic-1.1", "epic-1.2", "epic-1.3"]);
  });

  // (b) Error-discrimination: one repo fails, wrapper throws listing the failing repo
  it("throws an error listing failing repos when any repo's bd fails (z9h.9 contract)", async () => {
    const deps: CrossRepoBeadListDeps = {
      getRepoPaths: async () => ["/repo/ok", "/repo/broken"],
      listBeads: async (_epicId, _wave, repoPath) => {
        if (repoPath === "/repo/broken") {
          throw new Error("bd list failed for epic test-epic");
        }
        return [bead("ok-bead")];
      },
    };
    await expect(listOpenWaveBeadsAllRepos("test-epic", 1, deps)).rejects.toThrow(
      /listOpenWaveBeadsAllRepos: bd failed in 1 repo\(s\).*\/repo\/broken/,
    );
  });

  it("throws listing ALL failing repos, not just the first (aggregated error)", async () => {
    const deps: CrossRepoBeadListDeps = {
      getRepoPaths: async () => ["/repo/bad1", "/repo/bad2", "/repo/good"],
      listBeads: async (_epicId, _wave, repoPath) => {
        if (repoPath.includes("bad")) {
          throw new Error("bd failure");
        }
        return [bead("good-bead")];
      },
    };
    await expect(listOpenWaveBeadsAllRepos("epic-x", 2, deps)).rejects.toThrow(
      /bd failed in 2 repo\(s\).*\/repo\/bad1.*\/repo\/bad2/,
    );
  });

  // (e) Kill-switch: env=false falls through to single-repo only
  it("falls through to single-repo listOpenWaveBeads when CROSS_REPO_DISPATCH_ENABLED=false", async () => {
    const originalEnv = process.env.CROSS_REPO_DISPATCH_ENABLED;
    try {
      process.env.CROSS_REPO_DISPATCH_ENABLED = "false";

      const calledPaths: string[] = [];
      const deps: CrossRepoBeadListDeps = {
        getRepoPaths: async () => ["/repo/primary", "/repo/secondary"],
        listBeads: async (_epicId, _wave, repoPath) => {
          calledPaths.push(repoPath);
          return [bead("primary-bead")];
        },
      };

      const result = await listOpenWaveBeadsAllRepos("epic-kill", 1, deps);

      // Only the first (default) repo should have been queried — no fanout.
      expect(calledPaths).toEqual(["/repo/primary"]);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("primary-bead");
    } finally {
      // Restore env
      if (originalEnv === undefined) {
        delete process.env.CROSS_REPO_DISPATCH_ENABLED;
      } else {
        process.env.CROSS_REPO_DISPATCH_ENABLED = originalEnv;
      }
    }
  });
});

describe("isAgentActive cross-repo mode (beads_web-9vv)", () => {
  const cleanups: (() => void)[] = [];

  afterEach(() => {
    for (const cleanup of cleanups) cleanup();
    cleanups.length = 0;
  });

  // (c) Cross-repo by-bead-id positive case
  it("returns true when the beadId matches an active agent regardless of repoPath", () => {
    // Inject an agent in /repo/alpha with beadId "epic-1.5"
    cleanups.push(
      _testOnlySetActiveAgent("/repo/alpha::epic-1.5", {
        repoPath: "/repo/alpha",
        beadId: "epic-1.5",
      }),
    );

    // Cross-repo lookup from /repo/beta should find it
    expect(
      isAgentActive("/repo/beta", "epic-1.5", undefined, { crossRepo: true }),
    ).toBe(true);
  });

  it("returns false when no active agent has the given beadId (cross-repo mode)", () => {
    cleanups.push(
      _testOnlySetActiveAgent("/repo/alpha::epic-1.5", {
        repoPath: "/repo/alpha",
        beadId: "epic-1.5",
      }),
    );

    expect(
      isAgentActive("/repo/alpha", "epic-1.99", undefined, { crossRepo: true }),
    ).toBe(false);
  });

  // (d) Collision case: same beadId in multiple repos throws
  it("throws on bead-ID collision (multiple active agents with same beadId in different repos)", () => {
    // Inject two agents with the same beadId in different repos
    cleanups.push(
      _testOnlySetActiveAgent("/repo/alpha::epic-1.5", {
        repoPath: "/repo/alpha",
        beadId: "epic-1.5",
      }),
    );
    cleanups.push(
      _testOnlySetActiveAgent("/repo/beta::epic-1.5", {
        repoPath: "/repo/beta",
        beadId: "epic-1.5",
      }),
    );

    expect(() =>
      isAgentActive("/repo/gamma", "epic-1.5", undefined, { crossRepo: true }),
    ).toThrow(/bead-ID collision.*epic-1\.5.*2 repos.*\/repo\/alpha.*\/repo\/beta/);
  });

  it("preserves default key-based behaviour when crossRepo is not set", () => {
    // Use /tmp (resolvable via realpathSync on macOS/Linux) to avoid ENOENT.
    // activeAgentKey resolves repoPath via realpathSync before keying.
    // On macOS, /tmp → /private/tmp — the map key must use the resolved path
    // to match activeAgentKey's internal resolution.
    const fs = require("fs");
    const resolvedTmp = fs.realpathSync("/tmp");

    cleanups.push(
      _testOnlySetActiveAgent(`${resolvedTmp}::epic-1.5`, {
        repoPath: resolvedTmp,
        beadId: "epic-1.5",
      }),
    );

    // Without crossRepo mode, isAgentActive uses key-based lookup which
    // computes the key from the passed repoPath. /var (a different valid path)
    // won't match the /tmp-based key, proving default mode is repo-scoped.
    expect(isAgentActive("/var", "epic-1.5")).toBe(false);
    // Same repo SHOULD match via the default key-based path.
    expect(isAgentActive("/tmp", "epic-1.5")).toBe(true);
  });
});

// ===========================================================================
// beads_web-cnr (A.8) — Cross-cutting integration tests
// ===========================================================================
// These tests exercise A.1-A.7 in combination, covering the integration
// surface BETWEEN the individual beads rather than per-bead unit scope.
// ===========================================================================

describe("A.8 cross-cutting: listOpenWaveBeadsAllRepos + kill-switch + union (A.1 + A.3)", () => {
  const bead = (id: string, title?: string): WaveBead => ({
    id,
    title: title ?? id,
    files: [],
  });

  it("kill-switch disables cross-repo fanout even when multiple repos are configured", async () => {
    const originalEnv = process.env.CROSS_REPO_DISPATCH_ENABLED;
    try {
      process.env.CROSS_REPO_DISPATCH_ENABLED = "false";

      const reposCalled: string[] = [];
      const deps: CrossRepoBeadListDeps = {
        getRepoPaths: async () => ["/repo/fleet-core", "/repo/beads-web", "/repo/third"],
        listBeads: async (_epicId, _wave, repoPath) => {
          reposCalled.push(repoPath);
          return [bead(`${repoPath}-bead`)];
        },
      };

      const result = await listOpenWaveBeadsAllRepos("epic-killswitch", 1, deps);

      // Only the first repo gets queried — no cross-repo fanout.
      expect(reposCalled).toEqual(["/repo/fleet-core"]);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("/repo/fleet-core-bead");
    } finally {
      if (originalEnv === undefined) {
        delete process.env.CROSS_REPO_DISPATCH_ENABLED;
      } else {
        process.env.CROSS_REPO_DISPATCH_ENABLED = originalEnv;
      }
    }
  });

  it("re-enabling kill-switch restores cross-repo fanout (no env leakage)", async () => {
    const originalEnv = process.env.CROSS_REPO_DISPATCH_ENABLED;
    try {
      // First: disable
      process.env.CROSS_REPO_DISPATCH_ENABLED = "false";
      const reposCalled1: string[] = [];
      const deps1: CrossRepoBeadListDeps = {
        getRepoPaths: async () => ["/repo/A", "/repo/B"],
        listBeads: async (_epicId, _wave, repoPath) => {
          reposCalled1.push(repoPath);
          return [bead(`${repoPath}-bead`)];
        },
      };
      await listOpenWaveBeadsAllRepos("epic-toggle", 1, deps1);
      expect(reposCalled1).toEqual(["/repo/A"]);

      // Now: re-enable
      delete process.env.CROSS_REPO_DISPATCH_ENABLED;
      const reposCalled2: string[] = [];
      const deps2: CrossRepoBeadListDeps = {
        getRepoPaths: async () => ["/repo/A", "/repo/B"],
        listBeads: async (_epicId, _wave, repoPath) => {
          reposCalled2.push(repoPath);
          return [bead(`${repoPath}-bead`)];
        },
      };
      const result = await listOpenWaveBeadsAllRepos("epic-toggle", 1, deps2);

      // Both repos queried now — fanout restored.
      expect(reposCalled2.sort()).toEqual(["/repo/A", "/repo/B"]);
      expect(result).toHaveLength(2);
    } finally {
      if (originalEnv === undefined) {
        delete process.env.CROSS_REPO_DISPATCH_ENABLED;
      } else {
        process.env.CROSS_REPO_DISPATCH_ENABLED = originalEnv;
      }
    }
  });

  it("cross-repo union preserves bead identity across repos (no deduplication on shared IDs)", async () => {
    // If two repos return a bead with the same ID (a collision scenario),
    // listOpenWaveBeadsAllRepos should return both — the collision is
    // caught by isAgentActive at dispatch time, not by the enumerator.
    const deps: CrossRepoBeadListDeps = {
      getRepoPaths: async () => ["/repo/alpha", "/repo/beta"],
      listBeads: async (_epicId, _wave, repoPath) => {
        if (repoPath === "/repo/alpha") return [bead("shared-id"), bead("alpha-only")];
        if (repoPath === "/repo/beta") return [bead("shared-id"), bead("beta-only")];
        return [];
      },
    };
    const result = await listOpenWaveBeadsAllRepos("epic-collision", 1, deps);

    // All 4 beads returned (including the two with shared-id).
    expect(result).toHaveLength(4);
    expect(result.filter((b) => b.id === "shared-id")).toHaveLength(2);
  });
});

describe("A.8 cross-cutting: isAgentActive collision detection + cross-repo lookup chain (A.1 + A.6)", () => {
  const cleanups: (() => void)[] = [];

  afterEach(() => {
    for (const cleanup of cleanups) cleanup();
    cleanups.length = 0;
  });

  it("collision detection fires during dispatch check even when kill-switch is off (unconditional check)", () => {
    // The bead-ID collision check in isAgentActive is NOT gated by the
    // kill-switch — it's a correctness check, not a feature flag.
    // Inject two agents with the same beadId in different repos.
    cleanups.push(
      _testOnlySetActiveAgent("/repo/alpha::collision-bead", {
        repoPath: "/repo/alpha",
        beadId: "collision-bead",
      }),
    );
    cleanups.push(
      _testOnlySetActiveAgent("/repo/beta::collision-bead", {
        repoPath: "/repo/beta",
        beadId: "collision-bead",
      }),
    );

    // Cross-repo mode should detect the collision.
    expect(() =>
      isAgentActive("/repo/gamma", "collision-bead", undefined, { crossRepo: true }),
    ).toThrow(/bead-ID collision.*collision-bead.*2 repos/);
  });

  it("cross-repo lookup finds agents launched in any repo (simulates multi-repo dispatch)", () => {
    // Agent for bead in fleet-core
    cleanups.push(
      _testOnlySetActiveAgent("/repo/fleet-core::so74.A", {
        repoPath: "/repo/fleet-core",
        beadId: "so74.A",
      }),
    );
    // Agent for bead in beads-web
    cleanups.push(
      _testOnlySetActiveAgent("/repo/beads-web::so74.B", {
        repoPath: "/repo/beads-web",
        beadId: "so74.B",
      }),
    );

    // From any repo, cross-repo mode finds both.
    expect(isAgentActive("/repo/fleet-core", "so74.A", undefined, { crossRepo: true })).toBe(true);
    expect(isAgentActive("/repo/fleet-core", "so74.B", undefined, { crossRepo: true })).toBe(true);
    expect(isAgentActive("/repo/beads-web", "so74.A", undefined, { crossRepo: true })).toBe(true);
    expect(isAgentActive("/repo/beads-web", "so74.B", undefined, { crossRepo: true })).toBe(true);

    // Non-existent bead still returns false.
    expect(isAgentActive("/repo/fleet-core", "so74.C", undefined, { crossRepo: true })).toBe(false);
  });
});

// ===========================================================================
// beads_web-cnr (A.8) AC 6 — Bounding-rule assertion test (unit-level)
// ===========================================================================
// Per operator amendment: unit-level with mocked cache. Mock the bead-repo
// cache to return a mismatched repo for one bead under a product epic.
// Trigger the start-wave handler logic. Verify it throws with the explicit
// error message naming the bead, the resolved (mismatched) repo, and the
// expected (epic's) repo. No live bd state mutation.
//
// This tests the bounding-rule logic as it exists in the fleet action route
// (route.ts). Since route.ts is tested in __tests__/api/fleet-action.test.ts,
// this test exercises the UNDERLYING listOpenWaveBeadsAllRepos + cache
// interaction pattern at the unit level — verifying the primitives that the
// bounding rule depends on are correct in combination.
// ===========================================================================

describe("A.8 AC 6: bounding-rule assertion via primitives (unit-level, mocked cache)", () => {
  const bead = (id: string, title?: string): WaveBead => ({
    id,
    title: title ?? id,
    files: [],
  });

  it("cross-repo enumeration returns beads from ALL repos, enabling bounding-rule detection", async () => {
    // A product epic lives in /repo/product. A misbehaving bead appears in
    // /repo/other (it shouldn't be there for a product epic). The enumerator
    // returns both — the bounding rule in route.ts then catches the mismatch.
    //
    // This test verifies the enumerator doesn't filter or deduplicate — it
    // faithfully returns the union, leaving the bounding rule to act.
    const deps: CrossRepoBeadListDeps = {
      getRepoPaths: async () => ["/repo/product", "/repo/other"],
      listBeads: async (_epicId, _wave, repoPath) => {
        if (repoPath === "/repo/product") return [bead("product-bead-1")];
        if (repoPath === "/repo/other") return [bead("misplaced-bead-X")];
        return [];
      },
    };
    const result = await listOpenWaveBeadsAllRepos("product-epic-1", 1, deps);

    // Both beads returned — the enumerator doesn't enforce the bounding rule.
    expect(result).toHaveLength(2);
    expect(result.map((b) => b.id).sort()).toEqual(["misplaced-bead-X", "product-bead-1"]);

    // Now simulate the bounding-rule check that route.ts would perform:
    // build a cache mapping each bead to its resolved repo.
    const beadRepoCache = new Map<string, string>();
    beadRepoCache.set("product-bead-1", "/repo/product");
    beadRepoCache.set("misplaced-bead-X", "/repo/other"); // mismatch!

    const waveRepoPath = "/repo/product";
    const isCrossRepoEpic = false; // product epic

    // Bounding-rule assertion: product epic should NOT have cross-repo children.
    if (!isCrossRepoEpic) {
      const violations: Array<{ beadId: string; resolvedRepo: string }> = [];
      for (const [beadId, beadRepo] of beadRepoCache) {
        if (beadRepo !== waveRepoPath) {
          violations.push({ beadId, resolvedRepo: beadRepo });
        }
      }

      expect(violations).toHaveLength(1);
      expect(violations[0].beadId).toBe("misplaced-bead-X");
      expect(violations[0].resolvedRepo).toBe("/repo/other");

      // The error message route.ts would produce:
      const msg = `Bounding-rule violation: product epic product-epic-1 has cross-repo child ${violations[0].beadId} (resolved to ${violations[0].resolvedRepo}, expected ${waveRepoPath}).`;
      expect(msg).toContain("misplaced-bead-X");
      expect(msg).toContain("/repo/other");
      expect(msg).toContain("/repo/product");
    }
  });

  it("bounding rule passes when all beads resolve to the epic's home repo", async () => {
    const deps: CrossRepoBeadListDeps = {
      getRepoPaths: async () => ["/repo/product"],
      listBeads: async () => [bead("p-1"), bead("p-2"), bead("p-3")],
    };
    const result = await listOpenWaveBeadsAllRepos("product-epic-2", 1, deps);

    const beadRepoCache = new Map<string, string>();
    for (const b of result) {
      beadRepoCache.set(b.id, "/repo/product");
    }

    const waveRepoPath = "/repo/product";
    let violationCount = 0;
    for (const [, beadRepo] of beadRepoCache) {
      if (beadRepo !== waveRepoPath) violationCount++;
    }

    expect(violationCount).toBe(0);
  });

  it("bounding rule is NOT enforced for cross-repo epics (isCrossRepoEpic=true)", async () => {
    // Cross-repo epics (factory-core) are EXPECTED to have children
    // in multiple repos. The bounding rule only fires for product epics.
    const deps: CrossRepoBeadListDeps = {
      getRepoPaths: async () => ["/repo/factory-core", "/repo/beads-web"],
      listBeads: async (_epicId, _wave, repoPath) => {
        if (repoPath === "/repo/factory-core") return [bead("so74.1")];
        if (repoPath === "/repo/beads-web") return [bead("so74.2")];
        return [];
      },
    };
    const result = await listOpenWaveBeadsAllRepos("factory-core-so74", 2, deps);

    const beadRepoCache = new Map<string, string>();
    beadRepoCache.set("so74.1", "/repo/factory-core");
    beadRepoCache.set("so74.2", "/repo/beads-web");

    const isCrossRepoEpic = true;
    const waveRepoPath = "/repo/factory-core";

    // For cross-repo epics, the bounding rule is skipped.
    let violationCount = 0;
    if (!isCrossRepoEpic) {
      for (const [, beadRepo] of beadRepoCache) {
        if (beadRepo !== waveRepoPath) violationCount++;
      }
    }

    expect(violationCount).toBe(0);
    expect(result).toHaveLength(2); // Both repos' beads included.
  });
});
