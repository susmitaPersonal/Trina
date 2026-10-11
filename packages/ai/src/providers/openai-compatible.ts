import { ProviderUnavailableError, type GenerateRequest, type GenerateResult, type LLMProvider, type ProviderCapabilities } from '../provider';

export type OpenAICompatibleOptions = {
  /** e.g. http://localhost:11434/v1 (Ollama), http://localhost:8080/v1 (llama.cpp server), vLLM, LM Studio. */
  baseUrl: string;
  model: string;
  /** Optional bearer for self-hosted gateways. Never a proprietary cloud LLM key. */
  apiKey?: string;
  timeoutMs?: number;
  contextTokens?: number;
  /** Qwen3-style models: append "/no_think" so they answer directly instead of reasoning first. */
  disableThinking?: boolean;
  fetchImpl?: typeof fetch;
};

/** Removes <think>…</think> blocks some open models emit. */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

/**
 * Talks to ANY OpenAI-compatible chat endpoint served by a self-hosted open-weight model.
 * Uses JSON-schema constrained output when a schema is given; falls back to json_object mode.
 */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly id: string;
  readonly modelId: string;
  readonly capabilities: ProviderCapabilities;
  private readonly fetch: typeof fetch;

  constructor(private readonly opts: OpenAICompatibleOptions) {
    this.modelId = opts.model;
    this.id = `http:${new URL(opts.baseUrl).host}:${opts.model}`;
    this.capabilities = {
      contextTokens: opts.contextTokens ?? 8192,
      structuredOutput: 'json_schema',
      streaming: false,
      vision: false,
      locality: 'self_hosted',
    };
    this.fetch = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  private headers() {
    return { 'content-type': 'application/json', ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}) };
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await this.fetch(`${this.opts.baseUrl}/models`, { headers: this.headers(), signal: AbortSignal.timeout(1500) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const messages = req.messages.map((m, i) =>
      this.opts.disableThinking && m.role === 'system' && i === 0 ? { ...m, content: `${m.content}\n/no_think` } : m,
    );
    const body: Record<string, unknown> = {
      model: this.opts.model,
      messages,
      temperature: req.temperature,
      max_tokens: req.maxTokens,
      ...(req.stop ? { stop: req.stop } : {}),
    };
    if (req.schema) body.response_format = { type: 'json_schema', json_schema: { name: 'output', schema: req.schema, strict: true } };

    const started = Date.now();
    const call = async (b: Record<string, unknown>) => {
      const signal = req.signal ?? AbortSignal.timeout(this.opts.timeoutMs ?? 60_000);
      try {
        return await this.fetch(`${this.opts.baseUrl}/chat/completions`, { method: 'POST', headers: this.headers(), body: JSON.stringify(b), signal });
      } catch (e) {
        throw new ProviderUnavailableError(`LLM endpoint unreachable: ${(e as Error).message}`);
      }
    };
    let res = await call(body);
    if (res.status === 400 && req.schema) {
      // Some runtimes don't support json_schema; retry with plain JSON mode (schema still in the prompt).
      res = await call({ ...body, response_format: { type: 'json_object' } });
    }
    if (!res.ok) throw new ProviderUnavailableError(`LLM endpoint returned ${res.status}`);
    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = stripThinking(json.choices?.[0]?.message?.content ?? '');
    return {
      text,
      usage: { promptTokens: json.usage?.prompt_tokens, completionTokens: json.usage?.completion_tokens },
      latencyMs: Date.now() - started,
    };
  }
}
