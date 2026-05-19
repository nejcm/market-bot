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
      { equityMoverLimit: 2, cryptoMoverLimit: 2, newsLimit: 2 },
      new Date("2026-05-19T00:00:00.000Z"),
      fetchImpl,
    );

    expect(result.rawSnapshots).toHaveLength(2);
    expect(result.marketSnapshots[0]?.symbol).toBe("AAPL");
    expect(result.newsSources[0]?.id).toBe("news-equity-1");
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
      { equityMoverLimit: 2, cryptoMoverLimit: 2, newsLimit: 2 },
      new Date("2026-05-19T00:00:00.000Z"),
      fetchImpl,
    );

    expect(result.marketSnapshots.map((snapshot) => snapshot.symbol)).toEqual(["BTC"]);
  });
});
