# Improvements Backlog


## Near-term focus

- **Real-run validation** - exercise ticker Extended Evidence, market-update data gaps,
  persistent news dedupe, scoring, and calibration over real runs before adding candidate
  discovery.
- **Alpha search** - next major research feature after real-run validation; includes
  evidence-backed candidate discovery as one output of the alpha-search workflow.
- **Social sentiment** (X, Reddit, StockTwits) - high noise; defer until calibration shows
  that it adds signal beyond current news and market-data sources.

## Research backlog

### Alpha search (v2)

- **Prerequisite validation** - review recent daily, weekly, and ticker artifacts for source
  gaps, Evidence Quality caps, repeat-news suppression, and prediction calibration before
  promoting alpha search to a first-class workflow.
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

### Sources and data depth (v3)

- **SEC/EDGAR segment and guidance enrichment** - add segment/geography revenue extraction,
  guidance-change extraction from filings, and deeper thesis support beyond current
  Fundamental Evidence.

### Research quality of regime / movers (v4)

- **Regime inference depth** - currently proxy deltas (`src/research/regime.ts`); could
  incorporate breadth (advancers/decliners), sector dispersion, term structure, or credit
  spreads.
- **Mover ranking** - currently blends momentum, liquidity, and available unusual-volume
  or gap-size Mover Features. Sector-relative movement and short-interest remain deferred
  until provider depth supports them.
- **Benchmark-relative mover analysis** so a stock is compared against its sector/index
  instead of only absolute movement.

## Platform backlog

### Pipeline and orchestration (v2)

- **Tool-use / agentic loop** - let the model request additional fetches mid-run (e.g.
  "pull EDGAR 10-Q for X", "fetch IV term structure"). Currently fixed-shot. Any loop must
  use enumerated tools, validated arguments, max rounds, source budgets, public-data-only
  providers, and the existing timeout/cache/rate-limit/`SourceGap` behavior.
- **Multi-agent debate** beyond specialist -> critique -> synthesis.
- **TradingAgents-style research committee** with bull/bear researchers, risk personas, and a
  research-only evidence/risk summarizer. This must not introduce portfolio-manager behavior,
  trade actions, position sizing, execution instructions, or portfolio-change language.
- **Vibe-Trading-style skill system** where domain playbooks are loaded on demand to keep
  prompts smaller while preserving specialized guidance.
- **Swarm/team presets** for macro desk, crypto desk, earnings desk, risk committee, or global allocation research.

### Cross-run intelligence (v2)

- **Watchlist + thesis-delta tracking** — "what changed in the AAPL thesis since last Tuesday". Long-term notes the bot consults across runs.
- **Semantic dedup of news sources** - broaden exact canonical-URL repeat suppression if real
  runs show headline clustering still dominates reports.
- **Incremental memory** — open questions and unresolved hypotheses carried forward.
- **Session/run search** over prior reports, sources, predictions, and theses.

### Operational (v3)

- **Decouple the scoring pass** into its own scheduled job (daily after US close, ~21:30 UTC).
  Decide whether this replaces or complements the current non-blocking score/calibration
  side effect on research runs. Include idempotency, locking, market-calendar handling,
  GitHub Actions artifact persistence, and calibration refresh timing.
- **Database-backed persistence** once local files become hard to query. SQLite is the likely first step; keep raw artifacts on disk if useful.
  If optimal use db only for metadata and references to files (artifacts of runs) on disk.

## Product polish (v3)

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
  execution, allocation, or portfolio changes must live outside V1 research generation per ADR
  0001.
