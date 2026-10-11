# @trina/ai

Model-agnostic AI layer for the **Challenge Agent**. The AI is advisory and never authoritative.

- Spec: [docs/architecture/ai.md](../../docs/architecture/ai.md)

Layout (see also `evals/` and `src/agent.ts` for the pipeline):
```
src/
  provider.ts              LLMProvider interface, ModelProfile
  providers/openai-compatible.ts   Ollama / llama.cpp server / vLLM / LM Studio
  providers/template.ts    deterministic no-AI fallback
  router.ts                device → self-hosted → template
  intent/                  ChallengeIntent grammar builder (from engine registry), repair loop
  compiler/                intent → ChallengeDefinition (deterministic)
prompts/                   intent.v1.md, patch.v1.md, describe.v1.md, encourage.v1.md
evals/                     prompts.jsonl + runner
evals/kaggle/              Kaggle Benchmarks port of the intent eval (see evals/kaggle/README.md)
```

Kaggle benchmark: [evals/kaggle/README.md](evals/kaggle/README.md) has a 40-case, code-scored
"stay in your lane" port of the intent eval for the Kaggle Benchmarking Challenge.

The on-device `LlamaRnProvider` lives in `apps/mobile/src/features/ai` (native module), so this
package stays platform-agnostic.

**Hard rules:** the LLM never outputs coordinates, scores or verdicts. All output passes zod and
the engine compiler, then human review.
