// =============================================================================
// Tests for src/components/fleet/AttentionBanner.tsx
// =============================================================================
// Covers (functional spec Feature 2 acceptance criteria):
//   - Empty array → renders nothing (null)
//   - Verification-needed → "Human Verification Required" + Approve button
//   - QA review → "QA Review Needed" + Dismiss button
//   - Multiple items stack, all rendered
//   - Action button invokes onAction with (item, actionName)
//   - Second click while pending is suppressed
//   - Click.stopPropagation prevents navigation (Link wrapper parent)
//   - Human-flagged item shows bead title context
// (factory-core-509.5)
// =============================================================================

import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { AttentionBanner } from "@/components/fleet/AttentionBanner";
import type { AttentionItem } from "@/components/fleet/fleet-utils";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function item(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: "epic-1:checkpoint:human-verify",
    epicId: "epic-1",
    type: "verification-needed",
    reason: "Human Verification Required",
    targetLabel: "checkpoint:human-verify",
    actions: [{ name: "human-approve", label: "Approve" }],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

describe("AttentionBanner — empty", () => {
  it("renders nothing when items array is empty", () => {
    const { container } = render(<AttentionBanner items={[]} onAction={() => {}} />);
    expect(container.firstChild).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Single-item rendering
// ---------------------------------------------------------------------------

describe("AttentionBanner — rendering", () => {
  it("renders verification-needed with Approve button", () => {
    render(<AttentionBanner items={[item()]} onAction={() => {}} />);
    expect(screen.getByText("Human Verification Required")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Approve/i }),
    ).toBeInTheDocument();
  });

  it("renders qa-review with Dismiss button", () => {
    render(
      <AttentionBanner
        items={[
          item({
            id: "epic-1:qa:needs-review",
            type: "qa-review",
            reason: "QA Review Needed",
            targetLabel: "qa:needs-review",
            actions: [{ name: "human-dismiss", label: "Dismiss" }],
          }),
        ]}
        onAction={() => {}}
      />,
    );
    expect(screen.getByText("QA Review Needed")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Dismiss/i }),
    ).toBeInTheDocument();
  });

  it("includes bead title context for human-flagged items", () => {
    render(
      <AttentionBanner
        items={[
          item({
            id: "epic-1:human:epic-1.3",
            type: "human-flagged",
            reason: "Flagged for Human Decision",
            beadId: "epic-1.3",
            beadTitle: "Ambiguous migration path",
            targetLabel: undefined,
            actions: [{ name: "human-dismiss", label: "Dismiss" }],
          }),
        ]}
        onAction={() => {}}
      />,
    );
    expect(screen.getByText("Flagged for Human Decision")).toBeInTheDocument();
    expect(
      screen.getByText(/epic-1\.3: Ambiguous migration path/),
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Multiple items
// ---------------------------------------------------------------------------

describe("AttentionBanner — multiple items", () => {
  it("renders every item, not just the first", () => {
    const items: AttentionItem[] = [
      item(),
      item({
        id: "epic-1:checkpoint:decision",
        type: "decision-required",
        reason: "Decision Required",
        targetLabel: "checkpoint:decision",
        actions: [{ name: "human-dismiss", label: "Dismiss" }],
      }),
      item({
        id: "epic-1:qa:needs-review",
        type: "qa-review",
        reason: "QA Review Needed",
        targetLabel: "qa:needs-review",
        actions: [{ name: "human-dismiss", label: "Dismiss" }],
      }),
    ];
    render(<AttentionBanner items={items} onAction={() => {}} />);
    expect(screen.getByText("Human Verification Required")).toBeInTheDocument();
    expect(screen.getByText("Decision Required")).toBeInTheDocument();
    expect(screen.getByText("QA Review Needed")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Action dispatch
// ---------------------------------------------------------------------------

describe("AttentionBanner — onAction", () => {
  it("invokes onAction with (item, actionName) when a button is clicked", () => {
    const spy = jest.fn();
    const i = item();
    render(<AttentionBanner items={[i]} onAction={spy} />);
    fireEvent.click(screen.getByRole("button", { name: /Approve/i }));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(i, "human-approve");
  });

  it("prevents default and stops propagation so it does not navigate", () => {
    const spy = jest.fn();
    const parentSpy = jest.fn();
    // Wrap in a React parent with a synthetic onClick — this mirrors how
    // FleetCard nests the banner inside a <Link> whose click handler should
    // NOT fire when action buttons are clicked.
    render(
      <div onClick={parentSpy}>
        <AttentionBanner items={[item()]} onAction={spy} />
      </div>,
    );
    const btn = screen.getByRole("button", { name: /Approve/i });
    fireEvent.click(btn);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(parentSpy).not.toHaveBeenCalled();
  });

  it("suppresses rapid second clicks while the first is in flight", () => {
    const spy = jest.fn();
    render(<AttentionBanner items={[item()]} onAction={spy} />);
    const btn = screen.getByRole("button", { name: /Approve/i });
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("disables the button while pending", () => {
    render(<AttentionBanner items={[item()]} onAction={() => {}} />);
    const btn = screen.getByRole("button", { name: /Approve/i });
    fireEvent.click(btn);
    expect(btn).toBeDisabled();
  });
});
