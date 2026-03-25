"use client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { AgentSession, AgentStatus } from "@/lib/agent-launcher";
import { useToast } from "@/components/ui/Toast";

interface LaunchParams {
  repoPath: string;
  prompt: string;
  model?: string;
  maxTurns?: number;
  allowedTools?: string;
  epicId?: string;
  pipelineStage?: string;
}

export function useAgentStatus() {
  return useQuery<AgentStatus>({
    queryKey: ["agent-status"],
    queryFn: async () => {
      const res = await fetch("/api/agent");
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      return res.json();
    },
    refetchInterval: 5_000, // Poll every 5s while agent may be running
    staleTime: 3_000,
  });
}

export function useAgentLaunch() {
  const queryClient = useQueryClient();
  const { addToast } = useToast();

  return useMutation<{ launched: boolean; session: AgentSession }, Error, LaunchParams>({
    mutationFn: async (params) => {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "launch", ...params }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      addToast("Agent launched", "success");
      queryClient.invalidateQueries({ queryKey: ["agent-status"] });
      queryClient.invalidateQueries({ queryKey: ["issues"] });
    },
    onError: (err) => {
      addToast(`Agent launch failed \u2014 ${err.message}`, "error");
    },
  });
}

export function useAgentStop() {
  const queryClient = useQueryClient();
  const { addToast } = useToast();

  return useMutation<{ stopped: boolean; pid?: number }, Error>({
    mutationFn: async () => {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stop" }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      addToast("Agent stopped", "info");
      queryClient.invalidateQueries({ queryKey: ["agent-status"] });
      queryClient.invalidateQueries({ queryKey: ["issues"] });
    },
    onError: (err) => {
      addToast(`Failed to stop agent \u2014 ${err.message}`, "error");
    },
  });
}

