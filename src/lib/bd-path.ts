// =============================================================================
// Beads Fleet — bd CLI Path Resolution
// =============================================================================
//
// Centralised resolution for the `bd` binary path. The Homebrew-installed bd
// at /opt/homebrew/bin/bd includes CGO/Dolt support. When Next.js spawns bd
// as a subprocess, it may resolve a different binary (e.g. an npm shim) that
// lacks Dolt support. Using the absolute path avoids this.
//
// Override with BD_PATH env var if bd is installed elsewhere.
// =============================================================================

import { existsSync } from "fs";

const HOMEBREW_BD = "/opt/homebrew/bin/bd";

/**
 * Returns the absolute path to the `bd` CLI binary.
 * Prefers BD_PATH env var, then Homebrew location, then bare "bd" (PATH lookup).
 */
export function getBdPath(): string {
  if (process.env.BD_PATH) return process.env.BD_PATH;
  if (existsSync(HOMEBREW_BD)) return HOMEBREW_BD;
  return "bd";
}

/**
 * Returns a sanitised env for bd subprocesses.
 * Strips BEADS_NO_DAEMON to ensure bd uses daemon RPC (not direct Dolt access).
 */
export function getBdEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env, NO_COLOR: "1" };
  delete env.BEADS_NO_DAEMON;
  return env;
}
