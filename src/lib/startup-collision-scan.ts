// =============================================================================
// Startup Bead-ID Collision Scan (A.6 — Diagnostic, Non-Blocking)
// =============================================================================
//
// Scans all registered repos for bead-ID collisions at boot time. Bead IDs are
// assumed globally unique (they include a repo prefix like `factory-core-`,
// `beads_web-`, etc.). A collision means either operator-induced data error or
// registry corruption — not a normal state. This scan catches that at boot
// rather than mid-dispatch.
//
// Complements A.1's runtime collision detection (`isAgentActive` throws on
// active collision during dispatch); this scan catches dormant collisions.
//
// Non-blocking: invoked via fire-and-forget from instrumentation.ts. Does NOT
// block startup, mutate state, or feed back into the dispatcher.
// =============================================================================

import { getAllRepoPaths } from "./repo-config";
import { getPlan } from "./bv-client";
import type { RobotPlan } from "./types";

/**
 * Scan all registered repos for bead-ID collisions (bead IDs appearing in
 * more than one repo's issue set). Logs warnings to console if collisions
 * are found; logs a clean-registry message otherwise.
 *
 * Uses `Promise.allSettled` so that per-repo failures are handled gracefully:
 * if `getPlan(repoPath)` fails for one repo, a warning is logged and the
 * scan continues with the remaining repos.
 */
export async function scanForBeadIdCollisions(): Promise<void> {
  const startMs = Date.now();

  let repoPaths: string[];
  try {
    repoPaths = await getAllRepoPaths();
  } catch (err) {
    console.warn(
      "[COLLISION SCAN] Failed to read repo paths, skipping scan:",
      err instanceof Error ? err.message : err,
    );
    return;
  }

  if (repoPaths.length === 0) {
    console.log("[COLLISION SCAN] No repos registered, skipping scan.");
    return;
  }

  // Fetch plans for all repos concurrently, tolerating per-repo failures.
  const results = await Promise.allSettled(
    repoPaths.map((repoPath) => getPlan(repoPath)),
  );

  // Build Map<beadId, repoPath[]> from the union of all repos' all_issues arrays.
  const beadIdToRepos = new Map<string, string[]>();
  let scannedRepoCount = 0;

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const repoPath = repoPaths[i];

    if (result.status === "rejected") {
      console.warn(
        `[COLLISION SCAN] Failed to read plan for repo ${repoPath}:`,
        result.reason instanceof Error ? result.reason.message : result.reason,
      );
      continue;
    }

    scannedRepoCount++;
    const plan: RobotPlan = result.value;

    for (const issue of plan.all_issues) {
      const existing = beadIdToRepos.get(issue.id);
      if (existing) {
        // Only add if this repo isn't already listed for this bead ID
        if (!existing.includes(repoPath)) {
          existing.push(repoPath);
        }
      } else {
        beadIdToRepos.set(issue.id, [repoPath]);
      }
    }
  }

  // Find collisions: bead IDs appearing in more than one repo.
  const collisions: Array<{ beadId: string; repos: string[] }> = [];
  for (const [beadId, repos] of beadIdToRepos) {
    if (repos.length > 1) {
      collisions.push({ beadId, repos });
    }
  }

  const elapsedMs = Date.now() - startMs;

  if (collisions.length > 0) {
    console.warn(
      `[COLLISION SCAN] Found ${collisions.length} bead-ID collisions at startup:`,
    );
    for (const { beadId, repos } of collisions) {
      console.warn(`  - ${beadId} in repos: ${repos.join(", ")}`);
    }

    // beads_web-8wh redesign (ADR-002): persist collision findings to the
    // reconciler event log so the operator can audit them even if not
    // watching the terminal at boot. console.warn alone is transient;
    // event log entries are persistent + queryable via reconciler status.
    // Failure to write the event log is non-fatal — the scan's primary
    // visibility (console.warn above) is unaffected.
    try {
      const repoPath =
        process.env.FLEET_CORE_PATH ?? "/Users/janemckay/dev/fleet/fleet-core-improved";
      const { appendEvent } = await import("./event-log");
      await appendEvent(repoPath, {
        type: "collision-detected",
        epicId: "__collision-scan__",
        payload: {
          collisions: collisions.map((c) => ({ beadId: c.beadId, repos: c.repos })),
          scannedRepoCount,
          detectedAt: new Date().toISOString(),
        },
      });
    } catch (err) {
      console.warn(
        "[COLLISION SCAN] Failed to write event log (non-fatal):",
        err instanceof Error ? err.message : err,
      );
    }
  } else {
    console.log(
      `[COLLISION SCAN] No bead-ID collisions found across ${scannedRepoCount} repos.`,
    );
  }

  console.log(`[COLLISION SCAN] Completed in ${elapsedMs}ms across ${scannedRepoCount} repos.`);
}
