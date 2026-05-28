# PRD: Market Bot V1 Research CLI

## Problem Statement

The user wants a financial-market research bot that can run LLM-assisted research workflows for daily market awareness and specific instrument research. Existing open-source projects show useful patterns, but they are either broad research operating systems or trading-decision frameworks with more scope than needed for this repo. The user needs a controlled, auditable V1 that produces useful research artifacts without drifting into automated trading, portfolio advice, or opaque LLM-only conclusions.

## Solution

Build a TypeScript/Bun CLI application that produces sourced **Research Views** for separate equity and crypto workflows. V1 supports daily market updates and single-instrument research, persists every run as local artifacts, uses deterministic source collection before LLM synthesis, and keeps the model layer abstract enough to support OpenAI first and local/open-source models later.

The output is research-only. Reports may include thesis, evidence, catalysts, risks, scenarios, source gaps, and Evidence Quality, but must not emit buy/sell/hold recommendations, position sizing, execution instructions, or portfolio changes.

## User Stories

1. As a market researcher, I want to run a daily equity report, so that I can understand the current market regime and major movers.
2. As a market researcher, I want to run a daily crypto report separately from equities, so that crypto-specific conditions do not get mixed with equity assumptions.
3. As a market researcher, I want the daily report to identify top movers dynamically, so that I do not have to maintain a static watchlist.
4. As a market researcher, I want daily movers filtered by liquidity, so that reports do not over-focus on noisy or manipulated instruments.
5. As a market researcher, I want a brief daily mode by default, so that routine usage stays fast and readable.
6. As a market researcher, I want a deep daily mode, so that I can request a fuller analyst-style report when needed.
7. As an investor doing research, I want to run a ticker/instrument report, so that I can understand a specific equity or crypto asset.
8. As an investor doing research, I want ticker research to produce a full thesis, so that I can evaluate business or protocol context, price action, catalysts, and risks.
9. As an investor doing research, I want equity and crypto ticker research to use separate assumptions, so that fundamentals and protocol analysis are not conflated.
10. As a user researching global equities, I want ticker research to accept supported global symbols, so that I can research instruments beyond US tickers where public data allows it.
11. As a user researching crypto, I want daily crypto discovery to focus on liquid top assets, so that the report avoids obscure low-quality movers.
12. As a user, I want every report to include sources, so that I can verify claims.
13. As a user, I want major findings linked to source IDs, so that I can trace which data supports each conclusion.
14. As a user, I want reports to call out missing or weak data, so that I can judge reliability.
15. As a user, I want confidence to mean Evidence Quality, so that it does not masquerade as investment conviction or expected return.
16. As a user, I want the bot to degrade gracefully when sources are missing, so that I still receive a useful report with caveats.
17. As a user, I want the LLM prevented from filling source gaps from memory, so that reports stay grounded in fetched evidence.
18. As a user, I want reports in Markdown, so that I can read them easily.
19. As a user, I want structured JSON reports, so that future automation and alpha workflows can consume them.
20. As a user, I want raw source snapshots saved, so that I can audit or debug reports later.
21. As a user, I want normalized inputs saved, so that source adapters can be tested and compared.
22. As a user, I want trace metadata saved, so that I can see model choice, timestamps, source gaps, and token/cost estimates.
23. As a user, I want CLI commands suitable for external schedulers, so that I can run daily reports without a built-in daemon.
24. As a developer, I want source adapters behind stable interfaces, so that paid or better data sources can be added later without rewriting job logic.
25. As a developer, I want mover discovery to be deterministic, so that reports are auditable and testable.
26. As a developer, I want news treated as corroborating evidence, so that headline narratives do not dominate the research process.
27. As a developer, I want fixed analysis stages, so that the workflow is easier to test than an unconstrained autonomous agent.
28. As a developer, I want a critique stage that challenges findings, so that reports surface alternative explanations and risks without inventing new facts.
29. As a developer, I want a provider abstraction around model calls, so that OpenAI can be used first while local/open-source models remain possible later.
30. As a developer, I want strict core report schemas with flexible extras, so that the artifact is stable but can evolve.
31. As a developer, I want a glossary of domain terms, so that future implementation uses consistent language.
32. As a developer, I want ADRs for the research-only boundary and stack choice, so that future contributors do not accidentally turn V1 into a trading bot or large framework fork.
33. As a future alpha-research user, I want V1 artifacts to preserve reusable movers, sources, and Evidence Quality fields, so that alpha discovery can be added immediately after V1.
34. As a future alpha-research user, I want reports to avoid trade-action language, so that alpha workflows can later add separate deterministic risk and decision layers.

## Implementation Decisions

- Build a new native TypeScript/Bun CLI rather than forking TradingAgents or Vibe-Trading.
- Implement V1 commands for daily market updates, weekly market updates, and ticker/instrument research.
- Use **Instrument** as the canonical research target, identified in V1 by `symbol + assetClass`.
- Use separate equity and crypto workflows rather than a blended market workflow.
- Start equity daily mover discovery with US equities only.
- Allow equity ticker research for supported global Yahoo-style symbols where public sources work.
- Start crypto daily mover discovery with liquid top assets only.
- Treat the default daily report as a Market Regime + Movers brief.
- Add a deep mode flag for fuller daily analysis.
- Treat ticker research as a full Research View by default.
- Use deterministic source collection before any LLM synthesis.
- Create deep, independently testable modules for:
  - CLI command parsing and job dispatch
  - configuration resolution
  - source adapter registry
  - market data normalization
  - news/source normalization
  - mover discovery and ranking
  - run artifact persistence
  - model provider abstraction
  - research orchestration
  - report schema validation and rendering
- Keep source adapters replaceable so free/public sources can be replaced or supplemented by paid providers later.
- Rank movers by movement magnitude plus liquidity.
- Treat news as corroborating evidence, not the primary selector.
- Use fixed workflow stages: source collection, specialist analysis, critique, final synthesis.
- Limit critique to challenging findings, missing evidence, alternative explanations, and risk scenarios.
- Use a TypeScript AI SDK/provider abstraction for LLM calls.
- Guarantee OpenAI support in V1.
- Make local/open-source providers config-ready only in V1, with no guarantee that they are tested or production-ready.
- Persist each run as local files, including raw snapshots, normalized inputs, structured JSON, Markdown, and trace metadata.
- Use strict core report schemas with flexible extras.
- Require major findings to reference source IDs.
- Use one standard research-only note per report.
- Add a glossary-only context document for Research View, Instrument, Daily Market Update, Market Regime, Mover, Evidence Quality, and Source.
- Add an ADR for the research-only boundary.
- Add an ADR for native TypeScript/Bun orchestration with an AI SDK/provider abstraction.

## Testing Decisions

- Tests should verify external behavior and artifact contracts, not internal prompt wording or private implementation details.
- CLI tests should verify accepted commands, required arguments, asset-class separation, and deep-mode behavior.
- Configuration tests should verify provider, model, base URL, API key, data directory, and source option resolution.
- Source adapter tests should verify normalized outputs from mocked free/public source payloads.
- Mover discovery tests should verify deterministic ranking by movement magnitude plus liquidity.
- Instrument tests should verify symbol plus asset-class identity behavior.
- Report schema tests should verify required core fields, flexible extras, source IDs, data gaps, and research-only markers.
- Orchestration tests should use mocked model responses and mocked sources to verify daily equity, daily crypto, ticker equity, and ticker crypto runs.
- Artifact tests should verify that each run writes raw snapshots, normalized inputs, JSON report, Markdown report, and trace metadata.
- Golden tests should verify that Markdown reports include source references, caveats, and one standard research-only note.
- Safety tests should verify that reports do not contain buy/sell/hold conclusions, position sizing, execution instructions, or portfolio-change language.
- Degradation tests should verify that missing or sparse sources lower Evidence Quality and add data gaps instead of hallucinated facts.

## Out of Scope

- Broker integration.
- Live trading.
- Portfolio accounting.
- Position sizing.
- Buy/sell/hold recommendations.
- Automated trade execution.
- Web application.
- API server.
- Database persistence.
- Built-in daemon scheduler.
- First-class local/open-source model support.
- Alpha discovery implementation.
- Paid data-provider integrations as required V1 dependencies.
- Backtesting.
- Trade journal analysis.
- Multi-user hosted deployment.

## Further Notes

- The issue should receive the `ready-for-agent` triage label when published.
- The current repository has no configured Git remote, so the PRD cannot be published to an issue tracker until a repository owner/name is provided or a remote is configured.
- The existing research briefs support the decision to build a small native research workflow rather than adopting either researched project wholesale.
