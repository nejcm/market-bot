# Improvements Backlog

## Alpha search

Implemented alpha-search discovery, validation, deterministic candidate state, Source
Promotion Criteria, feature attribution, and SEC fundamentals enrichment are documented in
`docs/how-it-works.md`, `docs/architecture.md`, and `docs/configuration.md`. This
section tracks remaining expansion work.

### Next

- **Validation-data review loop** - once source groups and feature buckets have enough
  resolved Alpha validation outcomes, review which inputs actually explain excess return.
  Keep this artifact-led: propose ranking changes only from observed source criteria and
  attribution, not from intuition.
- **Expanded signal ranking experiments** based on validated deterministic features beyond
  the current discovery/ranking inputs. Keep signal strength separate from Evidence Quality,
  keep V1 rankings stable until an experiment is explicitly accepted, and document any
  ranking-policy change before implementation.
- **Alpha candidate drill-down view** for watchlist, validation, attribution, and
  fundamentals artifacts. This should be a browsing surface over existing artifacts, not a
  new report contract.

### Defer or skip

- **Narrative candidate report type** with thesis, why-now catalyst, evidence, bear case,
  risks, invalidation criteria, and source IDs. Defer until source criteria and attribution
  have enough resolved history to show Alpha leads are worth model-written reports.
- **New social/news providers** for alpha-search discovery. Defer until fundamentals
  and feature attribution have enough resolved history to show provider expansion would add
  signal instead of noise.
- **Automatic source changes** such as changing source weights, candidate budgets, or
  inclusion from criteria labels. Keep Source Promotion Criteria report-only until a ranking
  experiment is reviewed and accepted.

## Cross-run intelligence

- **Narrative thesis-delta tracking** — "what changed in the AAPL thesis since last Tuesday". Long-term notes the bot consults across runs.
- **Incremental memory** — open questions and unresolved hypotheses carried forward.
- **Session/run search** over prior reports, sources, predictions, and theses.
- Finding alpha stocks with checking the growth, PE ratio, profits, etc... and comparing over time
- Store all artifacts per stock and track stats over runs and over time by comparing against historical data

## Operational

- **Source provider health dashboard** - artifact-backed CLI validation exists via
  `provider-health` v2. Future work: turn this into a dashboard once the run history is large
  enough to need browsing/filtering.
- **Database-backed persistence** once local files become hard to query. SQLite is the likely first step;
  keep raw artifacts on disk if useful. If optimal use db only for metadata and references to files (artifacts of runs) on disk.

## Research Console

- **Run history and artifact browser** - Svelte + Bun localhost UI over existing run
  artifacts, reports, logs, analytics, and provider health.
- **Branded structured report rendering** - research-desk presentation of `report.json`
  with source-first navigation and markdown fallback.
- **Typed job controls** - later phase for allowlisted CLI jobs with basic queued/running/
  succeeded/failed status and captured output.

## Monitoring

- Reliability SLAs, monitoring, alerting.

## Other (deferred)

- based on real runs implement improvements
- https://github.com/defeat-beta/defeatbeta-api
- improvements based on other projects
  - https://github.com/TauricResearch/TradingAgents
  - https://github.com/HKUDS/Vibe-Trading
