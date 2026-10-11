import type { Difficulty, Movement, Stat, Verification } from '@trina/contracts';

/**
 * Movement profiles (design §2.3): the ONLY source of speeds and METs for data modules.
 * There is deliberately no motorised profile. A module may only make plausibility stricter.
 */
export type MovementProfile = { maxSpeedMps: number; typicalSpeedMps: number; movingMet: number; restMet: number; stat: Stat };

export const MOVEMENT_PROFILES: Record<Movement, MovementProfile> = {
  on_foot: { maxSpeedMps: 4, typicalSpeedMps: 1.2, movingMet: 3.5, restMet: 1.5, stat: 'VIT' },
  human_powered_wheels: { maxSpeedMps: 12, typicalSpeedMps: 4.0, movingMet: 6.0, restMet: 1.5, stat: 'AGI' },
  stationary_play: { maxSpeedMps: 3, typicalSpeedMps: 0.3, movingMet: 2.5, restMet: 1.3, stat: 'SENSE' },
  mixed_play: { maxSpeedMps: 8, typicalSpeedMps: 1.5, movingMet: 6.0, restMet: 2.0, stat: 'STR' },
};

/** Max challenge points per minute for challenges using data modules, by level (owner decision, ADR-028). */
export const POINTS_PER_MINUTE_BUDGET: Record<Difficulty, number> = { easy: 8, medium: 12, hard: 15 };

/** Strength order of verification levels (index: lower = stronger). */
export const VERIFICATION_ORDER: Verification[] = ['sensor', 'photo', 'organizer', 'peer', 'self_report'];

export function weakest(levels: Verification[]): Verification {
  let worst = 0;
  for (const l of levels) worst = Math.max(worst, VERIFICATION_ORDER.indexOf(l));
  return VERIFICATION_ORDER[worst]!;
}

/** Facts every session produces, with their verification level (design §2.5). */
export const BASE_FACT_LEVELS: Record<string, Verification> = {
  duration_s: 'sensor',
  distance_m: 'sensor',
  moving_time_s: 'sensor',
  active_minutes: 'sensor',
  steps: 'sensor',
  zone_dwell_s: 'sensor',
  phone_free_minutes: 'sensor',
  start_local_minute: 'sensor',
  offline_s: 'sensor',
  photo_proofs: 'photo',
  'checkpoints.reached': 'sensor',
  completed: 'sensor',
};

/** Server-only facts (need other people's sessions). */
export const SERVER_ONLY_FACTS: Record<string, Verification> = { 'copresence.max_players': 'sensor' };

export function taskLevel(completion: 'evidence' | 'self_report' | 'confirmation'): Verification {
  return completion === 'evidence' ? 'photo' : completion === 'confirmation' ? 'peer' : 'self_report';
}
