/**
 * src/adapters/website/auth.ts
 * JWT issuance, verification, and login handler for the website adapter.
 */
import type { FastifyRequest, FastifyReply, RouteHandlerMethod } from 'fastify';
import { SignJWT, jwtVerify } from 'jose';
import type { Config } from '../../config/index.js';
import type { SecretString } from '../../config/schema.js';
import { childLogger } from '../../utils/logger.js';

const log = childLogger({ module: 'website:auth' });

// ─── In-memory login rate limiter ─────────────────────────────────────────────
const loginAttempts = new Map<string, { count: number; resetAt: number }>();

// ─── JWT helpers ──────────────────────────────────────────────────────────────

/**
 * Issue an HS256 JWT for the given username.
 * Subject is set to `web:<username>`, expiry 24 h.
 */
export async function issueJwt(username: string, secret: SecretString): Promise<string> {
  const secretBytes = new TextEncoder().encode(secret as string);
  return new SignJWT({ username })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(`web:${username}`)
    .setIssuedAt()
    .setExpirationTime('24h')
    .sign(secretBytes);
}

// ─── Login handler ────────────────────────────────────────────────────────────

/**
 * Returns a Fastify route handler for POST /auth/login.
 * Validates credentials, enforces rate limiting, issues JWT on success.
 */
export function loginHandler(config: Config): RouteHandlerMethod {
  return async function handler(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    // CRITICAL-2: Guard JWT secret at top
    if (!config.access?.gatewayJwtSecret) {
      return reply
        .status(503)
        .send({ error: 'JWT signing not configured — set GATEWAY_JWT_SECRET' });
    }

    // website config is guaranteed present (checked in initialize())
    const website = config.website!;

    // MAJOR-2: Rate limiting
    const ip = (request as FastifyRequest & { ip?: string }).ip ?? 'unknown';
    const now = Date.now();
    const record = loginAttempts.get(ip) ?? { count: 0, resetAt: now + 60_000 };
    if (now > record.resetAt) {
      record.count = 0;
      record.resetAt = now + 60_000;
    }
    if (record.count >= 5) {
      return reply.status(429).send({ error: 'Too many login attempts' });
    }
    loginAttempts.set(ip, record);

    // Parse body
    const body = request.body as Record<string, unknown> | null | undefined;
    const username = typeof body?.['username'] === 'string' ? body['username'] : '';
    const password = typeof body?.['password'] === 'string' ? body['password'] : '';

    // Validate credentials
    const usernameMatch = username === website.ownerUsername;
    const passwordMatch = password === (website.ownerPassword as unknown as string);

    if (!usernameMatch || !passwordMatch) {
      record.count++;
      log.warn({ ip, username }, 'Failed login attempt');
      return reply.status(401).send({ error: 'Invalid credentials' });
    }

    // Success: reset rate limit and issue JWT
    loginAttempts.delete(ip);
    const token = await issueJwt(username, config.access.gatewayJwtSecret);
    log.info({ username }, 'Login successful');
    return reply.status(200).send({ token });
  };
}

// ─── JWT verification preHandler ──────────────────────────────────────────────

/**
 * Fastify preHandler hook that verifies the JWT on /api/* routes.
 * Attaches decoded claims to request.user on success.
 * Returns a plain async function compatible with Fastify's route-level preHandler option.
 */
export function verifyJwt(
  config: Config,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async function hook(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    if (!config.access?.gatewayJwtSecret) {
      return reply
        .status(503)
        .send({ error: 'JWT signing not configured — set GATEWAY_JWT_SECRET' }) as unknown as void;
    }

    const authHeader = request.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply
        .status(401)
        .send({ error: 'Missing or invalid Authorization header' }) as unknown as void;
    }

    const token = authHeader.slice(7);
    const secretBytes = new TextEncoder().encode(config.access.gatewayJwtSecret as string);

    try {
      const { payload } = await jwtVerify(token, secretBytes);
      // Attach claims to request for downstream handlers
      (request as FastifyRequest & { user: unknown }).user = {
        username: payload['username'] as string | undefined,
        sub: payload.sub,
      };
    } catch (err) {
      log.debug({ err }, 'JWT verification failed');
      return reply
        .status(401)
        .send({ error: 'Invalid or expired token' }) as unknown as void;
    }
  };
}
