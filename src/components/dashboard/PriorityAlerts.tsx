import type { PriorityRecommendation } from "@/lib/types";
import { PRIORITY_CONFIG } from "@/lib/types";

interface PriorityAlertsProps {
  recommendations: PriorityRecommendation[];
}

export function PriorityAlerts({ recommendations }: PriorityAlertsProps) {
  const misaligned = recommendations
    .filter((r) => r.current_priority !== r.recommended_priority)
    .slice(0, 3);

  if (misaligned.length === 0) return null;

  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-5">
      <h2 className="text-xs font-medium uppercase tracking-wider text-amber-400 mb-3">
        Priority Recommendations
      </h2>
      <div className="space-y-3">
        {misaligned.map((rec) => (
          <div
            key={rec.issue_id}
            className="flex items-start gap-3 text-sm"
          >
            <span className="font-mono text-xs text-gray-400 shrink-0 pt-0.5">
              {rec.issue_id}
            </span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span
                  className={`font-medium ${PRIORITY_CONFIG[rec.current_priority].color}`}
                >
                  P{rec.current_priority}
                </span>
                <span className="text-gray-500" aria-label="to">
                  &rarr;
                </span>
                <span
                  className={`font-medium ${PRIORITY_CONFIG[rec.recommended_priority].color}`}
                >
                  P{rec.recommended_priority}
                </span>
                <span className="text-xs text-gray-500">
                  ({Math.round(rec.confidence * 100)}% confidence)
                </span>
              </div>
              <p className="text-xs text-gray-400 mt-0.5 truncate">
                {rec.reason}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
