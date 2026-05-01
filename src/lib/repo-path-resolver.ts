// =============================================================================
// Beads Fleet — Repo Path Resolution
// =============================================================================
//
// Central resolver for product repository paths, research paths, and plan paths
// based on ship type. Ensures consistent path construction across all pipeline
// actions.
//
// Rules:
// - ship-type:venture → use fleet-core, research in docs/research/<topic>.md
// - ship-type:internal → parse title to determine target repo (beads_web vs fleet-core)
// - All other ship types → product repo at /Users/janemckay/dev/claude_projects/<AppName>
// =============================================================================

import { promises as fs } from "fs";
import path from "path";

export const FLEET_CORE_PATH = process.env.FLEET_CORE_PATH || "/Users/janemckay/dev/fleet/factory-core";

export interface RepoPathResult {
  /** Absolute path to the repository where work happens */
  repoPath: string;
  /** Repository name (for display and agent context) */
  repoName: string;
  /** Absolute path to the research report/recon brief */
  researchPath: string;
  /** Absolute path to the build plan (undefined for ventures) */
  planPath?: string;
  /** Absolute path to the functional spec (undefined for ventures) */
  specPath?: string;
  /** Absolute path to the architecture document (undefined for ventures) */
  architecturePath?: string;
  /** Absolute path to the test scenarios document (undefined for ventures) */
  testScenariosPath?: string;
}

// Resolve fleet-core path: env var > hardcoded fallback.
// factory-core-so74 A.8 deferred-AC fix: fallback updated to factory-core
// (the active fork). The legacy fleet-core directory remains registered for
// ARCHIVE reference but is not the default. Without this update, the bounding
// rule at route.ts (path.basename === "factory-core") silently returns
// false on env-var absence, disabling cross-repo dispatch. See
// docs/aspirational-pipeline/a8-deferred-fixes.md.
/**
 * Convert epic title to a filesystem-safe topic name.
 * - Lowercase
 * - Underscores become hyphens (factory-core-k7gy.13: "beads_web" → "beads-web")
 * - Replace spaces/punctuation with hyphens
 * - Max 5 words
 * - Strip leading/trailing hyphens
 */
export function sanitizeTopicName(title: string): string {
  const words = title
    .toLowerCase()
    .replace(/_/g, "-") // factory-core-k7gy.13: preserve underscore-separated words
    .replace(/[^a-z0-9\s-]/g, "") // Strip non-alphanumeric except spaces and hyphens
    .split(/\s+/)
    .filter(w => w.length > 0)
    .slice(0, 5); // Max 5 words

  return words.join("-").replace(/^-+|-+$/g, "");
}

/**
 * Count how many leading hyphen-separated tokens of `a` also appear in the
 * same position of `b`. Used by findExistingDocPath to score candidate
 * matches — the file whose slug shares the longest prefix with the
 * derived slug is the best guess at what we meant.
 */
function sharedPrefixTokens(a: string, b: string): number {
  const aTokens = a.split("-");
  const bTokens = b.split("-");
  let n = 0;
  while (n < aTokens.length && n < bTokens.length && aTokens[n] === bTokens[n]) {
    n += 1;
  }
  return n;
}

/**
 * Resolve a document path, preferring an on-disk file when the naive path
 * doesn't exist. factory-core-k7gy.13.
 *
 * The naive derivation (sanitizeTopicName + suffix) often overshoots —
 * it uses 5 title words while the real file on disk was named with 3.
 * When that happens the agent falls back to Glob, which costs extra
 * tool-use turns. This helper does the Glob up-front.
 *
 * Strategy:
 *   1. If naivePath exists on disk, return it (the happy path).
 *   2. Otherwise scan searchDir for files ending in `suffix`.
 *   3. Pick the candidate whose stem shares the longest token-prefix
 *      with the derived slug, tie-breaking by shortest filename.
 *   4. If no candidate shares at least one leading token with the slug,
 *      fall back to the naive path (caller will handle the missing file).
 */
export async function findExistingDocPath(params: {
  naivePath: string;
  searchDir: string;
  slug: string;
  suffix: string;
}): Promise<string> {
  try {
    await fs.access(params.naivePath);
    return params.naivePath;
  } catch {
    /* not found — fall through to glob */
  }

  let entries: string[];
  try {
    entries = await fs.readdir(params.searchDir);
  } catch {
    return params.naivePath;
  }

  const candidates = entries.filter((name) => name.endsWith(params.suffix));
  if (candidates.length === 0) return params.naivePath;

  let best: { name: string; score: number } | undefined;
  for (const name of candidates) {
    const stem = name.slice(0, -params.suffix.length);
    const score = sharedPrefixTokens(stem, params.slug);
    if (score === 0) continue;
    if (
      !best ||
      score > best.score ||
      (score === best.score && name.length < best.name.length)
    ) {
      best = { name, score };
    }
  }

  return best ? path.join(params.searchDir, best.name) : params.naivePath;
}

/**
 * Resolve repository paths for a given epic based on ship type.
 *
 * @param shipType - The ship type (e.g., "ios-app", "venture", "internal")
 * @param epicTitle - The epic title
 * @param appName - The derived app name (PascalCase)
 * @param epicId - The epic ID
 * @param fleetCorePath - Path to fleet-core (usually FLEET_CORE_PATH)
 * @param productRepoBase - Base path for product repositories (default: "/Users/janemckay/dev/claude_projects")
 * @returns RepoPathResult with paths for repo, research, and plan
 */
export function resolveRepoPath(
  shipType: string,
  epicTitle: string,
  appName: string,
  epicId: string,
  fleetCorePath: string,
  productRepoBase: string = "/Users/janemckay/dev/claude_projects",
): RepoPathResult {
  // Venture: research-only in fleet-core
  // No specPath, architecturePath, or planPath — ventures skip PM and Architect
  if (shipType === "venture") {
    const topic = sanitizeTopicName(epicTitle);
    return {
      repoPath: fleetCorePath,
      repoName: "fleet-core",
      researchPath: `${fleetCorePath}/docs/research/${topic}.md`,
    };
  }

  // Internal: parse title to determine target repo
  if (shipType === "internal") {
    // If the epic lives in fleet-core beads, the repo is fleet-core
    // (even if the title mentions beads_web as part of the work)
    const isFleetCoreEpic = epicId.startsWith("factory-core");

    const lowerTitle = epicTitle.toLowerCase();
    const isBeadsWeb =
      !isFleetCoreEpic && (
        lowerTitle.includes("beads_web") ||
        lowerTitle.includes("dashboard") ||
        lowerTitle.includes("fleet board")
      );

    if (isBeadsWeb) {
      const topic = sanitizeTopicName(epicTitle);
      return {
        repoPath: `${productRepoBase}/beads_web`,
        repoName: "beads_web",
        researchPath: `${fleetCorePath}/docs/research/${topic}.md`,
        planPath: `${productRepoBase}/beads_web/.beads/plans/${epicId}.md`,
        specPath: `${fleetCorePath}/docs/research/${topic}-functional-spec.md`,
        architecturePath: `${fleetCorePath}/docs/research/${topic}-architecture.md`,
        testScenariosPath: `${fleetCorePath}/docs/research/${topic}-test-scenarios.md`,
      };
    } else {
      // Internal work on fleet-core itself
      const topic = sanitizeTopicName(epicTitle);
      return {
        repoPath: fleetCorePath,
        repoName: "fleet-core",
        researchPath: `${fleetCorePath}/docs/research/${topic}.md`,
        planPath: `${fleetCorePath}/.beads/plans/${epicId}.md`,
        specPath: `${fleetCorePath}/docs/research/${topic}-functional-spec.md`,
        architecturePath: `${fleetCorePath}/docs/research/${topic}-architecture.md`,
        testScenariosPath: `${fleetCorePath}/docs/research/${topic}-test-scenarios.md`,
      };
    }
  }

  // All other ship types: product repo
  const productRepoPath = `${productRepoBase}/${appName}`;
  return {
    repoPath: productRepoPath,
    repoName: appName,
    researchPath: `${fleetCorePath}/products/${appName}/research/report.md`,
    planPath: `${productRepoPath}/.beads/plans/${epicId}.md`,
    specPath: `${fleetCorePath}/products/${appName}/research/functional-spec.md`,
    architecturePath: `${fleetCorePath}/products/${appName}/research/architecture.md`,
    testScenariosPath: `${fleetCorePath}/products/${appName}/research/test-scenarios.md`,
  };
}
