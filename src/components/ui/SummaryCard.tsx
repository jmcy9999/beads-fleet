interface SummaryCardProps {
  label: string;
  value: number;
  color?: string;
  icon?: string;
  subtitle?: string;
}

export function SummaryCard({
  label,
  value,
  color,
  icon,
  subtitle,
}: SummaryCardProps) {
  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-medium uppercase tracking-wider text-gray-400">
          {label}
        </span>
        {icon && <span className="text-lg">{icon}</span>}
      </div>
      <div className={`text-3xl font-bold ${color ?? "text-white"}`}>
        {value}
      </div>
      {subtitle && (
        <p className="text-xs text-gray-400 mt-1">{subtitle}</p>
      )}
    </div>
  );
}
