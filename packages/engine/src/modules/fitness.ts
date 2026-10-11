import { z } from 'zod';
import { defineModule, noParams, taskType } from './define';

export const fitness = defineModule({
  id: 'fitness',
  version: 1,
  displayName: 'Outdoor fitness',
  icon: '💪',
  kind: 'task',
  paramsSchema: noParams,
  taskTypes: [
    taskType({
      id: 'do_reps',
      displayName: 'Do a set of exercises',
      paramsSchema: z
        .object({ exercise: z.string().max(40).default('squats'), reps: z.int().min(1).max(500).default(20) })
        .loose() as unknown as z.ZodType<Record<string, unknown>>,
      completion: 'self_report',
      defaultEvidence: [],
      defaultPoints: 10,
      minTaskSeconds: 30,
    }),
  ],
  plausibility: { maxSpeedMps: 4 },
  restMet: 5.0,
  aiHints: { description: 'Self-reported exercise sets in the park.', examples: ['20 squats at each stop', 'park workout'] },
});
