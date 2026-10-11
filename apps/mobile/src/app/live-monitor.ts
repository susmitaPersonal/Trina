import * as Haptics from 'expo-haptics';
import * as Notifications from 'expo-notifications';
import type { LiveSnapshot } from '../core/session-manager';
import { announceMilestones } from './milestone-notify';
import { setQuestActive } from './quest-runtime';
import { getServices } from './services';

type Seen = { checkpoints: Set<string>; halfway: boolean; lastTen: boolean; finished: boolean };
const seen = new Map<string, Seen>();
const listeners = new Set<(s: LiveSnapshot) => void>();

export function onLiveSnapshot(fn: (s: LiveSnapshot) => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

async function notify(title: string, body: string) {
  try {
    await Notifications.scheduleNotificationAsync({ content: { title, body, sound: true }, trigger: null });
  } catch {
    /* notifications not permitted: haptics still work */
  }
}

function line(snap: LiveSnapshot, trigger: string): string | null {
  const opts = snap.challenge.bundle.encouragement.filter((e) => e.trigger === trigger);
  return opts.length ? opts[snap.state.samplesTotal % opts.length]!.text : null;
}

/**
 * Runs after every GPS update (foreground or background task). Pocket-first feedback:
 * haptics + notifications on checkpoints, halfway, last 10 minutes; auto-finish by rules or time.
 */
export async function checkLive(sessionId: string): Promise<LiveSnapshot | null> {
  const s = await getServices();
  const sm = await s.sessions();
  const snap = await sm.snapshot(sessionId);
  let st = seen.get(sessionId);
  if (!st) {
    st = { checkpoints: new Set(Object.entries(snap.state.checkpoints).filter(([, c]) => c.reached).map(([id]) => id)), halfway: false, lastTen: false, finished: false };
    seen.set(sessionId, st);
  }
  if (snap.state.status !== 'active' || st.finished) return snap;

  for (const [id, cp] of Object.entries(snap.state.checkpoints)) {
    if (!cp.reached || st.checkpoints.has(id)) continue;
    st.checkpoints.add(id);
    const def = snap.compiled.checkpoints.get(id)!;
    const last = snap.state.lastSample;
    await sm.append(sessionId, 'CheckpointEntered', {
      checkpointId: id,
      fix: { lat: last?.lat ?? def.geometry.center[1], lng: last?.lng ?? def.geometry.center[0], acc: last?.acc ?? 0, ts: new Date().toISOString() },
    });
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
    const unlocked = [...snap.compiled.tasks.values()].filter((t) => t.location.kind === 'checkpoint' && t.location.ref === id);
    await notify(`✓ ${def.name}`, unlocked.length ? `Task unlocked: ${unlocked[0]!.title}` : (line(snap, 'checkpoint') ?? 'Checkpoint reached'));
  }
  const total = snap.compiled.checkpoints.size;
  if (!st.halfway && total >= 2 && st.checkpoints.size >= Math.ceil(total / 2)) {
    st.halfway = true;
    const l = line(snap, 'halfway');
    if (l) await notify('Halfway there', l);
  }
  if (!st.lastTen && snap.remainingMs <= 10 * 60_000 && snap.remainingMs > 0) {
    st.lastTen = true;
    await notify('10 minutes left', line(snap, 'last_ten_minutes') ?? 'No rush, stay safe.');
  }
  const me = await s.me();
  if (snap.score.completed || snap.remainingMs === 0) {
    st.finished = true;
    const reason = snap.score.completed ? 'rules' : 'timeout';
    const done = await sm.finish(sessionId, reason, { shareWellbeing: me?.shareWellbeing ?? false });
    if (snap.state.quest) await setQuestActive(null); // quest over: the guard lifts, data syncs now
    await announceMilestones(await s.milestones(), { haptic: false }).catch(() => undefined);
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
    await notify(reason === 'rules' ? 'Challenge complete! 🌱' : "Time's up", `${done.score.total} points (provisional). Open Trina to see your results.`);
    void s.sync.runOnce();
    listeners.forEach((fn) => fn(done));
    return done;
  }
  listeners.forEach((fn) => fn(snap));
  return snap;
}
