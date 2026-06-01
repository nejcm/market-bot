# ADR 0009 — Source provider modules with optional capabilities

## Status

Accepted

## Context

Source integrations were growing across separate concerns: primary market data, news, ticker Extended Evidence, Market Context, and scoring Observations. Some providers are primary inputs, while others are supplemental evidence. Keeping provider selection hard-coded in registry and collector code made additions and removals harder than the domain requires.

Massive, formerly Polygon.io, introduced a clear need for supplemental behavior: it should add equity evidence and news when configured, but it must not replace Yahoo, change mover ranking, affect crypto, or contribute scoring Observations.

## Decision

Each Source Provider is represented by a typed provider module in `src/sources/providers.ts`. A provider can expose any subset of these capabilities:

- primary market data
- supplemental market data
- news
- Extended Evidence
- Market Context
- scoring Observations

The registry composes capabilities by asset class. Primary market data remains a single selected adapter per asset class. Supplemental market data and news can fan out across multiple providers. Extended Evidence is composed from separate provider files so SEC/EDGAR, Finnhub events, FRED, Tradier, and Glassnode can be added or removed independently.

Massive uses the current `api.massive.com` host and canonical provider name `massive`. Documentation may mention Polygon.io only as legacy naming. `MARKET_BOT_MASSIVE_API_KEY` silently enables or disables Massive. When configured, Massive request failures emit normal `SourceGap`s.

## Consequences

- Provider additions are localized to a provider adapter file plus the provider module list.
- Supplemental Source Providers can add citeable evidence without entering deterministic ranking, regime, crypto, or scoring paths.
- Missing credentials can follow provider-specific behavior: primary optional providers can disclose gaps, while supplemental-only providers may silently disable themselves.
- The registry now composes some capabilities from multiple modules, so tests must cover provider ordering and source-gap behavior.

## Rejected alternatives

- **Make Massive a primary equity market adapter** — rejected because Yahoo remains the selected mover and regime source in this version.
- **Keep Extended Evidence as one bundled module** — rejected because provider-specific evidence is optional and should be removable by provider.
- **Use legacy Polygon naming for new code** — rejected because Massive is the current provider name; Polygon.io remains documentation-only context.

## References

- [Massive rebrand from Polygon.io](https://massive.com/blog/polygon-is-now-massive/)
- [Massive stock news API](https://massive.com/docs/rest/stocks/news)
- [Massive full-market stock snapshot API](https://massive.com/docs/rest/stocks/snapshots/full-market-snapshot)
