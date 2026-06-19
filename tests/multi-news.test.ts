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

  test("does not treat generic market headlines as subject-relevant for thematic targets", async () => {
    // Mirrors the semiconductor subject proxy target: displayName + aliases joined into one name.
    // Aliases here include generic terms ("chip stocks", "semiconductor stocks").
    const semiconductorTargetName =
      "Semiconductors semiconductors semiconductor stocks chips chip stocks semis";
    const researchContext: CollectContext = {
      command: {
        jobType: "research",
        assetClass: "equity",
        subject: "semiconductors",
        depth: "brief",
      },
      fetchedAt: "2026-06-01T00:00:00.000Z",
      newsLimit: 4,
      cryptoMoverLimit: 0,
      newsRelevanceTargets: [
        { symbol: "SMH", name: semiconductorTargetName },
        { symbol: "NVDA", name: "NVIDIA Corporation" },
        { symbol: "AMD", name: "Advanced Micro Devices" },
        { symbol: "AVGO", name: "Broadcom" },
      ],
      request: {
        json: async () => {
          throw new Error("not used");
        },
        text: async () => {
          throw new Error("not used");
        },
      },
    };

    const multi = createMultiNewsAdapter(
      [
        adapter("provider-a", [
          source(
            "a-generic",
            "provider-a",
            "Stocks rally as Fed holds rates",
            "2026-06-01T12:00:00.000Z",
          ),
          source(
            "a-relevant",
            "provider-a",
            "NVDA chips power AI demand",
            "2026-06-01T11:00:00.000Z",
          ),
        ]),
      ],
      ["provider-a"],
    );

    const result = await multi.collect(researchContext);

    // The subject-relevant headline must outrank the generic "stocks" headline.
    expect(result.newsSources.map((item) => item.title)).toEqual([
      "NVDA chips power AI demand",
      "Stocks rally as Fed holds rates",
    ]);
    expect(result.newsAnalytics).toMatchObject({
      selectedRelevantMoverNewsSourceCount: 1,
      selectedGenericMoverNewsSourceCount: 1,
    });
  });
});
