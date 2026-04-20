// =============================================================================
// Tests for src/app/api/plan-review/integrity/route.ts — factory-core-k7gy.8
// =============================================================================
// Covers every F2 transport acceptance criterion plus the regression patterns
// flagged in the bead/test-spec: #2 (60s cap boundaries), #4 (validation
// scattered — input validation lives in the route), #12 (empty-string query
// params), #13 (fail-closed on sweep failure).
// =============================================================================

import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// Mocks — isolate the route from the real Dolt reader and repo registry.
// ---------------------------------------------------------------------------

jest.mock("@/lib/plan-review/integrity", () => {
  const actual = jest.requireActual("@/lib/plan-review/integrity");
  return {
    ...actual,
    runIntegritySweep: jest.fn(),
  };
});

jest.mock("@/lib/repo-config", () => ({
  findRepoForIssue: jest.fn(),
}));

import { GET } from "@/app/api/plan-review/integrity/route";
import {
  runIntegritySweep,
  INTEGRITY_SWEEP_TIMEOUT_MS,
} from "@/lib/plan-review/integrity";
import { findRepoForIssue } from "@/lib/repo-config";

const mockRunIntegritySweep = runIntegritySweep as jest.MockedFunction<
  typeof runIntegritySweep
>;
const mockFindRepoForIssue = findRepoForIssue as jest.MockedFunction<
  typeof findRepoForIssue
>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_REPO = "/Users/janemckay/dev/fleet/fleet-core";
const DEFAULT_EPIC_ID = "factory-core-k7gy";
const DEFAULT_PLAN_PATH = ".beads/plans/factory-core-k7gy.md";

function buildUrl(params: Record<string, string | null>): string {
  const base = "http://localhost:3000/api/plan-review/integrity";
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== null) search.set(k, v);
  }
  const qs = search.toString();
  return qs ? `${base}?${qs}` : base;
}

function buildRequest(params: Record<string, string | null>): NextRequest {
  return new NextRequest(buildUrl(params));
}

const EMPTY_RESULT = {
  orphans: [],
  strays: [],
  mislabels: [],
  unavailable: [],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/plan-review/integrity", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFindRepoForIssue.mockResolvedValue(DEFAULT_REPO);
  });

  // -----------------------------------------------------------------------
  // Happy path — pass-through of module shapes (Spec F2 AC1–AC4).
  // -----------------------------------------------------------------------

  describe("pass-through of sweep result", () => {
    it("returns 200 with all-empty body when module returns an all-green result", async () => {
      mockRunIntegritySweep.mockResolvedValue(EMPTY_RESULT);

      const response = await GET(
        buildRequest({
          epicId: DEFAULT_EPIC_ID,
          planManifestPath: DEFAULT_PLAN_PATH,
        }),
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual(EMPTY_RESULT);
      expect(response.headers.get("content-type")).toContain("application/json");
    });

    it("passes orphans/strays/mislabels through byte-identical", async () => {
      const withFindings = {
        orphans: [
          { beadId: "factory-core-k7gy.99", expectedRepo: "factory-core" },
          { beadId: "factory-core-k7gy.100", expectedRepo: "factory-core" },
        ],
        strays: [
          {
            beadId: "factory-core-k7gy.101",
            actualRepo: "factory-core",
            actualLabel: "epic:factory-core-k7gy",
          },
        ],
        mislabels: [],
        unavailable: [],
      };
      mockRunIntegritySweep.mockResolvedValue(withFindings);

      const response = await GET(
        buildRequest({
          epicId: DEFAULT_EPIC_ID,
          planManifestPath: DEFAULT_PLAN_PATH,
        }),
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual(withFindings);
    });

    it("passes through a module-reported `unavailable` list without re-sanitising", async () => {
      const unavail = {
        orphans: [],
        strays: [],
        mislabels: [],
        unavailable: ["beads"],
      };
      mockRunIntegritySweep.mockResolvedValue(unavail);

      const response = await GET(
        buildRequest({
          epicId: DEFAULT_EPIC_ID,
          planManifestPath: DEFAULT_PLAN_PATH,
        }),
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual(unavail);
    });

    it("invokes runIntegritySweep with the resolved baseDir", async () => {
      mockRunIntegritySweep.mockResolvedValue(EMPTY_RESULT);
      mockFindRepoForIssue.mockResolvedValue(DEFAULT_REPO);

      await GET(
        buildRequest({
          epicId: DEFAULT_EPIC_ID,
          planManifestPath: DEFAULT_PLAN_PATH,
        }),
      );

      expect(mockRunIntegritySweep).toHaveBeenCalledTimes(1);
      const [epicIdArg, planPathArg, depsArg] =
        mockRunIntegritySweep.mock.calls[0];
      expect(epicIdArg).toBe(DEFAULT_EPIC_ID);
      expect(planPathArg).toBe(DEFAULT_PLAN_PATH);
      expect(depsArg).toEqual({ baseDir: DEFAULT_REPO });
    });
  });

  // -----------------------------------------------------------------------
  // Input validation — regression patterns #4, #12.
  // -----------------------------------------------------------------------

  describe("epicId validation", () => {
    it("returns 400 for epicId with spaces (regex reject)", async () => {
      const response = await GET(
        buildRequest({
          epicId: "bad id with spaces",
          planManifestPath: DEFAULT_PLAN_PATH,
        }),
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toContain("Invalid epicId");
      expect(mockRunIntegritySweep).not.toHaveBeenCalled();
    });

    it("returns 400 for SQL-injection-shaped epicId", async () => {
      const response = await GET(
        buildRequest({
          epicId: "; DROP TABLE",
          planManifestPath: DEFAULT_PLAN_PATH,
        }),
      );

      expect(response.status).toBe(400);
      expect(mockRunIntegritySweep).not.toHaveBeenCalled();
    });

    it("returns 400 for empty epicId (regex #12)", async () => {
      const response = await GET(
        buildRequest({
          epicId: "",
          planManifestPath: DEFAULT_PLAN_PATH,
        }),
      );

      expect(response.status).toBe(400);
      expect(mockRunIntegritySweep).not.toHaveBeenCalled();
    });

    it("returns 400 when epicId is missing entirely", async () => {
      const response = await GET(
        buildRequest({
          epicId: null,
          planManifestPath: DEFAULT_PLAN_PATH,
        }),
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toMatch(/missing.*epicId/i);
      expect(mockRunIntegritySweep).not.toHaveBeenCalled();
    });

    it("returns 400 for uppercase epicId", async () => {
      const response = await GET(
        buildRequest({
          epicId: "FACTORY-CORE-K7GY",
          planManifestPath: DEFAULT_PLAN_PATH,
        }),
      );

      expect(response.status).toBe(400);
    });

    it("accepts minimum valid epicId (single char)", async () => {
      mockRunIntegritySweep.mockResolvedValue(EMPTY_RESULT);
      mockFindRepoForIssue.mockResolvedValue(DEFAULT_REPO);

      const response = await GET(
        buildRequest({ epicId: "a", planManifestPath: DEFAULT_PLAN_PATH }),
      );

      expect(response.status).toBe(200);
      expect(mockRunIntegritySweep).toHaveBeenCalled();
    });

    it("accepts dotted nested epicId (`foo-bar.3.7`)", async () => {
      mockRunIntegritySweep.mockResolvedValue(EMPTY_RESULT);
      mockFindRepoForIssue.mockResolvedValue(DEFAULT_REPO);

      const response = await GET(
        buildRequest({
          epicId: "foo-bar.3.7",
          planManifestPath: DEFAULT_PLAN_PATH,
        }),
      );

      expect(response.status).toBe(200);
    });
  });

  describe("planManifestPath validation", () => {
    it("returns 400 when planManifestPath is missing entirely", async () => {
      const response = await GET(
        buildRequest({
          epicId: DEFAULT_EPIC_ID,
          planManifestPath: null,
        }),
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toMatch(/missing.*planManifestPath/i);
      expect(mockRunIntegritySweep).not.toHaveBeenCalled();
    });

    it("returns 400 for empty planManifestPath (#12)", async () => {
      const response = await GET(
        buildRequest({
          epicId: DEFAULT_EPIC_ID,
          planManifestPath: "",
        }),
      );

      expect(response.status).toBe(400);
      expect(mockRunIntegritySweep).not.toHaveBeenCalled();
    });

    it("returns 400 for path traversal `../../etc/passwd`", async () => {
      const response = await GET(
        buildRequest({
          epicId: DEFAULT_EPIC_ID,
          planManifestPath: "../../etc/passwd",
        }),
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toMatch(/path traversal/i);
      expect(mockRunIntegritySweep).not.toHaveBeenCalled();
    });

    it("returns 400 when normalised path still escapes the base (e.g. `foo/../../bar.md`)", async () => {
      // path.normalize("foo/../../bar.md") === "../bar.md" — escapes base.
      // (In contrast, "foo/../bar.md" normalises to "bar.md" and is safe.)
      const response = await GET(
        buildRequest({
          epicId: DEFAULT_EPIC_ID,
          planManifestPath: "foo/../../bar.md",
        }),
      );

      expect(response.status).toBe(400);
      expect(mockRunIntegritySweep).not.toHaveBeenCalled();
    });

    it("returns 400 for absolute planManifestPath `/etc/passwd`", async () => {
      const response = await GET(
        buildRequest({
          epicId: DEFAULT_EPIC_ID,
          planManifestPath: "/etc/passwd",
        }),
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toMatch(/absolute/i);
      expect(mockRunIntegritySweep).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Fail-closed behaviour (regression #13 / ADR-006).
  // -----------------------------------------------------------------------

  describe("fail-closed on sweep errors", () => {
    it("returns 200 with `unavailable` non-empty when runIntegritySweep throws", async () => {
      mockRunIntegritySweep.mockRejectedValue(new Error("boom"));

      const response = await GET(
        buildRequest({
          epicId: DEFAULT_EPIC_ID,
          planManifestPath: DEFAULT_PLAN_PATH,
        }),
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.orphans).toEqual([]);
      expect(body.strays).toEqual([]);
      expect(body.mislabels).toEqual([]);
      expect(body.unavailable).toHaveLength(1);
      expect(body.unavailable[0]).toBeTruthy();
    });

    it("returns 200 with `unavailable` when the app repo cannot be located", async () => {
      mockFindRepoForIssue.mockResolvedValue(null);

      const response = await GET(
        buildRequest({
          epicId: DEFAULT_EPIC_ID,
          planManifestPath: DEFAULT_PLAN_PATH,
        }),
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.orphans).toEqual([]);
      expect(body.unavailable).toHaveLength(1);
      expect(mockRunIntegritySweep).not.toHaveBeenCalled();
    });

    it("returns 200 with `unavailable` when findRepoForIssue throws", async () => {
      mockFindRepoForIssue.mockRejectedValue(new Error("dolt down"));

      const response = await GET(
        buildRequest({
          epicId: DEFAULT_EPIC_ID,
          planManifestPath: DEFAULT_PLAN_PATH,
        }),
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.unavailable).toHaveLength(1);
      expect(mockRunIntegritySweep).not.toHaveBeenCalled();
    });

    it("NEVER returns a 2xx with empty `unavailable` when a failure occurred (Spec F2 AC5)", async () => {
      mockRunIntegritySweep.mockRejectedValue(new Error("boom"));

      const response = await GET(
        buildRequest({
          epicId: DEFAULT_EPIC_ID,
          planManifestPath: DEFAULT_PLAN_PATH,
        }),
      );
      const body = await response.json();

      expect(response.status).toBeGreaterThanOrEqual(200);
      expect(response.status).toBeLessThan(300);
      expect(body.unavailable.length).toBeGreaterThan(0);
    });
  });

  // -----------------------------------------------------------------------
  // 60s total cap (regression #2).
  // -----------------------------------------------------------------------

  describe("60s total wall-clock cap", () => {
    it("returns the module's result within the cap when the sweep completes in time", async () => {
      // Simulate a 50ms "slow" sweep; this is well within the 60s cap.
      mockRunIntegritySweep.mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(() => resolve(EMPTY_RESULT), 50),
          ),
      );

      const start = Date.now();
      const response = await GET(
        buildRequest({
          epicId: DEFAULT_EPIC_ID,
          planManifestPath: DEFAULT_PLAN_PATH,
        }),
      );
      const elapsed = Date.now() - start;

      expect(response.status).toBe(200);
      expect(elapsed).toBeLessThan(INTEGRITY_SWEEP_TIMEOUT_MS);
    });

    it("returns fail-closed 200 with `unavailable` when the sweep exceeds the route cap", async () => {
      jest.useFakeTimers();
      try {
        // Sweep that never resolves — route cap must fire.
        mockRunIntegritySweep.mockImplementation(
          () => new Promise(() => undefined),
        );

        const promise = GET(
          buildRequest({
            epicId: DEFAULT_EPIC_ID,
            planManifestPath: DEFAULT_PLAN_PATH,
          }),
        );

        // Advance time past the cap AND flush pending microtasks so the
        // rejection inside withTotalCap propagates to the GET handler's
        // catch block. `advanceTimersByTimeAsync` both advances timers and
        // awaits microtask flushes in a single call.
        await jest.advanceTimersByTimeAsync(INTEGRITY_SWEEP_TIMEOUT_MS + 1);

        const response = await promise;
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.orphans).toEqual([]);
        expect(body.unavailable.length).toBeGreaterThan(0);
      } finally {
        jest.useRealTimers();
      }
    });

    it("exposes INTEGRITY_SWEEP_TIMEOUT_MS as 60_000 (boundary)", () => {
      expect(INTEGRITY_SWEEP_TIMEOUT_MS).toBe(60_000);
    });
  });

  // -----------------------------------------------------------------------
  // Security — loopback-only, no CORS headers.
  // -----------------------------------------------------------------------

  describe("security", () => {
    it("does not set CORS headers (loopback-only default)", async () => {
      mockRunIntegritySweep.mockResolvedValue(EMPTY_RESULT);

      const response = await GET(
        buildRequest({
          epicId: DEFAULT_EPIC_ID,
          planManifestPath: DEFAULT_PLAN_PATH,
        }),
      );

      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      expect(response.headers.get("access-control-allow-credentials")).toBeNull();
      expect(response.headers.get("access-control-allow-methods")).toBeNull();
    });
  });
});
