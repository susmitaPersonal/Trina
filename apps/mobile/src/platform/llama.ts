import type { GenerateRequest, GenerateResult, LLMProvider, ProviderCapabilities } from '@trina/ai';
import * as Device from 'expo-device';

/**
 * On-device open-weight model via llama.cpp (llama.rn). OPTIONAL (ADR-010: stretch goal).
 * Enable with: `pnpm --filter @trina/mobile add llama.rn` + a dev build, then download a GGUF in Profile → AI model.
 * The native module is required lazily so the app builds and runs without it.
 */
type LlamaContext = {
  completion(params: Record<string, unknown>): Promise<{ text: string; timings?: { predicted_n?: number; prompt_n?: number } }>;
  release(): Promise<void>;
};

function loadLlama(): { initLlama(p: Record<string, unknown>): Promise<LlamaContext> } | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('llama.rn');
  } catch {
    return null;
  }
}

export function llamaAvailable(): boolean {
  return loadLlama() !== null;
}

export function deviceRamGb(): number {
  return (Device.totalMemory ?? 0) / 1024 ** 3;
}

export class LlamaRnProvider implements LLMProvider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities = { contextTokens: 4096, structuredOutput: 'json_schema', streaming: true, vision: false, locality: 'device' };
  private ctx: LlamaContext | null = null;

  constructor(
    readonly modelId: string,
    private readonly modelPath: string,
    private readonly minRamGb: number,
  ) {
    this.id = `llama-rn:${modelId}`;
  }

  async isAvailable(): Promise<boolean> {
    return llamaAvailable() && deviceRamGb() >= this.minRamGb - 0.5;
  }

  /** Load lazily when the AI Builder opens; release when leaving (≈1.5 GB RAM). Never during a challenge. */
  async load() {
    if (this.ctx) return this.ctx;
    const lib = loadLlama();
    if (!lib) throw new Error('llama.rn is not installed in this build');
    this.ctx = await lib.initLlama({ model: this.modelPath, n_ctx: 4096, n_gpu_layers: 99, use_mlock: false });
    return this.ctx;
  }

  async release() {
    await this.ctx?.release();
    this.ctx = null;
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const ctx = await this.load();
    const started = Date.now();
    const messages = req.messages.map((m, i) => (i === 0 && m.role === 'system' && this.modelId.startsWith('qwen3') ? { ...m, content: `${m.content}\n/no_think` } : m));
    const out = await ctx.completion({
      messages,
      n_predict: req.maxTokens,
      temperature: req.temperature,
      stop: req.stop,
      ...(req.schema ? { response_format: { type: 'json_schema', json_schema: { strict: true, schema: req.schema } } } : {}),
      ...(req.grammar ? { grammar: req.grammar } : {}),
    });
    return {
      text: out.text.replace(/<think>[\s\S]*?<\/think>/g, '').trim(),
      usage: { completionTokens: out.timings?.predicted_n, promptTokens: out.timings?.prompt_n },
      latencyMs: Date.now() - started,
    };
  }
}
