import type { IssueType } from "@/lib/types";

const ISSUE_TYPE_EMOJI: Record<IssueType, { emoji: string; label: string }> = {
  bug: { emoji: "🐛", label: "Bug" },
  feature: { emoji: "✨", label: "Feature" },
  task: { emoji: "📋", label: "Task" },
  epic: { emoji: "🏔️", label: "Epic" },
  chore: { emoji: "🔧", label: "Chore" },
};

interface IssueTypeIconProps {
  type: IssueType;
  showLabel?: boolean;
}

export function IssueTypeIcon({ type, showLabel = false }: IssueTypeIconProps) {
  const config = ISSUE_TYPE_EMOJI[type];

  return (
    <span
      className="inline-flex items-center gap-1"
      title={config.label}
      role="img"
      aria-label={config.label}
    >
      <span>{config.emoji}</span>
      {showLabel && (
        <span className="text-xs text-gray-400">{config.label}</span>
      )}
    </span>
  );
}
