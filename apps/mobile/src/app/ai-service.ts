import { createDraft, finalizeDraft, recap, shiftDifficulty, templateRecap, TemplateProvider, type RecapFacts } from '@trina/ai';
import type { ChallengeDefinitionInput, ChallengeIntent, CompileIssue, LngLat } from '@trina/contracts';
import { LlamaRnProvider } from '../platform/llama';
import { getServices } from './services';

export type DraftView = {
  intent: ChallengeIntent;
  definition: ChallengeDefinitionInput | null;
  issues: CompileIssue[];
  notes: string[];
  where: 'device' | 'server' | 'rules';
  modelLabel: string;
  generationId?: string;
};

let deviceProvider: LlamaRnProvider | null = null;

/** Installed on-device model (if any): see Profile → AI model. */
export async function getDeviceProvider(): Promise<LlamaRnProvider | null> {
  const s = await getServices();
  const row = await s.db.get<{ id: string; file_uri: string; status: string }>(`SELECT * FROM ai_models WHERE status = 'ready' LIMIT 1`);
  if (!row) return null;
  if (!deviceProvider || deviceProvider.modelId !== row.id) {
    deviceProvider = new LlamaRnProvider(row.id, row.file_uri.replace('file://', ''), row.id.includes('0.6b') ? 4 : 6);
  }
  return (await deviceProvider.isAvailable()) ? deviceProvider : null;
}

export async function releaseDeviceModel() {
  await deviceProvider?.release();
}

/**
 * Router: on-device model → self-hosted server model → rule-based builder (always works offline).
 * Whatever runs, the result is an editable draft validated by the deterministic engine.
 */
export async function draftChallenge(prompt: string, start: LngLat | undefined): Promise<DraftView> {
  const s = await getServices();
  const device = await getDeviceProvider();
  if (device) {
    const d = await createDraft(device, prompt, { start });
    if (!d.usedFallback) {
      void s.api.request('POST', '/v1/ai/generations', { modelId: device.modelId, promptVersion: d.promptVersion, valid: true, latencyMs: d.latencyMs }).catch(() => undefined);
      return { ...d, where: 'device', modelLabel: `On this device · ${device.modelId}` };
    }
  }
  if (s.network.online) {
    try {
      const r = await s.api.aiDraft({ prompt, mode: 'create', context: start ? { startPoint: start } : {} });
      const local = r.intents[0] ? finalizeDraft(r.intents[0], start) : null;
      return {
        intent: r.intents[0]!,
        definition: (r.definitions[0] as ChallengeDefinitionInput | null) ?? local?.definition ?? null,
        issues: r.issues,
        notes: r.notes,
        where: r.provider.locality === 'none' ? 'rules' : 'server',
        modelLabel: r.provider.locality === 'none' ? 'Rule-based builder (AI model offline)' : `Trina server · ${r.provider.modelId}`,
        generationId: r.generationId,
      };
    } catch {
      /* fall through to the local rule-based builder */
    }
  }
  const d = await createDraft(new TemplateProvider(), prompt, { start });
  return { ...d, where: 'rules', modelLabel: 'Rule-based builder (works offline)', notes: ['No AI model available right now. The built-in rule-based builder made this draft.', ...d.notes] };
}

export function adjustDraft(view: DraftView, dir: 'easier' | 'harder', start: LngLat | undefined): DraftView {
  const next = finalizeDraft(shiftDifficulty(view.intent, dir), start);
  return { ...view, ...next };
}

export function placeDraft(view: DraftView, start: LngLat): DraftView {
  return { ...view, ...finalizeDraft(view.intent, start) };
}

export async function recapFor(sessionId: string, facts: RecapFacts): Promise<string> {
  const s = await getServices();
  const device = await getDeviceProvider();
  if (device) return (await recap(device, facts)).text;
  if (s.network.online) {
    try {
      return (await s.api.aiRecap(sessionId)).text;
    } catch {
      /* fall back */
    }
  }
  return templateRecap(facts);
}
