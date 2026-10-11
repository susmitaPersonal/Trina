import { uuidv7 } from '@trina/contracts';
import { compileOrThrow, defaultRegistry, destinationPoint } from '@trina/engine';
import { DEMO_CENTER, greenSprintDefinition } from '@trina/engine/fixtures';
import { z } from 'zod';
import type { AppContext } from './platform/context';
import { hashPassword } from './modules/auth/routes';
import { createChallenge } from './modules/challenges/service';

export const DEMO_USERS = [
  { email: 'organizer@trina.dev', password: 'touch-grass-2026', displayName: 'Priya (Organizer)', role: 'admin' as const },
  { email: 'arjun@trina.dev', password: 'touch-grass-2026', displayName: 'Arjun', role: 'user' as const },
];

/** Seeds modules, official templates and (in dev) demo users + a published Green Sprint 60. Idempotent. */
export async function seedIfEmpty(ctx: AppContext) {
  for (const m of defaultRegistry.list()) {
    await ctx.db.query(
      `INSERT INTO challenge_modules (id, version, display_name, params_schema) VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version, display_name = EXCLUDED.display_name, params_schema = EXCLUDED.params_schema`,
      [m.id, m.version, m.displayName, JSON.stringify(z.toJSONSchema(m.paramsSchema, { unrepresentable: 'any' }))],
    );
  }

  const tpl = await ctx.db.one('SELECT 1 FROM challenge_templates LIMIT 1');
  if (!tpl) {
    const gs = compileOrThrow(greenSprintDefinition()).definition;
    const walk = JSON.parse(JSON.stringify(gs));
    walk.meta = { ...walk.meta, title: 'Mindful Park Walk', description: 'An easy 30-minute walk with three mindful pauses.', difficulty: 'easy' };
    walk.modules = [{ id: 'walking', version: 1, params: {} }, { id: 'mindful', version: 1, params: {} }];
    walk.timing.durationMin = 30;
    walk.checkpoints = walk.checkpoints.slice(0, 2).map((c: any, i: number) => ({ ...c, geometry: { ...c.geometry, center: destinationPoint(DEMO_CENTER, i * 120, 250) } }));
    walk.route = { type: 'unordered', checkpointIds: walk.checkpoints.map((c: any) => c.id) };
    walk.tasks = [
      { id: 'pause', type: 'mindful.pause', params: {}, location: { kind: 'anywhere' }, evidence: [], required: false, scope: 'individual' },
      { id: 'notice', type: 'mindful.notice', params: {}, location: { kind: 'anywhere' }, evidence: [], required: false, scope: 'individual' },
    ];
    walk.scoring = {
      rules: [
        { id: 'cp', kind: 'per_checkpoint', points: 20 },
        { id: 'pause', kind: 'per_task', task: 'pause', points: 5 },
        { id: 'notice', kind: 'per_task', task: 'notice', points: 5 },
      ],
      bonuses: [],
      penalties: [],
      teamAggregation: 'sum',
    };
    walk.completion = { all: [{ fact: 'checkpoints.required_reached', op: '==', value: 'ALL' }], endZoneRequired: false };
    compileOrThrow(walk);
    for (const [title, def] of [
      ['Green Sprint 60', gs],
      ['Mindful Park Walk', walk],
    ] as const) {
      await ctx.db.query(`INSERT INTO challenge_templates (id, title, description, module_ids, definition) VALUES ($1, $2, $3, $4, $5)`, [
        uuidv7(), title, def.meta.description, def.modules.map((m: { id: string }) => m.id), JSON.stringify(def),
      ]);
    }
  }

  if (ctx.config.NODE_ENV !== 'development') return;
  // The Daily Quest system anchor (migration 3, @trina.invalid) is not a real user.
  const existing = await ctx.db.one(`SELECT 1 FROM users WHERE email NOT LIKE '%@trina.invalid' LIMIT 1`);
  if (existing) return;
  const ids: string[] = [];
  for (const u of DEMO_USERS) {
    const id = uuidv7();
    ids.push(id);
    await ctx.db.query('INSERT INTO users (id, email, password_hash, display_name, role, share_wellbeing) VALUES ($1, $2, $3, $4, $5, true)', [
      id, u.email, await hashPassword(ctx, u.password), u.displayName, u.role,
    ]);
  }
  const created = await createChallenge(ctx, ids[0]!, greenSprintDefinition());
  await ctx.db.query(`UPDATE challenges SET status = 'published', published_version = 1 WHERE id = $1`, [created.id]);
  ctx.logger.info({ users: DEMO_USERS.map((u) => u.email), challengeId: created.id }, 'seeded demo data (password: touch-grass-2026)');
}
