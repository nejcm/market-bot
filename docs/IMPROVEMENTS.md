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
- **Candidate validation loop** that scores whether candidates later outperformed relevant
  benchmarks over declared horizons. Validation must resolve from public market data and stay
  within the observable-forecast boundary.

## Research quality of regime / movers

- **Benchmark-relative ranking or universe expansion** - daily and weekly equity movers include
  citeable benchmark-relative context in V1. Future work can decide whether relative movement
  should affect ranking or whether mover collection should include a broader universe.

## Cross-run intelligence

- **Watchlist + thesis-delta tracking** — "what changed in the AAPL thesis since last Tuesday". Long-term notes the bot consults across runs.
- **Semantic dedup of news sources** - broaden exact canonical-URL repeat suppression if real
  runs show headline clustering still dominates reports.
- **Incremental memory** — open questions and unresolved hypotheses carried forward.
- **Session/run search** over prior reports, sources, predictions, and theses.

## Operational

- **Source provider health dashboard** - artifact-backed CLI validation exists via
  `provider-health` v2. Future work: turn this into a dashboard once the run history is large
  enough to need browsing/filtering.
- **Database-backed persistence** once local files become hard to query. SQLite is the likely first step;
  keep raw artifacts on disk if useful. If optimal use db only for metadata and references to files (artifacts of runs) on disk.

## Product polish

Relevant only if the framing drifts from "research substrate for me" toward "shareable product":

- Web frontend for browsing the run history.
- Branding, themed report rendering.
- Reliability SLAs, monitoring, alerting.
- Shareable artifacts (signed JSON, RSS feed of recent runs).

## Other

- finding alpha stocks with checking the growth, PE ratio, profits, over time
- store all artifacts about stocks and track stats over runs and over time
- based on real runs implement improvements
- improvements based on other projects
  - https://github.com/TauricResearch/TradingAgents
  - https://github.com/HKUDS/Vibe-Trading
