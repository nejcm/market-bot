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

## Extended Evidence

Optional, higher-specificity Source Provider evidence that enriches ticker Research Views without changing the research-only boundary.
