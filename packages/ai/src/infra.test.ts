import { ChallengeIntent } from '@trina/contracts';
import { describe, expect, it } from 'vitest';
import {
  AIRouter,
  explainMessages,
  explainRules,
  intentMessages,
  MODEL_PROFILES,
  ON_DEVICE_MODELS,
  OpenAICompatibleProvider,
  patchDraft,
  patchMessages,
  profileFor,
  ProviderUnavailableError,
  recap,
  recapMessages,
  TemplateProvider,
  templateIntent,
  type GenerateRequest,
  type LLMProvider,
} from './index';

const START: [number, number] = [88.35, 22.5115];

function fake(outputs: (string | Error)[], opts: { available?: boolean; locality?: 'device' | 'self_hosted' } = {}): LLMProvider & { calls: GenerateRequest[] } {
  const calls: GenerateRequest[] = [];
  return {
    id: `fake-${opts.locality ?? 'self_hosted'}`,
    modelId: 'fake',
    capabilities: { contextTokens: 4096, structuredOutput: 'json_schema', streaming: false, vision: false, locality: opts.locality ?? 'self_hosted' },
    calls,
    async isAvailable() {
      if (opts.available === undefined) return true;
      return opts.available;
    },
    async generate(req) {
      calls.push(req);
      const o = outputs.shift() ?? '';
      if (o instanceof Error) throw o;
      return { text: o, latencyMs: 1 };
    },
  };
}

const base = ChallengeIntent.parse({ durationMin: 60, participants: { count: 4, mode: 'team' }, activities: [{ module: 'walking' }], tasks: [], checkpoints: { count: 3 } });

describe('AIRouter', () => {
  it('prefers on-device, then server, then the rule-based builder', async () => {
    const device = fake([], { locality: 'device', available: true });
    const server = fake([], { available: true });
    expect((await new AIRouter([device, server]).pick()).id).toBe('fake-device');
    const deviceOff = fake([], { locality: 'device', available: false });
    expect((await new AIRouter([deviceOff, server]).pick()).id).toBe('fake-self_hosted');
    const broken = { ...server, isAvailable: async () => { throw new Error('boom'); } } as LLMProvider;
    expect((await new AIRouter([deviceOff, broken]).pick()).id).toBe('template');
  });
});

describe('model profiles and manifest', () => {
  it('maps model ids to profiles (Qwen3 disables thinking)', () => {
    expect(profileFor('qwen3:4b').disableThinking).toBe(true);
    expect(profileFor('Qwen3-1.7B-Instruct').disableThinking).toBe(true);
    expect(profileFor('gemma3:4b')).toBe(MODEL_PROFILES.gemma3);
    expect(profileFor('mystery-model')).toBe(MODEL_PROFILES.llama3);
  });
  it('lists open-licensed on-device models with RAM requirements', () => {
    expect(ON_DEVICE_MODELS.every((m) => m.license === 'Apache-2.0' && m.minRamGb >= 4)).toBe(true);
  });
});

describe('prompts', () => {
  it('include the registry catalogue and the language note; never ask for coordinates', () => {
    const sys = intentMessages('hello')[0]!.content;
    expect(sys).toMatch(/tree_care \[task\]/);
    expect(sys).toMatch(/Bengali or Hindi/);
    expect(sys).toMatch(/Never invent modules, coordinates, points or scores/);
    expect(patchMessages('harder', '{}')[0]!.content).toMatch(/Never touch points or coordinates/);
    expect(recapMessages({ points: 1 })[0]!.content).toMatch(/Use ONLY the numbers given/);
    expect(explainMessages(['Rule A'], 'q')[0]!.content).toMatch(/- Rule A/);
  });
});

describe('patchDraft', () => {
  it('applies a model patch and recompiles', async () => {
    const p = fake([JSON.stringify({ ops: [{ op: 'set', path: 'durationMin', value: 90 }, { op: 'add', path: 'tasks', value: { module: 'tree_care', type: 'water_tree', quantity: 2 } }] })]);
    const d = await patchDraft(p, base, 'longer and water two trees', { start: START });
    expect(d.intent.durationMin).toBe(90);
    expect(d.definition?.tasks?.filter((t) => t.type === 'tree_care.water_tree')).toHaveLength(2);
  });
  it('rejects patches that produce unknown modules', async () => {
    const p = fake([JSON.stringify({ ops: [{ op: 'add', path: 'activities', value: { module: 'flying' } }] })]);
    await expect(patchDraft(p, base, 'fly', { start: START })).rejects.toThrow(/invalid/);
  });
});

describe('recap and explain with a working model', () => {
  const facts = { title: 'Walk', points: 120, distanceKm: 2.5, minutes: 40 };
  it('uses the model text when it only uses given numbers', async () => {
    const r = await recap(fake(['"Great walk: 120 points over 2.5 km!"']), facts);
    expect(r.text).toBe('Great walk: 120 points over 2.5 km!');
    expect(r.provider).toBe('fake-self_hosted');
  });
  it('falls back when the model errors or rambles', async () => {
    expect((await recap(fake([new Error('down')]), facts)).provider).toBe('template');
    expect((await recap(fake(['x'.repeat(500)]), facts)).provider).toBe('template');
  });
  it('explains rules with a model and falls back to the official text on failure/empty', async () => {
    expect((await explainRules(fake(['Walk to each checkpoint in order.']), ['Rule.'], 'how?')).text).toBe('Walk to each checkpoint in order.');
    expect((await explainRules(fake(['   ']), ['Rule A.', 'Rule B.'], 'how?')).text).toBe('Rule A. Rule B.');
    expect((await explainRules(fake([new Error('x')]), ['Rule A.'], 'how?')).provider).toBe('template');
  });
});

describe('OpenAI-compatible provider edge cases', () => {
  it('isAvailable reflects /models reachability', async () => {
    const ok = new OpenAICompatibleProvider({ baseUrl: 'http://h/v1', model: 'm', fetchImpl: (async () => new Response('{}', { status: 200 })) as never });
    const down = new OpenAICompatibleProvider({ baseUrl: 'http://h/v1', model: 'm', fetchImpl: (async () => { throw new Error('ECONNREFUSED'); }) as never });
    const err = new OpenAICompatibleProvider({ baseUrl: 'http://h/v1', model: 'm', fetchImpl: (async () => new Response('', { status: 500 })) as never });
    expect(await ok.isAvailable()).toBe(true);
    expect(await down.isAvailable()).toBe(false);
    expect(await err.isAvailable()).toBe(false);
  });
  it('throws ProviderUnavailableError on network failure and non-2xx; sends API key and stop', async () => {
    let seen: RequestInit | undefined;
    const p500 = new OpenAICompatibleProvider({ baseUrl: 'http://h/v1', model: 'm', apiKey: 'k', fetchImpl: (async (_u: string, init: RequestInit) => { seen = init; return new Response('', { status: 503 }); }) as never });
    await expect(p500.generate({ messages: [{ role: 'user', content: 'x' }], maxTokens: 5, temperature: 0, stop: ['\n'] })).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect((seen!.headers as Record<string, string>).authorization).toBe('Bearer k');
    expect(JSON.parse(String(seen!.body)).stop).toEqual(['\n']);
    const pNet = new OpenAICompatibleProvider({ baseUrl: 'http://h/v1', model: 'm', fetchImpl: (async () => { throw new TypeError('fetch failed'); }) as never });
    await expect(pNet.generate({ messages: [], maxTokens: 5, temperature: 0 })).rejects.toThrow(/unreachable/);
  });
  it('reports usage tokens', async () => {
    const p = new OpenAICompatibleProvider({ baseUrl: 'http://h/v1', model: 'm', fetchImpl: (async () => new Response(JSON.stringify({ choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }))) as never });
    const r = await p.generate({ messages: [], maxTokens: 5, temperature: 0 });
    expect(r.usage).toEqual({ promptTokens: 10, completionTokens: 2 });
    expect(p.id).toBe('http:h:m');
  });
});

describe('TemplateProvider', () => {
  it('answers intent requests deterministically and nothing else', async () => {
    const t = new TemplateProvider();
    expect(await t.isAvailable()).toBe(true);
    const out = await t.generate({ messages: intentMessages('90 minute cycle with 3 friends'), maxTokens: 10, temperature: 0, purpose: 'intent.v1' });
    expect(JSON.parse(out.text).durationMin).toBe(90);
    expect((await t.generate({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 1, temperature: 0, purpose: 'recap.v1' })).text).toBe('');
  });
  it.each([
    ['half an hour stroll', { durationMin: 30 }],
    ['an hour run, 10k', { durationMin: 60, km: 10 }],
    ['2 hours out and back cycling', { durationMin: 120, layout: 'out_and_back' }],
    ['tough park workout', { difficulty: 'hard' }],
    ['me and my 3 friends walk', { mode: 'team' }],
    ['solo walk', { mode: 'individual' }],
  ])('parses "%s"', (text, exp) => {
    const i = templateIntent(text);
    if ('durationMin' in exp) expect(i.durationMin).toBe(exp.durationMin);
    if ('km' in exp) expect(i.checkpoints.targetDistanceKm).toBe(exp.km);
    if ('layout' in exp) expect(i.checkpoints.layout).toBe(exp.layout);
    if ('difficulty' in exp) expect(i.difficulty).toBe(exp.difficulty);
    if ('mode' in exp) expect(i.participants.mode).toBe(exp.mode);
  });
});
