import type { BeadsIssue } from "@/lib/types";

const mockReadIssuesFromDolt = jest.fn<Promise<BeadsIssue[]>, [string]>();

jest.mock("@/lib/dolt-reader", () => ({
  readIssuesFromDolt: (...args: [string]) => mockReadIssuesFromDolt(...args),
}));

import {
  __resetReadModelSnapshotsForTests,
  getPortfolioReadSnapshot,
  getRepoReadSnapshot,
  invalidateReadModelSnapshots,
} from "@/lib/read-model-snapshot";

function issue(overrides: Partial<BeadsIssue>): BeadsIssue {
  return {
    id: "test-1",
    title: "Test issue",
    status: "open",
    priority: 2,
    issue_type: "task",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("read-model snapshot", () => {
  const originalTtl = process.env.BEADS_READ_MODEL_TTL_MS;
  const originalStale = process.env.BEADS_READ_MODEL_STALE_MS;

  beforeEach(() => {
    jest.clearAllMocks();
    __resetReadModelSnapshotsForTests();
    delete process.env.BEADS_READ_MODEL_TTL_MS;
    delete process.env.BEADS_READ_MODEL_STALE_MS;
  });

  afterAll(() => {
    if (originalTtl === undefined) {
      delete process.env.BEADS_READ_MODEL_TTL_MS;
    } else {
      process.env.BEADS_READ_MODEL_TTL_MS = originalTtl;
    }
    if (originalStale === undefined) {
      delete process.env.BEADS_READ_MODEL_STALE_MS;
    } else {
      process.env.BEADS_READ_MODEL_STALE_MS = originalStale;
    }
  });

  it("builds and caches a repo plan from Dolt issues", async () => {
    mockReadIssuesFromDolt.mockResolvedValue([
      issue({ id: "repo-a-1", title: "One" }),
    ]);

    const first = await getRepoReadSnapshot("/repos/repo-a");
    const second = await getRepoReadSnapshot("/repos/repo-a");

    expect(first.repoName).toBe("repo-a");
    expect(first.issues).toHaveLength(1);
    expect(first.plan.all_issues[0].id).toBe("repo-a-1");
    expect(second).toBe(first);
    expect(mockReadIssuesFromDolt).toHaveBeenCalledTimes(1);
  });

  it("aggregates portfolio plans and records offline repos", async () => {
    mockReadIssuesFromDolt
      .mockResolvedValueOnce([issue({ id: "A-1", status: "open" })])
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:3306"));

    const snapshot = await getPortfolioReadSnapshot(["/repos/a", "/repos/b"]);

    expect(snapshot.plan.project_path).toBe("__all__");
    expect(snapshot.plan.summary.open_count).toBe(1);
    expect(snapshot.plan.all_issues[0].labels).toContain("project:a");
    expect(snapshot.offline_repos).toEqual([
      {
        repoName: "b",
        repoPath: "/repos/b",
        reason: "connect ECONNREFUSED 127.0.0.1:3306",
      },
    ]);
  });

  it("coalesces concurrent repo refreshes into one Dolt read", async () => {
    let resolveIssues: (issues: BeadsIssue[]) => void = () => undefined;
    mockReadIssuesFromDolt.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveIssues = resolve;
        }),
    );

    const first = getRepoReadSnapshot("/repos/repo-a");
    const second = getRepoReadSnapshot("/repos/repo-a");

    resolveIssues([issue({ id: "A-1" })]);
    const [a, b] = await Promise.all([first, second]);

    expect(a).toBe(b);
    expect(mockReadIssuesFromDolt).toHaveBeenCalledTimes(1);
  });

  it("serves stale data when a refresh fails inside the stale window", async () => {
    process.env.BEADS_READ_MODEL_TTL_MS = "1";
    process.env.BEADS_READ_MODEL_STALE_MS = "60000";
    mockReadIssuesFromDolt.mockResolvedValueOnce([issue({ id: "OLD" })]);

    const oldSnapshot = await getRepoReadSnapshot("/repos/repo-a");
    await new Promise((resolve) => setTimeout(resolve, 5));

    mockReadIssuesFromDolt.mockRejectedValueOnce(new Error("temporary down"));
    const stale = await getRepoReadSnapshot("/repos/repo-a");

    expect(stale).toBe(oldSnapshot);
    expect(stale.plan.all_issues[0].id).toBe("OLD");
  });

  it("does not let an invalidated in-flight refresh repopulate the cache", async () => {
    let resolveIssues: (issues: BeadsIssue[]) => void = () => undefined;
    mockReadIssuesFromDolt.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveIssues = resolve;
        }),
    );

    const pending = getRepoReadSnapshot("/repos/repo-a");
    invalidateReadModelSnapshots({ type: "repo", repoPath: "/repos/repo-a" });
    resolveIssues([issue({ id: "STALE" })]);
    await pending;

    mockReadIssuesFromDolt.mockResolvedValueOnce([issue({ id: "FRESH" })]);
    const fresh = await getRepoReadSnapshot("/repos/repo-a");

    expect(fresh.plan.all_issues[0].id).toBe("FRESH");
    expect(mockReadIssuesFromDolt).toHaveBeenCalledTimes(2);
  });
});
