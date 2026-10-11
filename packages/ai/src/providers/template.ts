import type { ChallengeIntentInput } from '@trina/contracts';
import { templateModuleIntent } from '../module/template';
import type { GenerateRequest, GenerateResult, LLMProvider, ProviderCapabilities } from '../provider';

/** Keyword tables (English + Bengali + Hindi). Deterministic; no model involved. */
const MODULE_WORDS: Record<string, RegExp> = {
  cycling: /\b(cycl\w*|bike|biking|bicycle|ride)\b|সাইকেল|साइकिल/i,
  running: /\b(run|running|jog\w*|sprint\w*|5k|10k)\b|দৌড়|दौड़/i,
  walking: /\b(walk\w*|stroll|hike|hiking|trek)\b|হাঁট|হাটা|पैदल|चल/i,
  cleanup: /\b(clean\w*|garbage|litter|trash|plastic|rubbish|waste)\b|আবর্জনা|ময়লা|পরিষ্কার|कचरा|सफ़ाई|सफाई/i,
  tree_care: /\b(tree|trees|plant\w*|sapling\w*|water\w*)\b|গাছ|पेड़|पौध/i,
  mindful: /\b(mindful\w*|relax\w*|calm|de-?stress|meditat\w*|breath\w*)\b|শান্ত|ধ্যান|ध्यान/i,
  scavenger: /\b(scavenger|treasure|hunt|find)\b|খোঁজ|खोज/i,
  fitness: /\b(workout|exercise|squat\w*|push-?ups?|fitness)\b|ব্যায়াম|व्यायाम/i,
};

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, fifteen: 15, twenty: 20,
  এক: 1, দুই: 2, তিন: 3, চার: 4, পাঁচ: 5, दो: 2, तीन: 3, चार: 4, पांच: 5,
};

function num(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : NUMBER_WORDS[s.toLowerCase()];
}

const N = '(\\d+|one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty)';

/** Bengali (০-৯) and Devanagari (०-९) digits → ASCII; local hour/minute words → English. */
export function normalizeLocal(text: string): string {
  return text
    .replace(/[০-৯]/g, (d) => String(d.charCodeAt(0) - 0x09e6))
    .replace(/[०-९]/g, (d) => String(d.charCodeAt(0) - 0x0966))
    .replace(/ঘন্টা|ঘণ্টা|घंटा|घंटे/g, ' hour ')
    .replace(/মিনিট|मिनट/g, ' minutes ')
    .replace(/জন|लोग/g, ' people ');
}

/** Extracts a ChallengeIntent from free text using rules only. */
export function templateIntent(prompt: string): ChallengeIntentInput {
  prompt = normalizeLocal(prompt);
  const p = prompt.toLowerCase();
  const hours = num(p.match(new RegExp(`${N}\\s*(?:-\\s*)?(?:hours?|hrs?)\\b`))?.[1]);
  const mins = num(p.match(new RegExp(`${N}\\s*(?:-\\s*)?(?:minutes?|mins?|min)\\b`))?.[1]);
  const durationMin = Math.min(480, Math.max(10, mins ?? (hours ? hours * 60 : p.includes('half an hour') ? 30 : p.includes('an hour') ? 60 : 45)));

  const people = num(
    p.match(new RegExp(`(?:for|with)\\s+${N}\\s+(?:friends|people|of us|players|kids|volunteers|members)`))?.[1] ??
      p.match(new RegExp(`${N}\\s+(?:of us|friends|people|volunteers)`))?.[1],
  );
  const count = Math.max(1, Math.min(500, (people ?? (/\b(we|us|our|friends|team)\b/.test(p) ? 4 : 1)) + (/\bme and\b|\band me\b/.test(p) ? 1 : 0)));
  const team = count > 1 && /\b(team|together|friends|group|us|our)\b/.test(p);

  const matched = Object.entries(MODULE_WORDS).filter(([, re]) => re.test(prompt)).map(([id]) => id);
  const activityIds = matched.filter((m) => m === 'walking' || m === 'running' || m === 'cycling');
  const activities = (activityIds.length ? activityIds : ['walking']).slice(0, 2).map((module) => ({ module }));

  const tasks: NonNullable<ChallengeIntentInput['tasks']> = [];
  if (matched.includes('cleanup')) {
    const q = num(p.match(new RegExp(`${N}\\s+(?:pieces|items|bags|bits)`))?.[1]) ?? 10;
    tasks.push({ module: 'cleanup', type: 'collect_items', quantity: Math.min(100, q) });
  }
  if (matched.includes('tree_care')) {
    const q = num(p.match(new RegExp(`${N}\\s+(?:roadside\\s+|street\\s+|park\\s+)?(?:trees?|saplings?|plants?)`))?.[1]) ?? 2;
    tasks.push({ module: 'tree_care', type: 'water_tree', quantity: Math.min(10, q) });
  }
  if (matched.includes('scavenger')) tasks.push({ module: 'scavenger', type: 'find_spot', quantity: 4 });
  if (matched.includes('fitness')) tasks.push({ module: 'fitness', type: 'do_reps', quantity: 3 });

  const difficulty = /\b(easy|gentle|light|not too hard|beginner|kids?)\b/.test(p) ? 'easy' : /\b(hard|tough|intense|challenging)\b/.test(p) ? 'hard' : 'medium';
  const km = Number(p.match(/(\d+(?:\.\d+)?)\s*(?:km|k)\b/)?.[1]);
  const treeCount = tasks.find((t) => t.module === 'tree_care')?.quantity ?? 0;
  const cpCount = Math.max(3, Math.min(8, 2 + treeCount, Math.round(durationMin / 15)));

  return {
    durationMin,
    participants: { count, mode: team ? 'team' : 'individual', ...(team ? { teams: 1 } : {}) },
    activities,
    tasks,
    checkpoints: { count: cpCount, layout: /\b(out and back|there and back)\b/.test(p) ? 'out_and_back' : 'loop', ...(km > 0 ? { targetDistanceKm: Math.min(100, km) } : {}) },
    difficulty,
    mindful: matched.includes('mindful'),
    unresolved: ['start_location'],
  };
}

/** No-AI provider: always available, deterministic, honest about what it is. */
export class TemplateProvider implements LLMProvider {
  readonly id = 'template';
  readonly modelId = 'rules-v1';
  readonly capabilities: ProviderCapabilities = { contextTokens: 0, structuredOutput: 'none', streaming: false, vision: false, locality: 'none' };

  async isAvailable() {
    return true;
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const started = Date.now();
    const user = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const text = req.purpose?.startsWith('intent')
      ? JSON.stringify(templateIntent(user.replace(/^[\s\S]*?Request:\s*/i, '')))
      : req.purpose?.startsWith('module-intent')
        ? JSON.stringify(templateModuleIntent(user.replace(/^[\s\S]*?Activity:\s*/i, '')))
        : '';
    return { text, latencyMs: Date.now() - started };
  }
}
