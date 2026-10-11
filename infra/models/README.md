# Models

Server (self-hosted, OpenAI-compatible):

```bash
ollama pull qwen3:4b        # or qwen3:8b on a 16 GB+ machine
LLM_MODEL=qwen3:4b pnpm dev:server
```

Any OpenAI-compatible runtime works (llama.cpp `llama-server`, vLLM, LM Studio): set `LLM_BASE_URL`.

On-device (optional, ADR-010): GGUF files listed in `packages/ai/src/models.ts`, downloaded in the app
(Profile → AI model) into the app sandbox. Never commit `.gguf` files.

Benchmark before switching models: `pnpm eval:ai` (see packages/ai/evals).
