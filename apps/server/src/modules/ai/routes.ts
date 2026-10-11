import {
  createDraft,
  createModuleDraft,
  explainRules,
  finalizeDraft,
  ON_DEVICE_MODELS,
  patchDraft,
  PROMPT_VERSIONS,
  recap,
  shiftDifficulty,
  TemplateProvider,
  type DraftResult,
} from '@trina/ai';
import { AiDraftRequest, AiDraftResponse, AiRecapRequest, ModuleDraftRequest, ModuleDraftResponse, uuidv7, type ChallengeDefinition } from '@trina/contracts';
import { dayKeyOf } from '@trina/engine';
import { compileOrThrow, renderRules } from '@trina/engine';
import { Router } from 'express';
import { z } from 'zod';
import { currentUser, requireAuth } from '../../platform/auth';
import type { AppContext } from '../../platform/context';
import { badRequest, forbidden, notFound } from '../../platform/errors';
import { parseBody } from '../../platform/http';
import { limiter } from '../../platform/middleware';
import { assertCanView, getChallenge, getVersion } from '../challenges/service';

export function aiRouter(ctx: AppContext): Router {
  const r = Router();
  r.use(requireAuth(ctx));
  const aiLimit = limiter(ctx, { windowMs: 60_000, limit: 10, key: 'user' });

  r.post('/challenge-drafts', aiLimit, async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(AiDraftRequest, req);
    const start = body.context.startPoint;
    const started = Date.now();
    let drafts: Array<Pick<DraftResult, 'intent' | 'definition' | 'issues' | 'notes'>> = [];
    let provider = { id: ctx.llm.id, modelId: ctx.llm.modelId, locality: ctx.llm.capabilities.locality };
    let attempts = 1;
    let valid = true;
    let raw = '';

    if (body.mode === 'patch') {
      if (!body.baseIntent) throw badRequest('baseIntent is required for patch');
      const p = body.prompt.toLowerCase();
      const quick = /\b(easier|simpler|shorter)\b/.test(p) ? 'easier' : /\b(harder|longer|tougher)\b/.test(p) ? 'harder' : null;
      try {
        drafts = [await patchDraft(ctx.llm, body.baseIntent, body.prompt, { start })];
      } catch {
        if (!quick) throw badRequest('Could not apply that change. Try "easier", "harder" or edit it directly.');
        drafts = [finalizeDraft(shiftDifficulty(body.baseIntent, quick), start)];
        provider = { id: 'template', modelId: 'rules-v1', locality: 'none' };
        valid = false;
      }
    } else {
      const d = await createDraft(ctx.llm, body.prompt, { start });
      provider = d.provider;
      attempts = d.attempts;
      valid = !d.usedFallback;
      raw = d.rawOutput;
      drafts = [d];
      if (body.mode === 'variations') {
        drafts.push(finalizeDraft(shiftDifficulty(d.intent, 'easier'), start), finalizeDraft(shiftDifficulty(d.intent, 'harder'), start));
      }
    }

    const generationId = uuidv7();
    await ctx.db.query(
      `INSERT INTO ai_generations (id, user_id, kind, locality, provider, model_id, prompt_version, input_text, output_json, valid, repair_attempts, latency_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        generationId, me.id, body.mode, 'server', provider.id, provider.modelId,
        PROMPT_VERSIONS.intent, body.prompt, JSON.stringify({ intents: drafts.map((d) => d.intent), raw }), valid, Math.max(0, attempts - 1), Date.now() - started,
      ],
    );
    res.json(
      AiDraftResponse.parse({
        generationId,
        intents: drafts.map((d) => d.intent),
        definitions: drafts.map((d) => d.definition),
        issues: drafts[0]?.issues ?? [],
        notes: drafts[0]?.notes ?? [],
        provider,
      }),
    );
  });

  /** AI Module Builder (ADR-027): enums + labels from the model; everything else deterministic. 10 per day. */
  r.post('/module-drafts', aiLimit, limiter(ctx, { windowMs: 86_400_000, limit: 10, key: 'user' }), async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(ModuleDraftRequest, req);
    const d = await createModuleDraft(ctx.llm, body.prompt, { ownerSeed: me.id, dateKey: dayKeyOf(ctx.now().getTime(), 0) });
    const generationId = uuidv7();
    await ctx.db.query(
      `INSERT INTO ai_generations (id, user_id, kind, locality, provider, model_id, prompt_version, input_text, output_json, valid, repair_attempts, latency_ms)
       VALUES ($1, $2, 'module', $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [generationId, me.id, 'server', d.provider.id, d.provider.modelId, d.promptVersion, body.prompt, JSON.stringify({ status: d.status, intent: d.intent, raw: d.rawOutput }), d.status === 'ok' && !d.usedFallback, Math.max(0, d.attempts - 1), d.latencyMs],
    );
    res.json(
      ModuleDraftResponse.parse({
        generationId,
        status: d.status,
        refusal: d.refusal,
        intent: d.intent,
        definition: d.definition,
        issues: d.issues,
        risk: d.risk,
        notes: d.notes,
        usedFallback: d.usedFallback,
        provider: d.provider,
      }),
    );
  });

  r.get('/models', (_req, res) => {
    res.json(ON_DEVICE_MODELS);
  });

  // Opt-in telemetry for ON-DEVICE generations: metadata only, never the prompt text.
  r.post('/generations', async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(
      z.object({
        modelId: z.string().max(100),
        promptVersion: z.string().max(40),
        valid: z.boolean(),
        latencyMs: z.int().min(0).max(600_000),
        accepted: z.boolean().default(false),
      }),
      req,
    );
    await ctx.db.query(
      `INSERT INTO ai_generations (id, user_id, kind, locality, provider, model_id, prompt_version, valid, latency_ms, accepted)
       VALUES ($1, $2, 'draft', 'device', 'llama-rn', $3, $4, $5, $6, $7)`,
      [uuidv7(), me.id, body.modelId, body.promptVersion, body.valid, body.latencyMs, body.accepted],
    );
    res.status(204).end();
  });

  r.post('/recaps', aiLimit, async (req, res) => {
    const me = currentUser(req);
    const { sessionId } = parseBody(AiRecapRequest, req);
    const s = await ctx.db.one<any>(
      `SELECT s.user_id, c.title, sc.total_points, sc.distance_m, sc.duration_s, w.steps, w.kcal_estimate, w.phone_free_minutes, w.mood_before, w.mood_after
       FROM activity_sessions s JOIN challenges c ON c.id = s.challenge_id
       LEFT JOIN scores sc ON sc.session_id = s.id LEFT JOIN session_wellness w ON w.session_id = s.id WHERE s.id = $1`,
      [sessionId],
    );
    if (!s) throw notFound('Session');
    if (s.user_id !== me.id) throw forbidden('Not your session');
    if (s.total_points === null) throw badRequest('Results are not ready yet');
    // Numbers come from the database (engine output); the client cannot supply them.
    const out = await recap(ctx.llm, {
      title: s.title,
      points: s.total_points,
      distanceKm: Math.round(s.distance_m / 100) / 10,
      minutes: Math.round(s.duration_s / 60),
      steps: s.steps,
      kcalEstimate: s.kcal_estimate,
      phoneFreeMinutes: s.phone_free_minutes,
      moodBefore: s.mood_before,
      moodAfter: s.mood_after,
    });
    res.json(out);
  });

  r.post('/explain', aiLimit, async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(z.object({ challengeId: z.uuid(), question: z.string().trim().min(2).max(300).default('Explain the rules simply') }), req);
    const c = await getChallenge(ctx.db, body.challengeId);
    await assertCanView(ctx.db, c, me);
    const v = await getVersion(ctx.db, c.id, c.published_version ?? c.current_version);
    const rules = renderRules(compileOrThrow(v.definition as ChallengeDefinition));
    const out = await explainRules(ctx.llm, rules, body.question);
    res.json({ ...out, officialRules: rules });
  });

  return r;
}

export { TemplateProvider };
