"use client";
import type { GraphMetricEntry } from "@/lib/types";

type ColorScheme = "blue" | "purple" | "pink" | "amber" | "green" | "red";

interface MetricPanelProps {
  title: string;
  description: string;
  entries: GraphMetricEntry[];
  colorScheme: ColorScheme;
}

const gradientClasses: Record<ColorScheme, string> = {
  blue: "from-blue-900/40 to-blue-500",
  purple: "from-purple-900/40 to-purple-500",
  pink: "from-pink-900/40 to-pink-500",
  amber: "from-amber-900/40 to-amber-500",
  green: "from-green-900/40 to-green-500",
  red: "from-red-900/40 to-red-500",
};

const accentClasses: Record<ColorScheme, string> = {
  blue: "text-blue-400",
  purple: "text-purple-400",
  pink: "text-pink-400",
  amber: "text-amber-400",
  green: "text-green-400",
  red: "text-red-400",
};

export function MetricPanel({
  title,
  description,
  entries,
  colorScheme,
}: MetricPanelProps) {
  const top5 = entries.slice(0, 5);
  const maxScore = top5.length > 0 ? Math.max(...top5.map((e) => e.score)) : 0;

  return (
    <div className="card p-5">
      <div className="mb-4">
        <h3 className={`text-sm font-semibold uppercase tracking-wider ${accentClasses[colorScheme]}`}>
          {title}
        </h3>
        <p className="text-xs text-gray-500 mt-0.5">{description}</p>
      </div>

      {top5.length === 0 ? (
        <div className="text-center py-6">
          <p className="text-sm text-gray-500">No data available</p>
        </div>
      ) : (
        <ol className="space-y-2">
          {top5.map((entry, i) => {
            const widthPercent =
              maxScore > 0 ? (entry.score / maxScore) * 100 : 0;

            return (
              <li key={entry.issue_id} className="flex items-center gap-3">
                <span className="text-xs font-bold text-gray-500 w-5 text-right shrink-0">
                  {i + 1}
                </span>
                <span className="font-mono text-xs text-gray-400 shrink-0">
                  {entry.issue_id}
                </span>
                <span
                  className="text-sm text-gray-300 truncate min-w-0 flex-1"
                  title={entry.title}
                >
                  {entry.title}
                </span>
                <div className="w-24 shrink-0">
                  <div className="h-2 rounded-full bg-surface-2 overflow-hidden">
                    <div
                      className={`h-full rounded-full bg-gradient-to-r ${gradientClasses[colorScheme]}`}
                      style={{ width: `${Math.max(widthPercent, 4)}%` }}
                    />
                  </div>
                  <span className="text-[10px] text-gray-500 mt-0.5 block text-right">
                    {entry.score.toFixed(3)}
                  </span>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
