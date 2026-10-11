import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { AuthResponse, LoginRequest, LogoutRequest, RefreshRequest, RegisterRequest, uuidv7, type DeviceInfo, type UserDto } from '@trina/contracts';
import { Router } from 'express';
import { currentUser, newOpaqueToken, requireAuth, sha256, signAccessToken } from '../../platform/auth';
import type { AppContext } from '../../platform/context';
import type { Db } from '../../platform/db';
import { conflict, unauthorized } from '../../platform/errors';
import { parseBody } from '../../platform/http';
import { limiter } from '../../platform/middleware';

type UserRow = {
  id: string;
  email: string;
  password_hash: string;
  display_name: string;
  role: 'user' | 'admin';
  share_wellbeing: boolean;
  created_at: string;
  deleted_at: string | null;
};

export function toUserDto(u: UserRow): UserDto {
  return {
    id: u.id,
    email: u.email,
    displayName: u.display_name,
    role: u.role,
    shareWellbeing: u.share_wellbeing,
    createdAt: new Date(u.created_at).toISOString(),
  };
}

export async function hashPassword(ctx: AppContext, password: string): Promise<string> {
  return argonHash(password, { memoryCost: ctx.config.ARGON2_MEMORY_KIB, timeCost: ctx.config.ARGON2_TIME_COST, parallelism: 1 });
}

async function upsertDevice(db: Db, userId: string, d: DeviceInfo) {
  await db.query(
    `INSERT INTO devices (id, user_id, platform, app_version, os_version) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform,
       app_version = EXCLUDED.app_version, os_version = EXCLUDED.os_version, last_seen_at = now(), revoked_at = NULL`,
    [d.id, userId, d.platform, d.appVersion, d.osVersion ?? null],
  );
}

async function issueTokens(ctx: AppContext, db: Db, user: UserRow, deviceId: string, familyId = uuidv7()) {
  const refreshToken = newOpaqueToken();
  const expires = new Date(ctx.now().getTime() + ctx.config.REFRESH_TOKEN_TTL_DAYS * 86_400_000);
  await db.query(
    `INSERT INTO refresh_tokens (id, user_id, device_id, family_id, token_hash, expires_at) VALUES ($1, $2, $3, $4, $5, $6)`,
    [uuidv7(), user.id, deviceId, familyId, sha256(refreshToken), expires.toISOString()],
  );
  const accessToken = await signAccessToken(ctx, { id: user.id, role: user.role, deviceId });
  return AuthResponse.parse({ user: toUserDto(user), accessToken, refreshToken, expiresIn: ctx.config.ACCESS_TOKEN_TTL_S });
}

// Constant-cost dummy verification to reduce user-enumeration timing differences.
let dummyHash: string | null = null;

export function authRouter(ctx: AppContext): Router {
  const r = Router();
  const authLimit = limiter(ctx, { windowMs: 60_000, limit: 5 });
  const registerLimit = limiter(ctx, { windowMs: 3_600_000, limit: 10 });

  r.post('/register', registerLimit, async (req, res) => {
    const body = parseBody(RegisterRequest, req);
    const exists = await ctx.db.one('SELECT 1 FROM users WHERE email = $1', [body.email]);
    if (exists) throw conflict('EMAIL_TAKEN', 'An account with this email already exists');
    const passwordHash = await hashPassword(ctx, body.password);
    const result = await ctx.db.tx(async (t) => {
      const user = (await t.one<UserRow>(
        `INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, $2, $3, $4) RETURNING *`,
        [uuidv7(), body.email, passwordHash, body.displayName],
      ))!;
      await upsertDevice(t, user.id, body.device);
      return issueTokens(ctx, t, user, body.device.id);
    });
    res.status(201).json(result);
  });

  r.post('/login', authLimit, async (req, res) => {
    const body = parseBody(LoginRequest, req);
    const user = await ctx.db.one<UserRow>('SELECT * FROM users WHERE email = $1 AND deleted_at IS NULL', [body.email]);
    dummyHash ??= await hashPassword(ctx, 'dummy-password-for-timing');
    const ok = await argonVerify(user?.password_hash ?? dummyHash, body.password).catch(() => false);
    if (!user || !ok) throw unauthorized('Email or password is incorrect', 'INVALID_CREDENTIALS');
    const result = await ctx.db.tx(async (t) => {
      await upsertDevice(t, user.id, body.device);
      return issueTokens(ctx, t, user, body.device.id);
    });
    res.json(result);
  });

  r.post('/refresh', authLimit, async (req, res) => {
    const body = parseBody(RefreshRequest, req);
    const result = await ctx.db.tx(async (t) => {
      const row = await t.one<{
        id: string; user_id: string; device_id: string; family_id: string;
        expires_at: string; rotated_at: string | null; revoked_at: string | null;
      }>('SELECT * FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE', [sha256(body.refreshToken)]);
      if (!row) throw unauthorized('Invalid refresh token');
      if (row.rotated_at || row.revoked_at) {
        // Reuse of an old token: assume theft, revoke the whole family.
        await t.query(
          `UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, now()), revoked_reason = COALESCE(revoked_reason, 'reuse_detected') WHERE family_id = $1`,
          [row.family_id],
        );
        return { reused: true as const };
      }
      if (new Date(row.expires_at) <= ctx.now()) throw unauthorized('Refresh token expired', 'TOKEN_EXPIRED');
      if (row.device_id !== body.deviceId) throw unauthorized('Device mismatch');
      const device = await t.one<{ revoked_at: string | null }>('SELECT revoked_at FROM devices WHERE id = $1', [row.device_id]);
      if (!device || device.revoked_at) throw unauthorized('Device signed out');
      const user = await t.one<UserRow>('SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL', [row.user_id]);
      if (!user) throw unauthorized('Account not found');
      await t.query('UPDATE refresh_tokens SET rotated_at = now() WHERE id = $1', [row.id]);
      await t.query('UPDATE devices SET last_seen_at = now() WHERE id = $1', [row.device_id]);
      return { reused: false as const, tokens: await issueTokens(ctx, t, user, row.device_id, row.family_id) };
    });
    if (result.reused) throw unauthorized('Refresh token was already used; please sign in again', 'TOKEN_REUSED');
    res.json(result.tokens);
  });

  r.post('/logout', requireAuth(ctx), async (req, res) => {
    const body = parseBody(LogoutRequest, req);
    const me = currentUser(req);
    await ctx.db.query(
      `UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = 'logout'
       WHERE family_id = (SELECT family_id FROM refresh_tokens WHERE token_hash = $1 AND user_id = $2) AND revoked_at IS NULL`,
      [sha256(body.refreshToken), me.id],
    );
    res.status(204).end();
  });

  return r;
}
