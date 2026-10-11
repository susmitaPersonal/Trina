/**
 * AI eval runner. Gate: ≥ 90 % valid intents before a model or prompt change ships.
 *   pnpm eval:ai                     → rule-based builder (baseline, no model)
 *   LLM_BASE_URL=http://localhost:11434/v1 LLM_MODEL=qwen3:4b pnpm eval:ai   → self-hosted model
 * On-device quality: serve the SAME GGUF with llama.cpp `llama-server` and point LLM_BASE_URL at it.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDraft, OpenAICompatibleProvider, profileFor, TemplateProvider, type LLMProvider } from '../src/index';

type Case = { prompt: string; expect: { durationMin?: number; count?: number; modules?: string[]; notModules?: string[]; trees?: number; difficulty?: string; mindful?: boolean; valid?: boolean } };

const here = dirname(fileURLToPath(import.meta.url));
const cases: Case[] = readFileSync(join(here, 'prompts.jsonl'), 'utf8').trim().split('\n').map((l: string) => JSON.parse(l));
const START: [number, number] = [88.35, 22.5115];

const provider: LLMProvider = process.env.LLM_BASE_URL
  ? new OpenAICompatibleProvider({ baseUrl: process.env.LLM_BASE_URL, model: process.env.LLM_MODEL ?? 'qwen3:4b', disableThinking: profileFor(process.env.LLM_MODEL ?? 'qwen3').disableThinking, timeoutMs: 120_000 })
  : new TemplateProvider();

let valid = 0, compiled = 0, constraintHits = 0, constraintTotal = 0, fallbacks = 0;
const latencies: number[] = [];
for (const c of cases) {
  const d = await createDraft(provider, c.prompt, { start: START });
  latencies.push(d.latencyMs);
  if (d.usedFallback && provider.capabilities.locality !== 'none') fallbacks++;
  valid++; // createDraft only returns validated intents (or throws)
  if (d.definition && !d.issues.some((i) => i.severity === 'error')) compiled++;
  const mods = new Set([...d.intent.activities.map((a) => a.module), ...d.intent.tasks.map((t) => t.module)]);
  const checks: boolean[] = [];
  if (c.expect.durationMin) checks.push(d.intent.durationMin === c.expect.durationMin);
  if (c.expect.count) checks.push(d.intent.participants.count === c.expect.count);
  for (const m of c.expect.modules ?? []) checks.push(mods.has(m));
  for (const m of c.expect.notModules ?? []) checks.push(!mods.has(m));
  if (c.expect.trees) checks.push(d.intent.tasks.find((t) => t.module === 'tree_care')?.quantity === c.expect.trees);
  if (c.expect.difficulty) checks.push(d.intent.difficulty === c.expect.difficulty);
  if (c.expect.mindful !== undefined) checks.push(d.intent.mindful === c.expect.mindful);
  constraintTotal += checks.length;
  constraintHits += checks.filter(Boolean).length;
  const ok = checks.every(Boolean);
  console.log(`${ok ? '✅' : '❌'} ${c.prompt.slice(0, 60).padEnd(60)} ${d.intent.durationMin}min ×${d.intent.participants.count} [${[...mods].join(',')}]${d.usedFallback && provider.capabilities.locality !== 'none' ? ' (fallback)' : ''}`);
}
const pct = (a: number, b: number) => `${Math.round((a / Math.max(1, b)) * 100)}%`;
latencies.sort((a, b) => a - b);
console.log(`\nProvider: ${provider.id}`);
console.log(`Valid intents: ${pct(valid, cases.length)} · Compiles: ${pct(compiled, cases.length)} · Constraint adherence: ${pct(constraintHits, constraintTotal)} · Fallbacks: ${fallbacks}`);
console.log(`Latency p50 ${latencies[Math.floor(latencies.length / 2)]} ms · p95 ${latencies[Math.floor(latencies.length * 0.95)]} ms`);
if (compiled / cases.length < 0.9) process.exitCode = 1;
