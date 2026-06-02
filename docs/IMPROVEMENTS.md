# Improvements Backlog

## Validation

- **Provider-health v2 validation baseline** - `provider-health` now emits an explicit
  `pass`, `warn`, or `fail` verdict with required run coverage, blocking issue counts,
  nonblocking provider coverage gaps, and per-route classifications.
- **Baseline provider expectation** - FRED is baseline-required once `MARKET_BOT_FRED_API_KEY`
  is expected/configured; missing or failed FRED coverage is a validation failure. Glassnode
  and Tradier remain optional, Massive remains supplemental-only, and MarketAux/Finnhub
  individual gaps are warnings when another usable news source exists.
- **International equity coverage gaps** - validation accepts an international equity ticker
  smoke run and treats US-centric unsupported coverage, such as SEC or Tradier gaps on
  international tickers, as expected rather than blocking.
- **Prediction minimum validation** - crypto daily runs now retry bounded model shortfalls
  before accepting an under-filled prediction set. Keep watching future artifacts for
  repeated retry failures before expanding candidate discovery.

## Alpha search

Next major research feature after real-run validation; includes evidence-backed candidate discovery as one output of the alpha-search workflow.

- **Prerequisite validation** - keep reviewing provider-health summaries and recent artifacts
  for unresolved source gaps, Evidence Quality caps, repeat-news suppression, and prediction
  calibration before promoting alpha search to a first-class workflow.
- **Alpha signal discovery** - identify early, higher-risk research signals from market
  data, news, filings, social sources, and other public evidence. Treat social sentiment as
  high-noise input until validation shows it adds signal beyond existing sources.
- **Candidate discovery output** - reuse V1 source adapters, mover discovery, Evidence
  Quality, citations, and run artifacts to surface evidence-backed research candidates as
  alpha-search leads, not as a separate product workflow.
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

## Social sentiment

(X, Reddit, StockTwits) - high noise; defer until calibration shows that it adds signal beyond current news and market-data sources.

## Research quality of regime / movers

- **Mover ranking** - currently blends momentum, liquidity, and available unusual-volume
  or gap-size Mover Features. Sector-relative movement and short-interest remain deferred
  until provider depth supports them.
- **Benchmark-relative mover analysis** so a stock is compared against its sector/index
  instead of only absolute movement.

## Pipeline and orchestration

- **Evidence Request Loop expansion** - V1 is implemented for deep equity ticker runs with
  bounded SEC latest-filing and Tradier IV term-structure tools. Future work: consider crypto,
  daily/weekly, or additional public-data tools only after real-run validation shows the loop
  improves evidence quality without adding noisy fetches.

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
- **Provider credential completion** - configure non-empty FRED credentials for baseline
  validation, and decide whether optional Glassnode, Tradier, and Massive account coverage
  should be enabled or left as expected source gaps.
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

## Explicitly separate / out of scope

These ideas may be useful, but they should not be added to V1 research generation without a
separate boundary decision.

- **Trade journal import** for broker CSV/Excel exports. If pursued, keep it local-only,
  avoid broker credentials, avoid trade recommendations, and do not feed personal trading
  data into public research artifacts.
- **Behaviour diagnostics** such as holding period, win rate, overtrading, disposition effect,
  anchoring, and momentum chasing. Diagnostics must describe historical behavior only; no
  instructions to buy, sell, hold, size, enter, exit, rebalance, or change allocation.
- **Shadow-account-style analysis** inspired by Vibe-Trading. This belongs outside
  `market-bot` unless an ADR defines a separate personal analytics tool.
- **Manual decision review loop** where the user can mark whether a Research View influenced a
  decision and whether that was useful later. Keep it separate from report generation and
  model prompts unless a privacy/safety design is accepted.
- **Decision layer or portfolio tooling**. Any system that recommends trade actions, sizing,
  execution, allocation, or portfolio changes must live outside V1 research generation per ADR 0001.
