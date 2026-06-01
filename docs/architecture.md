# Architecture

`market-bot` is a Bun + TypeScript CLI that produces sourced research views and scores its own predictions. See [CONTEXT.md](../CONTEXT.md) for domain terms.

## Layout

```
src/
  app.ts              CLI glue (dispatches by jobType)
  cli/args.ts         Argument parsing
  config.ts           Env-driven AppConfig
  config/runs.ts      Typed per-run-type config (model, sampling knobs, depth profile)
  domain/             Instrument, AssetClass, Depth, Prediction, ResearchReport
  forecast/           Observable forecast contract: parser, expression shape, resolver
  model/              OpenAI / OpenAI-compatible / Codex providers
  movers/             Deterministic mover ranking
  report/             Report schema (zod) + markdown renderer
  research/           Orchestrator, prompt loader, regime summary
  scoring/            Score pass, Observation fetching, close cache, calibration aggregator
  sources/            Provider modules, normalized source adapters, collector with retry/backoff/cache
prompts/              Stage prompt files (base.md + optional combo overrides)
tests/                Bun test suites
docs/adr/             Architecture decision records
plans/                Curated planning docs (humans only)
data/                 Run artifacts and calibration output (gitignored)
```

Keep files cohesive — soft target 200–400 lines, hard limit 800.

## Subsystems

### Sources (`src/sources/`)

External fetching only. Retry, backoff, per-host rate limiting, and circuit breaking live at the collector/cache seam. Respect `MARKET_BOT_SOURCE_TIMEOUT_MS`. Mock at this seam in tests, not at `fetch`.

Notable inputs:
- Equity movers: Yahoo `day_gainers`
- Crypto movers: CoinGecko 24h change
- Supplemental equity market evidence: Massive stock snapshots for already-selected Yahoo symbols when `MARKET_BOT_MASSIVE_API_KEY` is set
- Market Context: FRED macro series for daily and weekly market updates
- News: MarketAux, Finnhub, Yahoo Finance search, and optional Massive equity news
- Observations for scoring: Yahoo closes (equities), CoinGecko closes (crypto), FRED macro values, and Tradier IV values

A file-based cache (`data/cache/<YYYY-MM-DD>/<sha256-of-v2-canonical-request>.json`) wraps all `fetchJsonOrGap` calls. The cache key includes the adapter plus a canonicalized provider request: protocol/host/path are normalized, query params are sorted, and credential-only params such as API tokens are stripped while request-shaping params remain. Same-day equivalent requests across daily, weekly, and ticker runs return cached payloads without hitting the network. If a live fetch fails and a cached entry exists within `MARKET_BOT_CACHE_FALLBACK_DAYS` (default 7), that entry is returned and a `SourceGap` is emitted disclosing the staleness. Cache entries store the hash key, not the full request URL.

Source providers are listed in `src/sources/providers.ts`. Each provider module exposes optional capabilities for primary market data, supplemental market data, news, Extended Evidence, Market Context, and future scoring Observation inputs. The registry composes those capabilities by asset class instead of hard-coding provider logic into one collector.

New Source Provider work should follow the [Source Provider Contract](./source-provider-contract.md).

News collection fans out to enabled providers, skips missing MarketAux/Finnhub tokens with `SourceGap`s, silently skips missing Massive keys, always includes Yahoo, canonicalizes URLs, collapses exact canonical-URL duplicates into one `Source`, and preserves provider aliases on the normalized source. A persistent seen-news index (`data/news-seen.json` by default, overridable with `MARKET_BOT_NEWS_SEEN_PATH`) suppresses exact canonical-URL repeats within the same research lane for 30 days. The index is updated only after a report is successfully persisted; if every news item is a repeat, one repeat fallback is kept and disclosed as a `SourceGap`.

Massive, formerly Polygon.io, is supplemental-only. When configured, it uses `api.massive.com` to collect equity news and stock snapshots for the symbols already selected by Yahoo. Those snapshots are persisted as supplemental market snapshots, included as report Sources, and included in prompt evidence. They do not enter mover ranking, market regime summaries, crypto workflows, or scoring Observations.

Market updates collect FRED Market Context when `MARKET_BOT_FRED_API_KEY` is set. Missing or failed FRED context is disclosed as a `SourceGap` but does not cap Evidence Quality. Weekly updates use the same mover inputs as daily — this is a cadence and horizon change, not a separate data product. Reports must disclose it as a source gap.

### Research (`src/research/`)

The orchestrator coordinates: collect sources → summarize regime → produce report → emit predictions. It is also the home for the deterministic market-regime summary.

### Predictions and scoring (`src/scoring/`, `src/forecast/`)

- `src/forecast/observable.ts` — the shared contract: `measurableAs` parser, expression shape, validation rules, and resolution against Observations. Adding a new prediction shape starts here.
- `src/scoring/observations.ts` — report-scoped Observation repository for point and window reads. Crypto scoring resolves CoinGecko IDs from Instrument Identity when present, with BTC/ETH fallback.
- `src/scoring/resolver.ts` — resolves a due prediction against Observations
- `src/scoring/index.ts` — `runScorePass` writes `score.json` per run
- `src/scoring/close-cache.ts` — caches successful historical-close fetches under `data/cache/closes/`
- `src/scoring/calibration.ts` + `calibration-markdown.ts` — aggregate scored predictions sliced by cadence (daily / weekly / ticker) into `data/calibration/`

Close-based predictions use provider-returned sessions: origin is the first available close at or after the report date, and horizon is the Nth available close after origin. Volatility predictions evaluate the full close window. Macro and IV predictions remain point-based.

Every research run triggers a score pass and calibration refresh as a **non-blocking** side effect. Failures there log to stderr; they must not abort the research job.

Adding a new prediction shape means updating: the parser in `forecast/observable.ts`, resolver, report schema, markdown renderer, and tests. All four.

### Report (`src/report/`)

Schema is the contract. Validation enforces the research-only boundary ([ADR 0001](./adr/0001-research-only-boundary.md)) and the observable-prediction rule ([ADR 0004](./adr/0004-predictions-as-observable-forecasts.md)).

## Data flow

```
CLI args → AppConfig → collect sources → orchestrator
                                      ├─ regime summary
                                      ├─ movers
                                      └─ predictions
                                              ↓
                                       report (zod-validated)
                                              ↓
                                  artifacts written to data/runs/<id>/
                                              ↓
                              score pass + calibration (side effect)
```

`score` and `calibration` CLI verbs invoke the last stage directly without a new research run. `cache prune` removes raw cache entries older than 30 days and scorer close-cache entries older than 365 days.
