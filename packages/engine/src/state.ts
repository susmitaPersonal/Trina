import type { ActivityEvent, LocationSample, LngLat } from '@trina/contracts';
import { distanceOutsideZoneM, haversineM, inCircle } from './geo';
import type { AcceptedSample, CompiledChallenge, EvaluateOptions, SessionState } from './types';

export const MAX_SAMPLE_ACCURACY_M = 100;
export const DISTANCE_SAMPLE_ACCURACY_M = 50;
export const BOUNDARY_EXIT_CONFIRM_MS = 30_000;
export const MANUAL_CONFIRM_MAX_AGE_MS = 120_000;
export const MANUAL_CONFIRM_EXTRA_M = 75;
export const TRACK_MIN_STEP_M = 5;
/** Gaps longer than this between in-zone fixes don't count as time in the zone. */
export const ZONE_GAP_MS = 60_000;
export const MAX_ZONE_INTERVALS = 50;

export function initialState(compiled: CompiledChallenge): SessionState {
  const checkpoints: SessionState['checkpoints'] = {};
  for (const id of compiled.checkpoints.keys()) {
    checkpoints[id] = { reached: false, reachedAtMono: null, insideSinceMono: null, qualifyingFixes: 0, manual: false };
  }
  const tasks: SessionState['tasks'] = {};
  for (const [id, t] of compiled.tasks) {
    tasks[id] = {
      status: t.location.kind === 'checkpoint' ? 'locked' : 'available',
      availableAtMono: t.location.kind === 'checkpoint' ? null : 0,
      startedAtMono: null,
      completedAtMono: null,
      quantity: null,
      evidenceIds: [],
      rejectedCompletions: 0,
      doneVia: null,
    };
  }
  return {
    status: 'not_started',
    sessionId: null,
    startMono: null,
    startClientTs: null,
    endMono: null,
    lastMono: 0,
    pausedMs: 0,
    pauseStartMono: null,
    anchor: null,
    lastSample: null,
    distanceM: 0,
    movingMs: 0,
    samplesTotal: 0,
    samplesRejected: { accuracy: 0, mocked: 0, jump: 0 },
    checkpoints,
    tasks,
    evidence: {},
    boundary: { inside: true, outsideSinceMono: null, exits: 0, exitCounted: false },
    inEndZone: false,
    steps: null,
    backgroundSinceMono: null,
    backgroundMs: 0,
    gpsLost: 0,
    lateEvents: 0,
    completionReason: null,
    track: [],
    zoneDwellMs: 0,
    lastZoneMono: null,
    zoneIntervals: [],
    counters: {},
    confirmed: {},
    confirmationIds: [],
    tzOffsetMin: null,
    quest: null,
    online: null,
    offlineSinceMono: null,
    offlineIntervals: [],
    questStop: null,
  };
}

/** Task type definition (from the challenge's modules) for a challenge task. */
function taskTypeOf(compiled: CompiledChallenge, taskId: string) {
  const def = compiled.tasks.get(taskId);
  if (!def) return undefined;
  for (const m of compiled.modules) for (const tt of m.taskTypes) if (`${m.id}.${tt.id}` === def.type) return tt;
  return undefined;
}

/** Inside the play area: the boundary when there is one, else the start zone. */
function inPlayArea(compiled: CompiledChallenge, p: LngLat, acc: number): boolean {
  const b = compiled.definition.area.boundary;
  if (b) return distanceOutsideZoneM(p, b) <= b.graceM + Math.min(acc, 25);
  return inCircle(p, acc, compiled.definition.area.startZone, DISTANCE_SAMPLE_ACCURACY_M);
}

function trackZone(compiled: CompiledChallenge, s: SessionState, p: LngLat, sample: AcceptedSample) {
  if (sample.acc > DISTANCE_SAMPLE_ACCURACY_M) return; // poor fix: neither counts nor resets
  if (!inPlayArea(compiled, p, sample.acc)) {
    s.lastZoneMono = null;
    return;
  }
  const last = s.lastZoneMono;
  if (last !== null && sample.monoMs - last <= ZONE_GAP_MS) {
    s.zoneDwellMs += sample.monoMs - last;
    const iv = s.zoneIntervals[s.zoneIntervals.length - 1];
    if (iv) iv[1] = sample.monoMs;
  } else {
    s.zoneIntervals.push([sample.monoMs, sample.monoMs]);
    if (s.zoneIntervals.length > MAX_ZONE_INTERVALS) {
      // Merge the two oldest intervals (keeps the list bounded; only widens coverage slightly).
      const [a, b] = s.zoneIntervals.splice(0, 2) as [[number, number], [number, number]];
      s.zoneIntervals.unshift([a[0], b[1]]);
    }
  }
  s.lastZoneMono = sample.monoMs;
}

/** Deadline (mono ms) after which activity no longer counts. Pauses extend it. */
export function deadlineMono(compiled: CompiledChallenge, s: SessionState): number {
  // While paused the challenge clock is stopped, so nothing can be "late" (incl. SessionResumed).
  if (s.startMono === null || s.pauseStartMono !== null) return Number.POSITIVE_INFINITY;
  return s.startMono + compiled.durationMs + s.pausedMs;
}

/** Checkpoints currently eligible to be reached (ordered routes: only the next one). */
export function eligibleCheckpoints(compiled: CompiledChallenge, s: SessionState): string[] {
  const unreached = [...compiled.checkpoints.keys()].filter((id) => !s.checkpoints[id]!.reached);
  if (compiled.definition.route.type !== 'ordered') return unreached;
  const next = compiled.routeOrder.find((id) => !s.checkpoints[id]!.reached);
  const offRoute = unreached.filter((id) => !compiled.routeOrder.includes(id));
  return next ? [next, ...offRoute] : offRoute;
}

function markReached(compiled: CompiledChallenge, s: SessionState, cpId: string, mono: number, manual: boolean) {
  const cp = s.checkpoints[cpId]!;
  cp.reached = true;
  cp.reachedAtMono = mono;
  cp.manual = manual;
  for (const [taskId, t] of compiled.tasks) {
    const ts = s.tasks[taskId]!;
    if (t.location.kind === 'checkpoint' && t.location.ref === cpId && ts.status === 'locked') {
      ts.status = 'available';
      ts.availableAtMono = mono;
    }
  }
}

function processSample(compiled: CompiledChallenge, s: SessionState, raw: LocationSample) {
  s.samplesTotal++;
  if (raw.mocked) {
    s.samplesRejected.mocked++;
    return;
  }
  if (raw.acc > MAX_SAMPLE_ACCURACY_M) {
    s.samplesRejected.accuracy++;
    return;
  }
  const sample: AcceptedSample = { lng: raw.lng, lat: raw.lat, acc: raw.acc, monoMs: raw.monoMs };
  const p: LngLat = [raw.lng, raw.lat];
  const last = s.lastSample;
  if (last) {
    if (sample.monoMs <= last.monoMs) return; // duplicate / out of order
    const dt = (sample.monoMs - last.monoMs) / 1000;
    const d = haversineM([last.lng, last.lat], p);
    if (d / dt > compiled.maxSpeedMps && d > sample.acc + last.acc) {
      s.samplesRejected.jump++;
      return;
    }
  }
  s.lastSample = sample;
  s.lastMono = Math.max(s.lastMono, sample.monoMs);

  const lastTrack = s.track[s.track.length - 1];
  if (!lastTrack || haversineM([lastTrack.lng, lastTrack.lat], p) >= TRACK_MIN_STEP_M) s.track.push(sample);

  // Distance: anchor-based to suppress GPS jitter while standing still. Paused time never counts.
  if (!s.anchor || s.status === 'paused') s.anchor = sample;
  else if (sample.acc <= DISTANCE_SAMPLE_ACCURACY_M) {
    const a = s.anchor;
    const d = haversineM([a.lng, a.lat], p);
    if (d >= Math.max(5, Math.min(sample.acc, 25))) {
      const dtMs = sample.monoMs - a.monoMs;
      s.distanceM += d;
      if (dtMs > 0 && dtMs <= 120_000 && d / (dtMs / 1000) >= 0.3) s.movingMs += dtMs;
      s.anchor = sample;
    }
  }

  if (s.status !== 'active') return;

  trackZone(compiled, s, p, sample);

  // Checkpoints
  for (const id of eligibleCheckpoints(compiled, s)) {
    const def = compiled.checkpoints.get(id)!;
    const cs = s.checkpoints[id]!;
    if (sample.acc > def.maxAccuracyM) continue; // poor fix: neither counts nor resets dwell
    if (inCircle(p, sample.acc, def.geometry, def.maxAccuracyM)) {
      if (cs.insideSinceMono === null) {
        cs.insideSinceMono = sample.monoMs;
        cs.qualifyingFixes = 1;
      } else cs.qualifyingFixes++;
      const dwellOk = sample.monoMs - cs.insideSinceMono >= def.dwellSec * 1000;
      const fixesOk = def.dwellSec === 0 ? cs.qualifyingFixes >= 1 : cs.qualifyingFixes >= 2;
      if (dwellOk && fixesOk) markReached(compiled, s, id, sample.monoMs, false);
    } else {
      cs.insideSinceMono = null;
      cs.qualifyingFixes = 0;
    }
  }

  // Boundary (hysteresis: must stay outside 30 s to count an exit)
  const boundary = compiled.definition.area.boundary;
  if (boundary && sample.acc <= DISTANCE_SAMPLE_ACCURACY_M) {
    const outside = distanceOutsideZoneM(p, boundary) > boundary.graceM + Math.min(sample.acc, 25);
    const b = s.boundary;
    if (outside) {
      if (b.inside) {
        b.inside = false;
        b.outsideSinceMono = sample.monoMs;
        b.exitCounted = false;
      } else if (!b.exitCounted && b.outsideSinceMono !== null && sample.monoMs - b.outsideSinceMono >= BOUNDARY_EXIT_CONFIRM_MS) {
        b.exits++;
        b.exitCounted = true;
      }
    } else {
      b.inside = true;
      b.outsideSinceMono = null;
    }
  }

  const end = compiled.definition.area.endZone;
  if (end) s.inEndZone = inCircle(p, sample.acc, end, DISTANCE_SAMPLE_ACCURACY_M);
}

function effectiveFix(s: SessionState, fix: { lat: number; lng: number; acc: number } | null, mono: number) {
  if (fix) return fix;
  const l = s.lastSample;
  if (l && mono - l.monoMs <= 60_000) return { lat: l.lat, lng: l.lng, acc: l.acc };
  return null;
}

function validEvidenceCount(s: SessionState, taskId: string, opts: EvaluateOptions): number {
  return s.tasks[taskId]!.evidenceIds.filter((id) => {
    const ev = s.evidence[id];
    return ev && !ev.invalidReason && !opts.invalidEvidence?.[id];
  }).length;
}

/**
 * Applies one event to a MUTABLE state. Callers that need immutability should use `reduce`.
 * Pure with respect to inputs: no clock, no randomness, no I/O.
 */
export function applyEvent(compiled: CompiledChallenge, s: SessionState, e: ActivityEvent, opts: EvaluateOptions = {}): void {
  const late =
    s.startMono !== null &&
    e.monoMs > deadlineMono(compiled, s) &&
    e.type !== 'SessionCompleted' &&
    e.type !== 'SessionAbandoned' &&
    e.type !== 'LocationBatch' &&
    // End-of-play bookkeeping is never "late": confirmations happen at the end of a match.
    e.type !== 'ConfirmationReceived' &&
    e.type !== 'ConfirmationIssued' &&
    e.type !== 'QuestStopped' &&
    e.type !== 'ConnectivityChanged';
  if (late) {
    s.lateEvents++;
    return;
  }
  if (e.type !== 'LocationBatch') s.lastMono = Math.max(s.lastMono, e.monoMs);

  switch (e.type) {
    case 'SessionStarted': {
      if (s.status !== 'not_started') return;
      s.status = 'active';
      s.sessionId = e.sessionId;
      s.startMono = e.monoMs;
      s.startClientTs = e.clientTs;
      s.tzOffsetMin = e.payload.tzOffsetMin ?? null;
      s.quest = e.payload.quest ?? null;
      const f = e.payload.startFix;
      processSample(compiled, s, {
        ts: f.ts, monoMs: e.monoMs, lat: f.lat, lng: f.lng, acc: f.acc,
        speed: null, heading: null, alt: null, mocked: f.mocked ?? false,
      });
      return;
    }
    case 'LocationBatch': {
      if (s.status !== 'active' && s.status !== 'paused') return;
      const deadline = deadlineMono(compiled, s);
      for (const sample of e.payload.samples) {
        if (sample.monoMs > deadline) {
          s.lateEvents++;
          continue;
        }
        processSample(compiled, s, sample);
      }
      return;
    }
    case 'GpsSignalLost':
      s.gpsLost++;
      return;
    case 'CheckpointManualConfirm': {
      if (s.status !== 'active') return;
      const id = e.payload.checkpointId;
      const def = compiled.checkpoints.get(id);
      if (!def || !eligibleCheckpoints(compiled, s).includes(id)) return;
      const f = e.payload.fix ?? s.lastSample;
      const mono = e.payload.fix ? e.monoMs : (s.lastSample?.monoMs ?? -Infinity);
      if (!f || e.monoMs - mono > MANUAL_CONFIRM_MAX_AGE_MS || f.acc > MAX_SAMPLE_ACCURACY_M) return;
      if (haversineM([f.lng, f.lat], def.geometry.center) <= def.geometry.radiusM + MANUAL_CONFIRM_EXTRA_M) {
        markReached(compiled, s, id, e.monoMs, true);
      }
      return;
    }
    case 'TaskStarted': {
      const t = s.tasks[e.payload.taskId];
      if (t && t.status === 'available') {
        t.status = 'started';
        t.startedAtMono = e.monoMs;
      }
      return;
    }
    case 'EvidenceCaptured': {
      const p = e.payload;
      const task = s.tasks[p.taskId];
      const def = compiled.tasks.get(p.taskId);
      let invalidReason: string | null = null;
      const fix = effectiveFix(s, p.fix, e.monoMs);
      if (!task || !def) invalidReason = 'unknown_task';
      else if (task.status === 'locked') invalidReason = 'task_locked';
      else if (!fix) invalidReason = 'no_location';
      else if (def.location.kind === 'checkpoint' && def.location.ref) {
        const cp = compiled.checkpoints.get(def.location.ref)!;
        const allowance = (compiled.modules.flatMap((m) => m.taskTypes).find((tt) => def.type.endsWith(`.${tt.id}`))?.evidenceRadiusM ?? 50);
        if (haversineM([fix.lng, fix.lat], cp.geometry.center) > cp.geometry.radiusM + allowance + Math.min(fix.acc, 50)) {
          invalidReason = 'off_location';
        }
      } else if (def.location.kind === 'in_boundary' && compiled.definition.area.boundary) {
        const b = compiled.definition.area.boundary;
        if (distanceOutsideZoneM([fix.lng, fix.lat], b) > b.graceM + Math.min(fix.acc, 50)) invalidReason = 'off_location';
      }
      s.evidence[p.evidenceId] = {
        evidenceId: p.evidenceId,
        taskId: p.taskId,
        checkpointId: p.checkpointId,
        sha256: p.sha256,
        monoMs: e.monoMs,
        fix: fix ? { lat: fix.lat, lng: fix.lng, acc: fix.acc } : null,
        invalidReason,
      };
      if (task && !task.evidenceIds.includes(p.evidenceId)) task.evidenceIds.push(p.evidenceId);
      return;
    }
    case 'TaskCompleted': {
      const t = s.tasks[e.payload.taskId];
      const def = compiled.tasks.get(e.payload.taskId);
      if (!t || !def || (t.status !== 'available' && t.status !== 'started')) return;
      // Confirmation tasks can only be completed by a signed confirmation (ADR-026).
      if (taskTypeOf(compiled, e.payload.taskId)?.completion === 'confirmation') {
        t.rejectedCompletions++;
        return;
      }
      const required = def.evidence.reduce((n, r) => n + r.count, 0);
      if (validEvidenceCount(s, e.payload.taskId, opts) < required) {
        t.rejectedCompletions++;
        return;
      }
      t.status = 'done';
      t.doneVia = required > 0 ? 'evidence' : 'self_report';
      t.completedAtMono = e.monoMs;
      const q = e.payload.quantity ?? (typeof def.params.quantity === 'number' ? def.params.quantity : null);
      t.quantity = q;
      return;
    }
    case 'TaskUndone': {
      const t = s.tasks[e.payload.taskId];
      if (t && t.status === 'done') {
        t.status = t.startedAtMono !== null ? 'started' : 'available';
        t.completedAtMono = null;
        t.quantity = null;
      }
      return;
    }
    case 'OrganizerConfirmation': {
      // Deprecated (ADR-026): written by the participant themselves, so it only ever counts as self-report.
      const t = s.tasks[e.payload.taskId];
      if (t && t.status !== 'done') {
        t.status = 'done';
        t.completedAtMono = e.monoMs;
        t.doneVia = 'legacy_organizer';
      }
      return;
    }
    case 'CountReported': {
      if (s.status !== 'active' && s.status !== 'paused') return;
      const id = e.payload.counterId;
      if (!compiled.knownFacts.has(id)) return; // not a counter of this challenge's modules
      s.counters[id] = Math.max(0, (s.counters[id] ?? 0) + e.payload.delta);
      return;
    }
    case 'ConfirmationIssued':
      return; // confirmer side: evidence for the server; it changes nothing in the confirmer's own score
    case 'ConfirmationReceived': {
      const p = e.payload;
      if (s.confirmationIds.includes(p.confirmationId)) return;
      const c = opts.confirmations;
      const claims = c?.mode === 'final' ? c.matched[p.confirmationId] : p.claims;
      if (!claims) return; // server: unmatched confirmations never count
      s.confirmationIds.push(p.confirmationId);
      for (const claim of claims) {
        if (claim.kind === 'counter') {
          if (!compiled.knownFacts.has(`${claim.ref}.confirmed`)) continue;
          s.confirmed[claim.ref] = (s.confirmed[claim.ref] ?? 0) + claim.value;
        } else {
          const t = s.tasks[claim.ref];
          if (t && t.status !== 'done' && t.status !== 'locked') {
            t.status = 'done';
            t.completedAtMono = e.monoMs;
            t.doneVia = 'confirmation';
          }
        }
      }
      return;
    }
    case 'ConnectivityChanged': {
      if (!e.payload.online) {
        if (s.offlineSinceMono === null) s.offlineSinceMono = e.monoMs;
      } else if (s.offlineSinceMono !== null) {
        if (e.monoMs > s.offlineSinceMono) s.offlineIntervals.push([s.offlineSinceMono, e.monoMs]);
        s.offlineSinceMono = null;
      }
      s.online = e.payload.online;
      return;
    }
    case 'QuestStopped':
      s.questStop = e.payload.kind;
      return;
    case 'SessionPaused':
      if (s.status === 'active') {
        s.status = 'paused';
        s.pauseStartMono = e.monoMs;
      }
      return;
    case 'SessionResumed':
      if (s.status === 'paused' && s.pauseStartMono !== null) {
        s.pausedMs += e.monoMs - s.pauseStartMono;
        s.pauseStartMono = null;
        s.status = 'active';
      }
      return;
    case 'AppBackgrounded':
      if (s.backgroundSinceMono === null) s.backgroundSinceMono = e.monoMs;
      return;
    case 'AppForegrounded':
      if (s.backgroundSinceMono !== null) {
        s.backgroundMs += Math.max(0, e.monoMs - s.backgroundSinceMono);
        s.backgroundSinceMono = null;
      }
      return;
    case 'StepsSample':
      s.steps = (s.steps ?? 0) + e.payload.delta;
      return;
    case 'SessionCompleted':
    case 'SessionAbandoned': {
      if (s.status !== 'active' && s.status !== 'paused') return;
      const end = Math.min(e.monoMs, deadlineMono(compiled, s));
      if (s.pauseStartMono !== null) {
        s.pausedMs += Math.max(0, end - s.pauseStartMono);
        s.pauseStartMono = null;
      }
      if (s.backgroundSinceMono !== null) {
        s.backgroundMs += Math.max(0, end - s.backgroundSinceMono);
        s.backgroundSinceMono = null;
      }
      if (s.offlineSinceMono !== null) {
        if (end > s.offlineSinceMono) s.offlineIntervals.push([s.offlineSinceMono, end]);
        s.offlineSinceMono = null;
      }
      s.endMono = end;
      s.status = e.type === 'SessionCompleted' ? 'completed' : 'abandoned';
      s.completionReason = e.type === 'SessionCompleted' ? e.payload.reason : 'abandoned';
      return;
    }
    default:
      return; // hint-only events: CheckpointEntered, Boundary*, MockLocationDetected, ClockAnomalyDetected, GpsSignalRestored
  }
}

/** Folds events (sorted by seq) into a fresh state. */
export function fold(compiled: CompiledChallenge, events: ActivityEvent[], opts: EvaluateOptions = {}): SessionState {
  const s = initialState(compiled);
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  for (const e of sorted) applyEvent(compiled, s, e, opts);
  return s;
}

/** Immutable single-step reducer. */
export function reduce(compiled: CompiledChallenge, state: SessionState, e: ActivityEvent, opts: EvaluateOptions = {}): SessionState {
  const next = cloneState(state);
  applyEvent(compiled, next, e, opts);
  return next;
}

export function cloneState(s: SessionState): SessionState {
  return JSON.parse(JSON.stringify(s)) as SessionState;
}

/** Applies not-yet-persisted live samples (device buffer) on top of a state copy, for live UI. */
export function withLiveSamples(compiled: CompiledChallenge, state: SessionState, samples: LocationSample[]): SessionState {
  const next = cloneState(state);
  if (next.status !== 'active' && next.status !== 'paused') return next;
  for (const sample of samples) processSample(compiled, next, sample);
  return next;
}
