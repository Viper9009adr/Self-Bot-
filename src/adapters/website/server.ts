/**
 * src/adapters/website/server.ts
 * Factory function that creates and configures the Fastify instance
 * for the website adapter.
 */
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import staticPlugin from '@fastify/static';
import path from 'node:path';
import fs from 'node:fs';
import { nanoid } from 'nanoid';
import type { Config } from '../../config/index.js';
import type { UnifiedMessage, UnifiedResponse, WebMetadata } from '../../types/message.js';
import type { SessionManager } from '../../session/manager.js';
import type { IAllowlistStore } from '../../access/index.js';
import { loginHandler, verifyJwt } from './auth.js';
import { childLogger } from '../../utils/logger.js';
import { initializeTelemetryStore } from '../../telemetry.js';

const log = childLogger({ module: 'website:server' });

type StatsMetric =
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

const STATS_METRICS: readonly StatsMetric[] = [
  'msg',
  'rt_p50',
  'rt_p95',
  'tokens',
  'cost',
  'active_sessions',
  'allow_add',
  'allow_remove',
  'allow_hit',
  'allow_miss',
];

function isStatsMetric(value: string): value is StatsMetric {
  return STATS_METRICS.includes(value as StatsMetric);
}

interface JwtUser {
  username?: string;
  sub?: string;
  role?: 'owner' | 'admin';
}

function getJwtUser(request: FastifyRequest): JwtUser {
  return (request as FastifyRequest & { user?: JwtUser }).user ?? {};
}

function parsePlatforms(value: unknown): Array<'telegram' | 'whatsapp' | 'web'> {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  const allowed = raw.filter((p): p is 'telegram' | 'whatsapp' | 'web' => p === 'telegram' || p === 'whatsapp' || p === 'web');
  return allowed;
}

function parsePlatformsFromQuery(query: Record<string, unknown>): Array<'telegram' | 'whatsapp' | 'web'> {
  return parsePlatforms(query['platform[]'] ?? query['platform']);
}

function getOptionalString(query: Record<string, unknown>, key: string): string | undefined {
  const value = query[key];
  return typeof value === 'string' ? value : undefined;
}

function buildSummaryQuery(query: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(getOptionalString(query, 'from') !== undefined ? { from: getOptionalString(query, 'from') } : {}),
    ...(getOptionalString(query, 'to') !== undefined ? { to: getOptionalString(query, 'to') } : {}),
    ...(getOptionalString(query, 'tz') !== undefined ? { tz: getOptionalString(query, 'tz') } : {}),
    platforms: parsePlatformsFromQuery(query),
  };
}

function requireStatsAuth(request: FastifyRequest, reply: FastifyReply, ownerUsername: string): boolean {
  const user = getJwtUser(request);
  const username = user.username ?? user.sub?.replace(/^web:/, '');
  const isOwner = username === ownerUsername;
  const isAdmin = user.role === 'admin' || username === 'admin';
  if (!isOwner && !isAdmin) {
    void reply.status(403).send({ error: 'Forbidden: owner/admin required' });
    return false;
  }

  if (user.sub && !user.sub.startsWith('web:')) {
    void reply.status(403).send({ error: 'Forbidden: non-owner tenant' });
    return false;
  }

  return true;
}

// ─── Maintenance HTML fallback ────────────────────────────────────────────────
const MAINTENANCE_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Self-BOT</title></head>
<body><h1>Self-BOT</h1><p>Web UI not yet built. Run <code>npm run build:web</code> first.</p></body>
</html>`;

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create and configure the Fastify web server for the website adapter.
 *
 * @param config       - Application config (website block must be present)
 * @param sessions     - SessionManager for /api/sessions endpoint
 * @param allowlist    - IAllowlistStore for /api/allowlist endpoints
 * @param onMessage    - Callback invoked when a chat message arrives
 * @param sendPending  - Callback invoked to route a response back to a pending request
 */
export async function createWebServer(
  config: Config,
  sessions: SessionManager,
  allowlist: IAllowlistStore,
  onMessage: (msg: UnifiedMessage) => void,
  sendPending: (response: UnifiedResponse) => void,
): Promise<FastifyInstance> {
  const fastify = Fastify({ logger: false });

  await registerAll(fastify, config, sessions, allowlist, onMessage, sendPending);

  return fastify;
}

// ─── Registration (async, called once) ───────────────────────────────────────

async function registerAll(
  fastify: FastifyInstance,
  config: Config,
  sessions: SessionManager,
  allowlist: IAllowlistStore,
  onMessage: (msg: UnifiedMessage) => void,
  sendPending: (response: UnifiedResponse) => void,
): Promise<void> {
  const website = config.website!;
  const telemetry = initializeTelemetryStore(
    (config.access.gatewayJwtSecret as unknown as string | undefined) ?? website.ownerUsername,
  );

  // CRITICAL-3: Register CORS
  await fastify.register(cors, {
    origin: config.nodeEnv === 'development' ? 'http://localhost:5173' : false,
    credentials: true,
  });

  // Static file serving — skip if web/dist does not exist
  const webDistPath = path.join(process.cwd(), 'web/dist');
  if (fs.existsSync(webDistPath)) {
    await fastify.register(staticPlugin, {
      root: webDistPath,
      prefix: '/',
    });
    log.info({ root: webDistPath }, 'Serving static files from web/dist');
  } else {
    fastify.get('/', async (_req: FastifyRequest, reply: FastifyReply) => {
      return reply.status(200).type('text/html').send(MAINTENANCE_HTML);
    });
    log.info('web/dist not found — serving maintenance page');
  }

  // ── POST /auth/login — no JWT required ──────────────────────────────────
  fastify.post('/auth/login', loginHandler(config));

  // Build JWT preHandler — plain async function, used as route-level preHandler option.
  const jwtPreHandler = verifyJwt(config);

  // ── GET /api/status ──────────────────────────────────────────────────────
  fastify.get('/api/status', { preHandler: jwtPreHandler }, async (_req: FastifyRequest, _reply: FastifyReply) => {
    return {
      adapters: ['telegram', 'whatsapp', 'web'],
      uptime: process.uptime(),
      platform: 'web',
    };
  });

  // ── GET /api/sessions ────────────────────────────────────────────────────
  fastify.get('/api/sessions', { preHandler: jwtPreHandler }, async (_req: FastifyRequest, _reply: FastifyReply) => {
    const users = await sessions.listUsers();
    return { users };
  });

  // ── GET /api/allowlist ───────────────────────────────────────────────────
  fastify.get('/api/allowlist', { preHandler: jwtPreHandler }, async (_req: FastifyRequest, _reply: FastifyReply) => {
    const entries = await allowlist.list();
    return { entries };
  });

  // ── POST /api/allowlist/grant ────────────────────────────────────────────
  fastify.post('/api/allowlist/grant', { preHandler: jwtPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as Record<string, unknown> | null | undefined;
    const userId = typeof body?.['userId'] === 'string' ? body['userId'] : null;
    if (!userId) {
      return reply.status(400).send({ error: 'userId is required' });
    }
    await allowlist.grant(userId, `web:${website.ownerUsername}`);
    telemetry.recordAllowAction('web', 'allow_add');
    return reply.status(200).send({ ok: true, userId });
  });

  // ── DELETE /api/allowlist/:userId ────────────────────────────────────────
  fastify.delete(
    '/api/allowlist/:userId',
    { preHandler: jwtPreHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = request.params as { userId: string };
      const userId = params.userId;
      await allowlist.revoke(userId);
      telemetry.recordAllowAction('web', 'allow_remove');
      return reply.status(200).send({ ok: true, userId });
    },
  );

  fastify.get('/api/stats/summary', { preHandler: jwtPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireStatsAuth(request, reply, website.ownerUsername)) {
      telemetry.recordAllowAction('web', 'allow_miss');
      return;
    }
    telemetry.recordAllowAction('web', 'allow_hit');
    const query = request.query as Record<string, unknown>;
    const summary = telemetry.querySummary(buildSummaryQuery(query));
    return reply.status(200).send(summary);
  });

  fastify.get('/api/stats/series', { preHandler: jwtPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireStatsAuth(request, reply, website.ownerUsername)) {
      telemetry.recordAllowAction('web', 'allow_miss');
      return;
    }
    telemetry.recordAllowAction('web', 'allow_hit');
    const query = request.query as Record<string, unknown>;
    const metricValue = typeof query['metric'] === 'string' ? query['metric'] : 'msg';
    if (!isStatsMetric(metricValue)) {
      return reply.status(400).send({ error: 'unsupported metric' });
    }
    const bucket = typeof query['bucket'] === 'string' ? query['bucket'] : 'day';
    if (bucket !== 'day') {
      return reply.status(400).send({ error: 'bucket must be day' });
    }
    const series = telemetry.querySeries({ ...buildSummaryQuery(query), metric: metricValue });
    return reply.status(200).send(series);
  });

  fastify.get('/api/stats/sessions', { preHandler: jwtPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireStatsAuth(request, reply, website.ownerUsername)) {
      telemetry.recordAllowAction('web', 'allow_miss');
      return;
    }
    telemetry.recordAllowAction('web', 'allow_hit');
    const query = request.query as Record<string, unknown>;
    const sessionsSeries = telemetry.querySessions(buildSummaryQuery(query));
    return reply.status(200).send(sessionsSeries);
  });

  // ── GET /api/tools ───────────────────────────────────────────────────────
  fastify.get('/api/tools', { preHandler: jwtPreHandler }, async (_req: FastifyRequest, _reply: FastifyReply) => {
    // Placeholder — MCPToolRegistry will be injected in P5
    return { tools: [] };
  });

  // ── POST /api/chat ───────────────────────────────────────────────────────
  fastify.post('/api/chat', { preHandler: jwtPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const requestStartedAt = Date.now();
    const body = request.body as Record<string, unknown> | null | undefined;
    const text = typeof body?.['message'] === 'string' ? body['message'] : '';
    if (!text.trim()) {
      return reply.status(400).send({ error: 'message is required' });
    }

    // Extract username from verified JWT claims
    const user = (request as FastifyRequest & { user?: { username?: string; sub?: string } }).user;
    const username = user?.username ?? user?.sub?.replace(/^web:/, '') ?? 'unknown';

    const requestId = nanoid();
    const messageId = nanoid();
    const now = new Date().toISOString();

    const meta: WebMetadata = {
      platform: 'web',
      rawJwt: (request.headers['authorization'] ?? '').slice(7),
      username,
      requestId,
      sourceIp: (request as FastifyRequest & { ip?: string }).ip,
      userAgent: request.headers['user-agent'],
    };

    const unifiedMessage: UnifiedMessage = {
      id: messageId,
      userId: `web:${username}`,
      conversationId: `web:${username}`,
      text,
      attachments: [],
      timestamp: now,
      platform: meta,
      isCommand: text.startsWith('/'),
      command: text.startsWith('/') ? text.slice(1).split(' ')[0] : undefined,
      commandArgs: text.startsWith('/') ? text.slice(1).split(' ').slice(1) : undefined,
    };

    telemetry.recordMessage('web', unifiedMessage.userId, unifiedMessage.conversationId, requestStartedAt);

    // Build pending promise with CRITICAL-1 settled guard
    const response = await new Promise<UnifiedResponse>((resolve, reject) => {
      const entry = {
        resolve,
        reject,
        settled: false,
        timer: setTimeout(() => {
          // CRITICAL-1 timer path
          if (entry.settled) return;
          entry.settled = true;
          // MINOR-1: delete from map before rejecting
          pendingRef.delete(requestId);
          reject(Object.assign(new Error('Request timed out'), { httpStatus: 504 }));
        }, 30_000),
      };

      // Store reference — we need access to pendingMap from outside the closure
      // sendPending callback handles resolution; we surface the entry via onMessage flow
      pendingRef.set(requestId, entry);

      // Dispatch — downstream calls sendPending(response) which resolves entry
      onMessage(unifiedMessage);
    }).catch((err: Error & { httpStatus?: number }) => {
      const status = err.httpStatus === 504 ? 504 : 500;
      void reply.status(status).send({ error: err.message });
      return null;
    });

    if (response === null) return; // already replied via catch above

    const rtMs = Date.now() - requestStartedAt;
    telemetry.recordBotResponse('web', unifiedMessage.userId, unifiedMessage.conversationId, rtMs, 0, 0, Date.now());

    return reply.status(200).send({ text: response.text, format: response.format });
  });

  // ── Internal pending map (accessed by sendPending callback) ──────────────
  // This is populated inside the /api/chat handler. We expose a resolver to
  // the adapter via the sendPending parameter.
  // The pendingRef below is declared in module scope so the timeout closure
  // and the sendPending callback share the same Map.
}

// Module-level pending map shared between the /api/chat handler and resolveResponse()
interface PendingEntry {
  resolve: (r: UnifiedResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  settled: boolean;
}

/**
 * Module-level map shared between the /api/chat route and sendPending callback.
 * Exported so WebAdapter can call resolvePending() from its resolveResponse().
 */
export const pendingRef = new Map<string, PendingEntry>();

/**
 * Resolve (or reject) a pending /api/chat promise.
 * Called by WebAdapter.resolveResponse() via the sendPending callback.
 * Implements CRITICAL-1: settled guard on sendResponse path.
 */
export function resolvePending(response: UnifiedResponse): void {
  const meta = response.platform as WebMetadata;
  const entry = pendingRef.get(meta.requestId);
  if (!entry || entry.settled) return;
  entry.settled = true;
  clearTimeout(entry.timer);
  pendingRef.delete(meta.requestId);
  entry.resolve(response);
}
