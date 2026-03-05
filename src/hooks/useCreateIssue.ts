"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";

interface CreateIssueInput {
  note: string;
  repoPath: string;
}

interface CreateIssueResult {
  success: boolean;
  issueId?: string;
  title?: string;
}

export function useCreateIssue() {
  const queryClient = useQueryClient();

  return useMutation<CreateIssueResult, Error, CreateIssueInput>({
    mutationFn: async ({ note, repoPath }) => {
      const res = await fetch("/api/issues", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note, repoPath }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["issues"] });
      queryClient.invalidateQueries({ queryKey: ["insights"] });
    },
  });
}
