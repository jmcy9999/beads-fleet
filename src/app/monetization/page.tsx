"use client";

import { useState, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useMonetizationBriefs, useMonetizationBrief } from "@/hooks/useMonetization";
import { useAgentStatus, useAgentLaunch } from "@/hooks/useAgent";
import { useRepos } from "@/hooks/useRepos";

const VERDICT_COLORS: Record<string, string> = {
  "Go": "bg-green-500/20 text-green-400 border-green-500/30",
  "Explore Further": "bg-amber-500/20 text-amber-400 border-amber-500/30",
  "Park It": "bg-gray-500/20 text-gray-400 border-gray-500/30",
};

function VerdictBadge({ verdict }: { verdict: string }) {
  const colors = VERDICT_COLORS[verdict] ?? "bg-surface-2 text-gray-400 border-border-default";
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${colors}`}>
      {verdict}
    </span>
  );
}

function BriefSkeleton() {
  return (
    <div className="space-y-4 animate-pulse">
      <div className="h-6 w-72 rounded bg-surface-2" />
      <div className="h-4 w-48 rounded bg-surface-2" />
      <div className="space-y-2 mt-6">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="h-4 rounded bg-surface-2" style={{ width: `${70 + Math.random() * 30}%` }} />
        ))}
      </div>
    </div>
  );
}

export default function MonetizationPage() {
  const { data: briefsData, isLoading: briefsLoading } = useMonetizationBriefs();
  const { data: agentStatus } = useAgentStatus();
  const agentLaunch = useAgentLaunch();
  const { data: reposData } = useRepos();

  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [followUpPrompt, setFollowUpPrompt] = useState("");

  const briefs = briefsData?.briefs ?? [];
  const latestSlug = briefs.length > 0 ? briefs[0].slug : null;
  const activeSlug = selectedSlug ?? latestSlug;

  const { data: briefContent, isLoading: contentLoading } = useMonetizationBrief(activeSlug);

  const todayStr = useMemo(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }, []);

  const hasTodaysBrief = briefs.some((b) => b.date === todayStr);
  const isAgentRunning = agentStatus?.running ?? false;

  const fleetCoreRepo = reposData?.repos.find((r) => r.name.includes("fleet-core") || r.name.includes("factory"));

  const handleGenerate = () => {
    if (!fleetCoreRepo) return;
    agentLaunch.mutate({
      repoPath: fleetCoreRepo.path,
      prompt: `Generate today's monetization brief. Follow the process in .claude/agents/monetization.md. Write the brief to research/monetization/${todayStr}.md and commit it.`,
      model: "sonnet",
      allowedTools: "Read,Glob,Grep,Write,Bash,WebSearch,WebFetch",
    });
  };

  const handleFollowUp = () => {
    if (!fleetCoreRepo || !activeSlug || !followUpPrompt.trim()) return;
    // Generate a slug for the follow-up: take the current brief's slug and append a short topic
    const topicSlug = followUpPrompt.trim().toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40);
    const followUpSlug = `${activeSlug}-${topicSlug}`;
    agentLaunch.mutate(
      {
        repoPath: fleetCoreRepo.path,
        prompt: `Follow-up research on monetization brief. Read the existing brief at research/monetization/${activeSlug}.md first. Then answer Jane's question with targeted web research (at least 5 searches). Write a new follow-up brief to research/monetization/${followUpSlug}.md using the same template from .claude/agents/monetization.md. Jane's question: "${followUpPrompt.trim()}" — Be thorough, search aggressively, cite sources. Commit the file when done.`,
        model: "sonnet",
        allowedTools: "Read,Glob,Grep,Write,Bash,WebSearch,WebFetch",
      },
      { onSuccess: () => setFollowUpPrompt("") },
    );
  };

  // Empty state
  if (!briefsLoading && briefs.length === 0) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold text-white">Monetization Briefs</h1>
        <div className="flex flex-col items-center justify-center py-24 space-y-4">
          <svg className="w-16 h-16 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p className="text-gray-400 text-lg">No monetization briefs yet</p>
          <p className="text-gray-500 text-sm">Generate your first daily brief to explore revenue angles.</p>
          <button
            onClick={handleGenerate}
            disabled={!fleetCoreRepo || isAgentRunning || agentLaunch.isPending}
            className="mt-4 rounded-md bg-green-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-green-500 disabled:opacity-50 transition-colors"
          >
            {agentLaunch.isPending ? "Launching..." : "Generate First Brief"}
          </button>
          {agentLaunch.isError && (
            <p className="text-xs text-red-400">{agentLaunch.error.message}</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">Monetization Briefs</h1>
        <button
          onClick={handleGenerate}
          disabled={!fleetCoreRepo || hasTodaysBrief || isAgentRunning || agentLaunch.isPending}
          className="rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-500 disabled:opacity-50 transition-colors"
          title={
            hasTodaysBrief
              ? "Today's brief already exists"
              : isAgentRunning
                ? "Agent is currently running"
                : "Generate today's monetization brief"
          }
        >
          {agentLaunch.isPending ? "Launching..." : isAgentRunning ? "Agent Running..." : "Generate Today's Brief"}
        </button>
      </div>

      {agentLaunch.isError && (
        <p className="text-sm text-red-400">{agentLaunch.error.message}</p>
      )}

      {/* Main layout: hero + sidebar */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* Hero: latest/selected brief */}
        <div className="lg:col-span-3">
          <div className="card p-6">
            {briefsLoading || contentLoading ? (
              <BriefSkeleton />
            ) : briefContent?.content ? (
              <div className="prose prose-invert prose-sm max-w-none
                prose-headings:text-gray-200 prose-headings:font-semibold
                prose-h1:text-lg prose-h2:text-base prose-h3:text-sm
                prose-p:text-gray-300 prose-p:leading-relaxed
                prose-a:text-blue-400 prose-a:no-underline hover:prose-a:underline
                prose-strong:text-gray-200
                prose-code:text-amber-300 prose-code:bg-surface-2 prose-code:rounded prose-code:px-1
                prose-pre:bg-surface-0 prose-pre:border prose-pre:border-border-default
                prose-table:text-sm
                prose-th:text-gray-400 prose-th:border-border-default
                prose-td:border-border-default
                prose-li:text-gray-300
                prose-blockquote:border-blue-500/50 prose-blockquote:text-gray-400
                prose-hr:border-border-default">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {briefContent.content}
                </ReactMarkdown>
              </div>
            ) : (
              <p className="text-gray-500 italic">No content available for this brief.</p>
            )}
          </div>

          {/* Follow-up research input */}
          {activeSlug && briefContent?.content && (
            <div className="card p-4">
              <h2 className="text-xs font-medium uppercase tracking-wider text-gray-500 mb-2">
                Dig Deeper
              </h2>
              <div className="flex gap-2">
                <textarea
                  value={followUpPrompt}
                  onChange={(e) => setFollowUpPrompt(e.target.value)}
                  placeholder="Ask a follow-up question... e.g. 'Research the securities law implications in detail' or 'Find more competitors doing fractional app ownership'"
                  rows={2}
                  className="flex-1 rounded-md border border-border-default bg-surface-2 px-3 py-2 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-green-500 resize-none"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && followUpPrompt.trim()) {
                      handleFollowUp();
                    }
                  }}
                />
                <button
                  onClick={handleFollowUp}
                  disabled={!followUpPrompt.trim() || !fleetCoreRepo || isAgentRunning || agentLaunch.isPending}
                  className="self-end rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-500 disabled:opacity-50 transition-colors shrink-0"
                >
                  {agentLaunch.isPending ? "Launching..." : isAgentRunning ? "Agent Running..." : "Research"}
                </button>
              </div>
              <p className="text-xs text-gray-600 mt-1.5">
                {typeof navigator !== "undefined" && navigator.platform?.includes("Mac") ? "Cmd" : "Ctrl"}+Enter to send. Launches an agent to research your question and write a follow-up brief.
              </p>
            </div>
          )}
        </div>

        {/* Archive sidebar */}
        <div className="lg:col-span-1">
          <div className="card p-4">
            <h2 className="text-xs font-medium uppercase tracking-wider text-gray-500 mb-3">
              Archive ({briefs.length})
            </h2>
            {briefsLoading ? (
              <div className="space-y-2 animate-pulse">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="h-12 rounded bg-surface-2" />
                ))}
              </div>
            ) : (
              <div className="space-y-1">
                {briefs.map((brief) => {
                  const isActive = brief.slug === activeSlug;
                  return (
                    <button
                      key={brief.slug}
                      onClick={() => setSelectedSlug(brief.slug)}
                      className={`w-full text-left rounded-md px-3 py-2 transition-colors ${
                        isActive
                          ? "bg-surface-2 border-l-2 border-status-open"
                          : "hover:bg-surface-2/50 border-l-2 border-transparent"
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-mono text-gray-300">{brief.date}</span>
                        <VerdictBadge verdict={brief.verdict} />
                      </div>
                      <p className="text-xs text-gray-500 mt-0.5 truncate">{brief.angle}</p>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
