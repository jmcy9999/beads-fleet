// =============================================================================
// Tests for src/components/fleet/FleetBoard.tsx — offline_repos banner (lmxb.7)
// =============================================================================
// Covers the kill-test acceptance criteria from factory-core-lmxb.7:
//
//   1. When offlineRepos contains N entries, the dashboard renders N visually
//      distinguishable offline indicators alongside online repos.
//   2. The reason string is reachable to the operator (aria-label OR visible
//      text — the contract is "reachable").
//   3. offlineRepos === undefined does not throw and renders no offline
//      indicators.
//   4. Healthy repos with running Dolt continue to render unchanged — no
//      regression.
//   5. Offline state is conveyed to a screen-reader by role + aria-label, not
//      colour alone (WCAG 2.1 SC 1.4.1 — non-colour cue: warning-icon shape +
//      "Offline" text badge + visible name + reason).
//
// Fixtures use the real OfflineRepoInfo type from @/lib/types — no
// hand-rolled stubs. The kill-test on a real Dolt sql-server provided the
// reason-string shape that this test pins ("connect ECONNREFUSED 127.0.0.1:
// <port>" — verbatim mysql2 message, per architect memo § Security
// Architecture).
// =============================================================================

import React from "react";
import { render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { FleetBoard } from "@/components/fleet/FleetBoard";
import type { PlanIssue, OfflineRepoInfo } from "@/lib/types";

// ---------------------------------------------------------------------------
// Mocks — FleetCard's children chain pulls in next/link + a couple of hooks.
// Kill those network/hook touches so the rendered component is pure.
// ---------------------------------------------------------------------------

jest.mock("next/link", () => {
  return function MockLink({
    children,
    href,
    onClick,
    className,
  }: {
    children: React.ReactNode;
    href: string;
    onClick?: (e: React.MouseEvent) => void;
    className?: string;
  }) {
    return (
      <a href={href} onClick={onClick} className={className}>
        {children}
      </a>
    );
  };
});

jest.mock("@/hooks/useResearchReport", () => ({
  useResearchReport: () => ({ data: null }),
}));

jest.mock("@/hooks/useWaveStatus", () => ({
  useWaveStatus: () => ({ data: null }),
}));

// localStorage is read in FleetBoard for column visibility — jsdom provides it.

// ---------------------------------------------------------------------------
// Fixtures — real OfflineRepoInfo + PlanIssue shapes (no stubs)
// ---------------------------------------------------------------------------

const PATCHCYCLE: OfflineRepoInfo = {
  repoName: "PatchCycle",
  repoPath: "/Users/janemckay/dev/claude_projects/change_my_patch/PatchCycle",
  reason: "connect ECONNREFUSED 127.0.0.1:54666",
};

const TEST_GOBLIN: OfflineRepoInfo = {
  repoName: "test_goblin",
  repoPath: "/Users/janemckay/dev/claude_projects/test_goblin",
  reason: "connect ECONNREFUSED 127.0.0.1:62033",
};

function makeEpic(overrides: Partial<PlanIssue> = {}): PlanIssue {
  return {
    id: overrides.id ?? "epic-online",
    title: overrides.title ?? "Healthy Epic",
    status: overrides.status ?? "open",
    priority: overrides.priority ?? 2,
    issue_type: "epic",
    blocked_by: [],
    blocks: [],
    labels: ["pipeline:development"],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FleetBoard — offline_repos banner (lmxb.7)", () => {
  it("renders no banner when offlineRepos is undefined (single-repo plan / legacy response)", () => {
    render(<FleetBoard issues={[makeEpic()]} />);

    expect(screen.queryByTestId("offline-repos-banner")).not.toBeInTheDocument();
  });

  it("renders no banner when offlineRepos is an empty array (all fan-outs fulfilled)", () => {
    render(<FleetBoard issues={[makeEpic()]} offlineRepos={[]} />);

    expect(screen.queryByTestId("offline-repos-banner")).not.toBeInTheDocument();
  });

  it("renders one offline-repo entry per OfflineRepoInfo (N entries → N rows)", () => {
    render(
      <FleetBoard issues={[makeEpic()]} offlineRepos={[PATCHCYCLE, TEST_GOBLIN]} />,
    );

    const banner = screen.getByTestId("offline-repos-banner");
    expect(banner).toBeInTheDocument();

    const entries = within(banner).getAllByTestId("offline-repo-entry");
    expect(entries).toHaveLength(2);
  });

  it("each offline-repo entry shows the visible repo name", () => {
    render(<FleetBoard issues={[]} offlineRepos={[PATCHCYCLE, TEST_GOBLIN]} />);

    const banner = screen.getByTestId("offline-repos-banner");
    const names = within(banner).getAllByTestId("offline-repo-name");
    expect(names.map((n) => n.textContent)).toEqual(["PatchCycle", "test_goblin"]);
  });

  it("each offline-repo entry shows the reason string visibly inline", () => {
    render(<FleetBoard issues={[]} offlineRepos={[PATCHCYCLE, TEST_GOBLIN]} />);

    const banner = screen.getByTestId("offline-repos-banner");
    const reasons = within(banner).getAllByTestId("offline-repo-reason");
    expect(reasons.map((r) => r.textContent)).toEqual([
      "connect ECONNREFUSED 127.0.0.1:54666",
      "connect ECONNREFUSED 127.0.0.1:62033",
    ]);
  });

  it("each offline-repo entry has role='status' and an aria-label combining name + reason (screen-reader signal)", () => {
    render(<FleetBoard issues={[]} offlineRepos={[PATCHCYCLE]} />);

    const entry = screen.getByTestId("offline-repo-entry");
    // role="status" on the <li> — announced as a live region by AT.
    expect(entry).toHaveAttribute("role", "status");
    // aria-label combines name + reason so the full status is reachable
    // without depending on visible-element traversal order.
    expect(entry).toHaveAttribute(
      "aria-label",
      "PatchCycle is offline: connect ECONNREFUSED 127.0.0.1:54666",
    );
  });

  it("shows a non-colour 'Offline' text badge in addition to the status colour (WCAG 2.1 SC 1.4.1)", () => {
    render(<FleetBoard issues={[]} offlineRepos={[PATCHCYCLE]} />);

    // The text badge "Offline" is rendered (visible text — not colour-only).
    const banner = screen.getByTestId("offline-repos-banner");
    expect(within(banner).getByText("Offline")).toBeInTheDocument();
  });

  it("banner heading reports the offline count (singular form for 1)", () => {
    render(<FleetBoard issues={[]} offlineRepos={[PATCHCYCLE]} />);

    expect(screen.getByText("1 offline repo")).toBeInTheDocument();
  });

  it("banner heading reports the offline count (plural form for >1)", () => {
    render(
      <FleetBoard issues={[]} offlineRepos={[PATCHCYCLE, TEST_GOBLIN]} />,
    );

    expect(screen.getByText("2 offline repos")).toBeInTheDocument();
  });

  it("banner does not regress healthy-repo rendering — kanban toolbar still present alongside banner (mixed scenario)", () => {
    // The kanban toolbar's ship-type filter is a stable anchor for the
    // existing render path. If the offline banner suppressed the kanban,
    // this assertion would fail.
    const epic = makeEpic({ id: "mixed-epic", title: "Mixed Epic" });
    render(<FleetBoard issues={[epic]} offlineRepos={[PATCHCYCLE]} />);

    // Banner is rendered.
    expect(screen.getByTestId("offline-repos-banner")).toBeInTheDocument();
    // Kanban toolbar's "All" ship-type filter button still rendered.
    expect(screen.getByRole("button", { name: "All" })).toBeInTheDocument();
  });

  it("preserves OfflineRepoInfo identity per repoPath via data-* attribute (debug signal for future enrichment)", () => {
    render(
      <FleetBoard issues={[]} offlineRepos={[PATCHCYCLE, TEST_GOBLIN]} />,
    );

    const banner = screen.getByTestId("offline-repos-banner");
    const entries = within(banner).getAllByTestId("offline-repo-entry");
    expect(entries[0]).toHaveAttribute("data-repo-name", "PatchCycle");
    expect(entries[1]).toHaveAttribute("data-repo-name", "test_goblin");
  });
});
