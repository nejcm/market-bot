import { describe, expect, test } from "bun:test";
import { createMultiNewsAdapter } from "../src/sources/multi-news";
import type { CollectContext, NewsAdapter } from "../src/sources/types";
import type { Source } from "../src/domain/types";

function source(id: string, provider: string, title: string, fetchedAt: string): Source {
  return {
    id,
    title,
    fetchedAt,
    kind: "news",
    assetClass: "equity",
    provider,
  };
}

function adapter(provider: string, newsSources: readonly Source[]): NewsAdapter {
  return {
    name: `${provider}-news`,
    provider,
    normalizeNews: () => [],
    collect: async () => ({ rawSnapshots: [], newsSources, sourceGaps: [] }),
  };
}

function context(): CollectContext {
  return {
    command: { jobType: "ticker", assetClass: "equity", symbol: "AAPL", depth: "brief" },
    fetchedAt: "2026-06-01T00:00:00.000Z",
    newsLimit: 4,
    cryptoMoverLimit: 0,
    request: {
      json: async () => {
        throw new Error("not used");
      },
      text: async () => {
        throw new Error("not used");
      },
    },
  };
}

describe("multi-news", () => {
  test("prioritizes ticker-relevant news inside provider round-robin selection", async () => {
    const multi = createMultiNewsAdapter(
      [
        adapter("provider-a", [
          source("a-generic", "provider-a", "Markets rise broadly", "2026-06-01T12:00:00.000Z"),
          source(
            "a-relevant",
            "provider-a",
            "AAPL supplier demand rises",
            "2026-06-01T11:00:00.000Z",
          ),
        ]),
        adapter("provider-b", [
          source("b-generic", "provider-b", "Tech sector roundup", "2026-06-01T12:00:00.000Z"),
          source(
            "b-relevant",
            "provider-b",
            "AAPL services revenue expands",
            "2026-06-01T10:00:00.000Z",
          ),
        ]),
      ],
      ["provider-a", "provider-b"],
    );

    const result = await multi.collect(context());

    expect(result.newsSources.map((item) => item.title)).toEqual([
      "AAPL supplier demand rises",
      "AAPL services revenue expands",
      "Markets rise broadly",
      "Tech sector roundup",
    ]);
    expect(result.newsAnalytics).toMatchObject({
      selectedNewsSourceCount: 4,
      selectedRelevantTickerNewsSourceCount: 2,
      selectedGenericTickerNewsSourceCount: 2,
    });
  });
});
