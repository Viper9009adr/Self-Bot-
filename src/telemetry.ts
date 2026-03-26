/**
 * In-memory telemetry capture and rollup queries used by the web stats API.
 *
 * This module stores recent raw events in memory, derives daily summary buckets,
 * and computes day-based series for dashboard chart rendering.
 */
import { createHash } from 'node:crypto';

type Platform = 'telegram' | 'whatsapp' | 'web';
type AllowAction = 'allow_add' | 'allow_remove' | 'allow_hit' | 'allow_miss';
type SeriesMetric =
  | 'msg'
  | 'rt_p50'
  | 'rt_p95'
  | 'tokens'
  | 'cost'
  | 'active_sessions'
  | 'allow_add'
  | 'allow_remove'
  | 'allow_hit'
  | 'allow_miss';

interface BaseEvent {
  platform: Platform;
  ts: number;
}

interface MessageEvent extends BaseEvent {
  type: 'message';
  userHash: string;
  chatHash: string;
}

interface BotResponseEvent extends BaseEvent {
  type: 'bot_response';
  userHash: string;
  chatHash: string;
  rtMs: number;
  tokens: number;
  costUsd: number;
}

interface AllowActionEvent extends BaseEvent {
  type: 'allow_action';
  actionType: AllowAction;
}

type TelemetryEvent = MessageEvent | BotResponseEvent | AllowActionEvent;

interface SummaryBucket {
  day: string;
  platform: Platform;
  messages: number;
  responses: number;
  rt_ms_p50: number;
  rt_ms_p95: number;
  tokens: number;
  cost_usd: number;
  active_sessions: number;
  allow_add: number;
  allow_remove: number;
  allow_hit: number;
  allow_miss: number;
}

interface SessionRow {
  day: string;
  platform: Platform;
  active_sessions: number;
  new_sessions: number;
  ended_sessions: number;
}

interface SummaryResponse {
  totals: {
    messages: number;
    responses: number;
    tokens: number;
    cost_usd: number;
    active_sessions: number;
    allow_total: number;
  };
  by_day: SummaryBucket[];
}

interface SummaryQuery {
  from: string;
  to: string;
  tz: string;
  platforms: Platform[];
}

interface SeriesQuery extends SummaryQuery {
  metric: SeriesMetric;
}

interface SessionInterval {
  key: string;
  platform: Platform;
  startTs: number;
  endTs: number;
}

interface SessionBuilder {
  key: string;
  platform: Platform;
  startTs: number;
  lastActivityTs: number;
  lastMessageTs?: number;
  lastBotResponseTs?: number;
}

const EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const AGG_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

const PLATFORM_VALUES: Platform[] = ['telegram', 'whatsapp', 'web'];

function clampInt(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  return Math.floor(value);
}

function clampMoney(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Number(value.toFixed(6));
}

function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1));
  return Math.round(sorted[idx] ?? 0);
}

function dayKey(ts: number, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ts));
  const year = parts.find((p) => p.type === 'year')?.value ?? '1970';
  const month = parts.find((p) => p.type === 'month')?.value ?? '01';
  const day = parts.find((p) => p.type === 'day')?.value ?? '01';
  return `${year}-${month}-${day}`;
}

function utcDayFromNowCutoff(days: number, now: number): string {
  const cutoff = new Date(now - days * 24 * 60 * 60 * 1000);
  const y = cutoff.getUTCFullYear();
  const m = String(cutoff.getUTCMonth() + 1).padStart(2, '0');
  const d = String(cutoff.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function hashId(input: string, salt: string): string {
  return createHash('sha256').update(`${salt}|${input}`).digest('hex').slice(0, 24);
}

function parsePlatforms(platforms: readonly string[] | undefined): Platform[] {
  if (!platforms || platforms.length === 0) return PLATFORM_VALUES;
  const normalized = platforms.filter((p): p is Platform => PLATFORM_VALUES.includes(p as Platform));
  return normalized.length > 0 ? normalized : PLATFORM_VALUES;
}

function parseDayInput(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return fallback;
  return dayKey(parsed, 'UTC');
}

function daySequence(from: string, to: string): string[] {
  const fromTs = Date.parse(`${from}T00:00:00Z`);
  const toTs = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(fromTs) || !Number.isFinite(toTs) || fromTs > toTs) return [from];
  const days: string[] = [];
  for (let ts = fromTs; ts <= toTs; ts += 24 * 60 * 60 * 1000) {
    days.push(dayKey(ts, 'UTC'));
  }
  return days;
}

function overlapsDay(interval: SessionInterval, day: string, tz: string): boolean {
  const startDay = dayKey(interval.startTs, tz);
  const endDay = dayKey(interval.endTs, tz);
  return startDay <= day && day <= endDay;
}

function sameOrAfter(day: string, from: string): boolean {
  return day >= from;
}

function sameOrBefore(day: string, to: string): boolean {
  return day <= to;
}

/** In-memory telemetry store for event capture and analytics queries. */
export class TelemetryStore {
  private readonly salt: string;
  private events: TelemetryEvent[] = [];
  private readonly dailyAggregateDays = new Set<string>();

  constructor(salt: string) {
    this.salt = salt;
  }

  /** Record an inbound user message event. */
  recordMessage(platform: Platform, userId: string, chatId: string, ts = Date.now()): void {
    this.prune(ts);
    this.events.push({
      type: 'message',
      platform,
      ts,
      userHash: hashId(userId, this.salt),
      chatHash: hashId(chatId, this.salt),
    });
    this.dailyAggregateDays.add(dayKey(ts, 'UTC'));
  }

  recordBotResponse(
    platform: Platform,
    userId: string,
    chatId: string,
    rtMs: number,
    tokens: number,
    costUsd: number,
    ts = Date.now(),
  ): void {
    this.prune(ts);
    this.events.push({
      type: 'bot_response',
      platform,
      ts,
      userHash: hashId(userId, this.salt),
      chatHash: hashId(chatId, this.salt),
      rtMs: clampInt(rtMs),
      tokens: clampInt(tokens),
      costUsd: clampMoney(costUsd),
    });
    this.dailyAggregateDays.add(dayKey(ts, 'UTC'));
  }

  /** Record allowlist action telemetry emitted by access-control routes. */
  recordAllowAction(platform: Platform, actionType: AllowAction, ts = Date.now()): void {
    this.prune(ts);
    this.events.push({ type: 'allow_action', platform, ts, actionType });
    this.dailyAggregateDays.add(dayKey(ts, 'UTC'));
  }

  /** Build totals plus day/platform summary buckets for stats cards and tables. */
  querySummary(input: Partial<SummaryQuery>): SummaryResponse {
    const query = this.normalizeQuery(input);
    const sessionRows = this.querySessions(query);
    const sessionMap = new Map<string, number>();
    for (const s of sessionRows) {
      sessionMap.set(`${s.day}|${s.platform}`, s.active_sessions);
    }

    const buckets = new Map<string, SummaryBucket & { latencies: number[] }>();
    for (const event of this.filteredEvents(query)) {
      const day = dayKey(event.ts, query.tz);
      const key = `${day}|${event.platform}`;
      const current = buckets.get(key) ?? {
        day,
        platform: event.platform,
        messages: 0,
        responses: 0,
        rt_ms_p50: 0,
        rt_ms_p95: 0,
        tokens: 0,
        cost_usd: 0,
        active_sessions: sessionMap.get(key) ?? 0,
        allow_add: 0,
        allow_remove: 0,
        allow_hit: 0,
        allow_miss: 0,
        latencies: [],
      };

      if (event.type === 'message') {
        current.messages += 1;
      }
      if (event.type === 'bot_response') {
        current.responses += 1;
        current.tokens += event.tokens;
        current.cost_usd = Number((current.cost_usd + event.costUsd).toFixed(6));
        current.latencies.push(event.rtMs);
      }
      if (event.type === 'allow_action') {
        current[event.actionType] += 1;
      }

      buckets.set(key, current);
    }

    const byDay = [...buckets.values()]
      .map((b) => ({
        ...b,
        rt_ms_p50: quantile(b.latencies, 0.5),
        rt_ms_p95: quantile(b.latencies, 0.95),
      }))
      .map(({ latencies: _latencies, ...row }) => row)
      .sort((a, b) => (a.day === b.day ? a.platform.localeCompare(b.platform) : a.day.localeCompare(b.day)));

    const totals = byDay.reduce(
      (acc, row) => {
        acc.messages += row.messages;
        acc.responses += row.responses;
        acc.tokens += row.tokens;
        acc.cost_usd = Number((acc.cost_usd + row.cost_usd).toFixed(6));
        acc.active_sessions += row.active_sessions;
        acc.allow_total += row.allow_add + row.allow_remove + row.allow_hit + row.allow_miss;
        return acc;
      },
      { messages: 0, responses: 0, tokens: 0, cost_usd: 0, active_sessions: 0, allow_total: 0 },
    );

    return { totals, by_day: byDay };
  }

  /** Build a metric series keyed by day for chart rendering. */
  querySeries(input: Partial<SeriesQuery>): Array<{ t: string; v: number; platform: Platform }> {
    const query = this.normalizeSeriesQuery(input);
    if (query.metric === 'active_sessions') {
      return this.querySessions(query).map((row) => ({
        t: row.day,
        v: row.active_sessions,
        platform: row.platform,
      }));
    }

    const summary = this.querySummary(query);
    return summary.by_day.map((row) => {
      const value = this.metricValue(query.metric, row);
      return { t: row.day, v: value, platform: row.platform };
    });
  }

  /** Build per-day session activity rows (active/new/ended) by platform. */
  querySessions(input: Partial<SummaryQuery>): SessionRow[] {
    const query = this.normalizeQuery(input);
    const intervals = this.buildSessionIntervals(query);
    const days = daySequence(query.from, query.to);
    const rows = new Map<string, SessionRow>();

    for (const interval of intervals) {
      for (const day of days) {
        if (!overlapsDay(interval, day, query.tz)) continue;
        const key = `${day}|${interval.platform}`;
        const row = rows.get(key) ?? {
          day,
          platform: interval.platform,
          active_sessions: 0,
          new_sessions: 0,
          ended_sessions: 0,
        };
        row.active_sessions += 1;
        if (dayKey(interval.startTs, query.tz) === day) row.new_sessions += 1;
        if (dayKey(interval.endTs, query.tz) === day) row.ended_sessions += 1;
        rows.set(key, row);
      }
    }

    return [...rows.values()].sort((a, b) => (a.day === b.day ? a.platform.localeCompare(b.platform) : a.day.localeCompare(b.day)));
  }

  private metricValue(metric: SeriesMetric, row: SummaryBucket): number {
    switch (metric) {
      case 'msg':
        return row.messages;
      case 'rt_p50':
        return row.rt_ms_p50;
      case 'rt_p95':
        return row.rt_ms_p95;
      case 'tokens':
        return row.tokens;
      case 'cost':
        return row.cost_usd;
      case 'active_sessions':
        return row.active_sessions;
      case 'allow_add':
        return row.allow_add;
      case 'allow_remove':
        return row.allow_remove;
      case 'allow_hit':
        return row.allow_hit;
      case 'allow_miss':
        return row.allow_miss;
    }
  }

  private normalizeQuery(input: Partial<SummaryQuery>): SummaryQuery {
    const now = Date.now();
    this.prune(now);

    const fallbackTo = dayKey(now, 'UTC');
    const fallbackFrom = dayKey(now - 6 * 24 * 60 * 60 * 1000, 'UTC');
    const tz = this.normalizeTz(input.tz);
    const from = parseDayInput(input.from, fallbackFrom);
    const to = parseDayInput(input.to, fallbackTo);
    const orderedFrom = from <= to ? from : to;
    const orderedTo = from <= to ? to : from;

    return {
      from: orderedFrom,
      to: orderedTo,
      tz,
      platforms: parsePlatforms(input.platforms),
    };
  }

  private normalizeSeriesQuery(input: Partial<SeriesQuery>): SeriesQuery {
    const query = this.normalizeQuery(input);
    const metric = input.metric ?? 'msg';
    return { ...query, metric };
  }

  private normalizeTz(tz?: string): string {
    if (!tz) return 'UTC';
    try {
      void new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
      return tz;
    } catch {
      return 'UTC';
    }
  }

  private filteredEvents(query: SummaryQuery): TelemetryEvent[] {
    return this.events.filter((event) => {
      if (!query.platforms.includes(event.platform)) return false;
      const day = dayKey(event.ts, query.tz);
      return sameOrAfter(day, query.from) && sameOrBefore(day, query.to);
    });
  }

  private buildSessionIntervals(query: SummaryQuery): SessionInterval[] {
    const relevant = this.filteredEvents(query)
      .filter((e): e is MessageEvent | BotResponseEvent => e.type === 'message' || e.type === 'bot_response')
      .sort((a, b) => a.ts - b.ts);

    const active = new Map<string, SessionBuilder>();
    const intervals: SessionInterval[] = [];

    const finalize = (builder: SessionBuilder): void => {
      const fallbackEnd = Math.max(
        builder.lastMessageTs ?? Number.NEGATIVE_INFINITY,
        builder.lastBotResponseTs ?? Number.NEGATIVE_INFINITY,
      );
      const endTs = Number.isFinite(fallbackEnd)
        ? Math.max(builder.lastActivityTs, fallbackEnd)
        : builder.lastActivityTs;
      intervals.push({
        key: builder.key,
        platform: builder.platform,
        startTs: builder.startTs,
        endTs,
      });
    };

    for (const event of relevant) {
      const key = `${event.platform}:${event.userHash}:${event.chatHash}`;
      const current = active.get(key);
      if (!current) {
        active.set(key, {
          key,
          platform: event.platform,
          startTs: event.ts,
          lastActivityTs: event.ts,
          ...(event.type === 'message' ? { lastMessageTs: event.ts } : { lastBotResponseTs: event.ts }),
        });
        continue;
      }

      if (event.ts - current.lastActivityTs > SESSION_IDLE_TIMEOUT_MS) {
        finalize(current);
        active.set(key, {
          key,
          platform: event.platform,
          startTs: event.ts,
          lastActivityTs: event.ts,
          ...(event.type === 'message' ? { lastMessageTs: event.ts } : { lastBotResponseTs: event.ts }),
        });
        continue;
      }

      current.lastActivityTs = event.ts;
      if (event.type === 'message') current.lastMessageTs = event.ts;
      if (event.type === 'bot_response') current.lastBotResponseTs = event.ts;
    }

    for (const builder of active.values()) {
      finalize(builder);
    }

    return intervals;
  }

  private prune(now: number): void {
    const eventCutoff = now - EVENT_RETENTION_MS;
    this.events = this.events.filter((event) => event.ts >= eventCutoff);

    const aggCutoffDay = utcDayFromNowCutoff(AGG_RETENTION_MS / (24 * 60 * 60 * 1000), now);
    for (const day of this.dailyAggregateDays) {
      if (day < aggCutoffDay) this.dailyAggregateDays.delete(day);
    }
  }
}

let telemetryStore: TelemetryStore | null = null;

/** Initialize and store the singleton TelemetryStore instance. */
export function initializeTelemetryStore(salt: string): TelemetryStore {
  telemetryStore = new TelemetryStore(salt);
  return telemetryStore;
}

/** Retrieve the singleton TelemetryStore instance, creating default when absent. */
export function getTelemetryStore(): TelemetryStore {
  if (!telemetryStore) {
    telemetryStore = new TelemetryStore('self-bot-default-salt');
  }
  return telemetryStore;
}
