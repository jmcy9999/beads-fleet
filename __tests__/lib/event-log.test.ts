// =============================================================================
// Tests for src/lib/event-log.ts (factory-core-lfcf.1)
// =============================================================================
// Real filesystem, per-test temp repo. Validates append/read round-trip,
// filter semantics, malformed-line tolerance, and the failure contract
// (appendEvent never throws).
// =============================================================================

import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";

import {
  appendEvent,
  readEvents,
  RECONCILER_ACTION_REFUSED,
  type ReconcilerActionRefusedEvent,
  type ReconcilerActionRefusedPayload,
  __resetEventLogForTests,
} from "@/lib/event-log";

async function makeRepo(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "event-log-test-"));
}

describe("event-log", () => {
  test("readEvents returns empty array when log does not exist", async () => {
    const repo = await makeRepo();
    const events = await readEvents(repo);
    expect(events).toEqual([]);
  });

  test("appendEvent creates .beads directory if missing", async () => {
    const repo = await makeRepo();
    await appendEvent(repo, {
      type: "agent-launched",
      epicId: "factory-core-test",
    });
    const logPath = path.join(repo, ".beads", "events.jsonl");
    const stat = await fs.stat(logPath);
    expect(stat.isFile()).toBe(true);
  });

  test("append + read round-trip preserves data", async () => {
    const repo = await makeRepo();
    await appendEvent(repo, {
      type: "agent-exited",
      epicId: "factory-core-x",
      stage: "build-review",
      correlationId: "tmux-session-1",
      payload: { exitCode: 0 },
    });
    const events = await readEvents(repo);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("agent-exited");
    expect(events[0].epicId).toBe("factory-core-x");
    expect(events[0].stage).toBe("build-review");
    expect(events[0].correlationId).toBe("tmux-session-1");
    expect(events[0].payload).toEqual({ exitCode: 0 });
    expect(events[0].timestamp).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
    );
  });

  test("multiple appends preserve order (newest-first on read)", async () => {
    const repo = await makeRepo();
    await appendEvent(repo, {
      type: "agent-launched",
      epicId: "e1",
      timestamp: "2026-04-21T10:00:00.000Z",
    });
    await appendEvent(repo, {
      type: "agent-exited",
      epicId: "e1",
      timestamp: "2026-04-21T10:00:10.000Z",
    });
    await appendEvent(repo, {
      type: "stage-dispatched",
      epicId: "e1",
      timestamp: "2026-04-21T10:00:11.000Z",
    });
    const events = await readEvents(repo);
    expect(events.map((e) => e.type)).toEqual([
      "stage-dispatched",
      "agent-exited",
      "agent-launched",
    ]);
  });

  test("type filter narrows results", async () => {
    const repo = await makeRepo();
    await appendEvent(repo, { type: "agent-launched", epicId: "e1" });
    await appendEvent(repo, { type: "agent-exited", epicId: "e1" });
    await appendEvent(repo, { type: "agent-exited", epicId: "e2" });
    const exits = await readEvents(repo, { type: "agent-exited" });
    expect(exits).toHaveLength(2);
    expect(exits.every((e) => e.type === "agent-exited")).toBe(true);
  });

  test("epicId filter narrows results", async () => {
    const repo = await makeRepo();
    await appendEvent(repo, { type: "t", epicId: "e1" });
    await appendEvent(repo, { type: "t", epicId: "e2" });
    await appendEvent(repo, { type: "t", epicId: "e1" });
    const e1Events = await readEvents(repo, { epicId: "e1" });
    expect(e1Events).toHaveLength(2);
    expect(e1Events.every((e) => e.epicId === "e1")).toBe(true);
  });

  test("since filter excludes older events", async () => {
    const repo = await makeRepo();
    await appendEvent(repo, {
      type: "t",
      epicId: "e1",
      timestamp: "2026-04-21T09:00:00.000Z",
    });
    await appendEvent(repo, {
      type: "t",
      epicId: "e1",
      timestamp: "2026-04-21T10:00:00.000Z",
    });
    await appendEvent(repo, {
      type: "t",
      epicId: "e1",
      timestamp: "2026-04-21T11:00:00.000Z",
    });
    const recent = await readEvents(repo, {
      since: "2026-04-21T09:30:00.000Z",
    });
    expect(recent).toHaveLength(2);
    expect(recent.map((e) => e.timestamp).sort()).toEqual([
      "2026-04-21T10:00:00.000Z",
      "2026-04-21T11:00:00.000Z",
    ]);
  });

  test("limit caps returned count after filtering", async () => {
    const repo = await makeRepo();
    for (let i = 0; i < 5; i++) {
      await appendEvent(repo, {
        type: "t",
        epicId: "e1",
        timestamp: new Date(Date.now() + i * 1000).toISOString(),
      });
    }
    const first3 = await readEvents(repo, { limit: 3 });
    expect(first3).toHaveLength(3);
  });

  test("malformed lines are skipped (not throw)", async () => {
    const repo = await makeRepo();
    await appendEvent(repo, { type: "ok", epicId: "e1" });
    // Corrupt the file with a bad line between two good ones
    const logPath = path.join(repo, ".beads", "events.jsonl");
    await fs.appendFile(logPath, "{ this is not json\n", "utf-8");
    await appendEvent(repo, { type: "ok", epicId: "e2" });
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const events = await readEvents(repo);
    expect(events.map((e) => e.epicId)).toEqual(["e2", "e1"]);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test("appendEvent never throws on permission error (failure contract)", async () => {
    // Construct a path that's guaranteed unwriteable (non-existent parent
    // with a junk path that can't be created).
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    // Use a repo path that's a regular file, not a directory, so
    // mkdir will fail.
    const notADir = path.join(os.tmpdir(), "event-log-not-a-dir-" + Date.now());
    await fs.writeFile(notADir, "regular file\n", "utf-8");
    // The event-log treats this as repoPath; creating <file>/.beads will fail.
    await expect(
      appendEvent(notADir, { type: "t", epicId: "e1" }),
    ).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
    await fs.unlink(notADir);
  });

  test("__resetEventLogForTests clears the log", async () => {
    const repo = await makeRepo();
    await appendEvent(repo, { type: "t", epicId: "e1" });
    expect(await readEvents(repo)).toHaveLength(1);
    await __resetEventLogForTests(repo);
    expect(await readEvents(repo)).toEqual([]);
  });

  // ---------------------------------------------------------------------
  // Variant: reconciler-action-refused (beads_web-ehp.2)
  // ---------------------------------------------------------------------
  // ADR-006: NEW event type, NOT a flag on existing reconciler-action-taken.
  // Pure additive variant — the existing event filters and round-trip
  // semantics MUST be preserved unchanged.
  // ---------------------------------------------------------------------

  test("RECONCILER_ACTION_REFUSED constant matches the wire literal", () => {
    expect(RECONCILER_ACTION_REFUSED).toBe("reconciler-action-refused");
  });

  test("reconciler-action-refused round-trips with all structured fields", async () => {
    const repo = await makeRepo();
    // Use the typed payload to lock the schema at the test layer too —
    // any future drift in the payload shape produces a TS error here.
    const payload: ReconcilerActionRefusedPayload = {
      ruleName: "marker-driven-routing",
      action: "marker-driven-routing:dispatch",
      // Plain string literal — DO NOT import RefusalCode (Wave 2 ehp.3),
      // forward-coupling per bead risk flag.
      refusalCode: "BD_STATUS_DEFERRED",
      failedCheck: "BD_STATUS_DEFERRED",
      reason: "Bead status=deferred (372-bead mass-defer scenario); refusing dispatch",
    };
    const event: Omit<ReconcilerActionRefusedEvent, "timestamp"> = {
      type: RECONCILER_ACTION_REFUSED,
      epicId: "factory-core-niii",
      correlationId: "shipyard-niii-marker-routing-2026-05-06T10-00-00",
      payload,
    };
    await appendEvent(repo, event);

    const events = await readEvents(repo);
    expect(events).toHaveLength(1);
    const got = events[0];
    expect(got.type).toBe(RECONCILER_ACTION_REFUSED);
    expect(got.epicId).toBe("factory-core-niii");
    expect(got.correlationId).toBe(
      "shipyard-niii-marker-routing-2026-05-06T10-00-00",
    );
    expect(got.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(got.payload).toEqual(payload);
  });

  test("reconciler-action-refused JSONL line is greppable + has stable shape", async () => {
    // Operators grep events.jsonl directly (event-log ADR: "JSONL, not SQLite
    // ... greppable by operators"). Verify the on-disk line includes the
    // discriminant tag and every payload field as raw JSON keys, in
    // a single line.
    const repo = await makeRepo();
    await appendEvent(repo, {
      type: RECONCILER_ACTION_REFUSED,
      epicId: "factory-core-x",
      correlationId: "tmux-corr-1",
      timestamp: "2026-05-06T10:00:00.000Z",
      payload: {
        ruleName: "stuck-in-stage",
        action: "stuck-in-stage:redispatch",
        refusalCode: "OPERATOR_DECISION_PENDING",
        failedCheck: "OPERATOR_DECISION_PENDING",
        reason: "Marker has next_agent=operator and blocker_class=spec-ambiguity",
      } satisfies ReconcilerActionRefusedPayload,
    });
    const logPath = path.join(repo, ".beads", "events.jsonl");
    const raw = await fs.readFile(logPath, "utf-8");
    // One line, terminated by \n.
    expect(raw.split("\n").filter((l) => l.length > 0)).toHaveLength(1);
    expect(raw).toContain("\"type\":\"reconciler-action-refused\"");
    expect(raw).toContain("\"epicId\":\"factory-core-x\"");
    expect(raw).toContain("\"correlationId\":\"tmux-corr-1\"");
    expect(raw).toContain("\"timestamp\":\"2026-05-06T10:00:00.000Z\"");
    expect(raw).toContain("\"ruleName\":\"stuck-in-stage\"");
    expect(raw).toContain("\"action\":\"stuck-in-stage:redispatch\"");
    expect(raw).toContain("\"refusalCode\":\"OPERATOR_DECISION_PENDING\"");
    expect(raw).toContain("\"failedCheck\":\"OPERATOR_DECISION_PENDING\"");
    expect(raw).toContain("\"reason\":\"Marker has next_agent=operator");
  });

  test("type filter on reconciler-action-refused does not return reconciler-action-taken", async () => {
    // Bead AC: "Filter `e.type === 'reconciler-action-refused'` reads only
    // the new variant, not the existing `reconciler-action-taken` events."
    const repo = await makeRepo();
    await appendEvent(repo, {
      type: "reconciler-action-taken",
      epicId: "e1",
      payload: {
        ruleName: "stuck-in-stage",
        idempotencyKey: "e1:stuck-in-stage:build",
      },
    });
    await appendEvent(repo, {
      type: RECONCILER_ACTION_REFUSED,
      epicId: "e1",
      payload: {
        ruleName: "stuck-in-stage",
        action: "stuck-in-stage:redispatch",
        refusalCode: "BD_STATUS_DEFERRED",
        failedCheck: "BD_STATUS_DEFERRED",
        reason: "deferred bead; refusing",
      } satisfies ReconcilerActionRefusedPayload,
    });
    await appendEvent(repo, {
      type: "reconciler-action-taken",
      epicId: "e1",
      payload: {
        ruleName: "marker-driven-routing",
        idempotencyKey: "e1:marker-driven-routing:plan-review",
      },
    });

    const refused = await readEvents(repo, {
      type: "reconciler-action-refused",
    });
    expect(refused).toHaveLength(1);
    expect(refused[0].type).toBe(RECONCILER_ACTION_REFUSED);
    expect(refused.every((e) => e.type === "reconciler-action-refused")).toBe(
      true,
    );

    const taken = await readEvents(repo, { type: "reconciler-action-taken" });
    expect(taken).toHaveLength(2);
    expect(taken.every((e) => e.type === "reconciler-action-taken")).toBe(true);
  });

  test("existing `e.type === 'reconciler-action-taken'` filter is unchanged by the new variant", async () => {
    // Bead AC: "Existing filter `e.type === 'reconciler-action-taken'`
    // (e.g., at `stuck-in-stage.ts:122`) continues to work unchanged."
    // Simulate the consumer's filter shape directly here.
    const repo = await makeRepo();
    await appendEvent(repo, {
      type: "reconciler-action-taken",
      epicId: "e1",
      payload: { ruleName: "r1" },
    });
    await appendEvent(repo, {
      type: RECONCILER_ACTION_REFUSED,
      epicId: "e1",
      payload: {
        ruleName: "r1",
        action: "r1:dispatch",
        refusalCode: "BD_STATUS_DEFERRED",
        failedCheck: "BD_STATUS_DEFERRED",
        reason: "x",
      } satisfies ReconcilerActionRefusedPayload,
    });
    await appendEvent(repo, {
      type: "agent-exited",
      epicId: "e1",
      payload: { exitCode: 0 },
    });

    const all = await readEvents(repo);
    // Mirror stuck-in-stage.ts:122 — exclude reconciler-action-taken.
    const nonReconcilerTaken = all.filter(
      (e) => e.type !== "reconciler-action-taken",
    );
    // Two events remain: the agent-exited and the reconciler-action-refused.
    expect(nonReconcilerTaken).toHaveLength(2);
    expect(nonReconcilerTaken.map((e) => e.type).sort()).toEqual(
      ["agent-exited", "reconciler-action-refused"].sort(),
    );

    // And the inverse filter — only reconciler-action-taken — returns 1.
    const onlyTaken = all.filter(
      (e) => e.type === "reconciler-action-taken",
    );
    expect(onlyTaken).toHaveLength(1);
    expect(onlyTaken[0].payload).toEqual({ ruleName: "r1" });
  });

  test("epicId + since filters compose with reconciler-action-refused", async () => {
    // Confirm the new variant participates in compound filters identically
    // to existing variants — no special-casing.
    const repo = await makeRepo();
    await appendEvent(repo, {
      type: RECONCILER_ACTION_REFUSED,
      epicId: "e1",
      timestamp: "2026-05-06T09:00:00.000Z",
      payload: {
        ruleName: "r1",
        action: "r1:dispatch",
        refusalCode: "BD_STATUS_DEFERRED",
        failedCheck: "BD_STATUS_DEFERRED",
        reason: "old",
      } satisfies ReconcilerActionRefusedPayload,
    });
    await appendEvent(repo, {
      type: RECONCILER_ACTION_REFUSED,
      epicId: "e1",
      timestamp: "2026-05-06T11:00:00.000Z",
      payload: {
        ruleName: "r1",
        action: "r1:dispatch",
        refusalCode: "OPERATOR_DECISION_PENDING",
        failedCheck: "OPERATOR_DECISION_PENDING",
        reason: "recent",
      } satisfies ReconcilerActionRefusedPayload,
    });
    await appendEvent(repo, {
      type: RECONCILER_ACTION_REFUSED,
      epicId: "e2",
      timestamp: "2026-05-06T11:00:00.000Z",
      payload: {
        ruleName: "r2",
        action: "r2:dispatch",
        refusalCode: "BD_STATUS_DEFERRED",
        failedCheck: "BD_STATUS_DEFERRED",
        reason: "wrong-epic",
      } satisfies ReconcilerActionRefusedPayload,
    });

    const filtered = await readEvents(repo, {
      type: "reconciler-action-refused",
      epicId: "e1",
      since: "2026-05-06T10:00:00.000Z",
    });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].epicId).toBe("e1");
    expect(filtered[0].timestamp).toBe("2026-05-06T11:00:00.000Z");
    expect((filtered[0].payload as ReconcilerActionRefusedPayload).reason).toBe(
      "recent",
    );
  });

  test("events missing required fields are skipped on read", async () => {
    const repo = await makeRepo();
    const logPath = path.join(repo, ".beads", "events.jsonl");
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    // Valid event
    await fs.writeFile(
      logPath,
      JSON.stringify({
        type: "ok",
        epicId: "e1",
        timestamp: "2026-04-21T10:00:00.000Z",
      }) +
        "\n" +
        // Missing required 'type'
        JSON.stringify({
          epicId: "e1",
          timestamp: "2026-04-21T10:00:01.000Z",
        }) +
        "\n",
      "utf-8",
    );
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const events = await readEvents(repo);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("ok");
    warnSpy.mockRestore();
  });
});
