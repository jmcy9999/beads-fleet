// =============================================================================
// beads_web-poh.17 — unit tests for marker-dispatch-sentinel.ts
// =============================================================================
// Verifies the on-disk contract that the marker-driven-routing rule depends
// on:
//   - encodeIdempotencyKey: filesystem-safe, no `:` or `/` in the result
//   - sentinelPath: lives under <repo>/.beads/markers/.dispatched/
//   - readDispatchSentinelSync: returns null on missing/malformed; parses
//     well-formed sentinels; rejects sentinels missing required fields
//   - writeDispatchSentinel: creates the directory, writes via temp+rename
//     so a concurrent reader never sees a partial file, swallows errors
//   - statMarkerMtimeSync: returns 0 when missing (so the matches()
//     comparison `markerMtimeMs <= sentinel.markerMtimeMs` skips the
//     match for a missing marker file — correct: nothing to dispatch)
// =============================================================================

import { promises as fs, existsSync, readFileSync } from "fs";
import * as os from "os";
import * as path from "path";

import {
  encodeIdempotencyKey,
  sentinelPath,
  readDispatchSentinelSync,
  writeDispatchSentinel,
  statMarkerMtimeSync,
  type DispatchSentinel,
} from "@/lib/marker-dispatch-sentinel";

async function makeRepo(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "poh17-sentinel-"));
}

describe("encodeIdempotencyKey (poh.17)", () => {
  it("replaces `:` with `_` (the bd idempotency-key separator must not land in a filename)", () => {
    const key = "marker-driven-routing::factory-core-1vud::research";
    expect(encodeIdempotencyKey(key)).toBe(
      "marker-driven-routing__factory-core-1vud__research",
    );
  });

  it("replaces `/` with `_` (defends against rule names that contain a path separator)", () => {
    const key = "rule-with/slash::epic::stage";
    expect(encodeIdempotencyKey(key)).toBe("rule-with_slash__epic__stage");
  });

  it("leaves alphanumerics + dashes untouched (round-trip readability)", () => {
    const key = "abc-123-XYZ";
    expect(encodeIdempotencyKey(key)).toBe("abc-123-XYZ");
  });
});

describe("sentinelPath (poh.17)", () => {
  it("lands under <repo>/.beads/markers/.dispatched/<encoded>.json", () => {
    const p = sentinelPath(
      "/repos/r",
      "marker-driven-routing::epic-x::planner",
    );
    expect(p).toBe(
      "/repos/r/.beads/markers/.dispatched/marker-driven-routing__epic-x__planner.json",
    );
  });
});

describe("readDispatchSentinelSync (poh.17)", () => {
  it("returns null when the sentinel file does not exist", async () => {
    const repo = await makeRepo();
    expect(
      readDispatchSentinelSync(repo, "marker-driven-routing::any::any"),
    ).toBeNull();
  });

  it("returns the parsed sentinel for a well-formed file", async () => {
    const repo = await makeRepo();
    const key = "marker-driven-routing::epic-1::planner";
    const sentinel: DispatchSentinel = {
      idempotencyKey: key,
      dispatchedAt: "2026-05-07T13:54:00.000Z",
      markerMtimeMs: 1234567890,
      markerId: "epic-1-planner",
      nextAgent: "test-spec",
    };
    const p = sentinelPath(repo, key);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, JSON.stringify(sentinel));

    const out = readDispatchSentinelSync(repo, key);
    expect(out).toEqual(sentinel);
  });

  it("returns null when the file exists but contains invalid JSON (fail-open: one extra dispatch beats blocking forever)", async () => {
    const repo = await makeRepo();
    const key = "marker-driven-routing::epic-2::planner";
    const p = sentinelPath(repo, key);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, "{ this is not json");

    expect(readDispatchSentinelSync(repo, key)).toBeNull();
  });

  it("returns null when the JSON is missing required fields (refuses to honour a partial sentinel)", async () => {
    const repo = await makeRepo();
    const key = "marker-driven-routing::epic-3::planner";
    const p = sentinelPath(repo, key);
    await fs.mkdir(path.dirname(p), { recursive: true });
    // Missing markerMtimeMs — ambiguous record, must not be trusted to
    // block dispatches.
    await fs.writeFile(
      p,
      JSON.stringify({
        idempotencyKey: key,
        dispatchedAt: "2026-05-07T13:54:00.000Z",
      }),
    );

    expect(readDispatchSentinelSync(repo, key)).toBeNull();
  });
});

describe("writeDispatchSentinel (poh.17)", () => {
  it("creates the .dispatched directory and writes a well-formed sentinel", async () => {
    const repo = await makeRepo();
    const key = "marker-driven-routing::epic-4::planner";
    const sentinel: DispatchSentinel = {
      idempotencyKey: key,
      dispatchedAt: "2026-05-07T13:55:00.000Z",
      markerMtimeMs: 9876543210,
      markerId: "epic-4-planner",
      nextAgent: "builder",
    };

    await writeDispatchSentinel(repo, key, sentinel);

    const p = sentinelPath(repo, key);
    expect(existsSync(p)).toBe(true);
    const parsed = JSON.parse(readFileSync(p, "utf-8"));
    expect(parsed).toEqual(sentinel);
  });

  it("survives a concurrent read seeing only the old or new file (atomic rename, never a partial truncate)", async () => {
    // We can't fully race fs operations in a unit test, but we can
    // assert the temp-file pattern by listing the directory after a
    // write — there must be exactly the named sentinel and no leftover
    // .tmp.* files.
    const repo = await makeRepo();
    const key = "marker-driven-routing::epic-5::planner";
    const sentinel: DispatchSentinel = {
      idempotencyKey: key,
      dispatchedAt: "2026-05-07T13:56:00.000Z",
      markerMtimeMs: 100,
    };

    await writeDispatchSentinel(repo, key, sentinel);

    const dir = path.dirname(sentinelPath(repo, key));
    const entries = await fs.readdir(dir);
    const tempLeftovers = entries.filter((f) => f.includes(".tmp."));
    expect(tempLeftovers).toEqual([]); // rename succeeded, no orphan
  });

  it("does not throw when the target directory cannot be created (best-effort, dispatch must still succeed)", async () => {
    // Point at a path that cannot be created (under a regular file).
    const repo = await makeRepo();
    const blocker = path.join(repo, ".beads");
    await fs.writeFile(blocker, "not a directory"); // .beads is a FILE
    const key = "marker-driven-routing::epic-6::planner";

    // writeDispatchSentinel must swallow the EEXIST/ENOTDIR.
    await expect(
      writeDispatchSentinel(repo, key, {
        idempotencyKey: key,
        dispatchedAt: "2026-05-07T13:57:00.000Z",
        markerMtimeMs: 100,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("statMarkerMtimeSync (poh.17)", () => {
  it("returns 0 when the marker file does not exist", async () => {
    const repo = await makeRepo();
    expect(statMarkerMtimeSync(repo, "missing-marker")).toBe(0);
  });

  it("returns a positive mtime in ms for an existing marker file", async () => {
    const repo = await makeRepo();
    const markersDir = path.join(repo, ".beads", "markers");
    await fs.mkdir(markersDir, { recursive: true });
    await fs.writeFile(
      path.join(markersDir, "epic-7-planner.json"),
      JSON.stringify({ stage: "planner" }),
    );

    const t = statMarkerMtimeSync(repo, "epic-7-planner");
    expect(t).toBeGreaterThan(0);
  });
});
