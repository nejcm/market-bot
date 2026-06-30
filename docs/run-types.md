# Run Type Flow Reference

This document describes how each CLI run type is parsed, configured, which data it
collects, which model stages it executes, and what artifacts it produces.

## 1. Common Infrastructure

### Run Type Registry

The seven research/analysis run identities are declared in
`src/domain/run-types.ts` via `RUN_TYPE_REGISTRY`. The registry still includes
legacy `daily` and `weekly` for artifact/history compatibility, but the public
CLI parser normalizes new `daily` / `weekly` invocations into canonical
`market-overview` commands with a `legacyAlias`.

| Run Type          | Asset Handling         | Depth Flag | Instrument | Web Gather | Evidence Request | Synthesis Report |
| ----------------- | ---------------------- | ---------- | ---------- | ---------- | ---------------- | ---------------- |
| `market-overview` | `--asset` required     | yes        | no         | no         | no               | yes              |
| `daily`           | legacy alias           | yes        | no         | no         | no               | yes              |
| `weekly`          | legacy alias           | yes        | no         | no         | no               | yes              |
| `equity`          | implied equity         | yes        | yes        | yes        | yes              | yes              |
| `crypto`          | implied crypto         | yes        | yes        | yes        | no               | yes              |
| `alpha-search`    | fixed `--asset equity` | yes        | no         | no         | no               | no               |
| `research`        | implied equity         | yes        | no         | yes        | no               | yes              |

Operational commands (`score`, `calibration`, `cache-prune`, `provider-health`,
`history-*`, `index-rebuild`) are not research run types.

### Config Resolution

Run params resolve via the fallback chain in
`src/config/runs/resolver.ts`:

1. `CODE_DEFAULTS` (code defaults in `src/config/runs/profiles/shared.ts`).
2. `AppConfig` env overrides (`quickModel`, `synthesisModel`, `modelParams`).
3. Profile block from `src/config/runs/profiles/*.ts`.
4. The profile's `deep:` sub-block when `depth === "deep"`.

Run key mapping (`toRunKey`):

- `equity` / `crypto` &rarr; `equity` / `crypto`.
- `research` &rarr; `research-equity`.
- `market-overview` &rarr; `market-overview-{assetClass}`. Deprecated
  `daily` / `weekly` CLI invocations are normalized before config resolution.

### Source Collection

`collectSources(command, sourceOptions, { peerUniverse })` in
`src/sources/collector.ts` is called for every research run. It:

1. Creates a `CollectContext` with API tokens, timeouts, retry delays, and cache
   options.
2. Uses `SourceRegistry` (`src/sources/registry.ts`) to pick adapters per asset
   class:
   - `marketDataFor` — primary market data (Yahoo for equity, CoinGecko for
     crypto).
   - `supplementalMarketDataFor` — supplemental market data (Massive, etc.).
   - `newsFor` — news adapters.
   - `extendedEvidenceFor` — SEC/FRED/Tradier/Glassnode/etc.
   - `marketContextFor` — macro context (FRED).
3. Sequences collection differently:
   - Market-update and ticker runs collect market data **before** news so movers
     or resolved instrument identity can steer news selection.
   - Research runs resolve registry-based news relevance targets in parallel.
4. Runs post-collection enrichment:
   - Verified market snapshot and canonical instrument identity.
   - Valuation evidence, financial lens, business framework.
   - Yahoo fundamentals.
   - Earnings setup + implied move (deep equity tickers only).

### Orchestrator Pipeline

For synthesis-report runs, `runResearchJob` in
`src/research/orchestrator.ts` executes:

1. Build initial `ResearchContext` (market regime, depth profile, calibration
   context).
2. Load historical context.
3. Run the **evidence-request loop** (deep US equity tickers only).
4. Run the **web-gather loop** (deep runs whose run type supports web gather, Exa
   key present, budgets positive).
5. Run **web-subject-profile extraction** on gathered web sources.
6. Reconcile business framework with web subject profile if possible.
7. For market-update runs: spotlight selection, mover ranking, market-update
   delta.
8. Build the **source plan** and assess **evidence quality**.
9. Run playbook selection &rarr; specialist-analysis &rarr; coverage panels
   &rarr; critique &rarr; final-synthesis.
10. Optional **forecast-disagreement** stage (deep runs with challenger models).
11. Build trace, analytics, render markdown, persist artifacts.
12. The CLI then runs a **score pass** for synthesis-report research runs and
    updates the run artifact index.

---

## 2. `market-overview`

### CLI

```sh
market-bot market-overview --asset equity|crypto [--horizon 1-20] [--deep] [prompt]
```

- `--asset` is required.
- `--horizon` is optional; default is 15 trading days.
- `prompt` is an optional positional steering phrase.

Command shape: `MarketOverviewCommand` with `jobType: "market-overview"`,
`assetClass`, `depth`, `horizonTradingDays`, optional `prompt`, and optional
`legacyAlias`.

### Config

Resolves to run key `market-overview-{assetClass}`:

- `market-overview-equity` profile.
- `market-overview-crypto` profile.

| Param                      | Brief                                                                                                | Deep                 |
| -------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------- |
| `minimumKeyFindings`       | 3                                                                                                    | 5                    |
| `minimumScenarios`         | 1                                                                                                    | 3                    |
| `targetPredictions`        | 2                                                                                                    | 3                    |
| `defaultPredictionHorizon` | 15                                                                                                   | 15                   |
| `predictionSubjects`       | Equity: SPY, QQQ, ^VIX, DGS10, DGS2, T10Y2Y, FEDFUNDS, CPIAUCSL, UNRATE, DTWEXBGS. Crypto: BTC, ETH. | Same as brief.       |
| `focus`                    | market regime, movers, narratives, catalysts, risks, source gaps                                     | + cross-asset themes |
| `analystStyle`             | concise brief                                                                                        | fuller analyst-style |
| `targetKindMix`            | Equity: relative/macro/volatility. Crypto: relative/range.                                           | `minNonDirection: 2` |

### Data Collected

- Market snapshots for the asset class (Yahoo for equity, CoinGecko for crypto).
- Supplemental market data (Massive for equity).
- News, ranked by relevance to top movers.
- Market context / macro indicators (FRED).
- No instrument-level extended evidence (SEC filings, options IV, earnings).
- No verified market snapshot, no identity resolution, no earnings setup.

### Model Stages

- Planned stages: `specialist-analysis`, coverage panels (deep only),
  `critique`, `final-synthesis`.
- Deep coverage panels for market updates:
  `regime-context-analysis`, `mover-theme-analysis`.
- Optional user steering prompt is injected into spotlight-selection and
  final-synthesis.
- Spotlight selection runs: the model selects top movers from ranked candidates.
- Market-update delta is computed against prior runs.

### Predictions

- Allowed subjects = `predictionSubjects` from config.
- The emission gate rejects predictions whose subject (or primary instrument for
  relative forecasts) is not in that set.
- Target predictions: 2 brief / 3 deep.

### Output Artifacts

Standard research artifacts (report, markdown, trace, analytics, stages, source
plan, evidence lanes, source ledger, historical context) plus market-update
extras: spotlights, movers, market-update delta, and catalyst calendar.

---

## 3. `daily` and `weekly` (Legacy Market Update)

### CLI

```sh
market-bot daily --asset equity|crypto [--deep]
market-bot weekly --asset equity|crypto [--deep]
```

- `--asset` is required.
- No `--horizon` flag.

CLI parse result: canonical `MarketOverviewCommand` with
`jobType: "market-overview"`, fixed `horizonTradingDays`, and
`legacyAlias: "daily" | "weekly"`. Old persisted artifacts can still carry
`jobType: "daily"` or `"weekly"` and remain readable through artifact/history
paths.

### Config

Both map to `market-overview-{assetClass}` profile (same as
`market-overview`). The horizon is fixed:

- `daily` &rarr; 5 trading days.
- `weekly` &rarr; 15 trading days.

For new CLI and Research Console runs, `resolveRunParams` receives the
canonical market-overview command and uses `horizonTradingDays` for
`defaultPredictionHorizon`. Legacy `daily` / `weekly` values remain valid only
as persisted `JobType` values on artifact/history read paths.

### Data and Stages

Identical to `market-overview` except:

- `horizonTradingDays` is fixed.
- Trace and report extras record `legacyMarketUpdateAlias: "daily" | "weekly"`
  on new alias-invoked runs. Read paths still map old `marketUpdateCadence`
  artifacts into horizon buckets.
- Horizon bucket is derived from the fixed horizon.

This is the legacy alias path per ADR 0025 (market-overview fold).

---

## 4. `equity` (Single Ticker)

### CLI

```sh
market-bot equity <symbol> [--deep]
```

- Symbol is required as a positional argument.
- `--asset` is not allowed because it is implied to be `equity`.

Command shape: `InstrumentCommand` with `jobType: "equity"`,
`assetClass: "equity"`, `symbol`, and `depth`.

### Config

Run key `equity` &rarr; `INSTRUMENT_RUN_PARAMS` profile in
`src/config/runs/profiles/shared.ts`.

| Param                      | Brief                                | Deep                                    |
| -------------------------- | ------------------------------------ | --------------------------------------- |
| `minimumKeyFindings`       | 4                                    | 6                                       |
| `minimumScenarios`         | 1                                    | 3                                       |
| `targetPredictions`        | 3                                    | 5                                       |
| `defaultPredictionHorizon` | 5                                    | 5                                       |
| `predictionSubjects`       | `[symbol]`                           | `[symbol]`                              |
| `focus`                    | thesis, evidence, risks, data gaps   | + catalysts, bull/bear cases, scenarios |
| `analystStyle`             | concise brief                        | fuller analyst-style                    |
| `targetKindMix`            | relative/range, `minNonDirection: 1` | `minNonDirection: 2`                    |

### Data Collected

- Market snapshot for the ticker plus a benchmark snapshot.
- Supplemental market data.
- News relevance targets = the ticker symbol (plus display name if available).
- Extended evidence:
  - SEC EDGAR filings.
  - FRED macro indicators.
  - Finnhub corporate events.
  - Tradier options IV / term structure.
  - Valuation evidence.
  - Financial lens.
  - Business framework.
- Verified market snapshot (Yahoo OHLCV + indicators) for equity tickers.
- Canonical instrument identity.
- Earnings setup + implied move (deep only).
- Deep equity tickers also enable the **evidence-request loop** and
  **peer-universe fallback** for valuation comps.

### Evidence-Request Loop

Enabled only for deep `equity` runs when budgets are positive. Tools:

- `sec_latest_filing`
- `tradier_iv_term_structure`

Only available for US listings. Requests must match the run symbol.

### Web-Gather Loop

Enabled for deep `equity` runs when an Exa key is present and budgets are
positive. Subject kind = `company`. Searches and fetches must mention the
company symbol or display name.

### Model Stages

- Planned stages: `specialist-analysis`, `instrument-evidence-analysis`,
  `market-behavior-analysis` (deep), `critique`, `final-synthesis`.
- Business framework and earnings-setup instructions are added to the
  final-synthesis prompt.
- Forecast diversity guidance enumerates direction, relative, range, IV,
  earnings, and conditional shapes.

### Predictions

- Allowed subjects = `{symbol}`.
- Web subject profile instruction warns the model not to widen prediction
  subjects.

### Output Artifacts

Standard research artifacts plus instrument-only sidecars: verified market
snapshot, instrument identity, valuation comps, financial lenses, and business
framework.

---

## 5. `crypto` (Single Ticker)

### CLI

```sh
market-bot crypto <symbol> [--deep]
```

### Config

Run key `crypto` &rarr; `INSTRUMENT_RUN_PARAMS` profile (same params as equity).

### Data Collected

- Market snapshot for the crypto ticker (CoinGecko).
- News relevance targets = the symbol.
- Extended evidence:
  - On-chain metrics (Glassnode) when API key is present.
  - No SEC filings, no options IV, no earnings.
- No verified market snapshot sidecar.
- No evidence-request loop (`supportsEvidenceRequest: false`).
- Web-gather loop enabled for deep runs (Exa key + budgets).

### Model Stages

Same as equity, with coverage panels `instrument-evidence-analysis` and
`market-behavior-analysis`.

### Predictions

Allowed subjects = `{symbol}`.

---

## 6. `research` (Thematic Subject)

### CLI

```sh
market-bot research <subject> [--deep]
```

- Subject is required as a positional phrase.

Command shape: `ResearchSubjectCommand` with `jobType: "research"`,
`assetClass: "equity"`, `subject`, and `depth`.

Before execution, `enrichResearchSubjectCommand` in `src/app.ts` resolves the
subject via `resolveResearchSubjectProxy`:

- If a registry match is found, it sets `subjectKey` and optionally
  `predictionProxySymbol`.
- If no match, the command proceeds with an unresolved subject.

### Config

Run key `research-equity` &rarr; `researchEquityProfile`.

| Param                      | Brief                                                               | Deep                   |
| -------------------------- | ------------------------------------------------------------------- | ---------------------- |
| `minimumKeyFindings`       | 3                                                                   | 5                      |
| `minimumScenarios`         | 1                                                                   | 3                      |
| `targetPredictions`        | 2 (or 0 if no proxy)                                                | 3 (or 0 if no proxy)   |
| `defaultPredictionHorizon` | 15                                                                  | 15                     |
| `predictionSubjects`       | `[]` (filled with proxy if resolved)                                | Same as brief.         |
| `focus`                    | subject evidence, proxy evidence, representatives, risks, data gaps | + catalysts, scenarios |
| `targetKindMix`            | range only                                                          | `minNonDirection: 2`   |

`targetPredictions` becomes `0` if the resolved subject has no
`predictionProxy`.

### Subject Registry

The checked-in registry in `src/research/subject-registry.ts` maps aliases such
as `semis`, `chip stocks`, or `ai infrastructure` to:

- `subjectKey`, `displayName`.
- Representative instruments (ETFs and stocks).
- Optional `predictionProxy` (must be a listed ETF).
- Provenance sources (`kind: "reference"`).

### Data Collected

- Market snapshots for the asset class (`equity`).
- News relevance targets derived from the registry entry:
  - Proxy symbol with `displayName` + aliases as topic name.
  - All non-proxy representative symbols.
- Extended evidence: same equity lanes as an `equity` run, applied only if a
  proxy or instrument identity resolves.
- No evidence-request loop.
- Web-gather loop enabled for deep runs; subject kind = `theme` or `company`
  depending on the registry entry.

### Registry Provenance

- Report source list is extended with registry provenance sources.
- Evidence payload includes a `registrySubject` block with representative
  instruments and `hasLiveSnapshot` flags.
- Representative instruments without live snapshots become disclosed
  `researchRepresentative:` gaps.

### Predictions

`researchPredictionGate` in `src/research/report-assembly.ts` is the authority:

- If no proxy resolved &rarr; 0 predictions, explicit gap.
- If proxy resolved but no market snapshot for proxy &rarr; 0 predictions, gap.
- Otherwise predictions are filtered to the proxy subject only.

No `allowedSubjects` is set from `runParams` (passed as `undefined` to avoid
a double-drop).

### Model Stages

Same orchestrator pipeline; mandatory `source-discipline` playbook for
`critique`.

### Output Artifacts

Standard research artifacts plus `webSubjectProfile`.

---

## 7. `alpha-search`

### CLI

```sh
market-bot alpha-search --asset equity [--deep]
```

- Only `--asset equity` is supported in V1.

### Config

Uses `alphaSearchOptions` from `AppConfig` (env-driven):

- ApeWisdom filter and page limits.
- SEC form types and discovery limit.
- Validation, lead, and candidate limits.
- Price / volume / market-cap eligibility bands.

No synthesis run params; no model predictions.

### Workflow

`runAlphaSearchWorkflow` in `src/alpha-search/workflow.ts` executes:

1. **ApeWisdom discovery** — collect social-momentum candidates.
2. **Social momentum ranking** — rank candidates.
3. **SEC filing discovery** — discover recent filing candidates.
4. **Listed-universe filter** — filter through Nasdaq/Cboe official lists; reject
   ETFs, inactive, test issues, etc.
5. **Yahoo validation** — validate remaining candidates as listed stocks meeting
   price/volume/market-cap bands.
6. **Fundamentals collection** — SEC fundamental metrics for validated leads.
7. Build report with `researchLeads` and `rejectedCandidates`.
8. Persist alpha-search-specific artifacts.

### Stages

Hard-coded trace stages (no LLM pipeline):

- `apewisdom-discovery`
- `social-momentum-ranking`
- `sec-filing-discovery`
- `official-listed-universe-filter`
- `yahoo-validation`
- `alpha-search-report`

### Output

- `jobType: "alpha-search"`, `assetClass: "equity"`.
- No predictions; no calibration side effects.
- Evidence quality is `medium` if valid leads exist and no core gaps, else
  `low`.
- Artifacts: social candidates, SEC discovery candidates, alpha-search
  candidates, listed universe, research leads, SEC fundamentals, rejected
  candidates, candidate profiles, analytics.

### Post-Run

`alpha-search` itself only runs the deterministic discovery workflow and run
artifact index update. It does not run the post-research score pass because it
emits no predictions. The separate `score` command later updates alpha
validation summaries, feature attribution, candidate watchlist, and lead cohorts
from persisted alpha-search artifacts.

---

## 8. Operational Commands

All are handled directly in `src/app.ts`.

### `score`

```sh
market-bot score
```

- Calls `runScorePass(config.dataDir, now, scorePassOptions)`.
- Iterates every run directory, scores unresolved predictions, writes
  `score.json`.
- Builds/writes miss autopsy, alpha validation, candidate profiles, watchlist,
  cohorts, and feature attribution.
- Then calls `buildAndWriteCalibration`.
- Updates the run artifact index.

### `calibration`

```sh
market-bot calibration
```

- Calls `buildAndWriteCalibration(config.dataDir)`.
- Loads resolved prediction pairs from the index (or disk fallback), builds
  Brier/skill calibration by job type, horizon bucket, asset class, and market
  regime.
- Writes `calibration/summary.json` and `calibration/summary.md`.

### `cache prune`

```sh
market-bot cache prune
```

- Calls `pruneCache({ dir, now, rawRetentionDays: 30, closeRetentionDays: 365 })`.

### `provider-health`

```sh
market-bot provider-health
```

- Calls `writeProviderHealthSummary(config.dataDir)`.
- Writes provider health markdown and JSON.

### `index rebuild`

```sh
market-bot index rebuild
```

- Calls `rebuildRunArtifactIndex(config.dataDir, { dbPath? })`.
- Rebuilds the SQLite index of run artifacts and search entries.

### `history rebuild`

```sh
market-bot history rebuild
```

- Calls `rebuildHistoryArtifacts(config.dataDir, now)`.
- Rebuilds instrument timelines and the history search index.

### `history search`

```sh
market-bot history search --query <text> [--symbol] [--asset] [--job-type] [--from] [--to] [--section] [--provider] [--limit]
```

- Rebuilds history artifacts if stale.
- Calls `searchHistoryIndex` with filters.
- Renders search results.

### `history thesis-delta`

```sh
market-bot history thesis-delta <symbol> [--asset equity|crypto] [--since] [--to] [--narrative]
```

- Rebuilds history artifacts if stale.
- If `--narrative` is set, creates a provider and runs a model-based narrative
  delta.
- Calls `buildThesisDelta` and renders it.

---

## 9. Model Calls and Prompts

### Models

- `quickModel` for all stages except final-synthesis and forecast-disagreement.
- `synthesisModel` for final-synthesis.
- Challenger models for forecast-disagreement.
- Provider selected by `MARKET_BOT_PROVIDER` (`openai`, `openai-compatible`,
  `codex`, or `anthropic`).

### Prompt Construction

`buildStagePrompt` in `src/research/research-context.ts` builds a JSON prompt
containing:

- `instruction`, `stage`, `stageGoal`.
- `depthProfile`.
- `evidence` payload (market snapshots, news, extended evidence, gaps,
  historical context, etc.).
- `priorStages`.
- `requiredShape`.
- For final-synthesis: prediction instructions, kind-mix guidance, allowed
  source IDs, and conditional / earnings / business-framework / web-profile
  instructions.

### Final Synthesis Loop

`synthesizeReportUntilValid` in `src/research/final-synthesis.ts`:

1. Runs final-synthesis.
2. Parses predictions and validates them against known source IDs and allowed
   subjects.
3. Up to 2 reprompts for hard prediction errors.
4. One replacement attempt if redundant trims dropped the count below target.
5. If report assembly throws, retries final-synthesis with validation errors.
6. Post-synthesis audit runs but is warning-only telemetry.

---

## 10. Post-Research Score Pass

After every synthesis-report research run:

1. `runScorePass` scores all predictions in all run directories.
2. `buildAndWriteCalibration` updates the calibration summary.
3. `updateRunArtifactIndex` writes new run directories to the index and rebuilds
   if stale.

This happens inside `runCli` after `market-overview`, legacy alias,
`equity`, `crypto`, and `research` runs. `alpha-search` skips this score pass
and only writes its own run directory through the index; alpha validation and
candidate-state rollups are produced by a later `score` run.
