import { OpenAICompatibleProvider, profileFor, type LLMProvider } from '@trina/ai';
import type { Config } from '../../config';

/** Self-hosted open-weight model only (Ollama / llama.cpp server / vLLM). Never a proprietary cloud LLM. */
export function createLlmProvider(config: Config): LLMProvider {
  const profile = profileFor(config.LLM_MODEL);
  return new OpenAICompatibleProvider({
    baseUrl: config.LLM_BASE_URL,
    model: config.LLM_MODEL,
    timeoutMs: config.LLM_TIMEOUT_MS,
    contextTokens: profile.contextTokens,
    disableThinking: profile.disableThinking,
  });
}
