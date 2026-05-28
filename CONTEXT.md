# Market Bot Context

## Glossary

## Research View

A sourced research artifact that summarizes evidence, uncertainty, scenarios, risks, and gaps without recommending trades or portfolio actions.

## Instrument

The canonical research target, identified by `symbol + assetClass`.

## Market Update

A daily or weekly research run for an asset class that summarizes market regime, liquid movers, themes, risks, and source gaps.

Weekly market updates are a cadence and horizon change in V1, not a separate trailing-window data product. Equity mover inputs still come from Yahoo `day_gainers`, and crypto mover inputs still use CoinGecko 24h change fields; reports must disclose this as a source gap.

## Market Regime

The current market backdrop inferred from fetched evidence, such as broad direction, volatility, liquidity, and dominant themes.

## Mover

A liquid instrument ranked deterministically by price movement magnitude plus liquidity.

## Evidence Quality

A label for how complete, recent, corroborated, and traceable the fetched evidence is. It is not investment conviction or expected return.

## Source

A fetched data or news item saved with an ID so report claims can link back to evidence.

## Source Provider

An external service that supplies market data, news, or reference data before it is normalized into Sources.

## Source Gap

A disclosed absence, weakness, failure, or staleness in Source Provider evidence that affects report reliability.
