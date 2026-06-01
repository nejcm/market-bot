import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rankMovers } from "../src/movers/ranking";
import { collectSources, resetSourceResilienceForTests } from "../src/sources/collector";
import { recordSeenNewsSources } from "../src/sources/news-seen";

function jsonResponse(payload: unknown): Response {
  return Response.json(payload);
}

let tmpDirs: string[] = [];

beforeEach(() => {
  resetSourceResilienceForTests();
  tmpDirs = [];
});

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempSeenPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "collector-news-seen-test-"));
  tmpDirs.push(dir);
  return join(dir, "news-seen.json");
}

describe("collectSources", () => {
  test("collects daily equity market data and news with injectable fetch", async () => {
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes("screener")) {
        return jsonResponse({
          finance: {
            result: [
              {
                quotes: [
                  {
                    symbol: "AAPL",
                    regularMarketPrice: 190,
                    regularMarketChangePercent: 2,
                    regularMarketVolume: 80_000_000,
                  },
                ],
              },
            ],
          },
        });
      }

      if (url.includes("quote")) {
        return jsonResponse({
          quoteResponse: {
            result: [
              {
                symbol: "SPY",
                regularMarketPrice: 510,
                regularMarketChangePercent: 0.4,
                regularMarketVolume: 70_000_000,
              },
            ],
          },
        });
      }

      return jsonResponse({
        news: [
          {
            title: "Markets rise",
            link: "https://example.test/markets",
            publisher: "Example",
            providerPublishTime: 1_779_120_000,
          },
        ],
      });
    };

    const result = await collectSources(
      { jobType: "daily", assetClass: "equity", depth: "brief" },
      { equityMoverLimit: 2, cryptoMoverLimit: 2, newsLimit: 2, sourceTimeoutMs: 1000 },
      new Date("2026-05-19T00:00:00.000Z"),
      fetchImpl,
    );

    expect(result.rawSnapshots).toHaveLength(3);
    expect(result.marketSnapshots[0]?.symbol).toBe("AAPL");
    expect(result.marketSnapshots.map((snapshot) => snapshot.symbol)).toContain("SPY");
    expect(result.newsSources[0]?.id).toBe("news-equity-1");
    expect(result.sourceGaps.map((gap) => gap.source)).toEqual([
      "marketaux-news",
      "finnhub-news",
      "fred-macro",
    ]);
    expect(result.marketContext).toEqual({
      assetClass: "equity",
      items: [],
      gaps: [{ source: "fred-macro", message: "MARKET_BOT_FRED_API_KEY is not set" }],
    });
    expect(result.marketContextSources).toEqual([]);
  });

  test("collects weekly equity through market-update mover and regime sources", async () => {
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes("screener")) {
        return jsonResponse({
          finance: {
            result: [
              {
                quotes: [
                  {
                    symbol: "MSFT",
                    regularMarketPrice: 420,
                    regularMarketChangePercent: 3,
                    regularMarketVolume: 50_000_000,
                  },
                ],
              },
            ],
          },
        });
      }

      if (url.includes("quote")) {
        return jsonResponse({
          quoteResponse: {
            result: [
              {
                symbol: "SPY",
                regularMarketPrice: 510,
                regularMarketChangePercent: 0.4,
                regularMarketVolume: 70_000_000,
              },
            ],
          },
        });
      }

      return jsonResponse({ news: [] });
    };

    const result = await collectSources(
      { jobType: "weekly", assetClass: "equity", depth: "brief" },
      { equityMoverLimit: 2, cryptoMoverLimit: 2, newsLimit: 2, sourceTimeoutMs: 1000 },
      new Date("2026-05-19T00:00:00.000Z"),
      fetchImpl,
    );

    expect(result.rawSnapshots).toHaveLength(3);
    expect(result.marketSnapshots.map((snapshot) => snapshot.symbol)).toEqual(["MSFT", "SPY"]);
  });

  test("reuses same-day equivalent cache entries across daily and weekly equity runs", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "collector-cache-test-"));
    tmpDirs.push(cacheDir);
    const requestedUrls: string[] = [];
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      requestedUrls.push(url);

      if (url.includes("screener")) {
        return jsonResponse({
          finance: {
            result: [
              {
                quotes: [
                  {
                    symbol: "AAPL",
                    regularMarketPrice: 190,
                    regularMarketChangePercent: 2,
                    regularMarketVolume: 80_000_000,
                  },
                ],
              },
            ],
          },
        });
      }

      if (url.includes("quote")) {
        return jsonResponse({
          quoteResponse: {
            result: [
              {
                symbol: "SPY",
                regularMarketPrice: 510,
                regularMarketChangePercent: 0.4,
                regularMarketVolume: 70_000_000,
              },
            ],
          },
        });
      }

      return jsonResponse({
        news: [
          {
            title: "Markets rise",
            link: "https://example.test/markets",
            publisher: "Example",
            providerPublishTime: 1_779_120_000,
          },
        ],
      });
    };
    const sourceOptions = {
      equityMoverLimit: 2,
      cryptoMoverLimit: 2,
      newsLimit: 2,
      sourceTimeoutMs: 1000,
      cacheDir,
    };
    const now = new Date("2026-05-19T00:00:00.000Z");

    const daily = await collectSources(
      { jobType: "daily", assetClass: "equity", depth: "brief" },
      sourceOptions,
      now,
      fetchImpl,
    );
    const firstRunFetches = requestedUrls.length;
    const weekly = await collectSources(
      { jobType: "weekly", assetClass: "equity", depth: "brief" },
      sourceOptions,
      now,
      fetchImpl,
    );

    expect(firstRunFetches).toBeGreaterThan(0);
    expect(requestedUrls).toHaveLength(firstRunFetches);
    expect(daily.marketSnapshots.map((snapshot) => snapshot.symbol)).toEqual(["AAPL", "SPY"]);
    expect(weekly.marketSnapshots.map((snapshot) => snapshot.symbol)).toEqual(["AAPL", "SPY"]);
    expect(weekly.sourceGaps.map((gap) => gap.source)).toEqual([
      "marketaux-news",
      "finnhub-news",
      "fred-macro",
    ]);
  });

  test("filters crypto ticker collection by symbol", async () => {
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes("coingecko")) {
        return jsonResponse([
          {
            symbol: "eth",
            current_price: 3500,
            price_change_percentage_24h: 1,
            total_volume: 10_000_000_000,
          },
          {
            symbol: "btc",
            current_price: 103_000,
            price_change_percentage_24h: 2,
            total_volume: 40_000_000_000,
          },
        ]);
      }

      return jsonResponse({ news: [] });
    };

    const result = await collectSources(
      { jobType: "ticker", assetClass: "crypto", symbol: "BTC", depth: "deep" },
      { equityMoverLimit: 2, cryptoMoverLimit: 2, newsLimit: 2, sourceTimeoutMs: 1000 },
      new Date("2026-05-19T00:00:00.000Z"),
      fetchImpl,
    );

    expect(result.marketSnapshots.map((snapshot) => snapshot.symbol)).toEqual(["BTC"]);
  });

  test("preserves partial results when one source fails", async () => {
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes("coingecko")) {
        return jsonResponse([
          {
            symbol: "btc",
            current_price: 103_000,
            price_change_percentage_24h: 2,
            total_volume: 40_000_000_000,
          },
        ]);
      }

      return new Response("bad gateway", { status: 502 });
    };

    const result = await collectSources(
      { jobType: "daily", assetClass: "crypto", depth: "brief" },
      { equityMoverLimit: 2, cryptoMoverLimit: 2, newsLimit: 2, sourceTimeoutMs: 1000 },
      new Date("2026-05-19T00:00:00.000Z"),
      fetchImpl,
      [],
    );

    expect(result.marketSnapshots.map((snapshot) => snapshot.symbol)).toEqual(["BTC"]);
    expect(result.newsSources).toEqual([]);
    expect(result.sourceGaps.map((gap) => gap.source)).toContain("yahoo-news");
  });

  test("keeps daily equity regime quotes when movers source fails", async () => {
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes("screener")) {
        return new Response("bad gateway", { status: 502 });
      }

      if (url.includes("quote")) {
        return jsonResponse({
          quoteResponse: {
            result: [
              {
                symbol: "SPY",
                regularMarketPrice: 510,
                regularMarketChangePercent: 0.4,
                regularMarketVolume: 70_000_000,
              },
            ],
          },
        });
      }

      return jsonResponse({ news: [] });
    };

    const result = await collectSources(
      { jobType: "daily", assetClass: "equity", depth: "brief" },
      { equityMoverLimit: 2, cryptoMoverLimit: 2, newsLimit: 2, sourceTimeoutMs: 1000 },
      new Date("2026-05-19T00:00:00.000Z"),
      fetchImpl,
      [],
    );

    expect(result.marketSnapshots.map((snapshot) => snapshot.symbol)).toEqual(["SPY"]);
    expect(result.sourceGaps[0]?.source).toBe("yahoo-movers");
  });

  test("does not call Massive or emit a gap when key is missing", async () => {
    const requestedUrls: string[] = [];
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      requestedUrls.push(url);

      if (url.includes("screener")) {
        return jsonResponse({
          finance: {
            result: [
              {
                quotes: [
                  {
                    symbol: "AAPL",
                    regularMarketPrice: 190,
                    regularMarketChangePercent: 2,
                    regularMarketVolume: 80_000_000,
                  },
                ],
              },
            ],
          },
        });
      }

      if (url.includes("quote")) {
        return jsonResponse({ quoteResponse: { result: [] } });
      }

      return jsonResponse({ news: [] });
    };

    const result = await collectSources(
      { jobType: "daily", assetClass: "equity", depth: "brief" },
      { equityMoverLimit: 2, cryptoMoverLimit: 2, newsLimit: 2, sourceTimeoutMs: 1000 },
      new Date("2026-05-19T00:00:00.000Z"),
      fetchImpl,
    );

    expect(requestedUrls.some((url) => url.includes("massive.com"))).toBe(false);
    expect(result.supplementalMarketSnapshots).toEqual([]);
    expect(result.sourceGaps.map((gap) => gap.source)).not.toContain("massive-supplemental-market");
    expect(result.sourceGaps.map((gap) => gap.source)).not.toContain("massive-news");
  });

  test("collects Massive supplemental equity snapshots without changing primary movers", async () => {
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes("screener")) {
        return jsonResponse({
          finance: {
            result: [
              {
                quotes: [
                  {
                    symbol: "AAPL",
                    regularMarketPrice: 190,
                    regularMarketChangePercent: 2,
                    regularMarketVolume: 80_000_000,
                  },
                ],
              },
            ],
          },
        });
      }

      if (url.includes("quote")) {
        return jsonResponse({
          quoteResponse: {
            result: [
              {
                symbol: "SPY",
                regularMarketPrice: 510,
                regularMarketChangePercent: 0.4,
                regularMarketVolume: 70_000_000,
              },
            ],
          },
        });
      }

      if (url.includes("api.massive.com/v2/snapshot")) {
        return jsonResponse({
          tickers: [
            {
              ticker: "AAPL",
              todaysChangePerc: 9,
              day: { c: 195, o: 190, v: 90_000_000 },
              prevDay: { c: 188 },
            },
            {
              ticker: "SPY",
              todaysChangePerc: 5,
              day: { c: 512, v: 75_000_000 },
            },
          ],
        });
      }

      return jsonResponse({ results: [] });
    };

    const result = await collectSources(
      { jobType: "daily", assetClass: "equity", depth: "brief" },
      {
        equityMoverLimit: 2,
        cryptoMoverLimit: 2,
        newsLimit: 2,
        sourceTimeoutMs: 1000,
        massiveApiKey: "massive-key",
      },
      new Date("2026-05-19T00:00:00.000Z"),
      fetchImpl,
    );

    expect(result.marketSnapshots.map((snapshot) => snapshot.symbol)).toEqual(["AAPL", "SPY"]);
    expect(result.supplementalMarketSnapshots.map((snapshot) => snapshot.symbol)).toEqual([
      "AAPL",
      "SPY",
    ]);
    expect(rankMovers(result.marketSnapshots, 2).map((mover) => mover.snapshot.sourceId)).toEqual([
      "market-yahoo-equity-aapl",
      "market-yahoo-equity-spy",
    ]);
    expect(result.rawSnapshots.map((snapshot) => snapshot.adapter)).toContain(
      "massive-supplemental-market",
    );
  });

  test("adds Massive equity news into provider round-robin", async () => {
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes("screener")) {
        return jsonResponse({
          finance: {
            result: [
              {
                quotes: [
                  {
                    symbol: "AAPL",
                    regularMarketPrice: 190,
                    regularMarketChangePercent: 2,
                    regularMarketVolume: 80_000_000,
                  },
                ],
              },
            ],
          },
        });
      }

      if (url.includes("quote")) {
        return jsonResponse({ quoteResponse: { result: [] } });
      }

      if (url.includes("marketaux")) {
        return jsonResponse({
          data: [
            {
              uuid: "marketaux-1",
              title: "MarketAux equity story",
              url: "https://example.test/marketaux",
              source: "Example",
              published_at: "2026-05-18T12:00:00.000Z",
            },
          ],
        });
      }

      if (url.includes("finnhub")) {
        return jsonResponse([
          {
            id: 1,
            headline: "Finnhub equity story",
            url: "https://example.test/finnhub",
            source: "Example",
            datetime: 1_779_120_000,
          },
        ]);
      }

      if (url.includes("v2/reference/news")) {
        return jsonResponse({
          results: [
            {
              id: "massive-1",
              title: "Massive equity story",
              article_url: "https://example.test/massive",
              publisher: { name: "Example" },
              published_utc: "2026-05-18T12:00:00.000Z",
            },
          ],
        });
      }

      if (url.includes("api.massive.com/v2/snapshot")) {
        return jsonResponse({ tickers: [] });
      }

      return jsonResponse({
        news: [
          {
            title: "Yahoo equity story",
            link: "https://example.test/yahoo",
            publisher: "Example",
            providerPublishTime: 1_779_120_000,
          },
        ],
      });
    };

    const result = await collectSources(
      { jobType: "daily", assetClass: "equity", depth: "brief" },
      {
        equityMoverLimit: 2,
        cryptoMoverLimit: 2,
        newsLimit: 4,
        sourceTimeoutMs: 1000,
        marketauxApiToken: "marketaux-token",
        finnhubApiToken: "finnhub-token",
        massiveApiKey: "massive-key",
      },
      new Date("2026-05-19T00:00:00.000Z"),
      fetchImpl,
    );

    expect(result.newsSources.map((source) => source.provider)).toEqual([
      "marketaux",
      "finnhub",
      "yahoo-news",
      "massive",
    ]);
  });

  test("does not call Massive for crypto even when configured", async () => {
    const requestedUrls: string[] = [];
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.includes("coingecko")) {
        return jsonResponse([
          {
            symbol: "btc",
            current_price: 103_000,
            price_change_percentage_24h: 2,
            total_volume: 40_000_000_000,
          },
        ]);
      }

      return jsonResponse({ news: [] });
    };

    const result = await collectSources(
      { jobType: "daily", assetClass: "crypto", depth: "brief" },
      {
        equityMoverLimit: 2,
        cryptoMoverLimit: 2,
        newsLimit: 2,
        sourceTimeoutMs: 1000,
        massiveApiKey: "massive-key",
      },
      new Date("2026-05-19T00:00:00.000Z"),
      fetchImpl,
    );

    expect(requestedUrls.some((url) => url.includes("massive.com"))).toBe(false);
    expect(result.supplementalMarketSnapshots).toEqual([]);
  });

  test("emits Massive source gap while preserving other equity providers", async () => {
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes("screener")) {
        return jsonResponse({
          finance: {
            result: [
              {
                quotes: [
                  {
                    symbol: "AAPL",
                    regularMarketPrice: 190,
                    regularMarketChangePercent: 2,
                    regularMarketVolume: 80_000_000,
                  },
                ],
              },
            ],
          },
        });
      }

      if (url.includes("quote")) {
        return jsonResponse({ quoteResponse: { result: [] } });
      }

      if (url.includes("massive.com")) {
        return new Response("bad gateway", { status: 502 });
      }

      return jsonResponse({ news: [] });
    };

    const result = await collectSources(
      { jobType: "daily", assetClass: "equity", depth: "brief" },
      {
        equityMoverLimit: 2,
        cryptoMoverLimit: 2,
        newsLimit: 2,
        sourceTimeoutMs: 1000,
        massiveApiKey: "massive-key",
      },
      new Date("2026-05-19T00:00:00.000Z"),
      fetchImpl,
      [],
    );

    expect(result.marketSnapshots.map((snapshot) => snapshot.symbol)).toEqual(["AAPL"]);
    expect(result.sourceGaps.map((gap) => gap.source)).toEqual([
      "marketaux-news",
      "finnhub-news",
      "massive-news",
      "fred-macro",
      "massive-supplemental-market",
    ]);
  });

  test("retries on transient 503 and succeeds on third attempt", async () => {
    let coinGeckoCalls = 0;
    const fetchImpl = (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes("coingecko")) {
        coinGeckoCalls += 1;
        if (coinGeckoCalls < 3) {
          return Promise.resolve(new Response("service unavailable", { status: 503 }));
        }
        return Promise.resolve(
          Response.json([
            {
              symbol: "btc",
              current_price: 103_000,
              price_change_percentage_24h: 2,
              total_volume: 40_000_000_000,
            },
          ]),
        );
      }
      return Promise.resolve(Response.json({ news: [] }));
    };

    const result = await collectSources(
      { jobType: "daily", assetClass: "crypto", depth: "brief" },
      { equityMoverLimit: 2, cryptoMoverLimit: 2, newsLimit: 2, sourceTimeoutMs: 1000 },
      new Date("2026-05-19T00:00:00.000Z"),
      fetchImpl,
      [0, 0],
    );

    expect(coinGeckoCalls).toBe(3);
    expect(result.marketSnapshots.map((snapshot) => snapshot.symbol)).toEqual(["BTC"]);
    expect(result.sourceGaps.map((gap) => gap.source)).toEqual([
      "marketaux-news",
      "finnhub-news",
      "fred-macro",
    ]);
  });

  test("collects and dedupes news across MarketAux, Finnhub, and Yahoo", async () => {
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes("coingecko")) {
        return jsonResponse([
          {
            symbol: "btc",
            current_price: 103_000,
            price_change_percentage_24h: 2,
            total_volume: 40_000_000_000,
          },
        ]);
      }

      if (url.includes("marketaux")) {
        return jsonResponse({
          data: [
            {
              uuid: "marketaux-1",
              title: "Same BTC story",
              url: "https://www.example.test/btc?utm_source=marketaux",
              source: "Example",
              published_at: "2026-05-18T12:00:00.000Z",
              description: "MarketAux summary",
            },
          ],
        });
      }

      if (url.includes("finnhub")) {
        return jsonResponse([
          {
            id: 55,
            headline: "Same BTC story",
            url: "https://example.test/btc",
            source: "Example",
            datetime: 1_779_120_000,
            summary: "Finnhub summary",
          },
        ]);
      }

      return jsonResponse({
        news: [
          {
            title: "Different crypto story",
            link: "https://example.test/crypto",
            publisher: "Example",
            providerPublishTime: 1_779_120_000,
          },
        ],
      });
    };

    const result = await collectSources(
      { jobType: "daily", assetClass: "crypto", depth: "brief" },
      {
        equityMoverLimit: 2,
        cryptoMoverLimit: 2,
        newsLimit: 3,
        sourceTimeoutMs: 1000,
        marketauxApiToken: "marketaux-token",
        finnhubApiToken: "finnhub-token",
      },
      new Date("2026-05-19T00:00:00.000Z"),
      fetchImpl,
    );

    expect(result.newsSources).toHaveLength(2);
    expect(result.newsSources[0]).toMatchObject({
      id: "news-crypto-1",
      provider: "marketaux",
      providerAliases: [
        {
          provider: "marketaux",
          providerArticleId: "marketaux-1",
          publisher: "Example",
        },
        {
          provider: "finnhub",
          providerArticleId: "55",
          publisher: "Example",
        },
      ],
    });
    expect(result.newsSources[1]).toMatchObject({
      id: "news-crypto-2",
      provider: "yahoo-news",
    });
    expect(result.sourceGaps.map((gap) => gap.source)).toEqual(["fred-macro"]);
  });

  test("caps Finnhub after normalization and keeps provider round-robin order", async () => {
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes("coingecko")) {
        return jsonResponse([
          {
            symbol: "btc",
            current_price: 103_000,
            price_change_percentage_24h: 2,
            total_volume: 40_000_000_000,
          },
        ]);
      }

      if (url.includes("marketaux")) {
        return jsonResponse({
          data: [
            {
              uuid: "marketaux-1",
              title: "MarketAux story",
              url: "https://example.test/marketaux",
              source: "Example",
              published_at: "2026-05-18T12:00:00.000Z",
            },
          ],
        });
      }

      if (url.includes("finnhub")) {
        return jsonResponse([
          {
            id: 1,
            headline: "Finnhub first story",
            url: "https://example.test/finnhub-1",
            source: "Example",
            datetime: 1_779_120_000,
          },
          {
            id: 2,
            headline: "Finnhub second story",
            url: "https://example.test/finnhub-2",
            source: "Example",
            datetime: 1_779_120_000,
          },
        ]);
      }

      return jsonResponse({
        news: [
          {
            title: "Yahoo story",
            link: "https://example.test/yahoo",
            publisher: "Example",
            providerPublishTime: 1_779_120_000,
          },
        ],
      });
    };

    const result = await collectSources(
      { jobType: "daily", assetClass: "crypto", depth: "brief" },
      {
        equityMoverLimit: 2,
        cryptoMoverLimit: 2,
        newsLimit: 1,
        sourceTimeoutMs: 1000,
        marketauxApiToken: "marketaux-token",
        finnhubApiToken: "finnhub-token",
      },
      new Date("2026-05-19T00:00:00.000Z"),
      fetchImpl,
    );

    expect(result.newsSources.map((source) => source.provider)).toEqual(["marketaux"]);
    const finnhubPayload = result.rawSnapshots.find(
      (snapshot) => snapshot.adapter === "finnhub-news",
    )?.payload;
    expect(Array.isArray(finnhubPayload) ? finnhubPayload.length : 0).toBe(2);
  });

  test("suppresses previously seen news within the same research lane", async () => {
    const newsSeenPath = tempSeenPath();
    await recordSeenNewsSources({
      path: newsSeenPath,
      retentionDays: 30,
      command: { jobType: "daily", assetClass: "crypto", depth: "brief" },
      runId: "previous-run",
      seenAt: "2026-05-18T00:00:00.000Z",
      sources: [
        {
          id: "news-crypto-1",
          title: "Repeated BTC story",
          url: "https://example.test/repeat",
          fetchedAt: "2026-05-18T00:00:00.000Z",
          kind: "news",
          assetClass: "crypto",
          provider: "yahoo-news",
        },
      ],
    });
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes("coingecko")) {
        return jsonResponse([
          {
            symbol: "btc",
            current_price: 103_000,
            price_change_percentage_24h: 2,
            total_volume: 40_000_000_000,
          },
        ]);
      }

      return jsonResponse({
        news: [
          {
            title: "Repeated BTC story",
            link: "https://example.test/repeat",
            publisher: "Example",
            providerPublishTime: 1_779_120_000,
          },
          {
            title: "Fresh BTC story",
            link: "https://example.test/fresh",
            publisher: "Example",
            providerPublishTime: 1_779_120_000,
          },
        ],
      });
    };

    const result = await collectSources(
      { jobType: "daily", assetClass: "crypto", depth: "brief" },
      {
        equityMoverLimit: 2,
        cryptoMoverLimit: 2,
        newsLimit: 3,
        sourceTimeoutMs: 1000,
        newsSeenPath,
        newsSeenRetentionDays: 30,
      },
      new Date("2026-05-19T00:00:00.000Z"),
      fetchImpl,
    );

    expect(result.newsSources.map((source) => source.title)).toEqual(["Fresh BTC story"]);
    expect(result.newsSources[0]?.id).toBe("news-crypto-1");
    expect(result.sourceGaps.map((gap) => gap.source)).not.toContain("news-seen");
  });

  test("keeps previously seen news in a different research lane", async () => {
    const newsSeenPath = tempSeenPath();
    await recordSeenNewsSources({
      path: newsSeenPath,
      retentionDays: 30,
      command: { jobType: "daily", assetClass: "crypto", depth: "brief" },
      runId: "previous-run",
      seenAt: "2026-05-18T00:00:00.000Z",
      sources: [
        {
          id: "news-crypto-1",
          title: "Repeated BTC story",
          url: "https://example.test/repeat",
          fetchedAt: "2026-05-18T00:00:00.000Z",
          kind: "news",
          assetClass: "crypto",
          provider: "yahoo-news",
        },
      ],
    });
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes("coingecko")) {
        return jsonResponse([
          {
            symbol: "btc",
            current_price: 103_000,
            price_change_percentage_24h: 2,
            total_volume: 40_000_000_000,
          },
        ]);
      }

      return jsonResponse({
        news: [
          {
            title: "Repeated BTC story",
            link: "https://example.test/repeat",
            publisher: "Example",
            providerPublishTime: 1_779_120_000,
          },
        ],
      });
    };

    const result = await collectSources(
      { jobType: "weekly", assetClass: "crypto", depth: "brief" },
      {
        equityMoverLimit: 2,
        cryptoMoverLimit: 2,
        newsLimit: 3,
        sourceTimeoutMs: 1000,
        newsSeenPath,
        newsSeenRetentionDays: 30,
      },
      new Date("2026-05-19T00:00:00.000Z"),
      fetchImpl,
    );

    expect(result.newsSources.map((source) => source.title)).toEqual(["Repeated BTC story"]);
  });

  test("keeps one repeat fallback when persistent dedupe removes every news source", async () => {
    const newsSeenPath = tempSeenPath();
    await recordSeenNewsSources({
      path: newsSeenPath,
      retentionDays: 30,
      command: { jobType: "daily", assetClass: "crypto", depth: "brief" },
      runId: "previous-run",
      seenAt: "2026-05-18T00:00:00.000Z",
      sources: [
        {
          id: "news-crypto-1",
          title: "Repeated BTC story",
          url: "https://example.test/repeat",
          fetchedAt: "2026-05-18T00:00:00.000Z",
          kind: "news",
          assetClass: "crypto",
          provider: "yahoo-news",
        },
      ],
    });
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes("coingecko")) {
        return jsonResponse([
          {
            symbol: "btc",
            current_price: 103_000,
            price_change_percentage_24h: 2,
            total_volume: 40_000_000_000,
          },
        ]);
      }

      return jsonResponse({
        news: [
          {
            title: "Repeated BTC story",
            link: "https://example.test/repeat",
            publisher: "Example",
            providerPublishTime: 1_779_120_000,
          },
        ],
      });
    };

    const result = await collectSources(
      { jobType: "daily", assetClass: "crypto", depth: "brief" },
      {
        equityMoverLimit: 2,
        cryptoMoverLimit: 2,
        newsLimit: 3,
        sourceTimeoutMs: 1000,
        newsSeenPath,
        newsSeenRetentionDays: 30,
      },
      new Date("2026-05-19T00:00:00.000Z"),
      fetchImpl,
    );

    expect(result.newsSources.map((source) => source.title)).toEqual(["Repeated BTC story"]);
    expect(result.sourceGaps.some((gap) => gap.source === "news-seen")).toBe(true);
  });

  test("opens provider circuit on rate limit responses", async () => {
    let marketAuxCalls = 0;
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes("coingecko")) {
        return jsonResponse([
          {
            symbol: "btc",
            current_price: 103_000,
            price_change_percentage_24h: 2,
            total_volume: 40_000_000_000,
          },
        ]);
      }

      if (url.includes("marketaux")) {
        marketAuxCalls += 1;
        return new Response("rate limit", { status: 429 });
      }

      return jsonResponse([]);
    };
    const sourceOptions = {
      equityMoverLimit: 2,
      cryptoMoverLimit: 2,
      newsLimit: 2,
      sourceTimeoutMs: 1000,
      marketauxApiToken: "marketaux-token",
      finnhubApiToken: "finnhub-token",
    };

    await collectSources(
      { jobType: "daily", assetClass: "crypto", depth: "brief" },
      sourceOptions,
      new Date("2026-05-19T00:00:00.000Z"),
      fetchImpl,
      [],
    );
    const second = await collectSources(
      { jobType: "daily", assetClass: "crypto", depth: "brief" },
      sourceOptions,
      new Date("2026-05-19T00:00:00.000Z"),
      fetchImpl,
      [],
    );

    expect(marketAuxCalls).toBe(1);
    expect(second.sourceGaps.some((gap) => gap.message.includes("circuit open"))).toBe(true);
  });
});
