import { z } from 'zod';
import { defineModule } from './define';

export const running = defineModule({
  id: 'running',
  version: 1,
  displayName: 'Running',
  icon: '🏃',
  kind: 'activity',
  paramsSchema: z
    .object({ targetDistanceM: z.int().min(500).max(50_000).optional() })
    .loose() as unknown as z.ZodType<Record<string, unknown>>,
  taskTypes: [],
  plausibility: { maxSpeedMps: 7 },
  typicalSpeedMps: 2.5,
  metBySpeed: [
    { upToMps: 1.8, met: 4.3 },
    { upToMps: 2.2, met: 7.0 },
    { upToMps: 2.7, met: 8.3 },
    { upToMps: 3.2, met: 9.8 },
    { upToMps: 99, met: 11.0 },
  ],
  restMet: 1.5,
  difficulty: (params, level) => ({ ...params, targetDistanceM: { easy: 2000, medium: 5000, hard: 10000 }[level] }),
  aiHints: {
    description: 'Run a route through checkpoints. Never rewards road speed.',
    examples: ['5k run in the park', 'morning jog with friends', 'sprint between landmarks'],
  },
});
