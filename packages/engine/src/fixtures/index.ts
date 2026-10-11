/**
 * Test/demo fixtures shared by engine, server and mobile tests.
 * Green Sprint 60 is the golden demo challenge (docs/delivery/mvp-scope.md).
 */
import {
  computeEventHash,
  genesisHash,
  uuidv7,
  type ActivityEvent,
  type ChallengeDefinitionInput,
  type EventType,
  type LngLat,
  type LocationSample,
  type PayloadOf,
} from '@trina/contracts';
import { bearingDeg, destinationPoint, haversineM } from '../geo';

/** Rabindra Sarobar lake, Kolkata: a public park (demo default). */
export const DEMO_CENTER: LngLat = [88.35, 22.5115];

export function greenSprintPoints(center: LngLat = DEMO_CENTER) {
  return {
    start: center,
    cp1: destinationPoint(center, 0, 350),
    cp2: destinationPoint(center, 90, 350),
    cp3: destinationPoint(center, 180, 350),
    cp4: destinationPoint(center, 270, 350),
  };
}

export function greenSprintDefinition(center: LngLat = DEMO_CENTER, opts: { ordered?: boolean } = {}): ChallengeDefinitionInput {
  const p = greenSprintPoints(center);
  const circle = (c: LngLat, r: number) => ({ type: 'circle' as const, center: c, radiusM: r });
  return {
    schemaVersion: '1.0',
    meta: {
      title: 'Green Sprint 60',
      description: 'Walk or cycle a loop, pick up litter, water two trees. Phone in pocket between checkpoints.',
      tags: ['green', 'demo'],
      difficulty: 'easy',
      visibility: 'public',
      language: 'en',
    },
    modules: [
      { id: 'walking', version: 1, params: {} },
      { id: 'cleanup', version: 1, params: {} },
      { id: 'tree_care', version: 1, params: {} },
    ],
    mode: 'individual',
    participants: { min: 1, max: 50 },
    timing: { durationMin: 60, startGraceMin: 10, daylightOnly: false },
    area: {
      startZone: circle(p.start, 75),
      boundary: { type: 'circle', center: p.start, radiusM: 700, graceM: 50 },
      endZone: circle(p.start, 75),
    },
    route: { type: opts.ordered === false ? 'unordered' : 'ordered', checkpointIds: ['cp1', 'cp2', 'cp3', 'cp4'] },
    checkpoints: [
      { id: 'cp1', name: 'Lake Gate', geometry: circle(p.cp1, 30), required: true, dwellSec: 5, maxAccuracyM: 40 },
      { id: 'cp2', name: 'Boat Club', geometry: circle(p.cp2, 30), required: true, dwellSec: 5, maxAccuracyM: 40 },
      { id: 'cp3', name: 'Old Banyan', geometry: circle(p.cp3, 30), required: true, dwellSec: 5, maxAccuracyM: 40 },
      { id: 'cp4', name: 'Neem Corner', geometry: circle(p.cp4, 30), required: true, dwellSec: 5, maxAccuracyM: 40 },
    ],
    tasks: [
      {
        id: 'litter',
        type: 'cleanup.collect_items',
        title: 'Collect 10 pieces of litter',
        params: { quantity: 10 },
        location: { kind: 'checkpoint', ref: 'cp2' },
        evidence: [{ kind: 'photo', count: 1, hint: 'Show the full bag of litter' }],
        required: true,
      },
      {
        id: 'tree1',
        type: 'tree_care.water_tree',
        title: 'Water the Old Banyan',
        location: { kind: 'checkpoint', ref: 'cp3' },
        evidence: [{ kind: 'photo', count: 1, hint: 'Show the tree and the water' }],
        required: true,
      },
      {
        id: 'tree2',
        type: 'tree_care.water_tree',
        title: 'Water the Neem tree',
        location: { kind: 'checkpoint', ref: 'cp4' },
        evidence: [{ kind: 'photo', count: 1, hint: 'Show the tree and the water' }],
        required: true,
      },
    ],
    scoring: {
      rules: [
        { id: 'cp', kind: 'per_checkpoint', points: 25 },
        { id: 'litter', kind: 'per_task', task: 'litter', points: 50 },
        { id: 'tree1', kind: 'per_task', task: 'tree1', points: 30 },
        { id: 'tree2', kind: 'per_task', task: 'tree2', points: 30 },
        { id: 'dist', kind: 'metric_rate', metric: 'distance_m', pointsPer: 1, per: 100, cap: 50 },
      ],
      bonuses: [
        {
          id: 'finish',
          kind: 'condition',
          label: 'Completed within 60 minutes',
          when: { fact: 'completed', op: '==', value: true },
          points: 50,
        },
      ],
      penalties: [
        { id: 'exits', kind: 'per_occurrence', label: 'Left the play area', fact: 'boundary_exits', points: -10, graceCount: 1 },
      ],
      teamAggregation: 'sum',
    },
    completion: {
      all: [
        { fact: 'checkpoints.required_reached', op: '==', value: 'ALL' },
        { fact: 'tasks.required_done', op: '==', value: 'ALL' },
      ],
      endZoneRequired: true,
    },
    safety: { noSpeedRewards: true },
  };
}

type SampleOpts = { acc?: number; mocked?: boolean };

/**
 * Builds a realistic, sealed (seq + hash chain) event log by "walking" between points.
 * Location samples are batched into LocationBatch events like the real device does.
 */
export class SessionBuilder {
  readonly sessionId: string;
  private events: ActivityEvent[] = [];
  private seq = 0;
  private prevHash: string;
  private mono = 0;
  private pos: LngLat;
  private buffer: LocationSample[] = [];
  private stepsCumulative = 0;

  constructor(
    private readonly opts: {
      challengeId: string;
      challengeVersion?: number;
      definitionHash: string;
      userId: string;
      deviceId: string;
      start: LngLat;
      startTs?: string;
      teamId?: string | null;
      sessionId?: string;
      batchSize?: number;
    },
  ) {
    this.sessionId = opts.sessionId ?? uuidv7();
    this.prevHash = genesisHash(this.sessionId);
    this.pos = opts.start;
  }

  private ts(mono = this.mono): string {
    const base = Date.parse(this.opts.startTs ?? '2026-10-20T07:00:00.000Z');
    return new Date(base + mono).toISOString();
  }

  private fix(acc = 8) {
    return { lat: this.pos[1], lng: this.pos[0], acc, ts: this.ts() };
  }

  emit<T extends EventType>(type: T, payload: PayloadOf<T>): this {
    if (type !== 'LocationBatch') this.flush();
    this.push(type, payload);
    return this;
  }

  private push<T extends EventType>(type: T, payload: PayloadOf<T>) {
    this.seq++;
    const base = {
      eventId: uuidv7(),
      sessionId: this.sessionId,
      seq: this.seq,
      type,
      schemaVersion: 1,
      clientTs: this.ts(),
      monoMs: this.mono,
      payload,
      prevHash: this.prevHash,
    };
    const hash = computeEventHash(base);
    this.prevHash = hash;
    this.events.push({ ...base, hash } as ActivityEvent);
  }

  private flush() {
    if (this.buffer.length) {
      const samples = this.buffer;
      this.buffer = [];
      this.push('LocationBatch', { samples });
    }
  }

  private sample(o: SampleOpts = {}) {
    this.buffer.push({
      ts: this.ts(),
      monoMs: this.mono,
      lat: this.pos[1],
      lng: this.pos[0],
      acc: o.acc ?? 8,
      speed: null,
      heading: null,
      alt: null,
      mocked: o.mocked ?? false,
    });
    if (this.buffer.length >= (this.opts.batchSize ?? 30)) this.flush();
  }

  start(): this {
    return this.emit('SessionStarted', {
      challengeId: this.opts.challengeId,
      challengeVersion: this.opts.challengeVersion ?? 1,
      definitionHash: this.opts.definitionHash,
      deviceId: this.opts.deviceId,
      userId: this.opts.userId,
      teamId: this.opts.teamId ?? null,
      bootId: 'boot-1',
      clockOffsetMsAtDownload: 0,
      startFix: this.fix(),
    });
  }

  /** Move to `to` at `speedMps`, sampling every `intervalS` seconds. Adds ~1.3 steps/m when walking. */
  moveTo(to: LngLat, speedMps = 1.4, intervalS = 5, o: SampleOpts & { stepsPerM?: number } = {}): this {
    const total = haversineM(this.pos, to);
    const bearing = bearingDeg(this.pos, to);
    const from = this.pos;
    const stepM = speedMps * intervalS;
    let travelled = 0;
    while (travelled + stepM < total) {
      travelled += stepM;
      this.mono += intervalS * 1000;
      this.pos = destinationPoint(from, bearing, travelled);
      this.sample(o);
    }
    const lastDt = Math.max(1, Math.round(((total - travelled) / speedMps) * 1000));
    this.mono += lastDt;
    this.pos = to;
    this.sample(o);
    const steps = Math.round(total * (o.stepsPerM ?? 1.3));
    if (steps > 0) {
      this.stepsCumulative += steps;
      this.emit('StepsSample', { cumulative: this.stepsCumulative, delta: steps, source: 'simulated' });
    }
    return this;
  }

  /** Stay in place for `seconds`, sampling every `intervalS`. */
  wait(seconds: number, intervalS = 5, o: SampleOpts = {}): this {
    const n = Math.floor(seconds / intervalS);
    for (let i = 0; i < n; i++) {
      this.mono += intervalS * 1000;
      this.sample(o);
    }
    return this;
  }

  /** Jump instantly (teleport) to `to`. */
  teleport(to: LngLat, o: SampleOpts = {}): this {
    this.mono += 1000;
    this.pos = to;
    this.sample(o);
    return this;
  }

  advance(ms: number): this {
    this.mono += ms;
    return this;
  }

  evidence(taskId: string, sha256: string, evidenceId: string = uuidv7(), checkpointId: string | null = null): this {
    return this.emit('EvidenceCaptured', {
      evidenceId,
      taskId,
      checkpointId,
      sha256,
      bytes: 420_000,
      mime: 'image/jpeg',
      fix: this.fix(),
    });
  }

  completeTask(taskId: string, quantity?: number): this {
    return this.emit('TaskCompleted', quantity === undefined ? { taskId } : { taskId, quantity });
  }

  background(ms: number): this {
    this.emit('AppBackgrounded', {});
    this.mono += ms;
    return this.emit('AppForegrounded', {});
  }

  complete(provisionalScore = 0, wellness?: { moodBefore?: number | null; moodAfter?: number | null }): this {
    return this.emit('SessionCompleted', { reason: 'rules', provisionalScore, ...(wellness ? { wellness } : {}) });
  }

  build(): ActivityEvent[] {
    this.flush();
    return [...this.events];
  }

  get now() {
    return this.mono;
  }
}

/** Deterministic fake SHA-256 hex for tests. */
export function fakeSha(n: number): string {
  return n.toString(16).padStart(64, 'a').slice(-64);
}

/**
 * A complete, honest Green Sprint run (~2.5 km walk, all tasks, back to start in ~45 min).
 * Returns the events plus evidence ids so tests can upload/validate them.
 */
export function greenSprintCleanRun(args: {
  challengeId: string;
  definitionHash: string;
  userId: string;
  deviceId: string;
  center?: LngLat;
  sessionId?: string;
  startTs?: string;
}) {
  const p = greenSprintPoints(args.center);
  const ev = { litter: uuidv7(), tree1: uuidv7(), tree2: uuidv7() };
  const b = new SessionBuilder({ ...args, start: p.start });
  b.start()
    .moveTo(p.cp1)
    .wait(15)
    .moveTo(p.cp2)
    .wait(180)
    .evidence('litter', fakeSha(1), ev.litter, 'cp2')
    .completeTask('litter', 10)
    .moveTo(p.cp3)
    .wait(40)
    .evidence('tree1', fakeSha(2), ev.tree1, 'cp3')
    .completeTask('tree1')
    .moveTo(p.cp4)
    .wait(40)
    .evidence('tree2', fakeSha(3), ev.tree2, 'cp4')
    .completeTask('tree2')
    .background(10 * 60_000)
    .moveTo(p.start)
    .wait(10)
    .complete(0, { moodBefore: 3, moodAfter: 5 });
  return { events: b.build(), evidence: ev, sessionId: b.sessionId, shas: { litter: fakeSha(1), tree1: fakeSha(2), tree2: fakeSha(3) } };
}
