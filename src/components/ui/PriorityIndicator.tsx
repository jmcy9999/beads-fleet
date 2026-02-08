import { PRIORITY_CONFIG, type Priority } from "@/lib/types";

interface PriorityIndicatorProps {
  priority: Priority;
  showLabel?: boolean;
}

export function PriorityIndicator({
  priority,
  showLabel = false,
}: PriorityIndicatorProps) {
  const config = PRIORITY_CONFIG[priority];

  return (
    <span
      className={`inline-flex items-center gap-1 ${config.color}`}
      title={`P${priority} - ${config.label}`}
    >
      {config.flames > 0 ? (
        <span aria-label={`${config.flames} flames`}>
          {"🔥".repeat(config.flames)}
        </span>
      ) : (
        <span className="text-priority-minimal" aria-label="No flames">
          —
        </span>
      )}
      {showLabel && (
        <span className="text-xs font-medium">{config.label}</span>
      )}
    </span>
  );
}
