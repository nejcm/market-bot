import { beforeEach, describe, expect, test } from "bun:test";
import { collectSources, resetSourceResilienceForTests } from "../src/sources/collector";

function jsonResponse(payload: unknown): Response {
  return Response.json(payload);
}

beforeEach(() => {
  resetSourceResilienceForTests();
});

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
    expect(result.sourceGaps.map((gap) => gap.source)).toEqual(["marketaux-news", "finnhub-news"]);
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
    expect(result.sourceGaps.map((gap) => gap.source)).toEqual(["marketaux-news", "finnhub-news"]);
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
    expect(result.sourceGaps).toHaveLength(0);
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
