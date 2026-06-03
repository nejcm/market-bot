import { describe, expect, test } from "bun:test";
import {
  crossCheckAlphaSearchCandidatesWithYahoo,
  validateYahooCandidateQuotes,
} from "../src/alpha-search/yahoo-validation";
import type { SocialMomentumRankedCandidate } from "../src/alpha-search/social-momentum-ranking";
import type { FetchJsonResult, SourceRequestExecutor } from "../src/sources/types";

function candidate(symbol: string, rank = 1): SocialMomentumRankedCandidate {
  return {
    socialRank: rank,
    symbol,
    name: symbol,
    sourceProvider: "apewisdom",
    sourceIds: [`apewisdom-all-stocks-${symbol}`],
    socialMomentumScore: 50,
    mentions: 2,
    upvotes: 20,
  };
}

function quote(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    symbol: "AAPL",
    shortName: "Apple Inc.",
    exchange: "NMS",
    fullExchangeName: "NasdaqGS",
    quoteType: "EQUITY",
    regularMarketPrice: 190,
    regularMarketVolume: 80_000_000,
    marketCap: 2_900_000_000_000,
    ...overrides,
  };
}

function payload(quotes: readonly Record<string, unknown>[]): unknown {
  return { quoteResponse: { result: quotes } };
}

function fetched(payloadValue: unknown): FetchJsonResult {
  return {
    rawSnapshot: {
      id: "raw-yahoo-alpha-search-2026-06-01T00:00:00.000Z",
      adapter: "yahoo-alpha-search",
      fetchedAt: "2026-06-01T00:00:00.000Z",
      payload: payloadValue,
    },
    payload: payloadValue,
  };
}

function requestExecutor(
  onUrl: (url: string) => void,
  payloadValue: unknown,
): SourceRequestExecutor {
  return {
    json: async (request) => {
      onUrl(request.url);
      return fetched(payloadValue);
    },
    text: async () => {
      throw new Error("unexpected text fetch");
    },
  };
}

describe("Yahoo alpha-search validation", () => {
  test("accepts Yahoo-validated stocks and ETFs with basic market info", () => {
    const result = validateYahooCandidateQuotes(
      [candidate("AAPL"), candidate("SPY", 2)],
      payload([
        quote({ symbol: "AAPL", quoteType: "EQUITY" }),
        quote({
          symbol: "SPY",
          shortName: "SPDR S&P 500 ETF Trust",
          exchange: "PCX",
          fullExchangeName: "NYSEArca",
          quoteType: "ETF",
          regularMarketPrice: 520,
          regularMarketVolume: 90_000_000,
        }),
      ]),
    );

    expect(result.validLeads).toEqual([
      expect.objectContaining({
        symbol: "AAPL",
        name: "Apple Inc.",
        exchange: "NMS",
        price: 190,
        volume: 80_000_000,
        marketCap: 2_900_000_000_000,
        instrumentKind: "stock",
      }),
      expect.objectContaining({
        symbol: "SPY",
        name: "SPDR S&P 500 ETF Trust",
        exchange: "PCX",
        price: 520,
        volume: 90_000_000,
        instrumentKind: "etf",
      }),
    ]);
    expect(result.rejectedCandidates).toEqual([]);
  });

  test("rejects unresolved, OTC, sub-dollar, and non-stock Yahoo candidates", () => {
    const result = validateYahooCandidateQuotes(
      [candidate("MISSING"), candidate("OTCM", 2), candidate("PENY", 3), candidate("FUND", 4)],
      payload([
        quote({
          symbol: "OTCM",
          exchange: "PNK",
          fullExchangeName: "Other OTC",
          regularMarketPrice: 50,
        }),
        quote({ symbol: "PENY", regularMarketPrice: 0.5 }),
        quote({ symbol: "FUND", quoteType: "MUTUALFUND", regularMarketPrice: 20 }),
      ]),
    );

    expect(result.validLeads).toEqual([]);
    expect(
      result.rejectedCandidates.map((rejected) => [rejected.candidate.symbol, rejected.reason]),
    ).toEqual([
      ["MISSING", "unresolved by Yahoo"],
      ["OTCM", "OTC or pink-sheet instrument"],
      ["PENY", "Yahoo price is below $1"],
      ["FUND", "Yahoo quote type is not stock or ETF"],
    ]);
  });

  test("does not reject listed candidates only because exchange text contains OTC", () => {
    const result = validateYahooCandidateQuotes(
      [candidate("SAFE")],
      payload([
        quote({
          symbol: "SAFE",
          exchange: "XOTC",
          fullExchangeName: "Example Listed Exchange",
        }),
      ]),
    );

    expect(result.validLeads.map((lead) => lead.symbol)).toEqual(["SAFE"]);
    expect(result.rejectedCandidates).toEqual([]);
  });

  test("cross-checks only the configured top alpha-search candidates", async () => {
    const requestedUrls: string[] = [];
    const result = await crossCheckAlphaSearchCandidatesWithYahoo({
      candidates: [candidate("AAPL"), candidate("MSFT", 2), candidate("TSLA", 3)],
      candidateLimit: 2,
      request: requestExecutor(
        (url) => requestedUrls.push(url),
        payload([quote({ symbol: "AAPL" }), quote({ symbol: "MSFT" })]),
      ),
    });

    expect(decodeURIComponent(requestedUrls[0] ?? "")).toContain("symbols=AAPL,MSFT");
    expect(decodeURIComponent(requestedUrls[0] ?? "")).not.toContain("TSLA");
    expect(result.rawSnapshots).toHaveLength(1);
    expect(result.validLeads.map((lead) => lead.symbol)).toEqual(["AAPL", "MSFT"]);
    expect(result.sourceGaps).toEqual([]);
  });

  test("does not call Yahoo when candidate limit is non-positive", async () => {
    for (const candidateLimit of [0, -1]) {
      const result = await crossCheckAlphaSearchCandidatesWithYahoo({
        candidates: [candidate("AAPL")],
        candidateLimit,
        request: {
          json: async () => {
            throw new Error("unexpected json fetch");
          },
          text: async () => {
            throw new Error("unexpected text fetch");
          },
        },
      });

      expect(result).toEqual({
        rawSnapshots: [],
        validLeads: [],
        rejectedCandidates: [],
        sourceGaps: [],
      });
    }
  });

  test("returns source gaps from the Yahoo request boundary", async () => {
    const result = await crossCheckAlphaSearchCandidatesWithYahoo({
      candidates: [candidate("AAPL"), candidate("MSFT", 2)],
      candidateLimit: 15,
      request: {
        json: async () => ({
          source: "yahoo-alpha-search",
          message: "source request failed with status 429",
          cause: "fetch-failed",
        }),
        text: async () => {
          throw new Error("unexpected text fetch");
        },
      },
    });

    expect(result).toEqual({
      rawSnapshots: [],
      validLeads: [],
      rejectedCandidates: [
        {
          candidate: candidate("AAPL"),
          reason: "Yahoo validation unavailable: source request failed with status 429",
        },
        {
          candidate: candidate("MSFT", 2),
          reason: "Yahoo validation unavailable: source request failed with status 429",
        },
      ],
      sourceGaps: [
        {
          source: "yahoo-alpha-search",
          message: "source request failed with status 429",
          cause: "fetch-failed",
        },
      ],
    });
  });
});
