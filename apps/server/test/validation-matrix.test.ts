/**
 * Anti-cheat matrix: one crafted session per validation flag. Each must raise its flag with the
 * documented severity and verdict, and never use accusatory wording.
 */
import { computeEventHash, genesisHash, uuidv7, type ActivityEvent } from '@trina/contracts';
import { destinationPoint } from '@trina/engine';
import { SessionBuilder, greenSprintDefinition, greenSprintPoints } from '@trina/engine/fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMaintenance } from '../src/modules/validation/jobs';
import { GS_HASH, hoursAgo, jpeg, pushEvents, setup, sha, type TestUser } from './helpers';

let t: Awaited<ReturnType<typeof setup>>;
let challengeId: string;
const P = greenSprintPoints();

beforeAll(async () => {
  t = await setup();
  challengeId = await t.publishedChallenge(await t.user('org'));
});
afterAll(async () => {
  await t.cleanup();
});

/** Recomputes the hash chain after a test deliberately edits events. */
function seal(events: ActivityEvent[]): ActivityEvent[] {
  let prev = genesisHash(events[0]!.sessionId);
  return events.map((e) => {
    const base = { ...e, prevHash: prev } as ActivityEvent;
    prev = computeEventHash(base);
    return { ...base, hash: prev } as ActivityEvent;
  });
}

type Outcome = { codes: string[]; severities: Record<string, string>; verdict: string; messages: string[] };

async function play(build: (b: SessionBuilder, ctx: { photo: (task: string, cp: string | null) => Promise<void> }) => Promise<void> | void, opts: { challenge?: string; startTs?: string; definitionHash?: string; edit?: (e: ActivityEvent[]) => ActivityEvent[]; forceValidate?: boolean } = {}): Promise<Outcome> {
  const u: TestUser = await t.user();
  const cid = opts.challenge ?? challengeId;
  await t.api.post(`/v1/challenges/${cid}/join`).set(u.auth).send({}).expect(201);
  const b = new SessionBuilder({ challengeId: cid, definitionHash: opts.definitionHash ?? GS_HASH, userId: u.user.id, deviceId: u.deviceId, start: P.start, startTs: opts.startTs ?? hoursAgo(2) });
  const uploads: { id: string; bytes: Buffer }[] = [];
  let seed = Math.floor(Math.random() * 1e6);
  await build(b, {
    photo: async (task, cp) => {
      const bytes = await jpeg(seed++);
      const id = uuidv7();
      b.evidence(task, sha(bytes), id, cp);
      uploads.push({ id, bytes });
    },
  });
  let events = b.build();
  if (opts.edit) events = opts.edit(events);
  await pushEvents(t.api, u, b.sessionId, events).expect(200);
  for (const up of uploads) await t.api.put(`/v1/evidence/${up.id}/content`).set(u.auth).set('Content-Type', 'image/jpeg').send(up.bytes);
  if (opts.forceValidate) {
    await t.ctx.db.query(`UPDATE activity_sessions SET last_received_at = now() - interval '3 days' WHERE id = $1`, [b.sessionId]);
    await runMaintenance(t.ctx);
  }
  await t.ctx.jobs.drain();
  const s = await t.api.get(`/v1/sessions/${b.sessionId}`).set(u.auth);
  return {
    codes: s.body.flags.map((f: any) => f.code),
    severities: Object.fromEntries(s.body.flags.map((f: any) => [f.code, f.severity])),
    verdict: s.body.verdict,
    messages: s.body.flags.map((f: any) => f.message),
  };
}

describe('validation matrix', () => {
  it('clean walk → verified, no flags (no false positives)', async () => {
    const o = await play((b) => void b.start().moveTo(P.cp1).wait(15).complete());
    expect(o.codes).toEqual([]);
    expect(o.verdict).toBe('verified');
  });

  it('CLOCK_DRIFT (warn): the wall clock jumps while monotonic time does not', async () => {
    const o = await play((b) => void b.start().moveTo(P.cp1).wait(15).complete(), {
      edit: (ev) => seal(ev.map((e, i) => (i === ev.length - 1 ? { ...e, clientTs: new Date(Date.parse(e.clientTs) + 20 * 60_000).toISOString() } : e))),
    });
    expect(o.severities.CLOCK_DRIFT).toBe('warn');
    expect(o.verdict).toBe('verified_with_notes');
  });

  it('FUTURE_EVENT (critical): timestamps later than the server received them', async () => {
    const o = await play((b) => void b.start().moveTo(P.cp1).complete(), { startTs: new Date(Date.now() + 86_400_000).toISOString() });
    expect(o.severities.FUTURE_EVENT).toBe('critical');
    expect(o.verdict).toBe('needs_review');
  });

  it('OUTSIDE_WINDOW (critical): played before the challenge window opened', async () => {
    const def: any = greenSprintDefinition();
    def.timing.window = { opensAt: new Date(Date.now() + 86_400_000).toISOString(), closesAt: new Date(Date.now() + 3 * 86_400_000).toISOString() };
    const org = await t.user();
    const cid = await t.publishedChallenge(org, def);
    const hash = (await t.ctx.db.one<{ definition_hash: string }>('SELECT definition_hash FROM challenge_versions WHERE challenge_id = $1', [cid]))!.definition_hash;
    const o = await play((b) => void b.start().moveTo(P.cp1).complete(), { challenge: cid, definitionHash: hash });
    expect(o.severities.OUTSIDE_WINDOW).toBe('critical');
  });

  it('DEFINITION_MISMATCH (critical): the phone played different rules', async () => {
    const o = await play((b) => void b.start().complete(), { definitionHash: 'b'.repeat(64) });
    expect(o.severities.DEFINITION_MISMATCH).toBe('critical');
  });

  it('START_OUTSIDE_ZONE (critical): started far from the start zone', async () => {
    const o = await play((b) => void b.start().complete(), {
      edit: (ev) => seal(ev.map((e) => (e.type === 'SessionStarted' ? ({ ...e, payload: { ...e.payload, startFix: { ...e.payload.startFix, lat: P.cp3[1] - 0.01 } } } as ActivityEvent) : e))),
    });
    expect(o.severities.START_OUTSIDE_ZONE).toBe('critical');
  });

  it('LOCATION_JUMP (warn): a teleport that is not a mocked fix', async () => {
    const o = await play((b) => void b.start().teleport(destinationPoint(P.start, 0, 3000)).moveTo(P.start, 1.4, 30).complete());
    expect(o.severities.LOCATION_JUMP).toBe('warn');
  });

  it('TOO_FAST (warn): 10 pieces of litter "collected" in 10 seconds', async () => {
    const o = await play(async (b, { photo }) => {
      b.start().moveTo(P.cp1).wait(15).moveTo(P.cp2).wait(10);
      await photo('litter', 'cp2');
      b.completeTask('litter', 10).complete();
    });
    expect(o.severities.TOO_FAST).toBe('warn');
  });

  it('STEPS_GPS_MISMATCH (warn): walking 2 km with almost no steps', async () => {
    const o = await play((b) => {
      b.start().emit('StepsSample', { cumulative: 1, delta: 1, source: 'simulated' });
      b.moveTo(P.cp1, 1.4, 5, { stepsPerM: 0 }).moveTo(P.cp2, 1.4, 5, { stepsPerM: 0 }).moveTo(P.cp3, 1.4, 5, { stepsPerM: 0 }).complete();
    });
    expect(o.severities.STEPS_GPS_MISMATCH).toBe('warn');
  });

  it('CADENCE_IMPLAUSIBLE (warn): 800+ steps per minute (phone being shaken)', async () => {
    const o = await play((b) => void b.start().moveTo(P.cp1, 1.4, 5, { stepsPerM: 10 }).moveTo(P.cp2, 1.4, 5, { stepsPerM: 10 }).moveTo(P.cp3, 1.4, 5, { stepsPerM: 10 }).complete());
    expect(o.severities.CADENCE_IMPLAUSIBLE).toBe('warn');
  });

  it('SEQ_GAP (warn): an event never arrived; validated after the 48 h timeout', async () => {
    const o = await play((b) => void b.start().moveTo(P.cp1).wait(15).emit('GpsSignalLost', {}).moveTo(P.cp2).complete(), {
      edit: (ev) => ev.filter((e) => e.type !== 'GpsSignalLost'),
      forceValidate: true,
    });
    expect(o.severities.SEQ_GAP).toBe('warn');
    expect(o.codes).not.toContain('CHAIN_BROKEN');
  });

  it('CP_MANUAL and GPS_WEAK (info): honest weak-GPS situations stay verified', async () => {
    const near = destinationPoint(P.cp1, 180, 70);
    const o = await play((b) => void b.start().moveTo(near).emit('GpsSignalLost', {}).emit('CheckpointManualConfirm', { checkpointId: 'cp1', fix: null }).complete());
    expect(o.severities.CP_MANUAL).toBe('info');
    expect(o.severities.GPS_WEAK).toBe('info');
    expect(o.verdict).toBe('verified');
  });

  it('EVIDENCE_OFF_LOCATION (info): a photo taken away from its tree is not counted', async () => {
    const o = await play(async (b, { photo }) => {
      b.start().moveTo(P.cp1).wait(15).moveTo(P.cp2).wait(15).moveTo(P.cp3).wait(15).moveTo(P.start);
      await photo('tree1', 'cp3');
      b.completeTask('tree1').complete();
    });
    expect(o.severities.EVIDENCE_OFF_LOCATION).toBe('info');
  });

  it('flag messages are neutral (no "cheat", "fraud" or "fake")', async () => {
    const all = await t.ctx.db.query<{ message: string }>('SELECT DISTINCT message FROM session_flags');
    expect(all.length).toBeGreaterThan(8);
    for (const m of all) expect(m.message).not.toMatch(/cheat|fraud|fake|liar/i);
  });
});
