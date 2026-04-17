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
  parseFilesManifest,
  groupBeadsByFileConflict,
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
    it("appends the bead ID when set", () => {
      expect(sessionScopeSuffix(2, "factory-core-z9h.3")).toBe(
        "-wave2-factory-core-z9h.3",
      );
    });

    it("allows bead-only scope when wave is absent", () => {
      expect(sessionScopeSuffix(undefined, "bead-123")).toBe("-bead-123");
    });

    it("sanitises tmux-unsafe characters in the bead ID", () => {
      // tmux session names disallow most punctuation beyond -, _, .
      // We preserve dots (bead IDs use them) but strip other unsafe chars.
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
