import { haversineM, defaultRegistry, type CompiledChallenge } from '@trina/engine';
import type { LngLat } from '@trina/contracts';
import sharp from 'sharp';
import type { SessionManager } from '../src/core/session-manager';
import { FakeClock, stay, tmp, walk, writePhoto } from './helpers';

let photoSeed = 1;

/**
 * A scripted "participant" that plays ANY compiled challenge through the real SessionManager:
 * walks the route, dwells at checkpoints, photographs evidence, completes tasks, returns to the finish.
 */
export async function autoPlay(
  sm: SessionManager,
  clock: FakeClock,
  compiled: CompiledChallenge,
  challengeId: string,
  version: number,
  opts: { stopAfterCheckpoints?: number; mocked?: boolean; speed?: number; abandon?: boolean; moodBefore?: number } = {},
): Promise<string> {
  const d = compiled.definition;
  const start = d.area.startZone.center;
  const dir = tmp();
  const speed = opts.speed ?? (compiled.modules.some((m) => m.id === 'cycling') ? 4 : 1.4);
  const sessionId = await sm.start({ challengeId, version, startFix: { lat: start[1], lng: start[0], acc: 6, ts: new Date(clock.wallNow()).toISOString(), mocked: opts.mocked } });
  if (opts.moodBefore) await sm.setMood(sessionId, 'before', opts.moodBefore);

  const doTask = async (taskId: string, at: LngLat) => {
    const t = compiled.tasks.get(taskId)!;
    const tt = defaultRegistry.taskType(t.type)!.task;
    await sm.append(sessionId, 'TaskStarted', { taskId });
    await stay(sm, sessionId, clock, at, Math.max(30, tt.minTaskSeconds ?? 0) + 10);
    for (const ev of t.evidence) {
      for (let i = 0; i < ev.count; i++) {
        const bytes = await sharp({ create: { width: 24, height: 24, channels: 3, background: { r: photoSeed * 37 % 255, g: photoSeed * 11 % 255, b: photoSeed * 101 % 255 } } }).jpeg().toBuffer();
        const p = await writePhoto(dir, `${taskId}-${photoSeed++}`, bytes);
        await sm.captureEvidence({ sessionId, taskId, checkpointId: t.location.kind === 'checkpoint' ? t.location.ref! : null, fileUri: p.uri, sha256: p.sha256, bytes: p.bytes, fix: { lat: at[1], lng: at[0], acc: 6, ts: new Date(clock.wallNow()).toISOString() } });
      }
    }
    await sm.append(sessionId, 'TaskCompleted', { taskId, ...(typeof t.params.quantity === 'number' ? { quantity: t.params.quantity } : {}) });
  };

  let pos: LngLat = start;
  const fixes = (to: LngLat) => (opts.mocked ? mockedWalk(sm, sessionId, clock, to) : walk(sm, sessionId, clock, pos, to, speed));
  // Tasks that can be done anywhere: do them at the start.
  for (const [id, t] of compiled.tasks) if (t.location.kind !== 'checkpoint') await doTask(id, pos);
  let reached = 0;
  for (const cpId of compiled.routeOrder) {
    if (opts.stopAfterCheckpoints !== undefined && reached >= opts.stopAfterCheckpoints) break;
    const cp = compiled.checkpoints.get(cpId)!;
    pos = await fixes(cp.geometry.center);
    await stay(sm, sessionId, clock, pos, cp.dwellSec + 15);
    reached++;
    for (const [id, t] of compiled.tasks) if (t.location.kind === 'checkpoint' && t.location.ref === cpId) await doTask(id, pos);
  }
  await sm.append(sessionId, 'StepsSample', { cumulative: 3000, delta: 3000, source: 'simulated' });
  if (opts.abandon) {
    await sm.abandon(sessionId, 'tired');
    return sessionId;
  }
  const end = d.area.endZone?.center ?? start;
  if (haversineM(pos, end) > 1) pos = await fixes(end);
  await stay(sm, sessionId, clock, pos, 15);
  await sm.finish(sessionId, 'rules', { shareWellbeing: true });
  return sessionId;
}

async function mockedWalk(sm: SessionManager, sessionId: string, clock: FakeClock, to: LngLat): Promise<LngLat> {
  clock.advance(60_000);
  await sm.addFixes(sessionId, [{ lat: to[1], lng: to[0], acc: 3, timestamp: clock.wallNow(), mocked: true }]);
  await sm.append(sessionId, 'MockLocationDetected', { fix: { lat: to[1], lng: to[0], acc: 3, ts: new Date(clock.wallNow()).toISOString(), mocked: true } });
  return to;
}
