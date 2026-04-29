#!/usr/bin/env node
/**
 * bd-cross-repo — thin CLI wrapper for the /api/cross-repo/list route.
 *
 * Usage:
 *   node scripts/bd-cross-repo.ts --label=epic:factory-core-so74
 *   node scripts/bd-cross-repo.ts --label=epic:factory-core-so74 --status=all
 *
 * Env vars:
 *   BEADS_WEB_URL — orchestrator base URL (default: http://localhost:3010)
 *
 * Exits 0 on success (JSON to stdout), 1 on error (message to stderr).
 *
 * IMPORTANT: This script must NOT import from src/ — it runs via plain
 * `node` without Next.js/Webpack bundling. Uses only Node 18+ globals
 * (fetch) and stdlib.
 */

function parseArgs(argv: string[]): { label: string; status: string } {
  let label = "";
  let status = "open";

  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--label=")) {
      label = arg.slice("--label=".length);
    } else if (arg.startsWith("--status=")) {
      status = arg.slice("--status=".length);
    }
  }

  if (!label) {
    console.error("Error: --label=<label> is required.");
    console.error("Usage: node scripts/bd-cross-repo.ts --label=epic:factory-core-so74 [--status=open|closed|all]");
    process.exit(1);
  }

  return { label, status };
}

async function main(): Promise<void> {
  const { label, status } = parseArgs(process.argv);
  const baseUrl = process.env.BEADS_WEB_URL ?? "http://localhost:3010";
  const url = `${baseUrl}/api/cross-repo/list?label=${encodeURIComponent(label)}&status=${encodeURIComponent(status)}`;

  let response: Response;
  try {
    response = await fetch(url);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: orchestrator unreachable at ${baseUrl}`);
    console.error(`Detail: ${msg}`);
    process.exit(1);
  }

  const body = await response.text();

  if (!response.ok) {
    console.error(`Error: API returned ${response.status}`);
    console.error(body);
    process.exit(1);
  }

  // Pretty-print the JSON to stdout
  try {
    const json = JSON.parse(body);
    console.log(JSON.stringify(json, null, 2));
  } catch {
    // If not valid JSON, output raw
    console.log(body);
  }
}

main();
