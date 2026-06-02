import { describe, expect, test } from "bun:test";
import { collectRedditDiscussions, type RedditDiscoveryClientOptions } from "../src/sources/reddit";
import type { FetchLike } from "../src/sources/types";

const fetchedAt = "2026-06-02T00:00:00.000Z";

interface FetchCall {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

function jsonResponse(
  payload: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return Response.json(payload, {
    status,
    headers,
  });
}

function listingPayload(after: string | null, children: readonly unknown[]): unknown {
  return {
    kind: "Listing",
    data: {
      after,
      children,
    },
  };
}

function postThing(
  id: string,
  createdUtc: number,
  overrides: Record<string, unknown> = {},
): unknown {
  return {
    kind: "t3",
    data: {
      id,
      name: `t3_${id}`,
      subreddit: "stocks",
      title: `${id.toUpperCase()} discussion`,
      selftext: "watchlist discussion",
      author: "poster",
      created_utc: createdUtc,
      score: 42,
      upvote_ratio: 0.88,
      num_comments: 3,
      permalink: `/r/stocks/comments/${id}/discussion/`,
      url: `https://www.reddit.com/r/stocks/comments/${id}/discussion/`,
      ...overrides,
    },
  };
}

function commentThing(
  id: string,
  postId: string,
  createdUtc: number,
  overrides: Record<string, unknown> = {},
): unknown {
  return {
    kind: "t1",
    data: {
      id,
      name: `t1_${id}`,
      parent_id: `t3_${postId}`,
      link_id: `t3_${postId}`,
      subreddit: "stocks",
      body: "AAPL and MSFT mentioned here",
      author: "commenter",
      created_utc: createdUtc,
      score: 7,
      depth: 0,
      ...overrides,
    },
  };
}

function commentWithReply(id: string, postId: string, createdUtc: number): unknown {
  return commentThing(id, postId, createdUtc, {
    replies: listingPayload(null, [commentThing("reply1", postId, createdUtc + 1, { depth: 1 })]),
  });
}

function commentsPayload(children: readonly unknown[]): unknown {
  return [listingPayload(null, []), listingPayload(null, children)];
}

function baseOptions(fetchImpl: FetchLike): RedditDiscoveryClientOptions {
  return {
    clientId: "client-id",
    clientSecret: "client-secret",
    userAgent: "script:market-bot:v0.1.0 (by /u/example)",
    subreddits: ["stocks"],
    lookbackDays: 7,
    fetchedAt,
    fetchImpl,
  };
}

describe("Reddit discovery client", () => {
  test("requires OAuth credentials", async () => {
    const calls: FetchCall[] = [];
    const result = await collectRedditDiscussions({
      userAgent: "script:market-bot:v0.1.0 (by /u/example)",
      subreddits: ["stocks"],
      lookbackDays: 7,
      fetchedAt,
      fetchImpl: async (input, init) => {
        calls.push({ url: String(input), init });
        throw new Error("unexpected fetch");
      },
    });

    expect(calls).toEqual([]);
    expect(result).toMatchObject({
      posts: [],
      comments: [],
      sourceGaps: [
        {
          source: "reddit",
          provider: "reddit",
          capability: "discussion",
          cause: "missing-credential",
        },
      ],
    });
  });

  test("uses OAuth, User-Agent, bearer auth, and fetches top comments", async () => {
    const calls: FetchCall[] = [];
    const fetchImpl: FetchLike = async (input, init) => {
      const url = String(input);
      calls.push({ url, init });

      if (url === "https://www.reddit.com/api/v1/access_token") {
        return jsonResponse({ access_token: "token-1", token_type: "bearer", expires_in: 3600 });
      }

      if (url.startsWith("https://oauth.reddit.com/r/stocks/new?")) {
        return jsonResponse(listingPayload(null, [postThing("abc", 1_780_000_000)]));
      }

      if (url.startsWith("https://oauth.reddit.com/r/stocks/comments/abc.json?")) {
        return jsonResponse(commentsPayload([commentThing("c1", "abc", 1_780_000_100)]));
      }

      throw new Error(`unexpected URL: ${url}`);
    };

    const result = await collectRedditDiscussions(baseOptions(fetchImpl));

    expect(result.sourceGaps).toEqual([]);
    expect(result.posts).toEqual([
      {
        id: "abc",
        fullname: "t3_abc",
        subreddit: "stocks",
        title: "ABC discussion",
        selfText: "watchlist discussion",
        author: "poster",
        createdAt: "2026-05-28T20:26:40.000Z",
        score: 42,
        upvoteRatio: 0.88,
        commentCount: 3,
        permalink: "https://www.reddit.com/r/stocks/comments/abc/discussion/",
        url: "https://www.reddit.com/r/stocks/comments/abc/discussion/",
      },
    ]);
    expect(result.comments).toEqual([
      {
        id: "c1",
        fullname: "t1_c1",
        postId: "abc",
        parentId: "t3_abc",
        subreddit: "stocks",
        body: "AAPL and MSFT mentioned here",
        author: "commenter",
        createdAt: "2026-05-28T20:28:20.000Z",
        score: 7,
        depth: 0,
      },
    ]);

    const [tokenCall, listingCall, commentsCall] = calls;
    expect(tokenCall?.init?.headers).toMatchObject({
      authorization: `Basic ${btoa("client-id:client-secret")}`,
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "script:market-bot:v0.1.0 (by /u/example)",
    });
    expect(String(tokenCall?.init?.body)).toBe("grant_type=client_credentials");
    expect(listingCall?.init?.headers).toMatchObject({
      authorization: "Bearer token-1",
      "user-agent": "script:market-bot:v0.1.0 (by /u/example)",
    });
    expect(new URL(listingCall?.url ?? "").searchParams.get("limit")).toBe("100");
    expect(new URL(commentsCall?.url ?? "").searchParams.get("sort")).toBe("top");
    expect(new URL(commentsCall?.url ?? "").searchParams.get("depth")).toBe("1");
  });

  test("paginates subreddit listings and applies lookback plus seen-id filters", async () => {
    const calls: FetchCall[] = [];
    const fetchImpl: FetchLike = async (input, init) => {
      const url = String(input);
      calls.push({ url, init });

      if (url === "https://www.reddit.com/api/v1/access_token") {
        return jsonResponse({ access_token: "token-1", token_type: "bearer", expires_in: 3600 });
      }

      if (url.includes("/r/stocks/new?") && !url.includes("after=")) {
        return jsonResponse(
          listingPayload("t3_next", [
            postThing("new1", 1_780_000_000),
            postThing("seen1", 1_780_000_000),
          ]),
        );
      }

      if (url.includes("after=t3_next")) {
        return jsonResponse(
          listingPayload(null, [
            postThing("new2", 1_779_900_000),
            postThing("old1", 1_778_000_000),
          ]),
        );
      }

      if (url.includes("/comments/new1.json") || url.includes("/comments/new2.json")) {
        return jsonResponse(commentsPayload([]));
      }

      throw new Error(`unexpected URL: ${url}`);
    };

    const result = await collectRedditDiscussions({
      ...baseOptions(fetchImpl),
      seenRedditIds: new Set(["t3_seen1"]),
    });

    expect(result.posts.map((post) => post.id)).toEqual(["new1", "new2"]);
    expect(calls.filter((call) => call.url.includes("/r/stocks/new?"))).toHaveLength(2);
    expect(calls.some((call) => call.url.includes("/comments/seen1.json"))).toBe(false);
    expect(calls.some((call) => call.url.includes("/comments/old1.json"))).toBe(false);
  });

  test("reports Reddit rate limits without retrying blindly", async () => {
    const fetchImpl: FetchLike = async (input) => {
      const url = String(input);
      if (url === "https://www.reddit.com/api/v1/access_token") {
        return jsonResponse({ access_token: "token-1", token_type: "bearer", expires_in: 3600 });
      }
      return jsonResponse({ error: "rate limited" }, 429, { "retry-after": "12" });
    };

    const result = await collectRedditDiscussions(baseOptions(fetchImpl));

    expect(result.posts).toEqual([]);
    expect(result.sourceGaps).toContainEqual(
      expect.objectContaining({
        source: "reddit",
        provider: "reddit",
        capability: "discussion",
        cause: "fetch-failed",
        message: "reddit rate limited retryAfterSeconds=12",
      }),
    );
  });

  test("reports private or nonexistent subreddits as source gaps", async () => {
    const fetchImpl: FetchLike = async (input) => {
      const url = String(input);
      if (url === "https://www.reddit.com/api/v1/access_token") {
        return jsonResponse({ access_token: "token-1", token_type: "bearer", expires_in: 3600 });
      }
      return jsonResponse({ message: "Not Found" }, 404);
    };

    const result = await collectRedditDiscussions(baseOptions(fetchImpl));

    expect(result.posts).toEqual([]);
    expect(result.comments).toEqual([]);
    expect(result.sourceGaps).toContainEqual(
      expect.objectContaining({
        source: "reddit",
        cause: "fetch-failed",
        message: "reddit request failed with status 404",
      }),
    );
  });

  test("does not treat Reddit JSON source and message fields as source gaps", async () => {
    const fetchImpl: FetchLike = async (input) => {
      const url = String(input);
      if (url === "https://www.reddit.com/api/v1/access_token") {
        return jsonResponse({ access_token: "token-1", token_type: "bearer", expires_in: 3600 });
      }
      if (url.includes("/r/stocks/new?")) {
        return jsonResponse({
          source: "reddit",
          message: "payload metadata",
          kind: "Listing",
          data: {
            after: null,
            children: [postThing("abc", 1_780_000_000)],
          },
        });
      }
      return jsonResponse(commentsPayload([]));
    };

    const result = await collectRedditDiscussions(baseOptions(fetchImpl));

    expect(result.sourceGaps).toEqual([]);
    expect(result.posts.map((post) => post.id)).toEqual(["abc"]);
  });

  test("reports fetch failures as source gaps", async () => {
    const result = await collectRedditDiscussions(
      baseOptions(async () => {
        throw new Error("network unavailable");
      }),
    );

    expect(result.sourceGaps).toContainEqual(
      expect.objectContaining({
        source: "reddit",
        cause: "fetch-failed",
        message: "reddit request failed: network unavailable",
      }),
    );
  });

  test("reports malformed OAuth and listing responses", async () => {
    const malformedToken = await collectRedditDiscussions(
      baseOptions(async () => jsonResponse({ token_type: "bearer" })),
    );
    expect(malformedToken.sourceGaps).toContainEqual(
      expect.objectContaining({
        source: "reddit",
        cause: "malformed-response",
        message: "reddit OAuth response missing bearer access token",
      }),
    );

    const malformedListing = await collectRedditDiscussions(
      baseOptions(async (input) => {
        if (String(input) === "https://www.reddit.com/api/v1/access_token") {
          return jsonResponse({ access_token: "token-1", token_type: "bearer", expires_in: 3600 });
        }
        return jsonResponse({ kind: "Listing", data: {} });
      }),
    );
    expect(malformedListing.sourceGaps).toContainEqual(
      expect.objectContaining({
        source: "reddit",
        cause: "malformed-response",
        message: "reddit listing response missing children",
      }),
    );
  });

  test("deep mode increases fetched comment depth", async () => {
    const calls: FetchCall[] = [];
    const fetchImpl: FetchLike = async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url === "https://www.reddit.com/api/v1/access_token") {
        return jsonResponse({ access_token: "token-1", token_type: "bearer", expires_in: 3600 });
      }
      if (url.includes("/r/stocks/new?")) {
        return jsonResponse(listingPayload(null, [postThing("abc", 1_780_000_000)]));
      }
      return jsonResponse(commentsPayload([]));
    };

    await collectRedditDiscussions({ ...baseOptions(fetchImpl), commentDepth: 3 });

    const commentsUrl = calls.find((call) => call.url.includes("/comments/abc.json"))?.url;
    expect(new URL(commentsUrl ?? "").searchParams.get("depth")).toBe("3");
  });

  test("encodes API-derived comment URL path segments", async () => {
    const calls: FetchCall[] = [];
    const fetchImpl: FetchLike = async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url === "https://www.reddit.com/api/v1/access_token") {
        return jsonResponse({ access_token: "token-1", token_type: "bearer", expires_in: 3600 });
      }
      if (url.includes("/r/stocks/new?")) {
        return jsonResponse(
          listingPayload(null, [
            postThing("abc/slash", 1_780_000_000, {
              id: "abc/slash",
              name: "t3_abc/slash",
              subreddit: "stock picks",
            }),
          ]),
        );
      }
      return jsonResponse(commentsPayload([]));
    };

    await collectRedditDiscussions(baseOptions(fetchImpl));

    const commentsUrl = calls.find((call) => call.url.includes("/comments/"))?.url ?? "";
    expect(commentsUrl).toContain("/r/stock%20picks/comments/abc%2Fslash.json?");
  });

  test("flattens nested comment replies returned by deep comment fetches", async () => {
    const fetchImpl: FetchLike = async (input) => {
      const url = String(input);
      if (url === "https://www.reddit.com/api/v1/access_token") {
        return jsonResponse({ access_token: "token-1", token_type: "bearer", expires_in: 3600 });
      }
      if (url.includes("/r/stocks/new?")) {
        return jsonResponse(listingPayload(null, [postThing("abc", 1_780_000_000)]));
      }
      return jsonResponse(commentsPayload([commentWithReply("c1", "abc", 1_780_000_100)]));
    };

    const result = await collectRedditDiscussions({ ...baseOptions(fetchImpl), commentDepth: 3 });

    expect(result.comments.map((comment) => comment.id)).toEqual(["c1", "reply1"]);
    expect(result.comments.map((comment) => comment.depth)).toEqual([0, 1]);
  });
});
