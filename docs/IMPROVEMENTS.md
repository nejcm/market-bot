# Improvements Backlog

## Alpha search

Implemented alpha-search discovery is documented in `docs/how-it-works.md`,
`docs/architecture.md`, and `docs/configuration.md`. This section tracks remaining
promotion and expansion work after real-run validation.

- **Prerequisite validation** - keep reviewing provider-health summaries and recent artifacts
  for unresolved source gaps, Evidence Quality caps, repeat-news suppression, and prediction
  calibration before promoting alpha search to a first-class workflow.
- **Alpha signal discovery** - identify early, higher-risk research signals from market
  data, news, filings, social sources, and other public evidence. Treat social sentiment as
  high-noise input until validation shows it adds signal beyond existing sources.
- **Signal ranking** based on explainable features, not an LLM-only list. Keep
  signal strength separate from Evidence Quality.
- **Candidate report type** with thesis, why-now catalyst, evidence, bear case, risks,
  invalidation criteria, and source IDs.
- **Candidate watchlist output** that persists candidates across runs and tracks thesis
  changes over time.
- **Candidate validation loop tuning** - use the persisted 5- and 20-trading-day excess-return
  summaries to decide whether the current discovery sources merit promotion or need ranking changes.

## Cross-run intelligence

- **Watchlist + thesis-delta tracking** — "what changed in the AAPL thesis since last Tuesday". Long-term notes the bot consults across runs.
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

## Product polish

- Web frontend for browsing the run history.
- Branding, themed report rendering.
- Reliability SLAs, monitoring, alerting.
- https://github.com/defeat-beta/defeatbeta-api

## Other (deferred)

- based on real runs implement improvements
- improvements based on other projects
  - https://github.com/TauricResearch/TradingAgents
  - https://github.com/HKUDS/Vibe-Trading
