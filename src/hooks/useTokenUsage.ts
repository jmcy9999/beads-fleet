"use client";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import type { TokenUsageRecord, IssueTokenSummary } from "@/lib/types";

interface TokenUsageSummaryResponse {
  byIssue: Record<string, IssueTokenSummary>;
  totals: IssueTokenSummary;
}

export function useTokenUsage(issueId?: string) {
  const queryKey = issueId ? ["token-usage", issueId] : ["token-usage"];
  const url = issueId
    ? `/api/token-usage?issue_id=${encodeURIComponent(issueId)}`
    : "/api/token-usage";

  return useQuery<TokenUsageRecord[]>({
    queryKey,
    queryFn: async () => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      return res.json();
    },
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
  });
}

export function useTokenUsageSummary() {
  return useQuery<TokenUsageSummaryResponse>({
    queryKey: ["token-usage", "summary"],
    queryFn: async () => {
      const res = await fetch("/api/token-usage?summary=true");
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      return res.json();
    },
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
  });
}
