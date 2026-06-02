# Improvements Backlog

## Alpha search

Active V1 workflow for Reddit-first candidate discovery; remaining items describe promotion and future expansion after real-run validation.

- **Prerequisite validation** - keep reviewing provider-health summaries and recent artifacts
  for unresolved source gaps, Evidence Quality caps, repeat-news suppression, and prediction
  calibration before promoting alpha search to a first-class workflow.
- **Alpha signal discovery** - identify early, higher-risk research signals from market
  data, news, filings, social sources, and other public evidence. Treat social sentiment as
  high-noise input until validation shows it adds signal beyond existing sources.
- **Candidate discovery output** - current V1 uses Reddit discussion, deterministic ranking,
  Yahoo validation, Evidence Quality, citations, and run artifacts to surface research
  candidates as alpha-search leads, not as a separate product workflow.
  No buy/sell/hold calls, sizing, execution language, portfolio-change language, or
  expected-return recommendations.
- **Signal ranking** based on explainable features, not an LLM-only list. Keep
  signal strength separate from Evidence Quality.
- **Candidate report type** with thesis, why-now catalyst, evidence, bear case, risks,
  invalidation criteria, and source IDs.
- **Candidate watchlist output** that persists candidates across runs and tracks thesis
  changes over time.
- **Factor-style research inspired by Vibe-Trading Alpha Zoo** - factor registry, factor
  metadata, benchmark jobs, and lookahead/purity tests if quant-style research becomes useful.
- **Candidate validation loop** that scores whether candidates later outperformed relevant
  benchmarks over declared horizons. Validation must resolve from public market data and stay
  within the observable-forecast boundary.

## Research quality of regime / movers

- **Mover ranking** - currently blends momentum, liquidity, and available unusual-volume
  or gap-size Mover Features. Sector-relative movement and short-interest remain deferred
  until provider depth supports them.
- **Benchmark-relative mover analysis** so a stock is compared against its sector/index
  instead of only absolute movement.


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
- **Decouple the scoring pass** into its own scheduled job (daily after US close, ~21:30 UTC).
  Decide whether this replaces or complements the current non-blocking score/calibration
  side effect on research runs. Include idempotency, locking, market-calendar handling,
  GitHub Actions artifact persistence, and calibration refresh timing.
- **Database-backed persistence** once local files become hard to query. SQLite is the likely first step;
  keep raw artifacts on disk if useful. If optimal use db only for metadata and references to files (artifacts of runs) on disk.

## Product polish

Relevant only if the framing drifts from "research substrate for me" toward "shareable product":

- Web frontend for browsing the run history.
- Branding, themed report rendering.
- Reliability SLAs, monitoring, alerting.
- Shareable artifacts (signed JSON, RSS feed of recent runs).
