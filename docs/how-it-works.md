# How It Works

`market-bot` is a Bun + TypeScript CLI that turns public market data and news into sourced research artifacts. It does not produce trading advice, execution instructions, position sizing, or portfolio actions.

## End-to-end flow

```text
CLI args
  -> config from environment
  -> source collection
  -> deterministic context
  -> model stages
  -> report validation
  -> artifact writing
  -> score pass + calibration refresh
```

1. `src/cli.ts` passes command-line arguments to `runCli`.
2. `src/app.ts` parses the command, resolves configuration, and dispatches the workflow.
3. Research commands collect sources, build an OpenAI or OpenAI-compatible provider, run the research job, and persist artifacts.
4. `score` and `calibration` commands skip research generation and operate on existing run artifacts.
5. `cache prune` removes old cache entries without generating research.
6. Daily, weekly, and ticker research commands also run scoring and calibration as non-blocking side effects before generating the new report. If scoring or calibration fails, the CLI logs the error and continues the research run.

## Commands

Run commands directly with Bun:

```sh
bun run src/cli.ts daily --asset equity
bun run src/cli.ts daily --asset crypto
bun run src/cli.ts weekly --asset equity
bun run src/cli.ts weekly --asset crypto
bun run src/cli.ts ticker AAPL --asset equity
bun run src/cli.ts ticker BTC --asset crypto
bun run src/cli.ts score
bun run src/cli.ts calibration
bun run src/cli.ts cache prune
```

If installed as a binary, the same verbs are available through `market-bot`:

```sh
market-bot daily --asset equity
market-bot weekly --asset crypto --deep
market-bot ticker AAPL --asset equity --deep
market-bot score
market-bot calibration
market-bot cache prune
```

Command behavior:

| Command | What it does |
| --- | --- |
| `daily --asset equity\|crypto` | Creates a daily market update for one asset class. |
| `weekly --asset equity\|crypto` | Creates a weekly market update. Weekly changes the cadence and prediction horizon, but current mover inputs still come from daily-style source payloads and are disclosed as source gaps. |
| `ticker <symbol> --asset equity\|crypto` | Creates a single-instrument research view. Symbols are normalized to uppercase and must match the instrument validator. |
| `--deep` | Uses the deep profile: more findings, scenarios, and predictions, with the synthesis model for the final pass. |
| `score` | Resolves due predictions in previous runs and writes `score.json` files. |
| `calibration` | Rebuilds aggregate calibration outputs from existing resolved scores. |
| `cache prune` | Removes raw cache day directories older than 30 days and scorer close-cache files older than 365 days. |

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

## Configuration

Configuration is read in `src/config.ts` from environment variables. The main required value for live model calls is `OPENAI_API_KEY` or `MARKET_BOT_OPENAI_API_KEY`.

Useful knobs:

| Variable | Purpose |
| --- | --- |
| `MARKET_BOT_PROVIDER` | `openai`, `openai-compatible`, or `codex`. |
| `MARKET_BOT_BASE_URL` | Required for `openai-compatible`. |
| `MARKET_BOT_QUICK_MODEL` | Model for specialist and critique stages. |
| `MARKET_BOT_SYNTHESIS_MODEL` | Model for final synthesis and `--deep` output. |
| `MARKET_BOT_DATA_DIR` | Run artifact directory, default `data/runs`. |
| `MARKET_BOT_CACHE_DIR` | Raw source cache directory, default `data/cache`. |
| `MARKET_BOT_CACHE_DISABLE` | Set `1` or `true` to bypass cache. |
| `MARKET_BOT_CACHE_FALLBACK_DAYS` | Stale cache fallback window after live fetch failure. |
| `MARKET_BOT_MARKETAUX_API_TOKEN` | Enables MarketAux news. |
| `MARKET_BOT_FINNHUB_API_TOKEN` | Enables Finnhub news. |
| `MARKET_BOT_MASSIVE_API_KEY` | Enables supplemental Massive equity snapshots and news. |

See [configuration.md](./configuration.md) for the full table.

## Source collection

Source collection lives in `src/sources/collector.ts`.

The collector fetches market data and news in parallel:

| Asset class | Market data | News |
| --- | --- | --- |
| `equity` | Yahoo Finance predefined `day_gainers` screener for market updates; Yahoo quote endpoint for regime proxies and ticker runs. Optional Massive snapshots supplement the Yahoo-selected symbols. | MarketAux, Finnhub company news for ticker runs, Yahoo Finance search, and optional Massive equity news. |
| `crypto` | CoinGecko markets endpoint. Market updates request enough rows to rank movers; ticker runs fetch a larger universe and filter by symbol. | MarketAux, Finnhub crypto market news, and Yahoo Finance search. |

Equity regime context uses `SPY`, `QQQ`, `IWM`, `DIA`, and `^VIX`. Crypto regime context uses major proxies such as `BTC` and `ETH`.

Daily and weekly market updates also collect Market Context from FRED when `MARKET_BOT_FRED_API_KEY` is set. Market Context is market-level evidence, not ticker Extended Evidence. It is sent to model prompts, saved in `report.json` extras, persisted as `normalized/market-context.json`, and included in `report.sources` so findings and macro predictions can cite it. Missing FRED credentials or fetch failures are disclosed as `SourceGap`s but do not cap Evidence Quality.

Massive, formerly Polygon.io, is a Supplemental Source Provider. `MARKET_BOT_MASSIVE_API_KEY` enables requests to `api.massive.com` for equity news and stock snapshots. Missing keys silently disable Massive. When the key is set and a Massive request fails, the failure is recorded as a `SourceGap`. Massive is equity-only in this version: it does not run for crypto, does not replace Yahoo, does not affect mover ranking or market regime, and does not create scoring Observations. Supplemental snapshots are saved as `normalized/supplemental-market-snapshots.json`, included in prompt evidence, and attached as citeable report Sources.

Ticker runs also collect Extended Evidence:

| Asset class | Extended Evidence |
| --- | --- |
| `equity` | SEC/EDGAR filings and company facts, Finnhub earnings/dividends/splits, FRED macro observations, and Tradier options IV. |
| `crypto` | FRED macro observations and Glassnode on-chain metrics. |

Extended Evidence is not collected for daily or weekly market updates. Missing optional provider credentials are reported as `SourceGap`s instead of failing the run.

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

## Movers

Mover ranking lives in `src/movers/ranking.ts`.

The ranker:

- drops snapshots with invalid price, invalid percent change, or volume below `10_000`;
- computes a baseline score as `abs(changePercent24h) * log10(volume)`;
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

The orchestrator runs model stages:

1. `specialist-analysis`: extracts sourced thesis points, catalysts, risks, and gaps.
2. `critique`: challenges the specialist output using only supplied evidence.
3. `final-synthesis`: emits the final JSON report and predictions.

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
  stages.json
  report.json
  report.md
  trace.json
  score.json             # written later when predictions become due
```

`runId` is based on the current ISO timestamp plus a short random suffix.

`trace.json` records command metadata, model names, stage names, source gaps, token estimate, cost estimate, and prediction validation errors when present.

## Scoring

Scoring lives in `src/scoring/index.ts`, `src/scoring/observations.ts`, and `src/scoring/resolver.ts`.

`score` scans every run directory:

1. Load `report.json`.
2. Skip runs without predictions.
3. Skip predictions that are already resolved or have reached the max attempt count.
4. Check whether the prediction horizon has elapsed in trading days.
5. Fetch point or window Observations from Yahoo, CoinGecko, FRED, or Tradier.
6. For close-based predictions, use provider-returned sessions: origin is the first available close at or after the report date, and horizon is the Nth available close after origin.
7. Resolve each observable forecast as `hit`, `miss`, or unresolved.
8. Write or update `score.json`.

Unresolved predictions are retried up to five attempts. After that, they are marked resolved without an outcome and excluded from calibration metrics.

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
| Add a source adapter | `src/sources/*`, `src/sources/registry.ts`, source tests |
| Add a prediction shape | `src/forecast/observable.ts`, `src/scoring/resolver.ts`, `src/report/schema.ts`, `src/report/markdown.ts`, tests |
| Change report structure | `src/domain/types.ts`, `src/report/schema.ts`, `src/report/markdown.ts`, orchestrator prompt shape, tests |
| Change CLI syntax | `src/cli/args.ts`, CLI tests, README command docs |

Keep changes inside the research-only boundary in [ADR 0001](./adr/0001-research-only-boundary.md) and the observable-forecast boundary in [ADR 0004](./adr/0004-predictions-as-observable-forecasts.md).
