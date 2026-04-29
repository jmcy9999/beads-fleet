// =============================================================================
// Beads Fleet — Dolt Health Probe (TCP-only reachability)
// =============================================================================
//
// Purpose: separate "is the repo reachable?" from "can we query the repo?".
// The former is a TCP probe (fast, ~50ms on a dead repo). The latter requires
// a MySQL handshake (slow, ~3s timeout on a dead repo). The dashboard's
// repo-health check formerly did the slow handshake even when the only
// signal needed was reachable/unreachable, paying ~3s × N-dead-repos on
// every render.
//
// Source pattern: ported from migration/scripts/probe-dolt-reachability.ts
// in fleet-core-improved. The category enum is the contract; preserved for
// callers that want a discriminated union.
//
// Cache: per-(host, port) for 30s. Within a single dashboard render, multiple
// callers querying the same probe target hit the cache. Across renders,
// the 30s TTL aligns with the dashboard's typical refetch cadence.
//
// Bead: factory-core-3p1e.5 (Phase 2 Bucket B Item 5).
// =============================================================================

import { createConnection } from "node:net";

/**
 * Categories from the source script. TCP probes can only return:
 *   - reachable, connection_refused, timeout, dns
 * The remaining categories (auth_failed, query_failed, no_port_file) are
 * preserved in the union for parity with `probe-dolt-reachability.ts`
 * callers; they are NEVER returned by `probeDolt` (TCP probes don't speak
 * MySQL or read port files).
 */
export type ProbeCategory =
  | "reachable"
  | "connection_refused"
  | "timeout"
  | "dns"
  | "auth_failed"
  | "query_failed"
  | "no_port_file";

export interface ProbeResult {
  readonly host: string;
  readonly port: number;
  readonly category: ProbeCategory;
  readonly latencyMs: number;
  readonly error?: string;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 30_000;

interface CacheEntry {
  readonly result: ProbeResult;
  readonly cachedAt: number;
}

/**
 * Module-scoped cache keyed by `host|port`. The cache is per-process; in
 * Next.js dev mode HMR may reset it. Production builds do not reset.
 *
 * Exposed for tests via `clearProbeCache`. Direct mutation by callers is
 * not supported.
 */
const probeCache = new Map<string, CacheEntry>();

function cacheKey(host: string, port: number): string {
  return `${host}|${port}`;
}

/**
 * Clear the probe cache. Test-only — production callers rely on TTL
 * eviction and should not invalidate the cache directly.
 */
export function clearProbeCache(): void {
  probeCache.clear();
}

/**
 * Pure TCP probe: opens a socket, waits for connect or error/timeout, closes
 * immediately. No MySQL handshake, no auth — just "is the port open?".
 *
 * @param host - target host (e.g. "127.0.0.1" or "localhost")
 * @param port - TCP port (1-65535; out-of-range ports return non-reachable)
 * @param timeoutMs - max wall-clock to wait; defaults to 5000ms. Values <= 0
 *                   coerce to the default (avoids hanging on bad input).
 * @returns ProbeResult with category + latencyMs + optional error message.
 *
 * The function never throws — every error path returns a non-reachable
 * category with the underlying error preserved in `error?`. This is
 * deliberate: callers should branch on `category` exhaustively, not on
 * try/catch (regression pattern #13 — silent exception swallowing).
 *
 * Cache: results are cached per-(host, port) for 30s. Within the TTL, the
 * cached result is returned without opening a new socket. Cached errors
 * are NOT eagerly cleared on success — the cache holds the last
 * deterministic outcome for the TTL window.
 */
export async function probeDolt(
  host: string,
  port: number,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<ProbeResult> {
  // Guard: invalid bounds — no socket open, fast non-reachable.
  if (!host || host.trim() === "") {
    return {
      host,
      port,
      category: "dns",
      latencyMs: 0,
      error: "empty host",
    };
  }
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    return {
      host,
      port,
      category: "connection_refused",
      latencyMs: 0,
      error: `port out of range: ${port}`,
    };
  }

  // Coerce non-positive timeouts to default (avoid hanging on bad input).
  const effectiveTimeout =
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;

  // Cache lookup
  const key = cacheKey(host, port);
  const cached = probeCache.get(key);
  const now = Date.now();
  if (cached && now - cached.cachedAt < CACHE_TTL_MS) {
    return cached.result;
  }

  // Fresh probe
  const start = now;
  const result = await new Promise<ProbeResult>((resolve) => {
    let settled = false;
    const settle = (r: ProbeResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    const socket = createConnection({ host, port });
    socket.setTimeout(effectiveTimeout);

    socket.once("connect", () => {
      const latencyMs = Date.now() - start;
      socket.end();
      socket.destroy();
      settle({ host, port, category: "reachable", latencyMs });
    });

    socket.once("timeout", () => {
      const latencyMs = Date.now() - start;
      socket.destroy();
      settle({
        host,
        port,
        category: "timeout",
        latencyMs,
        error: `connect timed out after ${effectiveTimeout}ms`,
      });
    });

    socket.once("error", (err: NodeJS.ErrnoException) => {
      const latencyMs = Date.now() - start;
      socket.destroy();
      const code = err.code ?? "";
      let category: ProbeCategory;
      if (code === "ECONNREFUSED") {
        category = "connection_refused";
      } else if (code === "ETIMEDOUT" || /timeout/i.test(err.message ?? "")) {
        category = "timeout";
      } else if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
        category = "dns";
      } else {
        // Unknown errno — categorise as connection_refused with the
        // underlying error preserved. Do NOT silently report "reachable"
        // (pattern #13 anti-pattern).
        category = "connection_refused";
      }
      settle({
        host,
        port,
        category,
        latencyMs,
        error: `${code}: ${err.message ?? "unknown"}`,
      });
    });
  });

  probeCache.set(key, { result, cachedAt: Date.now() });
  return result;
}
