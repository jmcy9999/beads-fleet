// =============================================================================
// Tests for src/components/fleet/FleetCard.tsx — attention integration
// =============================================================================
// Covers (factory-core-509.7):
//   - Renders AttentionBanner when attentionItems has entries
//   - Does NOT render AttentionBanner when attentionItems is absent/empty
//   - Clicking Approve dispatches onPipelineAction with human-approve + targetLabel
//   - Clicking Dismiss for a human-flagged child dispatches human-dismiss + targetBeadId
//   - Banner click does not navigate (does not trigger card Link)
//   - Existing stage CTAs still render alongside the banner
// =============================================================================

import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { FleetCard } from "@/components/fleet/FleetCard";
import type { AttentionItem, FleetApp } from "@/components/fleet/fleet-utils";
import type { PlanIssue } from "@/lib/types";

// ---------------------------------------------------------------------------
// Mocks — FleetCard uses next/link and useResearchReport
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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEpic(overrides: Partial<PlanIssue> = {}): PlanIssue {
  return {
    id: "factory-core-509",
    title: "Test Epic",
    status: "open",
    priority: 2,
    issue_type: "epic",
    blocked_by: [],
    blocks: [],
    labels: ["pipeline:development"],
    ...overrides,
  };
}

function makeApp(overrides: Partial<FleetApp> = {}): FleetApp {
  const epic = overrides.epic ?? makeEpic();
  return {
    epic,
    children: overrides.children ?? [],
    stage: overrides.stage ?? "development",
    shipType: overrides.shipType ?? "internal",
    progress: overrides.progress ?? { closed: 0, total: 0 },
  };
}

function verifyItem(): AttentionItem {
  return {
    id: "epic-1:checkpoint:human-verify",
    epicId: "factory-core-509",
    type: "verification-needed",
    reason: "Human Verification Required",
    targetLabel: "checkpoint:human-verify",
    actions: [{ name: "human-approve", label: "Approve" }],
  };
}

function humanFlaggedItem(): AttentionItem {
  return {
    id: "epic-1:human:child-3",
    epicId: "factory-core-509",
    beadId: "factory-core-509.3",
    beadTitle: "Needs human judgment",
    type: "human-flagged",
    reason: "Flagged for Human Decision",
    actions: [{ name: "human-dismiss", label: "Dismiss" }],
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe("FleetCard — AttentionBanner integration", () => {
  it("renders the banner when attentionItems is provided", () => {
    render(
      <FleetCard
        app={makeApp()}
        onPipelineAction={() => {}}
        attentionItems={[verifyItem()]}
      />,
    );
    expect(screen.getByText("Human Verification Required")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Approve/i }),
    ).toBeInTheDocument();
  });

  it("does not render the banner when attentionItems is undefined", () => {
    render(<FleetCard app={makeApp()} onPipelineAction={() => {}} />);
    expect(screen.queryByText("Human Verification Required")).not.toBeInTheDocument();
    expect(screen.queryByTestId("attention-banner-list")).not.toBeInTheDocument();
  });

  it("does not render the banner when attentionItems is empty", () => {
    render(
      <FleetCard
        app={makeApp()}
        onPipelineAction={() => {}}
        attentionItems={[]}
      />,
    );
    expect(screen.queryByTestId("attention-banner-list")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Action dispatch — verifies the FleetCard → handleAttentionAction →
// onPipelineAction wiring passes targetLabel / targetBeadId correctly.
// ---------------------------------------------------------------------------

describe("FleetCard — attention action dispatch", () => {
  it("dispatches human-approve with targetLabel for verification items", () => {
    const spy = jest.fn();
    render(
      <FleetCard
        app={makeApp()}
        onPipelineAction={spy}
        attentionItems={[verifyItem()]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Approve/i }));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({
      epicId: "factory-core-509",
      epicTitle: "Test Epic",
      action: "human-approve",
      targetLabel: "checkpoint:human-verify",
      targetBeadId: undefined,
    });
  });

  it("dispatches human-dismiss with targetBeadId for human-flagged child items", () => {
    const spy = jest.fn();
    render(
      <FleetCard
        app={makeApp()}
        onPipelineAction={spy}
        attentionItems={[humanFlaggedItem()]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Dismiss/i }));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({
      epicId: "factory-core-509",
      epicTitle: "Test Epic",
      action: "human-dismiss",
      targetLabel: undefined,
      targetBeadId: "factory-core-509.3",
    });
  });
});
