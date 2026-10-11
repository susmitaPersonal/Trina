import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import type { RawFix } from '../core/session-manager';

export const LOCATION_TASK = 'trina-location';

export function toRawFix(l: Location.LocationObject): RawFix {
  return {
    lat: l.coords.latitude,
    lng: l.coords.longitude,
    acc: l.coords.accuracy ?? 999,
    speed: l.coords.speed,
    heading: l.coords.heading,
    alt: l.coords.altitude,
    timestamp: l.timestamp,
    mocked: l.mocked === true,
  };
}

/**
 * Background location task (Android foreground service / iOS background mode, started while in use).
 * Writes fixes straight to SQLite, so nothing is lost even if the UI is gone.
 */
TaskManager.defineTask<{ locations: Location.LocationObject[] }>(LOCATION_TASK, async ({ data, error }) => {
  if (error || !data?.locations?.length) return;
  // Lazy import keeps this module light at app start.
  const { getServices } = await import('../app/services');
  const { checkLive } = await import('../app/live-monitor');
  const s = await getServices();
  const sid = await s.store.getMeta('active_session_id');
  if (!sid) return;
  const sm = await s.sessions();
  await sm.addFixes(sid, data.locations.map(toRawFix));
  if (data.locations.some((l) => l.mocked)) {
    const l = data.locations.find((x) => x.mocked)!;
    await sm.append(sid, 'MockLocationDetected', { fix: { lat: l.coords.latitude, lng: l.coords.longitude, acc: l.coords.accuracy ?? 999, ts: new Date(l.timestamp).toISOString(), mocked: true } });
  }
  await checkLive(sid);
});
