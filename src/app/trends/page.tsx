"use client";

import { useState } from "react";
import {
  useTrends,
  useTrendStats,
  useTrendDetail,
  type Trend,
} from "@/hooks/useTrends";

function ScoreBar({ value, max = 1 }: { value: number; max?: number }) {
  const pct = Math.round((value / max) * 100);
  return (
    <div className="w-full bg-surface-0 rounded-full h-2">
      <div
        className="h-2 rounded-full transition-all"
        style={{
          width: `${pct}%`,
          backgroundColor:
            pct >= 70
              ? "var(--color-status-closed)"
              : pct >= 40
                ? "var(--color-status-progress)"
                : "var(--color-status-open)",
        }}
      />
    </div>
  );
}

function SourceBadge({ source }: { source: string }) {
  const colors: Record<string, string> = {
    "google-trends": "bg-blue-500/20 text-blue-400",
    reddit: "bg-orange-500/20 text-orange-400",
    "product-hunt": "bg-amber-500/20 text-amber-400",
    "app-store": "bg-purple-500/20 text-purple-400",
    "hacker-news": "bg-emerald-500/20 text-emerald-400",
    techcrunch: "bg-green-500/20 text-green-400",
  };
  return (
    <span
      className={`px-2 py-0.5 rounded text-xs font-medium ${colors[source] || "bg-surface-2 text-gray-400"}`}
    >
      {source}
    </span>
  );
}

function CategoryBadge({ category }: { category: string }) {
  return (
    <span className="px-2 py-0.5 rounded text-xs font-medium bg-surface-2 text-gray-300">
      {category}
    </span>
  );
}

function StatsCards({ stats }: { stats: ReturnType<typeof useTrendStats>["data"] }) {
  if (!stats) return null;
  const cards = [
    { label: "Active Trends", value: stats.active },
    { label: "Promoted", value: stats.promoted },
    { label: "Dismissed", value: stats.dismissed },
    { label: "Total Signals", value: stats.totalSignals },
    { label: "Sources", value: stats.activeSources },
  ];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-5 gap-4 mb-6">
      {cards.map((c) => (
        <div key={c.label} className="card p-4">
          <div className="text-sm text-gray-400">{c.label}</div>
          <div className="text-2xl font-bold text-white mt-1">{c.value}</div>
        </div>
      ))}
    </div>
  );
}

function TrendRow({
  trend,
  onClick,
  selected,
}: {
  trend: Trend;
  onClick: () => void;
  selected: boolean;
}) {
  const score = trend.score;
  return (
    <tr
      className={`border-b border-border-default cursor-pointer transition-colors ${
        selected
          ? "bg-surface-2"
          : "hover:bg-surface-1"
      }`}
      onClick={onClick}
    >
      <td className="px-4 py-3">
        <div className="font-medium text-white truncate max-w-xs">
          {trend.name}
        </div>
        {trend.app_angle && (
          <div className="text-xs text-gray-400 truncate max-w-xs mt-0.5">
            {trend.app_angle}
          </div>
        )}
      </td>
      <td className="px-4 py-3">
        <CategoryBadge category={trend.category} />
      </td>
      <td className="px-4 py-3 w-32">
        {score ? (
          <div className="flex items-center gap-2">
            <ScoreBar value={score.total_score} />
            <span className="text-sm text-gray-300 w-10 text-right">
              {score.total_score.toFixed(2)}
            </span>
          </div>
        ) : (
          <span className="text-gray-500 text-sm">--</span>
        )}
      </td>
      <td className="px-4 py-3 text-sm text-gray-400">{trend.first_seen}</td>
      <td className="px-4 py-3 text-sm text-gray-400">{trend.last_seen}</td>
    </tr>
  );
}

function TrendDetail({ trendId }: { trendId: number }) {
  const { data: trend, isLoading } = useTrendDetail(trendId);

  if (isLoading)
    return (
      <div className="card p-6 animate-pulse">
        <div className="h-6 bg-surface-2 rounded w-1/2 mb-4" />
        <div className="h-4 bg-surface-2 rounded w-3/4 mb-2" />
        <div className="h-4 bg-surface-2 rounded w-2/3" />
      </div>
    );
  if (!trend) return null;

  const latestScore = trend.scores?.[0];

  return (
    <div className="card p-6">
      <h3 className="text-lg font-bold text-white mb-1">{trend.name}</h3>
      <div className="flex gap-2 mb-4">
        <CategoryBadge category={trend.category} />
        <span
          className={`px-2 py-0.5 rounded text-xs font-medium ${
            trend.status === "active"
              ? "bg-status-open/20 text-status-open"
              : trend.status === "promoted"
                ? "bg-status-closed/20 text-status-closed"
                : "bg-gray-500/20 text-gray-400"
          }`}
        >
          {trend.status}
        </span>
      </div>

      {trend.app_angle && (
        <p className="text-sm text-gray-300 mb-4">{trend.app_angle}</p>
      )}

      {latestScore && (
        <div className="mb-4">
          <h4 className="text-sm font-medium text-gray-400 mb-2">
            Score Breakdown
          </h4>
          <div className="space-y-2">
            {[
              { label: "Signal", value: latestScore.signal_score },
              { label: "Growth", value: latestScore.growth_score },
              { label: "Gap", value: latestScore.gap_score },
              { label: "Monetization", value: latestScore.monetization_score },
            ].map((s) => (
              <div key={s.label} className="flex items-center gap-2">
                <span className="text-xs text-gray-400 w-24">{s.label}</span>
                <ScoreBar value={s.value} />
                <span className="text-xs text-gray-300 w-8 text-right">
                  {s.value.toFixed(2)}
                </span>
              </div>
            ))}
          </div>
          <div className="mt-2 pt-2 border-t border-border-default flex items-center gap-2">
            <span className="text-xs text-gray-400 w-24 font-medium">
              Total
            </span>
            <ScoreBar value={latestScore.total_score} />
            <span className="text-xs text-white font-bold w-8 text-right">
              {latestScore.total_score.toFixed(2)}
            </span>
          </div>
        </div>
      )}

      {trend.sources && trend.sources.length > 0 && (
        <div className="mb-4">
          <h4 className="text-sm font-medium text-gray-400 mb-2">Sources</h4>
          <div className="space-y-1">
            {trend.sources.slice(0, 8).map((s, i) => (
              <div key={i} className="flex items-center gap-2">
                <SourceBadge source={s.source} />
                {s.url ? (
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-blue-400 hover:underline truncate"
                  >
                    {s.title || s.url}
                  </a>
                ) : (
                  <span className="text-xs text-gray-400">
                    {s.title || "No link"}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {trend.signals && trend.signals.length > 0 && (
        <div>
          <h4 className="text-sm font-medium text-gray-400 mb-2">
            Signal History ({trend.signals.length} data points)
          </h4>
          <div className="flex gap-1 items-end h-16">
            {trend.signals.slice(-30).map((s, i) => (
              <div
                key={i}
                className="flex-1 bg-blue-500/50 rounded-t min-w-[2px]"
                style={{ height: `${Math.max(4, s.strength * 100)}%` }}
                title={`${s.date}: ${s.strength.toFixed(2)} (${s.source})`}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function TrendsPage() {
  const [statusFilter, setStatusFilter] = useState("active");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const {
    data: trends,
    isLoading,
    error,
  } = useTrends(statusFilter, categoryFilter || undefined);
  const { data: stats } = useTrendStats();

  // Sort by score descending
  const sorted = trends
    ? [...trends].sort(
        (a, b) =>
          (b.score?.total_score || 0) - (a.score?.total_score || 0),
      )
    : [];

  const categories = stats?.categories?.map((c) => c.category) || [];

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">Trend Scout</h1>
        <p className="text-sm text-gray-400 mt-1">
          Automated niche and trend discovery for app ideas
          {stats?.latestScan && (
            <span className="ml-2">
              — last scan: {stats.latestScan}
            </span>
          )}
        </p>
      </div>

      <StatsCards stats={stats} />

      {/* Filters */}
      <div className="flex gap-3 mb-4">
        <select
          className="bg-surface-1 border border-border-default rounded px-3 py-1.5 text-sm text-gray-300"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
        >
          <option value="active">Active</option>
          <option value="promoted">Promoted</option>
          <option value="dismissed">Dismissed</option>
          <option value="stale">Stale</option>
        </select>
        <select
          className="bg-surface-1 border border-border-default rounded px-3 py-1.5 text-sm text-gray-300"
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
        >
          <option value="">All Categories</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Trends table */}
        <div className="lg:col-span-2">
          {isLoading ? (
            <div className="card p-6 space-y-3">
              {[...Array(8)].map((_, i) => (
                <div
                  key={i}
                  className="h-12 bg-surface-2 rounded animate-pulse"
                />
              ))}
            </div>
          ) : error ? (
            <div className="card p-6 text-center">
              <p className="text-red-400 mb-2">
                Failed to load trends
              </p>
              <p className="text-sm text-gray-400">
                Make sure the Trend Scout API is running: cd
                tools/trend-scout && npm run serve
              </p>
            </div>
          ) : sorted.length === 0 ? (
            <div className="card p-6 text-center">
              <p className="text-gray-400">No trends found</p>
              <p className="text-sm text-gray-500 mt-1">
                Run a scan first: cd tools/trend-scout && npm run scout
              </p>
            </div>
          ) : (
            <div className="card overflow-hidden">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border-default bg-surface-0">
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase">
                      Trend
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase">
                      Category
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase">
                      Score
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase">
                      First Seen
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase">
                      Last Seen
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((t) => (
                    <TrendRow
                      key={t.id}
                      trend={t}
                      selected={selectedId === t.id}
                      onClick={() =>
                        setSelectedId(
                          selectedId === t.id ? null : t.id,
                        )
                      }
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Detail panel */}
        <div className="lg:col-span-1">
          {selectedId ? (
            <TrendDetail trendId={selectedId} />
          ) : (
            <div className="card p-6 text-center text-gray-400">
              <p>Select a trend to see details</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
