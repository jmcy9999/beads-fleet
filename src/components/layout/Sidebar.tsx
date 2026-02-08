"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useHealth } from "@/hooks/useHealth";

const NAV_ITEMS = [
  {
    label: "Dashboard",
    href: "/",
    icon: (
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
          d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0a1 1 0 01-1-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 01-1 1h-2z"
        />
      </svg>
    ),
  },
  {
    label: "Board",
    href: "/board",
    icon: (
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
          d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2m8 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2"
        />
      </svg>
    ),
  },
  {
    label: "Insights",
    href: "/insights",
    icon: (
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
          d="M13 10V3L4 14h7v7l9-11h-7z"
        />
      </svg>
    ),
  },
];

export function Sidebar() {
  const pathname = usePathname();
  const { data: health } = useHealth();
  const bvAvailable = health?.bv_available ?? false;

  return (
    <aside className="hidden lg:flex lg:flex-col w-64 bg-surface-1 border-r border-border-default z-30">
      {/* Logo / Brand */}
      <div className="flex items-center gap-2 px-6 h-16 border-b border-border-default">
        <div className="w-8 h-8 rounded-lg bg-status-open/20 flex items-center justify-center">
          <span className="text-status-open font-bold text-sm">B</span>
        </div>
        <span className="text-lg font-semibold text-white tracking-tight">
          Beads Web
        </span>
      </div>

      {/* Navigation Links */}
      <nav className="flex-1 px-3 py-4 space-y-1">
        {NAV_ITEMS.map((item) => {
          const isActive =
            item.href === "/"
              ? pathname === "/"
              : pathname.startsWith(item.href);

          return (
            <Link
              key={item.href}
              href={item.href}
              className={`
                flex items-center gap-3 px-3 py-2.5 rounded-md text-sm font-medium
                transition-colors duration-150
                ${
                  isActive
                    ? "bg-surface-2 text-white border-l-2 border-status-open"
                    : "text-gray-400 hover:text-gray-200 hover:bg-surface-2/50 border-l-2 border-transparent"
                }
              `}
            >
              {item.icon}
              {item.label}
            </Link>
          );
        })}
      </nav>

      {/* Graph Health */}
      <div className="px-4 py-2 border-t border-border-default">
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <span className={bvAvailable ? "text-status-open" : "text-status-progress"}>●</span>
          <span>{bvAvailable ? "bv connected" : "JSONL fallback"}</span>
        </div>
      </div>

      {/* Bottom Section */}
      <div className="px-6 py-4 border-t border-border-default">
        <p className="text-xs text-gray-500">Beads Web v0.1</p>
      </div>
    </aside>
  );
}
