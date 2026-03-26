/**
 * Shared dashboard graph shell and lightweight SVG line chart renderer.
 */
import type { ReactNode } from 'react'

type SGProps = {
  title: string
  children: ReactNode
  className?: string
}

export interface ChartPoint {
  t: string
  v: number
}

export interface ChartSeries {
  name: string
  color: string
  points: ChartPoint[]
}

/** Compute chart min/max with a stable non-zero domain fallback. */
function getSeriesDomain(series: ChartSeries[]): { min: number; max: number } {
  const values = series.flatMap((s) => s.points.map((p) => p.v))
  if (values.length === 0) return { min: 0, max: 1 }
  const min = Math.min(...values, 0)
  const max = Math.max(...values, 1)
  return min === max ? { min: 0, max: max + 1 } : { min, max }
}

/** Build sorted unique x-axis labels from all series timelines. */
function uniqueTimeline(series: ChartSeries[]): string[] {
  return Array.from(new Set(series.flatMap((s) => s.points.map((p) => p.t)))).sort((a, b) => a.localeCompare(b))
}

/** Map timeline keys to numeric values for one series. */
function seriesValueMap(series: ChartSeries): Map<string, number> {
  return new Map(series.points.map((p) => [p.t, p.v]))
}

/** Render multi-series line chart using an inline SVG canvas. */
export function LineChart({
  series,
  height = 220,
}: {
  series: ChartSeries[]
  height?: number
}) {
  const timeline = uniqueTimeline(series)
  if (timeline.length === 0 || series.length === 0) {
    return <p className="text-sm text-slate-500">No chart data available.</p>
  }

  const width = 760
  const padding = 28
  const xStep = timeline.length > 1 ? (width - padding * 2) / (timeline.length - 1) : 0
  const { min, max } = getSeriesDomain(series)
  const scaleY = (value: number) => {
    const ratio = (value - min) / (max - min)
    return height - padding - ratio * (height - padding * 2)
  }

  return (
    <div className="space-y-3">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full rounded border border-slate-700 bg-slate-900/40">
        <line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding} stroke="#334155" strokeWidth="1" />
        <line x1={padding} y1={padding} x2={padding} y2={height - padding} stroke="#334155" strokeWidth="1" />
        {series.map((s) => {
          const byTime = seriesValueMap(s)
          const points = timeline
            .map((t, idx) => {
              const value = byTime.get(t)
              if (value === undefined) return null
              const x = padding + idx * xStep
              const y = scaleY(value)
              return `${x},${y}`
            })
            .filter((p): p is string => Boolean(p))
            .join(' ')
          return <polyline key={s.name} points={points} fill="none" stroke={s.color} strokeWidth="2" strokeLinecap="round" />
        })}
      </svg>

      <div className="flex flex-wrap gap-3 text-xs">
        {series.map((s) => (
          <div key={s.name} className="inline-flex items-center gap-2 text-slate-300">
            <span className="inline-block w-3 h-3 rounded-sm" style={{ backgroundColor: s.color }} />
            <span>{s.name}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Render a styled stats graph card wrapper section. */
export default function SG({ title, children, className }: SGProps) {
  return (
    <section className={`bg-slate-800 rounded-lg border border-slate-700 p-5 ${className ?? ''}`}>
      <h2 className="text-lg font-semibold text-slate-200 mb-3">{title}</h2>
      {children}
    </section>
  )
}
