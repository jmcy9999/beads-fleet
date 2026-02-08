"use client";

interface GraphDensityBadgeProps {
  density: number;
}

export function GraphDensityBadge({ density }: GraphDensityBadgeProps) {
  let colorClasses: string;
  if (density < 0.05) {
    colorClasses = "bg-green-500/10 text-green-400 border-green-500/20";
  } else if (density <= 0.15) {
    colorClasses = "bg-amber-500/10 text-amber-400 border-amber-500/20";
  } else {
    colorClasses = "bg-red-500/10 text-red-400 border-red-500/20";
  }

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${colorClasses}`}
    >
      <span className="text-gray-400">Density</span>
      {density.toFixed(3)}
    </span>
  );
}
