import type { Request } from 'express';
import type { z } from 'zod';
import { badRequest, zodToErrors } from './errors';

export function parseBody<T extends z.ZodType>(schema: T, req: Request): z.infer<T> {
  const r = schema.safeParse(req.body ?? {});
  if (!r.success) throw badRequest('Invalid request body', zodToErrors(r.error));
  return r.data;
}

export function parseQuery<T extends z.ZodType>(schema: T, req: Request): z.infer<T> {
  const r = schema.safeParse(req.query ?? {});
  if (!r.success) throw badRequest('Invalid query', zodToErrors(r.error));
  return r.data;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function uuidParam(req: Request, name: string): string {
  const v = req.params[name];
  if (typeof v !== 'string' || !UUID_RE.test(v)) throw badRequest(`Invalid ${name}`);
  return v.toLowerCase();
}

export const iso = (d: unknown): string | null => (d ? new Date(d as string).toISOString() : null);
