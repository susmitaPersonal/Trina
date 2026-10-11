import type { ModelManifestEntry } from '@trina/contracts';

/**
 * Candidate open-weight models (benchmark before committing; see docs/architecture/ai.md §6).
 * `sha256` and `url` are placeholders until the week-1 benchmark picks the exact GGUF files;
 * the app verifies the hash after download and refuses mismatches.
 */
export const ON_DEVICE_MODELS: ModelManifestEntry[] = [
  {
    id: 'qwen3-1.7b-instruct-q4_k_m',
    family: 'Qwen3',
    quant: 'Q4_K_M',
    bytes: 1_100_000_000,
    sha256: 'TBD',
    url: 'https://huggingface.co/Qwen/Qwen3-1.7B-GGUF',
    minRamGb: 6,
    license: 'Apache-2.0',
  },
  {
    id: 'qwen3-0.6b-instruct-q4_k_m',
    family: 'Qwen3',
    quant: 'Q4_K_M',
    bytes: 400_000_000,
    sha256: 'TBD',
    url: 'https://huggingface.co/Qwen/Qwen3-0.6B-GGUF',
    minRamGb: 4,
    license: 'Apache-2.0',
  },
];

/** Model profiles: data, not code. Swapping models is a config change gated by evals. */
export const MODEL_PROFILES: Record<string, { disableThinking: boolean; temperature: number; contextTokens: number }> = {
  qwen3: { disableThinking: true, temperature: 0.2, contextTokens: 8192 },
  gemma3: { disableThinking: false, temperature: 0.2, contextTokens: 8192 },
  llama3: { disableThinking: false, temperature: 0.2, contextTokens: 8192 },
};

export function profileFor(modelId: string) {
  const key = Object.keys(MODEL_PROFILES).find((k) => modelId.toLowerCase().replace(/[^a-z0-9]/g, '').includes(k));
  return MODEL_PROFILES[key ?? 'llama3']!;
}
