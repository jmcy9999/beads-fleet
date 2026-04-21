/**
 * Wave-completeness invariant (factory-core-zszt.2).
 *
 * The Shipyard plans work into waves: wave:1, wave:2, ... wave:N. A pipeline
 * advance past `pipeline:development` is only meaningful if every planned
 * wave has been built. Before zszt.2 this invariant was only enforced at one
 * point — the reviewer's "final wave" branch — and relied on the reviewer
 * successfully running for every wave. If an upstream drop (e.g. 8sz5's
 * flush-exit failure) skipped a wave review, or if the owner clicked a
 * dashboard CTA that advanced the pipeline manually, the epic could reach
 * `pipeline:qa` or `pipeline:submission-prep` with open wave beads — the
 * factory would then declare the app "ready" with most of the plan unbuilt.
 *
 * This utility centralises the check. It has two entry points:
 *   - `checkWaveCompleteness(waveStatus)` — pure predicate over an existing
 *     WaveStatus snapshot, used inside handleChainAction where we already
 *     hold an atomic snapshot (ppx.6 contract — no TOCTOU between read and
 *     transition).
 *   - `enforceWaveCompletenessOrDispatch(...)` — side-effectful gate used at
 *     the "leave development" boundaries (QA PASS, ux-polish PASS). When the
 *     invariant fails it rolls the pipeline label back to
 *     `pipeline:development`, dispatches `start-wave` for the lowest open
 *     wave, and tells the caller to stop advancing.
 *
 * Out of scope:
 *   - Retrying start-wave on dispatch failure (caller handles)
 *   - Deciding whether to re-use an in-flight builder (start-wave handles)
 */

import type { WaveStatus } from "./agent-launcher";

export interface WaveCompletenessCheck {
  /** True when every wave has (closed === total) or the epic has no waves. */
  complete: boolean;
  /** Lowest wave number with at least one open bead. Only set when !complete. */
  lowestOpenWave?: number;
  /** Total open beads across all incomplete waves. Only set when !complete. */
  openBeadCount?: number;
  /** Set when wave state could not be determined (bd failure). Caller must
   *  treat this as "unknown — do not advance" per regression pattern #13. */
  error?: string;
}

/**
 * Pure predicate — classify a WaveStatus into complete / incomplete / unknown.
 *
 * Legacy no-wave epics (hasWaves === false) are treated as complete so that
 * pre-wave-planner epics still flow through the pipeline unchanged.
 */
export function checkWaveCompleteness(
  waveStatus: WaveStatus,
): WaveCompletenessCheck {
  if (waveStatus.error) {
    return { complete: false, error: waveStatus.error };
  }
  if (!waveStatus.hasWaves) {
    return { complete: true };
  }
  if (waveStatus.allWavesComplete) {
    return { complete: true };
  }

  let lowestOpen = Infinity;
  let openCount = 0;
  for (const [waveNum, entry] of waveStatus.waves) {
    const open = entry.total - entry.closed;
    if (open > 0) {
      openCount += open;
      if (waveNum < lowestOpen) lowestOpen = waveNum;
    }
  }

  // Defensive: allWavesComplete was false but we found no open beads. Treat
  // as unknown rather than silently advancing.
  if (lowestOpen === Infinity) {
    return {
      complete: false,
      error:
        "checkWaveCompleteness: allWavesComplete=false but no open waves found — inconsistent WaveStatus",
    };
  }

  return { complete: false, lowestOpenWave: lowestOpen, openBeadCount: openCount };
}

export interface EnforceOptions {
  epicId: string;
  epicTitle: string;
  epicLabels: string[];
  waveStatus: WaveStatus;
  /**
   * Human-readable label for the transition being blocked (e.g.
   * "qa-pass -> submission-prep"). Appears in the log line so audits of
   * wave-completeness interventions can tell which call site fired.
   */
  intendedTransition: string;
  /**
   * Labels to remove from the epic when rolling back to development. Callers
   * name the specific `pipeline:*` / `qa:*` / `submission:*` labels relevant
   * to their branch so this utility does not need to know every pipeline
   * vocabulary surface.
   */
  rollbackRemoveLabels: string[];
  /**
   * Base URL for the dashboard action endpoint. Extracted so tests can
   * override; production code calls with the usual `http://localhost:3000`.
   */
  actionUrl?: string;
}

export interface EnforceResult {
  /** True when the gate intercepted — caller must NOT continue its advance. */
  intercepted: boolean;
  /** The wave we dispatched start-wave for (when intercepted & no error). */
  dispatchedWave?: number;
  /** Error text when the gate could not safely decide (bd failure etc.). */
  error?: string;
}

/**
 * Gate at pipeline-advance boundaries. When waves are incomplete, rolls the
 * pipeline label back to `pipeline:development`, dispatches `start-wave` for
 * the lowest open wave, and returns intercepted=true. When the invariant
 * holds (or an unknown state forbids advancement), returns appropriately so
 * the caller can react.
 *
 * Behaviour table:
 *   | waveStatus state        | result                                    |
 *   |-------------------------|-------------------------------------------|
 *   | complete                | intercepted=false (caller proceeds)       |
 *   | no waves (legacy)       | intercepted=false (caller proceeds)       |
 *   | incomplete, known waves | intercepted=true, start-wave dispatched   |
 *   | unknown (bd failure)    | intercepted=true, no dispatch, error set  |
 */
export async function enforceWaveCompletenessOrDispatch(
  opts: EnforceOptions,
): Promise<EnforceResult> {
  const check = checkWaveCompleteness(opts.waveStatus);

  if (check.complete) {
    return { intercepted: false };
  }

  if (check.error) {
    console.error(
      `[wave-completeness] ${opts.intendedTransition} for ${opts.epicId}: ` +
        `cannot determine wave state (${check.error}) — refusing to advance (fail-safe)`,
    );
    return { intercepted: true, error: check.error };
  }

  const lowestOpen = check.lowestOpenWave!;
  const openCount = check.openBeadCount!;

  console.log(
    `[wave-completeness] ${opts.intendedTransition} for ${opts.epicId}: ` +
      `blocking advance — ${openCount} bead(s) open across incomplete waves, lowest=wave:${lowestOpen}. ` +
      `Rolling pipeline label back to development and dispatching start-wave ${lowestOpen}.`,
  );

  try {
    const { addLabelsToEpic, removeLabelsFromEpic } = await import(
      "./pipeline-labels"
    );
    if (opts.rollbackRemoveLabels.length > 0) {
      await removeLabelsFromEpic(opts.epicId, opts.rollbackRemoveLabels);
    }
    await addLabelsToEpic(opts.epicId, ["pipeline:development"]);
  } catch (err) {
    console.error(
      `[wave-completeness] ${opts.intendedTransition} for ${opts.epicId}: ` +
        `failed to roll back labels — ${err instanceof Error ? err.message : String(err)}. ` +
        `Dispatching start-wave anyway.`,
    );
  }

  const url = opts.actionUrl ?? "http://localhost:3000/api/fleet/action";
  try {
    const res = await fetch(`${url}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "start-wave",
        epicId: opts.epicId,
        epicTitle: opts.epicTitle,
        currentLabels: opts.epicLabels,
        waveNumber: lowestOpen,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "<unreadable>");
      const errMsg = `start-wave dispatch for ${opts.epicId} wave:${lowestOpen} returned HTTP ${res.status}: ${body}`;
      console.error(`[wave-completeness] ${errMsg}`);
      return { intercepted: true, error: errMsg };
    }
  } catch (err) {
    const errMsg = `start-wave dispatch for ${opts.epicId} wave:${lowestOpen} threw: ${
      err instanceof Error ? err.message : String(err)
    }`;
    console.error(`[wave-completeness] ${errMsg}`);
    return { intercepted: true, error: errMsg };
  }

  return { intercepted: true, dispatchedWave: lowestOpen };
}
