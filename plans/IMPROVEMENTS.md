# Improvements Backlog

Future improvements and v2 features for `market-bot`, captured during V1 planning, research into TradingAgents/Vibe-Trading, and the [calibration loop](plans/calibration-loop-plan.md).

Items here are **deliberately deferred** from V1. The first post-V1 priority is alpha discovery; most other entries should be pulled forward only after calibration data shows which gap actually matters.

The ordering inside each section is rough priority, not strict.

---

## Source layer fixes

- **Replace the Yahoo news adapter with a real provider** (NewsAPI, GDELT, MarketAux). The adapter is now honestly named ([src/sources/yahoo-news.ts](../src/sources/yahoo-news.ts)) and the `NewsAdapter.buildUrl` seam lets a real provider plug in without touching `collectNewsData`, but the underlying Yahoo `search` endpoint remains unofficial and can change shape without warning. Needs an ADR (paid source, env var, calibration impact).
- **Rate-limiting + circuit breaker per host.** Overkill for personal cadence today; relevant if scheduled runs go multi-asset and multi-cadence.
- **Cache the scorer's historical-close fetches** under the same `data/cache/` layer used by `collectSources`. Today only the live research collector benefits from caching; the scoring pass still re-fetches Yahoo/CoinGecko closes on every run.
- **Cache pruning tooling** for `data/cache/`. Per-day directories make a simple sweep trivial (`find data/cache -mtime +30 -delete`-style), but nothing runs it today.

## Alpha discovery

- **Alpha discovery workflow** — immediate post-V1 milestone. Reuse the V1 source adapters, mover discovery, Evidence Quality, citations, and run artifacts to produce early investment/research candidates without trade actions.
- **Alpha candidate ranking** based on explainable features, not an LLM-only list. Keep attractiveness separate from Evidence Quality.
- **Alpha report type** with thesis, why-now catalyst, evidence, bear case, risks, invalidation criteria, and source IDs.
- **Alpha watchlist output** that persists candidates across runs and tracks thesis changes over time.
- **Factor-style research inspired by Vibe-Trading Alpha Zoo** — factor registry, factor metadata, benchmark jobs, and lookahead/purity tests if quant-style alpha becomes useful.
- **Alpha validation loop** that scores whether candidates later outperformed relevant benchmarks over declared horizons.

## Sources & data depth

- **Paid/provider-backed source adapters** such as Polygon, Finnhub, Alpha Vantage, NewsAPI, GDELT, MarketAux, CoinMarketCap, or CryptoCompare. V1 keeps adapters replaceable but does not require paid sources.
- **Earnings beat/miss predictions** — requires a fundamentals source (Finnhub, Polygon, AlphaVantage). High signal, low noise, but new integration + scoring path. Likely the first v2 source pulled in once calibration shows the bot has skill (or needs more grounding).
- **SEC/EDGAR** for fundamentals-driven theses (margin expansion, guidance changes, segment data).
- **FRED** for macro context (rates, CPI, unemployment, yield curve) — would deepen regime inference beyond proxy deltas.
- **Options flow / IV surface** — richer volatility predictions than the current VIX-threshold shape.
- **Social sentiment** (X, Reddit, StockTwits) — high noise, defer until calibration tells us if it earns its keep.
- **Crypto on-chain** (Glassnode, Dune-style) for crypto-specific predictions.
- **Region-specific equity data** for Europe and Asia, with separate daily runs per region rather than one blended global report.
- **Provider-normalized instrument identity** beyond V1's `symbol + assetClass`, including exchange, currency, provider IDs, and aliases.
- **Corporate actions and splits/dividends normalization** so historical price and prediction scoring stay accurate.

## Report shape

- **News-event predictions** (e.g. "Fed minutes use 'restrictive' > 'accommodative'") — needs careful phrasing and LLM-judged scoring; defer until pure-numeric predictions work.
- **Probability streams** instead of point probabilities — overkill for personal use.
- **Continuous scenarios with explicit triggers** beyond the four DSL shapes.
- **Confidence intervals on probabilities** — model emits `{ p: 0.6, lo: 0.5, hi: 0.7 }` so we can measure narrowing/widening over time.

## Pipeline & orchestration

- **Tool-use / agentic loop** — let the model request additional fetches mid-run (e.g. "pull EDGAR 10-Q for X", "fetch IV term structure"). Currently fixed-shot.
- **Multi-agent debate** beyond specialist → critique → synthesis.
- **TradingAgents-style research committee** with bull/bear researchers, risk personas, and a portfolio-manager-like summarizer, while still enforcing the no-trade-action boundary unless a separate decision layer is added.
- **Vibe-Trading-style skill system** where domain playbooks are loaded on demand to keep prompts smaller while preserving specialized guidance.
- **Swarm/team presets** for macro desk, crypto desk, earnings desk, risk committee, or global allocation research.
- **Swappable evaluator models** for LLM-judged scoring of fuzzy predictions if news-event predictions are pulled in.
- **Provider matrix calibration** — compare gpt-4.1 vs Claude vs local-model on the same prediction set.
- **First-class local/open-source model support** for Ollama, vLLM, LM Studio, or similar OpenAI-compatible servers, with actual tests and model-specific prompt/tool behavior.
- **Provider fallback policy** that can retry a failed model call on another provider without corrupting run reproducibility.

## Calibration evolution

- **Presentation-layer isotonic probability remap** once ≥50 predictions have resolved per `(kind, assetClass)` bin. Critical implementation note: if/when this is built, the calibration feedback injected into the synthesis prompt must use the **raw, pre-remap** probabilities, never the laundered values. Otherwise the model loses the feedback signal.
- **Per-bin sample-size gating** — don't display "your 0.8s resolved at 0.4" until N ≥ threshold; show "insufficient data" instead.
- **Calibration drift detection** — flag when recent windows diverge from long-term calibration (model regression or regime change).

## Cross-run intelligence

- **Watchlist + thesis-delta tracking** — "what changed in the AAPL thesis since last Tuesday". Long-term notes the bot consults across runs.
- **Persistent dedup of news sources** across runs so the same headline doesn't dominate three reports.
- **Incremental memory** — open questions and unresolved hypotheses carried forward.
- **Session/run search** over prior reports, sources, predictions, and theses.
- **Decision memory for user-reviewed outcomes** — track what the user later decided and whether the research was useful, without letting the bot execute trades.

## Operational

- **Scheduler** (cron / GitHub Actions) for daily runs without manual invocation.
- **Decouple the scoring pass** into its own scheduled job (daily after US close, ~21:30 UTC) instead of piggybacking on every research run.
- **Delivery** to inbox / Slack / RSS — not just file artifacts.
- **Real cost tracking** measured against API billing instead of token estimates, with a budget guardrail that aborts a run if month-to-date exceeds N.
- **Healthcheck command** that probes every source adapter and reports green/yellow/red without doing a full run.
- **Database-backed persistence** once local files become hard to query. SQLite is the likely first step; keep raw artifacts on disk if useful.
- **API server** for external clients or a future UI.
- **MCP server** so other agents can call market-bot tools and retrieve reports.
- **Docker image / compose setup** for reproducible local or scheduled execution.
- **Secrets management improvements** beyond local env vars if this moves to a hosted environment.

## Quality of regime / movers

- **Regime inference depth** — currently proxy deltas (src/research/regime.ts); could incorporate breadth (advancers/decliners), sector dispersion, term-structure, credit spreads.
- **Mover ranking** — currently momentum × liquidity; could blend in unusual-volume, gap, sector-relative, or short-interest signals.
- **Dynamic market-mover sources by region** for US, Europe, Asia, and crypto, each with separate calendars and liquidity filters.
- **Benchmark-relative mover analysis** so a stock is compared against its sector/index instead of only absolute movement.

## Backtesting and simulation

- **Backtesting for research hypotheses** using saved Research Views or alpha candidates, with explicit fees/slippage/liquidity assumptions.
- **Signal simulation layer** that remains separate from reports and produces testable hypothetical rules, not live orders.
- **Walk-forward and bootstrap validation** for any generated strategy or factor.
- **Lookahead-leakage tests** for any factor, screen, or strategy-like module.

## Trade journal and behaviour analysis

- **Trade journal import** for broker CSV/Excel exports.
- **Behaviour diagnostics** such as holding period, win rate, overtrading, disposition effect, anchoring, and momentum chasing.
- **Shadow-account-style research** inspired by Vibe-Trading: infer patterns from profitable historical roundtrips and compare them to current behaviour.
- **Manual decision review loop** where the user can mark whether a Research View influenced a decision and whether that was useful later.

## Execution and portfolio layer

These remain deliberately outside the research-only V1 boundary and should require a separate ADR before implementation.

- **Buy/sell/hold or action-memo outputs** produced by a deterministic decision layer, not directly by the research report.
- **Portfolio accounting** with holdings, exposure, cash, PnL, drawdown, and benchmark comparison.
- **Risk limits** for concentration, max position, stop rules, and asset-class exposure.
- **Broker integration / order management** only after research calibration and deterministic risk controls exist.
- **Compliance/audit controls** if the tool ever moves beyond personal research.

## Product polish

Relevant only if the framing drifts from "research substrate for me" toward "shareable product":

- Web frontend for browsing the run history.
- Branding, themed report rendering.
- Reliability SLAs, monitoring, alerting.
- Shareable artifacts (signed JSON, RSS feed of recent runs).
