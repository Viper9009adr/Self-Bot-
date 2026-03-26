import { useEffect, useMemo, useState } from 'react'
import SG, { LineChart, type ChartSeries } from '../SG'

type Platform = 'telegram' | 'whatsapp' | 'web'

interface SummaryData {
  totals: {
    messages: number
    responses: number
    tokens: number
    cost_usd: number
    active_sessions: number
    allow_total: number
  }
  by_day: Array<{
    day: string
    platform: Platform
    messages: number
    responses: number
    rt_ms_p50: number
    rt_ms_p95: number
    tokens: number
    cost_usd: number
    active_sessions: number
    allow_add: number
    allow_remove: number
    allow_hit: number
    allow_miss: number
  }>
}

interface SeriesPoint {
  t: string
  v: number
  platform: Platform
}

interface SessionsPoint {
  day: string
  platform: Platform
  active_sessions: number
  new_sessions: number
  ended_sessions: number
}

const PLATFORM_COLORS: Record<Platform, string> = {
  telegram: '#22d3ee',
  whatsapp: '#22c55e',
  web: '#f59e0b',
}

function seriesByPlatform(points: SeriesPoint[]): ChartSeries[] {
  const platforms: Platform[] = ['telegram', 'whatsapp', 'web']
  return platforms.map((platform) => ({
    name: platform,
    color: PLATFORM_COLORS[platform],
    points: points
      .filter((p) => p.platform === platform)
      .sort((a, b) => a.t.localeCompare(b.t))
      .map((p) => ({ t: p.t, v: p.v })),
  }))
}

function toSingleSeries(name: string, color: string, points: SeriesPoint[]): ChartSeries[] {
  return [
    {
      name,
      color,
      points: points.sort((a, b) => a.t.localeCompare(b.t)).map((p) => ({ t: p.t, v: p.v })),
    },
  ]
}

export default function Dashboard() {
  const [summary, setSummary] = useState<SummaryData | null>(null)
  const [msgSeries, setMsgSeries] = useState<SeriesPoint[]>([])
  const [rtP50Series, setRtP50Series] = useState<SeriesPoint[]>([])
  const [rtP95Series, setRtP95Series] = useState<SeriesPoint[]>([])
  const [tokensSeries, setTokensSeries] = useState<SeriesPoint[]>([])
  const [costSeries, setCostSeries] = useState<SeriesPoint[]>([])
  const [activeSeries, setActiveSeries] = useState<SeriesPoint[]>([])
  const [allowAddSeries, setAllowAddSeries] = useState<SeriesPoint[]>([])
  const [allowRemoveSeries, setAllowRemoveSeries] = useState<SeriesPoint[]>([])
  const [allowHitSeries, setAllowHitSeries] = useState<SeriesPoint[]>([])
  const [allowMissSeries, setAllowMissSeries] = useState<SeriesPoint[]>([])
  const [sessionsSeries, setSessionsSeries] = useState<SessionsPoint[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const query = useMemo(() => {
    const now = new Date()
    const start = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000)
    return {
      from: start.toISOString().slice(0, 10),
      to: now.toISOString().slice(0, 10),
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      platform: ['telegram', 'whatsapp', 'web'] as Platform[],
    }
  }, [])

  useEffect(() => {
    const token = localStorage.getItem('self-bot-token')

    async function apiFetch(path: string): Promise<unknown> {
      const res = await fetch(path, {
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      })
      if (!res.ok) {
        throw new Error(await res.text())
      }
      return res.json()
    }

    function toStatsQueryString(): string {
      const params = new URLSearchParams()
      if (query.from) params.set('from', query.from)
      if (query.to) params.set('to', query.to)
      if (query.tz) params.set('tz', query.tz)
      for (const p of query.platform) {
        params.append('platform[]', p)
      }
      const qs = params.toString()
      return qs ? `?${qs}` : ''
    }

    async function getStatsSummary(): Promise<unknown> {
      return apiFetch(`/api/stats/summary${toStatsQueryString()}`)
    }

    async function getStatsSeries(metric: string): Promise<unknown> {
      const qs = toStatsQueryString()
      const joiner = qs.includes('?') ? '&' : '?'
      return apiFetch(`/api/stats/series${qs}${joiner}metric=${encodeURIComponent(metric)}&bucket=day`)
    }

    async function getStatsSessions(): Promise<unknown> {
      return apiFetch(`/api/stats/sessions${toStatsQueryString()}`)
    }

    async function load() {
      setLoading(true)
      setError(null)
      try {
        const [summaryRes, msgRes, p50Res, p95Res, tokRes, costRes, activeRes, addRes, removeRes, hitRes, missRes, sessRes] = await Promise.all([
          getStatsSummary(),
          getStatsSeries('msg'),
          getStatsSeries('rt_p50'),
          getStatsSeries('rt_p95'),
          getStatsSeries('tokens'),
          getStatsSeries('cost'),
          getStatsSeries('active_sessions'),
          getStatsSeries('allow_add'),
          getStatsSeries('allow_remove'),
          getStatsSeries('allow_hit'),
          getStatsSeries('allow_miss'),
          getStatsSessions(),
        ])

        setSummary(summaryRes as SummaryData)
        setMsgSeries(Array.isArray(msgRes) ? (msgRes as SeriesPoint[]) : [])
        setRtP50Series(Array.isArray(p50Res) ? (p50Res as SeriesPoint[]) : [])
        setRtP95Series(Array.isArray(p95Res) ? (p95Res as SeriesPoint[]) : [])
        setTokensSeries(Array.isArray(tokRes) ? (tokRes as SeriesPoint[]) : [])
        setCostSeries(Array.isArray(costRes) ? (costRes as SeriesPoint[]) : [])
        setActiveSeries(Array.isArray(activeRes) ? (activeRes as SeriesPoint[]) : [])
        setAllowAddSeries(Array.isArray(addRes) ? (addRes as SeriesPoint[]) : [])
        setAllowRemoveSeries(Array.isArray(removeRes) ? (removeRes as SeriesPoint[]) : [])
        setAllowHitSeries(Array.isArray(hitRes) ? (hitRes as SeriesPoint[]) : [])
        setAllowMissSeries(Array.isArray(missRes) ? (missRes as SeriesPoint[]) : [])
        setSessionsSeries(Array.isArray(sessRes) ? (sessRes as SessionsPoint[]) : [])
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to load dashboard data')
      } finally {
        setLoading(false)
      }
    }
    void load()
  }, [query])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-4 border-green-500 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="text-red-400 bg-red-900/30 border border-red-700 rounded-md p-4">
        {error}
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-slate-100">Dashboard</h1>

      <div className="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-6 gap-4">
        <div className="bg-slate-800 rounded-lg border border-slate-700 p-4">
          <div className="text-xs uppercase text-slate-400">Messages</div>
          <div className="text-2xl font-semibold text-slate-100">{summary?.totals.messages ?? 0}</div>
        </div>
        <div className="bg-slate-800 rounded-lg border border-slate-700 p-4">
          <div className="text-xs uppercase text-slate-400">Active Sessions</div>
          <div className="text-2xl font-semibold text-slate-100">{summary?.totals.active_sessions ?? 0}</div>
        </div>
        <div className="bg-slate-800 rounded-lg border border-slate-700 p-4">
          <div className="text-xs uppercase text-slate-400">RT P95 (ms)</div>
          <div className="text-2xl font-semibold text-slate-100">{rtP95Series.at(-1)?.v ?? 0}</div>
        </div>
        <div className="bg-slate-800 rounded-lg border border-slate-700 p-4">
          <div className="text-xs uppercase text-slate-400">Tokens</div>
          <div className="text-2xl font-semibold text-slate-100">{summary?.totals.tokens ?? 0}</div>
        </div>
        <div className="bg-slate-800 rounded-lg border border-slate-700 p-4">
          <div className="text-xs uppercase text-slate-400">Cost (USD)</div>
          <div className="text-2xl font-semibold text-slate-100">{(summary?.totals.cost_usd ?? 0).toFixed(4)}</div>
        </div>
        <div className="bg-slate-800 rounded-lg border border-slate-700 p-4">
          <div className="text-xs uppercase text-slate-400">Allow Total</div>
          <div className="text-2xl font-semibold text-slate-100">{summary?.totals.allow_total ?? 0}</div>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <SG title="Messages / Day by Platform">
          <LineChart series={seriesByPlatform(msgSeries)} />
        </SG>

        <SG title="RT P50 / P95 (Day)">
          <LineChart
            series={[
              ...toSingleSeries('p50', '#38bdf8', rtP50Series),
              ...toSingleSeries('p95', '#a78bfa', rtP95Series),
            ]}
          />
        </SG>

        <SG title="Tokens + Cost (Day)">
          <LineChart
            series={[
              ...toSingleSeries('tokens', '#60a5fa', tokensSeries),
              ...toSingleSeries('cost', '#34d399', costSeries),
            ]}
          />
        </SG>

        <SG title="Active Sessions (Day)">
          <LineChart
            series={[
              ...toSingleSeries('active_sessions', '#f59e0b', activeSeries),
              {
                name: 'new_sessions',
                color: '#22c55e',
                points: sessionsSeries
                  .sort((a, b) => a.day.localeCompare(b.day))
                  .map((row) => ({ t: row.day, v: row.new_sessions })),
              },
              {
                name: 'ended_sessions',
                color: '#ef4444',
                points: sessionsSeries
                  .sort((a, b) => a.day.localeCompare(b.day))
                  .map((row) => ({ t: row.day, v: row.ended_sessions })),
              },
            ]}
          />
        </SG>

        <SG title="Allow Actions (Day)" className="xl:col-span-2">
          <LineChart
            series={[
              ...toSingleSeries('allow_add', '#22c55e', allowAddSeries),
              ...toSingleSeries('allow_remove', '#ef4444', allowRemoveSeries),
              ...toSingleSeries('allow_hit', '#3b82f6', allowHitSeries),
              ...toSingleSeries('allow_miss', '#f59e0b', allowMissSeries),
            ]}
          />
        </SG>
      </div>

      <div className="bg-slate-800 rounded-lg border border-slate-700 p-5">
        <h2 className="text-lg font-semibold text-slate-200 mb-3">Summary by Day + Platform</h2>
        {summary?.by_day?.length ? (
          <ul className="space-y-2">
            {summary.by_day.map((row, idx) => (
              <li key={`${row.day}-${row.platform}-${idx}`} className="text-sm text-slate-300 bg-slate-700 rounded px-3 py-2">
                <span className="font-mono">{row.day}</span> · <span>{row.platform}</span> · msg {row.messages} · rt95 {row.rt_ms_p95} · tok {row.tokens} · cost {row.cost_usd.toFixed(4)} · active {row.active_sessions}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-slate-500">No stats data available.</p>
        )}
      </div>
    </div>
  )
}
