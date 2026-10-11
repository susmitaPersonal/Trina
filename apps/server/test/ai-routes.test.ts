import { OpenAICompatibleProvider } from '@trina/ai';
import { uuidv7 } from '@trina/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup } from './helpers';

const START: [number, number] = [88.35, 22.5115];

describe('AI routes with the model down (graceful fallback)', () => {
  let t: Awaited<ReturnType<typeof setup>>;
  beforeAll(async () => {
    // Points at a closed port: the self-hosted model is "offline".
    t = await setup({ llm: new OpenAICompatibleProvider({ baseUrl: 'http://127.0.0.1:9/v1', model: 'qwen3:4b', timeoutMs: 300 }) });
  });
  afterAll(async () => {
    await t.cleanup();
  });

  it('creates a draft with the rule-based builder and says so', async () => {
    const u = await t.user();
    const r = await t.api
      .post('/v1/ai/challenge-drafts')
      .set(u.auth)
      .send({ prompt: 'Create a 60-minute challenge for 5 friends involving cycling and cleaning our neighborhood', context: { startPoint: START } });
    expect(r.status).toBe(200);
    expect(r.body.provider.id).toBe('template');
    expect(r.body.notes.join(' ')).toMatch(/unavailable/);
    expect(r.body.intents[0].participants.count).toBe(5);
    expect(r.body.definitions[0].modules.map((m: any) => m.id)).toEqual(expect.arrayContaining(['cycling', 'cleanup']));

    // Accepting the draft creates a real challenge linked to the generation.
    const c = await t.api.post('/v1/challenges').set(u.auth).set('Idempotency-Key', uuidv7()).send({ definition: r.body.definitions[0], aiGenerationId: r.body.generationId });
    expect(c.status).toBe(201);
    const gen = await t.ctx.db.one<{ accepted: boolean }>('SELECT accepted FROM ai_generations WHERE id = $1', [r.body.generationId]);
    expect(gen?.accepted).toBe(true);
  });

  it('variations and "make it easier" work without a model', async () => {
    const u = await t.user();
    const v = await t.api.post('/v1/ai/challenge-drafts').set(u.auth).send({ prompt: '45 minute walk and water 3 trees', mode: 'variations', context: { startPoint: START } });
    expect(v.body.intents.map((i: any) => i.difficulty)).toEqual(['medium', 'easy', 'hard']);
    const p = await t.api.post('/v1/ai/challenge-drafts').set(u.auth).send({ prompt: 'make it easier', mode: 'patch', baseIntent: v.body.intents[0], context: { startPoint: START } });
    expect(p.status).toBe(200);
    expect(p.body.intents[0].difficulty).toBe('easy');
  });

  it('asks for a start point and serves the on-device model manifest', async () => {
    const u = await t.user();
    const r = await t.api.post('/v1/ai/challenge-drafts').set(u.auth).send({ prompt: 'walk' });
    expect(r.body.definitions[0]).toBeNull();
    const m = await t.api.get('/v1/ai/models').set(u.auth);
    expect(m.body[0].license).toBe('Apache-2.0');
  });

  it('explains rules with the official deterministic text when AI is unavailable', async () => {
    const owner = await t.user();
    const id = await t.publishedChallenge(owner);
    const r = await t.api.post('/v1/ai/explain').set(owner.auth).send({ challengeId: id, question: 'What do I do at the Boat Club?' });
    expect(r.body.officialRules.join(' ')).toMatch(/Boat Club/);
    expect(r.body.provider).toBe('template');
  });
});
