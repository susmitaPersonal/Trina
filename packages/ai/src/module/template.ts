import type { ModuleIntentInput } from '@trina/contracts';

/**
 * Rule-based ModuleIntent (no model). Deterministic keyword templates; the guided form then lets the
 * player change any field. Safety is NOT decided here: the deterministic filter runs on every draft.
 */
type Template = Omit<ModuleIntentInput, 'team' | 'sessionLength' | 'concerns' | 'unresolved'> & { re: RegExp; team?: ModuleIntentInput['team']['size'] };

const TEMPLATES: Template[] = [
  {
    re: /\b(kites?|patang|ghuri|kite[- ]flying)\b/i,
    nameHint: 'Kite flying',
    movement: 'stationary_play',
    venue: 'open_ground',
    counters: [{ label: 'Kite duels won', unit: 'count', verification: 'peer' }],
    tasks: [
      { label: 'Get a kite in the air', completion: 'evidence', evidenceHint: 'Your kite in the sky' },
      { label: 'Pick up fallen string', completion: 'evidence', evidenceHint: 'Collected string in a bag' },
    ],
    milestoneIdeas: [
      { label: 'In the field', basis: 'dwell', window: 'session' },
      { label: 'Airborne', basis: 'task', window: 'lifetime', taskIndex: 0 },
      { label: 'Clean sky', basis: 'task', window: 'week', taskIndex: 1 },
      { label: 'Kite crew', basis: 'copresence', window: 'session' },
    ],
  },
  {
    re: /\b(bird\w*)\b/i,
    nameHint: 'Bird walk',
    movement: 'on_foot',
    venue: 'park',
    counters: [{ label: 'Species spotted', unit: 'species', verification: 'self_report' }],
    tasks: [{ label: 'Photograph a bird', completion: 'evidence', evidenceHint: 'A bird you spotted' }],
    milestoneIdeas: [
      { label: 'Quiet hour', basis: 'dwell', window: 'session' },
      { label: 'Species noted', basis: 'counter', window: 'day', counterIndex: 0 },
      { label: 'Dawn walk', basis: 'time_of_day_morning', window: 'day' },
      { label: 'Bird photo', basis: 'task', window: 'lifetime', taskIndex: 0 },
    ],
  },
  {
    re: /\b(badminton|shuttle\w*)\b/i,
    nameHint: 'Badminton',
    movement: 'mixed_play',
    venue: 'court',
    counters: [{ label: 'Games won', unit: 'count', verification: 'peer' }],
    tasks: [],
    milestoneIdeas: [
      { label: 'On the court', basis: 'dwell', window: 'session' },
      { label: 'Games won', basis: 'counter', window: 'day', counterIndex: 0 },
      { label: 'Regular player', basis: 'streak', window: 'lifetime' },
    ],
  },
  {
    re: /\b(frisbee|ultimate)\b/i,
    nameHint: 'Frisbee',
    movement: 'mixed_play',
    venue: 'park',
    counters: [{ label: 'Catches', unit: 'count', verification: 'peer' }],
    tasks: [],
    milestoneIdeas: [
      { label: 'Throwing time', basis: 'dwell', window: 'session' },
      { label: 'Good hands', basis: 'counter', window: 'day', counterIndex: 0 },
      { label: 'Frisbee crew', basis: 'copresence', window: 'session' },
    ],
  },
  {
    re: /\b(yoga|stretch\w*|asanas?)\b/i,
    nameHint: 'Outdoor yoga',
    movement: 'stationary_play',
    venue: 'garden',
    counters: [{ label: 'Poses held', unit: 'count', verification: 'self_report' }],
    tasks: [],
    milestoneIdeas: [
      { label: 'Mat time', basis: 'dwell', window: 'session' },
      { label: 'Morning practice', basis: 'time_of_day_morning', window: 'day' },
      { label: 'Yoga streak', basis: 'streak', window: 'lifetime' },
    ],
    team: 'solo',
  },
  {
    re: /\b(chess|carrom|board games?)\b/i,
    nameHint: 'Chess in the park',
    movement: 'stationary_play',
    venue: 'park',
    counters: [{ label: 'Games won', unit: 'count', verification: 'peer' }],
    tasks: [],
    milestoneIdeas: [
      { label: 'Fresh air time', basis: 'dwell', window: 'session' },
      { label: 'Winner', basis: 'counter', window: 'day', counterIndex: 0 },
    ],
    team: 'pair',
  },
  {
    re: /\b(skat\w*|roller\w*)\b/i,
    nameHint: 'Skating loop',
    movement: 'human_powered_wheels',
    venue: 'park',
    counters: [{ label: 'Laps', unit: 'laps', verification: 'self_report' }],
    tasks: [],
    milestoneIdeas: [
      { label: 'Rolling time', basis: 'dwell', window: 'session' },
      { label: 'Skate distance', basis: 'distance', window: 'day' },
    ],
  },
  {
    re: /\b(kho[- ]?kho|kabaddi|tag|hide and seek|playground)\b/i,
    nameHint: 'Playground game',
    movement: 'mixed_play',
    venue: 'open_ground',
    counters: [{ label: 'Rounds won', unit: 'rounds', verification: 'peer' }],
    tasks: [],
    milestoneIdeas: [
      { label: 'Playtime', basis: 'dwell', window: 'session' },
      { label: 'Rounds won', basis: 'counter', window: 'day', counterIndex: 0 },
      { label: 'Full team', basis: 'copresence', window: 'session' },
    ],
    team: 'two_teams',
  },
  {
    re: /\b(cricket)\b/i,
    nameHint: 'Gully cricket',
    movement: 'mixed_play',
    venue: 'open_ground',
    counters: [
      { label: 'Runs scored', unit: 'points', verification: 'organizer' },
      { label: 'Wickets taken', unit: 'count', verification: 'peer' },
    ],
    tasks: [],
    milestoneIdeas: [
      { label: 'At the ground', basis: 'dwell', window: 'session' },
      { label: 'Runs', basis: 'counter', window: 'day', counterIndex: 0 },
      { label: 'Wickets', basis: 'counter', window: 'day', counterIndex: 1 },
      { label: 'Full side', basis: 'copresence', window: 'session' },
    ],
    team: 'two_teams',
  },
  {
    re: /\b(football|soccer|5-a-side)\b/i,
    nameHint: 'Kick-about',
    movement: 'mixed_play',
    venue: 'open_ground',
    counters: [{ label: 'Goals', unit: 'count', verification: 'organizer' }],
    tasks: [],
    milestoneIdeas: [
      { label: 'Pitch time', basis: 'dwell', window: 'session' },
      { label: 'Goals', basis: 'counter', window: 'day', counterIndex: 0 },
    ],
    team: 'two_teams',
  },
  {
    re: /\b(volleyball|throwball)\b/i,
    nameHint: 'Volleyball',
    movement: 'mixed_play',
    venue: 'court',
    counters: [{ label: 'Points won', unit: 'points', verification: 'peer' }],
    tasks: [],
    milestoneIdeas: [
      { label: 'Court time', basis: 'dwell', window: 'session' },
      { label: 'Points', basis: 'counter', window: 'day', counterIndex: 0 },
    ],
    team: 'two_teams',
  },
  {
    re: /\b(hik\w*|trek\w*|trail)\b/i,
    nameHint: 'Hike',
    movement: 'on_foot',
    venue: 'any_public',
    counters: [],
    tasks: [{ label: 'Photo at the top', completion: 'evidence', evidenceHint: 'The view from the top' }],
    milestoneIdeas: [
      { label: 'Trail distance', basis: 'distance', window: 'day' },
      { label: 'Hike steps', basis: 'steps', window: 'day' },
      { label: 'Summit photo', basis: 'task', window: 'lifetime', taskIndex: 0 },
    ],
  },
  {
    re: /\b(plant\w*|sapling\w*|garden\w*|seed\w*)\b/i,
    nameHint: 'Community gardening',
    movement: 'on_foot',
    venue: 'garden',
    counters: [],
    tasks: [{ label: 'Plant or water a sapling', completion: 'evidence', evidenceHint: 'The sapling and the water' }],
    milestoneIdeas: [
      { label: 'Garden time', basis: 'dwell', window: 'session' },
      { label: 'Saplings cared for', basis: 'task', window: 'week', taskIndex: 0 },
    ],
  },
  {
    re: /\b(clean\w*|plastic|litter|garbage|trash|rubbish)\b/i,
    nameHint: 'Neighbourhood clean-up',
    movement: 'on_foot',
    venue: 'any_public',
    counters: [],
    tasks: [{ label: 'Fill a bag of litter', completion: 'evidence', evidenceHint: 'Your full bag of litter' }],
    milestoneIdeas: [
      { label: 'Clean-up time', basis: 'dwell', window: 'session' },
      { label: 'Bags collected', basis: 'task', window: 'day', taskIndex: 0 },
      { label: 'Clean-up crew', basis: 'copresence', window: 'session' },
    ],
  },
  {
    re: /\b(flowers?|photo walk|photograph\w*)\b/i,
    nameHint: 'Photo walk',
    movement: 'on_foot',
    venue: 'park',
    counters: [{ label: 'Kinds found', unit: 'species', verification: 'self_report' }],
    tasks: [{ label: 'Photo of a flower', completion: 'evidence', evidenceHint: 'A flower you found' }],
    milestoneIdeas: [
      { label: 'Walking time', basis: 'dwell', window: 'session' },
      { label: 'Flower photos', basis: 'task', window: 'day', taskIndex: 0 },
    ],
  },
  {
    re: /\b(cycl\w*|bike|bicycle)\b/i,
    nameHint: 'Bike ride',
    movement: 'human_powered_wheels',
    venue: 'any_public',
    counters: [],
    tasks: [],
    milestoneIdeas: [
      { label: 'Ride distance', basis: 'distance', window: 'day' },
      { label: 'Ride days', basis: 'streak', window: 'lifetime' },
    ],
  },
  {
    re: /\b(run\w*|jog\w*)\b/i,
    nameHint: 'Easy run',
    movement: 'on_foot',
    venue: 'any_public',
    counters: [],
    tasks: [],
    milestoneIdeas: [
      { label: 'Run distance', basis: 'distance', window: 'day' },
      { label: 'Run steps', basis: 'steps', window: 'day' },
    ],
  },
  {
    re: /\b(walk\w*|stroll\w*)\b/i,
    nameHint: 'Walk',
    movement: 'on_foot',
    venue: 'any_public',
    counters: [],
    tasks: [],
    milestoneIdeas: [
      { label: 'Walk steps', basis: 'steps', window: 'day' },
      { label: 'Walk distance', basis: 'distance', window: 'day' },
      { label: 'Morning walk', basis: 'time_of_day_morning', window: 'day' },
    ],
  },
];

const GENERIC: Template = {
  re: /.*/,
  nameHint: 'Outdoor play',
  movement: 'mixed_play',
  venue: 'open_ground',
  counters: [{ label: 'Rounds played', unit: 'rounds', verification: 'self_report' }],
  tasks: [],
  milestoneIdeas: [
    { label: 'Time outside', basis: 'dwell', window: 'session' },
    { label: 'Morning play', basis: 'time_of_day_morning', window: 'day' },
  ],
};

const VENUES: Array<[RegExp, ModuleIntentInput['venue']]> = [
  [/\b(lake|wetland|marsh)\b/i, 'wetland'],
  [/\bbeach\b/i, 'beach'],
  [/\bgarden\b/i, 'garden'],
  [/\bcourt\b/i, 'court'],
  [/\b(field|ground|maidan|maath|pitch)\b/i, 'open_ground'],
  [/\bpark\b/i, 'park'],
  [/\b(street|lane|neighbou?rhood|para|mohalla)\b/i, 'walkable_street'],
];

export function templateModuleIntent(prompt: string): ModuleIntentInput {
  const t = TEMPLATES.find((x) => x.re.test(prompt)) ?? GENERIC;
  const p = prompt.toLowerCase();
  const n = Number(p.match(/\b(?:with|for)\s+(\d{1,2})\s+(?:friends|people|players|of us|kids)/)?.[1] ?? NaN);
  const team: ModuleIntentInput['team']['size'] =
    /\b(alone|solo|by myself|just me)\b/.test(p) ? 'solo'
      : Number.isFinite(n) ? (n >= 10 ? 'two_teams' : n >= 3 ? 'small_group' : 'pair')
        : /\b(teams|match|vs)\b/.test(p) ? 'two_teams'
          : /\b(friends|group|cousins|neighbou?rs|family|club|class)\b/.test(p) ? (t.team === 'two_teams' ? 'two_teams' : 'small_group')
            : (t.team ?? 'small_group');
  const mins = Number(p.match(/\b(\d{2,3})\s*(?:min|mins|minutes)\b/)?.[1] ?? NaN);
  const sessionLength = Number.isFinite(mins) ? (mins <= 35 ? 'short' : mins <= 60 ? 'medium' : 'long') : /\b(quick|short)\b/.test(p) ? 'short' : /\b(long|all morning|hours?)\b/.test(p) ? 'long' : 'medium';
  const venue = t.venue === 'court' ? 'court' : (VENUES.find(([re]) => re.test(prompt))?.[1] ?? t.venue);
  const { re: _re, team: _team, ...rest } = t;
  void _re;
  void _team;
  return { ...rest, venue, team: { size: team }, sessionLength, concerns: [], unresolved: t === GENERIC ? ['activity_unclear'] : [] };
}
