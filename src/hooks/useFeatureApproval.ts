"use client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

export interface FeatureDecision {
  id: string;
  name: string;
  description?: string;
  status: "pending" | "approved" | "rejected" | "deferred";
}

export interface FeatureApprovalState {
  epicId: string;
  features: FeatureDecision[];
  updatedAt: string;
}

export function useFeatureApproval(epicId: string | null) {
  const queryClient = useQueryClient();

  const query = useQuery<FeatureApprovalState | null>({
    queryKey: ["feature-approval", epicId],
    queryFn: async () => {
      const res = await fetch(`/api/fleet/approval?epicId=${encodeURIComponent(epicId!)}`);
      if (!res.ok) {
        if (res.status === 404) return null;
        throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      }
      return res.json();
    },
    enabled: !!epicId,
    staleTime: 30_000,
  });

  const mutation = useMutation<{ success: boolean; state: FeatureApprovalState }, Error, FeatureApprovalState>({
    mutationFn: async (state) => {
      const res = await fetch("/api/fleet/approval", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["feature-approval", epicId] });
    },
  });

  return { query, mutation };
}
