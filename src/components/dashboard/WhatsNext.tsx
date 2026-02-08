interface WhatsNextProps {
  impact: {
    issue_id: string;
    title: string;
    impact_score: number;
    unblocks_count?: number;
  };
}

export function WhatsNext({ impact }: WhatsNextProps) {
  return (
    <div className="relative rounded-lg border border-green-500/20 bg-surface-1 overflow-hidden">
      <div className="absolute inset-y-0 left-0 w-1 bg-gradient-to-b from-green-400 to-blue-500" />
      <div className="p-5 pl-6">
        <h2 className="text-xs font-medium uppercase tracking-wider text-gray-400 mb-3">
          What&apos;s Next
        </h2>
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className="font-mono text-xs text-gray-400">
                {impact.issue_id}
              </span>
            </div>
            <h3 className="text-sm font-medium text-white truncate">
              {impact.title}
            </h3>
          </div>
          <div className="flex items-center gap-4 shrink-0">
            <div className="text-right">
              <div className="text-xs text-gray-400">Impact</div>
              <div className="text-lg font-bold text-green-400">
                {impact.impact_score.toFixed(1)}
              </div>
            </div>
            {impact.unblocks_count != null && impact.unblocks_count > 0 && (
              <div className="text-right">
                <div className="text-xs text-gray-400">Unblocks</div>
                <div className="text-lg font-bold text-blue-400">
                  {impact.unblocks_count} task{impact.unblocks_count !== 1 ? "s" : ""}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
