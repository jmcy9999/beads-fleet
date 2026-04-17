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
  type WaveBead,
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
