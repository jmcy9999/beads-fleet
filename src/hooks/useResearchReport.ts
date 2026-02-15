"use client";
import { useQuery, keepPreviousData } from "@tanstack/react-query";

interface ResearchReportResponse {
  content: string;
  repoPath: string;
}

/**
 * Fetch a research report for a given app name.
 * Only fetches when appName is provided (non-empty string).
 */
export function useResearchReport(appName: string | null) {
  return useQuery<ResearchReportResponse>({
    queryKey: ["research-report", appName],
    queryFn: async () => {
      const res = await fetch(`/api/research/${encodeURIComponent(appName!)}`);
      if (!res.ok) {
        if (res.status === 404) return { content: "", repoPath: "" };
        throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      }
      return res.json();
    },
    enabled: !!appName,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });
}
