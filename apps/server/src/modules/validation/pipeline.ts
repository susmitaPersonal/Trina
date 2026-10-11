import {
  ActivityEvent,
  canonicalJson,
  computeEventHash,
  genesisHash,
  sha256Hex,
  uuidv7,
  type ChallengeDefinition,
} from '@trina/contracts';
import {
  buildQuestDefinition,
  compileOrThrow,
  DAILY_QUEST_CHALLENGE_ID,
  ENGINE_VERSION,
  evaluate,
  fold,
  inCircle,
  simplifyLine,
  summarizeSession,
  wellness,
  type CompiledChallenge,
  type EvaluateOptions,
} from '@trina/engine';
import { canonicalJson as canon, definitionHash, lowerOnly, verifyConfirmation, type ConfirmationClaim } from '@trina/contracts';
import { registryForDefinition } from '../datamodules/service';
import type { AppContext } from '../../platform/context';
import { rebuildLeaderboard } from '../scoring/leaderboard';
import { FLAG_MESSAGES } from '../sync/sessions';

/** 2: data modules, Claims stage (signed confirmations, counts), offline quest checks, session summaries. */
export const PIPELINE_VERSION = 2;
export const CONFIRM_MIN_OVERLAP_MS = 10 * 60_000;
export const CONFIRMS_PER_DAY = 30;
export const RECIPROCAL_LIMIT = 3;

export type Severity = 'info' | 'warn' | 'critical';
export type Flag = { code: string; severity: Severity; details: Record<string, unknown>; evidenceId?: string };
export type Verdict = 'verified' | 'verified_with_notes' | 'needs_review' | 'rejected';

const FUTURE_TOLERANCE_MS = 5 * 60_000;
const DRIFT_MIN_MS = 60_000;
const DRIFT_RATIO = 0.02;

type EventRow = {
  event_id: string; session_id: string; seq: number; type: string; schema_version: number; client_ts: string;
  mono_ms: string | number; payload: unknown; prev_hash: string; hash: string; received_at: string; redacted: boolean;
};

function toEvent(r: EventRow): ActivityEvent {
  return {
    eventId: r.event_id,
    sessionId: r.session_id,
    seq: r.seq,
    type: r.type,
    schemaVersion: r.schema_version,
    clientTs: new Date(r.client_ts).toISOString(),
    monoMs: Number(r.mono_ms),
    payload: r.payload,
    prevHash: r.prev_hash,
    hash: r.hash,
  } as ActivityEvent;
}

/**
 * Deterministic server validation. Produces flags + verdict and the AUTHORITATIVE score.
 * Never claims certainty: critical flags send a session to human review, they don't "convict".
 */
export async function validateSession(ctx: AppContext, sessionId: string): Promise<{ verdict: Verdict; total: number; flags: Flag[] } | null> {
  const startedAt = ctx.now();
  const s = await ctx.db.one<any>('SELECT * FROM activity_sessions WHERE id = $1', [sessionId]);
  if (!s) return null;
  const challenge = await ctx.db.one<{ status: string; creator_id: string }>('SELECT status, creator_id FROM challenges WHERE id = $1', [s.challenge_id]);
  const version = await ctx.db.one<{ definition: ChallengeDefinition; definition_hash: string }>(
    'SELECT definition, definition_hash FROM challenge_versions WHERE challenge_id = $1 AND version = $2',
    [s.challenge_id, s.challenge_version],
  );
  if (!challenge || !version) return null;
  const isQuest = s.challenge_id === DAILY_QUEST_CHALLENGE_ID;
  const rows = await ctx.db.query<EventRow>('SELECT * FROM activity_events WHERE session_id = $1 ORDER BY seq', [sessionId]);
  const events = rows.map(toEvent);
  const flags: Flag[] = [];
  const add = (code: string, severity: Severity, details: Record<string, unknown> = {}, evidenceId?: string) =>
    flags.push({ code, severity, details, ...(evidenceId ? { evidenceId } : {}) });

  /* ----------------------------- Integrity ----------------------------- */
  if (s.final_seq !== null && s.last_contiguous_seq < s.final_seq) add('SEQ_GAP', 'warn', { contiguous: s.last_contiguous_seq, final: s.final_seq });
  let prev = genesisHash(sessionId);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.seq !== i + 1) break; // gap already flagged
    const e = events[i]!;
    const hashOk = row.redacted || computeEventHash(e) === e.hash;
    if (e.prevHash !== prev || !hashOk) {
      add('CHAIN_BROKEN', 'critical', { seq: e.seq });
      break;
    }
    prev = e.hash;
  }
  const anomalies = await ctx.db.query<{ details: { code: string } & Record<string, unknown> }>(
    `SELECT details FROM audit_log WHERE action = 'ingest_anomaly' AND target_type = 'session' AND target_id = $1`,
    [sessionId],
  );
  for (const a of anomalies) {
    const code = a.details.code;
    const severity: Severity = code === 'PARTICIPANT_WITHDRAWN' || code === 'EVIDENCE_ID_REUSED' ? 'warn' : 'critical';
    add(code, severity, a.details);
  }
  const start = events.find((e) => e.type === 'SessionStarted');
  if (!start || start.type !== 'SessionStarted') return null;
  // Definition: quests are rebuilt from their template + start fix; challenges use their pinned modules.
  let compiled: CompiledChallenge;
  let expectedHash: string;
  if (isQuest) {
    if (!start.payload.quest) return null;
    compiled = compileOrThrow(buildQuestDefinition(start.payload.quest, [start.payload.startFix.lng, start.payload.startFix.lat]));
    expectedHash = definitionHash(compiled.definition);
  } else {
    compiled = compileOrThrow(version.definition, await registryForDefinition(ctx.db, version.definition));
    expectedHash = version.definition_hash;
  }
  if (start.payload.definitionHash !== expectedHash) add(isQuest ? 'QUEST_DEFINITION_MISMATCH' : 'DEFINITION_MISMATCH', 'critical');

  /* ------------------------------ Temporal ----------------------------- */
  const offset = Number(s.clock_offset_ms_at_download ?? 0);
  const corrected = (ts: string) => Date.parse(ts) + offset;
  const window = compiled.definition.timing.window;
  if (window) {
    const t0 = corrected(start.clientTs);
    const opens = Date.parse(window.opensAt) - compiled.definition.timing.startGraceMin * 60_000;
    if (t0 < opens || t0 > Date.parse(window.closesAt)) add('OUTSIDE_WINDOW', 'critical');
  }
  let futureFlagged = false;
  let driftFlagged = false;
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    if (!futureFlagged && corrected(e.clientTs) > Date.parse(rows[i]!.received_at) + FUTURE_TOLERANCE_MS) {
      add('FUTURE_EVENT', 'critical', { seq: e.seq });
      futureFlagged = true;
    }
    const wall = Date.parse(e.clientTs) - Date.parse(start.clientTs);
    const mono = e.monoMs - start.monoMs;
    if (!driftFlagged && Math.abs(wall - mono) > Math.max(DRIFT_MIN_MS, DRIFT_RATIO * mono)) {
      add('CLOCK_DRIFT', 'warn', { seq: e.seq, driftMs: wall - mono });
      driftFlagged = true;
    }
  }

  /* ------------------------------ Spatial ------------------------------ */
  const first = fold(compiled, events);
  if (first.samplesRejected.mocked > 0 || events.some((e) => e.type === 'MockLocationDetected')) {
    add('MOCK_LOCATION', 'critical', { samples: first.samplesRejected.mocked });
  }
  if (first.samplesRejected.jump > 0) add('LOCATION_JUMP', 'warn', { samples: first.samplesRejected.jump });
  const sf = start.payload.startFix;
  if (!inCircle([sf.lng, sf.lat], sf.acc, compiled.definition.area.startZone, 100, 50)) add('START_OUTSIDE_ZONE', 'critical');
  for (const [id, cp] of Object.entries(first.checkpoints)) if (cp.reached && cp.manual) add('CP_MANUAL', 'info', { checkpointId: id });
  if (first.gpsLost > 0) add('GPS_WEAK', 'info', { times: first.gpsLost });

  /* ------------------------------ Evidence ----------------------------- */
  const invalidEvidence: Record<string, string> = {};
  const evRows = await ctx.db.query<{ id: string; sha256: string; upload_status: string; user_id: string }>(
    'SELECT id, sha256, upload_status, user_id FROM evidence WHERE session_id = $1',
    [sessionId],
  );
  const byId = new Map(evRows.map((r) => [r.id, r]));
  for (const e of events) {
    if (e.type !== 'EvidenceCaptured') continue;
    const id = e.payload.evidenceId;
    const row = byId.get(id);
    if (!row || row.upload_status === 'pending' || row.upload_status === 'rejected') {
      invalidEvidence[id] = 'missing';
      add('EVIDENCE_MISSING', 'warn', { taskId: e.payload.taskId }, id);
      continue;
    }
    const dups = await ctx.db.query<{ user_id: string }>(
      `SELECT user_id FROM evidence WHERE sha256 = $1 AND id <> $2 AND deleted_at IS NULL AND upload_status <> 'pending' AND created_at <= (SELECT created_at FROM evidence WHERE id = $2)`,
      [row.sha256, id],
    );
    if (dups.length) {
      invalidEvidence[id] = 'duplicate';
      add('EVIDENCE_DUPLICATE', dups.some((d) => d.user_id !== s.user_id) ? 'critical' : 'warn', { taskId: e.payload.taskId }, id);
    }
    if (first.evidence[id]?.invalidReason === 'off_location') add('EVIDENCE_OFF_LOCATION', 'info', { taskId: e.payload.taskId }, id);
  }

  /* ----------------------------- Behavioral ---------------------------- */
  for (const [taskId, ts] of Object.entries(first.tasks)) {
    if (ts.status !== 'done' || ts.completedAtMono === null) continue;
    const def = compiled.tasks.get(taskId);
    const min = def ? compiled.modules.flatMap((m) => m.taskTypes.map((tt) => ({ type: `${m.id}.${tt.id}`, tt }))).find((x) => x.type === def.type)?.tt.minTaskSeconds : undefined;
    const from = ts.startedAtMono ?? ts.availableAtMono ?? first.startMono ?? 0;
    if (min && ts.completedAtMono - from < min * 1000) add('TOO_FAST', 'warn', { taskId, seconds: Math.round((ts.completedAtMono - from) / 1000) });
  }
  const primary = compiled.modules.find((m) => m.kind === 'activity');
  const onFoot = primary?.id === 'walking' || primary?.id === 'running';
  const movingMin = first.movingMs / 60_000;
  if (onFoot && first.steps !== null && movingMin >= 5) {
    if (first.steps < movingMin * 10) add('STEPS_GPS_MISMATCH', 'warn', { steps: first.steps, movingMin: Math.round(movingMin) });
    else if (first.steps / movingMin > 220) add('CADENCE_IMPLAUSIBLE', 'warn', { spm: Math.round(first.steps / movingMin) });
  }
  if (challenge.status === 'cancelled') add('CHALLENGE_CANCELLED', 'info');

  /* ------------------------------- Score ------------------------------- */
  /* ------------------------------- Claims ------------------------------ */
  const matched = await claimsStage(ctx, { s, sessionId, challengeCreator: challenge.creator_id, compiled, events, first, corrected, add });
  countsStage(compiled, events, add);

  /* ---------------------------- Offline quest --------------------------- */
  let onlineMono: Array<[number, number]> = [];
  if (isQuest) {
    if (!events.some((e) => e.type === 'ConnectivityChanged')) add('OFFLINE_UNRECORDED', 'warn');
    const t0 = corrected(start.clientTs);
    const t1 = corrected(events[events.length - 1]!.clientTs);
    // Only whole minutes strictly inside the quest (the pre-sync and post-sync minutes are outside).
    const minutes = await ctx.db.query<{ minute: string }>(
      `SELECT minute FROM device_request_minutes WHERE device_id = $1 AND minute > $2 AND minute < $3 ORDER BY minute`,
      [s.device_id, new Date(t0).toISOString(), new Date(t1 - 60_000).toISOString()],
    );
    onlineMono = minutes.map((m) => {
      const mono = start.monoMs + (Date.parse(m.minute) - t0);
      return [mono, mono + 60_000] as [number, number];
    });
    if (onlineMono.length) add('ONLINE_DURING_QUEST', 'warn', { minutes: onlineMono.length });
  }

  const evalOpts: EvaluateOptions = { invalidEvidence, confirmations: { mode: 'final', matched }, onlineMono };
  const finalState = fold(compiled, events, evalOpts);
  const result = evaluate(compiled, finalState, evalOpts);
  const user = await ctx.db.one<{ share_wellbeing: boolean }>('SELECT share_wellbeing FROM users WHERE id = $1', [s.user_id]);
  const completedEv = events.find((e) => e.type === 'SessionCompleted');
  const sealedMood = completedEv?.type === 'SessionCompleted' ? completedEv.payload.wellness : undefined;
  const lateMood = (s.mood_json ?? {}) as { moodBefore?: number | null; moodAfter?: number | null };
  const mood = user?.share_wellbeing
    ? { moodBefore: lateMood.moodBefore ?? sealedMood?.moodBefore ?? null, moodAfter: lateMood.moodAfter ?? sealedMood?.moodAfter ?? null }
    : undefined;
  const w = wellness(compiled, finalState, { moodBefore: mood?.moodBefore ?? null, moodAfter: mood?.moodAfter ?? null });

  const verdict: Verdict = flags.some((f) => f.severity === 'critical')
    ? 'needs_review'
    : flags.some((f) => f.severity === 'warn')
      ? 'verified_with_notes'
      : 'verified';
  const scoreStatus = verdict === 'needs_review' || challenge.status === 'cancelled' ? 'hidden' : 'final';
  const inputsHash = sha256Hex(canonicalJson({ head: s.chain_head_hash, engine: ENGINE_VERSION, invalidEvidence, pipeline: PIPELINE_VERSION }));
  const track = simplifyLine(finalState.track.map((p) => [p.lng, p.lat] as [number, number]), 20);

  await ctx.db.tx(async (t) => {
    const runId = uuidv7();
    await t.query(
      `INSERT INTO validation_runs (id, session_id, engine_version, pipeline_version, verdict, started_at) VALUES ($1, $2, $3, $4, $5, $6)`,
      [runId, sessionId, ENGINE_VERSION, PIPELINE_VERSION, verdict, startedAt.toISOString()],
    );
    for (const f of flags) {
      await t.query(
        `INSERT INTO session_flags (id, session_id, validation_run_id, code, severity, message, details, evidence_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [uuidv7(), sessionId, runId, f.code, f.severity, FLAG_MESSAGES[f.code] ?? f.code, JSON.stringify(f.details), f.evidenceId ?? null],
      );
    }
    await t.query(
      `INSERT INTO scores (session_id, challenge_id, user_id, team_id, total_points, max_score, breakdown, completed, duration_s, distance_m, status, verdict, engine_version, inputs_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (session_id) DO UPDATE SET total_points = EXCLUDED.total_points, max_score = EXCLUDED.max_score, breakdown = EXCLUDED.breakdown,
         completed = EXCLUDED.completed, duration_s = EXCLUDED.duration_s, distance_m = EXCLUDED.distance_m, status = EXCLUDED.status,
         verdict = EXCLUDED.verdict, engine_version = EXCLUDED.engine_version, inputs_hash = EXCLUDED.inputs_hash, computed_at = now()`,
      [
        sessionId, s.challenge_id, s.user_id, s.team_id, result.total, result.maxScore, JSON.stringify(result.breakdown), result.completed,
        result.facts.duration_s, result.facts.distance_m, scoreStatus, verdict, ENGINE_VERSION, inputsHash,
      ],
    );
    await t.query(
      `INSERT INTO session_wellness (session_id, steps, avg_cadence_spm, active_minutes, phone_free_minutes, kcal_estimate, kcal_approx, mood_before, mood_after, engine_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (session_id) DO UPDATE SET steps = EXCLUDED.steps, avg_cadence_spm = EXCLUDED.avg_cadence_spm, active_minutes = EXCLUDED.active_minutes,
         phone_free_minutes = EXCLUDED.phone_free_minutes, kcal_estimate = EXCLUDED.kcal_estimate, kcal_approx = EXCLUDED.kcal_approx,
         mood_before = EXCLUDED.mood_before, mood_after = EXCLUDED.mood_after, computed_at = now()`,
      [sessionId, w.steps, w.avgCadenceSpm, w.activeMinutes, w.phoneFreeMinutes, w.kcalEstimate, w.kcalApprox, w.moodBefore, w.moodAfter, ENGINE_VERSION],
    );
    if (!s.track_deleted_at) {
      await t.query(
        `INSERT INTO session_tracks (session_id, simplified, distance_m, duration_s) VALUES ($1, $2, $3, $4)
         ON CONFLICT (session_id) DO UPDATE SET simplified = EXCLUDED.simplified, distance_m = EXCLUDED.distance_m, duration_s = EXCLUDED.duration_s`,
        [sessionId, JSON.stringify(track), result.facts.distance_m, result.facts.duration_s],
      );
    }
    await t.query(`UPDATE activity_sessions SET validation_status = $2 WHERE id = $1`, [sessionId, verdict]);
    const validIds = evRows.filter((r) => r.upload_status === 'uploaded' && !invalidEvidence[r.id]).map((r) => r.id);
    for (const id of validIds) await t.query(`UPDATE evidence SET upload_status = 'verified' WHERE id = $1`, [id]);
    await t.query(`INSERT INTO user_changes (user_id, kind, ref_id, data) VALUES ($1, 'session_result', $2, $3)`, [
      s.user_id,
      sessionId,
      JSON.stringify({
        sessionId,
        challengeId: s.challenge_id,
        verdict,
        totalPoints: result.total,
        completed: result.completed,
        breakdown: result.breakdown,
        flags: flags.filter((f) => f.severity !== 'info' || f.code === 'CP_MANUAL').map((f) => ({ code: f.code, severity: f.severity, message: FLAG_MESSAGES[f.code] ?? f.code })),
        wellness: { ...w, ...(user?.share_wellbeing ? {} : { moodBefore: null, moodAfter: null }) },
      }),
    ]);
  });
  // Milestones (derived, ADR-024): summary in, evaluator job out. Co-present players are re-evaluated too.
  const summary = summarizeSession(compiled, finalState, {
    ...evalOpts,
    userId: s.user_id,
    challengeId: s.challenge_id,
    verified: scoreStatus === 'final' && (verdict === 'verified' || verdict === 'verified_with_notes'),
    clockCorrectionMs: driftFlagged ? offset : 0,
  });
  await ctx.db.query(
    `INSERT INTO session_summaries (session_id, user_id, challenge_id, day_key, week_key, summary, verified, engine_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (session_id) DO UPDATE SET day_key = EXCLUDED.day_key, week_key = EXCLUDED.week_key, summary = EXCLUDED.summary,
       verified = EXCLUDED.verified, engine_version = EXCLUDED.engine_version, updated_at = now()`,
    [sessionId, s.user_id, s.challenge_id, summary.dayKey, summary.weekKey, JSON.stringify(summary), summary.verified, ENGINE_VERSION],
  );
  const affected = isQuest
    ? [{ user_id: s.user_id }]
    : await ctx.db.query<{ user_id: string }>('SELECT DISTINCT user_id FROM session_summaries WHERE challenge_id = $1 AND day_key = $2', [s.challenge_id, summary.dayKey]);
  for (const u of affected) await ctx.jobs.enqueue('evaluate-milestones', { userId: u.user_id }, { singletonKey: `milestones:${u.user_id}` });

  if (!isQuest) await rebuildLeaderboard(ctx, s.challenge_id);
  ctx.logger.info({ sessionId, verdict, total: result.total, flags: flags.length }, 'session validated');
  return { verdict, total: result.total, flags };
}

/* ------------------------------------------------------------------ */
/* Claims stage (ADR-026): signed, two-sided, co-present confirmations */
/* ------------------------------------------------------------------ */

type ClaimsArgs = {
  s: { id: string; user_id: string; device_id: string; challenge_id: string; clock_offset_ms_at_download: number | string | null };
  sessionId: string;
  challengeCreator: string;
  compiled: CompiledChallenge;
  events: ActivityEvent[];
  first: ReturnType<typeof fold>;
  corrected: (ts: string) => number;
  add: (code: string, severity: Severity, details?: Record<string, unknown>) => void;
};

/** Absolute (server-corrected) in-zone intervals of a folded session. */
function absZones(state: ReturnType<typeof fold>, startTs: string, offsetMs: number): Array<[number, number]> {
  const t0 = Date.parse(startTs) + offsetMs;
  const m0 = state.startMono ?? 0;
  return state.zoneIntervals.map(([a, b]) => [t0 + (a - m0), t0 + (b - m0)]);
}

function overlapMs(a: Array<[number, number]>, b: Array<[number, number]>) {
  let t = 0;
  for (const [x1, x2] of a) for (const [y1, y2] of b) t += Math.max(0, Math.min(x2, y2) - Math.max(x1, y1));
  return t;
}

async function claimsStage(ctx: AppContext, a: ClaimsArgs): Promise<Record<string, ConfirmationClaim[]>> {
  const matched: Record<string, ConfirmationClaim[]> = {};
  const received = a.events.filter((e): e is Extract<ActivityEvent, { type: 'ConfirmationReceived' }> => e.type === 'ConfirmationReceived');
  if (!received.length) return matched;
  const start = a.events.find((e) => e.type === 'SessionStarted')!;
  const subjectZones = absZones(a.first, start.clientTs, Number(a.s.clock_offset_ms_at_download ?? 0));
  const counterLevel = new Map<string, string>(a.compiled.modules.flatMap((m) => (m.counters ?? []).map((c) => [`${m.id}.${c.id}`, c.verification] as [string, string])));
  const reject = (id: string, reason: string) => ctx.db.query(`UPDATE peer_confirmations SET status = 'rejected', reject_reason = $2 WHERE id = $1`, [id, reason]);

  for (const e of received) {
    const p = e.payload;
    const row = await ctx.db.one<{
      issued_sig: string | null; issuer_user_id: string; issuer_device_id: string; issuer_session_id: string | null; issued_claims: ConfirmationClaim[]; issued_at: string;
      role: 'organizer' | 'peer'; subject_session_id: string; subject_user_id: string; challenge_id: string;
    }>('SELECT * FROM peer_confirmations WHERE id = $1', [p.confirmationId]);
    if (!row?.issued_sig) {
      // The confirmer hasn't synced yet: nothing counts until they do (we re-validate when they sync).
      const old = Date.now() - a.corrected(start.clientTs) > 48 * 3_600_000;
      a.add(old ? 'CONFIRM_UNMATCHED' : 'CONFIRM_PENDING', old ? 'warn' : 'info', { confirmationId: p.confirmationId });
      continue;
    }
    if (row.issuer_user_id === a.s.user_id || row.issuer_device_id === a.s.device_id) {
      a.add('CONFIRM_SELF', 'critical', { confirmationId: p.confirmationId });
      await reject(p.confirmationId, 'self');
      continue;
    }
    const dev = await ctx.db.one<{ public_key: string | null; revoked_at: string | null; user_id: string }>('SELECT public_key, revoked_at, user_id FROM devices WHERE id = $1', [row.issuer_device_id]);
    const body = {
      confirmationId: p.confirmationId, challengeId: a.s.challenge_id, subjectUserId: a.s.user_id, subjectSessionId: a.sessionId,
      issuerUserId: row.issuer_user_id, issuerDeviceId: row.issuer_device_id, role: row.role, claims: row.issued_claims,
    };
    const sigOk =
      !!dev?.public_key && !dev.revoked_at && dev.user_id === row.issuer_user_id &&
      row.subject_session_id === a.sessionId && row.subject_user_id === a.s.user_id && row.challenge_id === a.s.challenge_id &&
      row.issuer_user_id === p.issuerUserId && row.issued_sig === p.sig && canon(row.issued_claims) === canon(p.claims) &&
      verifyConfirmation(body, row.issued_sig, dev.public_key);
    if (!sigOk) {
      a.add('CONFIRM_SIGNATURE_INVALID', 'critical', { confirmationId: p.confirmationId });
      await reject(p.confirmationId, 'signature');
      continue;
    }
    // Co-presence: the confirmer must have been in the same play area, at the same time, for ≥ 10 minutes.
    const issuer = row.issuer_session_id
      ? await ctx.db.one<{ challenge_id: string; clock_offset_ms_at_download: number }>('SELECT challenge_id, clock_offset_ms_at_download FROM activity_sessions WHERE id = $1', [row.issuer_session_id])
      : null;
    let together = 0;
    if (issuer && issuer.challenge_id === a.s.challenge_id) {
      const evRows = await ctx.db.query<EventRow>('SELECT * FROM activity_events WHERE session_id = $1 ORDER BY seq', [row.issuer_session_id]);
      const issuerEvents = evRows.map(toEvent);
      const issuerStart = issuerEvents.find((x) => x.type === 'SessionStarted');
      if (issuerStart) together = overlapMs(subjectZones, absZones(fold(a.compiled, issuerEvents), issuerStart.clientTs, Number(issuer.clock_offset_ms_at_download ?? 0)));
    }
    if (together < CONFIRM_MIN_OVERLAP_MS) {
      a.add('CONFIRMER_NOT_COPRESENT', 'warn', { confirmationId: p.confirmationId, overlapMin: Math.floor(together / 60_000) });
      await reject(p.confirmationId, 'not_copresent');
      continue;
    }
    let role: 'organizer' | 'peer' = row.role;
    if (role === 'organizer' && row.issuer_user_id !== a.challengeCreator) {
      a.add('CONFIRM_ROLE_INVALID', 'warn', { confirmationId: p.confirmationId });
      role = 'peer';
    }
    let claims: ConfirmationClaim[] = (row.issued_claims as ConfirmationClaim[]).filter((c) => c.kind !== 'counter' || counterLevel.get(c.ref) !== 'organizer' || role === 'organizer');
    // Rate: one person can't confirm everything for everyone.
    const rate = await ctx.db.one<{ n: string }>(
      `SELECT count(*) AS n FROM peer_confirmations WHERE issuer_user_id = $1 AND issued_sig IS NOT NULL AND issued_at BETWEEN $2::timestamptz - interval '24 hours' AND $2::timestamptz AND id <> $3`,
      [row.issuer_user_id, row.issued_at, p.confirmationId],
    );
    if (Number(rate?.n ?? 0) >= CONFIRMS_PER_DAY) {
      a.add('CONFIRM_RATE', 'warn', { confirmationId: p.confirmationId });
      claims = [];
    }
    // Reciprocal confirmations (A ↔ B) repeatedly with no third person: kept, but noted for review.
    const pair = await ctx.db.one<{ ab: string; ba: string }>(
      `SELECT count(*) FILTER (WHERE issuer_user_id = $1 AND subject_user_id = $2) AS ab, count(*) FILTER (WHERE issuer_user_id = $2 AND subject_user_id = $1) AS ba
       FROM peer_confirmations WHERE issued_sig IS NOT NULL AND issued_at > $3::timestamptz - interval '7 days'`,
      [row.issuer_user_id, a.s.user_id, row.issued_at],
    );
    if (Number(pair?.ab ?? 0) >= RECIPROCAL_LIMIT && Number(pair?.ba ?? 0) >= RECIPROCAL_LIMIT) a.add('CONFIRM_RECIPROCAL', 'warn', { confirmationId: p.confirmationId });
    if (!claims.length) {
      await reject(p.confirmationId, 'no_claims');
      continue;
    }
    matched[p.confirmationId] = lowerOnly(p.claims, claims);
    await ctx.db.query(`UPDATE peer_confirmations SET status = 'matched', reject_reason = NULL WHERE id = $1`, [p.confirmationId]);
  }
  return matched;
}

/** Self-reported counts faster than the counter allows (any 5-minute window) or above the session max. */
function countsStage(compiled: CompiledChallenge, events: ActivityEvent[], add: ClaimsArgs['add']) {
  const counters = new Map<string, { maxPerMinute: number; maxPerSession: number }>(compiled.modules.flatMap((m) => (m.counters ?? []).map((c) => [`${m.id}.${c.id}`, c] as [string, { maxPerMinute: number; maxPerSession: number }])));
  const by = new Map<string, Array<{ mono: number; delta: number }>>();
  for (const e of events) if (e.type === 'CountReported' && e.payload.delta > 0) by.set(e.payload.counterId, [...(by.get(e.payload.counterId) ?? []), { mono: e.monoMs, delta: e.payload.delta }]);
  for (const [id, list] of by) {
    const c = counters.get(id);
    if (!c) continue;
    const limit = Math.max(1, Math.ceil(c.maxPerMinute * 5));
    let worst = 0;
    for (let i = 0, j = 0, sum = 0; j < list.length; j++) {
      sum += list[j]!.delta;
      while (list[j]!.mono - list[i]!.mono > 300_000) sum -= list[i++]!.delta;
      worst = Math.max(worst, sum);
    }
    const total = list.reduce((n, x) => n + x.delta, 0);
    if (worst > limit || total > c.maxPerSession) add('COUNT_IMPLAUSIBLE', 'warn', { counterId: id, per5min: worst, total });
  }
}

