"use client";

import { useState, useRef, useEffect, useMemo } from "react";
import { useRepos } from "@/hooks/useRepos";
import { useCreateIssue } from "@/hooks/useCreateIssue";

const ALL_PROJECTS_SENTINEL = "__all__";

export function QuickCreate() {
  const [isOpen, setIsOpen] = useState(false);
  const [note, setNote] = useState("");
  const [selectedRepo, setSelectedRepo] = useState<string>("");
  const inputRef = useRef<HTMLInputElement>(null);
  const { data: repoData } = useRepos();
  const createIssue = useCreateIssue();

  const repos = useMemo(() => repoData?.repos ?? [], [repoData?.repos]);
  const activeRepo = repoData?.activeRepo ?? "";

  // Default to active repo (but not __all__)
  useEffect(() => {
    if (!selectedRepo && activeRepo && activeRepo !== ALL_PROJECTS_SENTINEL) {
      setSelectedRepo(activeRepo);
    } else if (!selectedRepo && repos.length > 0) {
      setSelectedRepo(repos[0].path);
    }
  }, [activeRepo, repos, selectedRepo]);

  // Focus input when opened
  useEffect(() => {
    if (isOpen) inputRef.current?.focus();
  }, [isOpen]);

  // Keyboard shortcut: Cmd+K to toggle
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setIsOpen((prev) => !prev);
      }
      if (e.key === "Escape") {
        setIsOpen(false);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!note.trim() || !selectedRepo) return;

    try {
      await createIssue.mutateAsync({ note: note.trim(), repoPath: selectedRepo });
      setNote("");
      setIsOpen(false);
    } catch {
      // Error shown via mutation state
    }
  }

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-gray-400 bg-surface-2 border border-border-default rounded-md hover:border-gray-500 hover:text-gray-300 transition-colors"
        title="Quick create (Cmd+K)"
      >
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
        </svg>
        <span className="hidden sm:inline">New bead</span>
        <kbd className="hidden md:inline ml-1 px-1 py-0.5 text-[10px] bg-surface-0 border border-border-default rounded text-gray-500">
          {"\u2318"}K
        </kbd>
      </button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex items-center gap-2">
      {/* Project selector */}
      <select
        value={selectedRepo}
        onChange={(e) => setSelectedRepo(e.target.value)}
        className="bg-surface-2 text-gray-300 text-xs border border-border-default rounded px-2 py-1.5 focus:outline-none focus:border-gray-500 hover:border-gray-500 transition-colors cursor-pointer max-w-[140px]"
      >
        {repos.map((repo) => (
          <option key={repo.path} value={repo.path} className="bg-surface-1">
            {repo.name}
          </option>
        ))}
      </select>

      {/* Note input */}
      <div className="relative flex-1 min-w-[600px] max-w-[800px]">
        <input
          ref={inputRef}
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="fix login crash -p 0 -t bug"
          disabled={createIssue.isPending}
          className="w-full bg-surface-2 text-gray-200 text-sm border border-border-default rounded px-3 py-1.5 focus:outline-none focus:border-gray-400 placeholder:text-gray-600 transition-colors"
        />
      </div>

      {/* Submit */}
      <button
        type="submit"
        disabled={createIssue.isPending || !note.trim()}
        className="px-3 py-1.5 text-xs font-medium text-white bg-blue-600 rounded hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        {createIssue.isPending ? "..." : "Create"}
      </button>

      {/* Cancel */}
      <button
        type="button"
        onClick={() => { setIsOpen(false); setNote(""); }}
        className="p-1.5 text-gray-500 hover:text-gray-300 transition-colors"
        title="Cancel (Esc)"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>

      {/* Error display */}
      {createIssue.isError && (
        <span className="text-xs text-red-400 max-w-[200px] truncate" title={createIssue.error.message}>
          {createIssue.error.message}
        </span>
      )}
    </form>
  );
}
