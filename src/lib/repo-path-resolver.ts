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

export interface RepoPathResult {
  /** Absolute path to the repository where work happens */
  repoPath: string;
  /** Repository name (for display and agent context) */
  repoName: string;
  /** Absolute path to the research report/recon brief */
  researchPath: string;
  /** Absolute path to the build plan (undefined for ventures) */
  planPath?: string;
}

const FLEET_CORE_PATH = "/Users/janemckay/dev/fleet/fleet-core";
const PRODUCT_REPO_BASE = "/Users/janemckay/dev/claude_projects";

/**
 * Convert epic title to a filesystem-safe topic name.
 * - Lowercase
 * - Replace spaces/punctuation with hyphens
 * - Max 5 words
 * - Strip leading/trailing hyphens
 */
export function sanitizeTopicName(title: string): string {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "") // Strip non-alphanumeric except spaces and hyphens
    .split(/\s+/)
    .filter(w => w.length > 0)
    .slice(0, 5); // Max 5 words

  return words.join("-").replace(/^-+|-+$/g, "");
}

/**
 * Resolve repository paths for a given epic based on ship type.
 *
 * @param shipType - The ship type (e.g., "ios-app", "venture", "internal")
 * @param epicTitle - The epic title
 * @param appName - The derived app name (PascalCase)
 * @param epicId - The epic ID
 * @param fleetCorePath - Path to fleet-core (usually FLEET_CORE_PATH)
 * @returns RepoPathResult with paths for repo, research, and plan
 */
export function resolveRepoPath(
  shipType: string,
  epicTitle: string,
  appName: string,
  epicId: string,
  fleetCorePath: string,
): RepoPathResult {
  // Venture: research-only in fleet-core
  if (shipType === "venture") {
    const topic = sanitizeTopicName(epicTitle);
    return {
      repoPath: fleetCorePath,
      repoName: "fleet-core",
      researchPath: `${fleetCorePath}/docs/research/${topic}.md`,
      // No plan path for ventures
    };
  }

  // Internal: parse title to determine target repo
  if (shipType === "internal") {
    const lowerTitle = epicTitle.toLowerCase();
    const isBeadsWeb =
      lowerTitle.includes("beads_web") ||
      lowerTitle.includes("dashboard") ||
      lowerTitle.includes("fleet board");

    if (isBeadsWeb) {
      const topic = sanitizeTopicName(epicTitle);
      return {
        repoPath: `${PRODUCT_REPO_BASE}/beads_web`,
        repoName: "beads_web",
        researchPath: `${fleetCorePath}/docs/research/${topic}.md`,
        planPath: `${PRODUCT_REPO_BASE}/beads_web/.beads/plans/${epicId}.md`,
      };
    } else {
      // Internal work on fleet-core itself
      const topic = sanitizeTopicName(epicTitle);
      return {
        repoPath: fleetCorePath,
        repoName: "fleet-core",
        researchPath: `${fleetCorePath}/docs/research/${topic}.md`,
        planPath: `${fleetCorePath}/.beads/plans/${epicId}.md`,
      };
    }
  }

  // All other ship types: product repo
  const productRepoPath = `${PRODUCT_REPO_BASE}/${appName}`;
  return {
    repoPath: productRepoPath,
    repoName: appName,
    researchPath: `${fleetCorePath}/products/${appName}/research/report.md`,
    planPath: `${productRepoPath}/.beads/plans/${epicId}.md`,
  };
}
