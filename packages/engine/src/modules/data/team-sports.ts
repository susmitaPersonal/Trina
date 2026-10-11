import type { ModuleDefinitionInput } from '@trina/contracts';

/**
 * Official DATA modules (ADR-023): shipped in the repo, reviewed by pull request, interpreted by the
 * engine exactly like runtime custom modules. Time at the ground is measured; runs, overs, catches
 * and goals can only count when another participant confirms them (signed, ADR-026).
 */
export const cricketDefinition: ModuleDefinitionInput = {
  schemaVersion: 'module/1.0',
  id: 'cricket',
  version: 1,
  origin: 'official',
  meta: {
    displayName: 'Cricket',
    description: 'Play a match at a local ground. Time at the ground is measured; balls, overs and catches are confirmed by your party leader or a teammate.',
    icon: 'cricket',
    tags: ['team_sport', 'ball'],
  },
  movement: 'mixed_play',
  venue: 'open_ground',
  team: { min: 2, max: 22 },
  params: [
    { key: 'overs', kind: 'int', min: 2, max: 50, default: 10, unit: 'overs' },
    { key: 'targetMinutes', kind: 'int', min: 20, max: 240, default: 60, unit: 'minutes' },
  ],
  counters: [
    { id: 'balls_faced', label: 'Balls faced', unit: 'count', verification: 'organizer', maxPerMinute: 3, maxPerSession: 300 },
    { id: 'overs_bowled', label: 'Overs bowled', unit: 'overs', verification: 'organizer', maxPerMinute: 0.5, maxPerSession: 10 },
    { id: 'catches', label: 'Catches taken', unit: 'count', verification: 'peer', maxPerMinute: 1, maxPerSession: 10 },
    { id: 'boundaries', label: 'Fours and sixes', unit: 'count', verification: 'organizer', maxPerMinute: 2, maxPerSession: 60 },
  ],
  taskTypes: [
    { id: 'team_photo', displayName: 'Team photo at the ground', completion: 'evidence', evidence: [{ kind: 'photo', count: 1, hint: 'Everyone at the ground (faces optional)' }], minTaskSeconds: 0, evidenceRadiusM: 150, weight: 1 },
    { id: 'scored_match', displayName: 'Kept the score', completion: 'confirmation', minTaskSeconds: 600, evidenceRadiusM: 150, weight: 2 },
  ],
  scoring: {
    counterRules: [
      { counter: 'overs_bowled', weight: 2, capPerSession: 4 },
      { counter: 'catches', weight: 3, capPerSession: 3 },
    ],
    dwellWeight: 3,
    distanceWeight: 0,
  },
  difficulty: [{ param: 'targetMinutes', easy: 30, medium: 60, hard: 90 }],
  safety: { checklist: ['water_bottle', 'sun_protection'], daylightOnly: true, notes: ['hard_ball_needs_guard'] },
  milestones: [
    { id: 'at_the_ground', title: 'At the ground', window: 'session', measure: { agg: 'sum', fact: 'zone_dwell_s' }, tiers: [{ tier: 'bronze', gte: 1800 }, { tier: 'silver', gte: 2700 }, { tier: 'gold', gte: 5400 }], stat: 'STR' },
    { id: 'faced_balls', title: 'Faced balls', window: 'day', measure: { agg: 'sum', fact: 'cricket.balls_faced.confirmed' }, tiers: [{ tier: 'bronze', gte: 10 }, { tier: 'silver', gte: 30 }, { tier: 'gold', gte: 60 }], stat: 'STR' },
    { id: 'bowled_overs', title: 'Bowled overs', window: 'day', measure: { agg: 'sum', fact: 'cricket.overs_bowled.confirmed' }, tiers: [{ tier: 'bronze', gte: 1 }, { tier: 'silver', gte: 2 }, { tier: 'gold', gte: 4 }], stat: 'AGI' },
    { id: 'took_catch', title: 'Took a catch', window: 'day', measure: { agg: 'sum', fact: 'cricket.catches.confirmed' }, tiers: [{ tier: 'unlock', gte: 1 }], stat: 'AGI' },
    { id: 'full_side', title: 'Full side', window: 'session', measure: { agg: 'max', fact: 'copresence.max_players' }, tiers: [{ tier: 'unlock', gte: 6 }], scope: 'team', stat: 'AURA' },
    {
      id: 'early_match',
      title: 'Morning match',
      window: 'day',
      measure: { agg: 'sessions' },
      where: { all: [{ fact: 'start_local_minute', op: '<', value: 540 }, { fact: 'zone_dwell_s', op: '>=', value: 1800 }] },
      tiers: [{ tier: 'unlock', gte: 1 }],
      stat: 'VIT',
    },
    { id: 'weekly_regular', title: 'Weekly regular', window: 'week', measure: { agg: 'days', fact: 'zone_dwell_s', perDayGte: 1800 }, tiers: [{ tier: 'bronze', gte: 2 }, { tier: 'silver', gte: 3 }, { tier: 'gold', gte: 4 }], stat: 'STR' },
  ],
  aiHints: {
    description: 'Cricket match at a ground. Time at the ground is measured; balls, overs and catches are confirmed.',
    examples: ['gully cricket with friends', 'Sunday tennis-ball match', '10 over game at the maidan'],
  },
};

export const footballDefinition: ModuleDefinitionInput = {
  schemaVersion: 'module/1.0',
  id: 'football',
  version: 1,
  origin: 'official',
  meta: { displayName: 'Football', description: 'Play at a pitch. Time and steps are measured; goals and assists are confirmed.', icon: 'football', tags: ['team_sport', 'ball'] },
  movement: 'mixed_play',
  venue: 'open_ground',
  team: { min: 2, max: 22 },
  params: [{ key: 'targetMinutes', kind: 'int', min: 20, max: 180, default: 60, unit: 'minutes' }],
  counters: [
    { id: 'goals', label: 'Goals', unit: 'count', verification: 'organizer', maxPerMinute: 0.5, maxPerSession: 20 },
    { id: 'assists', label: 'Assists', unit: 'count', verification: 'peer', maxPerMinute: 0.5, maxPerSession: 20 },
  ],
  taskTypes: [
    { id: 'refereed', displayName: 'Refereed a match', completion: 'confirmation', minTaskSeconds: 1200, evidenceRadiusM: 150, weight: 2 },
    { id: 'clean_sheet', displayName: 'Clean sheet (goalkeeper)', completion: 'confirmation', minTaskSeconds: 1200, evidenceRadiusM: 150, weight: 2 },
  ],
  scoring: { counterRules: [{ counter: 'goals', weight: 2, capPerSession: 3 }, { counter: 'assists', weight: 2, capPerSession: 3 }], dwellWeight: 3, distanceWeight: 0 },
  difficulty: [{ param: 'targetMinutes', easy: 30, medium: 60, hard: 90 }],
  safety: { checklist: ['water_bottle'], daylightOnly: true, notes: [] },
  milestones: [
    { id: 'on_the_pitch', title: 'On the pitch', window: 'session', measure: { agg: 'sum', fact: 'zone_dwell_s' }, tiers: [{ tier: 'bronze', gte: 1800 }, { tier: 'silver', gte: 2700 }, { tier: 'gold', gte: 5400 }], stat: 'STR' },
    { id: 'match_steps', title: 'Match steps', window: 'session', measure: { agg: 'sum', fact: 'steps' }, tiers: [{ tier: 'bronze', gte: 2000 }, { tier: 'silver', gte: 3000 }, { tier: 'gold', gte: 5000 }], stat: 'VIT' },
    { id: 'scored', title: 'Scored a goal', window: 'day', measure: { agg: 'sum', fact: 'football.goals.confirmed' }, tiers: [{ tier: 'bronze', gte: 1 }, { tier: 'silver', gte: 2 }, { tier: 'gold', gte: 3 }], stat: 'STR' },
    { id: 'assist', title: 'Assist', window: 'day', measure: { agg: 'sum', fact: 'football.assists.confirmed' }, tiers: [{ tier: 'unlock', gte: 1 }], stat: 'AGI' },
    { id: 'ref', title: 'Referee', window: 'lifetime', measure: { agg: 'sum', fact: 'football.refereed.done_count' }, tiers: [{ tier: 'bronze', gte: 1 }, { tier: 'silver', gte: 5 }, { tier: 'gold', gte: 20 }], stat: 'AURA' },
    { id: 'full_eleven', title: 'Full eleven', window: 'session', measure: { agg: 'max', fact: 'copresence.max_players' }, tiers: [{ tier: 'unlock', gte: 10 }], scope: 'team', stat: 'AURA' },
  ],
  aiHints: { description: 'Football at a pitch: measured time and steps, confirmed goals.', examples: ['5-a-side after college', 'kick-about at the park'] },
};

export const OFFICIAL_DATA_DEFINITIONS: ModuleDefinitionInput[] = [cricketDefinition, footballDefinition];
