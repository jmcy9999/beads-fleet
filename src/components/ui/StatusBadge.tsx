import { STATUS_CONFIG, type IssueStatus } from "@/lib/types";

interface StatusBadgeProps {
  status: IssueStatus;
  size?: "sm" | "md";
}

export function StatusBadge({ status, size = "sm" }: StatusBadgeProps) {
  const config = STATUS_CONFIG[status];
  const sizeClasses =
    size === "sm" ? "px-2 py-0.5 text-xs" : "px-3 py-1 text-sm";

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full font-medium ${config.color} ${config.bgColor} ${sizeClasses}`}
    >
      {config.label}
    </span>
  );
}
