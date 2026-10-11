# infra

Local and demo infrastructure (`docker-compose.yml`). **Not needed for development:** `pnpm dev:server` uses embedded PGlite.

| Service | Image (indicative) | Port | Purpose |
|---|---|---|---|
| postgres | `postgis/postgis:16-3.4` | 5432 | Primary DB |
| minio | `minio/minio` | 9000/9001 | Evidence photos (S3 API) |
| ollama | `ollama/ollama` | 11434 | Self-hosted open-weight LLM (OpenAI-compatible) |
| api | built from `apps/server` | 3000 | REST API |
| worker | built from `apps/server` | n/a | pg-boss jobs |

Also planned: `models/profiles.json` (model profiles and the on-device model manifest) and
`tiles/` (PMTiles extract for the demo region; region not chosen yet).

Secrets go in `.env` (never committed). Commit `.env.example` only.
