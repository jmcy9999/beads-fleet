/**
 * Smoke-test freshness gate (factory-core-zszt.4).
 *
 * Closes the iOS runtime-verification loop at the submission-prep boundary:
 * an iOS or macOS epic must not transition to `pipeline:submission-prep`
 * unless the most recent smoke-test artefact in its product repo shows
 * verdict=PASS and was generated within a configurable freshness window.
 *
 * Why this lives as a separate guard (vs just trusting the smoke-test
 * chain handler in agent-launcher.ts): every rgqd-era fix produced an
 * artefact and a stage, but nothing enforces that the artefact is still
 * valid by the time the epic reaches submission-prep. A bug-fix round in
 * QA or polish might land code that breaks launch; without re-running
 * smoke-test, the epic advances to submission with an outdated pass.
 * This gate makes the pass explicit — "the last smoke-test we ran on
 * this code still says it launches cleanly."
 *
 * Artefact contract: smoke-test.sh writes `<repoPath>/smoke-test.json`
 * with fields { verdict: "PASS" | "FAIL", exitCode: number,
 * finishedAt: ISO-8601, ... }. See tools/platforms/ios/smoke-test.sh.
 *
 * Behaviour:
 *   - Non-iOS/macOS ship types: pass through (ok=true) — no runtime gate.
 *   - iOS/macOS, artefact missing: fail — "no smoke-test has run".
 *   - iOS/macOS, verdict=FAIL: fail — "last smoke-test failed".
 *   - iOS/macOS, verdict=PASS but stale: fail — "last pass is too old".
 *   - iOS/macOS, verdict=PASS and fresh: ok.
 */

import { promises as fs } from "fs";
import * as path from "path";

/**
 * Default freshness window: 30 minutes. The QA → polish → QA bounce for
 * iOS can take multiple hours if each round spawns fresh agents; a long
 * window would let a stale smoke-test carry forward through multiple
 * rounds of bug fixes. 30 min is long enough that a typical round-trip
 * won't expire a still-valid pass, short enough that serious drift
 * forces a re-run.
 */
export const DEFAULT_SMOKE_TEST_MAX_AGE_MINUTES = 30;

export interface SmokeTestFreshnessResult {
  /** True when the gate allows submission-prep; false blocks it. */
  ok: boolean;
  /** Populated when !ok — human-readable block reason. */
  reason?: string;
  /** Populated when !ok — machine-readable failure class. */
  class?:
    | "not-applicable"
    | "artefact-missing"
    | "artefact-unreadable"
    | "verdict-fail"
    | "verdict-missing"
    | "stale";
  /** Age of the artefact in minutes, when readable. */
  ageMinutes?: number;
}

/**
 * Check whether a product's latest smoke-test artefact authorises a
 * submission-prep transition for that ship type.
 *
 * @param shipType — epic's ship-type label value (e.g. "ios-app",
 *   "macos-app", "web-app"). Non-iOS/macOS types pass through.
 * @param repoPath — absolute path to the product's repo, where the
 *   smoke-test artefact lives as `${repoPath}/smoke-test.json`.
 * @param maxAgeMinutes — optional override; defaults to
 *   DEFAULT_SMOKE_TEST_MAX_AGE_MINUTES.
 */
export async function checkSmokeTestFreshness(
  shipType: string,
  repoPath: string,
  maxAgeMinutes: number = DEFAULT_SMOKE_TEST_MAX_AGE_MINUTES,
): Promise<SmokeTestFreshnessResult> {
  const requiresSmoke = shipType === "ios-app" || shipType === "macos-app";
  if (!requiresSmoke) {
    return { ok: true, class: "not-applicable" };
  }

  const artefactPath = path.join(repoPath, "smoke-test.json");

  let raw: string;
  try {
    raw = await fs.readFile(artefactPath, "utf-8");
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        ok: false,
        class: "artefact-missing",
        reason: `smoke-test artefact not found at ${artefactPath} — no runtime verification has run for this epic`,
      };
    }
    return {
      ok: false,
      class: "artefact-unreadable",
      reason: `failed to read smoke-test artefact at ${artefactPath}: ${errMsg}`,
    };
  }

  let parsed: {
    verdict?: string;
    exitCode?: number;
    finishedAt?: string;
  };
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      class: "artefact-unreadable",
      reason: `smoke-test artefact at ${artefactPath} is not valid JSON: ${errMsg}`,
    };
  }

  if (parsed.verdict !== "PASS") {
    return {
      ok: false,
      class: "verdict-fail",
      reason: `last smoke-test at ${artefactPath} has verdict=${parsed.verdict ?? "<missing>"}, exitCode=${parsed.exitCode ?? "<missing>"}`,
    };
  }

  if (!parsed.finishedAt) {
    return {
      ok: false,
      class: "verdict-missing",
      reason: `smoke-test artefact at ${artefactPath} is missing finishedAt timestamp`,
    };
  }

  const finishedMs = Date.parse(parsed.finishedAt);
  if (Number.isNaN(finishedMs)) {
    return {
      ok: false,
      class: "artefact-unreadable",
      reason: `smoke-test artefact at ${artefactPath} has unparseable finishedAt=${parsed.finishedAt}`,
    };
  }
  const ageMinutes = (Date.now() - finishedMs) / 60000;
  if (ageMinutes > maxAgeMinutes) {
    return {
      ok: false,
      class: "stale",
      reason: `last smoke-test at ${artefactPath} passed but is ${ageMinutes.toFixed(1)} min old (max ${maxAgeMinutes} min) — re-run smoke-test before submission-prep`,
      ageMinutes,
    };
  }

  return { ok: true, ageMinutes };
}
