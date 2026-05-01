// =============================================================================
// Unit tests for src/lib/marker-reader.ts (beads_web-28k)
// =============================================================================
//
// 8 test cases covering all acceptance criteria:
//   1. Happy path: all required + routing fields present (AC 6.1)
//   2. Happy path: routing fields absent / backward compat (AC 6.2)
//   3. Missing file -> null (AC 6.3)
//   4. Malformed JSON -> null + warning (AC 6.4)
//   5. Valid JSON, missing required field 'status' -> null + warning (AC 6.5)
//   6. Valid JSON, missing required field 'version' -> null + warning (AC 6.6)
//   7. Extra unknown fields preserved / forward compat (AC 6.7)
//   8. dispatch_context object parsed correctly (AC 6.8)
//
// Mock pattern: jest.mock("fs") per beads_web-u67 precedent.
// =============================================================================

import { readMarker } from "../../src/lib/marker-reader";
import { promises as fs } from "fs";

jest.mock("fs", () => {
  const actual = jest.requireActual("fs");
  return {
    ...actual,
    promises: {
      ...actual.promises,
      readFile: jest.fn(),
    },
  };
});

const mockedReadFile = fs.readFile as jest.MockedFunction<typeof fs.readFile>;

describe("marker-reader (beads_web-28k)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ---- AC 6.1: Happy path with routing fields ----
  test("happy path — all required + routing fields present", async () => {
    const mockMarker = {
      version: "1",
      bead_id: "beads_web-28k",
      status: "success",
      stage: "builder",
      started_at: "2026-05-01T14:00:00Z",
      exited_at: "2026-05-01T15:00:00Z",
      what_was_done: "Implemented marker-reader module",
      what_was_tested: "8 unit tests",
      deviations_from_ac: "None",
      next_agent: "coherence",
      blocker_class: "test-fail",
      dispatch_context: { round: 3 },
    };
    mockedReadFile.mockResolvedValue(JSON.stringify(mockMarker));

    const result = await readMarker("/fake/repo", "beads_web-28k");

    expect(result).toEqual(mockMarker);
    expect(result?.next_agent).toBe("coherence");
    expect(result?.blocker_class).toBe("test-fail");
    expect(result?.dispatch_context).toEqual({ round: 3 });
  });

  // ---- AC 6.2: Happy path without routing fields (backward compat) ----
  test("happy path — routing fields absent (backward compat)", async () => {
    const mockMarker = {
      version: "1",
      epic_id: "factory-core-lmxb",
      status: "blocked",
      stage: "planner",
      started_at: "2026-05-01T10:00:00Z",
      exited_at: "2026-05-01T10:30:00Z",
    };
    mockedReadFile.mockResolvedValue(JSON.stringify(mockMarker));

    const result = await readMarker(
      "/fake/repo",
      "factory-core-lmxb-planner",
    );

    expect(result).toEqual(mockMarker);
    expect(result?.next_agent).toBeUndefined();
    expect(result?.blocker_class).toBeUndefined();
  });

  // ---- AC 6.3: Missing file -> null ----
  test("missing file -> null", async () => {
    const enoent = new Error("ENOENT") as NodeJS.ErrnoException;
    enoent.code = "ENOENT";
    mockedReadFile.mockRejectedValue(enoent);

    const result = await readMarker("/fake/repo", "nonexistent");

    expect(result).toBeNull();
  });

  // ---- AC 6.4: Malformed JSON -> null + warning ----
  test("malformed JSON -> null + warning", async () => {
    mockedReadFile.mockResolvedValue("{invalid json");
    const warnSpy = jest.spyOn(console, "warn").mockImplementation();

    const result = await readMarker("/fake/repo", "beads_web-bad");

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Malformed JSON"),
    );
    warnSpy.mockRestore();
  });

  // ---- AC 6.5: Valid JSON, missing required field 'status' -> null + warning ----
  test("valid JSON, missing required field 'status' -> null + warning", async () => {
    const mockMarker = {
      version: "1",
      bead_id: "beads_web-28k",
      // status intentionally missing
      stage: "builder",
      started_at: "2026-05-01T14:00:00Z",
      exited_at: "2026-05-01T15:00:00Z",
    };
    mockedReadFile.mockResolvedValue(JSON.stringify(mockMarker));
    const warnSpy = jest.spyOn(console, "warn").mockImplementation();

    const result = await readMarker("/fake/repo", "beads_web-28k");

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Missing required field 'status'"),
    );
    warnSpy.mockRestore();
  });

  // ---- AC 6.6: Valid JSON, missing required field 'version' -> null + warning ----
  test("valid JSON, missing required field 'version' -> null + warning", async () => {
    const mockMarker = {
      // version intentionally missing
      bead_id: "beads_web-28k",
      status: "success",
      stage: "builder",
      started_at: "2026-05-01T14:00:00Z",
      exited_at: "2026-05-01T15:00:00Z",
    };
    mockedReadFile.mockResolvedValue(JSON.stringify(mockMarker));
    const warnSpy = jest.spyOn(console, "warn").mockImplementation();

    const result = await readMarker("/fake/repo", "beads_web-28k");

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Missing required field 'version'"),
    );
    warnSpy.mockRestore();
  });

  // ---- AC 6.7: Extra unknown fields preserved (forward compat) ----
  test("marker with unexpected extra fields -> preserved (forward compat)", async () => {
    const mockMarker = {
      version: "1",
      bead_id: "beads_web-28k",
      status: "success",
      stage: "builder",
      started_at: "2026-05-01T14:00:00Z",
      exited_at: "2026-05-01T15:00:00Z",
      future_field_added_in_v2: "some-value",
      another_unknown_field: { nested: "data" },
    };
    mockedReadFile.mockResolvedValue(JSON.stringify(mockMarker));

    const result = await readMarker("/fake/repo", "beads_web-28k");

    expect(result).toEqual(mockMarker);
    expect((result as Record<string, unknown>).future_field_added_in_v2).toBe(
      "some-value",
    );
    expect(
      (result as Record<string, unknown>).another_unknown_field,
    ).toEqual({ nested: "data" });
  });

  // ---- AC 6.8: dispatch_context object parsed correctly ----
  test("marker with dispatch_context object -> parsed", async () => {
    const mockMarker = {
      version: "1",
      epic_id: "factory-core-lmxb",
      status: "needs-decision",
      stage: "planner",
      started_at: "2026-05-01T10:00:00Z",
      exited_at: "2026-05-01T10:30:00Z",
      dispatch_context: {
        missing_component: "data-layer-sync-strategy",
        prior_attempt_count: 2,
        nested: { deeply: { value: 42 } },
      },
    };
    mockedReadFile.mockResolvedValue(JSON.stringify(mockMarker));

    const result = await readMarker(
      "/fake/repo",
      "factory-core-lmxb-planner",
    );

    expect(result?.dispatch_context).toEqual({
      missing_component: "data-layer-sync-strategy",
      prior_attempt_count: 2,
      nested: { deeply: { value: 42 } },
    });
  });
});
