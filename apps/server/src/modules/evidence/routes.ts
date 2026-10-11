import { createHmac, timingSafeEqual } from 'node:crypto';
import { uuidv7 } from '@trina/contracts';
import express, { Router } from 'express';
import sharp from 'sharp';
import { z } from 'zod';
import { currentUser, requireAuth, sha256 } from '../../platform/auth';
import type { AppContext } from '../../platform/context';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../../platform/errors';
import { parseQuery, uuidParam } from '../../platform/http';
import { limiter } from '../../platform/middleware';
import { maybeEnqueueValidation } from '../sync/ingest';

export const MAX_EVIDENCE_BYTES = 5 * 1024 * 1024;

export function sniffImage(buf: Buffer): 'image/jpeg' | 'image/webp' | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function sign(secret: string, id: string, exp: number) {
  return createHmac('sha256', secret).update(`${id}.${exp}`).digest('base64url');
}

type EvidenceRow = {
  id: string;
  session_id: string;
  user_id: string;
  sha256: string;
  upload_status: string;
  storage_key: string | null;
  task_id: string;
  mime: string;
  width: number | null;
  height: number | null;
  captured_at_client: string;
  deleted_at: string | null;
};

async function canView(ctx: AppContext, ev: EvidenceRow, user: { id: string; role: string }) {
  if (ev.user_id === user.id || user.role === 'admin') return true;
  const c = await ctx.db.one<{ creator_id: string }>(
    'SELECT c.creator_id FROM activity_sessions s JOIN challenges c ON c.id = s.challenge_id WHERE s.id = $1',
    [ev.session_id],
  );
  return c?.creator_id === user.id;
}

export function evidenceRouter(ctx: AppContext): Router {
  const r = Router();

  // Signed, short-lived file URL (no bearer header needed, e.g. for <Image> components).
  r.get('/:id/file', async (req, res) => {
    const id = uuidParam(req, 'id');
    const q = parseQuery(z.object({ exp: z.coerce.number().int(), sig: z.string().max(100) }), req);
    const expected = Buffer.from(sign(ctx.config.JWT_SECRET, id, q.exp));
    const given = Buffer.from(q.sig);
    if (q.exp < Math.floor(ctx.now().getTime() / 1000) || expected.length !== given.length || !timingSafeEqual(expected, given)) {
      throw forbidden('Link expired or invalid');
    }
    const ev = await ctx.db.one<EvidenceRow>('SELECT * FROM evidence WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!ev?.storage_key) throw notFound('Evidence');
    const data = await ctx.storage.get(`evidence/web/${id}.jpg`);
    if (!data) throw notFound('Evidence');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.type('image/jpeg').send(data);
  });

  r.use(requireAuth(ctx));

  r.put(
    '/:id/content',
    limiter(ctx, { windowMs: 60_000, limit: 30, key: 'user' }),
    express.raw({ type: () => true, limit: MAX_EVIDENCE_BYTES }),
    async (req, res) => {
      const me = currentUser(req);
      const id = uuidParam(req, 'id');
      const body = req.body as Buffer;
      if (!Buffer.isBuffer(body) || body.length === 0) throw badRequest('Empty body');
      const declared = (req.header('content-type') ?? '').split(';')[0]!.trim();
      if (declared !== 'image/jpeg' && declared !== 'image/webp') throw new HttpError(415, 'UNSUPPORTED_MEDIA', 'Only image/jpeg or image/webp');
      const sniffed = sniffImage(body);
      if (!sniffed || sniffed !== declared) throw new HttpError(415, 'UNSUPPORTED_MEDIA', 'File content does not match its type');

      const ev = await ctx.db.one<EvidenceRow>('SELECT * FROM evidence WHERE id = $1', [id]);
      if (!ev) throw notFound('Evidence (push activity events before uploading photos)');
      if (ev.user_id !== me.id) throw forbidden('Not your evidence');

      const actual = sha256(body);
      const header = req.header('x-content-sha256')?.toLowerCase();
      if (header && header !== actual) throw badRequest('X-Content-SHA256 does not match the uploaded bytes');
      if (actual !== ev.sha256) {
        await ctx.db.query(
          `INSERT INTO audit_log (id, action, target_type, target_id, details) VALUES ($1, 'ingest_anomaly', 'session', $2, $3)`,
          [uuidv7(), ev.session_id, JSON.stringify({ code: 'EVIDENCE_HASH_MISMATCH', evidenceId: id })],
        );
        throw conflict('HASH_CONFLICT', 'Photo does not match the hash recorded when it was captured');
      }
      if (ev.upload_status !== 'pending') {
        res.status(200).json({ status: ev.upload_status });
        return;
      }

      let meta: sharp.Metadata;
      let web: Buffer;
      try {
        const img = sharp(body, { failOn: 'error' });
        meta = await img.metadata();
        // Re-encode: strips EXIF/GPS metadata and neutralises polyglot files.
        web = await sharp(body).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
      } catch {
        throw new HttpError(422, 'UNSUPPORTED_MEDIA', 'Image could not be decoded');
      }
      await ctx.storage.put(`evidence/orig/${id}`, body, declared);
      await ctx.storage.put(`evidence/web/${id}.jpg`, web, 'image/jpeg');
      await ctx.db.query(
        `UPDATE evidence SET upload_status = 'uploaded', uploaded_at = now(), storage_key = $2, width = $3, height = $4 WHERE id = $1`,
        [id, `evidence/orig/${id}`, meta.width ?? null, meta.height ?? null],
      );
      await maybeEnqueueValidation(ctx, ev.session_id);
      res.status(201).json({ status: 'uploaded' });
    },
  );

  r.get('/:id', async (req, res) => {
    const me = currentUser(req);
    const id = uuidParam(req, 'id');
    const ev = await ctx.db.one<EvidenceRow>('SELECT * FROM evidence WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!ev || !(await canView(ctx, ev, me))) throw notFound('Evidence');
    const exp = Math.floor(ctx.now().getTime() / 1000) + 300;
    res.json({
      meta: { id: ev.id, taskId: ev.task_id, uploadStatus: ev.upload_status, width: ev.width, height: ev.height, capturedAt: new Date(ev.captured_at_client).toISOString() },
      url: ev.storage_key ? `${ctx.config.PUBLIC_BASE_URL}/v1/evidence/${id}/file?exp=${exp}&sig=${sign(ctx.config.JWT_SECRET, id, exp)}` : null,
    });
  });

  return r;
}
