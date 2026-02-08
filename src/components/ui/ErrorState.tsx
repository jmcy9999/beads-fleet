"use client";

interface ErrorStateProps {
  message: string;
  detail?: string;
  onRetry?: () => void;
}

export function ErrorState({ message, detail, onRetry }: ErrorStateProps) {
  return (
    <div className="rounded-lg border border-status-blocked/30 bg-status-blocked/5 p-6">
      <div className="flex items-start gap-3">
        <span className="text-status-blocked text-xl" aria-hidden="true">
          !
        </span>
        <div className="flex-1">
          <h3 className="text-sm font-medium text-status-blocked">
            {message}
          </h3>
          {detail && (
            <p className="text-sm text-gray-400 mt-1">{detail}</p>
          )}
          {onRetry && (
            <button
              onClick={onRetry}
              className="mt-3 px-3 py-1.5 text-sm font-medium rounded-md bg-status-blocked/10 text-status-blocked hover:bg-status-blocked/20 transition-colors"
            >
              Retry
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
