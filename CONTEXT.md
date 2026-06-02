# Market Bot Context

## Glossary

## Research View

A sourced research artifact that summarizes evidence, uncertainty, scenarios, risks, and gaps without recommending trades or portfolio actions.

## Instrument

A tradable listed or quoted research target. In the current CLI it is still identified by `symbol + assetClass`, with optional exchange, quote currency, provider IDs, and aliases when known.

## Instrument Identity

Provider-normalized metadata that helps relate Source Provider records to an Instrument without changing the research-only boundary.

## Observation

A public market quantity value used to resolve a Prediction. An Observation can be point-in-time or part of a window. It is not advice, conviction, or a trade signal.

## Market Update

A daily or weekly research run for an asset class that summarizes market regime, liquid movers, themes, risks, and source gaps.

Weekly market updates are a cadence and horizon change in V1, not a separate trailing-window data product. Equity mover inputs still come from Yahoo `day_gainers`, and crypto mover inputs still use CoinGecko 24h change fields; reports must disclose this as a source gap.

## Market Regime

The current market backdrop inferred from fetched evidence, such as broad direction, volatility, liquidity, and dominant themes.

## Market Context

Market-level evidence that enriches Market Updates without targeting one Instrument.

## Domain Playbook

A checked-in research guidance snippet selected once per run after source collection and the Evidence Request Loop. It steers eligible downstream model stages without fetching sources, changing report schema, or adding trading behavior.

## Mover

A liquid instrument ranked deterministically by price movement magnitude, liquidity, and available Mover Features.

## Mover Feature

A deterministic, explainable input to Mover ranking. It can change rank when present, but missing coverage is neutral and is not investment conviction, expected return, or a trade signal.

## Evidence Quality

A label for how complete, recent, corroborated, and traceable the fetched evidence is. It is not investment conviction or expected return.

## Source

A fetched data or news item saved with an ID so report claims can link back to evidence.

## Source Provider

An external service that supplies market data, news, or reference data before it is normalized into Sources.

## Supplemental Source Provider

An optional Source Provider that contributes citeable evidence without driving deterministic mover selection, market regime labels, or scoring Observations unless explicitly promoted.

## Source Gap

A disclosed absence, weakness, failure, or staleness in Source Provider evidence that affects report reliability.

## Research Lead

An equity candidate surfaced for further research by alpha-search. It is not a recommendation, trade signal, expected return, or portfolio action.

## Reddit Discovery Score

A deterministic alpha-search ranking score derived only from Reddit discussion features before market-data validation.

## Discussion Stance

A heuristic label for whether cited discussion appears constructive, skeptical, mixed, or unclear. It is noisy social evidence, not conviction.

## Alpha Search Report

A research-only discovery artifact that lists valid Research Leads and separately discloses rejected candidates with source IDs and reasons.

## Validation Baseline

A declared minimum set of exercised research routes and source capabilities required before provider readiness can be treated as passing.

## Provider Coverage Gap

A disclosed Source Gap caused by provider, account, region, or instrument limits rather than a failure of the research workflow. In provider-health validation it is usually expected or informational, not blocking.

## Extended Evidence

Optional, higher-specificity Source Provider evidence that enriches ticker Research Views without changing the research-only boundary.

## Fundamental Evidence

Sourced issuer operating and financial facts used as Extended Evidence. It supports ticker Research Views but is not investment conviction, expected return, or a trade signal.
