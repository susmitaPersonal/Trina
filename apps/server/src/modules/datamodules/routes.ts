import {
  CreateModuleRequest,
  type ModuleDefinition,
  ForkModuleRequest,
  ModerationDecisionRequest,
  PatchModuleRequest,
  PublishModuleRequest,
  ReportModuleRequest,
  type ModuleSummaryDto,
  type ModuleVersionDto,
} from '@trina/contracts';
import { defaultRegistry } from '@trina/engine';
import { Router } from 'express';
import { z } from 'zod';
import { currentUser, requireAdmin, requireAuth } from '../../platform/auth';
import type { AppContext } from '../../platform/context';
import { badRequest, HttpError, notFound } from '../../platform/errors';
import { iso, parseBody, parseQuery } from '../../platform/http';
import { idempotent, limiter } from '../../platform/middleware';
import { rebuildLeaderboard } from '../scoring/leaderboard';
import { canView, createModule, forkModule, getModule, getModuleVersion, publishModule, reportModule, setModuleStatus, updateModule, type ModuleRow } from './service';

const ModuleId = z.string().regex(/^[a-z][a-z0-9_]{2,31}$/);
const moduleParam = (v: unknown) => {
  const r = ModuleId.safeParse(v);
  if (!r.success) throw badRequest('Invalid module id');
  return r.data;
};

export function dataModulesRouter(ctx: AppContext): Router {
  const r = Router();
  // Auth only on this router's own paths, so unknown /v1 routes still answer 404.
  r.use('/modules', requireAuth(ctx));
  const day = 24 * 3_600_000;

  /** Built-in + official modules, the caller's own, and unlisted ones used by challenges the caller joined. */
  r.get('/modules', async (req, res) => {
    const me = currentUser(req);
    const builtins: ModuleSummaryDto[] = defaultRegistry.list().map((m) => ({
      id: m.id,
      version: m.version,
      origin: m.origin ?? 'builtin',
      displayName: m.displayName,
      icon: m.descriptor?.meta.icon ?? m.icon,
      movement: m.descriptor?.movement ?? null,
      venue: m.descriptor?.venue ?? null,
      status: 'active',
      visibility: 'public',
      ownerName: null,
      mine: false,
      taskTypes: m.taskTypes.map((t) => ({ id: `${m.id}.${t.id}`, displayName: t.displayName, completion: t.completion })),
    }));
    const rows = await ctx.db.query<ModuleRow & { definition: ModuleDefinition | null; owner_name: string | null }>(
      `SELECT d.*, v.definition, u.display_name AS owner_name FROM module_definitions d
       JOIN module_versions v ON v.module_id = d.id AND v.version = d.current_version
       LEFT JOIN users u ON u.id = d.owner_id
       WHERE d.owner_id = $1
          OR (d.status = 'active' AND d.visibility <> 'private' AND EXISTS (
                SELECT 1 FROM challenge_participants cp JOIN challenges c ON c.id = cp.challenge_id
                WHERE cp.user_id = $1 AND d.id = ANY(c.module_ids)))
       ORDER BY d.created_at DESC LIMIT 100`,
      [me.id],
    );
    const mine: ModuleSummaryDto[] = rows.map((m) => ({
      id: m.id,
      version: m.current_version,
      origin: 'community',
      displayName: m.display_name,
      icon: m.definition?.meta?.icon ?? 'star',
      movement: m.definition?.movement ?? null,
      venue: m.definition?.venue ?? null,
      status: m.status,
      visibility: m.visibility,
      ownerName: m.owner_name,
      mine: m.owner_id === me.id,
      taskTypes: (m.definition?.taskTypes ?? []).map((t) => ({ id: `${m.id}.${t.id}`, displayName: t.displayName, completion: t.completion })),
    }));
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.json([...builtins, ...mine]);
  });

  r.get('/modules/:id/versions/:v', async (req, res) => {
    const me = currentUser(req);
    const id = moduleParam(req.params.id);
    const version = Number.parseInt(String(req.params.v), 10);
    if (!Number.isInteger(version) || version < 1) throw badRequest('Invalid version');
    const official = defaultRegistry.get(id);
    if (official) {
      if (version !== official.version) throw notFound('Module version');
      const dto: ModuleVersionDto = {
        id, version, status: 'active', visibility: 'public', definition: official.descriptor, definitionHash: official.definitionHash ?? '0'.repeat(64),
        risk: { level: 'ok', findings: [], notes: [], concerns: [] }, owner: null, forkedFrom: null, publishedAt: null, mine: false,
      };
      res.json(dto);
      return;
    }
    const m = await getModule(ctx.db, id);
    if (m.status === 'taken_down' && m.owner_id !== me.id && me.role !== 'admin') throw new HttpError(410, 'MODULE_TAKEN_DOWN', 'This module was taken down');
    if (!canView(m, me)) throw notFound('Module');
    const v = await getModuleVersion(ctx.db, id, version);
    const owner = m.owner_id ? await ctx.db.one<{ display_name: string }>('SELECT display_name FROM users WHERE id = $1', [m.owner_id]) : null;
    const dto: ModuleVersionDto = {
      id,
      version,
      status: m.status,
      visibility: m.visibility,
      definition: v.definition,
      definitionHash: v.definition_hash,
      risk: v.risk_report as ModuleVersionDto['risk'],
      owner: owner ? { displayName: owner.display_name } : null,
      forkedFrom: m.forked_from_id ? { id: m.forked_from_id, version: m.forked_from_version ?? 1 } : null,
      publishedAt: iso(v.published_at),
      mine: m.owner_id === me.id,
    };
    res.json(dto);
  });

  r.post('/modules', idempotent(ctx, { required: true }), async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(CreateModuleRequest, req);
    const out = await createModule(ctx, me, body.definition, { aiGenerationId: body.aiGenerationId });
    res.status(201).json({ id: out.id, version: out.version, status: out.status, definition: out.definition, definitionHash: out.definitionHash, risk: out.risk, validation: { issues: out.issues } });
  });

  r.patch('/modules/:id', async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(PatchModuleRequest, req);
    const out = await updateModule(ctx, me, moduleParam(req.params.id), body.definition, body.baseVersion);
    res.json({ id: out.id, version: out.version, definition: out.definition, definitionHash: out.definitionHash, risk: out.risk, validation: { issues: out.issues } });
  });

  r.post('/modules/:id/publish', async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(PublishModuleRequest, req);
    res.json(await publishModule(ctx, me, moduleParam(req.params.id), body.version, body.visibility));
  });

  r.post('/modules/:id/fork', limiter(ctx, { windowMs: day, limit: 10, key: 'user' }), idempotent(ctx), async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(ForkModuleRequest, req);
    const out = await forkModule(ctx, me, moduleParam(req.params.id), body.fromVersion);
    res.status(201).json({ id: out.id, version: out.version, status: out.status, definition: out.definition, definitionHash: out.definitionHash, risk: out.risk });
  });

  r.post('/modules/:id/report', limiter(ctx, { windowMs: day, limit: 5, key: 'user' }), async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(ReportModuleRequest, req);
    await reportModule(ctx, me, moduleParam(req.params.id), body.reason, body.note);
    res.status(202).json({ received: true });
  });

  return r;
}

export function moderationRouter(ctx: AppContext): Router {
  const r = Router();
  r.use(requireAuth(ctx), requireAdmin());

  r.get('/moderation', async (req, res) => {
    const q = parseQuery(z.object({ status: z.enum(['open', 'all']).default('open') }), req);
    type CaseRow = { id: string; target_type: string; target_id: string; source: string; reason_code: string; status: string; created_at: string; display_name: string | null; module_status: string | null; visibility: string | null; definition: unknown; risk_report: unknown; reports: string | number | null };
    const rows = await ctx.db.query<CaseRow>(
      `SELECT mc.*, d.display_name, d.status AS module_status, d.visibility, v.definition, v.risk_report,
              (SELECT count(*) FROM module_reports r WHERE r.module_id = mc.target_id) AS reports
       FROM moderation_cases mc LEFT JOIN module_definitions d ON d.id = mc.target_id AND mc.target_type = 'module'
       LEFT JOIN module_versions v ON v.module_id = d.id AND v.version = d.current_version
       WHERE ($1 = 'all' OR mc.status = 'open') ORDER BY mc.created_at DESC LIMIT 100`,
      [q.status],
    );
    res.json({
      items: rows.map((c) => ({
        id: c.id, targetType: c.target_type, targetId: c.target_id, source: c.source, reasonCode: c.reason_code, status: c.status,
        module: c.display_name ? { displayName: c.display_name, status: c.module_status, visibility: c.visibility, definition: c.definition, risk: c.risk_report } : null,
        reports: Number(c.reports ?? 0), createdAt: iso(c.created_at),
      })),
    });
  });

  r.post('/moderation/:id/decision', async (req, res) => {
    const me = currentUser(req);
    const id = String(req.params.id);
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw badRequest('Invalid case id');
    const body = parseBody(ModerationDecisionRequest, req);
    const c = await ctx.db.one<{ target_type: string; target_id: string }>('SELECT target_type, target_id FROM moderation_cases WHERE id = $1', [id]);
    if (!c) throw notFound('Case');
    if (c.target_type === 'module' && body.decision !== 'dismiss') {
      const status = body.decision === 'restore' ? 'active' : body.decision === 'suspend' ? 'suspended' : 'taken_down';
      await setModuleStatus(ctx, c.target_id, status, me.id, body.note);
      const challenges = await ctx.db.query<{ id: string }>('SELECT id FROM challenges WHERE $1 = ANY(module_ids)', [c.target_id]);
      for (const ch of challenges) await rebuildLeaderboard(ctx, ch.id);
    }
    await ctx.db.query(`UPDATE moderation_cases SET status = $2, decided_by = $3, decision = $4, note = $5, decided_at = now() WHERE id = $1`, [
      id, body.decision === 'dismiss' ? 'dismissed' : 'actioned', me.id, body.decision, body.note,
    ]);
    res.json({ status: body.decision === 'dismiss' ? 'dismissed' : 'actioned' });
  });

  r.post('/modules/:id/takedown', async (req, res) => {
    const me = currentUser(req);
    const id = moduleParam(req.params.id);
    const body = parseBody(z.object({ reason: z.string().min(3).max(500) }), req);
    await getModule(ctx.db, id);
    await setModuleStatus(ctx, id, 'taken_down', me.id, body.reason);
    const challenges = await ctx.db.query<{ id: string }>('SELECT id FROM challenges WHERE $1 = ANY(module_ids)', [id]);
    for (const ch of challenges) await rebuildLeaderboard(ctx, ch.id);
    res.json({ status: 'taken_down' });
  });

  return r;
}
