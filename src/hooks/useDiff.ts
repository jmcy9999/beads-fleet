"use client";
import { useQuery } from "@tanstack/react-query";
import type { RobotDiff } from "@/lib/types";

export function useDiff(since: string = "HEAD~10") {
  return useQuery<RobotDiff>({
    queryKey: ["diff", since],
    queryFn: async () => {
      const res = await fetch(`/api/diff?since=${encodeURIComponent(since)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      return res.json();
    },
  });
}
