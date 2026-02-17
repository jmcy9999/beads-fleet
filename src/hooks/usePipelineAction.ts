"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";

/**
 * Pipeline actions corresponding to buttons on the fleet board and issue
 * detail page. Each action maps to a specific pipeline stage transition.
 */
export type PipelineActionType =
  | "start-research"
  | "stop-agent"
  | "send-for-development"
  | "send-to-development"  // alias for backward compat
  | "more-research"
  | "deprioritise"
  | "approve-submission"
  | "send-back-to-dev"
  | "send-back-to-development"  // alias for backward compat
  | "mark-as-live"
  | "generate-plan"
  | "approve-plan"
  | "revise-plan"
  | "skip-to-plan"
  | "revise-plan-from-launch";

export interface PipelineActionParams {
  epicId: string;
  epicTitle?: string;
  action: PipelineActionType;
  feedback?: string;
  currentLabels?: string[];
}

interface PipelineActionResult {
  success: boolean;
  action: string;
  epicId: string;
}

/**
 * Normalize action names that may use slightly different conventions.
 * The API expects specific action strings.
 */
function normalizeAction(action: PipelineActionType): string {
  if (action === "send-to-development") return "send-for-development";
  if (action === "send-back-to-development") return "send-back-to-dev";
  return action;
}

export function usePipelineAction() {
  const queryClient = useQueryClient();

  return useMutation<PipelineActionResult, Error, PipelineActionParams>({
    mutationFn: async ({ epicId, epicTitle, action, feedback, currentLabels }) => {
      const res = await fetch("/api/fleet/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          epicId,
          epicTitle: epicTitle ?? epicId, // fallback to ID if title not provided
          action: normalizeAction(action),
          feedback,
          currentLabels,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      return res.json() as Promise<PipelineActionResult>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["issues"] });
      queryClient.invalidateQueries({ queryKey: ["issue"] });
      queryClient.invalidateQueries({ queryKey: ["agent-status"] });
      queryClient.invalidateQueries({ queryKey: ["insights"] });
    },
  });
}
