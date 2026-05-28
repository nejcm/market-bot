import { describe, expect, test } from "bun:test";
import { normalizeCoinGeckoMarketsPayload } from "../src/sources/coingecko";
import { finnhubNewsAdapter } from "../src/sources/finnhub-news";
import { marketAuxNewsAdapter } from "../src/sources/marketaux-news";
import { createSourceRegistry } from "../src/sources/registry";
import { normalizeYahooQuotePayload } from "../src/sources/yahoo";
import { yahooNewsAdapter } from "../src/sources/yahoo-news";

const fetchedAt = "2026-05-19T00:00:00.000Z";

describe("source normalization", () => {
  test("normalizes Yahoo quote payloads for equities", () => {
    const snapshots = normalizeYahooQuotePayload(
      {
        quoteResponse: {
          result: [
            {
              symbol: "AAPL",
              shortName: "Apple Inc.",
              regularMarketPrice: 189.5,
              regularMarketChangePercent: 2.1,
              regularMarketVolume: 80_000_000,
              marketCap: 2_900_000_000_000,
            },
          ],
        },
      },
      "equity",
      fetchedAt,
    );

    expect(snapshots).toEqual([
      {
        sourceId: "market-yahoo-equity-aapl",
        assetClass: "equity",
        symbol: "AAPL",
        name: "Apple Inc.",
        price: 189.5,
        changePercent24h: 2.1,
        volume: 80_000_000,
        marketCap: 2_900_000_000_000,
        observedAt: fetchedAt,
      },
    ]);
  });

  test("normalizes CoinGecko market payloads for crypto", () => {
    const snapshots = normalizeCoinGeckoMarketsPayload(
      [
        {
          symbol: "btc",
          name: "Bitcoin",
          current_price: 103_000,
          price_change_percentage_24h: -1.2,
          total_volume: 42_000_000_000,
          market_cap: 2_000_000_000_000,
        },
      ],
      fetchedAt,
    );

    expect(snapshots[0]).toMatchObject({
      sourceId: "market-coingecko-crypto-btc",
      assetClass: "crypto",
      symbol: "BTC",
      name: "Bitcoin",
      price: 103_000,
      changePercent24h: -1.2,
      volume: 42_000_000_000,
    });
  });

  test("normalizes Yahoo news payload into traceable sources", () => {
    const publishTime = Math.floor(new Date(fetchedAt).getTime() / 1000);
    const sources = yahooNewsAdapter.normalizeNews(
      {
        news: [
          {
            title: "Fed minutes move markets",
            link: "https://example.test/fed",
            publisher: "Example Wire",
            providerPublishTime: publishTime,
          },
        ],
      },
      "equity",
      fetchedAt,
    );

    expect(sources).toEqual([
      {
        id: "news-equity-1",
        title: "Fed minutes move markets",
        url: "https://example.test/fed",
        publisher: "Example Wire",
        fetchedAt,
        kind: "news",
        assetClass: "equity",
        provider: "yahoo-news",
        canonicalUrl: "https://example.test/fed",
      },
    ]);
  });

  test("normalizes MarketAux news payload with provider metadata", () => {
    const sources = marketAuxNewsAdapter.normalizeNews(
      {
        data: [
          {
            uuid: "article-1",
            title: "Chip stocks rally",
            url: "https://www.example.test/chips?utm_source=feed",
            source: "example.test",
            published_at: fetchedAt,
            description: "Semiconductors led the session.",
            snippet: "Chip stocks moved higher...",
          },
        ],
      },
      "equity",
      fetchedAt,
    );

    expect(sources[0]).toMatchObject({
      id: "news-equity-marketaux-1",
      provider: "marketaux",
      providerArticleId: "article-1",
      canonicalUrl: "https://example.test/chips",
      summary: "Semiconductors led the session.",
      snippet: "Chip stocks moved higher...",
    });
  });

  test("normalizes Finnhub news payload with provider metadata", () => {
    const sources = finnhubNewsAdapter.normalizeNews(
      [
        {
          id: 123,
          headline: "Bitcoin volatility rises",
          url: "https://example.test/btc",
          source: "Example",
          datetime: Math.floor(new Date(fetchedAt).getTime() / 1000),
          summary: "Volatility increased.",
        },
      ],
      "crypto",
      fetchedAt,
    );

    expect(sources[0]).toMatchObject({
      id: "news-crypto-finnhub-1",
      provider: "finnhub",
      providerArticleId: "123",
      canonicalUrl: "https://example.test/btc",
      summary: "Volatility increased.",
    });
  });
});

describe("source registry", () => {
  test("keeps equity and crypto adapters separate", () => {
    const registry = createSourceRegistry();

    expect(registry.marketDataFor("equity").name).toBe("yahoo");
    expect(registry.marketDataFor("crypto").name).toBe("coingecko");
    expect(registry.newsFor("crypto").name).toBe("multi-news");
  });
});

describe("news provider collection", () => {
  test("caps Finnhub normalized sources after provider fetch", async () => {
    const result = await finnhubNewsAdapter.collect({
      command: { jobType: "daily", assetClass: "crypto", depth: "brief" },
      fetchedAt,
      sourceTimeoutMs: 1000,
      newsLimit: 1,
      cryptoMoverLimit: 2,
      finnhubApiToken: "finnhub-token",
      fetchImpl: fetch,
      retryDelaysMs: [],
      fetchOrGap: async () => ({
        rawSnapshot: {
          id: "raw-finnhub-news-test",
          adapter: "finnhub-news",
          fetchedAt,
          payload: [],
        },
        payload: [
          {
            id: 1,
            headline: "First story",
            url: "https://example.test/first",
            source: "Example",
            datetime: Math.floor(new Date(fetchedAt).getTime() / 1000),
          },
          {
            id: 2,
            headline: "Second story",
            url: "https://example.test/second",
            source: "Example",
            datetime: Math.floor(new Date(fetchedAt).getTime() / 1000),
          },
        ],
      }),
    });

    expect(result.newsSources).toHaveLength(1);
    expect(result.newsSources[0]?.providerArticleId).toBe("1");
  });
});
