import { ChallengeIntent, IntentPatch, type ChallengeIntent as Intent } from '@trina/contracts';

/**
 * Applies whitelisted patch ops ("make it harder") deterministically.
 * Returns the new intent (validated) or throws.
 */
export function applyIntentPatch(intent: Intent, patch: unknown): Intent {
  const p = IntentPatch.parse(patch);
  const next: any = JSON.parse(JSON.stringify(intent));
  for (const op of p.ops) {
    const parts = op.path.split('.');
    if (op.path === 'activities' || op.path === 'tasks') {
      const list: any[] = next[op.path];
      if (op.op === 'add' && op.value && typeof op.value === 'object') list.push(op.value);
      else if (op.op === 'remove' && op.value && typeof op.value === 'object') {
        const v = op.value as Record<string, unknown>;
        next[op.path] = list.filter((x) => !(x.module === v.module && (v.type === undefined || x.type === v.type)));
      } else if (op.op === 'set' && Array.isArray(op.value)) next[op.path] = op.value;
      continue;
    }
    if (op.op !== 'set') continue;
    let target = next;
    for (const k of parts.slice(0, -1)) target = target[k];
    target[parts[parts.length - 1]!] = op.value;
  }
  return ChallengeIntent.parse(next);
}

/** Deterministic difficulty shift used when the user taps "Easier"/"Harder" (no model needed). */
export function shiftDifficulty(intent: Intent, dir: 'easier' | 'harder'): Intent {
  const order = ['easy', 'medium', 'hard'] as const;
  const idx = Math.max(0, Math.min(2, order.indexOf(intent.difficulty) + (dir === 'harder' ? 1 : -1)));
  const factor = dir === 'harder' ? 1.25 : 0.8;
  return ChallengeIntent.parse({
    ...intent,
    difficulty: order[idx],
    checkpoints: {
      ...intent.checkpoints,
      count: Math.max(1, Math.min(20, intent.checkpoints.count + (dir === 'harder' ? 1 : -1))),
      ...(intent.checkpoints.targetDistanceKm ? { targetDistanceKm: Math.round(intent.checkpoints.targetDistanceKm * factor * 10) / 10 } : {}),
    },
    tasks: intent.tasks.map((t) => (t.quantity ? { ...t, quantity: Math.max(1, Math.min(100, Math.round(t.quantity * factor))) } : t)),
  });
}
