import { defineModule, noParams, taskType } from './define';

export const scavenger = defineModule({
  id: 'scavenger',
  version: 1,
  displayName: 'Scavenger hunt',
  icon: '🔎',
  kind: 'task',
  paramsSchema: noParams,
  taskTypes: [
    taskType({
      id: 'find_spot',
      displayName: 'Find the spot and take a photo',
      completion: 'evidence',
      defaultEvidence: [{ kind: 'photo', count: 1, hint: 'Photo of what you found' }],
      defaultPoints: 20,
      evidenceRadiusM: 40,
    }),
  ],
  plausibility: { maxSpeedMps: 7 },
  restMet: 2.0,
  aiHints: { description: 'Find hidden spots at checkpoints and photograph them.', examples: ['treasure hunt for kids', 'find 5 murals'] },
});
