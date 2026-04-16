// =============================================================================
// Tests for src/lib/langfuse-env.ts
// =============================================================================
// Epic: factory-core-75e.1
// Covers: isLangfuseConfigured, buildOtelEnv, buildLangfuseTraceUrl

import { isLangfuseConfigured, buildOtelEnv, buildLangfuseTraceUrl } from "@/lib/langfuse-env";

// ---------------------------------------------------------------------------
// Helpers — save and restore process.env around each test
// ---------------------------------------------------------------------------

const LANGFUSE_KEYS = [
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
  "LANGFUSE_BASE_URL",
  "LANGFUSE_PROJECT_ID",
] as const;

let envBackup: Record<string, string | undefined>;

beforeEach(() => {
  envBackup = {};
  for (const key of LANGFUSE_KEYS) {
    envBackup[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of LANGFUSE_KEYS) {
    if (envBackup[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = envBackup[key];
    }
  }
});

// ---------------------------------------------------------------------------
// isLangfuseConfigured
// ---------------------------------------------------------------------------

describe("isLangfuseConfigured", () => {
  it("returns false when both keys are missing", () => {
    expect(isLangfuseConfigured()).toBe(false);
  });

  it("returns false when only public key is set", () => {
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-abc";
    expect(isLangfuseConfigured()).toBe(false);
  });

  it("returns false when only secret key is set", () => {
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-abc";
    expect(isLangfuseConfigured()).toBe(false);
  });

  it("returns false when public key is empty string", () => {
    process.env.LANGFUSE_PUBLIC_KEY = "";
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-abc";
    expect(isLangfuseConfigured()).toBe(false);
  });

  it("returns false when secret key is empty string", () => {
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-abc";
    process.env.LANGFUSE_SECRET_KEY = "";
    expect(isLangfuseConfigured()).toBe(false);
  });

  it("returns false when public key is whitespace only", () => {
    process.env.LANGFUSE_PUBLIC_KEY = "   ";
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-abc";
    expect(isLangfuseConfigured()).toBe(false);
  });

  it("returns false when secret key is whitespace only", () => {
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-abc";
    process.env.LANGFUSE_SECRET_KEY = "  \t  ";
    expect(isLangfuseConfigured()).toBe(false);
  });

  it("returns true when both keys are set and non-empty", () => {
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-abc";
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-def";
    expect(isLangfuseConfigured()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildOtelEnv
// ---------------------------------------------------------------------------

describe("buildOtelEnv", () => {
  describe("when credentials are missing", () => {
    it("returns empty object when no env vars set", () => {
      expect(buildOtelEnv()).toEqual({});
    });

    it("returns empty object when only public key is set", () => {
      process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-abc";
      expect(buildOtelEnv({ epicId: "test-123" })).toEqual({});
    });

    it("returns empty object when secret key is empty", () => {
      process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-abc";
      process.env.LANGFUSE_SECRET_KEY = "";
      expect(buildOtelEnv({ epicId: "test-123" })).toEqual({});
    });
  });

  describe("when credentials are set", () => {
    beforeEach(() => {
      process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test123";
      process.env.LANGFUSE_SECRET_KEY = "sk-lf-secret456";
    });

    it("returns OTEL env vars with default base URL", () => {
      const result = buildOtelEnv();
      expect(result.CLAUDE_CODE_ENABLE_TELEMETRY).toBe("1");
      expect(result.OTEL_EXPORTER_OTLP_PROTOCOL).toBe("http/protobuf");
      expect(result.OTEL_EXPORTER_OTLP_ENDPOINT).toBe("https://cloud.langfuse.com/api/public/otel");
    });

    it("uses custom base URL when LANGFUSE_BASE_URL is set", () => {
      process.env.LANGFUSE_BASE_URL = "https://my-langfuse.example.com";
      const result = buildOtelEnv();
      expect(result.OTEL_EXPORTER_OTLP_ENDPOINT).toBe("https://my-langfuse.example.com/api/public/otel");
    });

    it("strips trailing slash from base URL", () => {
      process.env.LANGFUSE_BASE_URL = "https://cloud.langfuse.com/";
      const result = buildOtelEnv();
      expect(result.OTEL_EXPORTER_OTLP_ENDPOINT).toBe("https://cloud.langfuse.com/api/public/otel");
    });

    it("computes correct Base64 auth string", () => {
      const result = buildOtelEnv();
      const expected = Buffer.from("pk-lf-test123:sk-lf-secret456").toString("base64");
      expect(result.OTEL_EXPORTER_OTLP_HEADERS).toBe(`Authorization=Basic ${expected}`);
    });

    it("includes epicId in resource attributes", () => {
      const result = buildOtelEnv({ epicId: "factory-core-xyz" });
      expect(result.OTEL_RESOURCE_ATTRIBUTES).toContain("epic.id=factory-core-xyz");
    });

    it("includes agentType in resource attributes", () => {
      const result = buildOtelEnv({ agentType: "builder" });
      expect(result.OTEL_RESOURCE_ATTRIBUTES).toContain("agent.type=builder");
    });

    it("includes pipelineStage in resource attributes", () => {
      const result = buildOtelEnv({ pipelineStage: "development" });
      expect(result.OTEL_RESOURCE_ATTRIBUTES).toContain("pipeline.stage=development");
    });

    it("includes repoName in resource attributes", () => {
      const result = buildOtelEnv({ repoName: "beads_web" });
      expect(result.OTEL_RESOURCE_ATTRIBUTES).toContain("repo.name=beads_web");
    });

    it("includes session.id matching epicId for Langfuse grouping", () => {
      const result = buildOtelEnv({ epicId: "factory-core-xyz" });
      expect(result.OTEL_RESOURCE_ATTRIBUTES).toContain("session.id=factory-core-xyz");
    });

    it("includes all context fields in resource attributes", () => {
      const result = buildOtelEnv({
        epicId: "factory-core-xyz",
        agentType: "builder",
        pipelineStage: "development",
        repoName: "beads_web",
      });
      const attrs = result.OTEL_RESOURCE_ATTRIBUTES!;
      expect(attrs).toContain("epic.id=factory-core-xyz");
      expect(attrs).toContain("agent.type=builder");
      expect(attrs).toContain("pipeline.stage=development");
      expect(attrs).toContain("repo.name=beads_web");
      expect(attrs).toContain("session.id=factory-core-xyz");
    });

    it("omits OTEL_RESOURCE_ATTRIBUTES when no context provided", () => {
      const result = buildOtelEnv();
      expect(result.OTEL_RESOURCE_ATTRIBUTES).toBeUndefined();
    });

    it("omits OTEL_RESOURCE_ATTRIBUTES when context is empty", () => {
      const result = buildOtelEnv({});
      expect(result.OTEL_RESOURCE_ATTRIBUTES).toBeUndefined();
    });

    it("omits undefined context fields from resource attributes", () => {
      const result = buildOtelEnv({ epicId: "test", agentType: undefined });
      const attrs = result.OTEL_RESOURCE_ATTRIBUTES!;
      expect(attrs).toContain("epic.id=test");
      expect(attrs).not.toContain("agent.type");
    });
  });
});

// ---------------------------------------------------------------------------
// buildLangfuseTraceUrl
// ---------------------------------------------------------------------------

describe("buildLangfuseTraceUrl", () => {
  it("returns undefined when LANGFUSE_PROJECT_ID is not set", () => {
    expect(buildLangfuseTraceUrl("factory-core-xyz")).toBeUndefined();
  });

  it("returns undefined when LANGFUSE_PROJECT_ID is empty", () => {
    process.env.LANGFUSE_PROJECT_ID = "";
    expect(buildLangfuseTraceUrl("factory-core-xyz")).toBeUndefined();
  });

  it("returns undefined when LANGFUSE_PROJECT_ID is whitespace only", () => {
    process.env.LANGFUSE_PROJECT_ID = "   ";
    expect(buildLangfuseTraceUrl("factory-core-xyz")).toBeUndefined();
  });

  it("returns correct URL with default base URL", () => {
    process.env.LANGFUSE_PROJECT_ID = "cmnrd805e01oaad07nluckrme";
    const url = buildLangfuseTraceUrl("factory-core-xyz");
    expect(url).toBe(
      "https://cloud.langfuse.com/project/cmnrd805e01oaad07nluckrme/sessions/factory-core-xyz"
    );
  });

  it("returns correct URL with custom base URL", () => {
    process.env.LANGFUSE_PROJECT_ID = "proj123";
    process.env.LANGFUSE_BASE_URL = "https://my-langfuse.example.com";
    const url = buildLangfuseTraceUrl("epic-abc");
    expect(url).toBe(
      "https://my-langfuse.example.com/project/proj123/sessions/epic-abc"
    );
  });

  it("strips trailing slash from base URL", () => {
    process.env.LANGFUSE_PROJECT_ID = "proj123";
    process.env.LANGFUSE_BASE_URL = "https://cloud.langfuse.com/";
    const url = buildLangfuseTraceUrl("epic-abc");
    expect(url).toBe(
      "https://cloud.langfuse.com/project/proj123/sessions/epic-abc"
    );
  });

  it("trims whitespace from project ID", () => {
    process.env.LANGFUSE_PROJECT_ID = "  proj123  ";
    const url = buildLangfuseTraceUrl("epic-abc");
    expect(url).toContain("/project/proj123/sessions/");
  });

  it("encodes special characters in epicId", () => {
    process.env.LANGFUSE_PROJECT_ID = "proj123";
    const url = buildLangfuseTraceUrl("epic with spaces");
    expect(url).toContain("sessions/epic%20with%20spaces");
  });

  it("handles typical bead IDs correctly", () => {
    process.env.LANGFUSE_PROJECT_ID = "proj123";
    const url = buildLangfuseTraceUrl("factory-core-75e");
    expect(url).toBe(
      "https://cloud.langfuse.com/project/proj123/sessions/factory-core-75e"
    );
  });
});
