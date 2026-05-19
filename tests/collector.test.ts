import { describe, expect, test } from "bun:test";
import { collectSources } from "../src/sources/collector";

function jsonResponse(payload: unknown): Response {
  return Response.json(payload);
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
                    regularMarketVolume: 80000000,
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
                regularMarketVolume: 70000000,
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
            providerPublishTime: 1779120000,
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
    expect(result.sourceGaps).toHaveLength(0);
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
            total_volume: 10000000000,
          },
          {
            symbol: "btc",
            current_price: 103000,
            price_change_percentage_24h: 2,
            total_volume: 40000000000,
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
            current_price: 103000,
            price_change_percentage_24h: 2,
            total_volume: 40000000000,
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
    );

    expect(result.marketSnapshots.map((snapshot) => snapshot.symbol)).toEqual(["BTC"]);
    expect(result.newsSources).toEqual([]);
    expect(result.sourceGaps[0]?.source).toBe("public-news");
  });
});
