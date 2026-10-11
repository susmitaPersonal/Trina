import { defineModule, noParams, taskType } from './define';

export const mindful = defineModule({
  id: 'mindful',
  version: 1,
  displayName: 'Mindful moments',
  icon: '🧘',
  kind: 'task',
  paramsSchema: noParams,
  taskTypes: [
    taskType({ id: 'pause', displayName: 'Pause for 60 seconds and look around', completion: 'self_report', defaultEvidence: [], defaultPoints: 5, minTaskSeconds: 60 }),
    taskType({ id: 'notice', displayName: 'Notice three sounds or colours', completion: 'self_report', defaultEvidence: [], defaultPoints: 5, minTaskSeconds: 30 }),
    taskType({ id: 'breathe', displayName: 'Breathe slowly (4-7-8) five times', completion: 'self_report', defaultEvidence: [], defaultPoints: 5, minTaskSeconds: 60 }),
  ],
  plausibility: { maxSpeedMps: 4 },
  restMet: 1.3,
  aiHints: {
    description: 'Short self-reported mindful pauses. Small fixed points so they cannot be farmed.',
    examples: ['something relaxing', 'help us de-stress', 'mindful walk'],
  },
});
