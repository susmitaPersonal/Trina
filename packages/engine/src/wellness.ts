import { elapsedMs } from './evaluate';
import { walking } from './modules';
import type { CompiledChallenge, SessionState, WellnessResult } from './types';

export const DEFAULT_WEIGHT_KG = 70;

export type WellnessInput = {
  /** Device-only. Never synced. */
  weightKg?: number | null;
  moodBefore?: number | null;
  moodAfter?: number | null;
  nowMono?: number;
};

/**
 * Wellness metrics: measured by sensors, calculated deterministically.
 * Informational only; never feeds scoring. Calories use the MET method (approximate).
 */
export function wellness(compiled: CompiledChallenge, s: SessionState, input: WellnessInput = {}): WellnessResult {
  const durationMs = elapsedMs(compiled, s, input.nowMono);
  const movingMs = Math.min(s.movingMs, durationMs);
  const restMs = Math.max(0, durationMs - movingMs);

  const endForBg = s.endMono ?? input.nowMono ?? s.lastMono;
  const bgMs = s.backgroundMs + (s.backgroundSinceMono !== null ? Math.max(0, endForBg - s.backgroundSinceMono) : 0);

  const primary = compiled.modules.find((m) => m.kind === 'activity') ?? walking;
  const avgSpeed = movingMs > 0 ? s.distanceM / (movingMs / 1000) : 0;
  const tiers = primary.metBySpeed ?? walking.metBySpeed!;
  const movingMet = (tiers.find((t) => avgSpeed <= t.upToMps) ?? tiers[tiers.length - 1]!).met;

  const anyTaskDone = Object.values(s.tasks).some((t) => t.status === 'done');
  const restMet = anyTaskDone
    ? Math.max(...compiled.modules.filter((m) => m.kind === 'task').map((m) => m.restMet ?? 1.5), primary.restMet ?? 1.5)
    : (primary.restMet ?? 1.5);

  const weightValid = typeof input.weightKg === 'number' && input.weightKg >= 25 && input.weightKg <= 300;
  const weight = weightValid ? (input.weightKg as number) : DEFAULT_WEIGHT_KG;
  const hours = (ms: number) => ms / 3_600_000;
  const kcal = durationMs > 0 ? Math.round(weight * (movingMet * hours(movingMs) + restMet * hours(restMs))) : null;

  const movingMin = movingMs / 60_000;
  const cadence = s.steps !== null && movingMin >= 1 ? Math.round(s.steps / movingMin) : null;
  const mood = (v: number | null | undefined) => (typeof v === 'number' && v >= 1 && v <= 5 ? Math.round(v) : null);

  return {
    steps: s.steps,
    avgCadenceSpm: cadence,
    activeMinutes: Math.floor(movingMs / 60_000),
    phoneFreeMinutes: Math.floor(Math.min(bgMs, durationMs) / 60_000),
    kcalEstimate: kcal,
    kcalApprox: !weightValid,
    moodBefore: mood(input.moodBefore),
    moodAfter: mood(input.moodAfter),
  };
}
