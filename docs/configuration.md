# Configuration

All configuration is via environment variables, resolved in [src/config.ts](../src/config.ts). Add new knobs there with a default and a guard (positive integer, enum, etc.), then update this table in the same change.

| Variable | Default | Notes |
| --- | --- | --- |
| `OPENAI_API_KEY` / `MARKET_BOT_OPENAI_API_KEY` | — | Required when provider is `openai` or `openai-compatible`. Not needed for `codex`. |
| `MARKET_BOT_PROVIDER` | `openai` | `openai`, `openai-compatible`, or `codex`. |
| `MARKET_BOT_BASE_URL` | — | Required when provider is `openai-compatible`. |
| `MARKET_BOT_QUICK_MODEL` | `gpt-5.4-mini` | Used for brief depth (all providers). Do not set below `gpt-5.4`. |
| `MARKET_BOT_SYNTHESIS_MODEL` | `gpt-5.5` | Used for `--deep` (all providers). Do not set below `gpt-5.4`. |
| `MARKET_BOT_CODEX_QUICK_MODEL` | — | Overrides `MARKET_BOT_QUICK_MODEL` for the `codex` provider only. |
| `MARKET_BOT_CODEX_SYNTHESIS_MODEL` | — | Overrides `MARKET_BOT_SYNTHESIS_MODEL` for the `codex` provider only. |
| `MARKET_BOT_MODEL_TIMEOUT_MS` | `120000` | Max ms to wait for a model response before aborting. |
| `MARKET_BOT_DATA_DIR` | `data/runs` | Where run artifacts are written. |
| `MARKET_BOT_EQUITY_MOVER_LIMIT` | `5` | Movers per equity update. |
| `MARKET_BOT_CRYPTO_MOVER_LIMIT` | `5` | Movers per crypto update. |
| `MARKET_BOT_NEWS_LIMIT` | `8` | News items per run. |
| `MARKET_BOT_SOURCE_TIMEOUT_MS` | `15000` | Per-source fetch timeout. |
| `MARKET_BOT_CACHE_DIR` | `data/cache` | Directory for the raw-source cache. One JSON file per URL+date. |
| `MARKET_BOT_CACHE_DISABLE` | `false` | Set to `1` or `true` to bypass cache reads and writes entirely. |
| `MARKET_BOT_CACHE_FALLBACK_DAYS` | `7` | How many days back to look for a stale cached payload when a live fetch fails. A stale hit emits a `SourceGap` disclosing the staleness. |

## Secrets

Never commit secrets or fixtures containing tokens. Required keys are read from the environment at startup; the process exits with a clear error if missing.
