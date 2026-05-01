import { NextResponse } from "next/server";

/**
 * GET /api/version — Returns build metadata for prod-bundle staleness detection.
 *
 * `gitSha` and `buildTime` are injected at `next build` time via `next.config.mjs`
 * env block. In dev mode (or if env vars are unset), they gracefully fall back
 * to `"unknown"` so the smoke-check comparison correctly flags a mismatch.
 *
 * `packageVersion` is read from package.json at build time via static import.
 */

import pkg from "../../../../package.json";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const gitSha = process.env.GIT_SHA || "unknown";
  const buildTime = process.env.BUILD_TIME || "unknown";
  const packageVersion: string = pkg.version;

  return NextResponse.json({ gitSha, buildTime, packageVersion });
}
