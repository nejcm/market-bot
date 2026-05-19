# Architecture

`market-bot` is a Bun + TypeScript CLI that produces sourced research views and scores its own predictions. See [CONTEXT.md](../CONTEXT.md) for domain terms.

## Layout

```
src/
  app.ts              CLI glue (dispatches by jobType)
  cli/args.ts         Argument parsing
  config.ts           Env-driven AppConfig
  domain/             Instrument, AssetClass, Depth, Prediction, ResearchReport
  model/              OpenAI / OpenAI-compatible provider
  movers/             Deterministic mover ranking
  report/             Report schema (zod) + markdown renderer
  research/           Orchestrator + regime summary
  scoring/            Prediction DSL, resolver, scoring, calibration aggregator
  sources/            Yahoo, CoinGecko, news, collector with retry/backoff
tests/                Bun test suites
docs/adr/             Architecture decision records
plans/                Curated planning docs (humans only)
data/                 Run artifacts and calibration output (gitignored)
```

Keep files cohesive — soft target 200–400 lines, hard limit 800.

## Subsystems

### Sources (`src/sources/`)

External fetching only. Retry and backoff live at the adapter, not in callers. Respect `MARKET_BOT_SOURCE_TIMEOUT_MS`. Mock at this seam in tests, not at `fetch`.

Notable inputs:
- Equity movers: Yahoo `day_gainers`
- Crypto movers: CoinGecko 24h change
- Historical closes (for scoring): Yahoo (equities), CoinGecko (crypto)

A file-based cache (`data/cache/<YYYY-MM-DD>/<sha256-of-url>.json`) wraps all `fetchJsonOrGap` calls. Same-day re-runs return cached payloads without hitting the network. If a live fetch fails and a cached entry exists within `MARKET_BOT_CACHE_FALLBACK_DAYS` (default 7), that entry is returned and a `SourceGap` is emitted disclosing the staleness.

Weekly updates use the same mover inputs as daily — this is a cadence and horizon change, not a separate data product. Reports must disclose it as a source gap.

### Research (`src/research/`)

The orchestrator coordinates: collect sources → summarize regime → produce report → emit predictions. It is also the home for the deterministic market-regime summary.

### Predictions and scoring (`src/scoring/`)

- `dsl.ts` — parses prediction expressions
- `resolver.ts` — resolves a due prediction against historical closes
- `index.ts` — `runScorePass` writes `score.json` per run
- `calibration.ts` + `calibration-markdown.ts` — aggregate scored predictions sliced by cadence (daily / weekly / ticker) into `data/calibration/`

Every research run triggers a score pass and calibration refresh as a **non-blocking** side effect. Failures there log to stderr; they must not abort the research job.

Adding a new prediction shape means updating: DSL, resolver, report schema, markdown renderer, and tests. All five.

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

`score` and `calibration` CLI verbs invoke the last stage directly without a new research run.
