interface EmptyStateProps {
  icon?: string;
  message: string;
  description?: string;
}

export function EmptyState({ icon, message, description }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      {icon && (
        <span className="text-4xl mb-3" role="img" aria-hidden="true">
          {icon}
        </span>
      )}
      <h3 className="text-lg font-medium text-gray-300 mb-1">{message}</h3>
      {description && (
        <p className="text-sm text-gray-500 max-w-md">{description}</p>
      )}
    </div>
  );
}
