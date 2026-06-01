import { describe, expect, test } from "bun:test";
import { normalizeCoinGeckoMarketsPayload } from "../src/sources/coingecko";
import {
  cryptoExtendedEvidenceAdapter,
  equityExtendedEvidenceAdapter,
} from "../src/sources/extended-evidence";
import { buildFredMacroMetrics, fetchFredObservation } from "../src/sources/fred";
import { marketContextAdapter } from "../src/sources/market-context";
import { fetchTradierIvObservation } from "../src/sources/tradier";
import { finnhubNewsAdapter } from "../src/sources/finnhub-news";
import { marketAuxNewsAdapter } from "../src/sources/marketaux-news";
import { createSourceRegistry } from "../src/sources/registry";
import { normalizeYahooQuotePayload } from "../src/sources/yahoo";
import { yahooNewsAdapter } from "../src/sources/yahoo-news";

const fetchedAt = "2026-05-19T00:00:00.000Z";
const throwingFetch: typeof fetch = Object.assign(
  async () => {
    throw new Error("timeout");
  },
  { preconnect: fetch.preconnect },
);

describe("source normalization", () => {
  test("normalizes Yahoo quote payloads for equities", () => {
    const snapshots = normalizeYahooQuotePayload(
      {
        quoteResponse: {
          result: [
            {
              symbol: "AAPL",
              shortName: "Apple Inc.",
              fullExchangeName: "NasdaqGS",
              currency: "USD",
              regularMarketPrice: 189.5,
              regularMarketChangePercent: 2.1,
              regularMarketVolume: 80_000_000,
              marketCap: 2_900_000_000_000,
              regularMarketOpen: 188,
              regularMarketPreviousClose: 184,
              averageDailyVolume10Day: 50_000_000,
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
        identity: {
          exchange: "NasdaqGS",
          quoteCurrency: "USD",
          displayName: "Apple Inc.",
          aliases: [{ provider: "yahoo", idKind: "symbol", value: "AAPL" }],
        },
        price: 189.5,
        changePercent24h: 2.1,
        volume: 80_000_000,
        marketCap: 2_900_000_000_000,
        open: 188,
        previousClose: 184,
        averageVolume: 50_000_000,
        observedAt: fetchedAt,
      },
    ]);
  });

  test("uses fallback Yahoo average volume fields for mover features", () => {
    const snapshots = normalizeYahooQuotePayload(
      {
        quoteResponse: {
          result: [
            {
              symbol: "MSFT",
              regularMarketPrice: 420,
              regularMarketChangePercent: 1.4,
              regularMarketVolume: 30_000_000,
              averageDailyVolume3Month: 25_000_000,
              averageVolume: 20_000_000,
            },
            {
              symbol: "NVDA",
              regularMarketPrice: 900,
              regularMarketChangePercent: 4.8,
              regularMarketVolume: 70_000_000,
              averageVolume: 40_000_000,
            },
          ],
        },
      },
      "equity",
      fetchedAt,
    );

    expect(snapshots.map((snapshot) => [snapshot.symbol, snapshot.averageVolume])).toEqual([
      ["MSFT", 25_000_000],
      ["NVDA", 40_000_000],
    ]);
  });

  test("omits Yahoo mover feature fields when unavailable", () => {
    const [snapshot] = normalizeYahooQuotePayload(
      {
        quoteResponse: {
          result: [
            {
              symbol: "META",
              regularMarketPrice: 500,
              regularMarketChangePercent: -1.2,
              regularMarketVolume: 20_000_000,
            },
          ],
        },
      },
      "equity",
      fetchedAt,
    );

    expect(snapshot).not.toHaveProperty("open");
    expect(snapshot).not.toHaveProperty("previousClose");
    expect(snapshot).not.toHaveProperty("averageVolume");
  });

  test("normalizes CoinGecko market payloads for crypto", () => {
    const snapshots = normalizeCoinGeckoMarketsPayload(
      [
        {
          id: "bitcoin",
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
      identity: {
        quoteCurrency: "USD",
        displayName: "Bitcoin",
        providerIds: [{ provider: "coingecko", idKind: "coin-id", value: "bitcoin" }],
        aliases: [{ provider: "coingecko", idKind: "symbol", value: "BTC" }],
      },
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
    expect(registry.marketContextFor("equity").name).toBe("market-context");
  });
});

describe("market context provider collection", () => {
  test("normalizes latest FRED values and deltas", () => {
    const metrics = buildFredMacroMetrics([
      {
        seriesId: "DGS10",
        payload: {
          observations: [
            { date: "2026-05-19", value: "4.25" },
            { date: "2026-05-16", value: "4.10" },
          ],
        },
      },
    ]);

    expect(metrics).toEqual({
      DGS10: 4.25,
      DGS10Change: 0.15,
      DGS10Date: "2026-05-19",
      DGS10Prior: 4.1,
      DGS10PriorDate: "2026-05-16",
    });
  });

  test("collects FRED Market Context for market updates", async () => {
    const result = await marketContextAdapter.collect({
      command: { jobType: "daily", assetClass: "equity", depth: "brief" },
      fetchedAt,
      sourceTimeoutMs: 1000,
      newsLimit: 1,
      cryptoMoverLimit: 2,
      fredApiKey: "fred-key",
      fetchImpl: fetch,
      retryDelaysMs: [],
      fetchOrGap: async (_url, adapter) => {
        const payload = {
          observations: [
            { date: "2026-05-19", value: "4.25" },
            { date: "2026-05-16", value: "4.10" },
          ],
        };
        return {
          rawSnapshot: { id: `raw-${adapter}`, adapter, fetchedAt, payload },
          payload,
        };
      },
    });

    expect(result.marketContext?.assetClass).toBe("equity");
    expect(result.marketContext?.items).toHaveLength(1);
    expect(result.marketContext?.items[0]?.metrics?.DGS10).toBe(4.25);
    expect(result.marketContext?.items[0]?.metrics?.DGS10Change).toBeCloseTo(0.15);
    expect(result.sources).toEqual([
      expect.objectContaining({
        id: "market-context-fred-macro",
        kind: "market-context",
        assetClass: "equity",
        provider: "fred",
      }),
    ]);
    expect(result.sourceGaps).toEqual([]);
  });

  test("emits missing-key Market Context gap for market updates", async () => {
    const result = await marketContextAdapter.collect({
      command: { jobType: "weekly", assetClass: "crypto", depth: "brief" },
      fetchedAt,
      sourceTimeoutMs: 1000,
      newsLimit: 1,
      cryptoMoverLimit: 2,
      fetchImpl: fetch,
      retryDelaysMs: [],
      fetchOrGap: async () => {
        throw new Error("unexpected fetch");
      },
    });

    expect(result.marketContext).toEqual({
      assetClass: "crypto",
      items: [],
      gaps: [{ source: "fred-macro", message: "MARKET_BOT_FRED_API_KEY is not set" }],
    });
    expect(result.sourceGaps).toEqual([
      { source: "fred-macro", message: "MARKET_BOT_FRED_API_KEY is not set" },
    ]);
  });

  test("skips Market Context for ticker runs", async () => {
    const result = await marketContextAdapter.collect({
      command: { jobType: "ticker", assetClass: "equity", symbol: "AAPL", depth: "brief" },
      fetchedAt,
      sourceTimeoutMs: 1000,
      newsLimit: 1,
      cryptoMoverLimit: 2,
      fredApiKey: "fred-key",
      fetchImpl: fetch,
      retryDelaysMs: [],
      fetchOrGap: async () => {
        throw new Error("unexpected fetch");
      },
    });

    expect(result).toEqual({ rawSnapshots: [], sources: [], sourceGaps: [] });
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

describe("extended evidence provider collection", () => {
  test("collects compact equity extended evidence", async () => {
    const requests: { adapter: string; url: string; headers: Headers }[] = [];
    const result = await equityExtendedEvidenceAdapter.collect({
      command: { jobType: "ticker", assetClass: "equity", symbol: "aapl", depth: "brief" },
      fetchedAt,
      sourceTimeoutMs: 1000,
      newsLimit: 1,
      cryptoMoverLimit: 2,
      finnhubApiToken: "finnhub-token",
      fredApiKey: "fred-key",
      tradierApiToken: "tradier-token",
      secUserAgent: "market-bot test@example.test",
      fetchImpl: fetch,
      retryDelaysMs: [],
      fetchOrGap: async (
        url,
        adapter,
        _fetchedAt,
        _timeoutMs,
        _fetchImpl,
        _retryDelaysMs,
        init,
      ) => {
        requests.push({ adapter, url, headers: new Headers(init?.headers) });
        let payload: unknown = {};
        if (adapter === "sec-tickers") {
          payload = { "0": { cik_str: 320_193, ticker: "AAPL", title: "Apple Inc." } };
        } else if (adapter === "sec-submissions") {
          payload = { filings: { recent: { form: ["10-Q"], filingDate: ["2026-05-01"] } } };
        } else if (adapter === "sec-companyfacts") {
          payload = {
            facts: {
              "us-gaap": {
                Revenues: { units: { USD: [{ val: 100 }] } },
                NetIncomeLoss: { units: { USD: [{ val: 20 }] } },
              },
            },
          };
        } else if (adapter.startsWith("fred-")) {
          payload = {
            observations: [
              { date: "2026-05-19", value: "4.25" },
              { date: "2026-05-16", value: "4.10" },
            ],
          };
        } else if (adapter === "tradier-expirations") {
          payload = { expirations: { date: ["2026-05-22", "2026-06-19"] } };
        } else if (adapter === "tradier-options") {
          payload = { options: { option: [{ greeks: { mid_iv: 0.32 } }] } };
        } else if (adapter.startsWith("finnhub-events")) {
          payload = [{ symbol: "AAPL" }];
        }
        return {
          rawSnapshot: { id: `raw-${adapter}`, adapter, fetchedAt, payload },
          payload,
        };
      },
    });

    expect(result.extendedEvidence?.items.map((item) => item.category)).toContain("sec-edgar");
    expect(result.extendedEvidence?.items.map((item) => item.category)).toContain("equity-events");
    expect(result.extendedEvidence?.items.map((item) => item.category)).toContain("fred-macro");
    expect(
      result.extendedEvidence?.items.find((item) => item.category === "fred-macro")?.metrics
        ?.DGS10Change,
    ).toBeCloseTo(0.15);
    expect(result.extendedEvidence?.items.map((item) => item.category)).toContain("options-iv");
    expect(result.sources.every((source) => source.kind === "extended-evidence")).toBe(true);
    expect(result.sources.find((source) => source.provider === "sec-edgar")?.identity).toEqual({
      displayName: "Apple Inc.",
      providerIds: [{ provider: "sec-edgar", idKind: "cik", value: "0000320193" }],
      aliases: [{ provider: "sec-edgar", idKind: "ticker", value: "AAPL" }],
    });
    expect(
      result.extendedEvidence?.items.find((item) => item.category === "sec-edgar")?.identity,
    ).toEqual({
      displayName: "Apple Inc.",
      providerIds: [{ provider: "sec-edgar", idKind: "cik", value: "0000320193" }],
      aliases: [{ provider: "sec-edgar", idKind: "ticker", value: "AAPL" }],
    });
    expect(result.sourceGaps).toEqual([]);
    expect(
      requests
        .filter((request) => request.adapter.startsWith("sec-"))
        .every((request) => request.headers.get("user-agent") === "market-bot test@example.test"),
    ).toBe(true);
    expect(
      requests
        .find((request) => request.adapter === "tradier-expirations")
        ?.headers.get("authorization"),
    ).toBe("Bearer tradier-token");
    expect(
      requests
        .find((request) => request.adapter === "tradier-options")
        ?.headers.get("authorization"),
    ).toBe("Bearer tradier-token");
    expect(requests.find((request) => request.adapter === "tradier-options")?.url).toContain(
      "expiration=2026-06-19",
    );
    expect(requests.some((request) => request.adapter.startsWith("glassnode-"))).toBe(false);
  });

  test("emits gaps for missing crypto extended evidence tokens", async () => {
    const result = await cryptoExtendedEvidenceAdapter.collect({
      command: { jobType: "ticker", assetClass: "crypto", symbol: "BTC", depth: "brief" },
      fetchedAt,
      sourceTimeoutMs: 1000,
      newsLimit: 1,
      cryptoMoverLimit: 2,
      fetchImpl: fetch,
      retryDelaysMs: [],
      fetchOrGap: async () => {
        throw new Error("unexpected fetch");
      },
    });

    expect(result.extendedEvidence?.items).toEqual([]);
    expect(result.sourceGaps.map((gap) => gap.source)).toEqual([
      "fred-macro",
      "glassnode-on-chain",
    ]);
  });

  test("routes crypto extended evidence only through crypto providers", async () => {
    const adapters: string[] = [];
    const result = await cryptoExtendedEvidenceAdapter.collect({
      command: { jobType: "ticker", assetClass: "crypto", symbol: "BTC", depth: "brief" },
      fetchedAt,
      sourceTimeoutMs: 1000,
      newsLimit: 1,
      cryptoMoverLimit: 2,
      fredApiKey: "fred-key",
      glassnodeApiKey: "glassnode-key",
      fetchImpl: fetch,
      retryDelaysMs: [],
      fetchOrGap: async (_url, adapter) => {
        adapters.push(adapter);
        const payload = adapter.startsWith("fred-")
          ? { observations: [{ value: "4.25" }] }
          : [{ v: 12 }];
        return {
          rawSnapshot: { id: `raw-${adapter}`, adapter, fetchedAt, payload },
          payload,
        };
      },
    });

    expect(result.extendedEvidence?.items.map((item) => item.category)).toEqual([
      "fred-macro",
      "on-chain",
    ]);
    expect(
      adapters.every((adapter) => adapter.startsWith("fred-") || adapter.startsWith("glassnode-")),
    ).toBe(true);
  });

  test("fetches Tradier IV only point-in-time with listed expiration", async () => {
    const requested: string[] = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      requested.push(String(input));
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer tradier-token");
      if (String(input).includes("/expirations?")) {
        return Response.json({ expirations: { date: ["2026-06-19"] } });
      }
      return Response.json({ options: { option: [{ greeks: { mid_iv: 0.41 } }] } });
    };

    const iv = await fetchTradierIvObservation(
      "AAPL",
      new Date("2026-05-19T00:00:00.000Z"),
      "tradier-token",
      fetchImpl,
      new Date("2026-05-19T12:00:00.000Z"),
    );

    expect(iv).toBe(0.41);
    expect(requested[1]).toContain("expiration=2026-06-19");
    expect(
      await fetchTradierIvObservation(
        "AAPL",
        new Date("2026-05-19T00:00:00.000Z"),
        "tradier-token",
        fetchImpl,
        new Date("2026-05-20T00:00:00.000Z"),
      ),
    ).toBeUndefined();
  });

  test("returns undefined when scoring observation fetches fail", async () => {
    await expect(
      fetchFredObservation(
        "DGS10",
        new Date("2026-05-19T00:00:00.000Z"),
        "fred-key",
        throwingFetch,
      ),
    ).resolves.toBeUndefined();
    await expect(
      fetchTradierIvObservation(
        "AAPL",
        new Date("2026-05-19T00:00:00.000Z"),
        "tradier-token",
        throwingFetch,
        new Date("2026-05-19T12:00:00.000Z"),
      ),
    ).resolves.toBeUndefined();
  });
});
