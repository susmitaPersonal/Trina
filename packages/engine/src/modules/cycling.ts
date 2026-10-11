import { z } from 'zod';
import { defineModule } from './define';

export const cycling = defineModule({
  id: 'cycling',
  version: 1,
  displayName: 'Cycling',
  icon: '🚲',
  kind: 'activity',
  paramsSchema: z
    .object({ targetDistanceM: z.int().min(1000).max(150_000).optional() })
    .loose() as unknown as z.ZodType<Record<string, unknown>>,
  taskTypes: [],
  plausibility: { maxSpeedMps: 15 },
  typicalSpeedMps: 4,
  metBySpeed: [
    { upToMps: 2.5, met: 3.5 },
    { upToMps: 4.4, met: 5.8 },
    { upToMps: 5.3, met: 6.8 },
    { upToMps: 6.2, met: 8.0 },
    { upToMps: 99, met: 10.0 },
  ],
  restMet: 1.5,
  difficulty: (params, level) => ({ ...params, targetDistanceM: { easy: 4000, medium: 8000, hard: 15000 }[level] }),
  aiHints: {
    description: 'Cycle a route through checkpoints. Safety first: no speed rewards.',
    examples: ['cycle around the neighbourhood', 'bike ride to the river and back'],
  },
});
