/**
 * Model-agnostic LLM interface. The app never talks to a specific model or vendor.
 * Implementations: OpenAICompatibleProvider (Ollama / llama.cpp server / vLLM / LM Studio),
 * TemplateProvider (no AI), and LlamaRnProvider (on-device, in apps/mobile).
 */
export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export type Locality = 'device' | 'self_hosted' | 'none';

export type ProviderCapabilities = {
  contextTokens: number;
  structuredOutput: 'grammar' | 'json_schema' | 'none';
  streaming: boolean;
  vision: boolean;
  locality: Locality;
};

export type GenerateRequest = {
  messages: ChatMessage[];
  /** JSON Schema the output must follow (constrained decoding when supported). */
  schema?: Record<string, unknown>;
  /** GBNF grammar (llama.cpp family). */
  grammar?: string;
  maxTokens: number;
  temperature: number;
  stop?: string[];
  signal?: AbortSignal;
  /** Free-form tag for logs/telemetry, e.g. "intent.v1". */
  purpose?: string;
};

export type GenerateResult = {
  text: string;
  usage?: { promptTokens?: number; completionTokens?: number };
  latencyMs: number;
};

export interface LLMProvider {
  readonly id: string;
  readonly modelId: string;
  readonly capabilities: ProviderCapabilities;
  generate(req: GenerateRequest): Promise<GenerateResult>;
  /** Cheap availability probe (e.g. server reachable, model loaded). */
  isAvailable(): Promise<boolean>;
}

export class ProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderUnavailableError';
  }
}
