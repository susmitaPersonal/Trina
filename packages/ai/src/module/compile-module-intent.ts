import {
  checkSafety,
  RESERVED_MODULE_PREFIXES,
  sha256Hex,
  type ChecklistItem,
  type CounterUnit,
  type MilestoneDefinitionInput,
  type ModuleDefinitionInput,
  type ModuleIntent,
  type Movement,
  type SafetyNote,
  type Stat,
} from '@trina/contracts';

/**
 * Deterministic ModuleIntent → ModuleDefinition compiler (ADR-027). The LLM chose only enums and
 * labels; every number (thresholds, weights, limits) comes from the fixed tables below.
 * Same intent + same owner + same day → same definition.
 */

const TEAM: Record<ModuleIntent['team']['size'], { min: number; max: number }> = {
  solo: { min: 1, max: 1 },
  pair: { min: 2, max: 2 },
  small_group: { min: 2, max: 8 },
  team: { min: 3, max: 15 },
  two_teams: { min: 4, max: 22 },
};
const MINUTES = { short: 30, medium: 45, long: 90 } as const;
const COUNTER_LIMITS: Record<CounterUnit, { perMin: number; perSession: number; tiers: [number, number, number] }> = {
  count: { perMin: 2, perSession: 100, tiers: [1, 3, 10] },
  overs: { perMin: 0.5, perSession: 10, tiers: [1, 2, 4] },
  points: { perMin: 3, perSession: 200, tiers: [5, 20, 50] },
  laps: { perMin: 1, perSession: 50, tiers: [1, 5, 10] },
  rounds: { perMin: 1, perSession: 30, tiers: [1, 3, 5] },
  species: { perMin: 1, perSession: 50, tiers: [3, 5, 10] },
  minutes: { perMin: 1, perSession: 180, tiers: [10, 30, 60] },
};
const DWELL_TIERS = { short: [900, 1800, 2700], medium: [1800, 2700, 5400], long: [2700, 5400, 7200] } as const;
const PROFILE_STAT: Record<Movement, Stat> = { on_foot: 'VIT', human_powered_wheels: 'AGI', stationary_play: 'SENSE', mixed_play: 'STR' };
const CHECKLIST: Record<Movement, ChecklistItem[]> = {
  on_foot: ['water_bottle', 'shoes_on'],
  human_powered_wheels: ['helmet_on', 'brakes_checked'],
  stationary_play: ['sun_protection', 'water_bottle'],
  mixed_play: ['water_bottle', 'warm_up'],
};

const ICONS: Array<[RegExp, NonNullable<ModuleDefinitionInput['meta']>['icon']]> = [
  [/kite|patang|ghuri/i, 'kite'], [/bird/i, 'bird'], [/badminton|shuttle/i, 'badminton'], [/tennis/i, 'tennis'], [/basket/i, 'basketball'],
  [/volley/i, 'volleyball'], [/frisbee|ultimate/i, 'frisbee'], [/yoga|stretch/i, 'yoga'], [/chess|carrom|board/i, 'chess'], [/skat|roller/i, 'skate'],
  [/hik|trek|trail/i, 'hike'], [/football|soccer/i, 'football'], [/cricket/i, 'cricket'], [/garden|plant|sapling/i, 'garden'], [/flower/i, 'flower'],
  [/clean|litter|plastic|trash/i, 'broom'], [/photo/i, 'camera'], [/run|jog/i, 'run'], [/cycl|bike/i, 'bike'], [/walk|stroll/i, 'walk'], [/music|sing/i, 'music'], [/paint|draw|sketch/i, 'paint'],
];
const DEFAULT_ICON: Record<Movement, NonNullable<ModuleDefinitionInput['meta']>['icon']> = { on_foot: 'walk', human_powered_wheels: 'bike', stationary_play: 'sun', mixed_play: 'ball' };

/** Lowercase ASCII slug for ids (labels may be any language; ids never are). */
export function slugify(text: string, max = 24): string {
  const s = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, max)
    .replace(/_+$/g, '');
  return s.length >= 2 ? s : '';
}

function uniqueIds(labels: string[], fallback: string, max = 31): string[] {
  const used = new Set<string>();
  return labels.map((l, i) => {
    let base = slugify(l, max - 3) || `${fallback}_${i + 1}`;
    if (!/^[a-z]/.test(base)) base = `${fallback}_${base}`.slice(0, max - 3);
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}_${n}`;
    used.add(id);
    return id;
  });
}

const titleCase = (s: string) => s.trim().replace(/\s+/g, ' ').replace(/^./, (c) => c.toUpperCase()).slice(0, 40);
const tiers = (xs: readonly number[]) => (['bronze', 'silver', 'gold'] as const).slice(0, xs.length).map((tier, i) => ({ tier, gte: xs[i]! }));

export type CompileModuleIntentOptions = {
  /** Stable per-owner seed (e.g. user id) so ids don't collide between people. */
  ownerSeed: string;
  /** Day key; part of the id hash. */
  dateKey: string;
  /** Extra safety notes found in the original prompt (monotonic: always added). */
  extraNotes?: SafetyNote[];
};

export function compileModuleIntent(intent: ModuleIntent, opts: CompileModuleIntentOptions): ModuleDefinitionInput {
  const name = titleCase(intent.nameHint);
  let slug = slugify(intent.nameHint) || 'activity';
  if (RESERVED_MODULE_PREFIXES.some((p) => slug.startsWith(p))) slug = `my_${slug}`.slice(0, 24);
  const id = `u_${slug}_${sha256Hex(`${opts.ownerSeed}|${intent.nameHint}|${opts.dateKey}`).slice(0, 4)}`;
  const team = TEAM[intent.team.size];
  const target = MINUTES[intent.sessionLength];

  const counterIds = uniqueIds(intent.counters.map((c) => c.label), 'count');
  const counters = intent.counters.map((c, i) => ({
    id: counterIds[i]!,
    label: c.label,
    unit: c.unit,
    verification: c.verification,
    maxPerMinute: COUNTER_LIMITS[c.unit].perMin,
    maxPerSession: COUNTER_LIMITS[c.unit].perSession,
  }));
  const taskIds = uniqueIds(intent.tasks.map((t) => t.label), 'task');
  const taskTypes = intent.tasks.map((t, i) => ({
    id: taskIds[i]!,
    displayName: t.label,
    completion: t.completion,
    evidence: t.completion === 'evidence' ? [{ kind: 'photo' as const, count: 1, hint: (t.evidenceHint ?? `Photo: ${t.label}`).slice(0, 60) }] : [],
    minTaskSeconds: t.completion === 'evidence' ? 60 : t.completion === 'confirmation' ? 600 : 30,
    evidenceRadiusM: intent.venue === 'court' ? 100 : 150,
    weight: t.completion === 'evidence' ? 3 : t.completion === 'confirmation' ? 2 : 1,
  }));

  const profileStat = PROFILE_STAT[intent.movement];
  const civic = /clean|litter|plastic|plant|water|tree|sapling|garbage|trash/i;
  const milestones: MilestoneDefinitionInput[] = [];
  const ideaIds = uniqueIds(intent.milestoneIdeas.map((m) => m.label), 'goal', 32);
  intent.milestoneIdeas.forEach((idea, k) => {
    const base = { id: ideaIds[k]!, title: idea.label };
    const w = idea.window;
    if (idea.basis === 'dwell') {
      if (w === 'week') milestones.push({ ...base, window: 'week', measure: { agg: 'days', fact: 'zone_dwell_s', perDayGte: 1800 }, tiers: tiers([2, 3, 4]), stat: profileStat });
      else if (w === 'lifetime') milestones.push({ ...base, window: 'lifetime', measure: { agg: 'sum', fact: 'zone_dwell_s' }, tiers: tiers([36_000, 108_000, 360_000]), stat: profileStat });
      else milestones.push({ ...base, window: w, measure: { agg: w === 'session' ? 'max' : 'sum', fact: 'zone_dwell_s' }, tiers: tiers(DWELL_TIERS[intent.sessionLength]), stat: profileStat });
    } else if (idea.basis === 'distance') {
      const wheels = intent.movement === 'human_powered_wheels';
      const t = w === 'week' ? (wheels ? [20_000, 50_000, 100_000] : [10_000, 25_000, 50_000]) : w === 'lifetime' ? [50_000, 200_000, 1_000_000] : wheels ? [5000, 10_000, 20_000] : [1000, 3000, 5000];
      milestones.push({ ...base, window: w, measure: { agg: 'sum', fact: 'distance_m' }, tiers: tiers(t), stat: wheels ? 'AGI' : 'VIT' });
    } else if (idea.basis === 'steps') {
      if (w === 'week') milestones.push({ ...base, window: 'week', measure: { agg: 'days', fact: 'steps', perDayGte: 5000 }, tiers: tiers([3, 5, 7]), stat: 'VIT' });
      else milestones.push({ ...base, window: w, measure: { agg: 'sum', fact: 'steps' }, tiers: tiers(w === 'lifetime' ? [50_000, 250_000, 1_000_000] : [2000, 5000, 8000]), stat: 'VIT' });
    } else if (idea.basis === 'counter' && idea.counterIndex !== undefined && counters[idea.counterIndex]) {
      const c = counters[idea.counterIndex]!;
      const fact = c.verification === 'self_report' ? `${id}.${c.id}` : `${id}.${c.id}.confirmed`;
      const mult = w === 'week' ? 3 : w === 'lifetime' ? 10 : 1;
      const t = COUNTER_LIMITS[c.unit].tiers.map((x) => Math.min(w === 'session' || w === 'day' ? c.maxPerSession : 1_000_000, x * mult));
      milestones.push({ ...base, window: w, measure: { agg: 'sum', fact }, tiers: tiers([...new Set(t)]), stat: intent.movement === 'mixed_play' ? 'STR' : 'SENSE' });
    } else if (idea.basis === 'task' && idea.taskIndex !== undefined && taskTypes[idea.taskIndex]) {
      const t = taskTypes[idea.taskIndex]!;
      const fact = `${id}.${t.id}.done_count`;
      const stat: Stat = civic.test(t.displayName) ? 'AURA' : 'SENSE';
      if (w === 'session') milestones.push({ ...base, window: 'session', measure: { agg: 'sum', fact }, tiers: [{ tier: 'unlock', gte: 1 }], stat });
      else milestones.push({ ...base, window: w, measure: { agg: 'sum', fact }, tiers: tiers(w === 'lifetime' ? [1, 10, 25] : [1, 3, 5]), stat });
    } else if (idea.basis === 'copresence') {
      milestones.push({ ...base, window: 'session', measure: { agg: 'max', fact: 'copresence.max_players' }, tiers: [{ tier: 'unlock', gte: Math.min(10, Math.max(3, team.min)) }], scope: 'team', stat: 'AURA' });
    } else if (idea.basis === 'time_of_day_morning') {
      milestones.push({ ...base, window: 'day', measure: { agg: 'sessions' }, where: { all: [{ fact: 'start_local_minute', op: '<', value: 540 }, { fact: 'zone_dwell_s', op: '>=', value: 900 }] }, tiers: [{ tier: 'unlock', gte: 1 }], stat: 'VIT' });
    } else if (idea.basis === 'streak') {
      milestones.push({ ...base, window: 'lifetime', measure: { agg: 'streak_days', fact: 'zone_dwell_s', perDayGte: 900, restDaysPerWeek: 1, samePlace: false }, tiers: tiers([3, 5, 7]), stat: 'VIT' });
    }
  });
  if (!milestones.some((m) => 'fact' in m.measure && m.measure.fact === 'zone_dwell_s')) {
    milestones.unshift({ id: milestones.some((m) => m.id === 'time_outside') ? 'time_outside_auto' : 'time_outside', title: `${name} time`.slice(0, 40), window: 'session', measure: { agg: 'max', fact: 'zone_dwell_s' }, tiers: tiers(DWELL_TIERS[intent.sessionLength]), stat: profileStat });
  }

  const venueText: Record<string, string> = {
    open_ground: 'an open ground', park: 'a park', court: 'a court', walkable_street: 'walkable streets', beach: 'a beach', wetland: 'a wetland', garden: 'a garden', any_public: 'a public place',
  };
  const counted = counters.filter((c) => c.verification !== 'self_report').map((c) => c.label.toLowerCase());
  const description = `${name} at ${venueText[intent.venue]}. Time outside is measured${counted.length ? `; ${counted.join(' and ')} count when another player confirms` : ''}.`;
  const icon = ICONS.find(([re]) => re.test(intent.nameHint))?.[1] ?? DEFAULT_ICON[intent.movement];

  const draft: ModuleDefinitionInput = {
    schemaVersion: 'module/1.0',
    id,
    version: 1,
    origin: 'community',
    forkedFrom: null,
    meta: { displayName: name, description: description.slice(0, 300), icon, tags: team.max > 1 ? ['social', 'open_air'] : ['open_air'], language: 'en' },
    movement: intent.movement,
    venue: intent.venue,
    team,
    params: [{ key: 'targetMinutes', kind: 'int', min: 20, max: 180, default: target, unit: 'minutes' }],
    counters,
    taskTypes,
    scoring: {
      counterRules: counters.filter((c) => c.verification !== 'self_report').map((c) => ({ counter: c.id, weight: c.verification === 'organizer' ? 2 : 1, capPerSession: Math.min(10, c.maxPerSession) })),
      dwellWeight: intent.movement === 'stationary_play' || intent.movement === 'mixed_play' ? 3 : 1,
      distanceWeight: intent.movement === 'on_foot' || intent.movement === 'human_powered_wheels' ? 2 : 0,
    },
    difficulty: [{ param: 'targetMinutes', easy: 30, medium: 45, hard: 90 }],
    plausibility: {},
    safety: { checklist: CHECKLIST[intent.movement], daylightOnly: true, notes: [] },
    milestones: milestones.slice(0, 12),
    aiHints: { description: description.slice(0, 200), examples: [intent.nameHint.slice(0, 80)] },
  };
  // Safety notes: from the generated text, the AI's concerns and the original prompt. Only ever added.
  const texts = [draft.meta!.displayName, draft.meta!.description ?? '', ...counters.map((c) => c.label), ...taskTypes.map((t) => t.displayName), ...milestones.map((m) => m.title)];
  const notes = new Set<SafetyNote>([...checkSafety(texts, intent.concerns).notes, ...(opts.extraNotes ?? [])]);
  draft.safety = { ...draft.safety!, notes: [...notes].sort().slice(0, 8) };
  return draft;
}
