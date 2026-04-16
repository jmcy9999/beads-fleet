"use client";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import type { RobotPlan } from "@/lib/types";

export function useIssues() {
  return useQuery<RobotPlan>({
    queryKey: ["issues"],
    queryFn: async () => {
      const res = await fetch("/api/issues");
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      return res.json();
    },
    // 15s ensures attention items (checkpoint labels, qa:needs-review, child
    // `human` flags) become visible on the fleet board within the staleness
    // budget from factory-core-509's functional spec. (factory-core-509.3)
    refetchInterval: 15_000,
    placeholderData: keepPreviousData,
  });
}
