import { defineModule, noParams, taskType } from './define';

export const treeCare = defineModule({
  id: 'tree_care',
  version: 1,
  displayName: 'Tree care',
  icon: '🌳',
  kind: 'task',
  paramsSchema: noParams,
  taskTypes: [
    taskType({
      id: 'water_tree',
      displayName: 'Water a tree',
      completion: 'evidence',
      defaultEvidence: [{ kind: 'photo', count: 1, hint: 'Show the tree and the water' }],
      defaultPoints: 30,
      minTaskSeconds: 30,
      evidenceRadiusM: 40,
    }),
  ],
  plausibility: { maxSpeedMps: 4 },
  restMet: 3.0,
  factNames: ['tree_care.trees_watered'],
  factExtractors: [
    (state, compiled) => {
      let trees = 0;
      for (const [id, t] of Object.entries(state.tasks)) {
        if (compiled.tasks.get(id)?.type === 'tree_care.water_tree' && t.status === 'done') trees++;
      }
      return { 'tree_care.trees_watered': trees };
    },
  ],
  aiHints: {
    description: 'Water roadside or park trees, one photo per tree.',
    examples: ['water two trees', 'help the saplings in our lane'],
  },
});
