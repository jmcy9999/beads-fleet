// =============================================================================
// Tests for src/app/fleet/page.tsx — attention system single-source-of-truth
// =============================================================================
// The end-to-end acceptance criteria for 509.8 require running the dashboard
// against real bd data (manual verification). This file covers the in-code
// invariant that cannot be checked by hand: the header badge and the card
// banners must always derive from the same useAttentionItems computation so
// they never disagree (ADR-002 single source of truth).
// =============================================================================

import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import FleetPage from "@/app/fleet/page";
import type { PlanIssue, RobotPlan } from "@/lib/types";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// The page uses internal hooks that hit /api endpoints; mock them with
// deterministic data so the render is pure.

const mockIssues: PlanIssue[] = [
  {
    id: "epic-1",
    title: "Alpha Epic",
    status: "open",
    priority: 1,
    issue_type: "epic",
    blocked_by: [],
    blocks: [],
    labels: ["pipeline:development", "checkpoint:human-verify"],
  },
  {
    id: "epic-2",
    title: "Beta Epic",
    status: "open",
    priority: 2,
    issue_type: "epic",
    blocked_by: [],
    blocks: [],
    labels: ["pipeline:qa", "qa:needs-review"],
  },
  {
    id: "epic-3",
    title: "Gamma Epic",
    status: "open",
    priority: 2,
    issue_type: "epic",
    blocked_by: [],
    blocks: [],
    labels: ["pipeline:development"],
  },
  {
    id: "epic-3.1",
    title: "Flagged child",
    status: "open",
    priority: 2,
    issue_type: "task",
    blocked_by: [],
    blocks: [],
    epic: "epic-3",
    labels: ["human"],
  },
];

const mockPlan: RobotPlan = {
  timestamp: new Date().toISOString(),
  project_path: "/tmp/mock",
  summary: {
    total: mockIssues.length,
    open: 3,
    in_progress: 0,
    blocked: 0,
    closed: 0,
    ready_to_work: 0,
    blocked_count: 0,
    track_count: 1,
  } as unknown as RobotPlan["summary"],
  tracks: [],
  all_issues: mockIssues,
};

jest.mock("@/hooks/useIssues", () => ({
  useIssues: () => ({
    data: mockPlan,
    isLoading: false,
    error: null,
    refetch: jest.fn(),
  }),
}));

jest.mock("@/hooks/useTokenUsage", () => ({
  useTokenUsageSummary: () => ({ data: undefined }),
}));

jest.mock("@/hooks/useAgent", () => ({
  useAgentStatus: () => ({ data: { running: false, session: null } }),
  // factory-core-d5b.7: fleet page now uses fleet-wide status — return an
  // empty agents array so existing attention-system tests see "no agents
  // running" (matches the old single-session fixture).
  useFleetAgentStatus: () => ({ data: { agents: [], totalRunning: 0 } }),
  useAgentStop: () => ({ mutate: jest.fn(), isPending: false }),
}));

jest.mock("@/hooks/usePipelineAction", () => ({
  usePipelineAction: () => ({ mutate: jest.fn() }),
}));

jest.mock("@/hooks/useResearchReport", () => ({
  useResearchReport: () => ({ data: null }),
}));

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <FleetPage />
    </QueryClientProvider>,
  );
}

describe("FleetPage — attention system", () => {
  it("renders the AttentionBadge with the total count across epics", () => {
    renderPage();
    // 3 items expected: checkpoint:human-verify on epic-1, qa:needs-review
    // on epic-2, human-flagged child on epic-3.
    const badge = screen.getByTestId("attention-badge");
    expect(badge).toHaveTextContent("3");
  });

  it("renders attention banners on each affected epic card", () => {
    renderPage();
    expect(screen.getByText("Human Verification Required")).toBeInTheDocument();
    expect(screen.getByText("QA Review Needed")).toBeInTheDocument();
    expect(screen.getByText("Flagged for Human Decision")).toBeInTheDocument();
  });

  it("badge count and banner count agree (single source of truth)", () => {
    renderPage();
    const badge = screen.getByTestId("attention-badge");
    const banners = screen.getAllByTestId("attention-banner-list");
    // Sum the number of banner rows across all cards.
    let renderedItemTotal = 0;
    for (const list of banners) {
      // Each banner row has role=status with aria-label = reason text.
      renderedItemTotal += list.querySelectorAll("[role='status']").length;
    }
    expect(renderedItemTotal).toBe(3);
    expect(badge).toHaveTextContent(String(renderedItemTotal));
  });
});
