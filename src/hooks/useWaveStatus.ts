"use client";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import type { WaveProgress } from "@/components/fleet/fleet-utils";

interface WaveStatusData {
  epicId: string;
  waveProgress: WaveProgress[] | null;
  children: {
    total: number;
    closed: number;
    inProgress: number;
    blocked: number;
  };
}

/**
 * Fetch wave status for a non-internal epic's children across all registered repos.
 * Pass null to disable (for internal/venture epics that don't need cross-repo lookup).
 */
export function useWaveStatus(epicId: string | null) {
  return useQuery<WaveStatusData>({
    queryKey: ["wave-status", epicId],
    queryFn: async () => {
      const res = await fetch(`/api/fleet/wave-status?epicId=${encodeURIComponent(epicId!)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      return res.json();
    },
    enabled: !!epicId,
    refetchInterval: 15_000,
    placeholderData: keepPreviousData,
  });
}
