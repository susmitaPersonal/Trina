import { haversineM } from '@trina/engine';
import * as Location from 'expo-location';
import { Pedometer } from 'expo-sensors';
import { AppState, type NativeEventSubscription } from 'react-native';
import { checkLive } from '../app/live-monitor';
import { getServices } from '../app/services';
import { LOCATION_TASK, toRawFix } from './location-task';

let fallbackWatch: Location.LocationSubscription | null = null;
let stepSub: { remove(): void } | null = null;
let stepTimer: ReturnType<typeof setInterval> | null = null;
let appStateSub: NativeEventSubscription | null = null;
let stepsPending = 0;
let stepsTotal = 0;
let mode: 'background' | 'foreground_only' | null = null;
let currentProfile: 'far' | 'near' | null = null;

/** Adaptive sampling (docs/architecture/location.md §3): high accuracy only near checkpoints. */
function optionsFor(profile: 'far' | 'near'): Location.LocationTaskOptions {
  const near = profile === 'near';
  return {
    accuracy: near ? Location.Accuracy.BestForNavigation : Location.Accuracy.Balanced,
    timeInterval: near ? 3000 : 10_000,
    distanceInterval: near ? 5 : 15,
    activityType: Location.ActivityType.Fitness,
    pausesUpdatesAutomatically: false,
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: 'Trina challenge in progress 🌱',
      notificationBody: 'Phone in pocket. We will buzz at checkpoints.',
      killServiceOnDestroy: false,
    },
  };
}

async function startUpdates(profile: 'far' | 'near') {
  currentProfile = profile;
  try {
    await Location.startLocationUpdatesAsync(LOCATION_TASK, optionsFor(profile));
    mode = 'background';
  } catch {
    // Some devices/OS versions refuse background updates without "Always": fall back to in-app tracking.
    fallbackWatch?.remove();
    fallbackWatch = await Location.watchPositionAsync({ accuracy: Location.Accuracy.High, timeInterval: 5000, distanceInterval: 5 }, async (l) => {
      const s = await getServices();
      const sid = await s.store.getMeta('active_session_id');
      if (!sid) return;
      await (await s.sessions()).addFixes(sid, [toRawFix(l)]);
      await checkLive(sid);
    });
    mode = 'foreground_only';
  }
}

/** Re-tunes GPS accuracy based on distance to the next checkpoint (battery). */
export async function adaptSampling(distanceToNextM: number | null) {
  if (mode !== 'background') return;
  const want = distanceToNextM !== null && distanceToNextM < 300 ? 'near' : 'far';
  if (want !== currentProfile) await startUpdates(want);
}

export async function startRuntime(sessionId: string): Promise<'background' | 'foreground_only'> {
  await startUpdates('near');
  // Steps (optional): count deltas and record a StepsSample every 60 s.
  try {
    if (await Pedometer.isAvailableAsync()) {
      const perm = await Pedometer.requestPermissionsAsync();
      if (perm.granted) {
        stepsTotal = 0;
        stepSub = Pedometer.watchStepCount((r) => {
          const delta = Math.max(0, r.steps - stepsTotal);
          stepsTotal = r.steps;
          stepsPending += delta;
        });
        stepTimer = setInterval(() => void flushSteps(sessionId), 60_000);
      }
    }
  } catch {
    /* steps are optional */
  }
  appStateSub = AppState.addEventListener('change', async (state) => {
    const sm = await (await getServices()).sessions();
    if ((await sm.activeSessionId()) !== sessionId) return;
    if (state === 'background') await sm.append(sessionId, 'AppBackgrounded', {});
    else if (state === 'active') await sm.append(sessionId, 'AppForegrounded', {});
  });
  return mode!;
}

export async function flushSteps(sessionId: string) {
  if (stepsPending <= 0) return;
  const delta = stepsPending;
  stepsPending = 0;
  const sm = await (await getServices()).sessions();
  if ((await sm.activeSessionId()) !== sessionId) return;
  await sm.append(sessionId, 'StepsSample', { cumulative: stepsTotal, delta, source: 'expo_pedometer' });
}

export async function stopRuntime(sessionId?: string) {
  if (sessionId) await flushSteps(sessionId).catch(() => undefined);
  try {
    if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK)) await Location.stopLocationUpdatesAsync(LOCATION_TASK);
  } catch {
    /* ignore */
  }
  fallbackWatch?.remove();
  fallbackWatch = null;
  stepSub?.remove();
  stepSub = null;
  if (stepTimer) clearInterval(stepTimer);
  stepTimer = null;
  appStateSub?.remove();
  appStateSub = null;
  mode = null;
  currentProfile = null;
}

/** Resumes tracking after an app restart if a session is still active. */
export async function resumeRuntimeIfNeeded(): Promise<string | null> {
  const s = await getServices();
  const me = await s.me();
  if (!me) return null;
  const sid = await (await s.sessions()).activeSessionId();
  if (sid && !mode) await startRuntime(sid);
  return sid;
}

export function distanceToNext(snapshot: { compiled: { routeOrder: string[]; checkpoints: Map<string, { geometry: { center: [number, number] } }> }; state: { checkpoints: Record<string, { reached: boolean }>; lastSample: { lng: number; lat: number } | null } }) {
  const next = snapshot.compiled.routeOrder.find((id) => !snapshot.state.checkpoints[id]?.reached);
  const last = snapshot.state.lastSample;
  if (!next || !last) return null;
  return haversineM([last.lng, last.lat], snapshot.compiled.checkpoints.get(next)!.geometry.center);
}

export function trackingMode() {
  return mode;
}
