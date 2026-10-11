import { describe, expect, it } from 'vitest';
import { compile, haversineM } from '@trina/engine';
import {
  buildIntentJsonSchema,
  checkIntent,
  compileIntent,
  createDraft,
  extractJson,
  layoutCheckpoints,
  OpenAICompatibleProvider,
  recap,
  recapUsesOnlyGivenNumbers,
  shiftDifficulty,
  stripThinking,
  templateIntent,
  templateRecap,
  TemplateProvider,
  type GenerateRequest,
  type LLMProvider,
} from './index';

const START: [number, number] = [88.35, 22.5115];

/** Fake model returning scripted outputs, recording requests. */
class ScriptedProvider implements LLMProvider {
  readonly id = 'scripted';
  readonly modelId = 'fake-1';
  readonly capabilities = { contextTokens: 4096, structuredOutput: 'json_schema' as const, streaming: false, vision: false, locality: 'self_hosted' as const };
  calls: GenerateRequest[] = [];
  constructor(private outputs: (string | Error)[]) {}
  async isAvailable() {
    return true;
  }
  async generate(req: GenerateRequest) {
    this.calls.push(req);
    const o = this.outputs.shift() ?? '';
    if (o instanceof Error) throw o;
    return { text: o, latencyMs: 5 };
  }
}

const GOOD = JSON.stringify({
  titleHint: 'Pedal & Pick-up',
  durationMin: 60,
  participants: { count: 5, mode: 'team', teams: 1 },
  activities: [{ module: 'cycling', intensity: 'easy' }],
  tasks: [
    { module: 'cleanup', type: 'collect_items', quantity: 10 },
    { module: 'tree_care', type: 'water_tree', quantity: 2 },
  ],
  checkpoints: { count: 4, layout: 'loop' },
  difficulty: 'medium',
  mindful: false,
  unresolved: ['start_location'],
});

describe('template (no-AI) intent extraction', () => {
  it('understands the canonical demo prompt', () => {
    const i = templateIntent('Create a 60-minute challenge for 5 friends involving cycling and cleaning our neighborhood.');
    expect(i.durationMin).toBe(60);
    expect(i.participants.count).toBe(5);
    expect(i.participants.mode).toBe('team');
    expect(i.activities.map((a) => a.module)).toEqual(['cycling']);
    expect(i.tasks?.[0]).toMatchObject({ module: 'cleanup', type: 'collect_items' });
  });
  it('parses hours, tree counts and difficulty', () => {
    const i = templateIntent('I want a 90-minute outdoor challenge for 4 people. We should cycle, collect garbage, and water two trees. Not too hard.');
    expect(i.durationMin).toBe(90);
    expect(i.tasks?.find((t) => t.module === 'tree_care')?.quantity).toBe(2);
    expect(i.difficulty).toBe('easy');
  });
  it('handles Bengali and Hindi keywords', () => {
    expect(templateIntent('বন্ধুদের সাথে ১ ঘন্টা হাঁটা আর গাছে জল দেওয়া').tasks?.[0]?.module).toBe('tree_care');
    expect(templateIntent('दोस्तों के साथ साइकिल और कचरा सफाई').activities.map((a) => a.module)).toContain('cycling');
  });
});

describe('intent validation', () => {
  it('builds a schema whose enums come from the registry', () => {
    const s = buildIntentJsonSchema() as any;
    expect(s.properties.activities.items.properties.module.enum).toEqual(['walking', 'running', 'cycling']);
    expect(s.properties.tasks.items.properties.type.enum).toContain('water_tree');
  });
  it('rejects invented modules and task types', () => {
    const bad = { ...JSON.parse(GOOD), activities: [{ module: 'teleporting' }], tasks: [{ module: 'cleanup', type: 'vacuum_ocean' }] };
    const r = checkIntent(bad);
    expect(r.ok).toBe(false);
  });
  it('extracts JSON wrapped in prose and fences', () => {
    expect(extractJson('Sure!\n```json\n{"a":{"b":"}"}}\n```')).toEqual({ a: { b: '}' } });
    expect(stripThinking('<think>hmm</think>{"x":1}')).toBe('{"x":1}');
  });
});

describe('deterministic compiler', () => {
  it('produces a definition the engine accepts, with geometry from code (not the LLM)', () => {
    const intent = checkIntent(JSON.parse(GOOD));
    if (!intent.ok) throw new Error('bad fixture');
    const def = compileIntent(intent.intent, { start: START });
    const r = compile(def);
    expect(r.ok).toBe(true);
    expect(def.checkpoints).toHaveLength(4);
    // Trees are bound to checkpoints; litter can be collected anywhere in the boundary.
    expect(def.tasks!.filter((t) => t.type === 'tree_care.water_tree').every((t) => t.location?.kind === 'checkpoint')).toBe(true);
    // Same input → same output.
    expect(compileIntent(intent.intent, { start: START })).toEqual(def);
  });
  it('places loop checkpoints near the start at a sensible radius', () => {
    const pts = layoutCheckpoints(START, 4, 'loop', 3000);
    for (const p of pts) expect(haversineM(START, p)).toBeLessThan(1100);
  });
  it('shifts difficulty deterministically', () => {
    const i = checkIntent(JSON.parse(GOOD));
    if (!i.ok) throw new Error();
    const h = shiftDifficulty(i.intent, 'harder');
    expect(h.difficulty).toBe('hard');
    expect(h.checkpoints.count).toBe(5);
  });
});

describe('agent pipeline', () => {
  it('uses the model output when valid', async () => {
    const p = new ScriptedProvider([GOOD]);
    const d = await createDraft(p, 'cycle and clean', { start: START });
    expect(d.usedFallback).toBe(false);
    expect(d.provider.locality).toBe('self_hosted');
    expect(d.definition).not.toBeNull();
    expect(p.calls[0]!.schema).toBeDefined();
  });
  it('repairs once, then succeeds', async () => {
    const p = new ScriptedProvider(['{"durationMin": "sixty"}', GOOD]);
    const d = await createDraft(p, 'cycle and clean', { start: START });
    expect(d.attempts).toBe(2);
    expect(d.usedFallback).toBe(false);
    expect(p.calls[1]!.messages.at(-1)!.content).toMatch(/invalid/);
  });
  it('falls back to the template when the model keeps failing or is down', async () => {
    const d1 = await createDraft(new ScriptedProvider(['nope', 'nope', 'nope']), '60 minute walk for 3 friends', { start: START });
    expect(d1.usedFallback).toBe(true);
    expect(d1.provider.id).toBe('template');
    const d2 = await createDraft(new ScriptedProvider([new Error('ECONNREFUSED')]), '60 minute walk', { start: START });
    expect(d2.usedFallback).toBe(true);
    expect(d2.notes.join(' ')).toMatch(/unavailable/);
  });
  it('asks for a start point when none is given', async () => {
    const d = await createDraft(new TemplateProvider(), 'walk', {});
    expect(d.definition).toBeNull();
    expect(d.notes.join(' ')).toMatch(/start point/);
  });
});

describe('recap guard', () => {
  const facts = { title: 'Green Sprint 60', points: 281, distanceKm: 2.2, minutes: 60, steps: 4212, kcalEstimate: 210, phoneFreeMinutes: 48 };
  it('accepts recaps that only use given numbers', () => {
    expect(recapUsesOnlyGivenNumbers('You walked 4,212 steps and earned 281 points!', facts)).toBe(true);
  });
  it('rejects invented numbers and falls back to the template', async () => {
    expect(recapUsesOnlyGivenNumbers('You burned 900 calories!', facts)).toBe(false);
    const r = await recap(new ScriptedProvider(['You burned 900 calories!']), facts);
    expect(r.provider).toBe('template');
    expect(r.text).toBe(templateRecap(facts));
  });
});

describe('OpenAI-compatible provider', () => {
  it('sends json_schema, strips thinking, and retries with json_object on 400', async () => {
    const bodies: any[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      if (bodies.length === 1) return new Response('bad', { status: 400 });
      return new Response(JSON.stringify({ choices: [{ message: { content: '<think>x</think>{"ok":true}' } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const p = new OpenAICompatibleProvider({ baseUrl: 'http://localhost:11434/v1', model: 'qwen3:4b', disableThinking: true, fetchImpl });
    const out = await p.generate({ messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }], schema: { type: 'object' }, maxTokens: 10, temperature: 0 });
    expect(out.text).toBe('{"ok":true}');
    expect(bodies[0].response_format.type).toBe('json_schema');
    expect(bodies[1].response_format.type).toBe('json_object');
    expect(bodies[0].messages[0].content).toMatch(/\/no_think$/);
  });
});
