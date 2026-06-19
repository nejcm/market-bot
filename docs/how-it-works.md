# How It Works

`market-bot` is a Bun + TypeScript CLI that turns public market data and news into sourced research artifacts. It does not produce trading advice, execution instructions, position sizing, or portfolio actions.

## End-to-end flow

```text
CLI args
  -> config from environment
  -> source collection
  -> deterministic context
  -> historical context from prior run artifacts
  -> market spotlight selection (market-overview only)
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
4. `alpha-search` collects ApeWisdom social-momentum candidates, ranks equity candidates, adds SEC current-filing candidates, filters candidates through official listed-symbol metadata, Yahoo-validates eligible rows against the stock-only small-cap screen, and writes Research Leads, deterministic candidate profiles, profile/fundamental coverage counts, and rejected candidates without predictions. SEC Fundamental Evidence remains in `normalized/candidate-profiles.json` / `normalized/sec-fundamentals.json`, not in `researchLeads`; unmapped S-1/F-1/8-K/6-K filings are disclosed as pre-ticker mapping gaps. Oversized alpha raw payloads are compacted in `raw/snapshots.json` to byte count, SHA-256 digest, and structural summary while normalized sidecars remain complete.
5. `score` and `calibration` commands skip research generation and operate on existing run artifacts.
6. `cache prune` removes old cache entries without generating research.
7. Market overview, legacy daily/weekly alias, ticker, and thematic `research` commands also run scoring and calibration as non-blocking side effects before generating the new report. If scoring or calibration fails, the CLI logs the error and continues the research run.

## Commands

Run commands directly with Bun:

```sh
bun run src/cli.ts market-overview --asset equity
bun run src/cli.ts market-overview --asset crypto --horizon 15
bun run src/cli.ts market-overview --asset equity --horizon 5
bun run src/cli.ts market-overview --asset crypto --horizon 15 --deep
bun run src/cli.ts ticker AAPL --asset equity
bun run src/cli.ts ticker BTC --asset crypto
bun run src/cli.ts research AI biotech
bun run src/cli.ts research semis --deep
bun run src/cli.ts alpha-search --asset equity
bun run src/cli.ts score
bun run src/cli.ts calibration
bun run src/cli.ts cache prune
bun run src/cli.ts provider-health
bun run src/cli.ts history rebuild
bun run src/cli.ts history search --query catalyst
bun run src/cli.ts history thesis-delta AAPL --asset equity --since 2026-06-01
```

If installed as a binary, the same verbs are available through `market-bot`:

```sh
market-bot market-overview --asset equity
market-bot market-overview --asset crypto --horizon 15 --deep
market-bot ticker AAPL --asset equity --deep
market-bot research AI biotech --deep
market-bot alpha-search --asset equity --deep
market-bot score
market-bot calibration
market-bot cache prune
market-bot provider-health
market-bot history rebuild
market-bot history search --query catalyst
market-bot history thesis-delta AAPL --asset equity --since 2026-06-01 --narrative
```

Command behavior:

| Command                                  | What it does                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `market-overview --asset equity\|crypto [--horizon days] [prompt]` | Canonical whole-market update for one asset class, with overview-first coverage and optional Market Spotlights from current market evidence. `--horizon` sets the forecast horizon in trading days (default 15); an optional free-text prompt steers spotlight selection and final synthesis. Longer horizons still draw current mover inputs from daily-style source payloads, disclosed as source gaps. |
| `daily` / `weekly --asset equity\|crypto` | Deprecated aliases that dispatch into `market-overview` with preset horizons (`daily` -> 5 trading days, `weekly` -> 15). Retained for zero-break migration; prefer `market-overview --horizon`. |
| `ticker <symbol> --asset equity\|crypto` | Creates a detailed single-instrument research view with same-symbol historical context. Symbols are normalized to uppercase and must match the instrument validator.                                                                                                                                                                                            |
| `research <subject> [--deep]`           | Creates an equity thematic Research View. Subject text is the non-flag words after `research`; `--asset` and manual proxy flags are not accepted. Registry hits with a listed ETF proxy emit proxy-only forecasts and quote collection. Registry misses, or entries without a single proxy, still produce a report with zero scored predictions and a disclosed proxy gap. |
| `alpha-search --asset equity`            | Runs ApeWisdom social discovery plus SEC current-filing discovery, filters candidates through official listed-symbol metadata, validates eligible candidates with Yahoo as listed stocks inside the configured price, volume, and market-cap screen, and emits Research Leads plus rejected candidates with no predictions or scoring/calibration side effects. |
| `--deep`                                 | Uses the deep profile: more findings, scenarios, predictions, and fixed coverage-panel stages, with the synthesis model for the final pass.                                                                                                                                                                                                                     |
| `score`                                  | Resolves due predictions in previous runs and writes `score.json` files.                                                                                                                                                                                                                                                                                        |
| `calibration`                            | Rebuilds aggregate calibration outputs from existing resolved scores and prints a reliability dashboard to stdout (Brier skill, reliability bins, per-kind and per-horizon slices; small-sample warning below 5 resolved predictions).                                                                                                                          |
| `cache prune`                            | Removes raw cache day directories older than 30 days and scorer close-cache files older than 365 days.                                                                                                                                                                                                                                                          |
| `provider-health`                        | Reads persisted run artifacts and writes provider-health contract v2 to `data/provider-health/summary.json` plus `summary.md`, including a `pass`/`warn`/`fail` validation verdict, required coverage checklist, Run Artifact Index status, and provider gap classifications by route.                                                                                 |
| `index rebuild`                          | Bootstraps or fully rebuilds the derived SQLite Run Artifact Index (`data/index.sqlite` by default) from on-disk run artifacts.                                                                                                                                                                                                                                 |
| `history rebuild`                        | Rebuilds derived Historical Research Context indexes and per-Instrument timelines under `data/history/` from existing run artifacts.                                                                                                                                                                                                                            |
| `history search --query <text>`          | Searches prior reports, Sources, Predictions, Research Thesis components, open questions, fundamentals, and validation artifacts with optional filters. Uses the SQLite index when fresh; otherwise falls back to `data/history/index.json`.                                                                                                                    |
| `history thesis-delta <symbol>`          | Compares two historical Research Thesis states for an Instrument. By default it renders a deterministic delta; `--narrative` adds and persists a model-written research-only narrative.                                                                                                                                                                         |

The shared run taxonomy includes `research` for equity subject research artifacts. It is parsed by the public CLI and Research Console as `research <subject> [--deep]`, and is also used by report validation, history/search filters, calibration/index rows, and subject identity helpers.

Provider-health v2 expects coverage for short- and medium-horizon equity/crypto market overviews, equity and crypto ticker runs, a deep equity ticker run, and at least one international equity ticker smoke run. Legacy daily/weekly artifacts count during migration because they map into market-overview horizon buckets. Blocking gaps include missing required run shapes, missing usable news for a validation lane, FRED baseline gaps, Yahoo primary equity market-data/auth failures, CoinGecko primary crypto market-data failures, missing due scoring passes, and unsupported/unreadable Run Artifact Index schemas. Expected gaps produce a `warn` verdict; this includes Massive supplemental failures, Tradier/Glassnode account limits, individual MarketAux/Finnhub news gaps when another usable news source exists, and US-centric unsupported coverage for international equities. Informational gaps are disclosed without changing a `pass` verdict. Missing history on first-run paths is a soft Historical Context Gap, not a provider-health failure.

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
bun run app
```

The server binds to `127.0.0.1` and reads `MARKET_BOT_DATA_DIR` / `data/runs`.
Use `bun run app:dev` for the API plus Vite dev server.
The Jobs view queues allowlisted CLI verbs one at a time and shows basic status plus captured output.
The Search view queries the Run Artifact Index when fresh (substring match on report text, same semantics as the disk fallback) and filters by symbol, asset class, job type, and date range. Run detail still loads `report.json`, `score.json`, and other payloads from disk.

## Configuration

Configuration is read in `src/config.ts` from environment variables. Live model calls require the key for the selected provider, unless using the `codex` subscription provider.

Useful knobs:

| Variable                                                                             | Purpose                                                                                                            |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `MARKET_BOT_PROVIDER`                                                                | `openai`, `openai-compatible`, `codex`, or `anthropic`.                                                            |
| `MARKET_BOT_BASE_URL`                                                                | Required for `openai-compatible`.                                                                                  |
| `MARKET_BOT_QUICK_MODEL`                                                             | Model for playbook-selection, specialist, coverage-panel, and critique stages.                                     |
| `MARKET_BOT_SYNTHESIS_MODEL`                                                         | Model for final synthesis and `--deep` output.                                                                     |
| `MARKET_BOT_REASONING_EFFORT`                                                        | Optional `low`, `medium`, or `high` reasoning-effort hint.                                                         |
| `MARKET_BOT_DATA_DIR`                                                                | Run artifact directory, default `data/runs`.                                                                       |
| `MARKET_BOT_INDEX_DB_PATH`                                                           | Derived SQLite Run Artifact Index path; defaults to `data/index.sqlite` when `MARKET_BOT_DATA_DIR` is `data/runs`. |
| `MARKET_BOT_INDEX_DISABLE`                                                           | Set `1` or `true` to force disk-scan fallbacks for index-backed reads and skip write-through.                      |
| `MARKET_BOT_CACHE_DIR`                                                               | Raw source cache directory, default `data/cache`.                                                                  |
| `MARKET_BOT_CACHE_DISABLE`                                                           | Set `1` or `true` to bypass cache.                                                                                 |
| `MARKET_BOT_CACHE_FALLBACK_DAYS`                                                     | Stale cache fallback window after live fetch failure.                                                              |
| `MARKET_BOT_MARKET_SPOTLIGHT_BRIEF_LIMIT` / `MARKET_BOT_MARKET_SPOTLIGHT_DEEP_LIMIT` | Caps AI-selected Market Spotlights for market-overview runs. |
| `MARKET_BOT_MARKET_SPOTLIGHT_CANDIDATE_LIMIT`                                      | Top-ranked mover candidates fed to the spotlight selector (`0` = all).                                           |
| `MARKET_BOT_HISTORY_TICKER_RECENT_LIMIT` / `MARKET_BOT_HISTORY_MARKET_RECENT_LIMIT`  | Caps recent prior run artifacts used as Historical Research Context.                                               |
| `MARKET_BOT_HISTORY_RECENT_DAYS` / `MARKET_BOT_HISTORY_ANCHOR_MONTHS`                | Controls recent and older anchor history selection.                                                                |
| `MARKET_BOT_HISTORY_MISS_CORRECTION_LIMIT`                                         | Preserves recent resolved-miss runs against same-day rerun eviction (`0` = off).                                   |
| `MARKET_BOT_MARKETAUX_API_TOKEN`                                                     | Enables MarketAux news.                                                                                            |
| `MARKET_BOT_FINNHUB_API_TOKEN`                                                       | Enables Finnhub news.                                                                                              |
| `MARKET_BOT_MASSIVE_API_KEY` / `MARKET_BOT_POLYGON_API_KEY`                          | Enables supplemental Massive equity snapshots and news. `MARKET_BOT_POLYGON_API_KEY` is a legacy alias.            |

See [configuration.md](./configuration.md) for the full table.

## Source collection

Source collection lives in `src/sources/collector.ts`.

The collector fetches market data and news in parallel:

| Asset class | Market data                                                                                                                                                                                                                                           | News                                                                                                     |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `equity`    | Yahoo Finance predefined `day_gainers`, `day_losers`, and `most_actives` screeners (deduped by symbol) for market overviews; Yahoo quote endpoint for regime proxies and ticker runs. Optional Massive snapshots supplement the Yahoo-selected symbols. | MarketAux, Finnhub company news for ticker runs, Yahoo Finance search, and optional Massive equity news. |
| `crypto`    | CoinGecko markets endpoint. Market overviews request enough rows to rank movers; ticker runs fetch a larger universe and filter by symbol.                                                                                                           | MarketAux, Finnhub crypto market news, and Yahoo Finance search.                                         |

Equity regime context uses `SPY`, `QQQ`, `IWM`, `DIA`, `^VIX`, and `^VIX3M`. Crypto regime context uses major proxies such as `BTC` and `ETH`.

Market overview runs collect Market Context from FRED when `MARKET_BOT_FRED_API_KEY` is set. Market Context is market-level evidence, not ticker Extended Evidence. It is sent to model prompts, saved in `report.json` extras, persisted as `normalized/market-context.json`, and included in `report.sources` so findings and macro predictions can cite it. Missing FRED credentials or fetch failures are disclosed as `SourceGap`s and do not abort research, but provider-health v2 treats them as validation failures because FRED is baseline-required.

Massive, formerly Polygon.io, is a Supplemental Source Provider. `MARKET_BOT_MASSIVE_API_KEY` enables requests to `api.massive.com` for equity news and stock snapshots; `MARKET_BOT_POLYGON_API_KEY` is accepted as a legacy alias. Missing keys silently disable Massive. When the key is set and a Massive request fails, the failure is recorded as a `SourceGap` with `evidenceQualityImpact: "no-cap"`. Massive is equity-only in this version: it does not run for crypto, does not replace Yahoo, does not affect mover ranking or market regime, and does not create scoring Observations. Supplemental snapshots are saved as `normalized/supplemental-market-snapshots.json`, included in prompt evidence, and attached as citeable report Sources.

Ticker runs also collect Extended Evidence:

| Asset class | Extended Evidence                                                                                                                                         |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `equity`    | SEC/EDGAR recent filings and Fundamental Evidence from company facts, Finnhub earnings/dividends/splits, FRED macro observations, Tradier options IV, and Valuation Evidence when market cap and SEC fundamentals are both available. |
| `crypto`    | FRED macro observations and Glassnode on-chain metrics.                                                                                                   |

Extended Evidence is not collected for market overview runs. Missing optional provider credentials are reported as `SourceGap`s instead of failing the run.
SEC/EDGAR Fundamental Evidence uses curated operating basics and comparable prior-year deltas when SEC company facts expose matching periods; missing facts or non-comparable deltas are disclosed as `SourceGap`s.

Fetch behavior:

- All requests use `MARKET_BOT_SOURCE_TIMEOUT_MS`.
- Transient failures retry with backoff.
- Live fetches use a per-process, per-host limiter with one in-flight request and a 1000 ms minimum delay between starts.
- Repeated transient failures, provider usage-limit responses, and rate-limit responses open a circuit temporarily; open circuits emit `SourceGap`s.
- Failed sources become `SourceGap` entries instead of crashing the whole research run.
- `withCache` stores raw JSON by UTC date and a v2 canonical request hash that includes the adapter, strips credential-only query params, and keeps request-shaping params.
- Same-day equivalent provider requests can reuse cache across market overview, legacy daily/weekly alias, ticker, and evidence-request runs; broader/narrower provider payloads are not derived from each other.
- If a live request fails and a recent cached entry exists, the cached payload is used and a stale-source gap is recorded.
- Missing MarketAux or Finnhub tokens are reported as `no-cap` `SourceGap`s. Yahoo news still runs.
- Missing Massive keys are silent because Massive is supplemental-only; configured Massive failures are reported as `SourceGap`s with no evidence-quality cap.
- Finnhub news is capped after normalization because the used Finnhub news endpoints do not expose a count-limit parameter.
- Ticker news prefers sources whose title, summary, snippet, or source symbol mentions the ticker before provider round-robin selection. News is also checked against a persistent seen-news index at `data/news-seen.json` by default, or `MARKET_BOT_NEWS_SEEN_PATH` when set. Exact canonical-URL repeats are suppressed only within the same research lane for 30 days by default. The index is updated after report artifacts are written, so failed runs do not hide future news. If every news item is a repeat, one repeat fallback is kept and disclosed as a `SourceGap`.

## Historical context and Market Spotlights

Historical Research Context reads prior run artifacts from `MARKET_BOT_DATA_DIR` only. It does not read raw source cache files under `data/cache`. The reader loads matching `report.json` files, optional `score.json`, and selected normalized market snapshots. Recent history uses the configured lookback window; anchor history picks the closest matching run at or before configured month offsets.

The prompt receives compact history: prior summaries, findings, risks, catalysts, confidence, data gaps, scored prediction status, key extras, and selected numeric snapshots. History can inform forecast wording and probability calibration, but prediction counts, subjects, and horizons remain governed by run config.

Each selected prior run carries structured selection reasons: recency reasons (`recent`, `anchor-Nm`) plus topical relevance reasons (`same-symbol`, `spotlight-symbol`, `same-horizon`, `cross-horizon`). Up to `MARKET_BOT_HISTORY_MISS_CORRECTION_LIMIT` recent resolved-miss runs are also kept with a `miss-correction` reason when same-day reruns would otherwise evict them from the recency window. The context's audit block records how many runs each reason selected, how many carry a resolved miss (`resolvedMissRunCount`), how many were preserved by the miss-correction lane (`missCorrectionSelectedCount`), and the total disclosed gap count, so `trace.json` shows why each prior run was pulled in without re-deriving it.

Resolved prior **misses** are surfaced as explicit error-correction signal in the prompt — the model is asked to diagnose why a prior view was wrong before restating a similar one. The scoped blocks stay separate: ticker runs get an instrument-scoped block on the command's own symbol; market overview runs get a market-scoped block on their configured index/macro/crypto forecast subjects, drawn only from prior same-horizon, same-asset market overviews; `research` runs can get a thematic block when prior research artifacts match the same subject key or prediction proxy. Hits are never itemized here — they inform the run only through aggregate calibration.

Historical Research Context also has user-facing derived views. `history rebuild` scans existing run artifacts and writes `data/history/index.json` plus per-Instrument timelines under `data/history/instruments/`. These derived files keep `data/runs/<run-id>/` as the source of truth, use `assetClass:symbol` as the compatibility key, and preserve any Instrument Identity metadata that prior Sources exposed. History commands are artifact-only: they do not fetch fresh market data, news, fundamentals, or Observations.

The Run Artifact Index ([ADR 0018](./adr/0018-run-artifact-index.md)) is a separate derived SQLite file (`data/index.sqlite` by default). Run `index rebuild` once to bootstrap it; research jobs, `alpha-search`, and `score` then write through affected runs when mutable sidecars change. Index reads check run-directory set equality and mutable sidecar mtimes. A **stale** index (present and schema-matched but drifted) self-heals: the next research, `score`, or `alpha-search` run detects the drift and triggers a full rebuild as a non-fatal side effect ([ADR 0022](./adr/0022-stale-index-rebuild-follow-up.md)), so subsequent runs and the console return to index-backed reads without operator intervention. **Missing or unsupported-schema** indexes warn on `stderr` and fall back to disk scans until `index rebuild` is run. Provider-health includes the index status and fails on unsupported schemas until `bun run src/cli.ts index rebuild` is run. Console list/search, `history search`, and calibration resolved-pair loading use the SQLite path when fresh.

Markdown reports list cited Sources first and replace uncited normalized Sources with a compact provider/kind inventory line. `report.json` and console artifact views keep the full source array for audit and inspection.

The history JSON index and SQLite index both support local structured text search over report sections, Sources, Predictions, open questions, Fundamental Evidence, and validation artifacts. Thesis deltas compare Research Thesis components between two historical runs for the same Instrument: summary, findings, bull/bear cases, risks, catalysts, data gaps, open questions, observable Predictions, score state, fundamentals, and validation. Each timeline entry is tagged `instrument` or `market-update` scope: an `instrument`-scoped entry comes from a run whose subject is that symbol (a ticker run), while a `market-update`-scoped entry only references the symbol from a broader market overview or legacy daily/weekly report. `history thesis-delta` compares `instrument`-scoped entries only, so a whole-market narrative is never compared as if it were a single Instrument's Research Thesis. When `--narrative` is passed, the model summarizes the deterministic delta and the output is persisted with the input delta and model metadata under `data/history/deltas/`; a narrative that contains trade-action language is rejected before any file is written.

Ticker jobs include recent same-symbol ticker runs plus same-asset market overview history, including readable legacy daily/weekly artifacts. This context is loaded before the Evidence Request Loop, so eligible deep ticker runs can ask for extra public evidence in response to prior-run changes.

Market overview jobs include same-asset market overview history, with same-horizon runs prioritized. Market Spotlight candidates are built only from the current collected market snapshot universe and may be enriched with mover features, benchmark context, history availability, and alpha-search watchlist annotations. Alpha-search and history can enrich a candidate, but cannot create one without current market evidence. `MARKET_BOT_MARKET_SPOTLIGHT_CANDIDATE_LIMIT` caps the ranked mover list passed to the selector before the model runs (`0` passes every candidate).

The `spotlight-selection` quick-model stage runs before Domain Playbooks when a market overview has candidates and a nonzero spotlight cap. It may select zero candidates. Unknown symbols, duplicates, cap overflow, malformed JSON, and unknown source IDs are rejected into `trace.json`; the run continues with valid selections or no spotlights.

Final synthesis may render or refine selected spotlight rationale, but report assembly preserves the validated selected symbol set and source IDs.

Spotlights do not spawn ticker jobs, fetch extra evidence, use provider-native tools, or auto-upgrade to `--deep`. Weekly reports may compare current artifacts to prior run artifacts, but those deltas are run-to-run comparisons, not true trailing 5-session or 7-day mover data.

## Normalization and adapters

The source registry in `src/sources/registry.ts` maps asset classes to adapters:

- `src/sources/yahoo.ts` normalizes Yahoo quote payloads and fetches equity closes for scoring.
- `src/sources/coingecko.ts` normalizes CoinGecko market payloads and fetches crypto closes for scoring.
- `src/sources/yahoo-news.ts` normalizes news search results into report sources.
- `src/sources/marketaux-news.ts`, `src/sources/finnhub-news.ts`, and `src/sources/multi-news.ts` collect multi-provider news, dedupe by canonical URL and by normalized title when the title carries enough signal, merge duplicates while preserving the first canonical URL and provider aliases, and suppress recently seen repeats.
- `src/sources/massive.ts` normalizes Massive stock snapshots and equity news from `api.massive.com`. Massive was formerly Polygon.io.
- `src/sources/market-context.ts` collects FRED macro Market Context for market overview runs.
- `src/sources/extended-evidence.ts` composes ticker-only Extended Evidence from separate provider files under `src/sources/extended-evidence/` for SEC/EDGAR, Finnhub events, FRED, Tradier IV, Glassnode, and deterministic Valuation Evidence from market cap plus SEC fundamentals.
- `src/sources/providers.ts` lists Source Provider modules and their optional capabilities.
- `src/sources/fred.ts` and `src/sources/tradier.ts` support macro and IV scoring inputs.

Adapters convert external API payloads into internal `MarketSnapshot`, `Source`, and close-price records. Callers work with normalized shapes and source gaps, not raw provider-specific payloads.

New Source Provider work should follow the [Source Provider Contract](./source-provider-contract.md).

## Movers

Mover ranking lives in `src/movers/ranking.ts`.

The ranker:

- drops snapshots with invalid price, invalid percent change, or volume below `10_000`;
- computes a baseline score as `abs(changePercent24h) * log10(volume)`;
- adds Benchmark-Relative Mover Context for market overview equity movers when Yahoo benchmark quotes are available. The context compares each Yahoo-selected mover against a sector ETF, or `SPY` when sector metadata is unavailable, and is citeable evidence rather than a ranking input;
- adds neutral-if-missing Mover Feature boosts for unusual volume and opening gap size when the source payload includes usable fields;
- caps unusual-volume boost at `0.25` and gap boost at `0.20`, then scores as `baseScore * (1 + unusualVolumeBoost + gapBoost)`;
- sorts by score descending, then symbol ascending;
- assigns 1-based ranks after slicing to the configured limit;
- stamps each mover snapshot with the asset-class market-data provider (`yahoo` or `coingecko`) for analytics and source inventory;
- includes the score components and short deterministic reasons in the model evidence payload.

Longer-horizon market overviews currently reuse the same underlying mover inputs as short-horizon reports. The report records that limitation in `dataGaps`.

## Market regime

The deterministic regime summary lives in `src/research/regime.ts`.

For equities, the classifier aggregates three deterministic drivers across the `SPY`, `QQQ`, `IWM`, and `DIA` proxies: same-day **breadth** (advancers vs decliners), **trend** (each proxy's price vs its own 50-day average), and **VIX term structure** (`^VIX` vs `^VIX3M`, where front-month backwardation is a risk-off stress signal). Each driver casts a `risk-on` / `risk-off` / `neutral` vote and the majority wins; an elevated `^VIX` (at or above the threshold) still forces `risk-off` as an override. When no driver has inputs the label falls back to `insufficient-data` rather than defaulting to `risk-on`. For crypto, it checks breadth across major crypto proxies. FRED Market Context can add macro drivers and source IDs, but it does not change the deterministic `risk-on` / `risk-off` / `mixed` label. The output includes:

- `label`: `risk-on`, `risk-off`, `mixed`, or `insufficient-data`;
- `proxyCount`;
- human-readable drivers;
- source IDs used for the regime view.

This regime summary is sent to the model as context and stored in report extras.

## Research generation

Research orchestration lives in `src/research/orchestrator.ts`.

Each research run builds a depth profile:

| Mode    | Effect                                                                  |
| ------- | ----------------------------------------------------------------------- |
| `brief` | Concise report with fewer minimum findings, scenarios, and a lower prediction target. |
| `deep`  | Fuller report with higher minimum counts, a higher prediction target, and broader focus.       |

Before the shared analysis stages:

- Market overview runs may run `spotlight-selection` after current source collection and historical context.
- Eligible deep equity ticker runs may run `evidence-request`; the prompt sees historical context before requesting extra public evidence.

Brief runs use these shared model stages:

1. `playbook-selection`: chooses checked-in Domain Playbooks for eligible downstream stages.
2. `specialist-analysis`: extracts sourced thesis points, catalysts, risks, and gaps.
3. `critique`: challenges the specialist output using only supplied evidence.
4. `final-synthesis`: emits the final JSON report and predictions.

Deep runs keep `specialist-analysis` as the anchor, then run two fixed coverage-panel stages before critique:

- Market overviews: `regime-context-analysis` and `mover-theme-analysis`.
- Tickers: `instrument-evidence-analysis` and `market-behavior-analysis`.

Each coverage-panel stage receives the specialist output as prior context. `critique` receives the specialist plus both role outputs, and `final-synthesis` receives all analyses plus critique. The panel broadens coverage without adding report schema fields.

Domain Playbooks live under `prompts/playbooks/` and are registered in `prompts/playbooks/registry.json`. After source collection, historical context, any Market Spotlight selection, and any Evidence Request Loop, the quick model runs `playbook-selection` once with slim run context: command, depth profile, planned stages, candidate metadata, market-regime label, evidence categories, and source-gap summaries. It may select up to two playbooks per stage and six per run. Valid selections are loaded into downstream prompt JSON as `domainPlaybooks`; invalid selector output is recorded in `trace.json` and the run continues without adding report data gaps.

The prompts require JSON-only output and supplied source IDs only. The final synthesis prompt also requires observable prediction expressions.

The prediction count is a soft target, not a hard floor ([ADR 0021](./adr/0021-prediction-count-soft-target.md)). The orchestrator reprompts final synthesis only to fix genuine validation errors or redundant predictions; it never reprompts merely to reach the target. A clean below-target result ships as-is and discloses a `predictionShortfall` data gap rather than padding with coin-flip (≈0.5) predictions. Report assembly also rejects adjacent same-subject direction forecasts whose horizons are fewer than two trading days apart.

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
if (<existing expression>) then (<existing expression>)
```

Prediction validation checks:

- required fields are present;
- `kind`, `subject`, and `horizonTradingDays` match the parsed expression;
- horizon is an integer from 1 to 20 trading days;
- probability is between 0 and 1 and means `P(measurableAs is TRUE)`;
- for Conditional Predictions, probability means `P(consequent | antecedent)`, the antecedent horizon must be earlier than the consequent horizon, and condition-unmet scores are voided/excluded from Brier and reliability bins;
- source IDs exist in the report source list;
- direction forecasts on the same subject are at least two trading days apart.

Accepted predictions are canonicalized so the stored `measurableAs` matches the parser output. The stored public `claim` remains present for compatibility, but it is generated from the parsed `measurableAs`; model-authored claim text is ignored ([ADR 0020](./adr/0020-claim-rendered-from-dsl.md)). Legacy artifact display and indexes render from `measurableAs` when parseable and fall back to the stored `claim` otherwise.

## Report validation and rendering

`src/report/schema.ts` is the report contract. It enforces:

- `notFinancialAdvice: true`;
- `confidence` as `high`, `medium`, or `low`;
- source IDs on major findings, scenarios, bull case, bear case, risks, and catalysts;
- no trade-action language in report narrative.

`src/report/markdown.ts` renders the validated report into a readable `report.md` with summary, findings, cases, risks, catalysts, scenarios, predictions, data gaps, and sources.

Historical Context and Market Spotlights render from `report.extras.historicalContext` and `report.extras.spotlights`. The renderer parses them defensively, escapes markdown text, and only includes item-level source references that exist in the final source list.

For market overview reports, a `## What Changed Since Last <horizon> Market Overview` section renders directly after the summary from `report.extras.marketUpdateDelta` (the Market Update Delta). It is a deterministic, no-model-call diff against the most-recent prior same-horizon run: regime label change with flipped drivers, the ranked Mover membership diff, and Predictions from prior same-asset-class market overview runs that resolved since the baseline. When there is no prior same-horizon run it renders a single empty-state line.

## Artifacts

Artifacts are written under `MARKET_BOT_DATA_DIR`, default `data/runs`.

Each research run creates:

```text
data/runs/<run-id>/
  raw/snapshots.json
  normalized/market-snapshots.json
  normalized/market-context.json
  normalized/historical-context.json
  normalized/spotlight-candidates.json  # market overview only
  normalized/spotlight-selection.json  # market overview only
  normalized/movers.json  # market overview only — ranked mover set, baseline for the next Market Update Delta
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

`trace.json` records command metadata, model names, stage names, source gaps, historical-context audit metadata, Market Spotlight selector audit metadata, Domain Playbook selector audit metadata, token estimate, cost estimate, prediction retry reasons, and prediction validation errors when present. `startedAt` and `completedAt` use ISO timestamps; `completedAt` is recorded when artifact writing finishes so duration reflects the full run, not just model stages. `analytics.json` records deterministic run counters for source funnels, news dedupe, evidence quality, prediction health (`targetCount` / `targetMet` plus shortfall disclosure), generation-time calibration slices, Verified Market Snapshot freshness, and run shape. `stages.json` includes `playbook-selection` and, when it runs, `spotlight-selection` model output, so selector token and cost estimates are included in run totals.

## Scoring

Scoring lives in `src/scoring/index.ts`, `src/scoring/observations.ts`, and `src/scoring/resolver.ts`.

`score` scans every run directory:

1. Load `report.json`.
2. For prediction reports, skip predictions that are already resolved or have reached the max attempt count.
3. Check whether the prediction horizon has elapsed in trading days, counted against the US exchange calendar (`src/scoring/exchange-calendar.ts`) so weekends and market holidays are skipped.
4. Fetch point or window Observations from Yahoo, CoinGecko, FRED, or Tradier.
5. For close-based predictions, use provider-returned sessions: origin is the first available close at or after the report date, and horizon is the Nth available close after origin.
6. Resolve each observable forecast as `hit`, `miss`, `voided`, or unresolved. Conditional Predictions first resolve the antecedent; false antecedents are voided/excluded, true antecedents activate the consequent.
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
data/alpha-search/cohorts.json
data/alpha-search/cohorts.md
```

The Alpha feature-attribution summary buckets deterministic candidate profile features, including available SEC Fundamental Evidence metrics, against Alpha validation outcomes. The Alpha candidate watchlist is rebuilt from per-run candidate profiles and validation sidecars. It tracks first/last seen times, run IDs, latest deterministic candidate profile, deterministic deltas, and latest validation horizons. The Alpha lead cohort summary groups rejected candidates by rejection reason and unbriefed leads by age bucket, then joins any later validation outcomes by symbol. These artifacts are historical research state, not promotion verdicts.

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
- overall Brier skill vs the always-0.5 baseline (`1 - brier / 0.25`; 0 = no edge, 1 = perfect);
- reliability bins by stated probability;
- metrics by prediction kind;
- metrics by asset class;
- metrics by job type;
- metrics by market overview horizon bucket;
- metrics by horizon bucket.

When no resolved pairs exist, calibration does not write a new summary.

Running `calibration` (or the non-blocking side effect after research/score) also prints a stdout
dashboard via `renderCalibrationConsole` in `src/scoring/calibration-console.ts`. Below five resolved
predictions it shows counts and overall Brier metrics with a small-sample warning; at or above the
threshold it adds reliability bins and per-kind / per-horizon Brier skill slices.

## Adding or changing behavior

Common extension points:

| Change                         | Main files                                                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Add an environment variable    | `src/config.ts`, `docs/configuration.md`                                                                                  |
| Add a source adapter           | [Source Provider Contract](./source-provider-contract.md), `src/sources/*`, `src/sources/registry.ts`, source tests       |
| Add a prediction shape         | `src/forecast/observable.ts`, `src/scoring/resolver.ts`, `src/report/schema.ts`, `src/report/markdown.ts`, tests          |
| Change report structure        | `src/domain/types.ts`, `src/report/schema.ts`, `src/report/markdown.ts`, orchestrator prompt shape, tests                 |
| Change CLI syntax              | `src/cli/args.ts`, CLI tests, README command docs                                                                         |
| Add or change Domain Playbooks | `prompts/playbooks/registry.json`, `prompts/playbooks/*.md`, `src/research/playbooks.ts`, playbook and orchestrator tests |

Keep changes inside the research-only boundary in [ADR 0001](./adr/0001-research-only-boundary.md) and the observable-forecast boundary in [ADR 0004](./adr/0004-predictions-as-observable-forecasts.md).
