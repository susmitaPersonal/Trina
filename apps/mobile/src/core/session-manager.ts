import {
  computeEventHash,
  definitionHash,
  EVENT_SCHEMA_VERSION,
  genesisHash,
  uuidv7,
  type ActivityEvent,
  type EventType,
  type Fix,
  type LocationSample,
  type PayloadOf,
} from '@trina/contracts';
import {
  buildQuestDefinition,
  compileOrThrow,
  DAILY_QUEST_CHALLENGE_ID,
  ENGINE_VERSION,
  evaluate,
  fold,
  renderRules,
  summarizeSession,
  type QuestSpec,
  wellness,
  withLiveSamples,
  type CompiledChallenge,
  type ScoreResult,
  type SessionState,
  type WellnessResult,
} from '@trina/engine';
import { SessionClock, type Clock } from './clock';
import type { LocalMilestone, MilestoneService } from './milestones';
import type { OfflineStore, StoredChallenge } from './offline-store';
import { json, type SqlDb } from './sql';

export const FLUSH_SAMPLE_COUNT = 30;
export const FLUSH_MAX_AGE_MS = 60_000;

/** A raw GPS fix from the platform (wall-clock timestamp in ms). */
export type RawFix = { lat: number; lng: number; acc: number; timestamp: number; speed?: number | null; heading?: number | null; alt?: number | null; mocked?: boolean };

export type LiveSnapshot = {
  sessionId: string;
  challenge: StoredChallenge;
  compiled: CompiledChallenge;
  state: SessionState;
  score: ScoreResult;
  wellness: WellnessResult;
  nowMono: number;
  remainingMs: number;
};

type SessionRow = {
  id: string; challenge_id: string; challenge_version: number; user_id: string; status: string; started_wall: string;
  last_seq: number; chain_head: string; last_mono: number; last_wall_ms: number; wellness_json: string | null;
  quest_json?: string | null; quest_definition_json?: string | null;
};

/** Encouragement for quests (no server bundle): short, warm, never shaming. */
const QUEST_LINES = [
  { trigger: 'start', text: 'Quest started. Internet off, eyes up. 🌱' },
  { trigger: 'halfway', text: 'Halfway there. Enjoy the green.' },
  { trigger: 'last_ten_minutes', text: 'Ten minutes left. No rush.' },
  { trigger: 'finish', text: 'Quest complete! Turn the internet on whenever you like to sync.' },
];

export class SessionError extends Error {}

/**
 * Owns the append-only, hash-chained event log on the device.
 * Every user action is committed to SQLite BEFORE the UI confirms it (AGENTS.md rule 5).
 */
export class SessionManager {
  private clocks = new Map<string, SessionClock>();
  private questCache = new Map<string, { challenge: StoredChallenge; compiled: CompiledChallenge }>();

  constructor(
    private readonly db: SqlDb,
    private readonly store: OfflineStore,
    private readonly clock: Clock,
    private readonly ids: { userId: string; deviceId: string },
    private readonly extras: { milestones?: MilestoneService; tzOffsetMin?: () => number } = {},
  ) {}

  /** Local UTC offset (minutes east) recorded in SessionStarted for the day key (ADR-025). */
  private tz(): number {
    return this.extras.tzOffsetMin?.() ?? -new Date(this.clock.wallNow()).getTimezoneOffset();
  }

  /** Challenge + compiled rules for a session (quests are rebuilt from their stored definition). */
  private async ruleset(r: SessionRow): Promise<{ challenge: StoredChallenge; compiled: CompiledChallenge }> {
    if (r.quest_definition_json) {
      let q = this.questCache.get(r.id);
      if (!q) {
        const compiled = compileOrThrow(JSON.parse(r.quest_definition_json));
        const hash = definitionHash(compiled.definition);
        const challenge: StoredChallenge = {
          id: DAILY_QUEST_CHALLENGE_ID, version: 1, title: compiled.definition.meta.title, definitionHash: hash, maxScore: compiled.maxScore,
          engineMinVersion: ENGINE_VERSION, teamId: null, clockOffsetMs: 0, downloadedAt: r.started_wall, stale: false,
          bundle: {
            challengeId: DAILY_QUEST_CHALLENGE_ID, version: 1, definition: compiled.definition, definitionHash: hash, engineMinVersion: ENGINE_VERSION, maxScore: compiled.maxScore,
            mapPack: null, ruleText: renderRules(compiled), encouragement: QUEST_LINES, participation: { teamId: null, joinedVersion: 1 }, serverTime: r.started_wall, modules: [], participantKeys: [],
          },
        };
        q = { challenge, compiled };
        this.questCache.set(r.id, q);
      }
      return q;
    }
    const challenge = await this.store.getChallenge(r.challenge_id, r.challenge_version);
    if (!challenge) throw new SessionError('Challenge bundle missing');
    return { challenge, compiled: this.store.compiled(challenge) };
  }

  /** The running offline quest, if any (drives the QuestGuard that blocks all network calls). */
  async activeQuestId(): Promise<string | null> {
    const id = await this.activeSessionId();
    if (!id) return null;
    const r = await this.db.get<{ quest_json: string | null }>('SELECT quest_json FROM sessions WHERE id = ?', [id]);
    return r?.quest_json ? id : null;
  }

  /**
   * Starts an offline Daily Quest (design §5A). Built entirely on the phone from a template + the
   * player's own fix; the server rebuilds the same definition. `online` is the current connectivity.
   */
  async startQuest(args: { spec: QuestSpec; startFix: Fix; online: boolean; transport?: 'wifi' | 'cellular' | 'other' | 'none'; bootId?: string }): Promise<string> {
    if (await this.activeSessionId()) throw new SessionError('Another challenge is already in progress');
    if (args.online) throw new SessionError('Turn off mobile data and Wi-Fi to start your quest');
    const compiled = compileOrThrow(buildQuestDefinition(args.spec, [args.startFix.lng, args.startFix.lat]));
    const hash = definitionHash(compiled.definition);
    const sessionId = uuidv7(this.clock.wallNow());
    const clock = new SessionClock(this.clock, 0, 0);
    this.clocks.set(sessionId, clock);
    await this.db.tx(async (t) => {
      await t.run(
        `INSERT INTO sessions (id, challenge_id, challenge_version, user_id, status, started_wall, boot_id, clock_offset_ms, last_seq, chain_head, last_mono, last_wall_ms, created_at, quest_json, quest_definition_json)
         VALUES (?, ?, 1, ?, 'active', ?, ?, 0, 0, ?, 0, ?, ?, ?, ?)`,
        [sessionId, DAILY_QUEST_CHALLENGE_ID, this.ids.userId, clock.wallIso(), args.bootId ?? 'unknown', genesisHash(sessionId), this.clock.wallNow(), clock.wallIso(), JSON.stringify(args.spec), JSON.stringify(compiled.definition)],
      );
      await this.appendIn(t, sessionId, 'SessionStarted', {
        challengeId: DAILY_QUEST_CHALLENGE_ID, challengeVersion: 1, definitionHash: hash, deviceId: this.ids.deviceId, userId: this.ids.userId, teamId: null,
        bootId: (args.bootId ?? 'unknown').slice(0, 64), clockOffsetMsAtDownload: 0, startFix: args.startFix, tzOffsetMin: this.tz(), quest: args.spec,
      }, 0);
      await this.appendIn(t, sessionId, 'ConnectivityChanged', { online: false, transport: 'none' }, 0);
      await t.run(`INSERT INTO meta (key, value) VALUES ('active_session_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [sessionId]);
    });
    return sessionId;
  }

  /** Records a connectivity change (only when it actually changes). */
  async setConnectivity(sessionId: string, online: boolean, transport: 'wifi' | 'cellular' | 'other' | 'none'): Promise<boolean> {
    const last = await this.db.get<{ payload_json: string }>(`SELECT payload_json FROM events WHERE session_id = ? AND type = 'ConnectivityChanged' ORDER BY seq DESC LIMIT 1`, [sessionId]);
    if (last && JSON.parse(last.payload_json).online === online) return false;
    await this.append(sessionId, 'ConnectivityChanged', { online, transport: online ? transport : 'none' });
    return true;
  }

  /** Self-reported counter tap (+1 / −1 corrections stay append-only). */
  async reportCount(sessionId: string, counterId: string, delta: number) {
    if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 20) throw new SessionError('Invalid count');
    return this.append(sessionId, 'CountReported', { counterId, delta });
  }

  /** Stops a quest. `force` stops count toward the weekly penalty; `safety` stops never do. */
  async stopQuest(sessionId: string, kind: 'force' | 'safety', reason: 'unwell' | 'weather' | 'emergency' | 'need_phone' | 'other' | null) {
    await this.append(sessionId, 'QuestStopped', { kind, reason: kind === 'safety' ? reason ?? 'other' : reason });
    await this.abandon(sessionId, kind === 'safety' ? `safety:${reason ?? 'other'}` : 'quest_force_stop');
  }

  /** Session summary + provisional milestones after a session ends (never during play). */
  private async afterEnd(sessionId: string): Promise<LocalMilestone[]> {
    if (!this.extras.milestones) return [];
    const r = await this.row(this.db, sessionId);
    const { compiled } = await this.ruleset(r);
    const state = fold(compiled, await this.events(sessionId));
    const summary = summarizeSession(compiled, state, { userId: this.ids.userId, challengeId: r.challenge_id, verified: false, confirmations: { mode: 'provisional' } });
    await this.extras.milestones.saveSummary(summary);
    return this.extras.milestones.evaluateLocal();
  }

  private async row(db: SqlDb, sessionId: string): Promise<SessionRow> {
    const r = await db.get<SessionRow>('SELECT * FROM sessions WHERE id = ?', [sessionId]);
    if (!r) throw new SessionError(`Unknown session ${sessionId}`);
    return r;
  }

  private async sessionClock(sessionId: string): Promise<SessionClock> {
    let c = this.clocks.get(sessionId);
    if (!c) {
      const r = await this.row(this.db, sessionId);
      c = new SessionClock(this.clock, r.last_mono, r.last_wall_ms);
      this.clocks.set(sessionId, c);
      if (c.anomaly && r.status === 'active') {
        await this.append(sessionId, 'ClockAnomalyDetected', { kind: 'wall_backwards', detail: c.anomaly.slice(0, 200) });
      }
    }
    return c;
  }

  async activeSessionId(): Promise<string | null> {
    const id = await this.store.getMeta('active_session_id');
    if (!id) return null;
    const r = await this.db.get<{ status: string }>('SELECT status FROM sessions WHERE id = ?', [id]);
    return r && (r.status === 'active' || r.status === 'paused') ? id : null;
  }

  /** Starts a session fully offline. The server learns about it later via sync. */
  async start(args: { challengeId: string; version: number; startFix: Fix; bootId?: string }): Promise<string> {
    const challenge = await this.store.getChallenge(args.challengeId, args.version);
    if (!challenge) throw new SessionError('Challenge is not downloaded');
    if (await this.activeSessionId()) throw new SessionError('Another challenge is already in progress');
    for (const m of challenge.bundle.modules ?? []) {
      const st = await this.store.moduleStatus(m.id);
      if (st === 'taken_down' || st === 'suspended') throw new SessionError('This activity module was removed, so new sessions can’t start');
    }
    const sessionId = uuidv7(this.clock.wallNow());
    const clock = new SessionClock(this.clock, 0, 0);
    this.clocks.set(sessionId, clock);
    await this.db.tx(async (t) => {
      await t.run(
        `INSERT INTO sessions (id, challenge_id, challenge_version, user_id, status, started_wall, boot_id, clock_offset_ms, last_seq, chain_head, last_mono, last_wall_ms, created_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?, ?, 0, ?, 0, ?, ?)`,
        [sessionId, challenge.id, challenge.version, this.ids.userId, clock.wallIso(), args.bootId ?? 'unknown', challenge.clockOffsetMs, genesisHash(sessionId), this.clock.wallNow(), clock.wallIso()],
      );
      await this.appendIn(t, sessionId, 'SessionStarted', {
        challengeId: challenge.id,
        challengeVersion: challenge.version,
        definitionHash: challenge.definitionHash,
        deviceId: this.ids.deviceId,
        userId: this.ids.userId,
        teamId: challenge.teamId,
        bootId: (args.bootId ?? 'unknown').slice(0, 64),
        clockOffsetMsAtDownload: Math.round(challenge.clockOffsetMs),
        startFix: args.startFix,
        tzOffsetMin: this.tz(),
      }, 0);
      await t.run(`INSERT INTO meta (key, value) VALUES ('active_session_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [sessionId]);
    });
    return sessionId;
  }

  /** Seals (seq + hash chain) and stores one event inside an existing transaction. */
  private async appendIn<T extends EventType>(t: SqlDb, sessionId: string, type: T, payload: PayloadOf<T>, monoOverride?: number): Promise<ActivityEvent> {
    const s = await this.row(t, sessionId);
    const clock = this.clocks.get(sessionId) ?? new SessionClock(this.clock, s.last_mono, s.last_wall_ms);
    this.clocks.set(sessionId, clock);
    const monoMs = Math.max(monoOverride ?? clock.monoNow(), Number(s.last_mono));
    const base = {
      eventId: uuidv7(this.clock.wallNow()),
      sessionId,
      seq: s.last_seq + 1,
      type,
      schemaVersion: EVENT_SCHEMA_VERSION,
      clientTs: clock.wallIso(),
      monoMs,
      payload,
      prevHash: s.chain_head,
    };
    const hash = computeEventHash(base);
    await t.run(
      `INSERT INTO events (event_id, session_id, seq, type, schema_version, client_ts, mono_ms, payload_json, prev_hash, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [base.eventId, sessionId, base.seq, type, base.schemaVersion, base.clientTs, monoMs, JSON.stringify(payload), base.prevHash, hash],
    );
    await t.run('UPDATE sessions SET last_seq = ?, chain_head = ?, last_mono = max(last_mono, ?), last_wall_ms = ? WHERE id = ?', [
      base.seq, hash, monoMs, this.clock.wallNow(), sessionId,
    ]);
    return { ...base, hash } as ActivityEvent;
  }

  async append<T extends EventType>(sessionId: string, type: T, payload: PayloadOf<T>): Promise<ActivityEvent> {
    await this.sessionClock(sessionId);
    // Causal order: GPS fixes recorded before this action must be sealed first.
    if (type !== 'LocationBatch') await this.flushLocations(sessionId, true);
    return this.db.tx((t) => this.appendIn(t, sessionId, type, payload));
  }

  /** Buffers GPS fixes (cheap writes) and flushes them as LocationBatch events. */
  async addFixes(sessionId: string, fixes: RawFix[]): Promise<void> {
    if (!fixes.length) return;
    const clock = await this.sessionClock(sessionId);
    await this.db.tx(async (t) => {
      for (const f of fixes) {
        await t.run(
          'INSERT INTO location_buffer (session_id, ts, mono_ms, lat, lng, acc, speed, heading, alt, mocked) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [sessionId, new Date(f.timestamp).toISOString(), clock.monoAtWall(f.timestamp), f.lat, f.lng, f.acc, f.speed ?? null, f.heading ?? null, f.alt ?? null, f.mocked ? 1 : 0],
        );
      }
    });
    await this.flushLocations(sessionId);
  }

  async flushLocations(sessionId: string, force = false): Promise<number> {
    const clock = await this.sessionClock(sessionId);
    return this.db.tx(async (t) => {
      const rows = await t.all<any>('SELECT * FROM location_buffer WHERE session_id = ? ORDER BY mono_ms, id LIMIT 200', [sessionId]);
      if (!rows.length) return 0;
      const oldest = Number(rows[0].mono_ms);
      if (!force && rows.length < FLUSH_SAMPLE_COUNT && clock.monoNow() - oldest < FLUSH_MAX_AGE_MS) return 0;
      const samples: LocationSample[] = rows.map((r) => ({
        ts: r.ts, monoMs: Number(r.mono_ms), lat: r.lat, lng: r.lng, acc: r.acc,
        speed: r.speed ?? null, heading: r.heading ?? null, alt: r.alt ?? null, mocked: Number(r.mocked) === 1,
      }));
      // Keep monotonic order within the session: the batch event's mono = its last sample.
      await this.appendIn(t, sessionId, 'LocationBatch', { samples }, Math.max(clock.monoNow(), samples[samples.length - 1]!.monoMs));
      await t.run(`DELETE FROM location_buffer WHERE session_id = ? AND id <= ?`, [sessionId, rows[rows.length - 1].id]);
      return samples.length;
    });
  }

  /** Records a photo: evidence row + EvidenceCaptured event in ONE transaction (hash enters the chain). */
  async captureEvidence(args: { sessionId: string; taskId: string; checkpointId: string | null; fileUri: string; sha256: string; bytes: number; fix: Fix | null }): Promise<string> {
    await this.sessionClock(args.sessionId);
    await this.flushLocations(args.sessionId, true);
    const evidenceId = uuidv7(this.clock.wallNow());
    await this.db.tx(async (t) => {
      const ev = await this.appendIn(t, args.sessionId, 'EvidenceCaptured', {
        evidenceId, taskId: args.taskId, checkpointId: args.checkpointId, sha256: args.sha256, bytes: args.bytes, mime: 'image/jpeg', fix: args.fix,
      });
      await t.run(
        `INSERT INTO evidence (id, session_id, task_id, checkpoint_id, event_id, file_uri, sha256, bytes, captured_ts, lat, lng, acc) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [evidenceId, args.sessionId, args.taskId, args.checkpointId, ev.eventId, args.fileUri, args.sha256, args.bytes, ev.clientTs, args.fix?.lat ?? null, args.fix?.lng ?? null, args.fix?.acc ?? null],
      );
    });
    return evidenceId;
  }

  async setMood(sessionId: string, phase: 'before' | 'after', value: number | null) {
    const r = await this.row(this.db, sessionId);
    const w = json<Record<string, unknown>>(r.wellness_json, {});
    w[phase === 'before' ? 'moodBefore' : 'moodAfter'] = value;
    await this.db.run('UPDATE sessions SET wellness_json = ? WHERE id = ?', [JSON.stringify(w), sessionId]);
  }

  async events(sessionId: string): Promise<ActivityEvent[]> {
    const rows = await this.db.all<any>('SELECT * FROM events WHERE session_id = ? ORDER BY seq', [sessionId]);
    return rows.map((r) => ({
      eventId: r.event_id, sessionId: r.session_id, seq: Number(r.seq), type: r.type, schemaVersion: Number(r.schema_version),
      clientTs: r.client_ts, monoMs: Number(r.mono_ms), payload: JSON.parse(r.payload_json), prevHash: r.prev_hash, hash: r.hash,
    })) as ActivityEvent[];
  }

  /** Provisional, on-device state + score (same engine as the server). Includes unflushed GPS. */
  async snapshot(sessionId: string, opts: { weightKg?: number | null } = {}): Promise<LiveSnapshot> {
    const r = await this.row(this.db, sessionId);
    const { challenge, compiled } = await this.ruleset(r);
    const clock = await this.sessionClock(sessionId);
    const persisted = fold(compiled, await this.events(sessionId), { confirmations: { mode: 'provisional' } });
    const buffered = await this.db.all<any>('SELECT * FROM location_buffer WHERE session_id = ? ORDER BY mono_ms, id', [sessionId]);
    const state = withLiveSamples(
      compiled,
      persisted,
      buffered.map((b) => ({ ts: b.ts, monoMs: Number(b.mono_ms), lat: b.lat, lng: b.lng, acc: b.acc, speed: null, heading: null, alt: null, mocked: Number(b.mocked) === 1 })),
    );
    const nowMono = state.endMono ?? clock.monoNow();
    const score = evaluate(compiled, state, { nowMono, confirmations: { mode: 'provisional' } });
    const mood = json<{ moodBefore?: number; moodAfter?: number }>(r.wellness_json, {});
    const w = wellness(compiled, state, { nowMono, weightKg: opts.weightKg ?? null, moodBefore: mood.moodBefore ?? null, moodAfter: mood.moodAfter ?? null });
    const elapsed = Number(score.facts.duration_s) * 1000;
    return { sessionId, challenge, compiled, state, score, wellness: w, nowMono, remainingMs: Math.max(0, compiled.durationMs - elapsed) };
  }

  /** Ends the session offline: flush GPS, compute provisional score, seal SessionCompleted. */
  async finish(sessionId: string, reason: 'rules' | 'manual' | 'timeout', opts: { shareWellbeing: boolean; weightKg?: number | null }): Promise<LiveSnapshot & { unlocks: LocalMilestone[] }> {
    await this.flushLocations(sessionId, true);
    const snap = await this.snapshot(sessionId, opts);
    const r = await this.row(this.db, sessionId);
    const mood = json<{ moodBefore?: number | null; moodAfter?: number | null }>(r.wellness_json, {});
    await this.db.tx(async (t) => {
      await this.appendIn(t, sessionId, 'SessionCompleted', {
        reason,
        provisionalScore: snap.score.total,
        ...(opts.shareWellbeing ? { wellness: { moodBefore: mood.moodBefore ?? null, moodAfter: mood.moodAfter ?? null } } : {}),
      });
      await t.run(`UPDATE sessions SET status = 'completed', ended_wall = ?, provisional_score_json = ?, wellness_json = ? WHERE id = ?`, [
        new Date(this.clock.wallNow()).toISOString(),
        JSON.stringify({ total: snap.score.total, maxScore: snap.score.maxScore, completed: snap.score.completed, breakdown: snap.score.breakdown, facts: snap.score.facts, engineVersion: ENGINE_VERSION }),
        JSON.stringify({ ...snap.wellness, moodBefore: mood.moodBefore ?? null, moodAfter: mood.moodAfter ?? null }),
        sessionId,
      ]);
      await t.run(`DELETE FROM meta WHERE key = 'active_session_id'`);
    });
    const unlocks = await this.afterEnd(sessionId);
    return { ...(await this.snapshot(sessionId, opts)), unlocks };
  }

  async abandon(sessionId: string, reason: string) {
    await this.flushLocations(sessionId, true);
    await this.db.tx(async (t) => {
      await this.appendIn(t, sessionId, 'SessionAbandoned', { reason: reason.slice(0, 200) });
      await t.run(`UPDATE sessions SET status = 'abandoned', ended_wall = ? WHERE id = ?`, [new Date(this.clock.wallNow()).toISOString(), sessionId]);
      await t.run(`DELETE FROM meta WHERE key = 'active_session_id'`);
    });
    await this.afterEnd(sessionId);
  }

  /** Lifetime impact from finished sessions (engine facts, not guesses). */
  async impact(): Promise<{ sessions: number; trees: number; litter: number; distanceM: number; steps: number }> {
    const rows = await this.db.all<{ provisional_score_json: string | null; wellness_json: string | null }>(
      `SELECT provisional_score_json, wellness_json FROM sessions WHERE status = 'completed' AND user_id = ?`,
      [this.ids.userId],
    );
    const out = { sessions: rows.length, trees: 0, litter: 0, distanceM: 0, steps: 0 };
    for (const r of rows) {
      const f = json<{ facts?: Record<string, number> }>(r.provisional_score_json, {}).facts ?? {};
      out.trees += Number(f['tree_care.trees_watered'] ?? 0);
      out.litter += Number(f['cleanup.items_collected'] ?? 0);
      out.distanceM += Number(f.distance_m ?? 0);
      out.steps += Number(json<{ steps?: number }>(r.wellness_json, {}).steps ?? 0);
    }
    return out;
  }

  async history(): Promise<Array<{ id: string; challengeId: string; title: string; status: string; startedAt: string; verdict: string | null; provisional: number | null; final: number | null; pending: number }>> {
    const rows = await this.db.all<any>(
      `SELECT s.*, c.title, (SELECT count(*) FROM events e WHERE e.session_id = s.id AND e.sync_state != 'acked') AS pending
       FROM sessions s LEFT JOIN challenges c ON c.id = s.challenge_id AND c.version = s.challenge_version WHERE s.user_id = ? ORDER BY s.created_at DESC`,
      [this.ids.userId],
    );
    return rows.map((r) => ({
      id: r.id,
      challengeId: r.challenge_id,
      title: r.title ?? (r.quest_json ? 'Daily Quest' : 'Challenge'),
      status: r.status,
      startedAt: r.started_wall,
      verdict: r.verdict ?? null,
      provisional: json<{ total?: number }>(r.provisional_score_json, {}).total ?? null,
      final: json<{ totalPoints?: number }>(r.final_score_json, {}).totalPoints ?? null,
      pending: Number(r.pending),
    }));
  }
}
