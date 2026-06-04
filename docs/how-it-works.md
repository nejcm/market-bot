# How It Works

`market-bot` is a Bun + TypeScript CLI that turns public market data and news into sourced research artifacts. It does not produce trading advice, execution instructions, position sizing, or portfolio actions.

## End-to-end flow

```text
CLI args
  -> config from environment
  -> source collection
  -> deterministic context
  -> playbook selection
  -> model stages
  -> report validation
  -> artifact writing
  -> score pass + calibration refresh
```

`alpha-search --asset equity [--deep]` uses a separate deterministic discovery path:

```text
CLI args
  -> config from environment
  -> ApeWisdom social-momentum pages
  -> social momentum ranking
  -> SEC current-filing discovery
  -> official listed-universe filtering
  -> Yahoo candidate validation
  -> alpha-search report validation
  -> candidate profile artifact
  -> artifact writing
```

1. `src/cli.ts` passes command-line arguments to `runCli`.
2. `src/app.ts` parses the command, resolves configuration, and dispatches the workflow.
3. Research commands collect sources, build the configured model provider, run the research job, and persist artifacts.
4. `alpha-search` collects ApeWisdom social-momentum candidates, ranks equity candidates, adds SEC current-filing candidates, filters candidates through official listed-symbol metadata, Yahoo-validates eligible rows against the stock-only small-cap screen, and writes Research Leads, deterministic candidate profiles, and rejected candidates without predictions.
5. `score` and `calibration` commands skip research generation and operate on existing run artifacts.
6. `cache prune` removes old cache entries without generating research.
7. Daily, weekly, and ticker research commands also run scoring and calibration as non-blocking side effects before generating the new report. If scoring or calibration fails, the CLI logs the error and continues the research run.

## Commands

Run commands directly with Bun:

```sh
bun run src/cli.ts daily --asset equity
bun run src/cli.ts daily --asset crypto
bun run src/cli.ts weekly --asset equity
bun run src/cli.ts weekly --asset crypto
bun run src/cli.ts ticker AAPL --asset equity
bun run src/cli.ts ticker BTC --asset crypto
bun run src/cli.ts alpha-search --asset equity
bun run src/cli.ts score
bun run src/cli.ts calibration
bun run src/cli.ts cache prune
bun run src/cli.ts provider-health
```

If installed as a binary, the same verbs are available through `market-bot`:

```sh
market-bot daily --asset equity
market-bot weekly --asset crypto --deep
market-bot ticker AAPL --asset equity --deep
market-bot alpha-search --asset equity --deep
market-bot score
market-bot calibration
market-bot cache prune
market-bot provider-health
```

Command behavior:

| Command | What it does |
| --- | --- |
| `daily --asset equity\|crypto` | Creates a daily market update for one asset class. |
| `weekly --asset equity\|crypto` | Creates a weekly market update. Weekly changes the cadence and prediction horizon, but current mover inputs still come from daily-style source payloads and are disclosed as source gaps. |
| `ticker <symbol> --asset equity\|crypto` | Creates a single-instrument research view. Symbols are normalized to uppercase and must match the instrument validator. |
| `alpha-search --asset equity` | Runs ApeWisdom social discovery plus SEC current-filing discovery, filters candidates through official listed-symbol metadata, validates eligible candidates with Yahoo as listed stocks inside the configured price, volume, and market-cap screen, and emits Research Leads plus rejected candidates with no predictions or scoring/calibration side effects. |
| `--deep` | Uses the deep profile: more findings, scenarios, predictions, and fixed coverage-panel stages, with the synthesis model for the final pass. |
| `score` | Resolves due predictions in previous runs and writes `score.json` files. |
| `calibration` | Rebuilds aggregate calibration outputs from existing resolved scores. |
| `cache prune` | Removes raw cache day directories older than 30 days and scorer close-cache files older than 365 days. |
| `provider-health` | Reads persisted run artifacts and writes provider-health contract v2 to `data/provider-health/summary.json` plus `summary.md`, including a `pass`/`warn`/`fail` validation verdict, required coverage checklist, and provider gap classifications by route. |

Provider-health v2 expects coverage for daily and weekly equity/crypto updates, equity and crypto ticker runs, a deep equity ticker run, and at least one international equity ticker smoke run. Blocking gaps include missing required run shapes, missing usable news for a validation lane, FRED baseline gaps, Yahoo primary equity market-data/auth failures, CoinGecko primary crypto market-data failures, and missing due scoring passes. Expected gaps produce a `warn` verdict; this includes Massive supplemental failures, Tradier/Glassnode account limits, individual MarketAux/Finnhub news gaps when another usable news source exists, and US-centric unsupported coverage for international equities. Informational gaps are disclosed without changing a `pass` verdict.

## Setup and development commands

```sh
bun install
bunx lefthook install
bun test
bun run typecheck
bun run lint
bun run fmt
bun run fmt:check
bun run knip
bun run audit
bun run check
```

`bun run check` is the local definition of done: lint, format check, typecheck, and tests.

## Research Console App

The local Research Console App browses existing artifacts without changing the research-only
boundary. Build the Svelte client, then start the localhost Bun server:

```sh
bun run console:build
bun run console
```

The server binds to `127.0.0.1` and reads `MARKET_BOT_DATA_DIR` / `data/runs`.
The Jobs view queues allowlisted CLI verbs one at a time and shows basic status plus captured output.
The Search view scans existing `report.json` artifacts for structured report sections and filters by symbol, asset class, job type, and date range.

## Configuration

Configuration is read in `src/config.ts` from environment variables. Live model calls require the key for the selected provider, unless using the `codex` subscription provider.

Useful knobs:

| Variable | Purpose |
| --- | --- |
| `MARKET_BOT_PROVIDER` | `openai`, `openai-compatible`, `codex`, or `anthropic`. |
| `MARKET_BOT_BASE_URL` | Required for `openai-compatible`. |
| `MARKET_BOT_QUICK_MODEL` | Model for playbook-selection, specialist, coverage-panel, and critique stages. |
| `MARKET_BOT_SYNTHESIS_MODEL` | Model for final synthesis and `--deep` output. |
| `MARKET_BOT_REASONING_EFFORT` | Optional `low`, `medium`, or `high` reasoning-effort hint. |
| `MARKET_BOT_DATA_DIR` | Run artifact directory, default `data/runs`. |
| `MARKET_BOT_CACHE_DIR` | Raw source cache directory, default `data/cache`. |
| `MARKET_BOT_CACHE_DISABLE` | Set `1` or `true` to bypass cache. |
| `MARKET_BOT_CACHE_FALLBACK_DAYS` | Stale cache fallback window after live fetch failure. |
| `MARKET_BOT_MARKETAUX_API_TOKEN` | Enables MarketAux news. |
| `MARKET_BOT_FINNHUB_API_TOKEN` | Enables Finnhub news. |
| `MARKET_BOT_MASSIVE_API_KEY` / `MARKET_BOT_POLYGON_API_KEY` | Enables supplemental Massive equity snapshots and news. `MARKET_BOT_POLYGON_API_KEY` is a legacy alias. |

See [configuration.md](./configuration.md) for the full table.

## Source collection

Source collection lives in `src/sources/collector.ts`.

The collector fetches market data and news in parallel:

| Asset class | Market data | News |
| --- | --- | --- |
| `equity` | Yahoo Finance predefined `day_gainers` screener for market updates; Yahoo quote endpoint for regime proxies and ticker runs. Optional Massive snapshots supplement the Yahoo-selected symbols. | MarketAux, Finnhub company news for ticker runs, Yahoo Finance search, and optional Massive equity news. |
| `crypto` | CoinGecko markets endpoint. Market updates request enough rows to rank movers; ticker runs fetch a larger universe and filter by symbol. | MarketAux, Finnhub crypto market news, and Yahoo Finance search. |

Equity regime context uses `SPY`, `QQQ`, `IWM`, `DIA`, and `^VIX`. Crypto regime context uses major proxies such as `BTC` and `ETH`.

Daily and weekly market updates also collect Market Context from FRED when `MARKET_BOT_FRED_API_KEY` is set. Market Context is market-level evidence, not ticker Extended Evidence. It is sent to model prompts, saved in `report.json` extras, persisted as `normalized/market-context.json`, and included in `report.sources` so findings and macro predictions can cite it. Missing FRED credentials or fetch failures are disclosed as `SourceGap`s and do not abort research, but provider-health v2 treats them as validation failures because FRED is baseline-required.

Massive, formerly Polygon.io, is a Supplemental Source Provider. `MARKET_BOT_MASSIVE_API_KEY` enables requests to `api.massive.com` for equity news and stock snapshots; `MARKET_BOT_POLYGON_API_KEY` is accepted as a legacy alias. Missing keys silently disable Massive. When the key is set and a Massive request fails, the failure is recorded as a `SourceGap`. Massive is equity-only in this version: it does not run for crypto, does not replace Yahoo, does not affect mover ranking or market regime, and does not create scoring Observations. Supplemental snapshots are saved as `normalized/supplemental-market-snapshots.json`, included in prompt evidence, and attached as citeable report Sources.

Ticker runs also collect Extended Evidence:

| Asset class | Extended Evidence |
| --- | --- |
| `equity` | SEC/EDGAR recent filings and Fundamental Evidence from company facts, Finnhub earnings/dividends/splits, FRED macro observations, and Tradier options IV. |
| `crypto` | FRED macro observations and Glassnode on-chain metrics. |

Extended Evidence is not collected for daily or weekly market updates. Missing optional provider credentials are reported as `SourceGap`s instead of failing the run.
SEC/EDGAR Fundamental Evidence uses curated operating basics and comparable prior-year deltas when SEC company facts expose matching periods; missing facts or non-comparable deltas are disclosed as `SourceGap`s.

Fetch behavior:

- All requests use `MARKET_BOT_SOURCE_TIMEOUT_MS`.
- Transient failures retry with backoff.
- Live fetches use a per-process, per-host limiter with one in-flight request and a 1000 ms minimum delay between starts.
- Repeated transient failures, provider usage-limit responses, and rate-limit responses open a circuit temporarily; open circuits emit `SourceGap`s.
- Failed sources become `SourceGap` entries instead of crashing the whole research run.
- `withCache` stores raw JSON by UTC date and a v2 canonical request hash that includes the adapter, strips credential-only query params, and keeps request-shaping params.
- Same-day equivalent provider requests can reuse cache across daily, weekly, and ticker runs; broader/narrower provider payloads are not derived from each other.
- If a live request fails and a recent cached entry exists, the cached payload is used and a stale-source gap is recorded.
- Missing MarketAux or Finnhub tokens are reported as `SourceGap`s. Yahoo news still runs.
- Missing Massive keys are silent because Massive is supplemental-only; configured Massive failures are reported as `SourceGap`s.
- Finnhub news is capped after normalization because the used Finnhub news endpoints do not expose a count-limit parameter.
- News is also checked against a persistent seen-news index at `data/news-seen.json` by default, or `MARKET_BOT_NEWS_SEEN_PATH` when set. Exact canonical-URL repeats are suppressed only within the same research lane for 30 days by default. The index is updated after report artifacts are written, so failed runs do not hide future news. If every news item is a repeat, one repeat fallback is kept and disclosed as a `SourceGap`.

## Normalization and adapters

The source registry in `src/sources/registry.ts` maps asset classes to adapters:

- `src/sources/yahoo.ts` normalizes Yahoo quote payloads and fetches equity closes for scoring.
- `src/sources/coingecko.ts` normalizes CoinGecko market payloads and fetches crypto closes for scoring.
- `src/sources/yahoo-news.ts` normalizes news search results into report sources.
- `src/sources/marketaux-news.ts`, `src/sources/finnhub-news.ts`, and `src/sources/multi-news.ts` collect multi-provider news, dedupe by canonical URL, suppress recently seen repeats, and preserve provider aliases.
- `src/sources/massive.ts` normalizes Massive stock snapshots and equity news from `api.massive.com`. Massive was formerly Polygon.io.
- `src/sources/market-context.ts` collects FRED macro Market Context for daily and weekly market updates.
- `src/sources/extended-evidence.ts` composes ticker-only Extended Evidence from separate provider files under `src/sources/extended-evidence/` for SEC/EDGAR, Finnhub events, FRED, Tradier IV, and Glassnode.
- `src/sources/providers.ts` lists Source Provider modules and their optional capabilities.
- `src/sources/fred.ts` and `src/sources/tradier.ts` support macro and IV scoring inputs.

Adapters convert external API payloads into internal `MarketSnapshot`, `Source`, and close-price records. Callers work with normalized shapes and source gaps, not raw provider-specific payloads.

New Source Provider work should follow the [Source Provider Contract](./source-provider-contract.md).

## Movers

Mover ranking lives in `src/movers/ranking.ts`.

The ranker:

- drops snapshots with invalid price, invalid percent change, or volume below `10_000`;
- computes a baseline score as `abs(changePercent24h) * log10(volume)`;
- adds Benchmark-Relative Mover Context for daily and weekly equity movers when Yahoo benchmark quotes are available. The context compares each Yahoo-selected mover against a sector ETF, or `SPY` when sector metadata is unavailable, and is citeable evidence rather than a ranking input;
- adds neutral-if-missing Mover Feature boosts for unusual volume and opening gap size when the source payload includes usable fields;
- caps unusual-volume boost at `0.25` and gap boost at `0.20`, then scores as `baseScore * (1 + unusualVolumeBoost + gapBoost)`;
- sorts by score descending, then symbol ascending;
- assigns 1-based ranks after slicing to the configured limit;
- includes the score components and short deterministic reasons in the model evidence payload.

Weekly reports currently reuse the same underlying mover inputs as daily reports. The report records that limitation in `dataGaps`.

## Market regime

The deterministic regime summary lives in `src/research/regime.ts`.

For equities, the app checks breadth across `SPY`, `QQQ`, `IWM`, and `DIA`, then forces `risk-off` when `^VIX` is at or above the elevated threshold. For crypto, it checks breadth across major crypto proxies. FRED Market Context can add macro drivers and source IDs, but it does not change the deterministic `risk-on` / `risk-off` / `mixed` label. The output includes:

- `label`: `risk-on`, `risk-off`, `mixed`, or `insufficient-data`;
- `proxyCount`;
- human-readable drivers;
- source IDs used for the regime view.

This regime summary is sent to the model as context and stored in report extras.

## Research generation

Research orchestration lives in `src/research/orchestrator.ts`.

Each research run builds a depth profile:

| Mode | Effect |
| --- | --- |
| `brief` | Concise report with fewer minimum findings, scenarios, and predictions. |
| `deep` | Fuller report with higher minimum counts and broader focus areas. |

Brief runs use four model stages:

1. `playbook-selection`: chooses checked-in Domain Playbooks for eligible downstream stages.
2. `specialist-analysis`: extracts sourced thesis points, catalysts, risks, and gaps.
3. `critique`: challenges the specialist output using only supplied evidence.
4. `final-synthesis`: emits the final JSON report and predictions.

Deep runs keep `specialist-analysis` as the anchor, then run two fixed coverage-panel stages before critique:

- Market updates: `regime-context-analysis` and `mover-theme-analysis`.
- Tickers: `instrument-evidence-analysis` and `market-behavior-analysis`.

Each coverage-panel stage receives the specialist output as prior context. `critique` receives the specialist plus both role outputs, and `final-synthesis` receives all analyses plus critique. The panel broadens coverage without adding report schema fields.

Domain Playbooks live under `prompts/playbooks/` and are registered in `prompts/playbooks/registry.json`. After source collection and any Evidence Request Loop, the quick model runs `playbook-selection` once with slim run context: command, depth profile, planned stages, candidate metadata, market-regime label, evidence categories, and source-gap summaries. It may select up to two playbooks per stage and six per run. Valid selections are loaded into downstream prompt JSON as `domainPlaybooks`; invalid selector output is recorded in `trace.json` and the run continues without adding report data gaps.

The prompts require JSON-only output and supplied source IDs only. The final synthesis prompt also requires observable prediction expressions.

If the final output has too few valid predictions, the orchestrator reprompts final synthesis once with validation errors and the unmet minimum count.

## Predictions

Predictions are observable forecasts, not recommendations. Validation lives mainly in `src/forecast/observable.ts` and `src/report/schema.ts`.

Supported `measurableAs` forms:

```text
close(SUBJECT, +N) > close(SUBJECT, 0)
close(A, +N)/close(A, 0) > close(B, +N)/close(B, 0)
max(close(SUBJECT), 0..+N) > T
close(SUBJECT, +N) outside [Lo, Hi]
fred(SERIES, +N) > fred(SERIES, 0)
iv(SUBJECT, +N) > T
```

Prediction validation checks:

- required fields are present;
- `kind`, `subject`, and `horizonTradingDays` match the parsed expression;
- horizon is an integer from 1 to 20 trading days;
- probability is between 0 and 1;
- source IDs exist in the report source list;
- claim text does not include trade-action or reader-directed language.

Accepted predictions are canonicalized so the stored `measurableAs` matches the parser output.

## Report validation and rendering

`src/report/schema.ts` is the report contract. It enforces:

- `notFinancialAdvice: true`;
- `confidence` as `high`, `medium`, or `low`;
- source IDs on major findings, scenarios, bull case, bear case, risks, and catalysts;
- no trade-action language in report narrative.

`src/report/markdown.ts` renders the validated report into a readable `report.md` with summary, findings, cases, risks, catalysts, scenarios, predictions, data gaps, and sources.

## Artifacts

Artifacts are written under `MARKET_BOT_DATA_DIR`, default `data/runs`.

Each research run creates:

```text
data/runs/<run-id>/
  raw/snapshots.json
  normalized/market-snapshots.json
  normalized/market-context.json
  normalized/news-sources.json
  normalized/source-gaps.json
  normalized/sec-fundamentals.json  # alpha-search only
  normalized/sec-fundamentals-source-gaps.json  # alpha-search only
  normalized/candidate-profiles.json  # alpha-search only
  stages.json
  analytics.json
  report.json
  report.md
  trace.json
  score.json             # written later when predictions become due
  alpha-validation.json  # written later for alpha-search Research Leads
```

`runId` is based on the current ISO timestamp plus a short random suffix.

`trace.json` records command metadata, model names, stage names, source gaps, Domain Playbook selector audit metadata, token estimate, cost estimate, prediction retry reasons, and prediction validation errors when present. `analytics.json` records deterministic run counters for source funnels, news dedupe, evidence quality, prediction health, and run shape. `stages.json` includes the `playbook-selection` model output, so selector token and cost estimates are included in run totals.

## Scoring

Scoring lives in `src/scoring/index.ts`, `src/scoring/observations.ts`, and `src/scoring/resolver.ts`.

`score` scans every run directory:

1. Load `report.json`.
2. For prediction reports, skip predictions that are already resolved or have reached the max attempt count.
3. Check whether the prediction horizon has elapsed in trading days.
4. Fetch point or window Observations from Yahoo, CoinGecko, FRED, or Tradier.
5. For close-based predictions, use provider-returned sessions: origin is the first available close at or after the report date, and horizon is the Nth available close after origin.
6. Resolve each observable forecast as `hit`, `miss`, or unresolved.
7. Write or update `score.json`.
8. For alpha-search reports with Research Leads, backfill `normalized/candidate-profiles.json` if missing.
9. Validate 5- and 20-trading-day excess returns against `IWM` and write `alpha-validation.json`.
10. Rebuild Alpha validation summaries and candidate watchlist artifacts:

```text
data/alpha-validation/summary.json
data/alpha-validation/summary.md
data/alpha-search/feature-attribution.json
data/alpha-search/feature-attribution.md
data/alpha-search/watchlist.json
data/alpha-search/watchlist.md
```

The Alpha feature-attribution summary buckets deterministic candidate profile features, including available SEC Fundamental Evidence metrics, against Alpha validation outcomes. The Alpha candidate watchlist is rebuilt from per-run candidate profiles and validation sidecars. It tracks first/last seen times, run IDs, latest deterministic candidate profile, deterministic deltas, and latest validation horizons. These artifacts are historical research state, not promotion verdicts.

Unresolved predictions are retried up to five attempts. After that, they are marked resolved without an outcome and excluded from calibration metrics.

Alpha validation sidecars and candidate watchlists are historical Research Lead checks, not report predictions. They do not feed calibration. The Alpha validation summary also includes report-only Source Promotion Criteria for discovery source groups; these labels do not promote individual Research Leads or automatically change ranking behavior.

## Calibration

Calibration aggregation lives in `src/scoring/calibration.ts`.

`calibration` reads resolved prediction-score pairs and writes:

```text
data/calibration/summary.json
data/calibration/summary.md
```

The summary includes:

- resolved prediction count;
- overall Brier score;
- reliability bins by stated probability;
- metrics by prediction kind;
- metrics by asset class;
- metrics by job type;
- metrics by market-update cadence;
- metrics by horizon bucket.

When no resolved pairs exist, calibration does not write a new summary.

## Adding or changing behavior

Common extension points:

| Change | Main files |
| --- | --- |
| Add an environment variable | `src/config.ts`, `docs/configuration.md` |
| Add a source adapter | [Source Provider Contract](./source-provider-contract.md), `src/sources/*`, `src/sources/registry.ts`, source tests |
| Add a prediction shape | `src/forecast/observable.ts`, `src/scoring/resolver.ts`, `src/report/schema.ts`, `src/report/markdown.ts`, tests |
| Change report structure | `src/domain/types.ts`, `src/report/schema.ts`, `src/report/markdown.ts`, orchestrator prompt shape, tests |
| Change CLI syntax | `src/cli/args.ts`, CLI tests, README command docs |
| Add or change Domain Playbooks | `prompts/playbooks/registry.json`, `prompts/playbooks/*.md`, `src/research/playbooks.ts`, playbook and orchestrator tests |

Keep changes inside the research-only boundary in [ADR 0001](./adr/0001-research-only-boundary.md) and the observable-forecast boundary in [ADR 0004](./adr/0004-predictions-as-observable-forecasts.md).
