// =============================================================================
// Tests for src/app/api/version/route.ts — GET /api/version
// =============================================================================

import { GET } from "@/app/api/version/route";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/version", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("returns 200 with gitSha, buildTime, and packageVersion", async () => {
    process.env.GIT_SHA = "abc123def456";
    process.env.BUILD_TIME = "2026-04-30T12:00:00.000Z";

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      gitSha: "abc123def456",
      buildTime: "2026-04-30T12:00:00.000Z",
      packageVersion: expect.any(String),
    });
  });

  it("returns env var values when GIT_SHA and BUILD_TIME are set", async () => {
    process.env.GIT_SHA = "deadbeef";
    process.env.BUILD_TIME = "2026-01-01T00:00:00.000Z";

    const response = await GET();
    const body = await response.json();

    expect(body.gitSha).toBe("deadbeef");
    expect(body.buildTime).toBe("2026-01-01T00:00:00.000Z");
  });

  it("returns packageVersion matching package.json version field", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require("../../package.json");

    const response = await GET();
    const body = await response.json();

    expect(body.packageVersion).toBe(pkg.version);
  });

  it("returns 'unknown' for gitSha when GIT_SHA is unset", async () => {
    delete process.env.GIT_SHA;
    process.env.BUILD_TIME = "2026-04-30T12:00:00.000Z";

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.gitSha).toBe("unknown");
    expect(body.buildTime).toBe("2026-04-30T12:00:00.000Z");
  });

  it("returns 'unknown' for buildTime when BUILD_TIME is unset", async () => {
    process.env.GIT_SHA = "abc123";
    delete process.env.BUILD_TIME;

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.gitSha).toBe("abc123");
    expect(body.buildTime).toBe("unknown");
  });

  it("returns 'unknown' for both when neither env var is set", async () => {
    delete process.env.GIT_SHA;
    delete process.env.BUILD_TIME;

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.gitSha).toBe("unknown");
    expect(body.buildTime).toBe("unknown");
    expect(body.packageVersion).toEqual(expect.any(String));
  });
});
