import { KanbanColumn } from "./KanbanColumn";
import { KANBAN_COLUMNS, type PlanIssue, type IssueStatus } from "@/lib/types";

export type KanbanSortOrder = "date" | "priority";

interface KanbanBoardProps {
  issues: PlanIssue[];
  onSelectIssue: (id: string) => void;
  sortOrder?: KanbanSortOrder;
}

/** Columns that are always shown, even when empty. */
const ALWAYS_VISIBLE: IssueStatus[] = ["open", "in_progress"];

export function KanbanBoard({ issues, onSelectIssue, sortOrder = "date" }: KanbanBoardProps) {
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

  // Sort each column
  for (const [status, bucket] of Array.from(grouped)) {
    bucket.sort((a, b) => {
      if (sortOrder === "priority") {
        // Primary: priority (P0 first)
        const priCompare = a.priority - b.priority;
        if (priCompare !== 0) return priCompare;

        // Tiebreaker: date (newest first)
        const dateA = a.created_at ?? a.updated_at ?? "";
        const dateB = b.created_at ?? b.updated_at ?? "";
        return dateB.localeCompare(dateA);
      }

      // Default: date sort (newest first), priority as tiebreaker
      let dateA: string | undefined;
      let dateB: string | undefined;

      if (status === "closed") {
        dateA = a.closed_at ?? a.updated_at;
        dateB = b.closed_at ?? b.updated_at;
      } else if (status === "open") {
        dateA = a.created_at;
        dateB = b.created_at;
      } else {
        // in_progress, blocked
        dateA = a.updated_at;
        dateB = b.updated_at;
      }

      // Newest first (descending)
      const dateCompare = (dateB ?? "").localeCompare(dateA ?? "");
      if (dateCompare !== 0) return dateCompare;

      // Tiebreaker: priority (P0 first)
      return a.priority - b.priority;
    });
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
          allIssues={issues}
          onSelectIssue={onSelectIssue}
        />
      ))}
    </div>
  );
}
