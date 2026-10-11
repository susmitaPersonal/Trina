import { sha256Hex, type ChallengeDefinitionInput, type LngLat } from '@trina/contracts';
import { round6 } from './geo';
import { DAILY_QUEST_POOL } from './modules/descriptors';

/**
 * Offline Daily Quests (design §5A). A quest is an ordinary session, so it needs a definition; the
 * phone builds it OFFLINE from a built-in template + the player's own start fix, and the server
 * rebuilds the exact same definition (and hash) from SessionStarted.payload.quest. No AI, no server
 * round trip, nothing chosen by anyone but code and the player.
 */
export const DAILY_QUEST_CHALLENGE_ID = '0192d41e-0000-7000-8000-000000000001';
export const QUEST_TEMPLATE_IDS = ['outside_v1'] as const;
export type QuestTemplateId = (typeof QUEST_TEMPLATE_IDS)[number];
export type QuestSpec = { templateId: string; targetMinutes: 30 | 45 | 60 | 90; levelTier: 'easy' | 'medium' | 'hard' };
/** Extra minutes on the clock so finishing exactly on target never times out. */
export const QUEST_GRACE_MIN = 15;

export function buildQuestDefinition(spec: QuestSpec, start: LngLat): ChallengeDefinitionInput {
  if (!(QUEST_TEMPLATE_IDS as readonly string[]).includes(spec.templateId)) throw new Error(`Unknown quest template "${spec.templateId}"`);
  const center: LngLat = [round6(start[0]), round6(start[1])];
  return {
    schemaVersion: '1.1',
    meta: {
      title: `Daily Quest · ${spec.targetMinutes} min offline`,
      description: 'Internet off, phone in pocket, go outside. Your time outside counts when you finish.',
      tags: ['quest'],
      difficulty: spec.levelTier,
      visibility: 'private',
      language: 'en',
    },
    modules: [{ id: 'walking', version: 1, params: {} }],
    mode: 'individual',
    participants: { min: 1, max: 1 },
    timing: { durationMin: spec.targetMinutes + QUEST_GRACE_MIN, startGraceMin: 0, daylightOnly: false },
    area: {
      startZone: { type: 'circle', center, radiusM: 75 },
      // A wide play area: any accepted GPS fix within 5 km counts as time outside.
      boundary: { type: 'circle', center, radiusM: 5000, graceM: 500 },
    },
    route: { type: 'free', checkpointIds: [] },
    checkpoints: [],
    tasks: [
      {
        id: 'photo',
        type: 'walking.photo_proof',
        title: 'Photo proof (optional)',
        params: {},
        location: { kind: 'anywhere' },
        evidence: [{ kind: 'photo', count: 1, hint: 'Something beautiful you noticed outside' }],
        required: false,
        scope: 'individual',
      },
    ],
    scoring: {
      rules: [
        { id: 'photo', kind: 'per_task', task: 'photo', points: 10 },
        { id: 'outside', kind: 'metric_rate', metric: 'zone_dwell_s', pointsPer: 1, per: 60, cap: spec.targetMinutes },
      ],
      bonuses: [],
      penalties: [],
      teamAggregation: 'sum',
    },
    completion: { all: [{ fact: 'duration_s', op: '>=', value: spec.targetMinutes * 60 }], endZoneRequired: false },
    safety: { noSpeedRewards: true },
  };
}

/**
 * Picks today's Daily Quests deterministically: a per-player order of the pool (by hash), walked in
 * windows of `count` per day. With 7 quests and 3 per day, consecutive days never repeat a quest.
 */
export function pickDailyQuests(userId: string, dayKey: string, count = 3): string[] {
  const order = [...DAILY_QUEST_POOL].map((q) => ({ q: q as string, h: sha256Hex(`${userId}|${q}`) })).sort((a, b) => a.h.localeCompare(b.h)).map((x) => x.q);
  const n = Math.round((Date.parse(`${dayKey}T00:00:00Z`) - Date.parse('2026-01-01T00:00:00Z')) / 86_400_000);
  const len = order.length;
  return Array.from({ length: Math.min(count, len) }, (_, i) => order[(((n * count + i) % len) + len) % len]!);
}
