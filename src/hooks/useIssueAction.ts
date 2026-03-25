"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/components/ui/Toast";

interface IssueActionParams {
  issueId: string;
  action: "start" | "close" | "reopen" | "comment" | "label-add" | "label-rm";
  reason?: string;
}

interface IssueActionResult {
  success: boolean;
  action: string;
  issueId: string;
}

export function useIssueAction() {
  const queryClient = useQueryClient();
  const { addToast } = useToast();

  return useMutation<IssueActionResult, Error, IssueActionParams>({
    mutationFn: async ({ issueId, action, reason }) => {
      const res = await fetch(`/api/issues/${issueId}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, reason }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      return res.json() as Promise<IssueActionResult>;
    },
    onSuccess: (_data, variables) => {
      addToast(`Issue ${variables.issueId}: ${variables.action} completed`, "success");
      queryClient.invalidateQueries({ queryKey: ["issues"] });
      queryClient.invalidateQueries({ queryKey: ["issue"] });
      queryClient.invalidateQueries({ queryKey: ["insights"] });
      queryClient.invalidateQueries({ queryKey: ["priority"] });
    },
    onError: (err, variables) => {
      addToast(`Issue ${variables.issueId}: ${variables.action} failed \u2014 ${err.message}`, "error");
    },
  });
}
