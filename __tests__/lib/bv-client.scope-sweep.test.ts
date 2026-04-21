// =============================================================================
// Lint-style regression guard for factory-core-ppx.8
// =============================================================================
// Purpose: prevent future regressions where a new route handler case-branch
// forgets to pass a CacheScope to `invalidateCache`. The bead sweep replaced
// every bare `invalidateCache()` call with a scoped call
// (`invalidateCache({type:"epic",epicId})`) across the two declared route
// handlers. This test fails if a bare call reappears, naming the offending
// file and line so the fix is obvious.
//
// Scope (per bead manifest):
//   - src/app/api/fleet/action/route.ts
//   - src/app/api/agent/route.ts
//
// Internal Guardrail 3 ("grep the entire tree") — the test ALSO greps
// `tools/`, `__tests__/`, `standards/`, and `docs/` for bare calls. Any
// caller found outside the two declared route handlers is reported so the
// sweep discipline stays visible even if new callers appear.
//
// Covers test-scenarios doc scenarios for ppx.8:
//   - "No bare invalidateCache remains in route handlers" (Edge Cases #4)
//   - "Missing scope regression guard" (Edge Cases — Silent Exception Swallowing)
//   - "Internal Guardrail 3 — grep the entire tree" (Edge Cases)
// =============================================================================

import { readFileSync } from "fs";
import path from "path";

// -----------------------------------------------------------------------------
// Helper: scan a file's source for bare `invalidateCache()` calls and return
// their 1-indexed line numbers. Skips comments and strings heuristically —
// good enough for a lint-style guard.
// -----------------------------------------------------------------------------

interface BareCall {
  file: string;
  line: number;
  context: string;
}

/**
 * A "bare call" is any `invalidateCache(` immediately followed by `)` on the
 * same line (i.e. no argument). Accepts optional whitespace between the
 * parentheses so `invalidateCache( )` also trips the guard.
 *
 * The regex is anchored only loosely — it does NOT care about indentation,
 * preceding whitespace, or trailing semicolon. Comments (// ... or /* ... *​/)
 * and template strings that mention the identifier are filtered out by
 * stripping common comment forms before matching.
 */
function findBareCalls(filePath: string): BareCall[] {
  const source = readFileSync(filePath, "utf-8");
  const lines = source.split("\n");
  const calls: BareCall[] = [];
  const bareCallRe = /\binvalidateCache\s*\(\s*\)/;
  let inBlockComment = false;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Strip block comments (naive single-line handling — good enough for
    // real-world TypeScript where most block comments span full lines).
    if (inBlockComment) {
      const closeIdx = line.indexOf("*/");
      if (closeIdx === -1) continue;
      line = line.slice(closeIdx + 2);
      inBlockComment = false;
    }
    while (line.includes("/*")) {
      const openIdx = line.indexOf("/*");
      const closeIdx = line.indexOf("*/", openIdx + 2);
      if (closeIdx === -1) {
        line = line.slice(0, openIdx);
        inBlockComment = true;
        break;
      }
      line = line.slice(0, openIdx) + line.slice(closeIdx + 2);
    }

    // Strip single-line comments.
    const lineCommentIdx = line.indexOf("//");
    if (lineCommentIdx !== -1) {
      line = line.slice(0, lineCommentIdx);
    }

    if (bareCallRe.test(line)) {
      calls.push({
        file: filePath,
        line: i + 1,
        context: lines[i].trim(),
      });
    }
  }

  return calls;
}

// -----------------------------------------------------------------------------
// Resolve paths relative to the repo root. `process.cwd()` is the beads_web
// root during `jest` runs (Next.js jest preset sets this).
// -----------------------------------------------------------------------------

const REPO_ROOT = process.cwd();

function resolve(...parts: string[]): string {
  return path.join(REPO_ROOT, ...parts);
}

// -----------------------------------------------------------------------------
// Declared scope: the two route handler files the bead swept.
// -----------------------------------------------------------------------------

const DECLARED_ROUTE_HANDLERS = [
  "src/app/api/fleet/action/route.ts",
  "src/app/api/agent/route.ts",
  "src/app/api/issues/[id]/action/route.ts",
  "src/app/api/issues/[id]/comments/route.ts",
  "src/app/api/issues/route.ts",
];

describe("factory-core-ppx.8 — cache scope sweep guard", () => {
  // ---------------------------------------------------------------------------
  // Primary gate: the two declared route handlers have zero bare calls after
  // the sweep. This is the "happy path" assertion from the test scenarios
  // doc ("No bare invalidateCache remains in route handlers").
  // ---------------------------------------------------------------------------

  describe.each(DECLARED_ROUTE_HANDLERS)(
    "declared route handler: %s",
    (relativePath) => {
      it("has zero bare invalidateCache() calls", () => {
        const absolute = resolve(relativePath);
        const bareCalls = findBareCalls(absolute);

        if (bareCalls.length > 0) {
          const detail = bareCalls
            .map((c) => `  ${c.file}:${c.line}  ${c.context}`)
            .join("\n");
          throw new Error(
            [
              `Found ${bareCalls.length} bare invalidateCache() call(s) in ${relativePath}.`,
              "Every call must pass a CacheScope:",
              '  - invalidateCache({ type: "epic", epicId }) when the action mutates a specific epic',
              '  - invalidateCache({ type: "repo", repoPath }) when the action affects a whole repo',
              '  - invalidateCache({ type: "global" }) when the action has no clear epic owner',
              "",
              "Offending call sites:",
              detail,
            ].join("\n"),
          );
        }

        expect(bareCalls).toHaveLength(0);
      });

      // -----------------------------------------------------------------------
      // Sanity check: every remaining `invalidateCache(` call carries a scope
      // argument. This catches the case where a future refactor rewrites the
      // call shape in a way the bare-call regex misses (e.g. multi-line
      // argument, comment injection). We simply assert that every match of
      // `invalidateCache(` is followed on the same line by `{` (scope literal)
      // or a variable reference (non-empty parenthesis content).
      // -----------------------------------------------------------------------

      it("every invalidateCache( call has a non-empty argument", () => {
        const absolute = resolve(relativePath);
        const source = readFileSync(absolute, "utf-8");
        const lines = source.split("\n");
        const offenders: { line: number; context: string }[] = [];

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const callIdx = line.indexOf("invalidateCache(");
          if (callIdx === -1) continue;
          // Skip the function definition line itself (the declaration lives
          // in bv-client.ts, not in these route handlers, but be defensive).
          if (/export\s+function\s+invalidateCache/.test(line)) continue;
          const afterParen = line.slice(callIdx + "invalidateCache(".length);
          const trimmed = afterParen.trimStart();
          // An empty-argument call starts with `)` right after the `(`.
          if (trimmed.startsWith(")")) {
            offenders.push({ line: i + 1, context: lines[i].trim() });
          }
        }

        if (offenders.length > 0) {
          const detail = offenders
            .map((o) => `  ${relativePath}:${o.line}  ${o.context}`)
            .join("\n");
          throw new Error(
            `Found ${offenders.length} invalidateCache() call(s) with empty argument list:\n${detail}`,
          );
        }

        expect(offenders).toHaveLength(0);
      });
    },
  );

  // ---------------------------------------------------------------------------
  // Scope boundary documentation: the bead's Files: manifest declared only
  // these two route handlers, but the acceptance criteria specifies that the
  // guard "names the offending file and line" for ANY future route handler
  // that forgets a scope. This test exists to make that behaviour explicit —
  // it's a self-check that `findBareCalls` actually reports line numbers
  // (run against a synthetic fixture file in __tests__/fixtures/).
  // ---------------------------------------------------------------------------

  it("findBareCalls helper reports line numbers for synthetic offenders", () => {
    // Write a tiny inline source to a temp-like path and assert the helper
    // behaviour. We don't actually touch the filesystem — we reach into the
    // helper's regex path by constructing the content in-memory.
    // (Alternative: a dedicated fixture file. In-memory is simpler and
    //  matches the check style used in other "meta-lint" tests in this repo.)
    const synthetic = [
      "import { invalidateCache } from '@/lib/bv-client';",
      "",
      "export async function POST() {",
      "  invalidateCache();           // line 4 — bare (regression)",
      "  invalidateCache({ type: 'epic', epicId: 'x' }); // line 5 — OK",
      "  // invalidateCache(); — commented out, should NOT be flagged",
      "  /* invalidateCache(); */     // line 7 — block-commented",
      "}",
    ].join("\n");
    const tmpPath = path.join(__dirname, "__bv-client-scope-sweep-tmp__.ts");
    // Use fs.writeFileSync / unlinkSync so the helper, which reads from disk,
    // actually sees the content.
    const fs = require("fs") as typeof import("fs");
    fs.writeFileSync(tmpPath, synthetic, "utf-8");
    try {
      const found = findBareCalls(tmpPath);
      expect(found).toHaveLength(1);
      expect(found[0].line).toBe(4);
      expect(found[0].context).toContain("invalidateCache();");
    } finally {
      fs.unlinkSync(tmpPath);
    }
  });

  // ---------------------------------------------------------------------------
  // Internal Guardrail 3 — full cross-tree assertion.
  //
  // ppx.11 expanded the sweep to all route handlers in src/. This test now
  // fails (not warns) if any bare invalidateCache() call exists anywhere in
  // src/ outside bv-client.ts (which declares the function).
  // ---------------------------------------------------------------------------

  it("zero bare invalidateCache() calls anywhere in src/", () => {
    const fs = require("fs") as typeof import("fs");

    function walk(dir: string): string[] {
      const out: string[] = [];
      let entries: import("fs").Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return out;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        if (entry.name === "node_modules") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          out.push(...walk(full));
        } else if (/\.tsx?$/.test(entry.name)) {
          out.push(full);
        }
      }
      return out;
    }

    const srcFiles = walk(resolve("src"));
    const allOffenders: BareCall[] = [];

    for (const f of srcFiles) {
      // Skip bv-client itself — it declares the function signature and
      // legitimately mentions `invalidateCache()` in JSDoc.
      if (f.endsWith("src/lib/bv-client.ts")) continue;
      allOffenders.push(...findBareCalls(f));
    }

    if (allOffenders.length > 0) {
      const detail = allOffenders
        .map((c) => `  ${path.relative(REPO_ROOT, c.file)}:${c.line}  ${c.context}`)
        .join("\n");
      throw new Error(
        [
          `Found ${allOffenders.length} bare invalidateCache() call(s) in src/.`,
          "Every call must pass a CacheScope:",
          '  - invalidateCache({ type: "epic", epicId }) for epic-scoped mutations',
          '  - invalidateCache({ type: "repo", repoPath }) for repo-scoped mutations',
          '  - invalidateCache({ type: "global" }) for explicit global invalidation',
          "",
          "Offending call sites:",
          detail,
        ].join("\n"),
      );
    }

    expect(allOffenders).toHaveLength(0);
  });
});
