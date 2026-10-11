import { z } from 'zod';
import { defineModule, taskType } from './define';

export const walking = defineModule({
  id: 'walking',
  version: 1,
  displayName: 'Walking',
  icon: '🚶',
  kind: 'activity',
  paramsSchema: z
    .object({ targetDistanceM: z.int().min(200).max(50_000).optional() })
    .loose() as unknown as z.ZodType<Record<string, unknown>>,
  taskTypes: [
    // Optional photo proof for Daily Quests: "something you noticed outside" (design §3.7).
    taskType({
      id: 'photo_proof',
      displayName: 'Photo of something you noticed',
      completion: 'evidence',
      defaultEvidence: [{ kind: 'photo', count: 1, hint: 'Something beautiful you noticed outside' }],
      defaultPoints: 10,
      minTaskSeconds: 0,
      evidenceRadiusM: 100,
    }),
  ],
  plausibility: { maxSpeedMps: 4 },
  typicalSpeedMps: 1.2,
  metBySpeed: [
    { upToMps: 0.9, met: 2.5 },
    { upToMps: 1.2, met: 3.0 },
    { upToMps: 1.5, met: 3.5 },
    { upToMps: 1.8, met: 4.3 },
    { upToMps: 99, met: 5.0 },
  ],
  restMet: 1.5,
  difficulty: (params, level) => ({ ...params, targetDistanceM: { easy: 1500, medium: 3000, hard: 5000 }[level] }),
  aiHints: {
    description: 'Walk a route or reach checkpoints on foot.',
    examples: ['an evening walk around the lake', 'a 30 minute walk with my mom', 'heritage walk'],
  },
});
