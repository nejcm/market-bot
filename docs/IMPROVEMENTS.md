# Improvements Backlog

---

## Near-term focus

- **Alpha discovery** — still deferred until the deeper data surface and source reliability have been exercised over real runs. Also socials like reddit groups,...
- **Social sentiment** (X, Reddit, StockTwits) — high noise, defer until calibration tells us if it earns its keep.

## Alpha discovery (v2)

- **Alpha discovery workflow** — deferred until the ticker Extended Evidence layer has been exercised over real runs and remaining market-update data gaps are addressed. Reuse the V1 source adapters, mover discovery, Evidence Quality, citations, and run artifacts to produce early investment/research candidates without trade actions.
- **Alpha candidate ranking** based on explainable features, not an LLM-only list. Keep attractiveness separate from Evidence Quality.
- **Alpha report type** with thesis, why-now catalyst, evidence, bear case, risks, invalidation criteria, and source IDs.
- **Alpha watchlist output** that persists candidates across runs and tracks thesis changes over time.
- **Factor-style research inspired by Vibe-Trading Alpha Zoo** — factor registry, factor metadata, benchmark jobs, and lookahead/purity tests if quant-style alpha becomes useful.
- **Alpha validation loop** that scores whether candidates later outperformed relevant benchmarks over declared horizons.

## Sources & data depth (v3)

- **Additional paid/provider-backed source adapters** such as Polygon, Alpha Vantage, NewsAPI, GDELT, CoinMarketCap, or CryptoCompare.
- **SEC/EDGAR enrichment** beyond compact ticker filing/fact summaries, such as segment data, guidance-change extraction, and richer fundamentals-driven thesis support.

## Pipeline & orchestration (v2)

- **Tool-use / agentic loop** — let the model request additional fetches mid-run (e.g. "pull EDGAR 10-Q for X", "fetch IV term structure"). Currently fixed-shot.
- **Multi-agent debate** beyond specialist → critique → synthesis.
- **TradingAgents-style research committee** with bull/bear researchers, risk personas, and a portfolio-manager-like summarizer, while still enforcing the no-trade-action boundary unless a separate decision layer is added.
- **Vibe-Trading-style skill system** where domain playbooks are loaded on demand to keep prompts smaller while preserving specialized guidance.
- **Swarm/team presets** for macro desk, crypto desk, earnings desk, risk committee, or global allocation research.

## Cross-run intelligence (v2)

- **Watchlist + thesis-delta tracking** — "what changed in the AAPL thesis since last Tuesday". Long-term notes the bot consults across runs.
- **Persistent dedup of news sources** across runs so the same headline doesn't dominate three reports.
- **Incremental memory** — open questions and unresolved hypotheses carried forward.
- **Session/run search** over prior reports, sources, predictions, and theses.

## Operational (v3)

- **Scheduler** (cron / GitHub Actions) for daily runs without manual invocation.
- **Decouple the scoring pass** into its own scheduled job (daily after US close, ~21:30 UTC) instead of piggybacking on every research run.
- **Database-backed persistence** once local files become hard to query. SQLite is the likely first step; keep raw artifacts on disk if useful.
- 
## Quality of regime / movers (v4)

- **Regime inference depth** — currently proxy deltas (src/research/regime.ts); could incorporate breadth (advancers/decliners), sector dispersion, term-structure, credit spreads.
- **Mover ranking** — currently momentum × liquidity; could blend in unusual-volume, gap, sector-relative, or short-interest signals.
- **Benchmark-relative mover analysis** so a stock is compared against its sector/index instead of only absolute movement.

## Trade journal and behaviour analysis (v4)

- **Trade journal import** for broker CSV/Excel exports.
- **Behaviour diagnostics** such as holding period, win rate, overtrading, disposition effect, anchoring, and momentum chasing.
- **Shadow-account-style research** inspired by Vibe-Trading: infer patterns from profitable historical roundtrips and compare them to current behaviour.
- **Manual decision review loop** where the user can mark whether a Research View influenced a decision and whether that was useful later.

## Product polish (v3)

Relevant only if the framing drifts from "research substrate for me" toward "shareable product":

- Web frontend for browsing the run history.
- Branding, themed report rendering.
- Reliability SLAs, monitoring, alerting.
- Shareable artifacts (signed JSON, RSS feed of recent runs).
