"use client";

import { useState, useMemo, useCallback } from "react";
import type { VenturePlan as VenturePlanType, VentureActual, VenturePlanStream } from "@/lib/venture-plan-types";
import type { PlanIssue } from "@/lib/types";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface VenturePlanProps {
  plan: VenturePlanType;
  onUpdate: (plan: VenturePlanType) => void;
  isUpdating: boolean;
  epicChildren: PlanIssue[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getMonthLabel(startDate: string, monthOffset: number): string {
  const d = new Date(startDate);
  d.setMonth(d.getMonth() + monthOffset);
  return d.toLocaleDateString(undefined, { month: "short", year: "2-digit" });
}

function getMonthDate(startDate: string, monthOffset: number): Date {
  const d = new Date(startDate);
  d.setMonth(d.getMonth() + monthOffset);
  return d;
}

function getCurrentMonth(startDate: string): number {
  const start = new Date(startDate);
  const now = new Date();
  const months = (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth());
  return Math.max(0, Math.min(5, months));
}

function formatCurrency(amount: number, currency: string): string {
  const sym = currency === "GBP" ? "\u00a3" : currency === "USD" ? "$" : currency === "EUR" ? "\u20ac" : "";
  return `${sym}${amount.toLocaleString()}`;
}

// ---------------------------------------------------------------------------
// A. Revenue Chart (pure SVG)
// ---------------------------------------------------------------------------

const CHART_W = 720;
const CHART_H = 300;
const CHART_PAD = { top: 20, right: 20, bottom: 40, left: 50 };
const PLOT_W = CHART_W - CHART_PAD.left - CHART_PAD.right;
const PLOT_H = CHART_H - CHART_PAD.top - CHART_PAD.bottom;

function RevenueChart({ plan }: { plan: VenturePlanType }) {
  const [hoveredPoint, setHoveredPoint] = useState<{ stream: string; month: number; revenue: number; x: number; y: number } | null>(null);

  const maxRevenue = plan.targetMonthly;

  const xScale = (month: number) => CHART_PAD.left + ((month - 1) / 5) * PLOT_W;
  const yScale = (value: number) => CHART_PAD.top + PLOT_H - (value / maxRevenue) * PLOT_H;

  // Stacked area: cumulative projected totals
  const cumulativeByMonth = useMemo(() => {
    return [1, 2, 3, 4, 5, 6].map((m) => {
      const total = plan.streams.reduce((sum, s) => {
        const ms = s.milestones.find((ms) => ms.month === m);
        return sum + (ms?.revenue ?? 0);
      }, 0);
      return { month: m, total };
    });
  }, [plan.streams]);

  // Stacked area path
  const areaPath = useMemo(() => {
    const points = cumulativeByMonth.map((p) => `${xScale(p.month)},${yScale(p.total)}`);
    const bottomRight = `${xScale(6)},${yScale(0)}`;
    const bottomLeft = `${xScale(1)},${yScale(0)}`;
    return `M${points.join(" L")} L${bottomRight} L${bottomLeft} Z`;
  }, [cumulativeByMonth]);

  // Actual revenue dots grouped by stream
  const actualsByStream = useMemo(() => {
    const map = new Map<string, VentureActual[]>();
    for (const a of plan.actuals) {
      if (!map.has(a.stream)) map.set(a.stream, []);
      map.get(a.stream)!.push(a);
    }
    return map;
  }, [plan.actuals]);

  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} className="w-full max-w-3xl" style={{ minWidth: 400 }}>
        {/* Y-axis grid lines */}
        {[0, 0.25, 0.5, 0.75, 1].map((frac) => {
          const val = frac * maxRevenue;
          const y = yScale(val);
          return (
            <g key={frac}>
              <line x1={CHART_PAD.left} y1={y} x2={CHART_W - CHART_PAD.right} y2={y} stroke="#353845" strokeWidth={1} />
              <text x={CHART_PAD.left - 8} y={y + 4} textAnchor="end" className="fill-gray-500" fontSize={10}>
                {formatCurrency(val, plan.currency)}
              </text>
            </g>
          );
        })}

        {/* Stacked area */}
        <path d={areaPath} fill="url(#areaGradient)" opacity={0.15} />
        <defs>
          <linearGradient id="areaGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#3b82f6" />
            <stop offset="100%" stopColor="#3b82f6" stopOpacity={0} />
          </linearGradient>
        </defs>

        {/* Dashed target line */}
        <line
          x1={CHART_PAD.left}
          y1={yScale(maxRevenue)}
          x2={CHART_W - CHART_PAD.right}
          y2={yScale(maxRevenue)}
          stroke="#ef4444"
          strokeWidth={1.5}
          strokeDasharray="6 4"
          opacity={0.7}
        />
        <text
          x={CHART_W - CHART_PAD.right + 4}
          y={yScale(maxRevenue) + 4}
          className="fill-red-400"
          fontSize={9}
          textAnchor="start"
        >
          Target
        </text>

        {/* Stream lines */}
        {plan.streams.map((stream) => {
          const points = stream.milestones.map((m) => ({
            x: xScale(m.month),
            y: yScale(m.revenue),
            month: m.month,
            revenue: m.revenue,
          }));
          const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");

          return (
            <g key={stream.id}>
              <path d={linePath} fill="none" stroke={stream.color} strokeWidth={2} opacity={0.8} />
              {points.map((p) => (
                <circle
                  key={p.month}
                  cx={p.x}
                  cy={p.y}
                  r={4}
                  fill={stream.color}
                  stroke="#1a1b26"
                  strokeWidth={2}
                  className="cursor-pointer"
                  onMouseEnter={() => setHoveredPoint({ stream: stream.name, month: p.month, revenue: p.revenue, x: p.x, y: p.y })}
                  onMouseLeave={() => setHoveredPoint(null)}
                />
              ))}
            </g>
          );
        })}

        {/* Actual revenue dots */}
        {plan.streams.map((stream) => {
          const actuals = actualsByStream.get(stream.id) || [];
          return actuals.map((a, i) => {
            const aDate = new Date(a.date);
            const start = new Date(plan.startDate);
            const monthFrac = (aDate.getFullYear() - start.getFullYear()) * 12 + (aDate.getMonth() - start.getMonth()) + (aDate.getDate() / 30);
            const x = CHART_PAD.left + ((monthFrac) / 5) * PLOT_W;
            const y = yScale(a.amount);
            return (
              <g key={`${stream.id}-actual-${i}`}>
                <circle cx={x} cy={y} r={5} fill={stream.color} opacity={0.9} />
                <circle cx={x} cy={y} r={5} fill="none" stroke="white" strokeWidth={1.5} opacity={0.6} />
              </g>
            );
          });
        })}

        {/* X-axis month labels */}
        {[1, 2, 3, 4, 5, 6].map((m) => (
          <text
            key={m}
            x={xScale(m)}
            y={CHART_H - 8}
            textAnchor="middle"
            className="fill-gray-400"
            fontSize={11}
          >
            {getMonthLabel(plan.startDate, m - 1)}
          </text>
        ))}

        {/* Tooltip */}
        {hoveredPoint && (
          <g>
            <rect
              x={hoveredPoint.x - 60}
              y={hoveredPoint.y - 36}
              width={120}
              height={28}
              rx={4}
              fill="#1e1f2e"
              stroke="#353845"
            />
            <text
              x={hoveredPoint.x}
              y={hoveredPoint.y - 18}
              textAnchor="middle"
              className="fill-gray-200"
              fontSize={10}
            >
              {hoveredPoint.stream}: {formatCurrency(hoveredPoint.revenue, plan.currency)}/mo
            </text>
          </g>
        )}
      </svg>

      {/* Legend */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 ml-12">
        {plan.streams.map((s) => (
          <div key={s.id} className="flex items-center gap-1.5 text-xs text-gray-400">
            <div className="w-3 h-0.5 rounded" style={{ backgroundColor: s.color }} />
            {s.name}
          </div>
        ))}
        <div className="flex items-center gap-1.5 text-xs text-red-400">
          <div className="w-3 h-0.5 rounded border-t border-dashed border-red-400" />
          Target
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// B. Monthly Milestones Grid
// ---------------------------------------------------------------------------

function MilestonesGrid({ plan }: { plan: VenturePlanType }) {
  const currentMonth = getCurrentMonth(plan.startDate);

  // Sum actual revenue per stream per month
  const actualByStreamMonth = useMemo(() => {
    const map = new Map<string, number>();
    for (const a of plan.actuals) {
      const aDate = new Date(a.date);
      const start = new Date(plan.startDate);
      const month = (aDate.getFullYear() - start.getFullYear()) * 12 + (aDate.getMonth() - start.getMonth());
      const key = `${a.stream}-${month}`;
      map.set(key, (map.get(key) || 0) + a.amount);
    }
    return map;
  }, [plan.actuals, plan.startDate]);

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs border-collapse" style={{ minWidth: 600 }}>
        <thead>
          <tr>
            <th className="text-left text-gray-500 font-medium uppercase tracking-wider py-1.5 px-2 border-b border-border-default w-28">
              Stream
            </th>
            {[0, 1, 2, 3, 4, 5].map((m) => (
              <th
                key={m}
                className={`text-center font-medium uppercase tracking-wider py-1.5 px-2 border-b ${
                  m === currentMonth
                    ? "text-blue-400 border-blue-500/50 bg-blue-500/5"
                    : "text-gray-500 border-border-default"
                }`}
              >
                M{m + 1}
                <span className="block text-[9px] font-normal normal-case tracking-normal">
                  {getMonthLabel(plan.startDate, m)}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {plan.streams.map((stream) => (
            <tr key={stream.id}>
              <td className="py-2 px-2 border-b border-border-default">
                <div className="flex items-center gap-1.5">
                  <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: stream.color }} />
                  <span className="text-gray-300 font-medium truncate">{stream.name}</span>
                </div>
              </td>
              {stream.milestones.map((ms) => {
                const mIdx = ms.month - 1;
                const isPast = mIdx < currentMonth;
                const isCurrent = mIdx === currentMonth;
                const actualKey = `${stream.id}-${mIdx}`;
                const actual = actualByStreamMonth.get(actualKey) || 0;
                const met = isPast && actual >= ms.revenue && ms.revenue > 0;

                return (
                  <td
                    key={ms.month}
                    className={`py-2 px-2 border-b text-center align-top ${
                      isCurrent
                        ? "border-blue-500/50 bg-blue-500/5"
                        : "border-border-default"
                    }`}
                  >
                    <p className="text-gray-400 leading-tight mb-1">{ms.target}</p>
                    <p className="text-gray-300 font-mono font-medium">
                      {formatCurrency(ms.revenue, plan.currency)}
                    </p>
                    {isPast && ms.revenue > 0 && (
                      <span className={`inline-block mt-0.5 text-[10px] ${met ? "text-green-400" : "text-red-400"}`}>
                        {met ? "\u2713" : "\u2717"} {formatCurrency(actual, plan.currency)}
                      </span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
          {/* Total row */}
          <tr>
            <td className="py-2 px-2 font-medium text-gray-300">Total</td>
            {[0, 1, 2, 3, 4, 5].map((m) => {
              const total = plan.streams.reduce((s, st) => {
                const ms = st.milestones.find((ms) => ms.month === m + 1);
                return s + (ms?.revenue ?? 0);
              }, 0);
              const isCurrent = m === currentMonth;
              return (
                <td
                  key={m}
                  className={`py-2 px-2 text-center font-mono font-medium ${
                    isCurrent
                      ? "text-blue-300 bg-blue-500/5"
                      : "text-gray-200"
                  }`}
                >
                  {formatCurrency(total, plan.currency)}
                </td>
              );
            })}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// C. Daily Bead Progress (heatmap per stream)
// ---------------------------------------------------------------------------

function BeadProgress({ plan, epicChildren }: { plan: VenturePlanType; epicChildren: PlanIssue[] }) {
  // Group children by stream label
  const byStream = useMemo(() => {
    const map = new Map<string, PlanIssue[]>();
    for (const stream of plan.streams) {
      map.set(stream.id, []);
    }
    // Also track "untagged"
    map.set("_untagged", []);

    for (const child of epicChildren) {
      const streamLabel = child.labels?.find((l) => l.startsWith("stream:"));
      if (streamLabel) {
        const streamId = streamLabel.replace("stream:", "");
        if (map.has(streamId)) {
          map.get(streamId)!.push(child);
        } else {
          map.get("_untagged")!.push(child);
        }
      } else {
        map.get("_untagged")!.push(child);
      }
    }
    return map;
  }, [plan.streams, epicChildren]);

  // Generate day grid for last 30 days
  const days = useMemo(() => {
    const result: string[] = [];
    const now = new Date();
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      result.push(d.toISOString().slice(0, 10));
    }
    return result;
  }, []);

  // Count closures per stream per day
  const closureMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const child of epicChildren) {
      if (child.status !== "closed" || !child.closed_at) continue;
      const day = child.closed_at.slice(0, 10);
      const streamLabel = child.labels?.find((l) => l.startsWith("stream:"));
      const streamId = streamLabel ? streamLabel.replace("stream:", "") : "_untagged";
      const key = `${streamId}:${day}`;
      map.set(key, (map.get(key) || 0) + 1);
    }
    return map;
  }, [epicChildren]);

  const maxPerDay = useMemo(() => {
    let max = 0;
    closureMap.forEach((v) => { if (v > max) max = v; });
    return Math.max(max, 1);
  }, [closureMap]);

  const allStreams: { id: string; name: string; color: string }[] = [
    ...plan.streams,
    { id: "_untagged", name: "Untagged", color: "#6b7280" },
  ];

  // Filter to streams that have at least one child issue
  const activeStreams = allStreams.filter((s) => (byStream.get(s.id)?.length ?? 0) > 0);

  if (epicChildren.length === 0) {
    return (
      <p className="text-sm text-gray-500 italic">No child issues yet. Create beads with <code className="text-amber-300">stream:&lt;id&gt;</code> labels to track progress.</p>
    );
  }

  return (
    <div className="space-y-3">
      {activeStreams.map((stream) => {
        const children = byStream.get(stream.id) || [];
        const closed = children.filter((c) => c.status === "closed").length;
        return (
          <div key={stream.id}>
            <div className="flex items-center gap-2 mb-1">
              <div className="w-2 h-2 rounded-full" style={{ backgroundColor: stream.color }} />
              <span className="text-xs text-gray-300 font-medium">{stream.name}</span>
              <span className="text-[10px] text-gray-500">{closed}/{children.length} done</span>
            </div>
            <div className="flex gap-0.5">
              {days.map((day) => {
                const count = closureMap.get(`${stream.id}:${day}`) || 0;
                const intensity = count / maxPerDay;
                const dayLabel = new Date(day).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
                return (
                  <div
                    key={day}
                    className="w-3 h-3 rounded-sm border border-border-default"
                    style={{
                      backgroundColor: count > 0
                        ? `color-mix(in srgb, ${stream.color} ${Math.round(30 + intensity * 70)}%, transparent)`
                        : "rgba(255,255,255,0.03)",
                    }}
                    title={`${dayLabel}: ${count} closed`}
                  />
                );
              })}
            </div>
          </div>
        );
      })}
      <div className="flex items-center gap-2 text-[10px] text-gray-600">
        <span>30 days</span>
        <div className="flex gap-0.5 items-center">
          <span>Less</span>
          {[0, 0.25, 0.5, 0.75, 1].map((v) => (
            <div
              key={v}
              className="w-3 h-3 rounded-sm border border-border-default"
              style={{
                backgroundColor: v === 0 ? "rgba(255,255,255,0.03)" : `color-mix(in srgb, #3b82f6 ${Math.round(30 + v * 70)}%, transparent)`,
              }}
            />
          ))}
          <span>More</span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// D. Inline Revenue Edit
// ---------------------------------------------------------------------------

function ActualsEditor({
  plan,
  onUpdate,
  isUpdating,
}: {
  plan: VenturePlanType;
  onUpdate: (plan: VenturePlanType) => void;
  isUpdating: boolean;
}) {
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [newEntry, setNewEntry] = useState<VentureActual>({
    date: new Date().toISOString().slice(0, 10),
    stream: plan.streams[0]?.id || "",
    amount: 0,
    note: "",
  });

  const handleEdit = useCallback(
    (idx: number, field: keyof VentureActual, value: string | number) => {
      const updated = { ...plan, actuals: [...plan.actuals] };
      updated.actuals[idx] = { ...updated.actuals[idx], [field]: value };
      onUpdate(updated);
      setEditingIdx(null);
    },
    [plan, onUpdate],
  );

  const handleAdd = useCallback(() => {
    if (!newEntry.stream || newEntry.amount <= 0) return;
    const updated = {
      ...plan,
      actuals: [
        ...plan.actuals,
        { ...newEntry, note: newEntry.note || undefined },
      ],
    };
    onUpdate(updated);
    setShowAdd(false);
    setNewEntry({
      date: new Date().toISOString().slice(0, 10),
      stream: plan.streams[0]?.id || "",
      amount: 0,
      note: "",
    });
  }, [plan, newEntry, onUpdate]);

  const handleDelete = useCallback(
    (idx: number) => {
      const updated = { ...plan, actuals: plan.actuals.filter((_, i) => i !== idx) };
      onUpdate(updated);
    },
    [plan, onUpdate],
  );

  const streamMap = useMemo(() => {
    const m = new Map<string, VenturePlanStream>();
    plan.streams.forEach((s) => m.set(s.id, s));
    return m;
  }, [plan.streams]);

  return (
    <div className="space-y-2">
      {plan.actuals.length > 0 && (
        <div className="space-y-1">
          {plan.actuals.map((a, idx) => {
            const stream = streamMap.get(a.stream);
            return (
              <div key={idx} className="flex items-center gap-2 text-xs py-1 px-2 rounded hover:bg-surface-1 group">
                <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: stream?.color || "#6b7280" }} />
                <span className="text-gray-500 font-mono">{a.date}</span>
                <span className="text-gray-400">{stream?.name || a.stream}</span>
                {editingIdx === idx ? (
                  <input
                    type="number"
                    defaultValue={a.amount}
                    className="w-20 rounded border border-border-default bg-surface-2 px-1.5 py-0.5 text-xs text-gray-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    onBlur={(e) => handleEdit(idx, "amount", Number(e.target.value))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleEdit(idx, "amount", Number((e.target as HTMLInputElement).value));
                      if (e.key === "Escape") setEditingIdx(null);
                    }}
                    autoFocus
                  />
                ) : (
                  <button
                    onClick={() => setEditingIdx(idx)}
                    className="text-gray-200 font-mono font-medium hover:text-blue-400 transition-colors"
                  >
                    {formatCurrency(a.amount, plan.currency)}
                  </button>
                )}
                {a.note && <span className="text-gray-500 truncate flex-1 italic">{a.note}</span>}
                <button
                  onClick={() => handleDelete(idx)}
                  className="text-gray-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all text-xs"
                  title="Remove"
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      )}

      {showAdd ? (
        <div className="flex flex-wrap gap-2 items-end p-2 bg-surface-1 rounded-md border border-border-default">
          <div>
            <label className="block text-[10px] text-gray-500 mb-0.5">Date</label>
            <input
              type="date"
              value={newEntry.date}
              onChange={(e) => setNewEntry({ ...newEntry, date: e.target.value })}
              className="rounded border border-border-default bg-surface-2 px-2 py-1 text-xs text-gray-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-[10px] text-gray-500 mb-0.5">Stream</label>
            <select
              value={newEntry.stream}
              onChange={(e) => setNewEntry({ ...newEntry, stream: e.target.value })}
              className="rounded border border-border-default bg-surface-2 px-2 py-1 text-xs text-gray-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              {plan.streams.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[10px] text-gray-500 mb-0.5">Amount ({plan.currency})</label>
            <input
              type="number"
              value={newEntry.amount || ""}
              onChange={(e) => setNewEntry({ ...newEntry, amount: Number(e.target.value) })}
              placeholder="0"
              className="w-24 rounded border border-border-default bg-surface-2 px-2 py-1 text-xs text-gray-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <div className="flex-1 min-w-[100px]">
            <label className="block text-[10px] text-gray-500 mb-0.5">Note (optional)</label>
            <input
              type="text"
              value={newEntry.note || ""}
              onChange={(e) => setNewEntry({ ...newEntry, note: e.target.value })}
              placeholder="First sale..."
              className="w-full rounded border border-border-default bg-surface-2 px-2 py-1 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <div className="flex gap-1.5">
            <button
              onClick={handleAdd}
              disabled={isUpdating || newEntry.amount <= 0}
              className="rounded bg-green-600 px-3 py-1 text-xs font-medium text-white hover:bg-green-500 disabled:opacity-50 transition-colors"
            >
              {isUpdating ? "Saving..." : "Add"}
            </button>
            <button
              onClick={() => setShowAdd(false)}
              className="rounded bg-surface-2 px-3 py-1 text-xs text-gray-400 hover:text-gray-200 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setShowAdd(true)}
          className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
          Add revenue entry
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export function VenturePlan({ plan, onUpdate, isUpdating, epicChildren }: VenturePlanProps) {
  return (
    <section className="card p-5 space-y-6">
      <details open>
        <summary className="text-xs font-medium uppercase tracking-wider text-emerald-400 mb-3 cursor-pointer select-none list-none flex items-center gap-1.5 [&::-webkit-details-marker]:hidden">
          <svg className="w-3 h-3 transition-transform [[open]>summary>&]:rotate-90" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
          Venture Plan
        </summary>

        <div className="space-y-6">
          {/* Revenue Chart */}
          <div>
            <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
              Revenue Projections
            </h3>
            <RevenueChart plan={plan} />
          </div>

          {/* Milestones Grid */}
          <div>
            <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
              Monthly Milestones
            </h3>
            <MilestonesGrid plan={plan} />
          </div>

          {/* Bead Progress */}
          <div>
            <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
              Daily Bead Progress
            </h3>
            <BeadProgress plan={plan} epicChildren={epicChildren} />
          </div>

          {/* Actual Revenue */}
          <div>
            <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
              Actual Revenue
            </h3>
            <ActualsEditor plan={plan} onUpdate={onUpdate} isUpdating={isUpdating} />
          </div>
        </div>
      </details>
    </section>
  );
}
