import { canonicalJson } from '@trina/contracts';
import type { RequestHandler } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { sha256 } from './auth';
import type { AppContext } from './context';
import { badRequest, conflict, problem } from './errors';

/** Rate limiter with problem+json responses. Disabled when RATE_LIMITS=off (tests). */
export function limiter(ctx: AppContext, opts: { windowMs: number; limit: number; key?: 'ip' | 'user' }): RequestHandler {
  if (!ctx.config.RATE_LIMITS) return (_req, _res, next) => next();
  return rateLimit({
    windowMs: opts.windowMs,
    limit: opts.limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: opts.key === 'user' ? (req) => req.user?.id ?? ipKeyGenerator(req.ip ?? '0.0.0.0') : undefined,
    handler: (_req, res) => {
      res.status(429).type('application/problem+json').json(problem(429, 'RATE_LIMITED', 'Too many requests, slow down'));
    },
  });
}

/**
 * Idempotency for POST mutations: same key + same body replays the stored response;
 * same key + different body is a 409. Keys expire after 24h.
 */
export function idempotent(ctx: AppContext, opts: { required?: boolean } = {}): RequestHandler {
  return async (req, res, next) => {
    const key = req.header('Idempotency-Key');
    if (!key) {
      if (opts.required) throw badRequest('Idempotency-Key header is required');
      return next();
    }
    if (key.length > 100) throw badRequest('Idempotency-Key too long');
    const userId = req.user?.id;
    if (!userId) return next();
    const route = `${req.method} ${req.baseUrl}${req.path}`;
    const requestHash = sha256(canonicalJson(req.body ?? {}));
    const existing = await ctx.db.one<{ route: string; request_hash: string; response_status: number; response_body: unknown }>(
      'SELECT route, request_hash, response_status, response_body FROM idempotency_keys WHERE user_id = $1 AND key = $2 AND expires_at > now()',
      [userId, key],
    );
    if (existing) {
      if (existing.route !== route || existing.request_hash !== requestHash) {
        throw conflict('IDEMPOTENCY_MISMATCH', 'Idempotency-Key was used with a different request');
      }
      res.status(existing.response_status).json(existing.response_body);
      return;
    }
    const json = res.json.bind(res);
    res.json = (body: unknown) => {
      if (res.statusCode >= 500) return json(body);
      // Store first, then respond, so a fast retry always sees the stored response.
      void ctx.db
        .query(
          `INSERT INTO idempotency_keys (user_id, key, route, request_hash, response_status, response_body, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, now() + interval '24 hours') ON CONFLICT DO NOTHING`,
          [userId, key, route, requestHash, res.statusCode, JSON.stringify(body ?? null)],
        )
        .catch((e) => ctx.logger.warn({ err: e.message }, 'idempotency store failed'))
        .finally(() => json(body));
      return res;
    };
    next();
  };
}
