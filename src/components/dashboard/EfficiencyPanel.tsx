"use client";

import { useMemo } from "react";
import { useTokenUsageSummary } from "@/hooks/useTokenUsage";
import { useIssues } from "@/hooks/useIssues";

interface IssueEfficiency {
  id: string;
  title: string;
  story_points: number;
  total_tokens: number;
  total_cost_usd: number;
  tokens_per_sp: number;
  cost_per_sp: number;
}

export function EfficiencyPanel() {
  const { data: tokenSummary } = useTokenUsageSummary();
  const { data: plan } = useIssues();

  const { metrics, issueData } = useMemo(() => {
    if (!tokenSummary?.byIssue || !plan?.all_issues) {
      return { metrics: null, issueData: [] };
    }

    const items: IssueEfficiency[] = [];

    for (const issue of plan.all_issues) {
      if (!issue.story_points || issue.story_points <= 0) continue;
      const usage = tokenSummary.byIssue[issue.id];
      if (!usage || usage.total_tokens === 0) continue;

      items.push({
        id: issue.id,
        title: issue.title,
        story_points: issue.story_points,
        total_tokens: usage.total_tokens,
        total_cost_usd: usage.total_cost_usd,
        tokens_per_sp: Math.round(usage.total_tokens / issue.story_points),
        cost_per_sp: usage.total_cost_usd / issue.story_points,
      });
    }

    if (items.length === 0) return { metrics: null, issueData: [] };

    const totalTokens = items.reduce((s, i) => s + i.total_tokens, 0);
    const totalCost = items.reduce((s, i) => s + i.total_cost_usd, 0);
    const totalSP = items.reduce((s, i) => s + i.story_points, 0);

    return {
      metrics: {
        avgTokensPerSP: Math.round(totalTokens / totalSP),
        avgCostPerSP: totalCost / totalSP,
        totalSP,
        issueCount: items.length,
      },
      issueData: items.sort((a, b) => a.cost_per_sp - b.cost_per_sp),
    };
  }, [tokenSummary, plan]);

  if (!metrics) return null;

  // Find the max tokens_per_sp for bar scaling
  const maxTokens = Math.max(...issueData.map((i) => i.tokens_per_sp));

  return (
    <div>
      <h2 className="text-xs font-medium uppercase tracking-wider text-gray-500 mb-3">
        Efficiency (Tokens per Story Point)
      </h2>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
        <div className="card p-4">
          <span className="text-xs font-medium uppercase tracking-wider text-gray-400 block mb-1">
            Avg Tokens/SP
          </span>
          <span className="text-2xl font-bold text-white">
            {metrics.avgTokensPerSP.toLocaleString()}
          </span>
        </div>
        <div className="card p-4">
          <span className="text-xs font-medium uppercase tracking-wider text-gray-400 block mb-1">
            Avg Cost/SP
          </span>
          <span className="text-2xl font-bold text-amber-400">
            ${metrics.avgCostPerSP.toFixed(2)}
          </span>
        </div>
        <div className="card p-4">
          <span className="text-xs font-medium uppercase tracking-wider text-gray-400 block mb-1">
            Total Story Points
          </span>
          <span className="text-2xl font-bold text-cyan-400">
            {metrics.totalSP}
          </span>
        </div>
        <div className="card p-4">
          <span className="text-xs font-medium uppercase tracking-wider text-gray-400 block mb-1">
            Issues with SP
          </span>
          <span className="text-2xl font-bold text-white">
            {metrics.issueCount}
          </span>
        </div>
      </div>

      {/* Scatter-style bar chart: tokens per SP by issue */}
      {issueData.length > 0 && (
        <div className="card p-4">
          <h3 className="text-xs font-medium uppercase tracking-wider text-gray-500 mb-3">
            Tokens/SP by Issue
          </h3>
          <div className="space-y-2">
            {issueData.slice(0, 15).map((item) => {
              const barPct = maxTokens > 0 ? (item.tokens_per_sp / maxTokens) * 100 : 0;
              return (
                <div key={item.id} className="flex items-center gap-2">
                  <span className="font-mono text-[10px] text-gray-500 w-24 shrink-0 truncate" title={item.id}>
                    {item.id}
                  </span>
                  <div className="flex-1 h-4 bg-surface-2 rounded overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-cyan-500 to-blue-500 rounded"
                      style={{ width: `${barPct}%` }}
                    />
                  </div>
                  <span className="text-[10px] text-gray-400 w-20 text-right shrink-0">
                    {item.tokens_per_sp.toLocaleString()} t/{item.story_points}sp
                  </span>
                  <span className="text-[10px] text-amber-400 font-mono w-14 text-right shrink-0">
                    ${item.cost_per_sp.toFixed(2)}/sp
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
