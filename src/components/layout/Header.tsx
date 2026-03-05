"use client";

import { usePathname } from "next/navigation";
import { useRepos, useRepoMutation } from "@/hooks/useRepos";
import { QuickCreate } from "@/components/QuickCreate";

const PAGE_NAMES: Record<string, string> = {
  "/": "Dashboard",
  "/board": "Board",
  "/insights": "Insights",
  "/diff": "Diff",
  "/settings": "Settings",
};

const ALL_PROJECTS_SENTINEL = "__all__";

export function Header() {
  const pathname = usePathname();
  const { data: repoData } = useRepos();
  const repoMutation = useRepoMutation();
  const pageName = PAGE_NAMES[pathname] ?? "Beads Fleet";

  const repos = repoData?.repos ?? [];
  const hasMultipleRepos = repos.length >= 2;
  const activeValue = repoData?.activeRepo ?? repos[0]?.path ?? "";

  function handleProjectChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const value = e.target.value;
    repoMutation.mutateAsync({ action: "set-active", path: value });
  }

  // Derive display name for mobile view
  const activeName =
    activeValue === ALL_PROJECTS_SENTINEL
      ? "All Projects"
      : repos.find((r) => r.path === activeValue)?.name ?? "";

  return (
    <header className="flex items-center justify-between h-16 px-6 bg-surface-1 border-b border-border-default">
      {/* Left: Mobile hamburger + breadcrumb */}
      <div className="flex items-center gap-4">
        {/* Hamburger button -- mobile only */}
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

        {/* Breadcrumb -- desktop */}
        <div className="hidden lg:flex items-center gap-2 text-sm">
          <span className="text-gray-500">Beads Fleet</span>
          {hasMultipleRepos && (
            <>
              <span className="text-gray-600">/</span>
              <select
                value={activeValue}
                onChange={handleProjectChange}
                disabled={repoMutation.isPending}
                className="bg-transparent text-gray-400 text-sm border border-gray-700 rounded px-2 py-0.5 focus:outline-none focus:border-gray-500 hover:border-gray-500 transition-colors cursor-pointer appearance-none"
                style={{ backgroundImage: "none" }}
              >
                <option value={ALL_PROJECTS_SENTINEL} className="bg-surface-1 text-gray-300">
                  All Projects
                </option>
                {repos.map((repo) => (
                  <option key={repo.path} value={repo.path} className="bg-surface-1 text-gray-300">
                    {repo.name}
                  </option>
                ))}
              </select>
            </>
          )}
          {!hasMultipleRepos && repos[0] && (
            <>
              <span className="text-gray-600">/</span>
              <span className="text-gray-400">{repos[0].name}</span>
            </>
          )}
          <span className="text-gray-600">/</span>
          <span className="text-white font-medium">{pageName}</span>
        </div>

        {/* Page name -- mobile */}
        <div className="lg:hidden flex items-center gap-2">
          {hasMultipleRepos && activeName && (
            <span className="text-gray-500 text-xs">{activeName} /</span>
          )}
          <span className="text-white font-medium text-sm">
            {pageName}
          </span>
        </div>
      </div>

      {/* Right: Quick create + refresh indicator */}
      <div className="flex items-center gap-3">
        <QuickCreate />
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <div className="w-1.5 h-1.5 rounded-full bg-status-open animate-pulse" />
          <span>Live</span>
        </div>
      </div>
    </header>
  );
}
