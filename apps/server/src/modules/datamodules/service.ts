import { checkSafety, definitionHash, nameKey, sha256Hex, uuidv7, type CompileIssue, type ModuleDefinition } from '@trina/contracts';
import { compileModule, defaultRegistry, ENGINE_VERSION, RESERVED_MODULE_IDS, type ModuleDef, type ModuleRegistry } from '@trina/engine';
import type { AppContext } from '../../platform/context';
import type { Db } from '../../platform/db';
import { conflict, forbidden, HttpError, notFound } from '../../platform/errors';

export type ModuleRow = {
  id: string;
  owner_id: string | null;
  origin: 'official' | 'community';
  display_name: string;
  name_key: string;
  status: 'draft' | 'active' | 'suspended' | 'taken_down';
  visibility: 'private' | 'unlisted' | 'public';
  current_version: number;
  published_version: number | null;
  forked_from_id: string | null;
  forked_from_version: number | null;
  created_at: string;
};
export type ModuleVersionRow = {
  module_id: string;
  version: number;
  definition: ModuleDefinition;
  definition_hash: string;
  risk_level: 'ok' | 'note' | 'private_only';
  risk_report: unknown;
  published_at: string | null;
  created_by: string;
};

export const MODULE_CREATES_PER_DAY = 5;
export const MODULE_FORKS_PER_DAY = 10;
export const MAX_ACTIVE_MODULES = 30;
export const REPORTS_TO_SUSPEND = 3;

const OFFICIAL_NAME_KEYS = new Set(defaultRegistry.list().map((m) => nameKey(m.displayName)));

/** Custom (runtime) module refs of a challenge definition: anything the default registry doesn't know. */
export function customRefs(def: unknown): Array<{ id: string; version: number; definitionHash?: string }> {
  const mods = (def as { modules?: Array<{ id?: unknown; version?: unknown; definitionHash?: unknown }> })?.modules;
  if (!Array.isArray(mods)) return [];
  return mods
    .filter((m) => typeof m?.id === 'string' && !defaultRegistry.get(m.id))
    .map((m) => ({ id: String(m.id), version: Number(m.version) || 1, ...(typeof m.definitionHash === 'string' ? { definitionHash: m.definitionHash } : {}) }));
}

/** Compiles a stored module version (already validated on write; still re-checked here). */
export function compileStored(row: Pick<ModuleVersionRow, 'definition'>): ModuleDef {
  const r = compileModule(row.definition, { reservedIds: RESERVED_MODULE_IDS });
  if (!r.ok) throw new HttpError(422, 'COMPILE_FAILED', 'Stored module no longer compiles', r.issues.filter((i) => i.severity === 'error'));
  return r.module;
}

export async function getModule(db: Db, id: string): Promise<ModuleRow> {
  const m = await db.one<ModuleRow>('SELECT * FROM module_definitions WHERE id = $1', [id]);
  if (!m) throw notFound('Module');
  return m;
}

export async function getModuleVersion(db: Db, id: string, version: number): Promise<ModuleVersionRow> {
  const v = await db.one<ModuleVersionRow>('SELECT * FROM module_versions WHERE module_id = $1 AND version = $2', [id, version]);
  if (!v) throw notFound('Module version');
  return v;
}

/**
 * A registry for a challenge definition: built-in + official + exactly the custom module versions it
 * pins. `forCreator` enforces availability (taken down / suspended / someone else's private module).
 */
export async function registryForDefinition(db: Db, def: unknown, opts: { forCreator?: { id: string; role: string } } = {}): Promise<ModuleRegistry> {
  const refs = customRefs(def);
  if (!refs.length) return defaultRegistry;
  const extra: ModuleDef[] = [];
  for (const ref of refs) {
    const m = await db.one<ModuleRow>('SELECT * FROM module_definitions WHERE id = $1', [ref.id]);
    const v = m ? await db.one<ModuleVersionRow>('SELECT * FROM module_versions WHERE module_id = $1 AND version = $2', [ref.id, ref.version]) : null;
    if (!m || !v) continue; // compile reports "Unknown module"
    if (opts.forCreator) {
      if (m.status === 'taken_down' || m.status === 'suspended') throw new HttpError(409, 'MODULE_TAKEN_DOWN', `Module "${m.display_name}" is not available`);
      const owner = m.owner_id === opts.forCreator.id || opts.forCreator.role === 'admin';
      if (!owner && (m.visibility === 'private' || m.status !== 'active')) throw forbidden(`Module "${m.display_name}" is private`);
    }
    extra.push(compileStored(v));
  }
  return defaultRegistry.with(extra);
}

/** Custom module definitions to ship inside a challenge bundle (offline play). */
export async function bundleModules(db: Db, def: unknown) {
  const out: Array<{ id: string; version: number; definition: unknown; definitionHash: string }> = [];
  for (const ref of customRefs(def)) {
    const v = await db.one<ModuleVersionRow>('SELECT * FROM module_versions WHERE module_id = $1 AND version = $2', [ref.id, ref.version]);
    if (v) out.push({ id: ref.id, version: ref.version, definition: v.definition, definitionHash: v.definition_hash });
  }
  return out;
}

export function canView(m: ModuleRow, user: { id: string; role: string }): boolean {
  if (user.role === 'admin' || m.owner_id === user.id) return true;
  if (m.status === 'taken_down' || m.status === 'draft') return false;
  return m.visibility !== 'private';
}

type Validated = { definition: ModuleDefinition; hash: string; risk: ReturnType<typeof checkSafety>; issues: CompileIssue[]; milestones: Array<{ id: string; window: string; stat: string; verification: string; def: unknown }> };

/** Full validation of a module definition for storage (compile + safety + name rules). */
export function validateModule(input: unknown, opts: { id?: string; version: number; origin?: 'community' }): Validated {
  const raw = typeof input === 'object' && input ? { ...(input as Record<string, unknown>) } : input;
  if (raw && typeof raw === 'object') {
    // The server owns identity fields: version and origin are never taken from the client.
    (raw as Record<string, unknown>).version = opts.version;
    (raw as Record<string, unknown>).origin = 'community';
    if (opts.id) (raw as Record<string, unknown>).id = opts.id;
  }
  const r = compileModule(raw, { reservedIds: RESERVED_MODULE_IDS });
  if (!r.ok) {
    const blocked = r.risk?.level === 'blocked';
    throw new HttpError(422, blocked ? 'MODULE_UNSAFE' : 'COMPILE_FAILED', blocked ? 'This module is not safe to publish' : 'Module definition is not valid', r.issues.filter((i) => i.severity === 'error'));
  }
  if (OFFICIAL_NAME_KEYS.has(nameKey(r.definition.meta.displayName))) {
    throw new HttpError(409, 'MODULE_NAME_TAKEN', `"${r.definition.meta.displayName}" is the name of an official module; choose another name`);
  }
  if (RESERVED_MODULE_IDS.includes(r.definition.id)) throw new HttpError(409, 'MODULE_ID_RESERVED', 'This module id is reserved');
  return {
    definition: r.definition,
    hash: definitionHash(r.definition),
    risk: r.risk,
    issues: r.issues,
    milestones: r.milestones.map((m) => ({ id: m.def.id, window: m.def.window, stat: m.def.stat, verification: m.verification, def: m.def })),
  };
}

async function writeVersion(t: Db, moduleId: string, version: number, v: Validated, userId: string, aiGenerationId?: string) {
  await t.query(
    `INSERT INTO module_versions (module_id, version, definition, definition_hash, schema_version, engine_min_version, risk_level, risk_report, ai_generation_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (module_id, version) DO UPDATE SET definition = EXCLUDED.definition, definition_hash = EXCLUDED.definition_hash,
       risk_level = EXCLUDED.risk_level, risk_report = EXCLUDED.risk_report, created_at = now()`,
    [moduleId, version, JSON.stringify(v.definition), v.hash, v.definition.schemaVersion, ENGINE_VERSION, v.risk.level === 'blocked' ? 'private_only' : v.risk.level, JSON.stringify(v.risk), aiGenerationId ?? null, userId],
  );
  await t.query('DELETE FROM milestone_definitions WHERE module_id = $1 AND module_version = $2', [moduleId, version]);
  for (const m of v.milestones) {
    await t.query(
      'INSERT INTO milestone_definitions (module_id, module_version, milestone_id, window_kind, stat, verification, definition) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [moduleId, version, m.id, m.window, m.stat, m.verification, JSON.stringify(m.def)],
    );
  }
}

async function assertQuota(db: Db, userId: string, sinceSql: string, max: number, what: string, extraWhere = '') {
  const r = await db.one<{ n: string }>(`SELECT count(*) AS n FROM module_definitions WHERE owner_id = $1 AND created_at > now() - interval '${sinceSql}' ${extraWhere}`, [userId]);
  if (Number(r?.n ?? 0) >= max) throw new HttpError(429, 'QUOTA_EXCEEDED', `You can create ${max} ${what} per day`);
}

export async function createModule(ctx: AppContext, user: { id: string }, input: unknown, opts: { aiGenerationId?: string; forkedFrom?: { id: string; version: number } } = {}) {
  await assertQuota(ctx.db, user.id, '24 hours', opts.forkedFrom ? MODULE_FORKS_PER_DAY : MODULE_CREATES_PER_DAY, opts.forkedFrom ? 'forks' : 'modules', opts.forkedFrom ? 'AND forked_from_id IS NOT NULL' : 'AND forked_from_id IS NULL');
  const active = await ctx.db.one<{ n: string }>(`SELECT count(*) AS n FROM module_definitions WHERE owner_id = $1 AND status <> 'taken_down'`, [user.id]);
  if (Number(active?.n ?? 0) >= MAX_ACTIVE_MODULES) throw new HttpError(429, 'QUOTA_EXCEEDED', `You can keep up to ${MAX_ACTIVE_MODULES} modules`);
  const raw = typeof input === 'object' && input ? { ...(input as Record<string, unknown>), ...(opts.forkedFrom ? { forkedFrom: opts.forkedFrom } : {}) } : input;
  const v = validateModule(raw, { version: 1 });
  const id = v.definition.id;
  await ctx.db.tx(async (t) => {
    const existing = await t.one<ModuleRow>('SELECT * FROM module_definitions WHERE id = $1', [id]);
    if (existing) throw conflict('CONFLICT', 'A module with this id already exists');
    await t.query(
      `INSERT INTO module_definitions (id, owner_id, origin, display_name, name_key, status, visibility, current_version, forked_from_id, forked_from_version)
       VALUES ($1, $2, 'community', $3, $4, 'draft', 'private', 1, $5, $6)`,
      [id, user.id, v.definition.meta.displayName, nameKey(v.definition.meta.displayName), opts.forkedFrom?.id ?? null, opts.forkedFrom?.version ?? null],
    );
    await writeVersion(t, id, 1, v, user.id, opts.aiGenerationId);
    if (opts.aiGenerationId) await t.query('UPDATE ai_generations SET accepted = true WHERE id = $1 AND user_id = $2', [opts.aiGenerationId, user.id]);
    if (v.risk.level === 'private_only') {
      await t.query(`INSERT INTO moderation_cases (id, target_type, target_id, source, reason_code) VALUES ($1, 'module', $2, 'auto', $3)`, [uuidv7(), id, `private_only:${v.risk.concerns.join(',')}`]);
    }
  });
  return { id, version: 1, status: 'draft' as const, definition: v.definition, definitionHash: v.hash, risk: v.risk, issues: v.issues };
}

export async function updateModule(ctx: AppContext, user: { id: string; role: string }, id: string, input: unknown, baseVersion: number) {
  return ctx.db.tx(async (t) => {
    const m = await t.one<ModuleRow>('SELECT * FROM module_definitions WHERE id = $1 FOR UPDATE', [id]);
    if (!m) throw notFound('Module');
    if (m.owner_id !== user.id && user.role !== 'admin') throw forbidden('Only the owner can edit this module');
    if (m.status === 'taken_down') throw new HttpError(409, 'MODULE_TAKEN_DOWN', 'This module was taken down');
    if (baseVersion !== m.current_version) throw conflict('STALE_VERSION', `Module is at version ${m.current_version}; reload and retry`);
    // Drafts are edited in place; published modules get an immutable new version.
    const version = m.published_version === m.current_version ? m.current_version + 1 : m.current_version;
    const prev = await t.one<ModuleVersionRow>('SELECT * FROM module_versions WHERE module_id = $1 AND version = $2', [id, m.current_version]);
    const raw = typeof input === 'object' && input ? { ...(input as Record<string, unknown>), forkedFrom: prev?.definition.forkedFrom ?? null } : input;
    const v = validateModule(raw, { id, version });
    await writeVersion(t, id, version, v, user.id);
    await t.query('UPDATE module_definitions SET current_version = $2, display_name = $3, name_key = $4, updated_at = now() WHERE id = $1', [id, version, v.definition.meta.displayName, nameKey(v.definition.meta.displayName)]);
    return { id, version, definition: v.definition, definitionHash: v.hash, risk: v.risk, issues: v.issues };
  });
}

export async function publishModule(ctx: AppContext, user: { id: string; role: string }, id: string, version: number, visibility: 'private' | 'unlisted' | 'public') {
  if (visibility === 'public') throw new HttpError(403, 'PUBLIC_NOT_AVAILABLE', 'Public modules are not available yet; use private or unlisted (share by link)');
  return ctx.db.tx(async (t) => {
    const m = await t.one<ModuleRow>('SELECT * FROM module_definitions WHERE id = $1 FOR UPDATE', [id]);
    if (!m) throw notFound('Module');
    if (m.owner_id !== user.id && user.role !== 'admin') throw forbidden('Only the owner can publish this module');
    if (m.status === 'taken_down' || m.status === 'suspended') throw new HttpError(409, 'MODULE_TAKEN_DOWN', 'This module is not available');
    if (version !== m.current_version) throw conflict('STALE_VERSION', 'Publish the latest version');
    const v = await t.one<ModuleVersionRow>('SELECT * FROM module_versions WHERE module_id = $1 AND version = $2', [id, version]);
    if (!v) throw notFound('Module version');
    if (v.risk_level === 'private_only' && visibility !== 'private') {
      throw new HttpError(422, 'MODULE_UNSAFE', 'Because of a safety concern this module can only be played privately');
    }
    await t.query('UPDATE module_versions SET published_at = COALESCE(published_at, now()) WHERE module_id = $1 AND version = $2', [id, version]);
    await t.query(`UPDATE module_definitions SET status = 'active', visibility = $2, published_version = $3, updated_at = now() WHERE id = $1`, [id, visibility, version]);
    return { id, version, status: 'active' as const, visibility };
  });
}

/** Fork: copy a visible module version under a NEW id owned by the caller (re-validated from scratch). */
export async function forkModule(ctx: AppContext, user: { id: string; role: string }, id: string, fromVersion: number) {
  let source: ModuleDefinition;
  const official = defaultRegistry.get(id);
  if (official?.descriptor && official.origin === 'official') {
    if (fromVersion !== official.version) throw notFound('Module version');
    source = official.descriptor;
  } else {
    const m = await getModule(ctx.db, id);
    if (!canView(m, user) || m.status === 'taken_down') throw notFound('Module');
    source = (await getModuleVersion(ctx.db, id, fromVersion)).definition;
  }
  const slug = source.id.replace(/^u_/, '').replace(/_[0-9a-f]{4}$/, '').slice(0, 20) || 'module';
  const newId = `u_${slug}_${sha256Hex(`${user.id}|fork|${id}|${fromVersion}|${Date.now()}`).slice(0, 4)}`;
  const name = `${source.meta.displayName} (my version)`.slice(0, 40);
  // Ids referenced inside milestones (facts like <id>.<counter>) move to the new id.
  const json = JSON.stringify({ ...source, id: newId, meta: { ...source.meta, displayName: name } }).split(`"${source.id}.`).join(`"${newId}.`);
  return createModule(ctx, user, JSON.parse(json), { forkedFrom: { id, version: fromVersion } });
}

export async function reportModule(ctx: AppContext, user: { id: string }, id: string, reason: string, note?: string) {
  const m = await getModule(ctx.db, id);
  const today = await ctx.db.one<{ n: string }>(`SELECT count(*) AS n FROM module_reports WHERE reporter_id = $1 AND created_at > now() - interval '24 hours'`, [user.id]);
  if (Number(today?.n ?? 0) >= 5) throw new HttpError(429, 'QUOTA_EXCEEDED', 'You can send 5 reports per day');
  await ctx.db.query('INSERT INTO module_reports (id, module_id, reporter_id, reason, note) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (module_id, reporter_id) DO NOTHING', [uuidv7(), id, user.id, reason, note ?? null]);
  const n = Number((await ctx.db.one<{ n: string }>('SELECT count(*) AS n FROM module_reports WHERE module_id = $1', [id]))?.n ?? 0);
  const open = await ctx.db.one(`SELECT 1 FROM moderation_cases WHERE target_type = 'module' AND target_id = $1 AND status = 'open'`, [id]);
  if (!open) await ctx.db.query(`INSERT INTO moderation_cases (id, target_type, target_id, source, reason_code) VALUES ($1, 'module', $2, 'report', $3)`, [uuidv7(), id, reason]);
  if (n >= REPORTS_TO_SUSPEND && m.status === 'active') {
    await setModuleStatus(ctx, id, 'suspended', null, `auto: ${n} reports`);
  }
}

/** Status change + pull notice to the owner and everyone who joined a challenge using it. */
export async function setModuleStatus(ctx: AppContext, id: string, status: 'active' | 'suspended' | 'taken_down', actorId: string | null, note: string) {
  await ctx.db.query('UPDATE module_definitions SET status = $2, updated_at = now() WHERE id = $1', [id, status]);
  await ctx.db.query(`INSERT INTO audit_log (id, actor_id, action, target_type, target_id, details) VALUES ($1, $2, $3, 'module', $4, $5)`, [uuidv7(), actorId, `module_${status}`, id, JSON.stringify({ note })]);
  const users = await ctx.db.query<{ user_id: string }>(
    `SELECT DISTINCT cp.user_id FROM challenge_participants cp JOIN challenges c ON c.id = cp.challenge_id WHERE $1 = ANY(c.module_ids)
     UNION SELECT owner_id AS user_id FROM module_definitions WHERE id = $1 AND owner_id IS NOT NULL`,
    [id],
  );
  for (const u of users) {
    await ctx.db.query(`INSERT INTO user_changes (user_id, kind, ref_id, data) VALUES ($1, 'module_status', $2, $3)`, [u.user_id, uuidv7(), JSON.stringify({ moduleId: id, status })]);
  }
  // Challenges using a removed module are excluded from leaderboards (rebuilt lazily by the caller).
  return users.length;
}
