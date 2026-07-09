import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { createMultiNewsAdapter } from "../src/sources/multi-news";
import { recordSeenNewsSources } from "../src/sources/news-seen";
import type { CollectContext, NewsAdapter } from "../src/sources/types";
import type { Source } from "../src/domain/types";

const seenTmpDirs: string[] = [];

afterEach(() => {
  for (const dir of seenTmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempSeenPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "multi-news-seen-test-"));
  seenTmpDirs.push(dir);
  return join(dir, "news-seen.json");
}

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
    command: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "brief" },
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
  test("runs optional thematic search while providers without it remain unchanged", async () => {
    let genericOnlyCalls = 0;
    let thematicCalls = 0;
    const genericOnly: NewsAdapter = {
      ...adapter("generic-only", [
        source("generic", "generic-only", "Markets rise broadly", "2026-06-01T12:00:00.000Z"),
      ]),
      collect: async () => {
        genericOnlyCalls += 1;
        return {
          rawSnapshots: [],
          newsSources: [
            source("generic", "generic-only", "Markets rise broadly", "2026-06-01T12:00:00.000Z"),
          ],
          sourceGaps: [],
        };
      },
    };
    const searchable: NewsAdapter = {
      ...adapter("searchable", []),
      searchThematic: async (_ctx, query) => {
        thematicCalls += 1;
        expect(query.terms).toEqual(["Biotechnology", "biotech"]);
        return {
          rawSnapshots: [],
          newsSources: [
            source(
              "thematic",
              "searchable",
              "Biotech funding rebounds",
              "2026-06-01T11:00:00.000Z",
            ),
          ],
          sourceGaps: [],
        };
      },
    };

    const result = await createMultiNewsAdapter([genericOnly, searchable]).collect({
      ...context(),
      command: {
        jobType: "research",
        assetClass: "equity",
        subject: "biotech",
        depth: "brief",
      },
      newsRelevanceTargets: [{ symbol: "XBI", name: "Biotechnology biotech" }],
      thematicNewsQuery: {
        subjectId: "biotech",
        subjectLabel: "Biotechnology",
        terms: ["Biotechnology", "biotech"],
      },
    });

    expect(genericOnlyCalls).toBe(1);
    expect(thematicCalls).toBe(1);
    expect(result.newsSources[0]?.title).toBe("Biotech funding rebounds");
    expect(result.newsAnalytics).toMatchObject({
      relevantBeforeSeenFilterCount: 1,
      relevantSelectedCount: 1,
    });
  });

  test("keeps generic news when optional thematic search rejects", async () => {
    const result = await createMultiNewsAdapter([
      {
        ...adapter("searchable", [
          source("generic", "searchable", "Biotech markets gain", "2026-06-01T12:00:00.000Z"),
        ]),
        searchThematic: async () => {
          throw new Error("thematic endpoint unavailable");
        },
      },
    ]).collect({
      ...context(),
      command: {
        jobType: "research",
        assetClass: "equity",
        subject: "biotech",
        depth: "brief",
      },
      newsRelevanceTargets: [{ symbol: "XBI", name: "Biotechnology biotech" }],
      thematicNewsQuery: {
        subjectId: "biotech",
        subjectLabel: "Biotechnology",
        terms: ["Biotechnology", "biotech"],
      },
    });

    expect(result.newsSources).toHaveLength(1);
    expect(result.newsSources[0]?.title).toBe("Biotech markets gain");
    expect(result.sourceGaps).toContainEqual({
      source: "searchable-thematic-news",
      provider: "searchable",
      capability: "news",
      cause: "fetch-failed",
      evidenceQualityImpact: "no-cap",
      message: "thematic endpoint unavailable",
    });
  });

  test("falls back to subject-focused web search before seen filtering", async () => {
    const requests: string[] = [];
    const result = await createMultiNewsAdapter([
      adapter("generic-only", [
        source("generic", "generic-only", "Markets rise broadly", "2026-06-01T12:00:00.000Z"),
      ]),
    ]).collect({
      ...context(),
      command: {
        jobType: "research",
        assetClass: "equity",
        subject: "biotech",
        depth: "brief",
      },
      exaApiKey: "exa-key",
      newsRelevanceTargets: [{ symbol: "XBI", name: "Biotechnology biotech" }],
      thematicNewsQuery: {
        subjectId: "biotech",
        subjectLabel: "Biotechnology",
        terms: ["Biotechnology", "biotech"],
      },
      request: {
        ...context().request,
        json: async ({ adapter: requestAdapter, url }) => {
          requests.push(url);
          return {
            rawSnapshot: {
              id: `raw-${requestAdapter}`,
              adapter: requestAdapter,
              fetchedAt: "2026-06-01T00:00:00.000Z",
              payload: {},
            },
            payload: {
              results: [
                {
                  id: "exa-1",
                  url: "https://example.test/biotech-funding",
                  title: "Biotech funding rebounds",
                  publishedDate: "2026-05-31T00:00:00.000Z",
                  summary: "Biotechnology companies raised new capital.",
                  highlights: ["Biotech funding increased."],
                },
                {
                  id: "exa-2",
                  url: "https://example.test/biotechnology-trials",
                  title: "Biotechnology trial readouts approach",
                  publishedDate: "2026-05-30T00:00:00.000Z",
                  summary: "Several biotechnology trials reported milestones.",
                  highlights: ["Biotechnology trial results are due."],
                },
              ],
            },
          };
        },
      },
    });

    expect(requests).toHaveLength(1);
    expect(new URL(requests[0] ?? "").searchParams.get("searchType")).toBe("news");
    expect(result.newsSources.map((item) => item.title)).toEqual([
      "Biotech funding rebounds",
      "Biotechnology trial readouts approach",
      "Markets rise broadly",
    ]);
    expect(result.newsSources.slice(0, 2).every((item) => item.kind === "news")).toBe(true);
    expect(result.newsAnalytics).toMatchObject({
      fetchedNewsSourcesByProvider: { "generic-only": 1, exa: 2 },
      relevantBeforeSeenFilterCount: 2,
      relevantSelectedCount: 2,
    });
    expect(
      result.modelInputSanitization?.entries.some(
        (entry) => entry.provider === "exa" && entry.ingress === "web-gather",
      ),
    ).toBe(true);
    expect(
      result.modelInputSanitization?.entries.some(
        (entry) => entry.provider === "exa" && entry.ingress === "news",
      ),
    ).toBe(false);
  });

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
      relevantBeforeSeenFilterCount: 2,
      relevantSuppressedBySeenFilterCount: 0,
      relevantSelectedCount: 2,
      selectedNewsSourceCount: 4,
      selectedRelevantTickerNewsSourceCount: 2,
      selectedGenericTickerNewsSourceCount: 2,
    });
  });

  test("uses ticker identity name terms for relevance", async () => {
    const tickerContext: CollectContext = {
      ...context(),
      newsLimit: 1,
      newsRelevanceTargets: [{ symbol: "AAPL", name: "Apple Inc." }],
    };
    const multi = createMultiNewsAdapter(
      [
        adapter("provider-a", [
          source("a-generic", "provider-a", "Markets rise broadly", "2026-06-01T12:00:00.000Z"),
          source(
            "a-relevant",
            "provider-a",
            "Apple supplier demand rises",
            "2026-06-01T11:00:00.000Z",
          ),
        ]),
      ],
      ["provider-a"],
    );

    const result = await multi.collect(tickerContext);

    expect(result.newsSources.map((item) => item.title)).toEqual(["Apple supplier demand rises"]);
    expect(result.newsAnalytics).toMatchObject({
      relevantBeforeSeenFilterCount: 1,
      relevantSuppressedBySeenFilterCount: 0,
      relevantSelectedCount: 1,
      selectedRelevantTickerNewsSourceCount: 1,
      selectedGenericTickerNewsSourceCount: 0,
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

  test("keeps subject-defining words (small caps) matchable for the small-caps subject", async () => {
    // The small-caps subject's own theme is "small caps"; those words must stay matchable
    // Even though they are generic-sounding, while "stocks" remains pure noise.
    const smallCapsTargetName = "Small Caps small caps small-cap stocks russell 2000";
    const researchContext: CollectContext = {
      command: {
        jobType: "research",
        assetClass: "equity",
        subject: "small caps",
        depth: "brief",
      },
      fetchedAt: "2026-06-01T00:00:00.000Z",
      newsLimit: 4,
      cryptoMoverLimit: 0,
      newsRelevanceTargets: [
        { symbol: "IWM", name: smallCapsTargetName },
        { symbol: "VTWO", name: "Vanguard Russell 2000 ETF" },
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
            "Small caps lead the market rally",
            "2026-06-01T11:00:00.000Z",
          ),
        ]),
      ],
      ["provider-a"],
    );

    const result = await multi.collect(researchContext);

    // The small-caps headline must outrank the generic "stocks" headline.
    expect(result.newsSources.map((item) => item.title)).toEqual([
      "Small caps lead the market rally",
      "Stocks rally as Fed holds rates",
    ]);
    expect(result.newsAnalytics).toMatchObject({
      selectedRelevantMoverNewsSourceCount: 1,
      selectedGenericMoverNewsSourceCount: 1,
    });
  });

  test("keeps a seen relevant ticker source via min-relevant-keep when generic survivors remain", async () => {
    const newsSeenPath = tempSeenPath();
    // Seed the seen index with the one issuer-relevant article from a prior run.
    await recordSeenNewsSources({
      path: newsSeenPath,
      retentionDays: 30,
      command: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "brief" },
      runId: "previous-run",
      seenAt: "2026-05-18T00:00:00.000Z",
      sources: [
        {
          id: "news-equity-seen",
          title: "AAPL supplier demand rises",
          url: "https://example.test/aapl-relevant",
          fetchedAt: "2026-05-18T00:00:00.000Z",
          kind: "news",
          assetClass: "equity",
          provider: "provider-a",
        },
      ],
    });

    const seenRelevant: Source = {
      ...source(
        "a-relevant",
        "provider-a",
        "AAPL supplier demand rises",
        "2026-06-01T11:00:00.000Z",
      ),
      url: "https://example.test/aapl-relevant",
    };
    const generic: Source[] = Array.from({ length: 10 }, (_, index) => ({
      ...source(
        `g-${index}`,
        "provider-b",
        `Markets rise broadly ${index}`,
        "2026-06-01T12:00:00.000Z",
      ),
      url: `https://example.test/generic-${index}`,
    }));

    const multi = createMultiNewsAdapter(
      [adapter("provider-a", [seenRelevant]), adapter("provider-b", generic)],
      ["provider-a", "provider-b"],
    );

    const result = await multi.collect({
      ...context(),
      newsLimit: 11,
      newsSeenPath,
      newsSeenRetentionDays: 30,
    });

    // The seen relevant article is re-added and selected alongside the generic survivors.
    expect(result.newsSources.map((item) => item.title)).toContain("AAPL supplier demand rises");
    expect(result.newsAnalytics?.selectedRelevantTickerNewsSourceCount).toBeGreaterThanOrEqual(1);
    expect(result.newsAnalytics?.relevantRepeatKeptCount).toBeGreaterThanOrEqual(1);
    // A repeat-fallback gap is emitted for the re-added relevant source.
    expect(result.sourceGaps.some((gap) => gap.cause === "repeat-fallback")).toBe(true);
    // The relevant article was suppressed by the seen filter, then re-added by the keep guarantee.
    expect(result.newsAnalytics?.relevantSuppressedBySeenFilterCount).toBe(1);
    expect(result.newsAnalytics?.repeatFallbackUsed).toBe(false);
  });

  test("re-adds seen relevant ticker news up to the configured relevance floor", async () => {
    const newsSeenPath = tempSeenPath();
    const relevant = Array.from({ length: 3 }, (_, index) => ({
      ...source(
        `relevant-${index}`,
        "provider-a",
        `AAPL material update ${index}`,
        `2026-06-01T1${index}:00:00.000Z`,
      ),
      url: `https://example.test/aapl-${index}`,
    }));
    await recordSeenNewsSources({
      path: newsSeenPath,
      retentionDays: 30,
      command: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "brief" },
      runId: "previous-run",
      seenAt: "2026-05-18T00:00:00.000Z",
      sources: relevant,
    });
    const generic = Array.from({ length: 6 }, (_, index) => ({
      ...source(
        `generic-${index}`,
        "provider-b",
        `Markets rise broadly ${index}`,
        `2026-06-01T0${index}:00:00.000Z`,
      ),
      url: `https://example.test/generic-floor-${index}`,
    }));
    const multi = createMultiNewsAdapter(
      [adapter("provider-a", relevant), adapter("provider-b", generic)],
      ["provider-a", "provider-b"],
    );

    const result = await multi.collect({
      ...context(),
      newsLimit: 6,
      newsSeenPath,
      newsSeenRetentionDays: 30,
    });

    expect(result.newsSources).toHaveLength(6);
    expect(result.newsAnalytics?.selectedRelevantTickerNewsSourceCount).toBe(3);
    expect(result.newsAnalytics?.relevantRepeatKeptCount).toBe(3);
    expect(result.sourceGaps.filter((gap) => gap.cause === "repeat-fallback")).toHaveLength(1);
  });

  test("clamps the relevance floor to available relevant supply when candidates are scarce", async () => {
    const newsSeenPath = tempSeenPath();
    // Only 2 relevant candidates exist, fewer than the floor of max(2, ceil(6/2)) = 3.
    const relevant = Array.from({ length: 2 }, (_, index) => ({
      ...source(
        `relevant-${index}`,
        "provider-a",
        `AAPL material update ${index}`,
        `2026-06-01T1${index}:00:00.000Z`,
      ),
      url: `https://example.test/aapl-scarce-${index}`,
    }));
    await recordSeenNewsSources({
      path: newsSeenPath,
      retentionDays: 30,
      command: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "brief" },
      runId: "previous-run",
      seenAt: "2026-05-18T00:00:00.000Z",
      sources: relevant,
    });
    const generic = Array.from({ length: 6 }, (_, index) => ({
      ...source(
        `generic-${index}`,
        "provider-b",
        `Markets rise broadly ${index}`,
        `2026-06-01T0${index}:00:00.000Z`,
      ),
      url: `https://example.test/generic-scarce-${index}`,
    }));
    const multi = createMultiNewsAdapter(
      [adapter("provider-a", relevant), adapter("provider-b", generic)],
      ["provider-a", "provider-b"],
    );

    const result = await multi.collect({
      ...context(),
      newsLimit: 6,
      newsSeenPath,
      newsSeenRetentionDays: 30,
    });

    // The floor is clamped to the 2 available relevant sources, not fabricated up to 3.
    expect(result.newsSources).toHaveLength(6);
    expect(result.newsAnalytics?.selectedRelevantTickerNewsSourceCount).toBe(2);
    expect(result.newsAnalytics?.relevantRepeatKeptCount).toBe(2);
    expect(result.sourceGaps.filter((gap) => gap.cause === "repeat-fallback")).toHaveLength(1);
  });
});
