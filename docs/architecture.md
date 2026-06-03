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
  alpha-search/       Equity lead discovery, listed-universe filtering, validation
  research/           Orchestrator, prompt loader, Domain Playbooks, regime summary
  scoring/            Score pass, Observation fetching, close cache, calibration aggregator
  sources/            Provider modules, normalized source adapters, collector with retry/backoff/cache
prompts/              Stage prompt files and checked-in Domain Playbooks
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
- Evidence Request tools: SEC latest periodic filing text and Tradier IV term structure for eligible deep equity ticker runs
- News: MarketAux, Finnhub, Yahoo Finance search, and optional Massive equity news
- Observations for scoring: Yahoo closes (equities), CoinGecko closes (crypto), FRED macro values, and Tradier IV values

A file-based cache (`data/cache/<YYYY-MM-DD>/<sha256-of-v2-canonical-request>.json`) wraps all `fetchJsonOrGap` and `fetchTextOrGap` calls. The cache key includes the adapter plus a canonicalized provider request: protocol/host/path are normalized, query params are sorted, and credential-only params such as API tokens are stripped while request-shaping params remain. Same-day equivalent requests across daily, weekly, ticker, and evidence-request runs return cached payloads without hitting the network. If a live fetch fails and a cached entry exists within `MARKET_BOT_CACHE_FALLBACK_DAYS` (default 7), that entry is returned and a `SourceGap` is emitted disclosing the staleness. Cache entries store the hash key, not the full request URL.

Source providers are listed in `src/sources/providers.ts`. Each provider module exposes optional capabilities for primary market data, supplemental market data, news, Extended Evidence, Market Context, and future scoring Observation inputs. The registry composes those capabilities by asset class instead of hard-coding provider logic into one collector.

New Source Provider work should follow the [Source Provider Contract](./source-provider-contract.md).

News collection fans out to enabled providers, skips missing MarketAux/Finnhub tokens with `SourceGap`s, silently skips missing Massive keys, always includes Yahoo, canonicalizes URLs, collapses exact canonical-URL duplicates into one `Source`, and preserves provider aliases on the normalized source. A persistent seen-news index (`data/news-seen.json` by default, overridable with `MARKET_BOT_NEWS_SEEN_PATH`) suppresses exact canonical-URL repeats within the same research lane for 30 days. The index is updated only after a report is successfully persisted; if every news item is a repeat, one repeat fallback is kept and disclosed as a `SourceGap`.

### Alpha Search (`src/alpha-search/`)

`alpha-search --asset equity [--deep]` is an equity lead discovery workflow. It fetches social-momentum pages from the ApeWisdom API, ranks candidates with a deterministic social momentum score, then runs SEC current-filing discovery for configured catalyst forms (`S-1,F-1,8-K,6-K` by default). SEC candidates are mapped to tickers through official SEC `company_tickers.json`. ApeWisdom runs first; SEC runs second. Candidates are deduped by symbol so ApeWisdom-backed rows keep social evidence while SEC evidence enriches the same symbol.

Before Yahoo validation, alpha-search filters candidates through official listed-symbol data from Nasdaq Trader `nasdaqlisted.txt` / `otherlisted.txt` and Cboe listed-symbol CSV. The filter rejects not-found, ETF/fund, inactive, and test-issue rows with deterministic reasons. Yahoo remains final validation for stock-only, non-OTC status, price, volume, and market-cap band. Defaults target listed small/mid-cap discovery (`$0.50+`, `100k+` volume, `$50M-$10B` market cap). Alpha-search reports have `jobType: "alpha-search"`, no predictions, and no scoring or calibration side effects. Valid candidates are emitted as Research Leads. Rejected candidates are listed separately with discovery sources, rejection reason, and source IDs.

Massive, formerly Polygon.io, is supplemental-only. When configured, it uses `api.massive.com` to collect equity news and stock snapshots for the symbols already selected by Yahoo. Those snapshots are persisted as supplemental market snapshots, included as report Sources, and included in prompt evidence. They do not enter mover ranking, market regime summaries, crypto workflows, or scoring Observations.

Market updates collect FRED Market Context when `MARKET_BOT_FRED_API_KEY` is set. Missing or failed FRED context is disclosed as a `SourceGap` but does not cap Evidence Quality. Weekly updates use the same mover inputs as daily — this is a cadence and horizon change, not a separate data product. Reports must disclose it as a source gap.

### Research (`src/research/`)

The orchestrator coordinates: collect sources → summarize regime → optional Evidence Request Loop → select Domain Playbooks → produce report → emit predictions. It is also the home for the deterministic market-regime summary.

The Evidence Request Loop runs only for `ticker --deep --asset equity` when its three env limits are nonzero. It uses the quick model and the `evidence-request` prompt stage to ask for JSON requests, validates them against enumerated public-data tools (`sec_latest_filing`, `tradier_iv_term_structure`), enforces per-run round/tool/source-unit budgets, executes tools through the same source collector seam, and merges outputs into normal Extended Evidence, Sources, raw snapshots, and `SourceGap`s before `specialist-analysis`. Malformed JSON emits a `SourceGap`, stops the loop, and continues to `specialist-analysis`. It does not use provider-native tool calling and does not add report schema fields.

Domain Playbooks are checked-in markdown guidance snippets under `prompts/playbooks/`, registered by `prompts/playbooks/registry.json` ([ADR 0012](./adr/0012-model-requested-domain-playbooks.md)). After the Evidence Request Loop, the quick model runs the `playbook-selection` stage against slim run context and eligible candidate metadata. Valid selections are loaded into downstream prompt JSON as `domainPlaybooks`; invalid JSON, unknown IDs, invalid stages, duplicates, and cap overages are trace-only rejections. The selector does not fetch sources, use provider-native tools, or add report schema fields.

Deep runs use a fixed Coverage Panel after `specialist-analysis` and before `critique` ([ADR 0011](./adr/0011-fixed-coverage-panel-for-deep-research.md)). Market updates run `regime-context-analysis` and `mover-theme-analysis`; ticker runs run `instrument-evidence-analysis` and `market-behavior-analysis`. The two role stages use the quick model, see the specialist output as their only prior stage, run concurrently, and are persisted in deterministic stage order. `critique` sees the specialist plus both role outputs, and `final-synthesis` sees all analyses plus critique. The panel does not add report schema fields.

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
                                      ├─ optional evidence-request loop
                                      ├─ playbook selection
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
