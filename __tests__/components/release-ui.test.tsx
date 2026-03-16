// =============================================================================
// Tests for release UI components (ProjectReleases, ReleaseIssueList, etc.)
// =============================================================================

import React from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ProjectReleases } from "@/components/releases/ProjectReleases";
import type { PlanIssue } from "@/lib/types";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), back: jest.fn() }),
  usePathname: () => "/releases",
}));

jest.mock("next/link", () => {
  return function MockLink({
    children,
    href,
  }: {
    children: React.ReactNode;
    href: string;
  }) {
    return <a href={href}>{children}</a>;
  };
});

const mockMutateAsync = jest.fn().mockResolvedValue({ success: true });
jest.mock("@/hooks/useIssueAction", () => ({
  useIssueAction: () => ({
    mutateAsync: mockMutateAsync,
    isPending: false,
  }),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeIssue(overrides: Partial<PlanIssue> & { id: string }): PlanIssue {
  return {
    title: overrides.id,
    status: "open",
    priority: 2,
    issue_type: "task",
    blocked_by: [],
    blocks: [],
    ...overrides,
  };
}

const testIssues: PlanIssue[] = [
  makeIssue({
    id: "PC-1",
    title: "Fix onboarding funnel",
    status: "open",
    priority: 1,
    labels: ["release:2.1"],
  }),
  makeIssue({
    id: "PC-2",
    title: "HIG compliance audit",
    status: "in_progress",
    priority: 0,
    issue_type: "epic",
    labels: ["release:2.1"],
  }),
  makeIssue({
    id: "PC-3",
    title: "AI insights BYOK",
    status: "open",
    priority: 3,
    issue_type: "feature",
    labels: ["release:3.0"],
  }),
  makeIssue({
    id: "PC-4",
    title: "Performance fix",
    status: "open",
    priority: 2,
  }),
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ProjectReleases", () => {
  beforeEach(() => {
    mockMutateAsync.mockClear();
  });

  it("renders project name", () => {
    render(<ProjectReleases projectName="PatchCycle" issues={testIssues} />);
    expect(screen.getByText("PatchCycle")).toBeInTheDocument();
  });

  it("shows release versions in ascending order", () => {
    render(<ProjectReleases projectName="PatchCycle" issues={testIssues} />);
    const versionLabels = screen.getAllByText(/^v\d/);
    expect(versionLabels[0]).toHaveTextContent("v2.1");
    expect(versionLabels[1]).toHaveTextContent("v3.0");
  });

  it("shows Unassigned group", () => {
    render(<ProjectReleases projectName="PatchCycle" issues={testIssues} />);
    expect(screen.getByText("Unassigned")).toBeInTheDocument();
  });

  it("shows correct counts for v2.1", () => {
    render(<ProjectReleases projectName="PatchCycle" issues={testIssues} />);
    // v2.1 has 2 total, 0 closed, 2 open
    expect(screen.getByText("(2 open)")).toBeInTheDocument();
  });

  it("shows New Release button", () => {
    render(<ProjectReleases projectName="PatchCycle" issues={testIssues} />);
    expect(screen.getByText("New Release")).toBeInTheDocument();
  });

  it("expands a release on click to show issue list", () => {
    render(<ProjectReleases projectName="PatchCycle" issues={testIssues} />);

    // Issues should not be visible initially
    expect(screen.queryByText("Fix onboarding funnel")).not.toBeInTheDocument();

    // Click the v2.1 row
    const v21Row = screen.getByText("v2.1").closest("[role=button]")!;
    fireEvent.click(v21Row);

    // Now issues should be visible
    expect(screen.getByText("Fix onboarding funnel")).toBeInTheDocument();
    expect(screen.getByText("HIG compliance audit")).toBeInTheDocument();
  });

  it("does not show v3.0 issues when v2.1 is expanded", () => {
    render(<ProjectReleases projectName="PatchCycle" issues={testIssues} />);

    const v21Row = screen.getByText("v2.1").closest("[role=button]")!;
    fireEvent.click(v21Row);

    expect(screen.queryByText("AI insights BYOK")).not.toBeInTheDocument();
  });

  it("collapses on second click", () => {
    render(<ProjectReleases projectName="PatchCycle" issues={testIssues} />);

    const v21Row = screen.getByText("v2.1").closest("[role=button]")!;
    fireEvent.click(v21Row);
    expect(screen.getByText("Fix onboarding funnel")).toBeInTheDocument();

    fireEvent.click(v21Row);
    expect(screen.queryByText("Fix onboarding funnel")).not.toBeInTheDocument();
  });

  it("checkboxes are rendered and clickable when expanded", () => {
    render(<ProjectReleases projectName="PatchCycle" issues={testIssues} />);

    const v21Row = screen.getByText("v2.1").closest("[role=button]")!;
    fireEvent.click(v21Row);

    const checkboxes = screen.getAllByRole("checkbox");
    // Should have at least: select-all + 2 issue checkboxes
    expect(checkboxes.length).toBeGreaterThanOrEqual(3);

    // Click an issue checkbox
    const issueCheckbox = checkboxes[1];
    expect(issueCheckbox).not.toBeChecked();
    fireEvent.click(issueCheckbox);
    expect(issueCheckbox).toBeChecked();
  });

  it("select-all toggles all checkboxes", () => {
    render(<ProjectReleases projectName="PatchCycle" issues={testIssues} />);

    const v21Row = screen.getByText("v2.1").closest("[role=button]")!;
    fireEvent.click(v21Row);

    const checkboxes = screen.getAllByRole("checkbox");
    const selectAll = checkboxes[0];

    // Select all
    fireEvent.click(selectAll);
    const afterSelectAll = screen.getAllByRole("checkbox");
    // All issue checkboxes should be checked
    afterSelectAll.slice(1).forEach((cb) => {
      expect(cb).toBeChecked();
    });

    // Deselect all
    fireEvent.click(selectAll);
    const afterDeselectAll = screen.getAllByRole("checkbox");
    afterDeselectAll.slice(1).forEach((cb) => {
      expect(cb).not.toBeChecked();
    });
  });

  it("shows bulk toolbar when issues are selected", () => {
    render(<ProjectReleases projectName="PatchCycle" issues={testIssues} />);

    const v21Row = screen.getByText("v2.1").closest("[role=button]")!;
    fireEvent.click(v21Row);

    // No toolbar initially
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument();

    // Select an issue
    const checkboxes = screen.getAllByRole("checkbox");
    fireEvent.click(checkboxes[1]);

    // Toolbar should appear
    expect(screen.getByText("1 selected")).toBeInTheDocument();
    expect(screen.getByText("Move to release...")).toBeInTheDocument();
    expect(screen.getByText("Remove from release")).toBeInTheDocument();
  });

  it("shows New Release input on button click", () => {
    render(<ProjectReleases projectName="PatchCycle" issues={testIssues} />);

    fireEvent.click(screen.getByText("New Release"));

    expect(screen.getByPlaceholderText("e.g. 2.2")).toBeInTheDocument();
    expect(screen.getByText("Create")).toBeInTheDocument();
    expect(screen.getByText("Cancel")).toBeInTheDocument();
  });

  it("returns null when no issues", () => {
    const { container } = render(
      <ProjectReleases projectName="Empty" issues={[]} />
    );
    expect(container.innerHTML).toBe("");
  });

  it("shows + button on versioned release rows", () => {
    render(<ProjectReleases projectName="PatchCycle" issues={testIssues} />);
    // Each versioned release row has a + button
    const addButtons = screen.getAllByTitle(/Add beads to v/);
    expect(addButtons.length).toBe(2); // v2.1 and v3.0
  });
});
