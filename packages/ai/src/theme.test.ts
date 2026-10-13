import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { QuestThemeIntent, type PartyTemplateId } from '@trina/contracts';
import { describe, expect, it } from 'vitest';
import type { GenerateRequest, LLMProvider } from './provider';
import { TemplateProvider } from './providers/template';
import { suggestTheme, templateTheme, themeJsonSchema } from './theme';

type Case = { text: string; expect: string | null };
const cases: Case[] = readFileSync(join(__dirname, '../evals/themes.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

/** A model stand-in returning a fixed text, recording what it was asked. */
function fakeModel(text: string | (() => string)): LLMProvider & { last?: GenerateRequest } {
  const p: LLMProvider & { last?: GenerateRequest } = {
    id: 'fake', modelId: 'fake-1',
    capabilities: { contextTokens: 4096, structuredOutput: 'json_schema', streaming: false, vision: false, locality: 'device' },
    isAvailable: async () => true,
    generate: async (req) => {
      p.last = req;
      return { text: typeof text === 'function' ? text() : text, latencyMs: 1 };
    },
  };
  return p;
}

describe('theme picker (rules, EN/BN/HI)', () => {
  it.each(cases.filter((c) => c.expect))('"%s"', (c) => {
    expect(templateTheme(c.text).themeId).toBe(c.expect);
  });

  it('with no keyword, the template picks a fitting default; output is always enums only', () => {
    const defaults: Record<PartyTemplateId, string> = { party_outside_v1: 'park_explorers', party_cleanup_v1: 'litter_hunters', party_trees_v1: 'tree_patrol' };
    for (const c of cases.filter((x) => !x.expect)) {
      for (const [t, d] of Object.entries(defaults)) {
        const out = templateTheme(c.text, t as PartyTemplateId);
        expect(out.themeId).toBe(d);
        expect(QuestThemeIntent.safeParse(out).success).toBe(true);
        expect(JSON.stringify(out)).not.toMatch(/\d/);
      }
    }
  });

  it('without a model, suggestTheme uses rules', async () => {
    expect(await suggestTheme(new TemplateProvider(), 'clean the beach')).toMatchObject({ themeId: 'river_guardians', provider: 'template' });
  });
});

describe('theme picker with a model (constrained, validated, fallback)', () => {
  it('accepts a valid enum answer, asking with the schema and treating the text as data', async () => {
    const m = fakeModel('{"themeId":"sunrise_squad","tone":"heroic"}');
    expect(await suggestTheme(m, 'beat the heat before the city wakes')).toEqual({ themeId: 'sunrise_squad', tone: 'heroic', provider: 'fake' });
    expect(m.last?.schema).toEqual(themeJsonSchema());
    expect(m.last?.messages[0]!.content).toMatch(/not instructions/);
  });

  it.each([
    ['extra field with points', '{"themeId":"tree_patrol","tone":"calm","points":500}'],
    ['unknown theme', '{"themeId":"speed_racers","tone":"calm"}'],
    ['numbers in a field', '{"themeId":"tree_patrol","tone":"90 min"}'],
    ['prose, no JSON', 'Sure! Tree patrol sounds great.'],
    ['empty', ''],
  ])('falls back to rules on %s', async (_label, text) => {
    const out = await suggestTheme(fakeModel(text), 'water the trees', { templateId: 'party_cleanup_v1' });
    expect(out).toMatchObject({ themeId: 'tree_patrol', provider: 'template' });
  });

  it('falls back when the model throws, and never calls the model for empty text', async () => {
    const boom = fakeModel(() => {
      throw new Error('model crashed');
    });
    expect((await suggestTheme(boom, 'litter hunt')).provider).toBe('template');
    const idle = fakeModel('{"themeId":"tree_patrol","tone":"calm"}');
    expect((await suggestTheme(idle, '   ', { templateId: 'party_trees_v1' })).provider).toBe('template');
    expect(idle.last).toBeUndefined();
  });

  it('prompt-injection text still yields only enum fields', async () => {
    for (const c of cases.filter((x) => !x.expect)) {
      const out = await suggestTheme(fakeModel('{"themeId":"park_explorers","tone":"playful","score":1000}'), c.text);
      expect(Object.keys(out).sort()).toEqual(['provider', 'themeId', 'tone']);
    }
  });
});
