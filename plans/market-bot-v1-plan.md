# Market Bot V1 Plan

## Summary

Build a TypeScript/Bun CLI research bot for financial markets. V1 produces sourced **Research Views** only: no buy/sell/hold conclusions, no position sizing, no broker execution, and no portfolio changes.

V1 includes daily market updates and ticker/instrument research. Alpha discovery comes immediately after V1 and should reuse the same source, run, mover, report, and evidence-quality infrastructure.

## Key Changes

- Create a Bun/TypeScript CLI:
  - `market-bot daily --asset equity|crypto [--deep]`
  - `market-bot ticker <symbol> --asset equity|crypto [--deep]`
- Use a native small orchestration layer with a TypeScript AI SDK/provider abstraction:
  - OpenAI is the only guaranteed/tested V1 provider
  - config shape allows later OpenAI-compatible/local providers such as Ollama, vLLM, or LM Studio
- Model the canonical research target as an **Instrument** identified by `symbol + assetClass`.
- Separate equity and crypto runs:
  - equity daily movers: US-first in V1
  - equity ticker research: allow global Yahoo-style symbols where sources support them
  - crypto daily movers: liquid top assets only
- Daily reports focus on **Market Regime + Movers**:
  - default: brief regime, movers, themes, risks, source gaps
  - `--deep`: fuller analyst-style version
- Ticker reports produce a full **Research View**:
  - thesis, evidence, catalysts, bull case, bear case, risks, scenarios, data gaps
  - confidence means **Evidence Quality**, not investment conviction
- Use deterministic source collection before LLM analysis:
  - market data adapter
  - news/source adapter
  - mover discovery adapter
  - mover discovery ranks by magnitude + liquidity
  - news is corroborating evidence, not the primary selector
- Use fixed analysis stages:
  - source collection
  - specialist analysis
  - bull/bear/risk critique that challenges findings only
  - final editor/synthesis
- Persist each run as local files:
  - raw source snapshots
  - normalized JSON inputs
  - structured report JSON
  - Markdown report
  - trace metadata with model, timestamps, token/cost estimates, source gaps

## Interfaces And Docs

- Config supports provider name, base URL, API key, quick model, synthesis model, data directory, and source options.
- Report JSON uses a strict core schema with flexible extras:
  - `runId`, `jobType`, `assetClass`, `symbol?`, `generatedAt`
  - `summary`, `keyFindings`, `bullCase`, `bearCase`, `risks`, `catalysts`, `scenarios`
  - `confidence`, `dataGaps`, `sources`, `notFinancialAdvice: true`
  - major findings reference source IDs
- Add root `CONTEXT.md` as a glossary only:
  - **Research View**
  - **Instrument**
  - **Daily Market Update**
  - **Market Regime**
  - **Mover**
  - **Evidence Quality**
  - **Source**
- Add two short ADRs:
  - V1 is research-only and must not emit trade actions.
  - V1 uses native TypeScript/Bun orchestration with an AI SDK/provider abstraction instead of forking TradingAgents or Vibe-Trading.

## Test Plan

- Unit tests:
  - CLI argument parsing
  - provider config resolution
  - equity vs crypto run separation
  - instrument identity parsing
  - mover ranking by magnitude + liquidity
  - source adapter normalization
  - report JSON schema validation
  - missing-source degradation
- Integration tests with mocked sources and mocked model responses:
  - daily equity brief
  - daily crypto brief
  - ticker equity Research View
  - ticker crypto Research View
  - `--deep` changes depth without changing artifact layout
- Golden tests:
  - Markdown includes source references, caveats, and one standard research-only note
  - JSON links major findings to source IDs
  - reports do not contain buy/sell/hold, sizing, or execution language

## Assumptions

- V1 has no web app, API server, database, daemon scheduler, broker integration, or live trading.
- External schedulers call the CLI.
- Free/public data sources are acceptable for V1, but source adapters must make paid-provider replacement straightforward.
- Missing data degrades reports with explicit caveats and lower Evidence Quality; the LLM must not fill gaps from memory.
- Local/open-source models are config-ready only in V1, not guaranteed.
