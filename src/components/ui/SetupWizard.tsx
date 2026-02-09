"use client";

import { useState } from "react";
import { useHealth } from "@/hooks/useHealth";
import { useRepos, useRepoMutation } from "@/hooks/useRepos";

type Step = "welcome" | "check" | "repo" | "done";

export function SetupWizard() {
  const [step, setStep] = useState<Step>("welcome");
  const [repoPath, setRepoPath] = useState("");
  const [error, setError] = useState<string | null>(null);

  const { data: health } = useHealth();
  const { data: repos, isLoading } = useRepos();
  const mutation = useRepoMutation();

  const bvAvailable = health?.bv_available ?? false;
  const hasRepos = (repos?.repos.length ?? 0) > 0;

  // Don't show wizard while still loading repo data
  if (isLoading) return null;

  // If we already have repos configured, don't show the wizard
  if (hasRepos) return null;

  const handleAddRepo = async () => {
    if (!repoPath.trim()) {
      setError("Please enter a path");
      return;
    }
    setError(null);
    try {
      await mutation.mutateAsync({ action: "add", path: repoPath.trim() });
      setStep("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add repository");
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-surface-0/95 backdrop-blur-sm">
      <div className="card p-8 max-w-lg w-full mx-4 space-y-6">
        {step === "welcome" && (
          <>
            <div className="text-center space-y-3">
              <div className="w-16 h-16 mx-auto rounded-2xl bg-status-open/20 flex items-center justify-center">
                <span className="text-status-open font-bold text-2xl">B</span>
              </div>
              <h1 className="text-2xl font-bold text-white">
                Welcome to Beads Web
              </h1>
              <p className="text-gray-400">
                A visual dashboard for your Beads issue tracker. Let&apos;s get
                you set up in a few quick steps.
              </p>
            </div>
            <button
              onClick={() => setStep("check")}
              className="w-full py-3 rounded-lg bg-status-open text-white font-medium hover:bg-status-open/90 transition-colors"
            >
              Get Started
            </button>
          </>
        )}

        {step === "check" && (
          <>
            <h2 className="text-xl font-semibold text-white">
              Prerequisites Check
            </h2>
            <div className="space-y-3">
              <div className="flex items-center gap-3 p-3 rounded-lg bg-surface-2">
                <span className={bvAvailable ? "text-status-open" : "text-status-progress"}>
                  {bvAvailable ? "\u2713" : "\u25CB"}
                </span>
                <div>
                  <p className="text-sm font-medium text-gray-200">
                    bv (beads_viewer)
                  </p>
                  <p className="text-xs text-gray-400">
                    {bvAvailable
                      ? "Installed — full graph metrics available"
                      : "Not found — will use JSONL fallback (basic mode)"}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3 p-3 rounded-lg bg-surface-2">
                <span className="text-status-open">{"\u2713"}</span>
                <div>
                  <p className="text-sm font-medium text-gray-200">
                    Node.js
                  </p>
                  <p className="text-xs text-gray-400">
                    Running — required for Beads Web
                  </p>
                </div>
              </div>
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => setStep("welcome")}
                className="flex-1 py-2.5 rounded-lg bg-surface-2 text-gray-300 font-medium hover:bg-surface-3 transition-colors"
              >
                Back
              </button>
              <button
                onClick={() => setStep("repo")}
                className="flex-1 py-2.5 rounded-lg bg-status-open text-white font-medium hover:bg-status-open/90 transition-colors"
              >
                Continue
              </button>
            </div>
          </>
        )}

        {step === "repo" && (
          <>
            <h2 className="text-xl font-semibold text-white">
              Add a Repository
            </h2>
            <p className="text-sm text-gray-400">
              Enter the path to a Beads-enabled project (must contain a{" "}
              <code className="bg-surface-2 px-1 py-0.5 rounded text-xs font-mono">
                .beads
              </code>{" "}
              directory).
            </p>
            <div className="space-y-3">
              <input
                type="text"
                value={repoPath}
                onChange={(e) => setRepoPath(e.target.value)}
                placeholder="/path/to/your/project"
                className="w-full px-4 py-2.5 rounded-lg bg-surface-2 border border-border-default text-gray-200 placeholder-gray-500 text-sm focus:outline-none focus:border-status-open/50"
                onKeyDown={(e) => e.key === "Enter" && handleAddRepo()}
              />
              {error && (
                <p className="text-sm text-status-blocked">{error}</p>
              )}
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => setStep("check")}
                className="flex-1 py-2.5 rounded-lg bg-surface-2 text-gray-300 font-medium hover:bg-surface-3 transition-colors"
              >
                Back
              </button>
              <button
                onClick={handleAddRepo}
                disabled={mutation.isPending}
                className="flex-1 py-2.5 rounded-lg bg-status-open text-white font-medium hover:bg-status-open/90 transition-colors disabled:opacity-50"
              >
                {mutation.isPending ? "Adding..." : "Add Repository"}
              </button>
            </div>
          </>
        )}

        {step === "done" && (
          <>
            <div className="text-center space-y-3">
              <div className="w-16 h-16 mx-auto rounded-2xl bg-status-open/20 flex items-center justify-center">
                <span className="text-status-open text-3xl">{"\u2713"}</span>
              </div>
              <h2 className="text-xl font-semibold text-white">
                You&apos;re all set!
              </h2>
              <p className="text-gray-400">
                Your repository has been added. The dashboard will load
                momentarily.
              </p>
            </div>
            <button
              onClick={() => window.location.reload()}
              className="w-full py-3 rounded-lg bg-status-open text-white font-medium hover:bg-status-open/90 transition-colors"
            >
              Open Dashboard
            </button>
          </>
        )}
      </div>
    </div>
  );
}
