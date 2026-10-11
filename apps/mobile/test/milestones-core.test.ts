/**
 * Phone core units: milestone reconciliation rules, confirmation handshake errors, quest rules,
 * offline module storage, and migrations (node:sqlite, no server).
 */
import { decodeQr, uuidv7, type ConfirmationToken, type DeviceKeyPair } from '@trina/contracts';
import { DEMO_CENTER } from '@trina/engine/fixtures';
import { describe, expect, it } from 'vitest';
import { ConfirmationService, type KeyStore } from '../src/core/confirmations';
import { labelFor, MilestoneService } from '../src/core/milestones';
import { migrateLocal } from '../src/core/migrations';
import { OfflineStore } from '../src/core/offline-store';
import { SessionManager } from '../src/core/session-manager';
import { FakeClock, stay } from './helpers';
import { nodeSqlite } from './node-sqlite';

const keys = (): KeyStore => {
  let k: DeviceKeyPair | null = null;
  return { get: async () => k, set: async (x) => void (k = x) };
};

async function phone(userId = uuidv7()) {
  const db = nodeSqlite();
  await migrateLocal(db);
  await migrateLocal(db); // idempotent
  const store = new OfflineStore(db);
  const clock = new FakeClock(Date.parse('2026-10-12T02:00:00Z'));
  const milestones = new MilestoneService(db, store, { userId, now: () => clock.wallNow() });
  const sm = new SessionManager(db, store, clock, { userId, deviceId: uuidv7() }, { milestones, tzOffsetMin: () => 330 });
  const confirm = new ConfirmationService(db, sm, keys(), { userId, deviceId: uuidv7(), displayName: 'Me' }, () => clock.wallNow());
  return { db, store, clock, milestones, sm, confirm, userId };
}

const fix = (c: FakeClock) => ({ lat: DEMO_CENTER[1], lng: DEMO_CENTER[0], acc: 6, ts: new Date(c.wallNow()).toISOString() });
const spec = { templateId: 'outside_v1', targetMinutes: 30 as const, levelTier: 'easy' as const };

describe('milestones on the phone', () => {
  it('unlocks offline once, then reconciles: server rows final, disagreed rows revoked only after verdicts', async () => {
    const p = await phone();
    const sid = await p.sm.startQuest({ spec, startFix: fix(p.clock), online: false });
    await stay(p.sm, sid, p.clock, DEMO_CENTER, 31 * 60, 20);
    const done = await p.sm.finish(sid, 'rules', { shareWellbeing: false });
    const keysOf = (xs: Array<{ key: string; tier: string }>) => xs.map((x) => `${x.key}|${x.tier}`);
    expect(keysOf(done.unlocks)).toEqual(expect.arrayContaining(['*@1:q_offline_30|unlock', '*@1:outdoor_minutes|bronze']));
    await p.milestones.markNotified(done.unlocks);
    expect(await p.milestones.evaluateLocal()).toEqual([]); // nothing announced twice

    const day = done.unlocks[0]!.dayKey;
    // Server agrees on q_offline_30 only; outdoor_minutes is not confirmed yet (no verdict) → stays provisional.
    await p.milestones.reconcile([{ key: '*@1:q_offline_30', windowKey: day, tier: 'unlock', title: 'x', value: 1, verification: 'sensor', stat: 'VIT', dayKey: day, unlockedAt: null }]);
    const after = await p.milestones.all();
    expect(after.find((m) => m.key === '*@1:q_offline_30')!.status).toBe('final');
    expect(after.find((m) => m.key === '*@1:outdoor_minutes')!.status).toBe('provisional');
    expect((await p.milestones.newlyFinal()).map((m) => m.key)).toEqual(['*@1:q_offline_30']);
    // Once the session has a verdict and the server still doesn't list it, the provisional row is revoked.
    await p.db.run(`UPDATE sessions SET verdict = 'verified' WHERE id = ?`, [sid]);
    await p.milestones.reconcile([{ key: '*@1:q_offline_30', windowKey: day, tier: 'unlock', title: 'x', value: 1, verification: 'sensor', stat: 'VIT', dayKey: day, unlockedAt: null }]);
    expect((await p.milestones.all()).find((m) => m.key === '*@1:outdoor_minutes')!.status).toBe('revoked');
    // Revoked rows are never resurrected by local re-evaluation.
    await p.milestones.evaluateLocal();
    expect((await p.milestones.all()).find((m) => m.key === '*@1:outdoor_minutes')!.status).toBe('revoked');
  });

  it('labels verification honestly', () => {
    expect([labelFor('sensor'), labelFor('photo'), labelFor('peer'), labelFor('organizer'), labelFor('self_report'), labelFor('sensor', 'pending_server')]).toEqual([
      'Measured', 'Evidenced', 'Confirmed', 'Confirmed', 'Self-reported', 'Checked after sync',
    ]);
  });

  it('force-stopped quests are summarized (for the weekly penalty) and blocked starts are explained', async () => {
    const p = await phone();
    const sid = await p.sm.startQuest({ spec, startFix: fix(p.clock), online: false });
    await expect(p.sm.startQuest({ spec, startFix: fix(p.clock), online: false })).rejects.toThrow(/already in progress/);
    await p.sm.reportCount(sid, 'walking.nothing', 1).catch(() => undefined); // unknown counters are ignored by the engine
    await expect(p.sm.reportCount(sid, 'walking.x', 0)).rejects.toThrow(/Invalid count/);
    await p.sm.stopQuest(sid, 'force', null);
    const s = (await p.milestones.summaries())[0]!;
    expect(s.questStop).toBe('force');
    expect(s.status).toBe('abandoned');
    expect(await p.sm.activeQuestId()).toBeNull();
  });

  it('connectivity changes are recorded only when they change', async () => {
    const p = await phone();
    const sid = await p.sm.startQuest({ spec, startFix: fix(p.clock), online: false });
    expect(await p.sm.setConnectivity(sid, false, 'none')).toBe(false);
    expect(await p.sm.setConnectivity(sid, true, 'cellular')).toBe(true);
    expect(await p.sm.setConnectivity(sid, true, 'wifi')).toBe(false);
    expect(await p.sm.setConnectivity(sid, false, 'none')).toBe(true);
    const types = (await p.sm.events(sid)).filter((e) => e.type === 'ConnectivityChanged').map((e) => (e.payload as { online: boolean }).online);
    expect(types).toEqual([false, true, false]);
  });
});

describe('confirmation handshake errors', () => {
  it('refuses self-confirmation, other challenges, finished sessions and tampered tokens', async () => {
    const a = await phone();
    const b = await phone();
    const sa = await a.sm.startQuest({ spec, startFix: fix(a.clock), online: false });
    const sb = await b.sm.startQuest({ spec, startFix: fix(b.clock), online: false });
    const claims = [{ kind: 'counter' as const, ref: 'walking.laps', value: 2 }];
    await expect(a.confirm.request(sa, [])).rejects.toThrow(/at least one/);
    const qrA = await a.confirm.request(sa, claims);
    await expect(a.confirm.approve(qrA, sa)).rejects.toThrow(/own claims/);
    const { qr: qrB, claims: approved } = await b.confirm.approve(qrA, sb, { approved: [{ kind: 'counter', ref: 'walking.laps', value: 9 }] });
    expect(approved).toEqual([{ kind: 'counter', ref: 'walking.laps', value: 2 }]); // can lower, never raise
    await expect(b.confirm.accept(qrB, sb)).rejects.toThrow(/someone else/);
    await expect(a.confirm.accept(qrA, sa)).rejects.toThrow(/signed/);
    await expect(a.confirm.accept(qrB, sa, [{ userId: b.userId, deviceId: (decodeQr(qrB) as ConfirmationToken).body.issuerDeviceId, publicKey: '0'.repeat(64) }])).rejects.toThrow(/key/);
    const ok = await a.confirm.accept(qrB, sa);
    expect(ok.keyChecked).toBe(false);
    expect((await a.confirm.accept(qrB, sa)).claims).toEqual(approved); // idempotent: not recorded twice
    expect((await a.sm.events(sa)).filter((e) => e.type === 'ConfirmationReceived')).toHaveLength(1);
    await a.sm.finish(sa, 'manual', { shareWellbeing: false });
    await expect(a.confirm.request(sa, claims)).rejects.toThrow(/before finishing/);
  });
});
