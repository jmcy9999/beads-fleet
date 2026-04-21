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
