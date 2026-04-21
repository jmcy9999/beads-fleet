/**
 * Reconciler bootstrap (factory-core-lfcf, hotfix 3).
 *
 * Lazy-initializes the global reconciler on first call. Designed to be
 * invoked from route handlers (which are unambiguously Node-runtime in
 * Next.js) rather than from instrumentation.ts (which Next.js compiles
 * for BOTH node and edge targets, causing child_process bundling
 * failures in the edge build).
 *
 * Idempotent: subsequent calls are no-ops once the reconciler is up.
 * The bootstrap is called opportunistically — e.g. on the first request
 * to the fleet action endpoint or the reconciler status endpoint — so
 * the reconciler starts running as soon as the server actually handles
 * pipeline traffic. For a completely idle server this means the
 * reconciler doesn't spin up until something asks it to, which is fine:
 * there are no pipeline events to reconcile in that state anyway.
 */

import { initReconciler, getGlobalReconciler } from "./reconciler";
import { buildMissedWaveReviewDispatchRule } from "./reconciler-rules/missed-wave-review-dispatch";
import { buildStuckInStageRule } from "./reconciler-rules/stuck-in-stage";
import { buildWaveBeadMismatchRule } from "./reconciler-rules/wave-bead-mismatch";
import { buildRepeatedQaRoundRule } from "./reconciler-rules/repeated-qa-round";
import { buildCoherenceEscalationRule } from "./reconciler-rules/coherence-escalation";
import { buildRepeatDispatchEscalationRule } from "./reconciler-rules/repeat-dispatch-escalation";
import { readEpicState } from "./agent-launcher";
import { appendEvent, readEvents } from "./event-log";
import { execSync } from "child_process";
import { getBdPath, getBdEnv } from "./bd-path";

/**
 * Idempotent bootstrap. Call freely from any route handler or server
 * component — subsequent calls after the first return immediately.
 * Swallows errors by design; the reconciler is defence-in-depth, not a
 * hard requirement, and a failed bootstrap must not break the route
 * that triggered it.
 *
 * zsjv hotfix 2026-04-21: the "already bootstrapped" check lives on
 * the global reconciler singleton (from reconciler.ts) rather than a
 * module-local `bootstrapped` flag. Next.js dev hot-reloads can reset
 * module-local state, causing redundant re-initialisations — each one
 * stopping the prior reconciler's interval but NOT its in-flight tick
 * (which is awaiting a long fetch). Result: ticks from 2+ reconciler
 * instances interleave, all writing action-taken events, idempotency
 * fails. Anchoring the guard to the singleton that reconciler.ts
 * maintains means the check survives hot reloads of THIS module.
 */
export function ensureReconcilerRunning(): void {
  if (getGlobalReconciler()) return;
  try {
    const repoPath =
      process.env.FLEET_CORE_PATH ?? "/Users/janemckay/dev/fleet/fleet-core";
    const rec = initReconciler(repoPath);

    // Register the one production rule. When more rules arrive, add
    // them here — keeps the wiring in one place.
    rec.registerRule(
      buildMissedWaveReviewDispatchRule({
        readEpicSnapshot: async (epicId: string) => {
          const snap = await readEpicState(epicId, repoPath);
          return {
            waveStatus: {
              hasWaves: snap.waveStatus.hasWaves,
              currentWave: snap.waveStatus.currentWave,
              allWavesComplete: snap.waveStatus.allWavesComplete,
              error: snap.waveStatus.error,
            },
            openBugCount: snap.openBugCount,
            labels: snap.labels,
            title: epicId,
          };
        },
      }),
    );

    // factory-core-zsjv.1: stuck-in-stage detector — generalises the
    // missed-wave-review recovery pattern to every pipeline stage.
    rec.registerRule(
      buildStuckInStageRule({
        readEpicSnapshot: async (epicId: string) => {
          const snap = await readEpicState(epicId, repoPath);
          const pipelineLabel = snap.labels.find((l) =>
            l.startsWith("pipeline:"),
          );
          const currentStage = pipelineLabel
            ? pipelineLabel.replace("pipeline:", "")
            : null;
          const hasAgentRunning = snap.labels.includes("agent:running");
          const currentWave = snap.waveStatus.hasWaves
            ? snap.waveStatus.currentWave
            : undefined;
          return {
            currentStage,
            hasAgentRunning,
            labels: snap.labels,
            title: epicId,
            currentWave,
          };
        },
      }),
    );

    // factory-core-zsjv.2: wave-bead-mismatch detector — catches epics
    // that advanced past development while wave beads remained open.
    // Rolls the epic back to pipeline:development + re-dispatches
    // start-wave for the lowest open wave.
    rec.registerRule(
      buildWaveBeadMismatchRule({
        readEpicSnapshot: async (epicId: string) => {
          const snap = await readEpicState(epicId, repoPath);
          const pipelineLabel = snap.labels.find((l) =>
            l.startsWith("pipeline:"),
          );
          const currentStage = pipelineLabel
            ? pipelineLabel.replace("pipeline:", "")
            : null;
          // Derive lowestOpenWave from the waveStatus map.
          let lowestOpenWave: number | undefined;
          if (snap.waveStatus.hasWaves && !snap.waveStatus.allWavesComplete) {
            for (const [n, entry] of snap.waveStatus.waves) {
              if (entry.closed < entry.total) {
                if (lowestOpenWave === undefined || n < lowestOpenWave) {
                  lowestOpenWave = n;
                }
              }
            }
          }
          return {
            currentStage,
            lowestOpenWave,
            allWavesComplete: snap.waveStatus.allWavesComplete,
            hasWaves: snap.waveStatus.hasWaves,
            waveStatusError: snap.waveStatus.error,
            labels: snap.labels,
            title: epicId,
          };
        },
      }),
    );

    // factory-core-zsjv.3: repeated-QA-round detector — catches QA
    // loops that aren't converging after 5 rounds. Flags the epic for
    // human attention (v1 threshold flag; v2 zsjv.4 escalates to the
    // coherence agent for LLM-judgment).
    rec.registerRule(
      buildRepeatedQaRoundRule({
        readEpicSnapshot: async (epicId: string) => {
          const snap = await readEpicState(epicId, repoPath);
          const pipelineLabel = snap.labels.find((l) =>
            l.startsWith("pipeline:"),
          );
          const currentStage = pipelineLabel
            ? pipelineLabel.replace("pipeline:", "")
            : null;
          // Highest qa:round-N label — "highest" so we detect the latest
          // round even if earlier round labels are also present.
          let highestQaRound = 0;
          for (const l of snap.labels) {
            const m = l.match(/^qa:round-(\d+)$/);
            if (m) {
              const n = parseInt(m[1], 10);
              if (!Number.isNaN(n) && n > highestQaRound) highestQaRound = n;
            }
          }
          const hasNeedsHuman = snap.labels.includes("review:needs-human");
          return {
            currentStage,
            highestQaRound,
            openBugCount: snap.openBugCount,
            hasNeedsHuman,
            labels: snap.labels,
            title: epicId,
          };
        },
      }),
    );

    // factory-core-zsjv.4 — coherence escalation rule: dispatches the
    // coherence agent for epics flagged review:needs-human.
    rec.registerRule(
      buildCoherenceEscalationRule({
        readEpicSnapshot: async (epicId: string) => {
          const snap = await readEpicState(epicId, repoPath);
          return {
            hasNeedsHuman: snap.labels.includes("review:needs-human"),
            labels: snap.labels,
            title: epicId,
          };
        },
      }),
    );

    // factory-core-zsjv.6 — repeat-dispatch-escalation: when the same
    // (epic, stage) has been the target of stuck-in-stage recoveries
    // 3+ times in the last hour, mechanical re-dispatch isn't unsticking
    // the epic. Dispatch the coherence agent to diagnose.
    rec.registerRule(
      buildRepeatDispatchEscalationRule({
        readEpicSnapshot: async (epicId: string) => {
          const snap = await readEpicState(epicId, repoPath);
          const pipelineLabel = snap.labels.find((l) =>
            l.startsWith("pipeline:"),
          );
          const currentStage = pipelineLabel
            ? pipelineLabel.replace("pipeline:", "")
            : null;
          return {
            currentStage,
            labels: snap.labels,
            title: epicId,
          };
        },
      }),
    );

    rec.start();
    console.log("[reconciler-bootstrap] reconciler started from route handler");

    // factory-core-zsjv (Jane 2026-04-21): seed the event log with
    // "epic-observed" events for every currently-open pipeline:* epic.
    // Without this, rules only see epics referenced in events from the
    // last 60 min — anything stuck BEFORE the reconciler started is
    // invisible. The synthetic events are dated 20 min ago so stall
    // detection (15 min threshold) catches them on the first tick.
    // Dedupe: check the log for a synthetic event for the same epic
    // within the last 24 h before appending a new one.
    void seedOpenEpicsFromBd(repoPath);
  } catch (err) {
    console.error(
      "[reconciler-bootstrap] init failed — will retry on next call:",
      err instanceof Error ? err.message : err,
    );
    // The global reconciler may or may not be set depending on where
    // init failed. getGlobalReconciler() is the source of truth — if
    // it's still null, the next ensureReconcilerRunning() call retries.
  }
}

/**
 * For tests only: reset the bootstrap flag and stop the global reconciler
 * so subsequent test cases start clean.
 */
export function __resetReconcilerBootstrapForTests(): void {
  const rec = getGlobalReconciler();
  if (rec) rec.stop();
}

/**
 * factory-core-zsjv (Jane 2026-04-21): seed the event log with synthetic
 * events for every open pipeline:* epic so existing stuck epics (jba,
 * jtjn, any future pre-reconciler stalls) are visible to rules without
 * having to wait for a fresh agent exit.
 *
 * Called AFTER the reconciler starts; best-effort, swallows errors so a
 * bd failure here doesn't affect the reconciler's normal operation.
 *
 * Dedupe: each epic's seed event is stamped with correlationId
 * "reconciler-seed-<epicId>". Before emitting, we check the event log
 * for an identical correlationId within the last 24 h; if found, skip.
 */
async function seedOpenEpicsFromBd(repoPath: string): Promise<void> {
  try {
    const bd = getBdPath();
    const env = getBdEnv();

    // bd list tree output doesn't include labels. We have to (a) list all
    // open epics, (b) `bd show` each one to read its labels. Slower but
    // correct. Runs once at boot so the O(N) cost is acceptable.
    const listOut = execSync(`${bd} list --status=open --type=epic`, {
      cwd: repoPath,
      encoding: "utf-8",
      env,
      timeout: 20_000,
    });

    const epicIdRegex = /factory-core-[a-z0-9]+/g;
    const seen = new Set<string>();
    for (const line of listOut.split("\n")) {
      const matches = line.match(epicIdRegex);
      if (!matches) continue;
      for (const id of matches) seen.add(id);
    }
    // Also include in_progress epics (bd list --status=open includes them,
    // but be defensive against future bd CLI changes).
    try {
      const progOut = execSync(
        `${bd} list --status=in_progress --type=epic`,
        { cwd: repoPath, encoding: "utf-8", env, timeout: 10_000 },
      );
      for (const line of progOut.split("\n")) {
        const matches = line.match(epicIdRegex);
        if (!matches) continue;
        for (const id of matches) seen.add(id);
      }
    } catch {
      /* best-effort */
    }

    if (seen.size === 0) {
      console.log("[reconciler-bootstrap] no open pipeline:* epics to seed");
      return;
    }

    // Read recent events once for dedupe.
    const twentyFourHoursAgo = new Date(
      Date.now() - 24 * 60 * 60_000,
    ).toISOString();
    const recentEvents = await readEvents(repoPath, {
      since: twentyFourHoursAgo,
      type: "agent-exited",
    });
    const alreadySeeded = new Set<string>();
    for (const e of recentEvents) {
      if (e.correlationId?.startsWith("reconciler-seed-")) {
        alreadySeeded.add(e.correlationId);
      }
    }

    const twentyMinAgo = new Date(Date.now() - 20 * 60_000).toISOString();
    let emitted = 0;
    for (const epicId of seen) {
      const correlationId = `reconciler-seed-${epicId}`;
      if (alreadySeeded.has(correlationId)) continue;

      // Read the epic to confirm it has a pipeline:* label and grab the
      // current stage. Skip terminal states (live, completed, bad-idea).
      let showOut = "";
      try {
        showOut = execSync(`${bd} show ${epicId}`, {
          cwd: repoPath,
          encoding: "utf-8",
          env,
          timeout: 10_000,
        });
      } catch {
        continue;
      }
      const pipelineMatch = showOut.match(/pipeline:([a-z-]+)/);
      if (!pipelineMatch) continue;
      const stage = pipelineMatch[1];
      if (["live", "completed", "bad-idea"].includes(stage)) continue;
      // agent-running → actually working; let the agent emit its own
      // exit event when it finishes.
      if (showOut.includes("agent:running")) continue;

      await appendEvent(repoPath, {
        type: "agent-exited",
        epicId,
        stage,
        correlationId,
        timestamp: twentyMinAgo,
        payload: { exitCode: 0, synthetic: true, reason: "reconciler-boot-seed" },
      });
      emitted += 1;
    }

    if (emitted > 0) {
      console.log(
        `[reconciler-bootstrap] seeded ${emitted} open pipeline:* epics for rule discovery`,
      );
    }
  } catch (err) {
    console.error(
      "[reconciler-bootstrap] seed-open-epics failed (non-fatal):",
      err instanceof Error ? err.message : err,
    );
  }
}
