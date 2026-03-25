import React from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ToastProvider, useToast } from "@/components/ui/Toast";

// Helper component to trigger toasts
function ToastTrigger({ message, type }: { message: string; type?: "success" | "error" | "info" }) {
  const { addToast } = useToast();
  return (
    <button onClick={() => addToast(message, type)}>
      Trigger Toast
    </button>
  );
}

function renderWithProvider(ui: React.ReactElement) {
  return render(<ToastProvider>{ui}</ToastProvider>);
}

describe("ToastProvider", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("renders children without toasts initially", () => {
    renderWithProvider(<div>Hello</div>);
    expect(screen.getByText("Hello")).toBeInTheDocument();
  });

  it("shows a toast when addToast is called", () => {
    renderWithProvider(<ToastTrigger message="Action completed" type="success" />);

    fireEvent.click(screen.getByText("Trigger Toast"));

    expect(screen.getByText("Action completed")).toBeInTheDocument();
  });

  it("auto-dismisses toast after 4 seconds", () => {
    renderWithProvider(<ToastTrigger message="Temporary toast" />);

    fireEvent.click(screen.getByText("Trigger Toast"));
    expect(screen.getByText("Temporary toast")).toBeInTheDocument();

    act(() => {
      jest.advanceTimersByTime(4000);
    });

    expect(screen.queryByText("Temporary toast")).not.toBeInTheDocument();
  });

  it("dismisses toast on close button click", () => {
    renderWithProvider(<ToastTrigger message="Dismissable toast" />);

    fireEvent.click(screen.getByText("Trigger Toast"));
    expect(screen.getByText("Dismissable toast")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Dismiss"));
    expect(screen.queryByText("Dismissable toast")).not.toBeInTheDocument();
  });

  it("shows multiple toasts at once", () => {
    function MultiTrigger() {
      const { addToast } = useToast();
      return (
        <>
          <button onClick={() => addToast("First toast", "success")}>Toast 1</button>
          <button onClick={() => addToast("Second toast", "error")}>Toast 2</button>
        </>
      );
    }

    renderWithProvider(<MultiTrigger />);

    fireEvent.click(screen.getByText("Toast 1"));
    fireEvent.click(screen.getByText("Toast 2"));

    expect(screen.getByText("First toast")).toBeInTheDocument();
    expect(screen.getByText("Second toast")).toBeInTheDocument();
  });

  it("applies correct CSS classes for each toast type", () => {
    function TypeTrigger() {
      const { addToast } = useToast();
      return (
        <>
          <button onClick={() => addToast("Success msg", "success")}>Success</button>
          <button onClick={() => addToast("Error msg", "error")}>Error</button>
          <button onClick={() => addToast("Info msg", "info")}>Info</button>
        </>
      );
    }

    renderWithProvider(<TypeTrigger />);

    fireEvent.click(screen.getByText("Success"));
    const successToast = screen.getByText("Success msg").closest("[role='status']");
    expect(successToast).toHaveClass("bg-emerald-900/90");

    fireEvent.click(screen.getByText("Error"));
    const errorToast = screen.getByText("Error msg").closest("[role='status']");
    expect(errorToast).toHaveClass("bg-red-900/90");

    fireEvent.click(screen.getByText("Info"));
    const infoToast = screen.getByText("Info msg").closest("[role='status']");
    expect(infoToast).toHaveClass("bg-surface-2");
  });
});

describe("useToast outside provider", () => {
  it("throws when used outside ToastProvider", () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});

    expect(() => {
      render(<ToastTrigger message="Should fail" />);
    }).toThrow("useToast must be used within ToastProvider");

    spy.mockRestore();
  });
});
