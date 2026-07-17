import { describe, expect, test } from "bun:test";
import { collectAlphaSearchFundamentals } from "../src/alpha-search/fundamentals";
import type { AlphaSearchLead } from "../src/alpha-search/report-extras";
import { sourceGap } from "../src/domain/source-gaps";
import type { FetchJsonResult, SourceRequestExecutor } from "../src/sources/types";

const FETCHED_AT = "2026-06-01T00:00:00.000Z";

function lead(symbol: string): AlphaSearchLead {
  return {
    symbol,
    exchange: "NMS",
    price: 10,
    volume: 1_000_000,
    marketCap: 500_000_000,
    discoverySources: ["apewisdom"],
    sourceIds: [`apewisdom-${symbol}`, "market-yahoo-alpha-search"],
  };
}

function fetched(payload: unknown): FetchJsonResult {
  return {
    rawSnapshot: {
      id: "sec-alpha-fundamentals-tickers",
      adapter: "sec-alpha-fundamentals-tickers",
      fetchedAt: FETCHED_AT,
      payload,
    },
    payload,
  };
}

describe("collectAlphaSearchFundamentals", () => {
  test("stamps symbols on per-company SEC fetch gaps", async () => {
    const request: SourceRequestExecutor = {
      json: async ({ adapter }) => {
        if (adapter === "sec-alpha-fundamentals-tickers") {
          return fetched({
            "0": { cik_str: 3_200_193, ticker: "AAPL", title: "Apple Inc." },
            "1": { cik_str: 789_019, ticker: "MSFT", title: "Microsoft Corp." },
          });
        }
        return sourceGap({
          source: "sec-alpha-fundamentals",
          message: "SEC companyfacts request failed",
          cause: "fetch-failed",
        });
      },
      text: async () => {
        throw new Error("unexpected text request");
      },
    };

    const result = await collectAlphaSearchFundamentals({
      leads: [lead("AAPL"), lead("MSFT")],
      request,
      analysisAsOf: FETCHED_AT,
    });

    expect(result.sourceGaps).toEqual([
      expect.objectContaining({ symbol: "AAPL", message: "SEC companyfacts request failed" }),
      expect.objectContaining({ symbol: "MSFT", message: "SEC companyfacts request failed" }),
    ]);
  });
});
