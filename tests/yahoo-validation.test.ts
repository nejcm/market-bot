import { describe, expect, test } from "bun:test";
import {
  crossCheckAlphaSearchCandidatesWithYahoo,
  validateYahooCandidateQuotes,
} from "../src/alpha-search/yahoo-validation";
import type { AlphaSearchCandidate } from "../src/alpha-search/candidates";
import type { FetchJsonResult, SourceRequestExecutor } from "../src/sources/types";

function candidate(symbol: string, rank = 1): AlphaSearchCandidate {
  return {
    socialRank: rank,
    symbol,
    name: symbol,
    sourceIds: [`apewisdom-all-stocks-${symbol}`],
    discoverySources: ["apewisdom"],
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
    marketCap: 2_900_000_000,
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
  test("accepts Yahoo-validated listed stocks with basic market info", () => {
    const result = validateYahooCandidateQuotes(
      [candidate("AAPL")],
      payload([quote({ symbol: "AAPL", quoteType: "EQUITY" })]),
    );

    expect(result.validLeads).toEqual([
      expect.objectContaining({
        symbol: "AAPL",
        name: "Apple Inc.",
        exchange: "NMS",
        price: 190,
        volume: 80_000_000,
        marketCap: 2_900_000_000,
      }),
    ]);
    expect(result.rejectedCandidates).toEqual([]);
  });

  test("rejects unresolved, OTC, sub-minimum-price, ETF, and non-stock Yahoo candidates", () => {
    const result = validateYahooCandidateQuotes(
      [
        candidate("MISSING"),
        candidate("OTCM", 2),
        candidate("PENY", 3),
        candidate("SPY", 4),
        candidate("FUND", 5),
      ],
      payload([
        quote({
          symbol: "OTCM",
          exchange: "PNK",
          fullExchangeName: "Other OTC",
          regularMarketPrice: 50,
        }),
        quote({ symbol: "PENY", regularMarketPrice: 0.49 }),
        quote({ symbol: "SPY", quoteType: "ETF", regularMarketPrice: 520 }),
        quote({ symbol: "FUND", quoteType: "MUTUALFUND", regularMarketPrice: 20 }),
      ]),
    );

    expect(result.validLeads).toEqual([]);
    expect(
      result.rejectedCandidates.map((rejected) => [rejected.candidate.symbol, rejected.reason]),
    ).toEqual([
      ["MISSING", "unresolved by Yahoo"],
      ["OTCM", "OTC or pink-sheet instrument"],
      ["PENY", "Yahoo price is below configured alpha-search minimum"],
      ["SPY", "Yahoo quote type is not listed stock"],
      ["FUND", "Yahoo quote type is not listed stock"],
    ]);
  });

  test("rejects low volume and missing or out-of-band market cap", () => {
    const result = validateYahooCandidateQuotes(
      [
        candidate("THIN"),
        candidate("NOCAP", 2),
        candidate("MICRO", 3),
        candidate("MEGA", 4),
        candidate("NOEXCH", 5),
      ],
      payload([
        quote({ symbol: "THIN", regularMarketVolume: 99_999 }),
        quote({ symbol: "NOCAP", marketCap: undefined }),
        quote({ symbol: "MICRO", marketCap: 49_999_999 }),
        quote({ symbol: "MEGA", marketCap: 10_000_000_001 }),
        quote({ symbol: "NOEXCH", exchange: undefined, fullExchangeName: undefined }),
      ]),
    );

    expect(result.validLeads).toEqual([]);
    expect(
      result.rejectedCandidates.map((rejected) => [rejected.candidate.symbol, rejected.reason]),
    ).toEqual([
      ["THIN", "Yahoo volume is below configured alpha-search minimum"],
      ["NOCAP", "Yahoo quote is missing market cap"],
      ["MICRO", "Yahoo market cap is below configured alpha-search minimum"],
      ["MEGA", "Yahoo market cap is above configured alpha-search maximum"],
      ["NOEXCH", "Yahoo quote is missing listed exchange"],
    ]);
  });

  test("applies custom alpha-search eligibility thresholds", () => {
    const result = validateYahooCandidateQuotes(
      [candidate("AAPL")],
      payload([quote({ symbol: "AAPL", regularMarketVolume: 80_000_000 })]),
      {
        minPrice: 200,
        minVolume: 90_000_000,
        minMarketCap: 1_000_000_000,
        maxMarketCap: 5_000_000_000,
      },
    );

    expect(result.validLeads).toEqual([]);
    expect(result.rejectedCandidates).toEqual([
      expect.objectContaining({
        candidate: expect.objectContaining({ symbol: "AAPL" }),
        reason: "Yahoo price is below configured alpha-search minimum",
      }),
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
