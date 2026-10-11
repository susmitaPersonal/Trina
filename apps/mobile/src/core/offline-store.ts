import { compileModuleOrThrow, compileOrThrow, defaultRegistry, type CompiledChallenge, type ModuleDef, type ModuleRegistry } from '@trina/engine';
import type { BundleDto } from '@trina/contracts';
import { json, type SqlDb } from './sql';

export type StoredChallenge = {
  id: string;
  version: number;
  title: string;
  definitionHash: string;
  maxScore: number;
  engineMinVersion: number;
  teamId: string | null;
  clockOffsetMs: number;
  downloadedAt: string;
  stale: boolean;
  bundle: BundleDto;
};

/** Registry for a bundle: built-in + official + the custom module versions it ships (design §7.2). */
export function registryForBundle(bundle: Pick<BundleDto, 'modules'>): ModuleRegistry {
  const mods: ModuleDef[] = (bundle.modules ?? []).map((m) => compileModuleOrThrow(m.definition));
  return mods.length ? defaultRegistry.with(mods) : defaultRegistry;
}

/** Cached challenge bundles + key/value meta. Everything needed to play offline. */
export class OfflineStore {
  private compiledCache = new Map<string, CompiledChallenge>();

  constructor(private readonly db: SqlDb) {}

  async getMeta(key: string): Promise<string | null> {
    return (await this.db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', [key]))?.value ?? null;
  }

  async setMeta(key: string, value: string | null): Promise<void> {
    if (value === null) await this.db.run('DELETE FROM meta WHERE key = ?', [key]);
    else await this.db.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value]);
  }

  /** Saves a downloaded bundle. `deviceNowMs` is used to record the server clock offset. */
  async saveBundle(bundle: BundleDto, deviceNowMs: number): Promise<StoredChallenge> {
    compileOrThrow(bundle.definition, registryForBundle(bundle)); // never store something we can't play
    const offset = Date.parse(bundle.serverTime) - deviceNowMs;
    for (const m of bundle.modules ?? []) {
      await this.db.run(
        `INSERT INTO module_defs (id, version, origin, definition_json, definition_hash, status, fetched_at) VALUES (?, ?, 'community', ?, ?, 'active', ?)
         ON CONFLICT(id, version) DO UPDATE SET definition_json = excluded.definition_json, definition_hash = excluded.definition_hash, fetched_at = excluded.fetched_at`,
        [m.id, m.version, JSON.stringify(m.definition), m.definitionHash, new Date(deviceNowMs).toISOString()],
      );
    }
    await this.db.run(
      `INSERT INTO challenges (id, version, title, definition_json, definition_hash, max_score, engine_min_version, bundle_json, team_id, clock_offset_ms, downloaded_at, offline_ready, stale)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0)
       ON CONFLICT(id, version) DO UPDATE SET bundle_json = excluded.bundle_json, team_id = excluded.team_id,
         clock_offset_ms = excluded.clock_offset_ms, downloaded_at = excluded.downloaded_at, stale = 0`,
      [
        bundle.challengeId, bundle.version, bundle.definition.meta.title, JSON.stringify(bundle.definition), bundle.definitionHash,
        bundle.maxScore, bundle.engineMinVersion, JSON.stringify(bundle), bundle.participation.teamId, offset, new Date(deviceNowMs).toISOString(),
      ],
    );
    await this.setMeta('server_clock_offset_ms', String(offset));
    return (await this.getChallenge(bundle.challengeId, bundle.version))!;
  }

  private row(r: Record<string, unknown>): StoredChallenge {
    return {
      id: String(r.id),
      version: Number(r.version),
      title: String(r.title),
      definitionHash: String(r.definition_hash),
      maxScore: Number(r.max_score),
      engineMinVersion: Number(r.engine_min_version),
      teamId: (r.team_id as string | null) ?? null,
      clockOffsetMs: Number(r.clock_offset_ms),
      downloadedAt: String(r.downloaded_at),
      stale: Number(r.stale) === 1,
      bundle: json<BundleDto>(r.bundle_json, null as unknown as BundleDto),
    };
  }

  async getChallenge(id: string, version?: number): Promise<StoredChallenge | null> {
    const r = version
      ? await this.db.get('SELECT * FROM challenges WHERE id = ? AND version = ?', [id, version])
      : await this.db.get('SELECT * FROM challenges WHERE id = ? ORDER BY version DESC LIMIT 1', [id]);
    return r ? this.row(r) : null;
  }

  async listDownloaded(): Promise<StoredChallenge[]> {
    const rows = await this.db.all(
      'SELECT c.* FROM challenges c WHERE c.version = (SELECT max(version) FROM challenges c2 WHERE c2.id = c.id) ORDER BY downloaded_at DESC',
    );
    return rows.map((r) => this.row(r));
  }

  async markStale(id: string) {
    await this.db.run('UPDATE challenges SET stale = 1 WHERE id = ?', [id]);
  }

  compiled(c: StoredChallenge): CompiledChallenge {
    const key = `${c.id}:${c.version}`;
    let v = this.compiledCache.get(key);
    if (!v) {
      v = compileOrThrow(c.bundle.definition, registryForBundle(c.bundle));
      this.compiledCache.set(key, v);
    }
    return v;
  }

  /**
   * Records who is signed in. When a DIFFERENT account signs in on this phone, per-user caches
   * (milestones, progress, guilds, pull cursor, device-key registration) are reset so nobody sees
   * someone else's data; unsynced events and photos are never touched (rule 5). Returns true on a switch.
   */
  async onSignIn(userId: string): Promise<boolean> {
    const prev = await this.getMeta('signed_in_user_id');
    await this.setMeta('signed_in_user_id', userId);
    if (!prev || prev === userId) return false;
    await this.db.tx(async (t) => {
      await t.run('DELETE FROM milestone_progress');
      await t.run('DELETE FROM progress');
      await t.run('DELETE FROM cache_guilds');
      await t.run(`DELETE FROM meta WHERE key IN ('pull_cursor', 'device_key_registered', 'last_sync_at')`);
      // Fetch this account's final milestones on the next sync.
      await t.run(`INSERT INTO meta (key, value) VALUES ('milestones_reconcile_pending', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
    });
    return true;
  }

  /** Custom modules stored on this phone (from bundles or the player's own drafts). */
  async customModules(): Promise<ModuleDef[]> {
    const rows = await this.db.all<{ definition_json: string; status: string }>(
      `SELECT d.definition_json, d.status FROM module_defs d WHERE d.version = (SELECT max(version) FROM module_defs x WHERE x.id = d.id)`,
    );
    const out: ModuleDef[] = [];
    for (const r of rows) {
      try {
        out.push(compileModuleOrThrow(JSON.parse(r.definition_json)));
      } catch {
        /* a module that no longer compiles is simply not offered */
      }
    }
    return out;
  }

  async saveModule(m: { id: string; version: number; definition: unknown; definitionHash: string }, nowMs: number) {
    await this.db.run(
      `INSERT INTO module_defs (id, version, origin, definition_json, definition_hash, status, fetched_at) VALUES (?, ?, 'community', ?, ?, 'active', ?)
       ON CONFLICT(id, version) DO UPDATE SET definition_json = excluded.definition_json, definition_hash = excluded.definition_hash, fetched_at = excluded.fetched_at`,
      [m.id, m.version, JSON.stringify(m.definition), m.definitionHash, new Date(nowMs).toISOString()],
    );
  }

  /** Takedown / suspension from the server: new sessions with this module are blocked (in-progress ones continue). */
  async setModuleStatus(moduleId: string, status: 'active' | 'suspended' | 'taken_down') {
    await this.db.run('UPDATE module_defs SET status = ? WHERE id = ?', [status, moduleId]);
  }

  async moduleStatus(moduleId: string): Promise<string | null> {
    return (await this.db.get<{ status: string }>('SELECT status FROM module_defs WHERE id = ? ORDER BY version DESC LIMIT 1', [moduleId]))?.status ?? null;
  }

  async cacheLeaderboard(challengeId: string, scope: string, data: unknown) {
    await this.db.run(
      `INSERT INTO cache_leaderboards (challenge_id, scope, json, fetched_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(challenge_id, scope) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at`,
      [challengeId, scope, JSON.stringify(data), new Date().toISOString()],
    );
  }

  async cachedLeaderboard<T>(challengeId: string, scope: string): Promise<{ data: T; fetchedAt: string } | null> {
    const r = await this.db.get<{ json: string; fetched_at: string }>('SELECT json, fetched_at FROM cache_leaderboards WHERE challenge_id = ? AND scope = ?', [challengeId, scope]);
    return r ? { data: JSON.parse(r.json) as T, fetchedAt: r.fetched_at } : null;
  }
}
