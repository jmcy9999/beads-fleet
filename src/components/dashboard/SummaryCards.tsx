import { SummaryCard } from "@/components/ui/SummaryCard";
import type { PlanSummary } from "@/lib/types";

interface SummaryCardsProps {
  summary: PlanSummary;
}

export function SummaryCards({ summary }: SummaryCardsProps) {
  const total =
    summary.open_count +
    summary.in_progress_count +
    summary.blocked_count +
    summary.closed_count;

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
      <SummaryCard
        label="Total Issues"
        value={total}
        icon="#"
      />
      <SummaryCard
        label="Open"
        value={summary.open_count}
        color="text-status-open"
        icon="O"
      />
      <SummaryCard
        label="In Progress"
        value={summary.in_progress_count}
        color="text-status-progress"
        icon=">"
      />
      <SummaryCard
        label="Blocked"
        value={summary.blocked_count}
        color="text-status-blocked"
        icon="!"
      />
      <SummaryCard
        label="Closed"
        value={summary.closed_count}
        color="text-gray-400"
        icon="x"
      />
    </div>
  );
}
