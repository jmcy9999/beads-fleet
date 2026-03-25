"use client";

import { useState, useCallback } from "react";
import { useFeatureApproval, type FeatureDecision, type FeatureApprovalState } from "@/hooks/useFeatureApproval";

interface FeatureApprovalPanelProps {
  epicId: string;
  onApproveAll: () => void;
  onClose: () => void;
}

const STATUS_STYLES: Record<FeatureDecision["status"], { bg: string; text: string; label: string }> = {
  pending: { bg: "bg-gray-500/20", text: "text-gray-300", label: "Pending" },
  approved: { bg: "bg-green-500/20", text: "text-green-300", label: "Approved" },
  rejected: { bg: "bg-red-500/20", text: "text-red-300", label: "Rejected" },
  deferred: { bg: "bg-amber-500/20", text: "text-amber-300", label: "Deferred" },
};

export function FeatureApprovalPanel({ epicId, onApproveAll, onClose }: FeatureApprovalPanelProps) {
  const { query, mutation } = useFeatureApproval(epicId);
  const [localFeatures, setLocalFeatures] = useState<FeatureDecision[] | null>(null);

  // Use local state if user has made changes, otherwise use server state
  const features = localFeatures ?? query.data?.features ?? [];
  const hasChanges = localFeatures !== null;

  const updateFeature = useCallback(
    (featureId: string, status: FeatureDecision["status"]) => {
      const current = localFeatures ?? query.data?.features ?? [];
      setLocalFeatures(current.map((f) => (f.id === featureId ? { ...f, status } : f)));
    },
    [localFeatures, query.data?.features],
  );

  const setAllStatus = useCallback(
    (status: FeatureDecision["status"]) => {
      const current = localFeatures ?? query.data?.features ?? [];
      setLocalFeatures(current.map((f) => ({ ...f, status })));
    },
    [localFeatures, query.data?.features],
  );

  const handleSave = useCallback(async () => {
    if (!localFeatures) return;
    const state: FeatureApprovalState = {
      epicId,
      features: localFeatures,
      updatedAt: new Date().toISOString(),
    };
    mutation.mutate(state);
  }, [epicId, localFeatures, mutation]);

  const handleApproveAndBuild = useCallback(() => {
    // Save current state first, then trigger the approve-and-build action
    const feats = localFeatures ?? query.data?.features ?? [];
    const state: FeatureApprovalState = {
      epicId,
      features: feats,
      updatedAt: new Date().toISOString(),
    };
    mutation.mutate(state, {
      onSuccess: () => onApproveAll(),
    });
  }, [epicId, localFeatures, query.data?.features, mutation, onApproveAll]);

  const approvedCount = features.filter((f) => f.status === "approved").length;
  const rejectedCount = features.filter((f) => f.status === "rejected").length;
  const deferredCount = features.filter((f) => f.status === "deferred").length;
  const pendingCount = features.filter((f) => f.status === "pending").length;

  if (query.isLoading) {
    return (
      <div className="p-4 text-center text-gray-400 text-xs">
        Loading features...
      </div>
    );
  }

  if (query.isError) {
    return (
      <div className="p-4 text-center text-red-400 text-xs">
        Failed to load features: {query.error?.message}
      </div>
    );
  }

  if (!features.length) {
    return (
      <div className="p-4 text-center text-gray-400 text-xs">
        No features found in plan. You can still approve the plan directly.
        <div className="mt-3 flex gap-2 justify-center">
          <button onClick={onApproveAll} className="px-3 py-1 text-xs rounded bg-green-500/20 text-green-300 hover:bg-green-500/30 border border-green-500/30">
            Approve & Build
          </button>
          <button onClick={onClose} className="px-3 py-1 text-xs rounded bg-gray-500/20 text-gray-300 hover:bg-gray-500/30 border border-gray-500/30">
            Close
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-2 space-y-2" onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}>
      {/* Header with summary */}
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-medium text-gray-300">
          Feature Review ({features.length} items)
        </span>
        <div className="flex gap-1.5 text-[9px]">
          {approvedCount > 0 && <span className="text-green-400">{approvedCount} approved</span>}
          {rejectedCount > 0 && <span className="text-red-400">{rejectedCount} rejected</span>}
          {deferredCount > 0 && <span className="text-amber-400">{deferredCount} deferred</span>}
          {pendingCount > 0 && <span className="text-gray-400">{pendingCount} pending</span>}
        </div>
      </div>

      {/* Bulk actions */}
      <div className="flex gap-1">
        <button
          onClick={() => setAllStatus("approved")}
          className="px-2 py-0.5 text-[9px] rounded bg-green-500/10 text-green-400 hover:bg-green-500/20 border border-green-500/20"
        >
          Approve All
        </button>
        <button
          onClick={() => setAllStatus("rejected")}
          className="px-2 py-0.5 text-[9px] rounded bg-red-500/10 text-red-400 hover:bg-red-500/20 border border-red-500/20"
        >
          Reject All
        </button>
        <button
          onClick={() => setAllStatus("pending")}
          className="px-2 py-0.5 text-[9px] rounded bg-gray-500/10 text-gray-400 hover:bg-gray-500/20 border border-gray-500/20"
        >
          Reset
        </button>
      </div>

      {/* Feature list */}
      <div className="max-h-64 overflow-y-auto space-y-1 pr-1 scrollbar-thin">
        {features.map((feature) => {
          const style = STATUS_STYLES[feature.status];
          return (
            <div
              key={feature.id}
              className={`flex items-start gap-2 p-1.5 rounded ${style.bg} border border-transparent`}
            >
              <div className="flex-1 min-w-0">
                <p className={`text-[11px] font-medium ${style.text} leading-tight`}>
                  {feature.name}
                </p>
                {feature.description && (
                  <p className="text-[9px] text-gray-500 mt-0.5 line-clamp-1">
                    {feature.description}
                  </p>
                )}
              </div>
              <div className="flex gap-0.5 shrink-0">
                <button
                  onClick={() => updateFeature(feature.id, "approved")}
                  className={`w-5 h-5 rounded text-[10px] flex items-center justify-center transition-colors ${
                    feature.status === "approved"
                      ? "bg-green-500/40 text-green-200"
                      : "bg-gray-700/50 text-gray-500 hover:text-green-400 hover:bg-green-500/20"
                  }`}
                  title="Approve"
                >
                  ✓
                </button>
                <button
                  onClick={() => updateFeature(feature.id, "rejected")}
                  className={`w-5 h-5 rounded text-[10px] flex items-center justify-center transition-colors ${
                    feature.status === "rejected"
                      ? "bg-red-500/40 text-red-200"
                      : "bg-gray-700/50 text-gray-500 hover:text-red-400 hover:bg-red-500/20"
                  }`}
                  title="Reject"
                >
                  ✕
                </button>
                <button
                  onClick={() => updateFeature(feature.id, "deferred")}
                  className={`w-5 h-5 rounded text-[10px] flex items-center justify-center transition-colors ${
                    feature.status === "deferred"
                      ? "bg-amber-500/40 text-amber-200"
                      : "bg-gray-700/50 text-gray-500 hover:text-amber-400 hover:bg-amber-500/20"
                  }`}
                  title="Defer"
                >
                  ⏸
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Action buttons */}
      <div className="flex gap-1.5 pt-1 border-t border-gray-700/50">
        {hasChanges && (
          <button
            onClick={handleSave}
            disabled={mutation.isPending}
            className="flex-1 px-2 py-1 text-[10px] font-medium rounded bg-blue-500/20 text-blue-300 hover:bg-blue-500/30 border border-blue-500/30 disabled:opacity-50"
          >
            {mutation.isPending ? "Saving..." : "Save Decisions"}
          </button>
        )}
        <button
          onClick={handleApproveAndBuild}
          disabled={mutation.isPending || pendingCount === features.length}
          className="flex-1 px-2 py-1 text-[10px] font-medium rounded bg-green-500/20 text-green-300 hover:bg-green-500/30 border border-green-500/30 disabled:opacity-50"
          title={pendingCount === features.length ? "Review features before building" : undefined}
        >
          {mutation.isPending ? "Saving..." : `Build (${approvedCount} features)`}
        </button>
        <button
          onClick={onClose}
          className="px-2 py-1 text-[10px] rounded bg-gray-500/20 text-gray-400 hover:bg-gray-500/30 border border-gray-500/30"
        >
          Close
        </button>
      </div>
    </div>
  );
}
