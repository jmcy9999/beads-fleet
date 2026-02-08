"use client";
import { useQuery } from "@tanstack/react-query";
import type { RobotPlan } from "@/lib/types";

export function useIssues() {
  return useQuery<RobotPlan>({
    queryKey: ["issues"],
    queryFn: async () => {
      const res = await fetch("/api/issues");
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      return res.json();
    },
  });
}
