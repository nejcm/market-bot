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
  model/              OpenAI / OpenAI-compatible / Codex / Anthropic providers
  movers/             Deterministic mover ranking and screener dedupe
  report/             Report schema (zod) + markdown renderer
  alpha-search/       Equity lead discovery, listed-universe filtering, validation
  research/           Orchestrator, prompt loader, history, Market Spotlights, Domain Playbooks, regime summary
                      subject-registry.ts for checked-in research subject proxy resolution
  history/            Derived Historical Research Context indexes, search, and thesis deltas
  run-artifact-index.ts Derived SQLite Run Artifact Index (query layer over disk artifacts)
  scoring/            Score pass, Observation fetching, close cache, calibration aggregator
  sources/            Provider modules, normalized source adapters, collector with retry/backoff/cache
prompts/              Stage prompt files and checked-in Domain Playbooks
tests/                Bun test suites
app/                  Local Svelte + Bun Research Console App
docs/adr/             Architecture decision records
plans/                Curated planning docs (humans only)
data/                 Run artifacts and calibration output (gitignored)
```

Keep files cohesive — soft target 200–400 lines, hard limit 800.

## Subsystems

### Sources (`src/sources/`)

External fetching only. Retry, backoff, per-host rate limiting, and circuit breaking live at the collector/cache seam. Respect `MARKET_BOT_SOURCE_TIMEOUT_MS`. Mock at this seam in tests, not at `fetch`.

Notable inputs:
- Equity movers: Yahoo `day_gainers`, `day_losers`, and `most_actives` (deduped by symbol)
- Equity mover benchmark context: Yahoo sector ETF quotes, falling back to `SPY`, attached as citeable context without changing mover ranking
- Crypto movers: CoinGecko 24h change
- Supplemental equity market evidence: Massive stock snapshots for already-selected Yahoo symbols when `MARKET_BOT_MASSIVE_API_KEY` is set
- Market Context: FRED macro series for market overview runs
- Evidence Request tools: SEC latest periodic filing text and Tradier IV term structure for eligible deep equity ticker runs
- News: MarketAux, Finnhub, Yahoo Finance search, and optional Massive equity news
- Observations for scoring: Yahoo closes (equities), CoinGecko closes (crypto), FRED macro values, and Tradier IV values

A file-based cache (`data/cache/<YYYY-MM-DD>/<sha256-of-v2-canonical-request>.json`) wraps all `fetchJsonOrGap` and `fetchTextOrGap` calls. The cache key includes the adapter plus a canonicalized provider request: protocol/host/path are normalized, query params are sorted, and credential-only params such as API tokens are stripped while request-shaping params remain. Same-day equivalent requests across market overview, legacy daily/weekly alias, ticker, and evidence-request runs return cached payloads without hitting the network. If a live fetch fails and a cached entry exists within `MARKET_BOT_CACHE_FALLBACK_DAYS` (default 7), that entry is returned and a `SourceGap` is emitted disclosing the staleness. Cache entries store the hash key, not the full request URL.

Source providers are listed in `src/sources/providers.ts`. Each provider module exposes optional capabilities for primary market data, supplemental market data, news, Extended Evidence, Market Context, and future scoring Observation inputs. The registry composes those capabilities by asset class instead of hard-coding provider logic into one collector.

New Source Provider work should follow the [Source Provider Contract](./source-provider-contract.md).

The deterministic Source Plan subsystem ([ADR 0028](./adr/0028-deterministic-source-plan-subsystem.md)) derives evidence lanes only from current provider paths. It writes `normalized/source-plan.json` for planned required/optional lanes, `normalized/evidence-lanes.json` for lane coverage and gaps, and `normalized/source-ledger.json` for per-source lane attribution. Covered lanes always have backing source IDs; missing required coverage is represented as a lane gap, not a synthetic covered lane.

**Verified Market Snapshot** ([ADR 0019](./adr/0019-verified-market-snapshot.md)): for every `equity ticker` run, `collectVerifiedMarketSnapshot` (`src/sources/verified-market-snapshot.ts`) fetches ≥400 calendar days of daily OHLCV bars from the Yahoo chart API via `ctx.request.json` (adapter `yahoo-verified-chart`), computes deterministic canonical indicators (EMA10, SMA50/200, RSI14, MACD 12/26/9, Bollinger 20/2, ATR14), and returns a compact snapshot injected into every stage prompt via `buildEvidencePayload`. The full bar series is retained in `rawSnapshots` and the structured result is persisted to `normalized/verified-market-snapshot.json`. On failure a `SourceGap` with `evidenceQualityImpact: "core-cap"` is emitted and the run continues. `fetchYahooCloseWindow` and the Massive closes-only fallback are forbidden for this path. Canonical `InstrumentIdentity` is derived in parallel from the already-collected ticker `MarketSnapshot` (no second fetch) and persisted to `normalized/instrument-identity.json`.

News collection fans out to enabled providers, skips missing MarketAux/Finnhub tokens with `no-cap` `SourceGap`s (Yahoo news still runs), silently skips missing Massive keys, always includes Yahoo, canonicalizes URLs, merges exact canonical-URL duplicates and sufficiently distinct normalized-title duplicates into one `Source` (preserving the first canonical URL and merging provider aliases), and preserves provider aliases on the normalized source. Ticker news ranks issuer-relevant stories ahead of generic market stories inside each provider bucket before provider round-robin selection. A persistent seen-news index (`data/news-seen.json` by default, overridable with `MARKET_BOT_NEWS_SEEN_PATH`) suppresses exact canonical-URL repeats within the same research lane for 30 days. The index is updated only after a report is successfully persisted; if every news item is a repeat, one repeat fallback is kept and disclosed as a `SourceGap`.

### Alpha Search (`src/alpha-search/`)

`alpha-search --asset equity [--deep]` is an equity lead discovery workflow. It fetches social-momentum pages from the ApeWisdom API, ranks candidates with a deterministic social momentum score, then runs SEC current-filing discovery for configured catalyst forms (`S-1,F-1,8-K,6-K` by default). SEC candidates are mapped to tickers through official SEC `company_tickers.json`. ApeWisdom runs first; SEC runs second. Candidates are deduped by symbol so ApeWisdom-backed rows keep social evidence while SEC evidence enriches the same symbol.

Before Yahoo validation, alpha-search filters candidates through official listed-symbol data from Nasdaq Trader `nasdaqlisted.txt` / `otherlisted.txt`, with Cboe trading-stat symbol rows retained only as supplemental symbol evidence. Nasdaq metadata classifies eligibility. The filter rejects not-found, ETF/fund, inactive, test-issue, and unsupported listing-type rows with deterministic reasons. Yahoo remains final validation for stock-only, non-OTC status, price, volume, and market-cap band. Defaults target listed small/mid-cap discovery (`$0.50+`, `100k+` volume, `$50M-$10B` market cap). Alpha-search reports have `jobType: "alpha-search"`, no predictions, and no calibration side effects. Valid candidates are emitted as Research Leads and deterministic candidate profiles. Rejected candidates are listed separately with discovery sources, rejection reason, and source IDs. Repeated unmapped SEC filing gaps are grouped (deduped, with an `(N filings)` count) before entering `report.dataGaps`, the trace, and the `normalized/source-gaps.json` sidecar, so supplemental absences do not pin confidence and the sidecar matches the rendered report. Candidate profiles may include SEC Fundamental Evidence metrics for attribution, but those metrics do not change ranking and are not embedded into `researchLeads`. The report renders profile coverage counts, social momentum drivers, and unmapped SEC filing counts so pre-ticker mapping gaps are separated from mapped-lead enrichment. Raw alpha snapshots over 1 MiB are compacted to metadata (`payloadBytes`, SHA-256 digest, and structural summary); normalized sidecars (apart from the unmapped-SEC-filing grouping applied to `normalized/source-gaps.json` described above), `report.json`, and score artifacts remain full fidelity. Later `score` passes write sidecar Alpha validation artifacts that compare each Research Lead's 5- and 20-trading-day return against `IWM`, backfill missing candidate profiles, rebuild feature-attribution summaries, rebuild `data/alpha-search/watchlist.{json,md}`, and write `data/alpha-search/cohorts.{json,md}` from run artifacts. Cohorts group rejected candidates by rejection reason and unbriefed leads by age bucket, joining later validation outcomes when the same symbol appears in validation sidecars. These artifacts remain historical validation and candidate-state data, not predictions or promotion verdicts.

Massive, formerly Polygon.io, is supplemental-only. When configured, it uses `api.massive.com` to collect equity news and stock snapshots for the symbols already selected by Yahoo. Those snapshots are persisted as supplemental market snapshots, included as report Sources, and included in prompt evidence. Configured Massive failures remain visible as `SourceGap`s with `evidenceQualityImpact: "no-cap"` because core Yahoo/FRED/CoinGecko semantics decide evidence quality. Missing optional news tokens (MarketAux, Finnhub) also emit `no-cap` gaps so supplemental absences do not pin alpha-search or market-overview confidence. Massive does not enter mover ranking, market regime summaries, crypto workflows, or scoring Observations.

Market overview runs collect FRED Market Context when `MARKET_BOT_FRED_API_KEY` is set. Missing or failed FRED context is disclosed as a `SourceGap` but does not cap Evidence Quality. Longer-horizon overviews use the same mover inputs as short-horizon overviews; this is horizon metadata, not a separate trailing-window data product. Reports must disclose it as a source gap.

### Research (`src/research/`)

The orchestrator coordinates: collect sources → load Historical Research Context → summarize regime → optional Market Spotlight selection for market overviews → optional Evidence Request Loop for eligible deep ticker runs → select Domain Playbooks → produce report → emit predictions. It is also the home for the deterministic market-regime summary and, for market overviews, the deterministic Market Update Delta (`market-update-delta.ts`) — a no-model-call diff against the most-recent prior same-asset, same-horizon-bucket overview run (regime change, ranked Mover membership diff, predictions resolved since the baseline) attached to `report.extras.marketUpdateDelta` and rendered after the summary. Each market overview persists its ranked mover set to `normalized/movers.json` as the baseline for the next run's delta.

Equity ticker runs also collect live Ticker Regime Context from the regime proxy set so ticker Research Views can cite current breadth and volatility context without substituting prior Market Overview artifacts for live evidence. When Yahoo market capitalization and SEC Fundamental Evidence are both available, source collection derives supplemental Valuation Evidence from those already-collected inputs; it does not fetch peers or change ranking, scoring, or the research-only boundary. Peer valuation comps require a deterministic Peer Universe from a sourced provider or checked-in mapping with provenance.

The Evidence Request Loop runs only for `ticker --deep --asset equity` when its three env limits are nonzero. It uses the quick model and the `evidence-request` prompt stage to ask for JSON requests, validates them against enumerated public-data tools (`sec_latest_filing`, `tradier_iv_term_structure`), enforces per-run round/tool/source-unit budgets, executes tools through the same source collector seam, and merges outputs into normal Extended Evidence, Sources, raw snapshots, and `SourceGap`s before `specialist-analysis`. Malformed JSON emits a `SourceGap`, stops the loop, and continues to `specialist-analysis`. It does not use provider-native tool calling and does not add report schema fields.

The Research Subject Registry (`src/research/subject-registry.ts`, [ADR 0027](./adr/0027-subject-proxy-peer-universe-registry.md)) is a checked-in equity-only registry for the `research` run type. It maps aliases to canonical subject keys, representative instruments, provenance, and optional single listed ETF prediction proxies. The public CLI and Research Console accept `research <subject>`; report validation, historical context, artifact indexing, and search also understand `jobType: "research"`. The registry is deterministic and local; no model or provider call can create a scored thematic proxy in V1. When the command resolves to a registry entry, the report source list is extended with the entry's provenance sources tagged `kind: "reference"` so findings can cite checked-in evidence; the evidence payload gains a `registrySubject` block naming representative instruments (with live-snapshot availability) and provenance, so the model quotes named representatives rather than generic movers. Representative instruments without a live snapshot are disclosed as soft `researchRepresentative:` source gaps. When the subject resolves but has no `predictionProxy` the gate always emits an explicit gap and zero predictions. Research news relevance targets are derived from the registry entry (`researchNewsRelevanceTargets` in `src/sources/collector.ts`): the proxy symbol (with displayName and aliases as its topic name) plus all non-proxy representative symbols; these flow through the same `contextWithNewsRelevanceTargets` seam that market-update runs use, so the news ranker orders subject-relevant stories first.

All persisted-run reads go through one seam, `src/run-artifacts.ts` ([ADR 0016](./adr/0016-run-artifact-reader.md)): `loadRunArtifact`/`scanRunArtifacts` parse `report.json`, `score.json`, normalized market snapshots, and `normalized/verified-market-snapshot.json` once, leniently, at full fidelity, and callers project down to what they need. Every consumer (`historical-context`, `market-update-delta`, `scoring/index`, `history/artifacts`) reads through it — no raw `JSON.parse(...) as T` casts remain. Single-caller sidecars (supplemental snapshots, SEC fundamentals, alpha validation) stay with their one caller by design. The reader carries `scoringVersion` through so score-writing consumers preserve the version stamped on already-resolved scores. `scanRunArtifacts` stays disk-only; the derived SQLite index does not yet hydrate full `RunArtifact` payloads.

`src/run-artifact-index.ts` ([ADR 0018](./adr/0018-run-artifact-index.md)) is a rebuildable query layer over the same on-disk tree. `index rebuild` populates `data/index.sqlite` (or `MARKET_BOT_INDEX_DB_PATH`). Console list/search, history search, and calibration resolved-pair loading read the index when fresh and fall back to disk scans with a `stderr` warning when the DB is absent, stale, or on an unsupported schema version. Provider-health reports the index state and treats unsupported/unreadable schemas as blocking with rebuild guidance; missing indexes are disclosed without disabling disk fallback. Research jobs, `alpha-search`, and `score` write through affected runs after mutable sidecars change; failures are non-fatal. After each write-through, the same lane also checks freshness and triggers a full rebuild when the index is present, schema-matched, and stale — a non-fatal, best-effort-awaited side effect that stops repeated disk-scan fallbacks (see [ADR 0022](./adr/0022-stale-index-rebuild-follow-up.md)). Missing or unsupported-schema indexes keep the existing warn-and-fallback path pending `index rebuild`. `MARKET_BOT_INDEX_DISABLE=1` is the permanent escape hatch.

Historical Research Context is the prompt-time surface of **Cross-run Intelligence** (see [CONTEXT.md](../CONTEXT.md)). It scans `MARKET_BOT_DATA_DIR` run artifacts only; it never reads `data/cache`. It loads compact prior report summaries, findings, risks, catalysts, data gaps, scored prediction status, selected extras, and normalized snapshots. Prior reports are added as citeable internal `model` Sources with IDs like `history-report-<runId>`. Each selected run carries structured relevance reasons (`same-symbol`, `same-subject`, `spotlight-symbol`, `same-horizon`, `cross-horizon`) alongside its recency reasons. Same-day comparable entries are collapsed before prompt injection to reduce repeated context, while resolved-miss runs preserved by the `miss-correction` lane are never evicted by that collapse. Up to `MARKET_BOT_HISTORY_MISS_CORRECTION_LIMIT` recent resolved-miss runs are preserved with a `miss-correction` reason even when same-day reruns would otherwise evict them from the recency window. The context exposes an audit block (selection counts, `resolvedMissRunCount`, `missCorrectionSelectedCount`, `gapCount`) so the trace shows *why* each prior run was pulled in. Missing or malformed history — including an unreadable alpha-search watchlist, surfaced for market overview runs only — is recorded as a soft historical-context gap, not a provider `SourceGap`.

Prior-miss **error correction** turns resolved misses into explicit correction signal in the prompt ([ADR 0015](./adr/0015-instrument-error-correction-ticker-only.md)). Three scoped blocks stay separate: the *instrument* block (`priorThesisErrors`) fires for ticker runs on the command's own instrument and only includes missed forecasts whose parsed observable expression names that instrument; the *market-scoped* block (`priorMarketForecastErrors`) fires for market overview runs on the run's configured index/macro/crypto subjects, drawn only from prior same-horizon-bucket, same-asset market overview runs; the *thematic* block (`priorThematicForecastErrors`) fires for `research` runs that match the same subject key or prediction proxy. All render misses only — hits stay aggregate-only via calibration. Calibration prompt context includes the current market-regime slice only when it meets the named resolved-sample floor, and exact numeric market claims are steered toward deterministic snapshot citations while `history-report-*` remains narrative prior context.

The `history` CLI family uses the same artifact-only boundary for user-facing historical views. `history rebuild` derives searchable indexes and per-Instrument timelines under `data/history/` from canonical run artifacts without rewriting those runs. Per-Instrument timeline matching uses the observable-forecast DSL to include every instrument named by a Prediction expression, including market-update and relative forecasts. `history search` reads the derived index, and `history thesis-delta` compares two historical Research Thesis states. Narrative thesis-delta output is generated only when explicitly requested and is persisted with the deterministic delta input and model metadata.

Market Spotlights run only for market overview runs. Candidates are built from the current collected market snapshot universe and may be enriched with mover features, benchmark context, history availability, and alpha-search watchlist annotations. Before the selector runs, `MARKET_BOT_MARKET_SPOTLIGHT_CANDIDATE_LIMIT` caps the ranked mover list passed to the model (`0` passes every candidate). The quick-model `spotlight-selection` stage may select zero candidates up to the configured cap. Invalid selector output is audit-only. Spotlights do not fetch extra evidence, run nested ticker jobs, use provider-native tools, or auto-upgrade depth. Selected history and spotlights flow into final synthesis as compact context and can render through `report.extras` without a top-level report schema migration.

Domain Playbooks are checked-in markdown guidance snippets under `prompts/playbooks/`, registered by `prompts/playbooks/registry.json` ([ADR 0012](./adr/0012-model-requested-domain-playbooks.md)). After historical context, any eligible Evidence Request Loop, and market spotlight selection, the quick model runs the `playbook-selection` stage against slim run context and eligible candidate metadata. Valid selections are loaded into downstream prompt JSON as `domainPlaybooks`; invalid JSON, unknown IDs, invalid stages, duplicates, and cap overages are trace-only rejections. A small always-on discipline set is injected before selector output is applied: `synthesis-discipline` for `final-synthesis` on market overview, legacy daily/weekly, ticker, and research runs, and `source-discipline` for research `critique`. Selector repeats of those stage/playbook pairs are deduped. The selector does not fetch sources, use provider-native tools, or add report schema fields.

Deep runs use a fixed Coverage Panel after `specialist-analysis` and before `critique` ([ADR 0011](./adr/0011-fixed-coverage-panel-for-deep-research.md)). Market overviews run `regime-context-analysis` and `mover-theme-analysis`; ticker runs run `instrument-evidence-analysis` and `market-behavior-analysis`. The two role stages use the quick model, see the specialist output as their only prior stage, run concurrently, and are persisted in deterministic stage order. `critique` sees the specialist plus both role outputs, and `final-synthesis` sees all analyses plus critique. After final synthesis, a deterministic warning-only audit records unsupported numeric/technical claims and weak evidence posture omissions in trace and analytics; it does not mutate the report or reject Predictions. The panel does not add report schema fields.

After final synthesis, the source-plan layer records compact `sourcePlan` and `evidenceLanes` summaries in `trace.json` and `analytics.json`. Full detail stays in the three normalized sidecars; no report schema fields are added.

### Predictions and scoring (`src/scoring/`, `src/forecast/`)

- `src/forecast/observable.ts` — the shared contract: `measurableAs` parser, expression shape, validation rules, and resolution against Observations. Adding a new prediction shape starts here. The persisted public `claim` is rendered from the parsed DSL ([ADR 0020](./adr/0020-claim-rendered-from-dsl.md)). Conditional Predictions use `P(B | A)` semantics and void/exclude condition-unmet scores ([ADR 0024](./adr/0024-conditional-predictions.md)). Final synthesis treats `DepthProfile.targetPredictions` as a soft target: below-target runs ship as-is and disclose a `predictionShortfall` data gap rather than padding with coin-flip forecasts ([ADR 0021](./adr/0021-prediction-count-soft-target.md)). Report assembly also rejects adjacent same-subject direction forecasts whose horizons are fewer than two trading days apart. `ObservableForecastPolicy.allowedSubjects` provides a per-run-type emission gate: market-overview and ticker runs enforce that prediction subjects (or, for relative forecasts, the primary instrument) belong to the run's configured subject set; research runs skip this gate and rely on `researchPredictionGate` in `report-assembly.ts` instead.
- `src/scoring/observations.ts` — report-scoped Observation repository for point and window reads. Crypto scoring resolves CoinGecko IDs from Instrument Identity when present, with BTC/ETH fallback.
- `src/scoring/resolver.ts` — resolves a due prediction against Observations
- `src/scoring/index.ts` — `runScorePass` reads prior report + scores through the Run Artifact seam ([ADR 0016](./adr/0016-run-artifact-reader.md)) and writes `score.json` per prediction run, `miss-autopsy.json` for material forecast errors, Alpha validation sidecars/summaries, Alpha candidate watchlist artifacts, and Alpha lead cohort artifacts; calibration pairing reads resolved pairs from the Run Artifact Index when fresh, otherwise through the disk seam, and enriches indexed pairs with Miss Autopsy sidecars from disk
- `src/scoring/close-cache.ts` — caches successful historical-close fetches under `data/cache/closes/`
- `src/scoring/calibration.ts` + `calibration-markdown.ts` + `calibration-console.ts` — aggregate scored predictions sliced by job type and market overview horizon bucket into `data/calibration/`, including Miss Autopsy taxonomy counts; the `calibration` CLI prints a stdout reliability dashboard

Close-based predictions use provider-returned sessions: origin is the first available close at or after the report date, and horizon is the Nth available close after origin. Volatility predictions evaluate the full close window. Macro and IV predictions remain point-based. Conditional Predictions are scored in two passes: condition pending, active pending after the antecedent occurs, voided if the antecedent is false, or hit/miss after the consequent resolves.

Every research run triggers a score pass, calibration refresh, and Run Artifact Index write-through as **non-blocking** side effects. Failures there log to stderr; they must not abort the research job. The `RunAnalytics.predictions` block (in `run-analytics.ts`) includes non-blocking forecast-quality telemetry: `nearBaseRateCount` (predictions within 0.05 of 0.5), `informativeCount` (outside that band), `signalTargetMet` (boolean: at least half the predictions are informative), and `mixWarnings` (direction-only mix or all-near-base-rate cluster). These fields observe; they never reject predictions (per ADR 0021).

Adding a new prediction shape means updating: the parser in `forecast/observable.ts`, resolver, report schema, markdown renderer, and tests. All four.

### Report (`src/report/`)

Schema is the contract. Validation enforces the research-only boundary ([ADR 0001](./adr/0001-research-only-boundary.md)) and the observable-prediction rule ([ADR 0004](./adr/0004-predictions-as-observable-forecasts.md)).

### Research Console App (`app/`)

A local, research-only Svelte 5 SPA (`app/client/`) served by a Bun HTTP API (`app/server.ts`). The server reads run artifacts from `MARKET_BOT_DATA_DIR` (list/search via the Run Artifact Index with disk fallback) and exposes: `/api/runs`, `/api/runs/:id`, `/api/runs/:id/files`, `/api/search`, `/api/jobs` (same-origin POST queues whitelisted CLI jobs), `/api/provider-health`, and `/api/calibration` (both read data-root `summary.{json,md}` siblings).

Views: dashboard (metrics, runs-per-day chart, recent runs), run workspace, search, jobs, calibration, and provider health. The run workspace joins each run's `score.json` to its observable forecasts — hit/miss/pending badges with resolution evidence in neutral observation language — and joins `miss-autopsy.json` when present to show material forecast-error taxonomy without changing outcome badge semantics. For ticker runs that persisted `normalized/verified-market-snapshot.json` ([ADR 0019](./adr/0019-verified-market-snapshot.md)), it renders a recent-closes chart with latest indicator values and forecast-horizon ticks. The calibration view shows the Brier/skill headline against the coin-flip baseline, a reliability chart over sparse bins, Miss Autopsy taxonomy counts, and slice tables; the quality-of-forecasts framing lives only there, never in per-run outcome badges.

Client conventions: loose `Record<string, unknown>` payloads at the wire, validated by type guards in `app/client/api.ts`, parsed by pure functions in `app/client/view-model.ts` / `app/report-artifact-view.ts`; hand-rolled SVG charts (no chart dependency). The console stays read-only over artifacts and adds no trade-action surface.

## Data flow

```
CLI args → AppConfig → collect sources → orchestrator
                                      ├─ historical context from run artifacts
                                      ├─ regime summary
                                      ├─ optional market spotlight selection
                                      ├─ optional evidence-request loop
                                      ├─ playbook selection
                                      ├─ movers
                                      ├─ market update delta (market overview)
                                      └─ predictions
                                              ↓
                                       report (zod-validated)
                                              ↓
                                  artifacts written to data/runs/<id>/
                                              ↓
                              score pass + calibration + index write-through (side effects)
```

`score` and `calibration` CLI verbs invoke the last stage directly without a new research run. `index rebuild` fully repopulates the derived SQLite index from disk. `cache prune` removes raw cache entries older than 30 days and scorer close-cache entries older than 365 days.
`history rebuild`, `history search`, and `history thesis-delta` operate on existing artifacts only; they do not fetch fresh Source Provider data.
