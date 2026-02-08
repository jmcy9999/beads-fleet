"use client";

import { usePathname } from "next/navigation";

const PAGE_NAMES: Record<string, string> = {
  "/": "Dashboard",
  "/board": "Board",
  "/insights": "Insights",
};

export function Header() {
  const pathname = usePathname();
  const pageName = PAGE_NAMES[pathname] ?? "Beads Web";

  return (
    <header className="flex items-center justify-between h-16 px-6 bg-surface-1 border-b border-border-default">
      {/* Left: Mobile hamburger + breadcrumb */}
      <div className="flex items-center gap-4">
        {/* Hamburger button — mobile only */}
        <button
          className="lg:hidden p-2 rounded-md text-gray-400 hover:text-white hover:bg-surface-2 transition-colors"
          aria-label="Open navigation"
        >
          <svg
            className="w-5 h-5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M4 6h16M4 12h16M4 18h16"
            />
          </svg>
        </button>

        {/* Breadcrumb — desktop */}
        <div className="hidden lg:flex items-center gap-2 text-sm">
          <span className="text-gray-500">Beads Web</span>
          <span className="text-gray-600">/</span>
          <span className="text-white font-medium">{pageName}</span>
        </div>

        {/* Page name — mobile */}
        <span className="lg:hidden text-white font-medium text-sm">
          {pageName}
        </span>
      </div>

      {/* Right: Refresh indicator */}
      <div className="flex items-center gap-2 text-xs text-gray-500">
        <div className="w-1.5 h-1.5 rounded-full bg-status-open animate-pulse" />
        <span>Live</span>
      </div>
    </header>
  );
}
