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
import type { ReconcilerRule } from "./reconciler";

/**
 * factory-core-3akh.2 helper: attach a minTickIntervalMs throttle to a
 * rule built via the normal buildXxxRule factories (which don't expose
 * the setting). Kept here so the rule factories stay minimal and the
 * bootstrap configures timing policy in one place.
 */
function throttled(rule: ReconcilerRule, minTickIntervalMs: number): ReconcilerRule {
  rule.minTickIntervalMs = minTickIntervalMs;
  return rule;
}
import { buildMissedWaveReviewDispatchRule } from "./reconciler-rules/missed-wave-review-dispatch";
import { buildStuckInStageRule } from "./reconciler-rules/stuck-in-stage";
import { buildWaveBeadMismatchRule } from "./reconciler-rules/wave-bead-mismatch";
import { buildRepeatedQaRoundRule } from "./reconciler-rules/repeated-qa-round";
import { buildCoherenceEscalationRule } from "./reconciler-rules/coherence-escalation";
import {
  buildRepeatDispatchEscalationRule,
  REPEAT_DISPATCH_SUPPRESSED_EVENT_TYPE,
} from "./reconciler-rules/repeat-dispatch-escalation";
import { probeActiveDispatch } from "./reconciler-rules/active-dispatch-probe";
import { buildLivenessCheckRule } from "./reconciler-rules/liveness-check";
import { readEpicState } from "./agent-launcher";
import { removeLabelsFromEpic } from "./pipeline-labels";
import { appendEvent, readEvents } from "./event-log";
import { execSync } from "child_process";
import { statSync, readdirSync } from "fs";
import * as path from "path";
import * as os from "os";
import { getBdPath, getBdEnv } from "./bd-path";

/**
 * factory-core-vy74.1: cached tmux session list for a single reconciler
 * tick. liveness-check queries tmux for every candidate epic — would be
 * wasteful to shell-out N times. We cache the list per-tick using a
 * stale-after-Nms timestamp on globalThis.
 */
interface TmuxCacheEntry {
  sessions: Set<string>;
  fetchedAtMs: number;
}
const TMUX_CACHE_TTL_MS = 5_000;

function listTmuxSessionsCached(): Set<string> {
  const g = globalThis as unknown as { __beadsWebTmuxCache?: TmuxCacheEntry };
  const now = Date.now();
  if (g.__beadsWebTmuxCache && now - g.__beadsWebTmuxCache.fetchedAtMs < TMUX_CACHE_TTL_MS) {
    return g.__beadsWebTmuxCache.sessions;
  }
  const sessions = new Set<string>();
  try {
    const out = execSync("tmux list-sessions -F '#{session_name}'", {
      encoding: "utf-8",
      env: process.env,
      timeout: 5_000,
    });
    for (const line of out.split("\n")) {
      const trimmed = line.trim();
      if (trimmed) sessions.add(trimmed);
    }
  } catch {
    // tmux not running, or no sessions → empty set is correct
  }
  g.__beadsWebTmuxCache = { sessions, fetchedAtMs: now };
  return sessions;
}

/**
 * factory-core-3p1e.10 — read the `session_activity` field for a tmux
 * session. tmux stores this as a unix timestamp in seconds; the active-
 * dispatch probe converts to milliseconds and compares against a 5-min
 * window. Failure-safe: returns null on any error so the probe degrades
 * to "no signal" rather than mis-suppressing a real escalation.
 */
function getTmuxSessionActivitySec(sessionName: string): number | null {
  try {
    // -t targets the session; -p prints to stdout; -F format string.
    // session_activity is documented in tmux(1) format strings.
    const out = execSync(
      `/opt/homebrew/bin/tmux display-message -p -t ${JSON.stringify(sessionName)} '#{session_activity}'`,
      {
        encoding: "utf-8",
        env: process.env,
        timeout: 3_000,
      },
    ).trim();
    if (!out) return null;
    const n = parseInt(out, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * factory-core-3p1e.10 — find the most recent .jsonl transcript mtime
 * (in milliseconds) for an epic.
 *
 * Claude Code writes transcripts to ~/.claude/projects/<safeCwd>/<sessionId>.jsonl
 * where safeCwd is the repo path with / and _ both replaced by -.
 * The reconciler does not know which repo a given epic was launched
 * against, so we scan ALL project directories for any .jsonl file
 * whose mtime is recent. This is intentionally wider than strictly
 * needed — a false-positive here only causes one extra suppression on
 * an unrelated epic that happens to have a fresh transcript at the
 * same time, which is acceptable. The rule's tmux-session check
 * already filters per-(epicId, stage), so false positives from this
 * function are gated behind that filter.
 *
 * Returns null when ~/.claude/projects/ does not exist or no .jsonl
 * files can be statted.
 */
function findLatestJsonlMtimeMs(epicId: string): number | null {
  // Heuristic: the transcript is most useful as a "is the agent making
  // progress?" signal. We don't know the repo cwd, but we can scan the
  // standard claude-projects root for fresh .jsonl files. The probe
  // gate (tmux session matching `shipyard-<epicId>-<stage>-`) filters
  // per-epic; this function only needs to confirm "some fresh
  // transcript exists in the last N minutes." We bound the cost by
  // skipping entire project dirs whose dir mtime is stale.
  void epicId; // signature kept for future targeted lookup; current scan is global
  try {
    const root = path.join(os.homedir(), ".claude", "projects");
    let projectDirs: string[];
    try {
      projectDirs = readdirSync(root);
    } catch {
      return null; // root missing
    }
    const horizonMs = Date.now() - 10 * 60_000; // double the 5-min window for slack
    let best: number | null = null;
    for (const proj of projectDirs) {
      const projPath = path.join(root, proj);
      let projStat;
      try {
        projStat = statSync(projPath);
      } catch {
        continue;
      }
      if (!projStat.isDirectory()) continue;
      // Skip dirs whose own mtime is older than horizon — fresh writes
      // bump dir mtime, so a stale dir cannot contain a fresh file.
      if (projStat.mtimeMs < horizonMs) continue;
      let entries: string[];
      try {
        entries = readdirSync(projPath);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.endsWith(".jsonl")) continue;
        try {
          const fStat = statSync(path.join(projPath, entry));
          if (best === null || fStat.mtimeMs > best) {
            best = fStat.mtimeMs;
          }
        } catch {
          /* skip */
        }
      }
    }
    return best;
  } catch {
    return null;
  }
}

/**
 * factory-core-6wrk.1 fix: look up an epic's real title from `bd show`.
 * Reconciler rules previously fell back to passing epicId as title when
 * they didn't have it cached, which broke run-polish / run-smoke-test /
 * any action that uses extractAppName(title) to resolve the product
 * repo path (e.g. /Users/janemckay/dev/claude_projects/<AppName>).
 * With the real title ("StudyCycle: Study cycle planner for iOS") the
 * extractor returns "StudyCycle" and the path resolves.
 *
 * Best-effort — returns epicId if bd show fails or title can't be parsed.
 * Never throws.
 */
function readEpicTitle(epicId: string, repoPath: string): string {
  try {
    const bd = getBdPath();
    const env = getBdEnv();
    const out = execSync(`${bd} show ${epicId}`, {
      cwd: repoPath,
      encoding: "utf-8",
      env,
      timeout: 10_000,
    });
    // Header line format:
    //   ◐ factory-core-jba [EPIC] · StudyCycle: Study cycle planner for iOS   [● P1 · IN_PROGRESS]
    const headerLine = out.split("\n")[0] ?? "";
    // Split on ·; title is between the "[EPIC]" segment and the final status bracket.
    const parts = headerLine.split("·");
    if (parts.length >= 2) {
      const middle = parts[1].trim();
      // Strip trailing "  [...]" status segment
      const bracketIdx = middle.lastIndexOf("[");
      const title = (bracketIdx > 0 ? middle.slice(0, bracketIdx) : middle).trim();
      if (title.length > 0) return title;
    }
  } catch {
    /* fall through to fallback */
  }
  return epicId;
}

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
    // factory-core-so74 A.8 deferred-AC fix: fallback updated to
    // fleet-core-improved (the active fork). Architect's design at
    // docs/aspirational-pipeline/a8-deferred-fixes.md missed this third
    // FLEET_CORE_PATH location and the one in route.ts; without these
    // updates the reconciler boots against the legacy fleet-core dir.
    const repoPath =
      process.env.FLEET_CORE_PATH ?? "/Users/janemckay/dev/fleet/factory-core";
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
            title: readEpicTitle(epicId, repoPath),
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
            title: readEpicTitle(epicId, repoPath),
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
            title: readEpicTitle(epicId, repoPath),
          };
        },
      }),
    );

    // factory-core-zsjv.3: repeated-QA-round detector — catches QA
    // loops that aren't converging after 5 rounds. Flags the epic for
    // human attention (v1 threshold flag; v2 zsjv.4 escalates to the
    // coherence agent for LLM-judgment).
    rec.registerRule(
      throttled(buildRepeatedQaRoundRule({
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
            title: readEpicTitle(epicId, repoPath),
          };
        },
      }), 5 * 60_000), // factory-core-3akh.2: QA rounds take hours, poll every 5m
    );

    // factory-core-zsjv.4 — coherence escalation rule: dispatches the
    // coherence agent for epics flagged review:needs-human.
    // factory-core-3akh.2: escalation feels fine at 1-min granularity.
    rec.registerRule(
      throttled(buildCoherenceEscalationRule({
        readEpicSnapshot: async (epicId: string) => {
          const snap = await readEpicState(epicId, repoPath);
          return {
            hasNeedsHuman: snap.labels.includes("review:needs-human"),
            labels: snap.labels,
            title: readEpicTitle(epicId, repoPath),
          };
        },
      }), 60_000), // factory-core-3akh.2: escalation at 1-min granularity
    );

    // factory-core-zsjv.6 — repeat-dispatch-escalation: when the same
    // (epic, stage) has been the target of stuck-in-stage recoveries
    // 3+ times in the last hour, mechanical re-dispatch isn't unsticking
    // the epic. Dispatch the coherence agent to diagnose.
    // factory-core-3akh.2: pattern matures over 15-min buckets; 1-min
    // poll is plenty.
    // factory-core-3p1e.10 — short-circuit if the latest dispatch is
    // actively progressing (matching tmux session alive AND transcript
    // mtime / session activity within 5 min). Avoids racing a live
    // builder with a coherence escalation. Audit trail via
    // `repeat-dispatch-suppressed` events on the reconciler event log.
    rec.registerRule(
      throttled(buildRepeatDispatchEscalationRule({
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
            title: readEpicTitle(epicId, repoPath),
          };
        },
        probeActiveDispatch: async (epicId, stage) => {
          // Use the per-tick cached tmux session list to avoid
          // re-shelling out on every probe. session_activity / JSONL
          // mtime go through dedicated helpers above.
          const sessions = listTmuxSessionsCached();
          return probeActiveDispatch(epicId, stage, {
            listTmuxSessions: () => [...sessions],
            getTmuxSessionActivitySec,
            findLatestJsonlMtimeMs,
            now: () => Date.now(),
          });
        },
        appendSuppressedEvent: async ({
          epicId,
          stage,
          attemptCount,
          sessionName,
          jsonlMtime,
          lastActivityAt,
        }) => {
          await appendEvent(repoPath, {
            type: REPEAT_DISPATCH_SUPPRESSED_EVENT_TYPE,
            epicId,
            stage,
            payload: {
              ruleName: "repeat-dispatch-escalation",
              attemptCount,
              sessionName,
              jsonlMtime,
              lastActivityAt,
            },
          });
        },
      }), 60_000), // factory-core-3akh.2: 1-min poll for pattern-maturation rule
    );

    // factory-core-vy74.1 — liveness-check rule: clear stale
    // agent:running labels when no matching tmux session exists. Closes
    // the label-leak gap (5+ epics observed with stale labels blocking
    // all other rules from engaging).
    // factory-core-3akh.2: label leaks are slow-moving; 1-min poll fine.
    rec.registerRule(
      throttled(buildLivenessCheckRule({
        listAgentRunningEpicIds: async () => {
          // Query bd for all open/in_progress epics with agent:running.
          // --limit 0 bypasses bd's default 50-row truncation (which
          // silently hid stale labels beyond the first page). --status
          // filters out long-closed epics whose label hygiene doesn't
          // matter anymore.
          try {
            const bd = getBdPath();
            const env = getBdEnv();
            const ids = new Set<string>();
            for (const status of ["open", "in_progress"]) {
              const out = execSync(
                `${bd} list --status=${status} --label agent:running --limit 0`,
                {
                  cwd: repoPath,
                  encoding: "utf-8",
                  env,
                  timeout: 15_000,
                },
              );
              for (const line of out.split("\n")) {
                const m = line.match(/factory-core-[a-z0-9]+/g);
                if (m) m.forEach((id) => ids.add(id));
              }
            }
            return [...ids];
          } catch (err) {
            console.error(
              "[liveness-check] listAgentRunningEpicIds failed:",
              err instanceof Error ? err.message : err,
            );
            return [];
          }
        },
        readEpicSnapshot: async (epicId: string) => {
          const snap = await readEpicState(epicId, repoPath);
          const hasAgentRunning = snap.labels.includes("agent:running");
          // Tmux session naming convention: shipyard-<epicId>-<stage>
          // (+ optional -wave<N> + -<beadId>). Match any session whose
          // name starts with "shipyard-<epicId>-".
          const sessions = listTmuxSessionsCached();
          const sessionPrefix = `shipyard-${epicId}-`;
          let tmuxSessionAlive = false;
          for (const s of sessions) {
            if (s.startsWith(sessionPrefix)) {
              tmuxSessionAlive = true;
              break;
            }
          }
          const pipelineLabel = snap.labels.find((l) =>
            l.startsWith("pipeline:"),
          );
          const currentStage = pipelineLabel
            ? pipelineLabel.replace("pipeline:", "")
            : null;
          return {
            hasAgentRunning,
            tmuxSessionAlive,
            currentStage,
          };
        },
        clearAgentRunning: async (epicId: string) => {
          await removeLabelsFromEpic(epicId, ["agent:running"], repoPath);
        },
        appendSyntheticExit: async ({ epicId, stage, reason }) => {
          await appendEvent(repoPath, {
            type: "agent-exited",
            epicId,
            stage: stage ?? undefined,
            correlationId: `liveness-check-${epicId}`,
            payload: {
              exitCode: null,
              synthetic: true,
              reason,
            },
          });
        },
      }), 60_000), // factory-core-3akh.2: label leaks don't need 10s reactivity
    );

    rec.start();
    console.log("[reconciler-bootstrap] reconciler started from route handler");

    // factory-core-zsjv (Jane 2026-04-21): seed the event log with
    // "epic-observed" events for every currently-open pipeline:* epic.
    // Without this, rules only see epics referenced in events from the
    // last 60 min — anything stuck BEFORE the reconciler started is
    // invisible.
    //
    // factory-core-vy74.2 (Jane 2026-04-21): the seed now re-runs every
    // 15 min so fresh epics (created post-boot) and epics whose state
    // recently changed (e.g. vy74.1 liveness-check cleared their stale
    // agent:running) become visible to rules within a window.
    // Dedupe via correlationId "reconciler-seed-<id>" within 24h is
    // already in place, so re-runs are cheap and idempotent.
    void seedOpenEpicsFromBd(repoPath);
    const RESEED_INTERVAL_MS = 15 * 60_000;
    const reseedInterval = setInterval(() => {
      void seedOpenEpicsFromBd(repoPath).catch((err) => {
        console.error(
          "[reconciler-bootstrap] periodic reseed failed:",
          err instanceof Error ? err.message : err,
        );
      });
    }, RESEED_INTERVAL_MS);
    // Pin the interval on globalThis so hot-reloads + __resetReconciler-
    // BootstrapForTests can stop it cleanly. Without this, restarts
    // would leak intervals indefinitely.
    const gReseed = globalThis as unknown as {
      __beadsWebReseedInterval?: NodeJS.Timeout | null;
    };
    if (gReseed.__beadsWebReseedInterval) {
      clearInterval(gReseed.__beadsWebReseedInterval);
    }
    gReseed.__beadsWebReseedInterval = reseedInterval;
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
  const g = globalThis as unknown as {
    __beadsWebReseedInterval?: NodeJS.Timeout | null;
    __beadsWebTmuxCache?: TmuxCacheEntry | null;
  };
  if (g.__beadsWebReseedInterval) {
    clearInterval(g.__beadsWebReseedInterval);
    g.__beadsWebReseedInterval = null;
  }
  g.__beadsWebTmuxCache = null;
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
      // factory-core-vy74.1: previously we skipped epics with
      // agent:running, assuming those were actually working. But those
      // are EXACTLY the ones liveness-check needs to see as candidates
      // — if the label is stale, every other rule is locked out. Seed
      // them too. stuck-in-stage will still correctly skip live agents
      // via its own hasAgentRunning guard when the snapshot shows the
      // tmux session exists.

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
