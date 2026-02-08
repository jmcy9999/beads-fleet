function Bone({ className = "" }: { className?: string }) {
  return (
    <div className={`animate-pulse bg-surface-2 rounded ${className}`} />
  );
}

export function CardSkeleton() {
  return (
    <div className="card p-3 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Bone className="h-4 w-4 rounded-full" />
          <Bone className="h-3 w-16" />
        </div>
        <Bone className="h-4 w-10" />
      </div>
      <Bone className="h-4 w-full" />
      <Bone className="h-4 w-3/4" />
      <div className="flex items-center justify-between pt-1">
        <Bone className="h-5 w-16 rounded-full" />
        <Bone className="h-3 w-12" />
      </div>
    </div>
  );
}

export function RowSkeleton() {
  return (
    <tr>
      <td className="px-3 py-2">
        <Bone className="h-4 w-16" />
      </td>
      <td className="px-3 py-2">
        <Bone className="h-4 w-48" />
      </td>
      <td className="px-3 py-2">
        <Bone className="h-5 w-20 rounded-full" />
      </td>
      <td className="px-3 py-2">
        <Bone className="h-4 w-12" />
      </td>
      <td className="px-3 py-2">
        <Bone className="h-4 w-16" />
      </td>
      <td className="px-3 py-2">
        <Bone className="h-4 w-6" />
      </td>
    </tr>
  );
}

export function SummaryCardSkeleton() {
  return (
    <div className="card p-4 space-y-2">
      <Bone className="h-3 w-20" />
      <Bone className="h-8 w-16" />
      <Bone className="h-3 w-24" />
    </div>
  );
}
