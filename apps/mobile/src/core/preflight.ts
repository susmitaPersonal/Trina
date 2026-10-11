import { ENGINE_VERSION, haversineM, inCircle, type CompiledChallenge } from '@trina/engine';

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'pending';
export type CheckId =
  | 'auth'
  | 'downloaded'
  | 'engine'
  | 'route'
  | 'location_permission'
  | 'notifications'
  | 'gps_accuracy'
  | 'start_zone'
  | 'camera'
  | 'activity_permission'
  | 'storage'
  | 'battery'
  | 'window'
  | 'eligibility'
  | 'clock'
  | 'map';

export type PreflightCheck = { id: CheckId; label: string; status: CheckStatus; blocking: boolean; detail?: string; fix?: string };

export type PreflightInput = {
  signedInBefore: boolean;
  compiled: CompiledChallenge | null;
  engineMinVersion: number;
  participationJoined: boolean;
  locationPermission: 'granted' | 'denied' | 'undetermined';
  notificationPermission: 'granted' | 'denied' | 'undetermined' | 'not_required';
  cameraPermission: 'granted' | 'denied' | 'undetermined';
  activityPermission: 'granted' | 'denied' | 'undetermined' | 'unavailable';
  fix: { lat: number; lng: number; acc: number } | null;
  fixWaitedMs: number;
  freeBytes: number | null;
  batteryLevel: number | null;
  /** Device now corrected by the server offset recorded at download. */
  serverNowMs: number;
  /** |device - server| drift measured at the last online moment, ms. */
  clockSkewMs: number | null;
  hasMapPack: boolean;
};

export const GPS_START_ACCURACY_M = 50;
export const GPS_WAIT_MS = 30_000;

/**
 * Deterministic pre-flight evaluation (docs/product/ux-screens.md#pre-flight-check).
 * Blocking failures disable Start; warnings let the participant continue.
 */
export function evaluatePreflight(i: PreflightInput): { checks: PreflightCheck[]; canStart: boolean; distanceToStartM: number | null } {
  const c: PreflightCheck[] = [];
  const add = (x: PreflightCheck) => c.push(x);
  const def = i.compiled?.definition;

  add({ id: 'auth', label: 'Signed in', status: i.signedInBefore ? 'pass' : 'fail', blocking: true, fix: 'Sign in once while online' });
  add({ id: 'downloaded', label: 'Challenge downloaded', status: i.compiled ? 'pass' : 'fail', blocking: true, fix: 'Download for offline' });
  add({
    id: 'engine',
    label: 'App can run these rules',
    status: i.engineMinVersion <= ENGINE_VERSION ? 'pass' : 'fail',
    blocking: true,
    fix: 'Update Trina',
  });
  add({ id: 'route', label: 'Route & checkpoints available', status: i.compiled && (def!.checkpoints.length > 0 || def!.route.type === 'free' || i.compiled.tasks.size > 0) ? 'pass' : 'fail', blocking: true, fix: 'Re-download the challenge' });
  add({ id: 'eligibility', label: 'You joined this challenge', status: i.participationJoined ? 'pass' : 'fail', blocking: true, fix: 'Join the challenge' });

  const window = def?.timing.window;
  let windowOk = true;
  if (window) {
    const opens = Date.parse(window.opensAt) - (def!.timing.startGraceMin ?? 0) * 60_000;
    windowOk = i.serverNowMs >= opens && i.serverNowMs + 60_000 <= Date.parse(window.closesAt);
  }
  add({ id: 'window', label: 'Challenge is open now', status: windowOk ? 'pass' : 'fail', blocking: true, detail: windowOk ? undefined : 'Outside the challenge window' });

  add({
    id: 'location_permission',
    label: 'Location (while using the app)',
    status: i.locationPermission === 'granted' ? 'pass' : 'fail',
    blocking: true,
    fix: 'Allow location',
  });
  if (i.notificationPermission !== 'not_required') {
    add({ id: 'notifications', label: 'Notifications (lock-screen progress)', status: i.notificationPermission === 'granted' ? 'pass' : 'warn', blocking: false, fix: 'Allow notifications' });
  }

  const needsCamera = i.compiled ? [...i.compiled.tasks.values()].some((t) => t.evidence.length > 0) : false;
  if (needsCamera) {
    add({ id: 'camera', label: 'Camera (for evidence photos)', status: i.cameraPermission === 'granted' ? 'pass' : 'fail', blocking: true, fix: 'Allow camera' });
  }
  add({
    id: 'activity_permission',
    label: 'Step counting',
    status: i.activityPermission === 'granted' ? 'pass' : 'warn',
    blocking: false,
    detail: i.activityPermission === 'granted' ? undefined : "Steps won't be counted",
    fix: i.activityPermission === 'unavailable' ? undefined : 'Allow physical activity',
  });

  // GPS
  let gps: CheckStatus = 'pending';
  if (i.fix && i.fix.acc <= GPS_START_ACCURACY_M) gps = 'pass';
  else if (i.fixWaitedMs >= GPS_WAIT_MS) gps = 'fail';
  add({
    id: 'gps_accuracy',
    label: 'GPS signal',
    status: gps,
    blocking: true,
    detail: i.fix ? `±${Math.round(i.fix.acc)} m` : 'Waiting for GPS…',
    fix: 'Move to open sky',
  });

  let distanceToStartM: number | null = null;
  let zone: CheckStatus = 'pending';
  if (def && i.fix) {
    distanceToStartM = Math.round(haversineM([i.fix.lng, i.fix.lat], def.area.startZone.center));
    zone = inCircle([i.fix.lng, i.fix.lat], i.fix.acc, def.area.startZone, 100, 25) ? 'pass' : 'fail';
  }
  add({
    id: 'start_zone',
    label: 'In the start zone',
    status: zone,
    blocking: true,
    detail: distanceToStartM !== null && zone !== 'pass' ? `${distanceToStartM} m away` : undefined,
    fix: 'Walk to the start',
  });

  const photos = i.compiled ? [...i.compiled.tasks.values()].reduce((n, t) => n + t.evidence.reduce((m, e) => m + e.count, 0), 0) : 0;
  const needBytes = photos * 1_000_000 + 50_000_000;
  add({
    id: 'storage',
    label: 'Enough storage',
    status: i.freeBytes === null ? 'warn' : i.freeBytes >= needBytes ? 'pass' : 'fail',
    blocking: i.freeBytes !== null,
    fix: 'Free up some space',
  });
  add({
    id: 'battery',
    label: 'Battery',
    status: i.batteryLevel === null || i.batteryLevel >= 0.2 ? 'pass' : 'warn',
    blocking: false,
    detail: i.batteryLevel !== null ? `${Math.round(i.batteryLevel * 100)}%` : undefined,
  });
  add({
    id: 'clock',
    label: 'Phone clock',
    status: i.clockSkewMs === null ? 'warn' : Math.abs(i.clockSkewMs) <= 5 * 60_000 ? 'pass' : 'warn',
    blocking: false,
    detail: i.clockSkewMs === null ? 'Go online once to check' : undefined,
  });
  add({ id: 'map', label: 'Offline map', status: i.hasMapPack ? 'pass' : 'warn', blocking: false, detail: i.hasMapPack ? undefined : 'Compass view will be used' });

  const canStart = c.every((x) => !x.blocking || x.status === 'pass');
  return { checks: c, canStart, distanceToStartM };
}
