import { describe, expect, test } from "bun:test";
import {
  rankRedditCandidates,
  type RedditCandidateRankInput,
} from "../src/alpha-search/reddit-ranking";

const fetchedAt = "2026-06-02T00:00:00.000Z";

function input(overrides: Partial<RedditCandidateRankInput> = {}): RedditCandidateRankInput {
  return {
    fetchedAt,
    lookbackDays: 7,
    candidateLimit: 15,
    posts: [],
    comments: [],
    ...overrides,
  };
}

describe("Reddit candidate ranking", () => {
  test("returns no candidates for empty discussion input", () => {
    expect(rankRedditCandidates(input())).toEqual([]);
  });

  test("ranks ticker-like Reddit mentions by deterministic discovery score", () => {
    const ranked = rankRedditCandidates(
      input({
        posts: [
          {
            id: "p1",
            fullname: "t3_p1",
            subreddit: "stocks",
            title: "AAPL earnings growth and MSFT notes",
            selfText: "AAPL looks strong. THE CEO discussed USD guidance.",
            author: "poster-a",
            createdAt: "2026-06-01T00:00:00.000Z",
            score: 80,
            commentCount: 10,
            permalink: "https://www.reddit.com/r/stocks/comments/p1/",
          },
          {
            id: "p2",
            fullname: "t3_p2",
            subreddit: "stocks",
            title: "MSFT update",
            selfText: "MSFT has steady growth.",
            author: "poster-b",
            createdAt: "2026-05-31T00:00:00.000Z",
            score: 1,
            commentCount: 1,
            permalink: "https://www.reddit.com/r/stocks/comments/p2/",
          },
        ],
        comments: [
          {
            id: "c1",
            fullname: "t1_c1",
            postId: "p1",
            parentId: "t3_p1",
            subreddit: "stocks",
            body: "AAPL beat looks bullish",
            author: "commenter-a",
            createdAt: "2026-06-01T12:00:00.000Z",
            score: 12,
            depth: 0,
          },
          {
            id: "c2",
            fullname: "t1_c2",
            postId: "p1",
            parentId: "t3_p1",
            subreddit: "stocks",
            body: "$AAPL and MSFT both mentioned",
            author: "commenter-b",
            createdAt: "2026-05-30T00:00:00.000Z",
            score: 4,
            depth: 0,
          },
        ],
      }),
    );

    expect(ranked.map((candidate) => candidate.symbol)).toEqual(["AAPL", "MSFT"]);
    expect(ranked[0]).toMatchObject({
      rank: 1,
      symbol: "AAPL",
      mentionCount: 4,
      uniqueParticipantCount: 3,
      discussionStance: "constructive",
      sourceIds: ["t3_p1", "t1_c1", "t1_c2"],
    });
    expect(ranked[0]?.redditDiscoveryScore).toBeGreaterThan(ranked[1]?.redditDiscoveryScore ?? 0);
  });

  test("labels mixed and skeptical discussion without emitting trade language", () => {
    const ranked = rankRedditCandidates(
      input({
        posts: [
          {
            id: "p1",
            fullname: "t3_p1",
            subreddit: "stocks",
            title: "NVDA strong but valuation risk",
            selfText: "NVDA growth is strong, but overvalued risk is real.",
            author: "poster-a",
            createdAt: "2026-06-01T00:00:00.000Z",
            score: 10,
            commentCount: 1,
            permalink: "https://www.reddit.com/r/stocks/comments/p1/",
          },
          {
            id: "p2",
            fullname: "t3_p2",
            subreddit: "stocks",
            title: "TSLA dilution and weak delivery thread",
            selfText: "TSLA miss and downgrade concerns.",
            author: "poster-b",
            createdAt: "2026-06-01T00:00:00.000Z",
            score: 10,
            commentCount: 1,
            permalink: "https://www.reddit.com/r/stocks/comments/p2/",
          },
        ],
      }),
    );

    expect(ranked.map((candidate) => [candidate.symbol, candidate.discussionStance])).toEqual([
      ["NVDA", "mixed"],
      ["TSLA", "skeptical"],
    ]);
  });

  test("keeps stance terms scoped to the mentioned ticker", () => {
    const ranked = rankRedditCandidates(
      input({
        posts: [
          {
            id: "p1",
            fullname: "t3_p1",
            subreddit: "stocks",
            title: "AAPL strong, TSLA scam",
            selfText: "",
            author: "poster-a",
            createdAt: "2026-06-01T00:00:00.000Z",
            score: 10,
            commentCount: 1,
            permalink: "https://www.reddit.com/r/stocks/comments/p1/",
          },
        ],
      }),
    );

    expect(ranked.map((candidate) => [candidate.symbol, candidate.discussionStance])).toEqual([
      ["AAPL", "constructive"],
      ["TSLA", "skeptical"],
    ]);
  });

  test("respects candidate limit and deterministic tie ordering", () => {
    const ranked = rankRedditCandidates(
      input({
        candidateLimit: 2,
        posts: [
          {
            id: "p1",
            fullname: "t3_p1",
            subreddit: "stocks",
            title: "MSFT AAPL GOOGL",
            selfText: "",
            author: "poster-a",
            createdAt: "2026-06-01T00:00:00.000Z",
            score: 1,
            commentCount: 0,
            permalink: "https://www.reddit.com/r/stocks/comments/p1/",
          },
        ],
      }),
    );

    expect(ranked.map((candidate) => candidate.symbol)).toEqual(["AAPL", "GOOGL"]);
  });

  test("extracts single-letter cashtags but not lowercase prose", () => {
    const ranked = rankRedditCandidates(
      input({
        posts: [
          {
            id: "p1",
            fullname: "t3_p1",
            subreddit: "stocks",
            title: "$F and $TsLa ai discussion",
            selfText: "lowercase aapl should not count, but $t should normalize.",
            author: "poster-a",
            createdAt: "2026-06-01T00:00:00.000Z",
            score: 1,
            commentCount: 0,
            permalink: "https://www.reddit.com/r/stocks/comments/p1/",
          },
        ],
      }),
    );

    expect(ranked.map((candidate) => candidate.symbol)).toEqual(["F", "T", "TSLA"]);
  });
});
