// =============================================================================
// Tests for src/lib/dolt-reader.ts — Dolt MySQL reader
// =============================================================================
// Unit tests mock mysql2 to test query construction and result parsing.
// Integration tests (marked with .skip by default) hit a real Dolt server.
// =============================================================================

import * as mysql from "mysql2/promise";
import { readIssuesFromDolt } from "@/lib/dolt-reader";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Mock mysql2/promise
jest.mock("mysql2/promise");
const mockCreateConnection = mysql.createConnection as jest.MockedFunction<
  typeof mysql.createConnection
>;

// ---------------------------------------------------------------------------
// Helpers: create temp .beads directories with Dolt config files
// ---------------------------------------------------------------------------

function createDoltFixture(opts: {
  port?: number;
  database?: string;
  noPortFile?: boolean;
  noMetadata?: boolean;
  invalidPort?: boolean;
}): { projectPath: string; cleanup: () => void } {
  const projectPath = mkdtempSync(join(tmpdir(), "beads-dolt-test-"));
  const beadsDir = join(projectPath, ".beads");
  mkdirSync(beadsDir);

  if (!opts.noPortFile) {
    const portContent = opts.invalidPort ? "not-a-number" : String(opts.port ?? 57619);
    writeFileSync(join(beadsDir, "dolt-server.port"), portContent);
  }

  if (!opts.noMetadata) {
    writeFileSync(
      join(beadsDir, "metadata.json"),
      JSON.stringify({
        database: "dolt",
        backend: "dolt",
        dolt_mode: "server",
        dolt_database: opts.database ?? "test_db",
      }),
    );
  }

  return {
    projectPath,
    cleanup: () => {
      try {
        const { rmSync } = require("fs");
        rmSync(projectPath, { recursive: true, force: true });
      } catch {
        // best effort
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Helper: create a mock mysql2 connection
// ---------------------------------------------------------------------------

function createMockConnection(opts: {
  issueRows?: Record<string, unknown>[];
  depRows?: Record<string, unknown>[];
  columns?: { Field: string }[];
}) {
  const mockQuery = jest.fn();
  const mockEnd = jest.fn();

  // SHOW COLUMNS call
  mockQuery.mockResolvedValueOnce([
    opts.columns ?? [
      { Field: "id" },
      { Field: "title" },
      { Field: "description" },
      { Field: "status" },
      { Field: "priority" },
      { Field: "issue_type" },
      { Field: "owner" },
      { Field: "created_at" },
      { Field: "created_by" },
      { Field: "updated_at" },
      { Field: "closed_at" },
      { Field: "close_reason" },
      { Field: "notes" },
      { Field: "due_at" },
      { Field: "estimated_minutes" },
    ],
  ]);

  // Issues query
  mockQuery.mockResolvedValueOnce([opts.issueRows ?? []]);

  // Dependencies query
  mockQuery.mockResolvedValueOnce([opts.depRows ?? []]);

  const mockConn = {
    query: mockQuery,
    end: mockEnd,
  } as unknown as mysql.Connection;

  mockCreateConnection.mockResolvedValue(mockConn);

  return { mockQuery, mockEnd, mockConn };
}

// =============================================================================
// Unit tests (mocked mysql2)
// =============================================================================

describe("readIssuesFromDolt", () => {
  afterEach(() => {
    jest.resetAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Port and config discovery
  // ---------------------------------------------------------------------------

  describe("config discovery", () => {
    it("throws when no .beads/dolt-server.port file exists", async () => {
      const fixture = createDoltFixture({ noPortFile: true });
      try {
        await expect(readIssuesFromDolt(fixture.projectPath)).rejects.toThrow(
          "No Dolt server port found",
        );
      } finally {
        fixture.cleanup();
      }
    });

    it("throws when port file contains non-numeric content", async () => {
      const fixture = createDoltFixture({ invalidPort: true });
      try {
        await expect(readIssuesFromDolt(fixture.projectPath)).rejects.toThrow(
          "No Dolt server port found",
        );
      } finally {
        fixture.cleanup();
      }
    });

    it("reads port from .beads/dolt-server.port", async () => {
      const fixture = createDoltFixture({ port: 12345 });
      createMockConnection({});
      try {
        await readIssuesFromDolt(fixture.projectPath);
        expect(mockCreateConnection).toHaveBeenCalledWith(
          expect.objectContaining({ port: 12345 }),
        );
      } finally {
        fixture.cleanup();
      }
    });

    it("reads database name from metadata.json dolt_database field", async () => {
      const fixture = createDoltFixture({ database: "my_project" });
      createMockConnection({});
      try {
        await readIssuesFromDolt(fixture.projectPath);
        expect(mockCreateConnection).toHaveBeenCalledWith(
          expect.objectContaining({ database: "my_project" }),
        );
      } finally {
        fixture.cleanup();
      }
    });

    it("falls back to directory name when metadata has no dolt_database", async () => {
      const fixture = createDoltFixture({ noMetadata: true });
      createMockConnection({});
      try {
        await readIssuesFromDolt(fixture.projectPath);
        const callArgs = mockCreateConnection.mock.calls[0][0] as Record<string, unknown>;
        // Database name should be the temp dir's basename
        expect(typeof callArgs.database).toBe("string");
        expect((callArgs.database as string).length).toBeGreaterThan(0);
      } finally {
        fixture.cleanup();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Connection settings
  // ---------------------------------------------------------------------------

  describe("connection", () => {
    it("connects to 127.0.0.1 with user root", async () => {
      const fixture = createDoltFixture({});
      createMockConnection({});
      try {
        await readIssuesFromDolt(fixture.projectPath);
        expect(mockCreateConnection).toHaveBeenCalledWith(
          expect.objectContaining({
            host: "127.0.0.1",
            user: "root",
          }),
        );
      } finally {
        fixture.cleanup();
      }
    });

    it("sets a 3-second connect timeout", async () => {
      const fixture = createDoltFixture({});
      createMockConnection({});
      try {
        await readIssuesFromDolt(fixture.projectPath);
        expect(mockCreateConnection).toHaveBeenCalledWith(
          expect.objectContaining({ connectTimeout: 3000 }),
        );
      } finally {
        fixture.cleanup();
      }
    });

    it("closes connection after successful read", async () => {
      const fixture = createDoltFixture({});
      const { mockEnd } = createMockConnection({});
      try {
        await readIssuesFromDolt(fixture.projectPath);
        expect(mockEnd).toHaveBeenCalled();
      } finally {
        fixture.cleanup();
      }
    });

    it("closes connection even when query fails", async () => {
      const fixture = createDoltFixture({});
      const mockEnd = jest.fn();
      const mockQuery = jest.fn().mockRejectedValue(new Error("query failed"));
      const mockConn = { query: mockQuery, end: mockEnd } as unknown as mysql.Connection;
      mockCreateConnection.mockResolvedValue(mockConn);
      try {
        await expect(readIssuesFromDolt(fixture.projectPath)).rejects.toThrow("query failed");
        expect(mockEnd).toHaveBeenCalled();
      } finally {
        fixture.cleanup();
      }
    });

    it("throws when Dolt server is unreachable", async () => {
      const fixture = createDoltFixture({});
      mockCreateConnection.mockRejectedValue(new Error("ECONNREFUSED"));
      try {
        await expect(readIssuesFromDolt(fixture.projectPath)).rejects.toThrow("ECONNREFUSED");
      } finally {
        fixture.cleanup();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Issue parsing
  // ---------------------------------------------------------------------------

  describe("issue parsing", () => {
    it("returns empty array when no issues exist", async () => {
      const fixture = createDoltFixture({});
      createMockConnection({ issueRows: [], depRows: [] });
      try {
        const issues = await readIssuesFromDolt(fixture.projectPath);
        expect(issues).toEqual([]);
      } finally {
        fixture.cleanup();
      }
    });

    it("parses issue fields correctly", async () => {
      const fixture = createDoltFixture({});
      createMockConnection({
        issueRows: [
          {
            id: "TEST-1",
            title: "Test issue",
            description: "A description",
            status: "open",
            priority: 1,
            issue_type: "task",
            owner: "jane@example.com",
            labels_csv: "backend,auth",
            created_at: "2026-01-01T00:00:00Z",
            created_by: "jane",
            updated_at: "2026-01-02T00:00:00Z",
            closed_at: null,
            close_reason: null,
            notes: "Some notes",
            due_at: null,
            estimated_minutes: 60,
          },
        ],
      });
      try {
        const issues = await readIssuesFromDolt(fixture.projectPath);
        expect(issues).toHaveLength(1);
        const issue = issues[0];
        expect(issue.id).toBe("TEST-1");
        expect(issue.title).toBe("Test issue");
        expect(issue.description).toBe("A description");
        expect(issue.status).toBe("open");
        expect(issue.priority).toBe(1);
        expect(issue.issue_type).toBe("task");
        expect(issue.owner).toBe("jane@example.com");
        expect(issue.labels).toEqual(["backend", "auth"]);
        expect(issue.notes).toBe("Some notes");
        expect(issue.estimated_minutes).toBe(60);
        expect(issue.closed_at).toBeUndefined();
        expect(issue.close_reason).toBeUndefined();
      } finally {
        fixture.cleanup();
      }
    });

    it("handles null labels_csv as undefined labels", async () => {
      const fixture = createDoltFixture({});
      createMockConnection({
        issueRows: [
          {
            id: "TEST-1", title: "No labels", description: "", status: "open",
            priority: 2, issue_type: "bug", owner: null, labels_csv: null,
            created_at: "2026-01-01T00:00:00Z", created_by: null,
            updated_at: "2026-01-01T00:00:00Z", closed_at: null,
            close_reason: null, notes: null, due_at: null, estimated_minutes: null,
          },
        ],
      });
      try {
        const issues = await readIssuesFromDolt(fixture.projectPath);
        expect(issues[0].labels).toBeUndefined();
        expect(issues[0].owner).toBeUndefined();
      } finally {
        fixture.cleanup();
      }
    });

    it("parses dependencies and groups by issue_id", async () => {
      const fixture = createDoltFixture({});
      createMockConnection({
        issueRows: [
          {
            id: "TEST-1", title: "Blocker", description: "", status: "open",
            priority: 1, issue_type: "task", owner: null, labels_csv: null,
            created_at: "2026-01-01T00:00:00Z", created_by: null,
            updated_at: "2026-01-01T00:00:00Z", closed_at: null,
            close_reason: null, notes: null, due_at: null, estimated_minutes: null,
          },
          {
            id: "TEST-2", title: "Blocked", description: "", status: "blocked",
            priority: 1, issue_type: "task", owner: null, labels_csv: null,
            created_at: "2026-01-01T00:00:00Z", created_by: null,
            updated_at: "2026-01-01T00:00:00Z", closed_at: null,
            close_reason: null, notes: null, due_at: null, estimated_minutes: null,
          },
        ],
        depRows: [
          {
            issue_id: "TEST-2",
            depends_on_id: "TEST-1",
            type: "blocks",
            created_at: "2026-01-01T00:00:00Z",
            created_by: "jane",
          },
        ],
      });
      try {
        const issues = await readIssuesFromDolt(fixture.projectPath);
        const blocked = issues.find((i) => i.id === "TEST-2");
        expect(blocked!.dependencies).toHaveLength(1);
        expect(blocked!.dependencies![0].depends_on_id).toBe("TEST-1");
        expect(blocked!.dependencies![0].type).toBe("blocks");

        const blocker = issues.find((i) => i.id === "TEST-1");
        expect(blocker!.dependencies).toBeUndefined();
      } finally {
        fixture.cleanup();
      }
    });

    it("handles optional story_points column when present", async () => {
      const fixture = createDoltFixture({});
      createMockConnection({
        columns: [
          { Field: "id" }, { Field: "title" }, { Field: "description" },
          { Field: "status" }, { Field: "priority" }, { Field: "issue_type" },
          { Field: "owner" }, { Field: "created_at" }, { Field: "created_by" },
          { Field: "updated_at" }, { Field: "closed_at" }, { Field: "close_reason" },
          { Field: "notes" }, { Field: "due_at" }, { Field: "estimated_minutes" },
          { Field: "story_points" },
        ],
        issueRows: [
          {
            id: "TEST-1", title: "With points", description: "", status: "open",
            priority: 1, issue_type: "task", owner: null, labels_csv: null,
            created_at: "2026-01-01T00:00:00Z", created_by: null,
            updated_at: "2026-01-01T00:00:00Z", closed_at: null,
            close_reason: null, notes: null, due_at: null,
            estimated_minutes: null, story_points: 5,
          },
        ],
      });
      try {
        const issues = await readIssuesFromDolt(fixture.projectPath);
        expect(issues[0].story_points).toBe(5);
      } finally {
        fixture.cleanup();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Query correctness
  // ---------------------------------------------------------------------------

  describe("query construction", () => {
    it("filters out tombstone issues (status <> tombstone)", async () => {
      const fixture = createDoltFixture({});
      const { mockQuery } = createMockConnection({});
      try {
        await readIssuesFromDolt(fixture.projectPath);
        // Second call is the issues query (first is SHOW COLUMNS)
        const issueQuery = mockQuery.mock.calls[1][0] as string;
        expect(issueQuery).toContain("status <> 'tombstone'");
      } finally {
        fixture.cleanup();
      }
    });

    it("does NOT filter on deleted_at (column does not exist in Dolt)", async () => {
      const fixture = createDoltFixture({});
      const { mockQuery } = createMockConnection({});
      try {
        await readIssuesFromDolt(fixture.projectPath);
        const issueQuery = mockQuery.mock.calls[1][0] as string;
        expect(issueQuery).not.toContain("deleted_at");
      } finally {
        fixture.cleanup();
      }
    });

    it("joins labels via GROUP_CONCAT", async () => {
      const fixture = createDoltFixture({});
      const { mockQuery } = createMockConnection({});
      try {
        await readIssuesFromDolt(fixture.projectPath);
        const issueQuery = mockQuery.mock.calls[1][0] as string;
        expect(issueQuery).toContain("GROUP_CONCAT(l.label)");
        expect(issueQuery).toContain("LEFT JOIN labels l ON l.issue_id = i.id");
      } finally {
        fixture.cleanup();
      }
    });

    it("queries dependencies table separately", async () => {
      const fixture = createDoltFixture({});
      const { mockQuery } = createMockConnection({});
      try {
        await readIssuesFromDolt(fixture.projectPath);
        // Third call is dependencies
        const depQuery = mockQuery.mock.calls[2][0] as string;
        expect(depQuery).toContain("FROM dependencies");
      } finally {
        fixture.cleanup();
      }
    });
  });
});
