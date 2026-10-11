import { defineModule, quantityParams, noParams, taskType } from './define';

export const cleanup = defineModule({
  id: 'cleanup',
  version: 1,
  displayName: 'Litter clean-up',
  icon: '🧹',
  kind: 'task',
  paramsSchema: noParams,
  taskTypes: [
    taskType({
      id: 'collect_items',
      displayName: 'Collect litter',
      paramsSchema: quantityParams,
      completion: 'evidence',
      defaultEvidence: [{ kind: 'photo', count: 1, hint: 'Show the full bag of litter' }],
      defaultPoints: 50,
      minTaskSeconds: 120,
      evidenceRadiusM: 75,
    }),
  ],
  plausibility: { maxSpeedMps: 4 },
  restMet: 3.5,
  factNames: ['cleanup.items_collected'],
  factExtractors: [
    (state, compiled) => {
      let items = 0;
      for (const [id, t] of Object.entries(state.tasks)) {
        const def = compiled.tasks.get(id);
        if (def?.type === 'cleanup.collect_items' && t.status === 'done') {
          items += t.quantity ?? Number(def.params.quantity ?? 1);
        }
      }
      return { 'cleanup.items_collected': items };
    },
  ],
  difficulty: (params) => params,
  aiHints: {
    description: 'Pick up litter and show a photo of the filled bag.',
    examples: ['clean our street', 'pick up plastic at the beach', 'collect 10 pieces of garbage'],
  },
});
