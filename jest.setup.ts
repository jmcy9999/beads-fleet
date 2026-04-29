import "@testing-library/jest-dom";

// jsdom does not implement ResizeObserver. FleetColumn (factory-core-3p1e.9)
// uses it to measure the column height for react-window's VariableSizeList.
// Provide a no-op polyfill so component tests render the column without
// throwing. Tests that want to assert on resize behaviour can override the
// global within the test.
if (typeof globalThis.ResizeObserver === "undefined") {
  class NoopResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = NoopResizeObserver;
}
