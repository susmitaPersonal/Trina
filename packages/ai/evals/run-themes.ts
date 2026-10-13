/**
 * Theme picker eval (ADR-032). Gate: 100 % enum-only outputs (anything else falls back to rules) and
 * ≥ 80 % keyword-case agreement with the rules for a real model.
 *   pnpm eval:ai                                     → rule-based (baseline)
 *   LLM_BASE_URL=http://localhost:11434/v1 LLM_MODEL=qwen3:4b pnpm eval:ai   → self-hosted model
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenAICompatibleProvider, profileFor, suggestTheme, TemplateProvider, type LLMProvider } from '../src/index';

type Case = { text: string; expect: string | null };
const here = dirname(fileURLToPath(import.meta.url));
const cases: Case[] = readFileSync(join(here, 'themes.jsonl'), 'utf8').trim().split('\n').map((l: string) => JSON.parse(l));
const provider: LLMProvider = process.env.LLM_BASE_URL
  ? new OpenAICompatibleProvider({ baseUrl: process.env.LLM_BASE_URL, model: process.env.LLM_MODEL ?? 'qwen3:4b', disableThinking: profileFor(process.env.LLM_MODEL ?? 'qwen3').disableThinking, timeoutMs: 60_000 })
  : new TemplateProvider();

let agree = 0, scored = 0, fromModel = 0;
for (const c of cases) {
  const out = await suggestTheme(provider, c.text);
  if (out.provider !== 'template') fromModel++;
  if (Object.keys(out).sort().join() !== 'provider,themeId,tone') throw new Error(`Non-enum output for "${c.text}"`);
  if (c.expect) {
    scored++;
    if (out.themeId === c.expect) agree++;
  }
  console.log(`${!c.expect || out.themeId === c.expect ? '✅' : '❌'} ${c.text.slice(0, 50).padEnd(50)} → ${out.themeId} (${out.tone}, ${out.provider})`);
}
console.log(`\nProvider: ${provider.id} · agreement ${Math.round((agree / scored) * 100)}% · answered by model ${fromModel}/${cases.length} · enum-only 100%`);
if (agree / scored < 0.8) process.exitCode = 1;
