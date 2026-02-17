"use client";
import { useQuery, keepPreviousData } from "@tanstack/react-query";

interface PlanReportResponse {
  content: string;
  repoPath: string;
}

/**
 * Fetch a plan document for a given issue ID.
 * Only fetches when issueId is provided (non-empty string).
 */
export function usePlanReport(issueId: string | null) {
  return useQuery<PlanReportResponse>({
    queryKey: ["plan-report", issueId],
    queryFn: async () => {
      const res = await fetch(`/api/plan/${encodeURIComponent(issueId!)}`);
      if (!res.ok) {
        if (res.status === 404) return { content: "", repoPath: "" };
        throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      }
      return res.json();
    },
    enabled: !!issueId,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });
}
