import { IssueCard } from "@/components/ui/IssueCard";
import { STATUS_CONFIG, type IssueStatus, type PlanIssue } from "@/lib/types";

interface KanbanColumnProps {
  status: IssueStatus;
  issues: PlanIssue[];
  onSelectIssue: (id: string) => void;
}

/** Static mapping so Tailwind JIT can detect full class names. */
const DOT_COLOR: Record<IssueStatus, string> = {
  open: "bg-status-open",
  in_progress: "bg-status-progress",
  blocked: "bg-status-blocked",
  closed: "bg-status-closed",
  deferred: "bg-status-deferred",
  pinned: "bg-status-pinned",
};

export function KanbanColumn({
  status,
  issues,
  onSelectIssue,
}: KanbanColumnProps) {
  const config = STATUS_CONFIG[status];

  return (
    <div className="min-w-[280px] max-w-[320px] flex-shrink-0 flex flex-col h-full">
      {/* Column header */}
      <div className="flex items-center gap-2 px-3 py-2 mb-3">
        <span
          className={`h-2.5 w-2.5 rounded-full ${DOT_COLOR[status]}`}
          aria-hidden="true"
        />
        <h2 className="text-sm font-medium text-gray-200">{config.label}</h2>
        <span className="ml-auto rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium text-gray-400">
          {issues.length}
        </span>
      </div>

      {/* Card list */}
      <div className="flex-1 overflow-y-auto space-y-2 px-1">
        {issues.length === 0 ? (
          <p className="text-center text-sm text-gray-500 py-8">No issues</p>
        ) : (
          issues.map((issue) => (
            <IssueCard
              key={issue.id}
              issue={issue}
              variant="card"
              onClick={onSelectIssue}
            />
          ))
        )}
      </div>
    </div>
  );
}
