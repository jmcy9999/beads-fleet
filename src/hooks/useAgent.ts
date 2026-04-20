"use client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { AgentSession, AgentStatus, FleetStatus } from "@/lib/agent-launcher";
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

/**
 * factory-core-d5b.7: fleet-wide status — returns ALL running agents.
 * Used by FleetPage to render one AgentStatusBanner per session so
 * parallel per-bead builders (z9h.3) and concurrent epics (ppx) are all
 * visible, not just the first-discovered.
 */
export function useFleetAgentStatus() {
  return useQuery<FleetStatus>({
    queryKey: ["fleet-agent-status"],
    queryFn: async () => {
      const res = await fetch("/api/agent?fleet=true");
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      return res.json();
    },
    refetchInterval: 5_000,
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

interface StopAgentParams {
  repoPath?: string; // stop only this repo's agent(s); omit to stop all
  epicId?: string;   // scope label-clearing (optional)
}

export function useAgentStop() {
  const queryClient = useQueryClient();
  const { addToast } = useToast();

  // factory-core-d5b.7: accept { repoPath, epicId } so individual banners
  // can stop a specific agent instead of always stopping all. When called
  // with no args, behaviour matches the old single-agent semantics (stop
  // the only running agent). Caveat: the server-side stopAgent(repoPath)
  // kills every agent whose session.repoPath matches — so for parallel
  // per-bead builders sharing one repo, this still stops all of them.
  // Surgical per-bead stop is a follow-up (requires tmuxSessionName in
  // the stopAgent signature).
  return useMutation<
    { stopped: boolean; pid?: number; stoppedCount?: number },
    Error,
    StopAgentParams | undefined
  >({
    mutationFn: async (params) => {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stop", ...(params ?? {}) }),
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
      queryClient.invalidateQueries({ queryKey: ["fleet-agent-status"] });
      queryClient.invalidateQueries({ queryKey: ["issues"] });
    },
    onError: (err) => {
      addToast(`Failed to stop agent \u2014 ${err.message}`, "error");
    },
  });
}

