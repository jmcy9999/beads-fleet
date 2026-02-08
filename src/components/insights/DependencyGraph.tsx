"use client";

import { useCallback, useMemo } from "react";
import ReactFlow, {
  Background,
  Controls,
  type Node,
  type Edge,
  Position,
  MarkerType,
} from "reactflow";
import "reactflow/dist/style.css";
import type { PlanIssue, IssueStatus } from "@/lib/types";

// ---------------------------------------------------------------------------
// Static colour map for the left-border of each node.
// We cannot use dynamic Tailwind classes here because ReactFlow renders
// outside the normal Tailwind purge scope; raw hex values are required.
// ---------------------------------------------------------------------------
const STATUS_BORDER_COLORS: Record<IssueStatus, string> = {
  open: "#22c55e",
  in_progress: "#f59e0b",
  blocked: "#ef4444",
  closed: "#6b7280",
  deferred: "#8b5cf6",
  pinned: "#3b82f6",
};

// ---------------------------------------------------------------------------
// Custom ReactFlow node
// ---------------------------------------------------------------------------
function IssueNode({ data }: { data: { issue: PlanIssue } }) {
  const borderColor = STATUS_BORDER_COLORS[data.issue.status] ?? "#6b7280";
  const title =
    data.issue.title.length > 30
      ? data.issue.title.slice(0, 30) + "..."
      : data.issue.title;

  return (
    <div
      className="px-3 py-2 rounded border-l-4 bg-surface-1 border border-border-default min-w-[180px] max-w-[220px] cursor-pointer"
      style={{ borderLeftColor: borderColor }}
    >
      <div className="text-xs font-mono text-gray-400">{data.issue.id}</div>
      <div className="text-sm text-gray-100 truncate" title={data.issue.title}>
        {title}
      </div>
    </div>
  );
}

const nodeTypes = { issue: IssueNode };

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

/** Build a set of issue IDs that participate in at least one cycle. */
function detectCycleIds(issues: PlanIssue[]): Set<string> {
  const issueMap = new Map(issues.map((i) => [i.id, i]));
  const cycleIds = new Set<string>();

  // Simple DFS-based cycle detection
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const parent = new Map<string, string | null>();

  for (const id of Array.from(issueMap.keys())) {
    color.set(id, WHITE);
  }

  function dfs(u: string) {
    color.set(u, GRAY);
    const issue = issueMap.get(u);
    if (issue) {
      for (const dep of issue.blocked_by) {
        if (!issueMap.has(dep)) continue; // edge to an issue we don't have
        const depColor = color.get(dep);
        if (depColor === GRAY) {
          // Back-edge found -- trace cycle
          cycleIds.add(dep);
          let cur = u;
          while (cur !== dep) {
            cycleIds.add(cur);
            cur = parent.get(cur) ?? dep;
          }
        } else if (depColor === WHITE) {
          parent.set(dep, u);
          dfs(dep);
        }
      }
    }
    color.set(u, BLACK);
  }

  for (const id of Array.from(issueMap.keys())) {
    if (color.get(id) === WHITE) dfs(id);
  }

  return cycleIds;
}

/**
 * Assign each issue to a "depth" layer.
 * Layer 0 = issues with no blockers.  Layer N = blocked only by layer < N.
 * Falls back gracefully for cycles (caps iterations at issue count).
 */
function computeDepths(issues: PlanIssue[]): Map<string, number> {
  const depths = new Map<string, number>();
  const issueIds = new Set(issues.map((i) => i.id));
  const remaining = new Map(issues.map((i) => [i.id, i]));

  let currentDepth = 0;
  const maxIter = issues.length;

  while (remaining.size > 0 && currentDepth <= maxIter) {
    const layer: string[] = [];
    for (const [id, issue] of Array.from(remaining)) {
      // An issue goes into this layer if all its blockers are already assigned
      // OR the blocker is not in our dataset at all.
      const unresolved = issue.blocked_by.filter(
        (b) => issueIds.has(b) && !depths.has(b),
      );
      if (unresolved.length === 0) {
        layer.push(id);
      }
    }

    // If no progress (cycle), dump everything remaining into the next layer.
    if (layer.length === 0) {
      for (const id of Array.from(remaining.keys())) {
        depths.set(id, currentDepth);
      }
      break;
    }

    for (const id of layer) {
      depths.set(id, currentDepth);
      remaining.delete(id);
    }
    currentDepth++;
  }

  return depths;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------
interface DependencyGraphProps {
  issues: PlanIssue[];
  onSelectIssue?: (id: string) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export function DependencyGraph({ issues, onSelectIssue }: DependencyGraphProps) {
  const cycleIds = useMemo(() => detectCycleIds(issues), [issues]);

  const { nodes, edges } = useMemo(() => {
    const depths = computeDepths(issues);
    const issueIds = new Set(issues.map((i) => i.id));

    // Group by layer for vertical spacing
    const layers = new Map<number, PlanIssue[]>();
    for (const issue of issues) {
      const d = depths.get(issue.id) ?? 0;
      if (!layers.has(d)) layers.set(d, []);
      layers.get(d)!.push(issue);
    }

    const rfNodes: Node[] = [];
    for (const [layerIndex, layerIssues] of Array.from(layers)) {
      layerIssues.forEach((issue, indexInLayer) => {
        rfNodes.push({
          id: issue.id,
          type: "issue",
          position: { x: layerIndex * 280, y: indexInLayer * 110 },
          data: { issue },
          sourcePosition: Position.Right,
          targetPosition: Position.Left,
        });
      });
    }

    const rfEdges: Edge[] = [];
    for (const issue of issues) {
      for (const blockerId of issue.blocked_by) {
        // Only create edge if the blocker exists in our dataset
        if (!issueIds.has(blockerId)) continue;

        const isCycleEdge =
          cycleIds.has(issue.id) && cycleIds.has(blockerId);
        const isClosed = issue.status === "closed";

        rfEdges.push({
          id: `${blockerId}->${issue.id}`,
          source: blockerId,
          target: issue.id,
          animated: !isClosed,
          style: {
            stroke: isCycleEdge ? "#ef4444" : "#4b5563",
            strokeDasharray: isClosed ? "5 5" : undefined,
          },
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: isCycleEdge ? "#ef4444" : "#4b5563",
          },
        });
      }
    }

    return { nodes: rfNodes, edges: rfEdges };
  }, [issues, cycleIds]);

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      onSelectIssue?.(node.id);
    },
    [onSelectIssue],
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodeClick={onNodeClick}
      fitView
      minZoom={0.2}
      maxZoom={2}
      proOptions={{ hideAttribution: true }}
    >
      <Background color="#353845" gap={20} />
      <Controls
        className="!bg-surface-2 !border-border-default !rounded-lg [&>button]:!bg-surface-2 [&>button]:!border-border-default [&>button]:!fill-gray-400 [&>button:hover]:!bg-surface-3"
      />
    </ReactFlow>
  );
}
