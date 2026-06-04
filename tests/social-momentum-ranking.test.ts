import { describe, expect, test } from "bun:test";
import {
  rankSocialMomentumCandidates,
  type SocialMomentumRankInput,
} from "../src/alpha-search/social-momentum-ranking";
import type { ApeWisdomCandidate } from "../src/sources/apewisdom";

type CandidateOverrides = Partial<Omit<ApeWisdomCandidate, "rank24hAgo" | "mentions24hAgo">> & {
  readonly rank24hAgo?: number | undefined;
  readonly mentions24hAgo?: number | undefined;
};

function hasKey(value: CandidateOverrides, key: keyof CandidateOverrides): boolean {
  return Object.hasOwn(value, key);
}

function candidate(overrides: CandidateOverrides = {}): ApeWisdomCandidate {
  const ticker = overrides.ticker ?? "AAPL";
  const rank24hAgo = hasKey(overrides, "rank24hAgo") ? overrides.rank24hAgo : 30;
  const mentions24hAgo = hasKey(overrides, "mentions24hAgo") ? overrides.mentions24hAgo : 10;
  const { rank24hAgo: _rank24hAgo, mentions24hAgo: _mentions24hAgo, ...rest } = overrides;
  const base = {
    sourceProvider: "apewisdom" as const,
    sourceId: `apewisdom-all-stocks-${ticker}`,
    filter: "all-stocks",
    url: "https://apewisdom.io/api/v1.0/filter/all-stocks/page/1",
    rank: 10,
    ticker,
    name: ticker,
    mentions: 20,
    upvotes: 60,
    ...rest,
  };

  return {
    ...base,
    ...(rank24hAgo !== undefined ? { rank24hAgo } : {}),
    ...(mentions24hAgo !== undefined ? { mentions24hAgo } : {}),
  };
}

function ranked(input: Partial<SocialMomentumRankInput> = {}) {
  return rankSocialMomentumCandidates({
    candidates: [],
    candidateLimit: 10,
    ...input,
  });
}

describe("Social Momentum ranking", () => {
  test("returns no candidates for empty or disabled input", () => {
    expect(ranked()).toEqual([]);
    expect(
      ranked({
        candidates: [candidate()],
        candidateLimit: 0,
      }),
    ).toEqual([]);
  });

  test("ranks ApeWisdom candidates by deterministic social momentum score", () => {
    const result = ranked({
      candidates: [
        candidate({
          ticker: "AAPL",
          mentions: 40,
          mentions24hAgo: 20,
          rank: 5,
          rank24hAgo: 10,
          upvotes: 100,
        }),
        candidate({
          ticker: "TSLA",
          mentions: 20,
          mentions24hAgo: 1,
          rank: 2,
          rank24hAgo: 40,
          upvotes: 160,
        }),
      ],
    });

    expect(result.map((entry) => entry.symbol)).toEqual(["TSLA", "AAPL"]);
    expect(result[0]).toMatchObject({
      socialRank: 1,
      symbol: "TSLA",
      sourceProvider: "apewisdom",
      sourceIds: ["apewisdom-all-stocks-TSLA"],
      mentions: 20,
      upvotes: 160,
      rank24hAgo: 40,
      mentions24hAgo: 1,
    });
    expect(result[0]?.socialMomentumScore).toBeGreaterThan(result[1]?.socialMomentumScore ?? 0);
  });

  test("uses mentions then ticker as stable tie-breakers", () => {
    const result = ranked({
      candidates: [
        candidate({
          ticker: "MSFT",
          mentions: 10,
          upvotes: 0,
          rank24hAgo: undefined,
          mentions24hAgo: undefined,
        }),
        candidate({
          ticker: "AAPL",
          mentions: 10,
          upvotes: 0,
          rank24hAgo: undefined,
          mentions24hAgo: undefined,
        }),
        candidate({
          ticker: "NVDA",
          mentions: 12,
          upvotes: 0,
          rank24hAgo: undefined,
          mentions24hAgo: undefined,
        }),
      ],
    });

    expect(result.map((entry) => entry.symbol)).toEqual(["NVDA", "AAPL", "MSFT"]);
    expect(result.map((entry) => entry.socialRank)).toEqual([1, 2, 3]);
  });

  test("dedupes repeated tickers before assigning social ranks", () => {
    const result = ranked({
      candidates: [
        candidate({
          ticker: "AAPL",
          sourceId: "apewisdom-all-stocks-AAPL",
          mentions: 10,
          upvotes: 20,
          rank: 8,
        }),
        candidate({
          ticker: "AAPL",
          sourceId: "apewisdom-all-stocks-AAPL",
          mentions: 30,
          upvotes: 80,
          rank: 4,
        }),
        candidate({
          ticker: "MSFT",
          mentions: 20,
          upvotes: 30,
          rank: 3,
        }),
      ],
    });

    expect(result.map((entry) => entry.symbol)).toEqual(["AAPL", "MSFT"]);
    expect(result.map((entry) => entry.socialRank)).toEqual([1, 2]);
    expect(result[0]).toMatchObject({
      sourceIds: ["apewisdom-all-stocks-AAPL"],
      mentions: 30,
      upvotes: 80,
    });
  });

  test("does not inflate momentum when 24h fields are missing", () => {
    const [missing24h, currentOnly] = ranked({
      candidates: [
        candidate({
          ticker: "AAPL",
          mentions: 20,
          upvotes: 0,
          rank24hAgo: undefined,
          mentions24hAgo: undefined,
        }),
        candidate({
          ticker: "MSFT",
          mentions: 10,
          mentions24hAgo: 0,
          rank: 1,
          rank24hAgo: 20,
          upvotes: 0,
        }),
      ],
    });

    expect(missing24h?.symbol).toBe("MSFT");
    expect(currentOnly?.symbol).toBe("AAPL");
  });
});
