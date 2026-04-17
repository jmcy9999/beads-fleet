// =============================================================================
// Tests for src/lib/agent-launcher.ts
// =============================================================================
// Pure-function coverage for session naming scope (factory-core-z9h.2 / .3).
// launchAgent itself spawns tmux and reads env — not unit-testable without
// heavy mocking — so we cover the pure helper that drives the session/file
// name suffixes.
// =============================================================================

import { sessionScopeSuffix } from "@/lib/agent-launcher";

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
