import { KanbanColumn } from "./KanbanColumn";
import { KANBAN_COLUMNS, type PlanIssue, type IssueStatus } from "@/lib/types";

interface KanbanBoardProps {
  issues: PlanIssue[];
  onSelectIssue: (id: string) => void;
}

const PRIORITY_ORDER = [0, 1, 2, 3, 4] as const;

/** Columns that are always shown, even when empty. */
const ALWAYS_VISIBLE: IssueStatus[] = ["open", "in_progress"];

export function KanbanBoard({ issues, onSelectIssue }: KanbanBoardProps) {
  const grouped = new Map<IssueStatus, PlanIssue[]>();

  for (const status of KANBAN_COLUMNS) {
    grouped.set(status, []);
  }

  for (const issue of issues) {
    const bucket = grouped.get(issue.status);
    if (bucket) {
      bucket.push(issue);
    }
  }

  // Sort each column by priority (P0 first)
  for (const [, bucket] of Array.from(grouped)) {
    bucket.sort(
      (a, b) =>
        PRIORITY_ORDER.indexOf(a.priority) -
        PRIORITY_ORDER.indexOf(b.priority),
    );
  }

  // Filter columns: always-visible ones + any others that have issues
  const visibleColumns = KANBAN_COLUMNS.filter(
    (status) =>
      ALWAYS_VISIBLE.includes(status) ||
      (grouped.get(status)?.length ?? 0) > 0,
  );

  return (
    <div className="flex gap-4 overflow-x-auto flex-1 pb-4">
      {visibleColumns.map((status) => (
        <KanbanColumn
          key={status}
          status={status}
          issues={grouped.get(status) ?? []}
          onSelectIssue={onSelectIssue}
        />
      ))}
    </div>
  );
}
