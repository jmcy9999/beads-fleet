"use client";
import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import type { VenturePlan } from "@/lib/venture-plan-types";

interface VenturePlanResponse {
  plan: VenturePlan;
  repoPath: string;
  planPath: string;
}

/**
 * Fetch a venture plan for a given app name.
 * Only fetches when appName is provided (non-empty string).
 */
export function useVenturePlan(appName: string | null) {
  return useQuery<VenturePlanResponse>({
    queryKey: ["venture-plan", appName],
    queryFn: async () => {
      const res = await fetch(`/api/venture-plan/${encodeURIComponent(appName!)}`);
      if (!res.ok) {
        if (res.status === 404) return { plan: null as unknown as VenturePlan, repoPath: "", planPath: "" };
        throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      }
      return res.json();
    },
    enabled: !!appName,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });
}

/**
 * Mutation to update a venture plan (PUT).
 * Invalidates the query cache on success.
 */
export function useUpdateVenturePlan(appName: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (plan: VenturePlan) => {
      const res = await fetch(`/api/venture-plan/${encodeURIComponent(appName!)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(plan),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["venture-plan", appName] });
    },
  });
}
