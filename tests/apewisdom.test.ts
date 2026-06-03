import { describe, expect, test } from "bun:test";
import { sourceGap } from "../src/domain/source-gaps";
import { collectApeWisdomCandidates } from "../src/sources/apewisdom";
import type { FetchJsonResult, SourceRequestExecutor } from "../src/sources/types";

function fetched(
  payload: unknown,
  url = "https://apewisdom.io/api/v1.0/filter/all-stocks/page/1",
): FetchJsonResult {
  return {
    rawSnapshot: {
      id: `raw-apewisdom-${url.split("/").at(-1) ?? "1"}`,
      adapter: "apewisdom",
      fetchedAt: "2026-06-03T00:00:00.000Z",
      payload,
    },
    payload,
  };
}

function requestExecutor(respond: (url: string) => FetchJsonResult): {
  readonly calls: string[];
  readonly request: SourceRequestExecutor;
} {
  const calls: string[] = [];
  return {
    calls,
    request: {
      json: async (request) => {
        calls.push(request.url);
        return respond(request.url);
      },
      text: async () => {
        throw new Error("unexpected text fetch");
      },
    },
  };
}

describe("ApeWisdom discovery client", () => {
  test("collects normalized aggregate candidates across capped pages", async () => {
    const { calls, request } = requestExecutor((url) => {
      const isSecondPage = url.endsWith("/page/2");
      return fetched(
        {
          pages: 2,
          results: [
            isSecondPage
              ? {
                  rank: 25,
                  ticker: "msft",
                  name: "Microsoft Corporation",
                  mentions: 11,
                  upvotes: 44,
                }
              : {
                  rank: "1",
                  ticker: "aapl",
                  name: "Apple Inc.",
                  mentions: "40",
                  upvotes: "120",
                  rank_24h_ago: "6",
                  mentions_24h_ago: "18",
                },
            {
              rank: 2,
              ticker: "bad ticker",
              name: "Bad",
              mentions: 10,
              upvotes: 4,
            },
          ],
        },
        url,
      );
    });

    const result = await collectApeWisdomCandidates({
      filter: "all-stocks",
      pageLimit: 5,
      request,
    });

    expect(calls).toEqual([
      "https://apewisdom.io/api/v1.0/filter/all-stocks/page/1",
      "https://apewisdom.io/api/v1.0/filter/all-stocks/page/2",
    ]);
    expect(result.sourceGaps).toEqual([]);
    expect(result.rawSnapshots).toHaveLength(2);
    expect(result.candidates).toEqual([
      {
        sourceProvider: "apewisdom",
        sourceId: "apewisdom-all-stocks-AAPL",
        filter: "all-stocks",
        url: "https://apewisdom.io/api/v1.0/filter/all-stocks/page/1",
        rank: 1,
        ticker: "AAPL",
        name: "Apple Inc.",
        mentions: 40,
        upvotes: 120,
        rank24hAgo: 6,
        mentions24hAgo: 18,
      },
      {
        sourceProvider: "apewisdom",
        sourceId: "apewisdom-all-stocks-MSFT",
        filter: "all-stocks",
        url: "https://apewisdom.io/api/v1.0/filter/all-stocks/page/2",
        rank: 25,
        ticker: "MSFT",
        name: "Microsoft Corporation",
        mentions: 11,
        upvotes: 44,
      },
    ]);
  });

  test("reports malformed page payloads as source gaps", async () => {
    const { request } = requestExecutor((url) => fetched({ rows: [] }, url));

    const result = await collectApeWisdomCandidates({
      filter: "all-stocks",
      pageLimit: 1,
      request,
    });

    expect(result.candidates).toEqual([]);
    expect(result.sourceGaps).toEqual([
      {
        source: "apewisdom",
        provider: "apewisdom",
        capability: "discussion",
        cause: "malformed-response",
        evidenceQualityImpact: "core-cap",
        message: "ApeWisdom response missing results array",
      },
    ]);
  });

  test("returns request source gaps without treating them as payloads", async () => {
    const gap = sourceGap({ source: "apewisdom", message: "timeout", cause: "fetch-failed" });
    const request: SourceRequestExecutor = {
      json: async () => gap,
      text: async () => {
        throw new Error("unexpected text fetch");
      },
    };

    const result = await collectApeWisdomCandidates({
      filter: "wallstreetbets",
      pageLimit: 1,
      request,
    });

    expect(result.rawSnapshots).toEqual([]);
    expect(result.candidates).toEqual([]);
    expect(result.sourceGaps).toEqual([gap]);
  });

  test("does not fetch when page limit is not positive", async () => {
    const { calls, request } = requestExecutor((url) => fetched({ results: [] }, url));

    const result = await collectApeWisdomCandidates({
      filter: "all-stocks",
      pageLimit: 0,
      request,
    });

    expect(calls).toEqual([]);
    expect(result).toEqual({ rawSnapshots: [], candidates: [], sourceGaps: [] });
  });
});
