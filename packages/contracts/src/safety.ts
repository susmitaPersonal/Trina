import type { SafetyNote } from './module-definition';
import type { SafetyConcern } from './module-intent';

/**
 * Deterministic text safety filter (design §8.2). The UI is English-only, but people type in their
 * own language, so the lists also cover Bengali and Hindi FOR SAFETY. Outcomes are monotonic: the
 * AI's own concerns are merged in and the strictest outcome wins; nothing can relax a finding.
 * Open source on purpose: improve the lists by pull request, with a test case in the eval set.
 */
export type SafetyLevel = 'ok' | 'note' | 'private_only' | 'blocked';
export type SafetyCategory = SafetyConcern | 'offensive' | 'rail' | 'reserved_name';
export type SafetyFinding = { category: SafetyCategory; term: string; outcome: Exclude<SafetyLevel, 'ok'>; message: string };
export type SafetyReport = { level: SafetyLevel; findings: SafetyFinding[]; notes: SafetyNote[]; concerns: SafetyConcern[] };

type Rule = { category: SafetyCategory; outcome: Exclude<SafetyLevel, 'ok'>; en: RegExp; local?: RegExp; message: string; notes?: SafetyNote[] };

/** Word-boundary English patterns; Bengali/Hindi are matched as substrings (no \b for those scripts). */
const RULES: Rule[] = [
  {
    category: 'motor_vehicle',
    outcome: 'blocked',
    en: /\b(drive|driving|driver|car|cars|motor ?bike|motorcycle|scooter|bike race|drag race|street race|race on the (?:road|highway|street)|speeding|drive fast|ride fast|highway)\b/i,
    local: /গাড়ি|বাইক রেস|মোটরসাইকেল|গাড়ী|गाड़ी|कार|मोटरसाइकिल|बाइक रेस|तेज़ चला/,
    message: 'motor vehicles and racing on roads are never part of Trina',
  },
  {
    category: 'height',
    outcome: 'blocked',
    en: /\b(roof|rooftop|roof ?top|terrace|climb(?:ing)? (?:the |a )?(?:tower|wall|building|water tank|water tower|pole|cliff)|cliff|ledge|parapet|balcony)\b/i,
    local: /ছাদ|ছাদে|ছাদের|छत|छत पर|टंकी पर चढ़/,
    message: 'heights (rooftops, towers, cliffs) have a high fall risk',
    notes: ['stay_off_rooftops'],
  },
  {
    category: 'rail',
    outcome: 'blocked',
    en: /\b(rail(?:way)? (?:track|tracks|line)|train tracks?|on the tracks)\b/i,
    local: /রেললাইন|রেল লাইন|रेल की पटरी|पटरी पर/,
    message: 'railway tracks are dangerous and off limits',
  },
  {
    category: 'fire',
    outcome: 'blocked',
    en: /\b(fire ?crackers?|crackers? contest|bonfire|fireworks?|set (?:a )?fire|burn(?:ing)? (?:trash|garbage|leaves))\b/i,
    local: /বাজি|আতশবাজি|আগুন|पटाखे|आग लगा|अलाव/,
    message: 'fire and fireworks are not allowed',
  },
  {
    category: 'weapons',
    outcome: 'blocked',
    en: /\b(gun|guns|knife fight|knives|weapon|weapons|airsoft|bb gun|catapult|slingshot)\b/i,
    local: /বন্দুক|ছুরি|बंदूक|चाकू/,
    message: 'weapons are not allowed',
  },
  {
    category: 'alcohol',
    outcome: 'blocked',
    en: /\b(beer|alcohol|drinking game|drunk|vodka|whisky|whiskey|booze)\b/i,
    local: /মদ|বিয়ার|शराब|बीयर/,
    message: 'alcohol is not allowed',
  },
  {
    category: 'night',
    outcome: 'blocked',
    en: /\b(at night|night ?time|midnight|after dark|in the dark|nocturnal|night (?:run|walk|ride|hike|trek))\b/i,
    local: /রাতে|রাত্রে|मध्यरात्रि|रात में|रात को/,
    message: 'Trina activities are daylight only',
    notes: ['daylight_only'],
  },
  {
    category: 'traffic',
    outcome: 'blocked',
    en: /\b(in traffic|through traffic|middle of the road|on the highway|cross(?:ing)? the highway)\b/i,
    message: 'playing in traffic is never safe',
    notes: ['no_road_racing'],
  },
  {
    category: 'private_property',
    outcome: 'blocked',
    en: /\b(trespass\w*|sneak into|break into|private property|someone'?s (?:garden|house|land))\b/i,
    message: 'private property is off limits',
  },
  {
    category: 'sharp_string',
    outcome: 'blocked',
    en: /\b(manja|glass[- ]coated|glass string|chinese string)\b/i,
    local: /মাঞ্জা|मांझा|माँझा/,
    message: 'glass-coated kite string injures birds and people',
    notes: ['no_glass_coated_string'],
  },
  {
    category: 'water',
    outcome: 'private_only',
    en: /\b(swim\w*|dive|diving|in the (?:river|lake|pond|sea|ocean|canal)|across the (?:river|lake|pond)|boat race)\b/i,
    local: /সাঁতার|পুকুরে নাম|নদীতে নাম|तैराकी|नदी में|तालाब में/,
    message: 'water activities need a buddy and can only be played privately',
    notes: ['no_swimming'],
  },
  {
    category: 'animals',
    outcome: 'private_only',
    en: /\b(feed(?:ing)? (?:stray|street) (?:dogs?|cats?)|stray dogs?|chase (?:animals|birds|dogs)|snakes?|monkeys?)\b/i,
    local: /কুকুর|সাপ|বাঁদর|कुत्ते|साँप|बंदर/,
    message: 'animals can be unpredictable; keep your distance',
    notes: ['keep_distance_from_animals'],
  },
  {
    category: 'heat',
    outcome: 'note',
    en: /\b(noon|midday|afternoon sun|heat ?wave|in the heat)\b/i,
    message: 'take breaks in the heat',
    notes: ['heat_take_breaks'],
  },
  {
    category: 'sharp_string',
    outcome: 'note',
    en: /\b(kites?|patang|ghuri|kite[- ]flying)\b/i,
    local: /ঘুড়ি|पतंग/,
    message: 'kite safety: no glass string, off rooftops, away from power lines',
    notes: ['no_glass_coated_string', 'stay_off_rooftops', 'away_from_power_lines'],
  },
  {
    category: 'offensive',
    outcome: 'blocked',
    en: /\b(fuck\w*|shit\w*|bitch\w*|bastard\w*|asshole\w*|cunt\w*|dick\w*|nazi\w*|kkk|rape\w*|terroris\w*|kill\w*|suicide)\b/i,
    local: /শালা|হারামি|चूतिया|हरामी|कमीना/,
    message: 'offensive or harmful language',
  },
  {
    category: 'reserved_name',
    outcome: 'blocked',
    en: /\b(trina official|official trina|trina (?:team|staff|admin)|admin|moderator|verified)\b/i,
    message: 'names that look official are reserved',
  },
];

const RANK: Record<SafetyLevel, number> = { ok: 0, note: 1, private_only: 2, blocked: 3 };

/** Concerns the AI may raise map to outcomes too (it can only make things stricter). */
const CONCERN_OUTCOME: Record<SafetyConcern, Exclude<SafetyLevel, 'ok'>> = {
  height: 'blocked', water: 'private_only', fire: 'blocked', traffic: 'blocked', animals: 'private_only', sharp_string: 'note',
  heat: 'note', night: 'blocked', alcohol: 'blocked', weapons: 'blocked', private_property: 'blocked', motor_vehicle: 'blocked',
};
const CONCERN_NOTES: Partial<Record<SafetyConcern, SafetyNote[]>> = {
  height: ['stay_off_rooftops'], water: ['no_swimming'], animals: ['keep_distance_from_animals'], heat: ['heat_take_breaks'],
  sharp_string: ['no_glass_coated_string'], night: ['daylight_only'], traffic: ['no_road_racing'],
};

export function stricter(a: SafetyLevel, b: SafetyLevel): SafetyLevel {
  return RANK[a] >= RANK[b] ? a : b;
}

/** Checks free text (prompt, labels, names) and optional AI-raised concerns. Pure. */
export function checkSafety(texts: string[], aiConcerns: SafetyConcern[] = []): SafetyReport {
  const findings: SafetyFinding[] = [];
  const notes = new Set<SafetyNote>();
  const concerns = new Set<SafetyConcern>();
  let level: SafetyLevel = 'ok';
  const text = texts.filter(Boolean).join('\n').normalize('NFC');
  for (const r of RULES) {
    const m = text.match(r.en) ?? (r.local ? text.match(r.local) : null);
    if (!m) continue;
    // A blocked sharp_string finding supersedes the kite "note" for the same category.
    if (findings.some((f) => f.category === r.category && RANK[f.outcome] >= RANK[r.outcome])) continue;
    findings.push({ category: r.category, term: m[0], outcome: r.outcome, message: r.message });
    level = stricter(level, r.outcome);
    for (const n of r.notes ?? []) notes.add(n);
    if (r.category !== 'offensive' && r.category !== 'rail' && r.category !== 'reserved_name') concerns.add(r.category);
  }
  for (const c of aiConcerns) {
    concerns.add(c);
    const outcome = CONCERN_OUTCOME[c];
    if (!findings.some((f) => f.category === c)) findings.push({ category: c, term: `(ai: ${c})`, outcome, message: `flagged as ${c.replace('_', ' ')}` });
    level = stricter(level, outcome);
    for (const n of CONCERN_NOTES[c] ?? []) notes.add(n);
  }
  return { level, findings, notes: [...notes].sort(), concerns: [...concerns].sort() };
}

/** Human-readable refusal reason from a report (first blocking finding). */
export function safetyReason(r: SafetyReport): string | null {
  if (r.level === 'ok' || r.level === 'note') return null;
  return r.findings.find((x) => x.outcome === r.level)?.message ?? null;
}

/** English-only builder input (owner decision): rejects mostly Bengali/Devanagari text. */
export function isMostlyEnglish(text: string): boolean {
  const letters = [...text].filter((ch) => /\p{L}/u.test(ch));
  if (!letters.length) return false;
  // Bengali (U+0980–U+09FF) and Devanagari (U+0900–U+097F) letters.
  const indic = letters.filter((ch) => {
    const cp = ch.codePointAt(0) ?? 0;
    return cp >= 0x0900 && cp <= 0x09ff;
  }).length;
  return indic / letters.length < 0.2;
}

/** Normalised key used to detect name collisions with official modules ("Cricket!" == "cricket"). */
export function nameKey(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');
}
