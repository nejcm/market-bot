# Configuration

All configuration is via environment variables, resolved in [src/config.ts](../src/config.ts). Add new knobs there with a default and a guard (positive integer, enum, etc.), then update this table in the same change.

| Variable | Default | Notes |
| --- | --- | --- |
| `OPENAI_API_KEY` / `MARKET_BOT_OPENAI_API_KEY` | — | Required when provider is `openai`. `openai-compatible` only reads `MARKET_BOT_OPENAI_API_KEY` so a global OpenAI key is not sent to custom endpoints. Not needed for `codex` or `anthropic`. |
| `ANTHROPIC_API_KEY` / `MARKET_BOT_ANTHROPIC_API_KEY` | — | Required when provider is `anthropic`. Not used by other providers. |
| `MARKET_BOT_PROVIDER` | `openai` | `openai`, `openai-compatible`, `codex`, or `anthropic`. |
| `MARKET_BOT_BASE_URL` | — | Required when provider is `openai-compatible`; rejected otherwise. Must be `https`, except `http` is allowed for localhost. Credentials in the URL are rejected. |
| `MARKET_BOT_QUICK_MODEL` | `gpt-5.4-mini`; `claude-sonnet-4-6` for `anthropic` | Used for brief depth (all providers). Do not set below `gpt-5.4` for OpenAI/Codex. |
| `MARKET_BOT_SYNTHESIS_MODEL` | `gpt-5.5`; `claude-opus-4-8` for `anthropic` | Used for `--deep` (all providers). Do not set below `gpt-5.4` for OpenAI/Codex. |
| `MARKET_BOT_REASONING_EFFORT` | — | Optional shared reasoning-effort hint: `low`, `medium`, or `high`. Unset omits provider-specific effort parameters. Run-specific `modelParams` override this default. Honored by OpenAI, Codex, and Anthropic; OpenAI-compatible endpoints may ignore or reject it. |
| `MARKET_BOT_CODEX_QUICK_MODEL` | — | Overrides `MARKET_BOT_QUICK_MODEL` for the `codex` provider only. |
| `MARKET_BOT_CODEX_SYNTHESIS_MODEL` | — | Overrides `MARKET_BOT_SYNTHESIS_MODEL` for the `codex` provider only. |
| `MARKET_BOT_MODEL_TIMEOUT_MS` | `120000` | Max ms to wait for a model response before aborting. |
| `MARKET_BOT_DATA_DIR` | `data/runs` | Where run artifacts are written. Provider-health expects this run-artifact directory and reads sibling outputs such as `../calibration/summary.json`. |
| `MARKET_BOT_CONSOLE_PORT` | `4173` | Localhost port for the Research Console App web server. |
| `MARKET_BOT_PROMPT_DIR` | `prompts/` (repo root) | Directory containing `<stage>/base.md` prompt files. Override to point at a custom prompt tree without editing source code. |
| `MARKET_BOT_EQUITY_MOVER_LIMIT` | `5` | Movers per equity update. |
| `MARKET_BOT_CRYPTO_MOVER_LIMIT` | `5` | Movers per crypto update. |
| `MARKET_BOT_NEWS_LIMIT` | `8` | Final combined news-source cap per run. Providers request or keep up to this limit before dedupe and round-robin selection; Finnhub is capped after fetch because its news endpoints do not expose a count limit. |
| `MARKET_BOT_NEWS_SEEN_PATH` | Derived from `MARKET_BOT_DATA_DIR` | Persistent seen-news index. Defaults to `data/news-seen.json` for `data/runs`; if `MARKET_BOT_DATA_DIR` does not end in `runs`, defaults inside that directory. |
| `MARKET_BOT_NEWS_SEEN_RETENTION_DAYS` | `30` | Days to suppress exact canonical-URL news repeats within the same research lane. |
| `MARKET_BOT_SOURCE_TIMEOUT_MS` | `15000` | Per-source fetch timeout. |
| `MARKET_BOT_APEWISDOM_FILTER` | `all-stocks` | ApeWisdom filter for alpha-search discovery. Filter names may contain letters, numbers, and hyphens. |
| `MARKET_BOT_APEWISDOM_BRIEF_PAGE_LIMIT` | `5` | ApeWisdom pages to fetch for brief alpha-search discovery. |
| `MARKET_BOT_APEWISDOM_DEEP_PAGE_LIMIT` | `10` | ApeWisdom pages to fetch for deep alpha-search discovery. |
| `MARKET_BOT_ALPHA_SEARCH_VALIDATION_LIMIT` | `25` | Number of ranked alpha-search candidates to validate with Yahoo. |
| `MARKET_BOT_ALPHA_SEARCH_LEAD_LIMIT` | `15` | Maximum Yahoo-validated Research Leads to show. |
| `MARKET_BOT_ALPHA_SEARCH_CANDIDATE_LIMIT` | `15` | Minimum number of ApeWisdom-ranked candidates to persist before Yahoo validation. |
| `MARKET_BOT_ALPHA_SEARCH_SEC_DISCOVERY_LIMIT` | `25` | Maximum SEC filing-discovered alpha-search candidates to consider after ApeWisdom ranking and before listed/Yahoo validation. |
| `MARKET_BOT_ALPHA_SEARCH_SEC_FORM_TYPES` | `S-1,F-1,8-K,6-K` | Comma-separated SEC current-filing form types used by alpha-search SEC discovery. |
| `MARKET_BOT_ALPHA_SEARCH_MIN_PRICE` | `0.50` | Minimum Yahoo regular-market price for alpha-search Research Leads. |
| `MARKET_BOT_ALPHA_SEARCH_MIN_VOLUME` | `100000` | Minimum Yahoo regular-market volume for alpha-search Research Leads. |
| `MARKET_BOT_ALPHA_SEARCH_MIN_MARKET_CAP` | `50000000` | Minimum Yahoo market cap for alpha-search Research Leads. |
| `MARKET_BOT_ALPHA_SEARCH_MAX_MARKET_CAP` | `10000000000` | Maximum Yahoo market cap for alpha-search Research Leads. Must be greater than or equal to the minimum. |
| `MARKET_BOT_EVIDENCE_REQUEST_MAX_ROUNDS` | `2` | Max evidence-request model rounds for `ticker --deep --asset equity`. Set to `0` to disable the loop. |
| `MARKET_BOT_EVIDENCE_REQUEST_MAX_TOOL_CALLS` | `2` | Max accepted evidence tool executions per eligible run. Set to `0` to disable the loop. |
| `MARKET_BOT_EVIDENCE_REQUEST_SOURCE_BUDGET` | `8` | Max declared source units per eligible run. SEC latest filing costs 3 units; Tradier IV term structure costs 5. Set to `0` to disable the loop. |
| `MARKET_BOT_MARKET_SPOTLIGHT_BRIEF_LIMIT` | `2` | Max AI-selected Market Spotlights for brief daily/weekly market updates. Set `0` to disable spotlights. |
| `MARKET_BOT_MARKET_SPOTLIGHT_DEEP_LIMIT` | `4` | Max AI-selected Market Spotlights for deep daily/weekly market updates. Set `0` to disable spotlights. |
| `MARKET_BOT_HISTORY_TICKER_RECENT_LIMIT` | `3` | Recent same-symbol ticker artifacts to include in ticker historical context. |
| `MARKET_BOT_HISTORY_MARKET_RECENT_LIMIT` | `5` | Recent daily/weekly market-update artifacts to include in market historical context. |
| `MARKET_BOT_HISTORY_RECENT_DAYS` | `90` | Lookback window for recent historical run artifacts. |
| `MARKET_BOT_HISTORY_ANCHOR_MONTHS` | `3,6,12` | Comma-separated month anchors used to pick older historical run artifacts. |
| `MARKET_BOT_MARKETAUX_API_TOKEN` | — | Enables MarketAux news. Missing tokens emit a `SourceGap`; Yahoo news still runs. |
| `MARKET_BOT_FINNHUB_API_TOKEN` | — | Enables Finnhub news. Missing tokens emit a `SourceGap`; Yahoo news still runs. |
| `MARKET_BOT_FRED_API_KEY` | — | Baseline free provider. Enables FRED Market Context for market updates, FRED macro Extended Evidence for ticker runs, and FRED forecast scoring. Missing token emits FRED `SourceGap`s without aborting research, but provider-health v2 treats missing or failed FRED coverage as a validation failure. |
| `MARKET_BOT_TRADIER_API_TOKEN` | — | Optional equity options/IV provider. Enables Tradier options/IV Extended Evidence and IV forecast scoring. Free/delayed access depends on Tradier account/API access. Missing token, account limits, or unsupported international coverage emit expected provider coverage gaps. |
| `MARKET_BOT_GLASSNODE_API_KEY` | — | Optional paid crypto on-chain provider. Glassnode API access requires a paid/API-add-on plan. Missing token emits ticker `SourceGap`s for on-chain evidence. |
| `MARKET_BOT_MASSIVE_API_KEY` / `MARKET_BOT_POLYGON_API_KEY` | — | Enables Massive, formerly Polygon.io, as a supplemental equity source provider using `api.massive.com`. `MARKET_BOT_POLYGON_API_KEY` is accepted as a legacy alias. Missing key silently disables Massive. When set, failed Massive requests emit `SourceGap`s. Massive contributes equity news and supplemental equity market snapshots. When set and Yahoo equity quote/chart routes fail after retries, Massive also serves as an opportunistic fallback for quotes, benchmarks, alpha-search validation, and scoring closes. Massive does not affect mover ranking, market regime labels, crypto, or replace Yahoo screeners/news. |
| `MARKET_BOT_SEC_USER_AGENT` | `market-bot research contact@example.invalid` | Recommended free provider. User-Agent sent to SEC EDGAR. Set to an app name plus real contact email for live SEC access. SEC coverage is US-centric; unsupported international ticker coverage is an expected provider coverage gap. |
| `MARKET_BOT_CACHE_DIR` | `data/cache` | Directory for raw-source cache entries and scorer close cache entries. Raw-source cache keys are v2 canonical request hashes; request URLs and credential query params are not persisted. |
| `MARKET_BOT_CACHE_DISABLE` | `false` | Set to `1` or `true` to bypass cache reads and writes entirely. |
| `MARKET_BOT_CACHE_FALLBACK_DAYS` | `7` | How many days back to look for a stale cached payload when a live fetch fails. A stale hit emits a `SourceGap` disclosing the staleness. Yahoo market-data adapters use a shorter effective window of 2 days. |

Cache pruning is manual: `market-bot cache prune` removes raw cache day directories older than 30 days and scorer close cache files older than 365 days.

Historical Research Context reads only `MARKET_BOT_DATA_DIR` run artifacts. The history env vars control how many prior reports are summarized and which older anchor runs are considered; they do not make the reader scan `MARKET_BOT_CACHE_DIR`. Market Spotlight limits cap AI-selected spotlights for daily and weekly updates. Setting a spotlight limit to `0` disables the selector for that depth.

## Free provider setup

For a free, high-value Extended Evidence setup, set `MARKET_BOT_FRED_API_KEY` and `MARKET_BOT_SEC_USER_AGENT`. FRED is also the provider-health v2 baseline macro expectation. Add `MARKET_BOT_TRADIER_API_TOKEN` only when you need equity options/IV evidence and have suitable Tradier API access. Leave `MARKET_BOT_GLASSNODE_API_KEY` blank unless you already pay for Glassnode API access.

## Secrets

Never commit secrets or fixtures containing tokens. Required keys are read from the environment at startup; the process exits with a clear error if missing.
