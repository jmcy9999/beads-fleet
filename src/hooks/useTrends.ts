"use client";

import { useQuery } from "@tanstack/react-query";

const TREND_SCOUT_API = "http://localhost:3001";

export interface TrendScore {
  total_score: number;
  signal_score: number;
  growth_score: number;
  gap_score: number;
  monetization_score: number;
  date: string;
}

export interface Trend {
  id: number;
  name: string;
  slug: string;
  category: string;
  first_seen: string;
  last_seen: string;
  app_angle: string | null;
  status: string;
  score: TrendScore | null;
}

export interface TrendDetail extends Trend {
  signals: { date: string; source: string; strength: number }[];
  sources: {
    source: string;
    url: string | null;
    title: string | null;
    discovered_at: string;
  }[];
  scores: TrendScore[];
}

export interface TrendStats {
  active: number;
  promoted: number;
  dismissed: number;
  totalSignals: number;
  activeSources: number;
  latestScan: string | null;
  categories: { category: string; count: number }[];
}

export interface SparklinePoint {
  date: string;
  total_strength: number;
}

export function useTrends(status?: string, category?: string) {
  return useQuery<Trend[]>({
    queryKey: ["trends", status, category],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (status) params.set("status", status);
      if (category) params.set("category", category);
      const res = await fetch(`${TREND_SCOUT_API}/api/trends?${params}`);
      if (!res.ok) throw new Error("Failed to fetch trends");
      return res.json();
    },
    refetchInterval: 60000,
  });
}

export function useTopTrends(limit = 20) {
  return useQuery<Trend[]>({
    queryKey: ["trends", "top", limit],
    queryFn: async () => {
      const res = await fetch(
        `${TREND_SCOUT_API}/api/trends/top?limit=${limit}`,
      );
      if (!res.ok) throw new Error("Failed to fetch top trends");
      return res.json();
    },
    refetchInterval: 60000,
  });
}

export function useTrendDetail(id: number | null) {
  return useQuery<TrendDetail>({
    queryKey: ["trend", id],
    queryFn: async () => {
      const res = await fetch(`${TREND_SCOUT_API}/api/trends/${id}`);
      if (!res.ok) throw new Error("Failed to fetch trend detail");
      return res.json();
    },
    enabled: id !== null,
  });
}

export function useTrendStats() {
  return useQuery<TrendStats>({
    queryKey: ["trend-stats"],
    queryFn: async () => {
      const res = await fetch(`${TREND_SCOUT_API}/api/stats/summary`);
      if (!res.ok) throw new Error("Failed to fetch trend stats");
      return res.json();
    },
    refetchInterval: 60000,
  });
}

export function useSparkline(id: number | null, days = 30) {
  return useQuery<SparklinePoint[]>({
    queryKey: ["sparkline", id, days],
    queryFn: async () => {
      const res = await fetch(
        `${TREND_SCOUT_API}/api/trends/${id}/sparkline?days=${days}`,
      );
      if (!res.ok) throw new Error("Failed to fetch sparkline");
      return res.json();
    },
    enabled: id !== null,
  });
}
