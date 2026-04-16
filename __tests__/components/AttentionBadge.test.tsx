// =============================================================================
// Tests for src/components/fleet/AttentionBadge.tsx
// =============================================================================
// Covers (functional spec Feature 3 acceptance criteria):
//   - count = 0 → renders nothing (null)
//   - count > 0 → shows the number with descriptive aria-label
//   - count = 1 → singular label
//   - count >= 2 → plural label
//   - negative count treated as zero (defensive)
// (factory-core-509.6)
// =============================================================================

import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { AttentionBadge } from "@/components/fleet/AttentionBadge";

describe("AttentionBadge", () => {
  it("renders nothing when count is 0", () => {
    const { container } = render(<AttentionBadge count={0} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when count is negative (defensive)", () => {
    const { container } = render(<AttentionBadge count={-1} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the count when count is greater than 0", () => {
    render(<AttentionBadge count={3} />);
    const badge = screen.getByTestId("attention-badge");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent("3");
  });

  it("uses singular aria-label when count is 1", () => {
    render(<AttentionBadge count={1} />);
    const badge = screen.getByTestId("attention-badge");
    expect(badge).toHaveAttribute("aria-label", "1 item needs attention");
    expect(badge).toHaveTextContent("1");
  });

  it("uses plural aria-label when count is 2 or more", () => {
    render(<AttentionBadge count={5} />);
    const badge = screen.getByTestId("attention-badge");
    expect(badge).toHaveAttribute("aria-label", "5 items need attention");
  });

  it("updates when the count prop changes", () => {
    const { rerender, container } = render(<AttentionBadge count={2} />);
    expect(screen.getByTestId("attention-badge")).toHaveTextContent("2");
    rerender(<AttentionBadge count={0} />);
    expect(container.firstChild).toBeNull();
    rerender(<AttentionBadge count={7} />);
    expect(screen.getByTestId("attention-badge")).toHaveTextContent("7");
  });
});
