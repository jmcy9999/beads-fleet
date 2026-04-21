// =============================================================================
// Tests for src/lib/wave-completeness.ts (factory-core-zszt.2)
// =============================================================================
// Covers the pure predicate `checkWaveCompleteness` against a handcrafted
// WaveStatus. The side-effectful `enforceWaveCompletenessOrDispatch` is
// covered at the integration surface via the chain handler tests; its
// behaviour is driven entirely off the predicate plus pipeline-labels +
// fetch (which are exercised elsewhere).
// =============================================================================

import { checkWaveCompleteness } from "@/lib/wave-completeness";
import type { WaveStatus } from "@/lib/agent-launcher";

function makeStatus(partial: Partial<WaveStatus>): WaveStatus {
  return {
    hasWaves: true,
    waves: new Map(),
    currentWave: 0,
    totalWaves: 0,
    currentWaveComplete: false,
    allWavesComplete: false,
    hasCheckpointRequired: false,
    totalChildren: 0,
    childrenWithWaveLabels: 0,
    closedWithoutWaveLabel: 0,
    ...partial,
  };
}

describe("checkWaveCompleteness", () => {
  test("legacy no-waves epic is treated as complete", () => {
    const result = checkWaveCompleteness(
      makeStatus({ hasWaves: false, allWavesComplete: false }),
    );
    expect(result).toEqual({ complete: true });
  });

  test("every wave closed returns complete=true", () => {
    const waves = new Map<number, { total: number; closed: number }>([
      [1, { total: 3, closed: 3 }],
      [2, { total: 2, closed: 2 }],
    ]);
    const result = checkWaveCompleteness(
      makeStatus({ hasWaves: true, waves, allWavesComplete: true }),
    );
    expect(result).toEqual({ complete: true });
  });

  test("single incomplete wave reports that wave as lowestOpen", () => {
    const waves = new Map<number, { total: number; closed: number }>([
      [1, { total: 3, closed: 3 }],
      [2, { total: 2, closed: 0 }],
    ]);
    const result = checkWaveCompleteness(
      makeStatus({ hasWaves: true, waves, allWavesComplete: false }),
    );
    expect(result.complete).toBe(false);
    expect(result.lowestOpenWave).toBe(2);
    expect(result.openBeadCount).toBe(2);
  });

  test("multiple incomplete waves — lowest N wins, openBeadCount sums them", () => {
    const waves = new Map<number, { total: number; closed: number }>([
      [1, { total: 3, closed: 3 }], // complete
      [2, { total: 4, closed: 1 }], // 3 open
      [3, { total: 2, closed: 0 }], // 2 open
      [4, { total: 1, closed: 0 }], // 1 open
    ]);
    const result = checkWaveCompleteness(
      makeStatus({ hasWaves: true, waves, allWavesComplete: false }),
    );
    expect(result.complete).toBe(false);
    expect(result.lowestOpenWave).toBe(2);
    expect(result.openBeadCount).toBe(6);
  });

  test("BreathCycle-shaped fixture (Wave 1 done, Waves 2-6 open) — diverts to Wave 2", () => {
    // jtjn dry-run: the actual state that exposed this invariant. Wave 1
    // built (3 beads closed), waves 2-6 planned but open.
    const waves = new Map<number, { total: number; closed: number }>([
      [1, { total: 3, closed: 3 }],
      [2, { total: 2, closed: 0 }],
      [3, { total: 2, closed: 0 }],
      [4, { total: 2, closed: 0 }],
      [5, { total: 2, closed: 0 }],
      [6, { total: 2, closed: 0 }],
    ]);
    const result = checkWaveCompleteness(
      makeStatus({ hasWaves: true, waves, allWavesComplete: false }),
    );
    expect(result.complete).toBe(false);
    expect(result.lowestOpenWave).toBe(2);
    expect(result.openBeadCount).toBe(10);
  });

  test("bd-failure propagates as error (do-not-advance contract)", () => {
    const result = checkWaveCompleteness(
      makeStatus({
        hasWaves: false,
        error: "bd list failed for epic X",
      }),
    );
    expect(result.complete).toBe(false);
    expect(result.error).toMatch(/bd list failed/);
  });

  test("inconsistent status (allWavesComplete=false but no open waves) is flagged", () => {
    // Defensive check: if WaveStatus is internally inconsistent, we treat it
    // as unknown rather than silently returning complete=true.
    const waves = new Map<number, { total: number; closed: number }>([
      [1, { total: 3, closed: 3 }],
    ]);
    const result = checkWaveCompleteness(
      makeStatus({ hasWaves: true, waves, allWavesComplete: false }),
    );
    expect(result.complete).toBe(false);
    expect(result.error).toMatch(/inconsistent WaveStatus/);
  });
});
