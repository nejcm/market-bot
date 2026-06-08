import { describe, expect, test } from "bun:test";
import {
  buildYahooQuotePayloadFromMassive,
  fetchMassiveCloseWindow,
  fetchMassiveQuoteFallback,
  massiveSnapshotsFromQuoteFallback,
} from "../src/sources/massive-fallback";
import type { FetchLike } from "../src/sources/types";

function jsonResponse(payload: unknown, status = 200): Response {
  return Response.json(payload, { status });
}

describe("massive-fallback", () => {
  test("returns undefined when api key is unset", async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({});

    expect(await fetchMassiveQuoteFallback(["AAPL"], undefined, fetchImpl)).toBeUndefined();
    expect(
      await fetchMassiveCloseWindow(
        "AAPL",
        new Date("2026-05-01T00:00:00.000Z"),
        new Date("2026-05-03T00:00:00.000Z"),
        undefined,
        fetchImpl,
      ),
    ).toBeUndefined();
  });

  test("builds Yahoo-compatible quote payload with market cap from ticker details", async () => {
    const fetchImpl: FetchLike = async (input) => {
      const url = String(input);
      if (url.includes("/v2/snapshot/")) {
        return jsonResponse({
          tickers: [
            {
              ticker: "AAPL",
              todaysChangePerc: 1.2,
              day: { c: 190, v: 80_000_000 },
              lastTrade: { p: 190 },
            },
          ],
        });
      }
      if (url.includes("/v3/reference/tickers/AAPL")) {
        return jsonResponse({
          results: {
            name: "Apple Inc.",
            primary_exchange: "XNAS",
            market_cap: 2_900_000_000,
          },
        });
      }
      return new Response("not found", { status: 404 });
    };

    const fallback = await fetchMassiveQuoteFallback(
      ["AAPL"],
      "massive-key",
      fetchImpl,
      "2026-06-01T00:00:00.000Z",
      { enrichTickerDetails: true },
    );

    expect(fallback).toBeDefined();
    const snapshots = massiveSnapshotsFromQuoteFallback(fallback!);
    expect(snapshots).toEqual([
      expect.objectContaining({
        symbol: "AAPL",
        price: 190,
        volume: 80_000_000,
        marketCap: 2_900_000_000,
        sourceId: "market-yahoo-equity-aapl",
      }),
    ]);

    const payload = buildYahooQuotePayloadFromMassive([
      {
        symbol: "AAPL",
        price: 190,
        changePercent24h: 1.2,
        volume: 80_000_000,
        marketCap: 2_900_000_000,
        exchange: "XNAS",
        name: "Apple Inc.",
      },
    ]);
    expect(payload).toEqual({
      quoteResponse: {
        result: [
          expect.objectContaining({
            symbol: "AAPL",
            regularMarketPrice: 190,
            marketCap: 2_900_000_000,
            quoteType: "EQUITY",
          }),
        ],
      },
    });
  });

  test("skips ticker-details requests unless enrichment is requested", async () => {
    const requestedUrls: string[] = [];
    const fetchImpl: FetchLike = async (input) => {
      requestedUrls.push(String(input));
      if (String(input).includes("/v2/snapshot/")) {
        return jsonResponse({
          tickers: [
            {
              ticker: "AAPL",
              todaysChangePerc: 1.2,
              day: { c: 190, v: 80_000_000 },
              lastTrade: { p: 190 },
            },
          ],
        });
      }
      return new Response("not found", { status: 404 });
    };

    const fallback = await fetchMassiveQuoteFallback(
      ["AAPL"],
      "massive-key",
      fetchImpl,
      "2026-06-01T00:00:00.000Z",
    );

    expect(fallback).toBeDefined();
    expect(requestedUrls.some((url) => url.includes("/v3/reference/tickers/"))).toBe(false);
    const snapshots = massiveSnapshotsFromQuoteFallback(fallback!);
    expect(snapshots[0]?.marketCap).toBeUndefined();
  });

  test("maps aggregate bars to observation windows", async () => {
    const fetchImpl: FetchLike = async (input) => {
      const url = String(input);
      if (url.includes("/v2/aggs/ticker/AAPL/range/1/day/")) {
        return jsonResponse({
          results: [
            { t: Date.parse("2026-05-19T00:00:00.000Z"), c: 190 },
            { t: Date.parse("2026-05-20T00:00:00.000Z"), c: 192 },
          ],
        });
      }
      return new Response("not found", { status: 404 });
    };

    const observations = await fetchMassiveCloseWindow(
      "AAPL",
      new Date("2026-05-19T00:00:00.000Z"),
      new Date("2026-05-20T00:00:00.000Z"),
      "massive-key",
      fetchImpl,
    );

    expect(observations).toEqual([
      { subject: "AAPL", date: "2026-05-19", value: 190 },
      { subject: "AAPL", date: "2026-05-20", value: 192 },
    ]);
  });
});
