"use client";

import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useHealth } from "@/hooks/useHealth";
import { useRepos, useRepoMutation } from "@/hooks/useRepos";
import { useMobileSidebar } from "@/components/providers/MobileSidebarContext";

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
    label: "Fleet",
    href: "/fleet",
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
          d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z"
        />
      </svg>
    ),
  },
  {
    label: "Releases",
    href: "/releases",
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
          d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z"
        />
      </svg>
    ),
  },
  {
    label: "Activity",
    href: "/activity",
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
          d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z"
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
  {
    label: "Monetization",
    href: "/monetization",
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
          d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
        />
      </svg>
    ),
  },
  {
    label: "Trends",
    href: "/trends",
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
          d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"
        />
      </svg>
    ),
  },
  {
    label: "Diff",
    href: "/diff",
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
          d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4"
        />
      </svg>
    ),
  },
  {
    label: "Settings",
    href: "/settings",
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
          d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
        />
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
        />
      </svg>
    ),
  },
];

function RepoSelector({ onSelect }: { onSelect?: () => void }) {
  const { data } = useRepos();
  const mutation = useRepoMutation();
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [open]);

  if (!data || data.repos.length < 2) return null;

  const isAllProjects = data.activeRepo === "__all__";
  const activeRepo = data.repos.find((r) => r.path === data.activeRepo);
  const activeLabel = isAllProjects ? "All Projects" : activeRepo?.name ?? "Select repo";

  return (
    <div className="px-3 py-3 border-b border-border-default" ref={dropdownRef}>
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-md text-sm
          bg-surface-0 border border-border-default
          text-gray-100 hover:bg-surface-2 transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0">
          <svg
            className="w-4 h-4 text-gray-500 shrink-0"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
            />
          </svg>
          <span className="truncate">{activeLabel}</span>
        </div>
        <svg
          className={`w-4 h-4 text-gray-500 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="mt-1 py-1 rounded-md bg-surface-0 border border-border-default shadow-lg max-h-[60vh] overflow-y-auto">
          {/* All Projects aggregation option */}
          <button
            onClick={() => {
              if (!isAllProjects) {
                mutation.mutate({ action: "set-active", path: "__all__" });
              }
              setOpen(false);
              onSelect?.();
            }}
            className={`w-full text-left px-3 py-2 text-sm transition-colors flex items-center gap-2
              ${
                isAllProjects
                  ? "text-status-open bg-status-open/5"
                  : "text-gray-300 hover:text-white hover:bg-surface-2"
              }`}
          >
            <span className="truncate flex-1">All Projects</span>
            {isAllProjects && (
              <svg
                className="w-4 h-4 shrink-0"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            )}
          </button>
          <div className="border-b border-border-default my-1" />
          {data.repos.map((repo) => {
            const isActive = repo.path === data.activeRepo;
            return (
              <button
                key={repo.path}
                onClick={() => {
                  if (!isActive) {
                    mutation.mutate({ action: "set-active", path: repo.path });
                  }
                  setOpen(false);
                  onSelect?.();
                }}
                className={`w-full text-left px-3 py-2 text-sm transition-colors flex items-center gap-2
                  ${
                    isActive
                      ? "text-status-open bg-status-open/5"
                      : "text-gray-300 hover:text-white hover:bg-surface-2"
                  }`}
              >
                <span className="truncate flex-1">{repo.name}</span>
                {isActive && (
                  <svg
                    className="w-4 h-4 shrink-0"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SidebarContent({ collapsed, setCollapsed, onNavClick }: {
  collapsed: boolean;
  setCollapsed: (v: boolean) => void;
  onNavClick?: () => void;
}) {
  const pathname = usePathname();
  const { data: health } = useHealth();
  const bvAvailable = health?.bv_available ?? false;

  return (
    <>
      {/* Logo / Brand */}
      <div className="flex items-center gap-2 px-3 h-16 border-b border-border-default">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/icon.svg" alt="Beads" className="w-8 h-8 rounded-lg shrink-0" />
        {!collapsed && (
          <span className="text-lg font-semibold text-white tracking-tight">
            Beads Fleet
          </span>
        )}
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="ml-auto p-1 rounded hover:bg-surface-2 text-gray-400 hover:text-gray-200 transition-colors shrink-0"
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            {collapsed ? (
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 5l7 7-7 7M5 5l7 7-7 7" />
            ) : (
              <path strokeLinecap="round" strokeLinejoin="round" d="M11 19l-7-7 7-7M19 19l-7-7 7-7" />
            )}
          </svg>
        </button>
      </div>

      {/* Repo Selector */}
      {!collapsed && <RepoSelector onSelect={onNavClick} />}

      {/* Navigation Links */}
      <nav className={`flex-1 ${collapsed ? "px-2" : "px-3"} py-4 space-y-1`}>
        {NAV_ITEMS.map((item) => {
          const isActive =
            item.href === "/"
              ? pathname === "/"
              : pathname.startsWith(item.href);

          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavClick}
              title={collapsed ? item.label : undefined}
              className={`
                flex items-center ${collapsed ? "justify-center" : "gap-3"} ${collapsed ? "px-2" : "px-3"} py-2.5 rounded-md text-sm font-medium
                transition-colors duration-150
                ${
                  isActive
                    ? "bg-surface-2 text-white border-l-2 border-status-open"
                    : "text-gray-400 hover:text-gray-200 hover:bg-surface-2/50 border-l-2 border-transparent"
                }
              `}
            >
              {item.icon}
              {!collapsed && item.label}
            </Link>
          );
        })}
      </nav>

      {/* Graph Health */}
      <div className={`${collapsed ? "px-2" : "px-4"} py-2 border-t border-border-default`}>
        <div className={`flex items-center ${collapsed ? "justify-center" : "gap-2"} text-xs text-gray-500`}>
          <span className={bvAvailable ? "text-status-open" : "text-status-progress"}>●</span>
          {!collapsed && <span>{bvAvailable ? "bv connected" : "JSONL fallback"}</span>}
        </div>
      </div>

      {/* Bottom Section */}
      <div className={`${collapsed ? "px-2" : "px-6"} py-4 border-t border-border-default`}>
        {!collapsed && <p className="text-xs text-gray-500">Beads Fleet v1.0</p>}
      </div>
    </>
  );
}

export function Sidebar() {
  const [collapsed, setCollapsed] = useState(false);
  const { isOpen, close } = useMobileSidebar();

  // Close mobile sidebar on route change
  const pathname = usePathname();
  useEffect(() => {
    close();
  }, [pathname, close]);

  return (
    <>
      {/* Desktop sidebar */}
      <aside
        className={`hidden lg:flex lg:flex-col bg-surface-1 border-r border-border-default z-30 transition-all duration-200 ${
          collapsed ? "w-16" : "w-64"
        }`}
      >
        <SidebarContent collapsed={collapsed} setCollapsed={setCollapsed} />
      </aside>

      {/* Mobile sidebar overlay */}
      {isOpen && (
        <div className="lg:hidden fixed inset-0 z-50 flex">
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-black/60"
            onClick={close}
            aria-label="Close navigation"
          />
          {/* Drawer */}
          <aside className="relative flex flex-col w-72 max-w-[80vw] bg-surface-1 border-r border-border-default animate-slide-in-left">
            {/* Close button */}
            <button
              onClick={close}
              className="absolute top-4 right-3 p-2 rounded-md text-gray-400 hover:text-white hover:bg-surface-2 transition-colors z-10"
              aria-label="Close navigation"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
            <SidebarContent collapsed={false} setCollapsed={() => {}} onNavClick={close} />
          </aside>
        </div>
      )}
    </>
  );
}
