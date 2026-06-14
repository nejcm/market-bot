import { describe, expect, test } from "bun:test";
import { EQUITY_REGIME_SYMBOLS } from "../src/domain/regime-symbols";
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
import {
  massiveNewsAdapter,
  massiveSupplementalMarketDataAdapter,
  normalizeMassiveSnapshotPayload,
} from "../src/sources/massive";
import { createMultiNewsAdapter } from "../src/sources/multi-news";
import { normalizeTitle } from "../src/sources/news-utils";
import { createSourceRegistry } from "../src/sources/registry";
import { summarizeSecFundamentals } from "../src/sources/extended-evidence/sec-edgar";
import { collectFinnhubEvents } from "../src/sources/extended-evidence/finnhub-events";
import { normalizeYahooQuotePayload, yahooMarketDataAdapter } from "../src/sources/yahoo";
import { yahooNewsAdapter } from "../src/sources/yahoo-news";
import type {
  CollectContext,
  FetchJsonResult,
  NewsAdapter,
  SourceRequestExecutor,
} from "../src/sources/types";
import type { MarketSnapshot } from "../src/domain/types";

const fetchedAt = "2026-05-19T00:00:00.000Z";
async function unexpectedTextFetch(): Promise<never> {
  throw new Error("unexpected text fetch");
}

function rawJson(adapter: string, payload: unknown, rawFetchedAt = fetchedAt): FetchJsonResult {
  return {
    rawSnapshot: { id: `raw-${adapter}`, adapter, fetchedAt: rawFetchedAt, payload },
    payload,
  };
}

function requestExecutor(overrides: Partial<SourceRequestExecutor> = {}): SourceRequestExecutor {
  return {
    json: async () => {
      throw new Error("unexpected json fetch");
    },
    text: unexpectedTextFetch,
    ...overrides,
  };
}

function collectContext(overrides: Partial<CollectContext> = {}): CollectContext {
  return {
    command: { jobType: "daily", assetClass: "equity", depth: "brief" },
    fetchedAt,
    newsLimit: 1,
    cryptoMoverLimit: 2,
    request: requestExecutor(),
    ...overrides,
  };
}

const throwingFetch: typeof fetch = Object.assign(
  async () => {
    throw new Error("timeout");
  },
  { preconnect: fetch.preconnect },
);

function secFact(
  val: number,
  overrides: Record<string, number | string> = {},
): Record<string, number | string> {
  return {
    val,
    form: "10-Q",
    fp: "Q2",
    fy: 2026,
    filed: "2026-07-30",
    end: "2026-06-29",
    ...overrides,
  };
}

function secFactUnits(current: number, prior = current - 1): { units: { USD: unknown[] } } {
  return {
    units: {
      USD: [
        secFact(prior, {
          fy: 2025,
          filed: "2025-07-30",
          end: "2025-06-29",
        }),
        secFact(current),
      ],
    },
  };
}

function secCompanyFactsPayload(): unknown {
  return {
    facts: {
      "us-gaap": {
        Revenues: {
          units: {
            USD: [
              secFact(90, { fy: 2025, filed: "2025-07-30", end: "2025-06-29" }),
              secFact(70, { fp: "Q1", filed: "2026-04-30", end: "2026-03-29" }),
              secFact(100),
            ],
          },
        },
        GrossProfit: secFactUnits(40, 35),
        OperatingIncomeLoss: secFactUnits(25, 20),
        NetIncomeLoss: secFactUnits(20, 18),
        EarningsPerShareDiluted: {
          units: {
            "USD/shares": [
              secFact(1.8, { fy: 2025, filed: "2025-07-30", end: "2025-06-29" }),
              secFact(2),
            ],
          },
        },
        CashAndCashEquivalentsAtCarryingValue: secFactUnits(30, 25),
        LongTermDebt: secFactUnits(50, 45),
        NetCashProvidedByUsedInOperatingActivities: secFactUnits(28, 22),
        PaymentsToAcquirePropertyPlantAndEquipment: secFactUnits(6, 5),
        WeightedAverageNumberOfDilutedSharesOutstanding: {
          units: {
            shares: [secFact(10, { fy: 2025, filed: "2025-07-30", end: "2025-06-29" }), secFact(9)],
          },
        },
      },
    },
  };
}

function secCompanyFactsPayloadWithRevenueContractConcept(): unknown {
  const payload = secCompanyFactsPayload();
  if (!("facts" in (payload as Record<string, unknown>))) {
    return payload;
  }
  const facts = (payload as { facts: { "us-gaap": Record<string, unknown> } }).facts["us-gaap"];
  facts.Revenues = { units: { USD: [secFact(100)] } };
  facts.SalesRevenueNet = { units: { USD: [] } };
  facts.RevenueFromContractWithCustomerExcludingAssessedTax = {
    units: {
      USD: [secFact(90, { fy: 2025, filed: "2025-07-30", end: "2025-06-29" }), secFact(100)],
    },
  };
  return payload;
}

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

  test("normalizes Massive stock snapshots as supplemental equity market data", () => {
    const snapshots = normalizeMassiveSnapshotPayload(
      {
        tickers: [
          {
            ticker: "AAPL",
            todaysChangePerc: 1.25,
            day: { c: 192.4, o: 190.1, v: 72_000_000 },
            prevDay: { c: 189.9 },
          },
        ],
      },
      fetchedAt,
    );

    expect(snapshots).toEqual([
      {
        sourceId: "supplemental-market-massive-equity-aapl",
        assetClass: "equity",
        symbol: "AAPL",
        identity: {
          aliases: [{ provider: "massive", idKind: "ticker", value: "AAPL" }],
        },
        price: 192.4,
        changePercent24h: 1.25,
        volume: 72_000_000,
        open: 190.1,
        previousClose: 189.9,
        observedAt: fetchedAt,
      },
    ]);
  });

  test("marks an inaccessible Massive supplemental-market snapshot as unsupported coverage", async () => {
    const primarySnapshot: MarketSnapshot = {
      sourceId: "market-yahoo-equity-aapl",
      assetClass: "equity",
      symbol: "AAPL",
      price: 192.4,
      changePercent24h: 1.25,
      volume: 72_000_000,
      observedAt: fetchedAt,
    };

    const result = await massiveSupplementalMarketDataAdapter.collect(
      collectContext({
        massiveApiKey: "massive-key",
        request: requestExecutor({
          json: async ({ adapter }) => ({
            source: adapter,
            message: `${adapter} source request failed with status 403`,
          }),
        }),
      }),
      [primarySnapshot],
    );

    expect(result.supplementalMarketSnapshots).toEqual([]);
    expect(result.sourceGaps).toEqual([
      expect.objectContaining({
        source: "massive-supplemental-market",
        provider: "massive",
        capability: "market-data",
        cause: "unsupported-coverage",
        evidenceQualityImpact: "no-cap",
        message: "massive supplemental-market snapshot unavailable on current plan",
      }),
    ]);
  });

  test("normalizes Massive news with canonical URLs and provider metadata", () => {
    const sources = massiveNewsAdapter.normalizeNews(
      {
        results: [
          {
            id: "article-1",
            title: "Apple shares rise",
            article_url: "https://www.example.test/apple?utm_source=massive",
            publisher: { name: "Example Wire" },
            published_utc: "2026-05-18T12:00:00Z",
            description: "Shares moved after earnings.",
          },
        ],
      },
      "equity",
      fetchedAt,
    );

    expect(sources).toEqual([
      {
        id: "news-equity-massive-1",
        title: "Apple shares rise",
        url: "https://www.example.test/apple?utm_source=massive",
        publisher: "Example Wire",
        fetchedAt: "2026-05-18T12:00:00Z",
        kind: "news",
        assetClass: "equity",
        provider: "massive",
        providerArticleId: "article-1",
        canonicalUrl: "https://example.test/apple",
        summary: "Shares moved after earnings.",
      },
    ]);
  });

  test("normalizes titles only when they have enough dedupe signal", () => {
    expect(normalizeTitle("Same BTC story!")).toBe("same btc story");
    expect(normalizeTitle("Nikkei 株式 Market Rally")).toBe("nikkei 株式 market rally");
    expect(normalizeTitle("2025")).toBeUndefined();
    expect(normalizeTitle("2025 2026")).toBeUndefined();
    expect(normalizeTitle("BTC")).toBeUndefined();
  });

  test("keeps canonical URL when title merge survivor lacked a URL", async () => {
    const adapters: NewsAdapter[] = [
      {
        name: "wire-a",
        provider: "wire-a",
        normalizeNews: () => [],
        collect: async () => ({
          rawSnapshots: [],
          newsSources: [
            {
              id: "wire-a-1",
              title: "Acme earnings report jumps",
              fetchedAt,
              kind: "news",
              assetClass: "equity",
              provider: "wire-a",
            },
          ],
          sourceGaps: [],
        }),
      },
      {
        name: "wire-b",
        provider: "wire-b",
        normalizeNews: () => [],
        collect: async () => ({
          rawSnapshots: [],
          newsSources: [
            {
              id: "wire-b-1",
              title: "Acme earnings report jumps!",
              url: "https://www.example.test/acme?utm_source=wire-b",
              fetchedAt,
              kind: "news",
              assetClass: "equity",
              provider: "wire-b",
            },
          ],
          sourceGaps: [],
        }),
      },
    ];

    const result = await createMultiNewsAdapter(adapters).collect(collectContext({ newsLimit: 5 }));

    expect(result.newsSources).toHaveLength(1);
    expect(result.newsSources[0]).toMatchObject({
      canonicalUrl: "https://example.test/acme",
      providerAliases: [{ provider: "wire-a" }, { provider: "wire-b" }],
    });
    expect(result.newsAnalytics?.canonicalDuplicateNewsSourceCount).toBe(1);
  });
});

describe("source registry", () => {
  test("keeps equity and crypto adapters separate", () => {
    const registry = createSourceRegistry();

    expect(registry.marketDataFor("equity").name).toBe("yahoo");
    expect(registry.marketDataFor("crypto").name).toBe("coingecko");
    expect(registry.newsFor("crypto").name).toBe("multi-news");
    expect(registry.marketContextFor("equity").name).toBe("market-context");
    expect(registry.supplementalMarketDataFor("equity").map((adapter) => adapter.name)).toEqual([
      "massive-supplemental-market",
    ]);
    expect(registry.supplementalMarketDataFor("crypto")).toEqual([]);
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
    const cachedFetchedAt = "2026-05-18T00:00:00.000Z";
    const result = await marketContextAdapter.collect(
      collectContext({
        command: { jobType: "daily", assetClass: "equity", depth: "brief" },
        fredApiKey: "fred-key",
        request: requestExecutor({
          json: async ({ adapter }) => {
            const payload = {
              observations: [
                { date: "2026-05-19", value: "4.25" },
                { date: "2026-05-16", value: "4.10" },
              ],
            };
            return rawJson(adapter, payload, cachedFetchedAt);
          },
        }),
      }),
    );

    expect(result.marketContext?.assetClass).toBe("equity");
    expect(result.marketContext?.items).toHaveLength(1);
    expect(result.marketContext?.items[0]?.observedAt).toBe(cachedFetchedAt);
    expect(result.marketContext?.items[0]?.metrics?.DGS10).toBe(4.25);
    expect(result.marketContext?.items[0]?.metrics?.DGS10Change).toBeCloseTo(0.15);
    expect(result.sources).toEqual([
      expect.objectContaining({
        id: "market-context-fred-macro",
        kind: "market-context",
        assetClass: "equity",
        provider: "fred",
        fetchedAt: cachedFetchedAt,
      }),
    ]);
    expect(result.sourceGaps).toEqual([]);
  });

  test("emits missing-key Market Context gap for market updates", async () => {
    const result = await marketContextAdapter.collect(
      collectContext({
        command: { jobType: "weekly", assetClass: "crypto", depth: "brief" },
      }),
    );

    expect(result.marketContext).toEqual({
      assetClass: "crypto",
      items: [],
      gaps: [
        expect.objectContaining({
          source: "fred-macro",
          message: "MARKET_BOT_FRED_API_KEY is not set",
          evidenceQualityImpact: "no-cap",
        }),
      ],
    });
    expect(result.sourceGaps).toEqual([
      expect.objectContaining({
        source: "fred-macro",
        message: "MARKET_BOT_FRED_API_KEY is not set",
        evidenceQualityImpact: "no-cap",
      }),
    ]);
  });

  test("skips Market Context for ticker runs", async () => {
    const result = await marketContextAdapter.collect(
      collectContext({
        command: { jobType: "ticker", assetClass: "equity", symbol: "AAPL", depth: "brief" },
        fredApiKey: "fred-key",
      }),
    );

    expect(result).toEqual({ rawSnapshots: [], sources: [], sourceGaps: [] });
  });
});

describe("news provider collection", () => {
  test("passes provider request facts without collector execution plumbing", async () => {
    let requestKeys: readonly string[] = [];

    await finnhubNewsAdapter.collect(
      collectContext({
        command: { jobType: "daily", assetClass: "crypto", depth: "brief" },
        finnhubApiToken: "finnhub-token",
        request: requestExecutor({
          json: async (request) => {
            requestKeys = Object.keys(request).toSorted();
            return rawJson(request.adapter, []);
          },
        }),
      }),
    );

    expect(requestKeys).toEqual(["adapter", "url"]);
  });

  test("passes Yahoo credential retry as a request-specific fetch override", async () => {
    const requestedAdaptersAndUrls: { adapter: string; scrId: string | null }[] = [];

    await yahooMarketDataAdapter.collect(
      collectContext({
        request: requestExecutor({
          json: async (request) => {
            expect(typeof request.fetch).toBe("function");
            const scrId = new URL(request.url).searchParams.get("scrIds");
            requestedAdaptersAndUrls.push({ adapter: request.adapter, scrId });
            const isScreener = scrId !== null;
            const payload = isScreener
              ? { finance: { result: [{ quotes: [] }] } }
              : { quoteResponse: { result: [] } };
            return rawJson(request.adapter, payload);
          },
        }),
      }),
    );

    expect(requestedAdaptersAndUrls).toEqual([
      { adapter: "yahoo-gainers", scrId: "day_gainers" },
      { adapter: "yahoo-losers", scrId: "day_losers" },
      { adapter: "yahoo-actives", scrId: "most_actives" },
      { adapter: "yahoo-regime", scrId: null },
    ]);
  });

  test("collects covered instrument and equity regime proxies for ticker runs", async () => {
    const requestedAdaptersAndUrls: { adapter: string; symbols: string | null }[] = [];

    const result = await yahooMarketDataAdapter.collect(
      collectContext({
        command: { jobType: "ticker", assetClass: "equity", symbol: "AAPL", depth: "brief" },
        request: requestExecutor({
          json: async (request) => {
            const symbols = new URL(request.url).searchParams.get("symbols");
            requestedAdaptersAndUrls.push({ adapter: request.adapter, symbols });
            const quoteResults =
              symbols === "AAPL"
                ? [
                    {
                      symbol: "AAPL",
                      regularMarketPrice: 190,
                      regularMarketChangePercent: -1.5,
                      regularMarketVolume: 40_000_000,
                    },
                  ]
                : [
                    {
                      symbol: "SPY",
                      regularMarketPrice: 510,
                      regularMarketChangePercent: 0.4,
                      regularMarketVolume: 70_000_000,
                      fiftyDayAverage: 500,
                    },
                    {
                      symbol: "QQQ",
                      regularMarketPrice: 430,
                      regularMarketChangePercent: 0.6,
                      regularMarketVolume: 50_000_000,
                      fiftyDayAverage: 420,
                    },
                  ];
            return rawJson(request.adapter, { quoteResponse: { result: quoteResults } });
          },
        }),
      }),
    );

    expect(requestedAdaptersAndUrls).toEqual([
      { adapter: "yahoo-ticker", symbols: "AAPL" },
      { adapter: "yahoo-regime", symbols: EQUITY_REGIME_SYMBOLS.join(",") },
    ]);
    expect(result.marketSnapshots.map((snapshot) => snapshot.symbol)).toEqual([
      "AAPL",
      "SPY",
      "QQQ",
    ]);
    expect(result.rawSnapshots.map((snapshot) => snapshot.adapter)).toEqual([
      "yahoo-ticker",
      "yahoo-regime",
    ]);
  });

  test("keeps regime quote fields when a proxy also appears as a mover", async () => {
    const result = await yahooMarketDataAdapter.collect(
      collectContext({
        request: requestExecutor({
          json: async (request) => {
            const scrId = new URL(request.url).searchParams.get("scrIds");
            if (scrId === "most_actives") {
              // SPY tops most_actives by volume, but the screener quote is not the regime source.
              return rawJson(request.adapter, {
                finance: {
                  result: [
                    {
                      quotes: [
                        {
                          symbol: "SPY",
                          regularMarketPrice: 530,
                          regularMarketChangePercent: 8,
                          regularMarketVolume: 200_000_000,
                        },
                      ],
                    },
                  ],
                },
              });
            }
            if (scrId !== null) {
              return rawJson(request.adapter, { finance: { result: [{ quotes: [] }] } });
            }
            // Regime quote carries the authoritative fields for the same symbol.
            return rawJson(request.adapter, {
              quoteResponse: {
                result: [
                  {
                    symbol: "SPY",
                    regularMarketPrice: 510,
                    regularMarketChangePercent: 0.4,
                    regularMarketVolume: 90_000_000,
                    fiftyDayAverage: 500,
                  },
                ],
              },
            });
          },
        }),
      }),
    );

    const spy = result.marketSnapshots.filter((snapshot) => snapshot.symbol === "SPY");
    expect(spy).toHaveLength(1);
    expect(spy[0]).toMatchObject({
      price: 510,
      changePercent24h: 0.4,
      volume: 90_000_000,
      fiftyDayAverage: 500,
    });
  });

  test("caps Finnhub normalized sources after provider fetch", async () => {
    const result = await finnhubNewsAdapter.collect(
      collectContext({
        command: { jobType: "daily", assetClass: "crypto", depth: "brief" },
        finnhubApiToken: "finnhub-token",
        request: requestExecutor({
          json: async ({ adapter }) => ({
            rawSnapshot: {
              id: "raw-finnhub-news-test",
              adapter,
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
        }),
      }),
    );

    expect(result.newsSources).toHaveLength(1);
    expect(result.newsSources[0]?.providerArticleId).toBe("1");
  });
});

describe("SEC fundamental evidence", () => {
  test("extracts operating facts with latest comparable deltas", () => {
    const result = summarizeSecFundamentals(secCompanyFactsPayload());

    expect(result?.metrics).toMatchObject({
      revenue: 100,
      revenuePrior: 90,
      grossProfit: 40,
      operatingIncome: 25,
      netIncome: 20,
      dilutedEps: 2,
      cash: 30,
      debt: 50,
      operatingCashFlow: 28,
      capex: 6,
      dilutedShares: 9,
    });
    expect(result?.metrics.revenueDeltaPercent).toBeCloseTo(11.11);
    expect(result?.metrics.dilutedSharesDeltaPercent).toBeCloseTo(-10);
    expect(result?.gaps).toEqual([]);
  });

  test("uses concept fallbacks and omits non-comparable deltas", () => {
    const result = summarizeSecFundamentals({
      facts: {
        "us-gaap": {
          SalesRevenueNet: {
            units: {
              USD: [
                secFact(80, { fy: 2025, fp: "Q1", filed: "2025-04-30", end: "2025-03-29" }),
                secFact(100),
              ],
            },
          },
          CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents: secFactUnits(30, 25),
          LongTermDebtCurrent: secFactUnits(5, 4),
          LongTermDebtNoncurrent: secFactUnits(45, 41),
        },
      },
    });

    expect(result?.metrics).toMatchObject({
      revenue: 100,
      cash: 30,
      cashPrior: 25,
      debt: 50,
      debtPrior: 45,
    });
    expect(result?.metrics.revenuePrior).toBeUndefined();
    expect(result?.metrics.revenueDeltaPercent).toBeUndefined();
    expect(result?.gaps.map((gap) => gap.message)).toContain(
      "Missing comparable SEC company facts for YoY deltas: revenue",
    );
    expect(result?.gaps.some((gap) => gap.message.startsWith("Missing SEC company facts:"))).toBe(
      true,
    );
  });

  test("uses contract revenue fallback for comparable revenue deltas", () => {
    const result = summarizeSecFundamentals(secCompanyFactsPayloadWithRevenueContractConcept());

    expect(result?.metrics).toMatchObject({
      revenue: 100,
      revenuePrior: 90,
    });
    expect(result?.metrics.revenueDeltaPercent).toBeCloseTo(11.11);
    expect(result?.gaps.map((gap) => gap.message)).not.toContain(
      "Missing comparable SEC company facts for YoY deltas: revenue",
    );
  });

  test("reports the latest revenue fact's reporting-period length in months", () => {
    const result = summarizeSecFundamentals({
      facts: {
        "us-gaap": {
          Revenues: {
            units: {
              USD: [
                secFact(90, {
                  fy: 2025,
                  filed: "2025-07-30",
                  start: "2025-04-01",
                  end: "2025-06-29",
                }),
                secFact(100, { start: "2026-04-01", end: "2026-06-29" }),
              ],
            },
          },
        },
      },
    });

    expect(result?.metrics.revenue).toBe(100);
    expect(result?.metrics.revenuePeriodMonths).toBe(3);
  });

  test("omits revenue period length when the latest fact has no reporting span", () => {
    const result = summarizeSecFundamentals(secCompanyFactsPayload());

    expect(result?.metrics.revenue).toBe(100);
    expect(result?.metrics.revenuePeriodMonths).toBeUndefined();
  });
});

describe("extended evidence provider collection", () => {
  test("collects compact equity extended evidence", async () => {
    const requests: { adapter: string; url: string; headers: Headers }[] = [];
    const fredCachedAt = "2026-05-18T00:00:00.000Z";
    const secFactsCachedAt = "2026-05-17T00:00:00.000Z";
    const finnhubCachedAt = "2026-05-16T00:00:00.000Z";
    const tradierChainCachedAt = "2026-05-15T00:00:00.000Z";
    const result = await equityExtendedEvidenceAdapter.collect(
      collectContext({
        command: { jobType: "ticker", assetClass: "equity", symbol: "aapl", depth: "brief" },
        finnhubApiToken: "finnhub-token",
        fredApiKey: "fred-key",
        tradierApiToken: "tradier-token",
        secUserAgent: "market-bot test@example.test",
        request: requestExecutor({
          json: async ({ url, adapter, init }) => {
            requests.push({ adapter, url, headers: new Headers(init?.headers) });
            let payload: unknown = {};
            if (adapter === "sec-tickers") {
              payload = { "0": { cik_str: 320_193, ticker: "AAPL", title: "Apple Inc." } };
            } else if (adapter === "sec-submissions") {
              payload = { filings: { recent: { form: ["10-Q"], filingDate: ["2026-05-01"] } } };
            } else if (adapter === "sec-companyfacts") {
              payload = secCompanyFactsPayload();
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
            let rawFetchedAt = fetchedAt;
            if (adapter === "sec-companyfacts") {
              rawFetchedAt = secFactsCachedAt;
            } else if (adapter.startsWith("fred-")) {
              rawFetchedAt = fredCachedAt;
            } else if (adapter === "tradier-options") {
              rawFetchedAt = tradierChainCachedAt;
            } else if (adapter.startsWith("finnhub-events")) {
              rawFetchedAt = finnhubCachedAt;
            }
            return rawJson(adapter, payload, rawFetchedAt);
          },
        }),
      }),
    );

    const secItem = result.extendedEvidence?.items.find((item) => item.category === "sec-edgar");
    expect(secItem?.sourceIds).toEqual([
      "extended-sec-edgar-aapl-filings",
      "extended-sec-edgar-aapl-fundamentals",
    ]);
    expect(secItem?.summary).toContain("Recent SEC filings: 10-Q 2026-05-01.");
    expect(secItem?.summary).toContain("SEC Fundamental Evidence");
    expect(secItem?.observedAt).toBe(secFactsCachedAt);
    expect(secItem?.metrics?.revenue).toBe(100);
    expect(secItem?.metrics?.revenuePrior).toBe(90);
    expect(secItem?.metrics?.revenueDeltaPercent).toBeCloseTo(11.11);
    expect(result.extendedEvidence?.items.map((item) => item.category)).toContain("sec-edgar");
    expect(result.extendedEvidence?.items.map((item) => item.category)).toContain("equity-events");
    expect(result.extendedEvidence?.items.map((item) => item.category)).toContain("fred-macro");
    expect(
      result.extendedEvidence?.items.find((item) => item.category === "fred-macro")?.metrics
        ?.DGS10Change,
    ).toBeCloseTo(0.15);
    expect(
      result.extendedEvidence?.items.find((item) => item.category === "fred-macro")?.observedAt,
    ).toBe(fredCachedAt);
    expect(
      result.extendedEvidence?.items.find((item) => item.category === "equity-events")?.observedAt,
    ).toBe(finnhubCachedAt);
    expect(result.extendedEvidence?.items.map((item) => item.category)).toContain("options-iv");
    expect(
      result.extendedEvidence?.items.find((item) => item.category === "options-iv")?.observedAt,
    ).toBe(tradierChainCachedAt);
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
    const result = await cryptoExtendedEvidenceAdapter.collect(
      collectContext({
        command: { jobType: "ticker", assetClass: "crypto", symbol: "BTC", depth: "brief" },
      }),
    );

    expect(result.extendedEvidence?.items).toEqual([]);
    expect(result.sourceGaps.map((gap) => gap.source)).toEqual([
      "fred-macro",
      "glassnode-on-chain",
    ]);
  });

  test("marks inaccessible Finnhub event routes as unsupported coverage", async () => {
    const result = await collectFinnhubEvents(
      collectContext({
        command: { jobType: "ticker", assetClass: "equity", symbol: "AAPL", depth: "deep" },
        finnhubApiToken: "finnhub-token",
        request: requestExecutor({
          json: async ({ adapter }) => {
            if (adapter === "finnhub-events-1") {
              return rawJson(adapter, { earningsCalendar: [{ symbol: "AAPL" }] });
            }
            return {
              source: adapter,
              message: `${adapter} source request failed with status 403`,
            };
          },
        }),
      }),
    );

    expect(result.items).toHaveLength(1);
    expect(result.gaps).toEqual([
      expect.objectContaining({
        source: "finnhub-events-2",
        provider: "finnhub",
        cause: "unsupported-coverage",
        message: "Finnhub dividend endpoint is unavailable for the configured token (status 403)",
      }),
      expect.objectContaining({
        source: "finnhub-events-3",
        provider: "finnhub",
        cause: "unsupported-coverage",
        message: "Finnhub split endpoint is unavailable for the configured token (status 403)",
      }),
    ]);
  });

  test("routes crypto extended evidence only through crypto providers", async () => {
    const adapters: string[] = [];
    const result = await cryptoExtendedEvidenceAdapter.collect(
      collectContext({
        command: { jobType: "ticker", assetClass: "crypto", symbol: "BTC", depth: "brief" },
        fredApiKey: "fred-key",
        glassnodeApiKey: "glassnode-key",
        request: requestExecutor({
          json: async ({ adapter }) => {
            adapters.push(adapter);
            const payload = adapter.startsWith("fred-")
              ? { observations: [{ value: "4.25" }] }
              : [{ v: 12 }];
            return rawJson(adapter, payload);
          },
        }),
      }),
    );

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
