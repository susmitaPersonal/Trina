import { createHash, randomBytes } from 'node:crypto';
import type { RequestHandler } from 'express';
import { jwtVerify, SignJWT, errors as joseErrors } from 'jose';
import type { AppContext, AuthUser } from './context';
import { forbidden, unauthorized } from './errors';

const ISSUER = 'trina';
const AUDIENCE = 'trina-app';

const key = (secret: string) => new TextEncoder().encode(secret);

export async function signAccessToken(ctx: AppContext, u: AuthUser): Promise<string> {
  return new SignJWT({ role: u.role, did: u.deviceId })
    .setProtectedHeader({ alg: 'HS256', kid: 'k1' })
    .setSubject(u.id)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(Math.floor(ctx.now().getTime() / 1000))
    .setExpirationTime(Math.floor(ctx.now().getTime() / 1000) + ctx.config.ACCESS_TOKEN_TTL_S)
    .sign(key(ctx.config.JWT_SECRET));
}

export async function verifyAccessToken(ctx: AppContext, token: string): Promise<AuthUser> {
  try {
    const { payload } = await jwtVerify(token, key(ctx.config.JWT_SECRET), {
      issuer: ISSUER,
      audience: AUDIENCE,
      currentDate: ctx.now(),
    });
    if (typeof payload.sub !== 'string' || typeof payload.did !== 'string') throw unauthorized();
    return { id: payload.sub, role: payload.role === 'admin' ? 'admin' : 'user', deviceId: payload.did };
  } catch (e) {
    if (e instanceof joseErrors.JWTExpired) throw unauthorized('Access token expired', 'TOKEN_EXPIRED');
    throw unauthorized('Invalid access token');
  }
}

export function newOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sha256(s: string | Buffer): string {
  return createHash('sha256').update(s).digest('hex');
}

export function requireAuth(ctx: AppContext): RequestHandler {
  return async (req, _res, next) => {
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) throw unauthorized();
    req.user = await verifyAccessToken(ctx, h.slice(7));
    // Offline Quest Mode (design §5A.5): remember only THAT this device talked to us in this minute.
    await ctx.db
      .query(`INSERT INTO device_request_minutes (device_id, minute) VALUES ($1, date_trunc('minute', $2::timestamptz)) ON CONFLICT DO NOTHING`, [req.user.deviceId, ctx.now().toISOString()])
      .catch(() => undefined);
    next();
  };
}

export function requireAdmin(): RequestHandler {
  return (req, _res, next) => {
    if (req.user?.role !== 'admin') throw forbidden('Admin only');
    next();
  };
}

export function currentUser(req: { user?: AuthUser }): AuthUser {
  if (!req.user) throw unauthorized();
  return req.user;
}
