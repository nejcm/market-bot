# API Provider Candidates

This note evaluates APIs that could add useful evidence to `market-bot` while preserving the research-only boundary. Do not add execution, portfolio management, position sizing, or trade recommendation behavior from broker APIs.

## Current Gaps

- More reliable equity close and intraday data than Yahoo.
- Richer equity ticker evidence: earnings, analyst events, fundamentals, options context.
- Crypto context beyond price: DeFi activity, on-chain metrics, social/developer activity.
- Differentiated sentiment or positioning evidence that can be cited as a source, not used as advice.

## Ranked Candidates

### 1. Massive

- **Use for:** US equity, ETF, options, indices, forex, and crypto market data.
- **Useful evidence:** historical closes, intraday bars, snapshots, options data, indices, validation for Yahoo-sourced prices.
- **Current status:** supplemental equity snapshots and news are implemented through `MARKET_BOT_MASSIVE_API_KEY`. Configured news/supplemental failures are disclosed as no-cap `SourceGap`s. When configured, Massive also opportunistically backs up Yahoo quote, benchmark, alpha-search validation, and scoring close routes after Yahoo retries are exhausted; movers remain Yahoo-only.
- **Fit:** strong promotion candidate if budget and validation allow; best for improving price/scoring reliability without replacing Yahoo as the registered primary adapter.
- **Caveat:** paid tiers may be needed for the useful coverage.
- **Docs:** <https://massive.com/docs/>
- **Legacy name:** formerly Polygon.io.

### 2. Alpha Vantage

- **Use for:** broad low-friction enrichment.
- **Useful evidence:** earnings calendar, fundamentals, news/sentiment, technical indicators, commodities, economic indicators.
- **Fit:** good optional provider for ticker briefs and market updates.
- **Caveat:** validate data quality and rate limits before making it scoring-critical.
- **Docs:** <https://www.alphavantage.co/documentation/>

### 3. Alpaca Market Data

- **Use for:** broker-style read-only market data.
- **Useful evidence:** equity/options/crypto bars, trades, quotes, WebSocket snapshots.
- **Fit:** useful as a read-only source adapter.
- **Caveat:** ignore trading/account endpoints; free equity data may be limited.
- **Docs:** <https://docs.alpaca.markets/us/v1.1/docs/about-market-data-api>

### 4. Benzinga

- **Use for:** market-moving event data.
- **Useful evidence:** analyst ratings, earnings, guidance, news, transcripts, event streams.
- **Fit:** strong for ticker briefs; less important for broad market updates.
- **Caveat:** many fields include analyst action language, so normalize carefully to avoid report text becoming advice-like.
- **Docs:** <https://docs.benzinga.com/introduction/introduction>

### 5. Nasdaq Data Link

- **Use for:** curated financial and alternative datasets.
- **Useful evidence:** fundamentals, macro, specialist datasets, premium historical data.
- **Fit:** best for targeted paid enrichment once a specific dataset is chosen.
- **Caveat:** not a default provider candidate without a concrete dataset need.
- **Docs:** <https://www.nasdaq.com/solutions/data/nasdaq-data-link>

### 6. DeFiLlama

- **Use for:** crypto and DeFi context.
- **Useful evidence:** TVL, stablecoin supply, protocol revenue/fees, DEX volumes, yields, bridges, protocol metadata.
- **Fit:** high-signal, low-friction addition for crypto weekly updates and crypto ticker briefs.
- **Caveat:** DeFi metrics are contextual evidence, not direct price forecast ground truth.
- **Docs/data:** <https://defillama.com/downloads>

### 7. Coin Metrics

- **Use for:** higher-quality crypto market and on-chain data.
- **Useful evidence:** exchange-level market data, historical time series, asset metrics.
- **Fit:** strong validation source for crypto if cost and access fit.
- **Caveat:** likely more serious and less simple than CoinGecko.
- **Docs:** <https://docs.coinmetrics.io/market-data>

### 8. Santiment

- **Use for:** crypto behavioral analytics.
- **Useful evidence:** social volume, development activity, on-chain metrics, holder behavior.
- **Fit:** differentiated signal source for crypto ticker briefs.
- **Caveat:** sentiment/social metrics should be weak qualitative evidence unless backtested.
- **Docs:** <https://api.santiment.net/>

### 9. Tradier Expansion

- **Use for:** deeper options evidence beyond existing IV usage.
- **Useful evidence:** option chains, Greeks, IV, expiration-level context.
- **Fit:** natural extension because Tradier is already supported.
- **Caveat:** options-derived claims must remain research context and observable forecast inputs, not trade setup language.
- **Docs:** <https://docs.tradier.com/reference/brokerage-api-markets-get-options-chains>

### 10. eToro

- **Use for:** social/positioning and platform-specific market data.
- **Useful evidence:** bid/ask, last execution, historical candles, close snapshots, instrument metadata, popularity, holder percentages, buy/sell holding percentages, feed posts, user analytics.
- **Fit:** interesting secondary provider, especially for social positioning.
- **Caveat:** identity and trading endpoints are not useful for this bot. Requires verified eToro account/API keys.
- **Docs:** <https://api-portal.etoro.com/>

## Suggested Implementation Order

1. Add DeFiLlama for crypto context.
2. Validate whether Massive should be promoted beyond supplemental evidence for equity price/scoring reliability.
3. Add Alpha Vantage for earnings calendar and news sentiment.
4. Add eToro or Santiment only if social/positioning evidence becomes a priority.

## Integration Rules

- Implement providers under `src/sources/` with the existing timeout, retry/backoff, cache, and `SourceGap` patterns.
- Follow the [Source Provider Contract](./source-provider-contract.md) before adding or promoting provider capabilities.
- Keep credentials in environment variables only.
- Treat all new provider data as cited evidence first; make it scoring-critical only after validating coverage and historical consistency.
- Do not add broker trading, account, portfolio, order, or watchlist-management behavior.
- Update `docs/configuration.md` in the same change when adding env vars.
