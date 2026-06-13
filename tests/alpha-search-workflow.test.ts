import { afterEach, describe, expect, test } from "bun:test";
import { readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAlphaSearchWorkflow } from "../src/alpha-search/workflow";
import type { AppConfig } from "../src/config";
import { resetSourceResilienceForTests } from "../src/sources/collector";
import type { FetchLike } from "../src/sources/types";

const dataDirs: string[] = [];

afterEach(async () => {
  resetSourceResilienceForTests();
  await Promise.all(dataDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function dataDir(): string {
  const path = join(
    tmpdir(),
    `market-bot-alpha-workflow-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  dataDirs.push(path);
  return path;
}

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    provider: "openai",
    quickModel: "quick",
    synthesisModel: "synthesis",
    modelTimeoutMs: 120_000,
    dataDir: dataDir(),
    promptDir: "prompts",
    sourceOptions: {
      equityMoverLimit: 3,
      cryptoMoverLimit: 3,
      newsLimit: 3,
      sourceTimeoutMs: 1000,
    },
    evidenceRequestOptions: {
      maxRounds: 0,
      maxToolCalls: 0,
      sourceBudget: 0,
    },
    alphaSearchOptions: {
      apeWisdomFilter: "all-stocks",
      apeWisdomBriefPageLimit: 5,
      apeWisdomDeepPageLimit: 10,
      validationCandidateLimit: 25,
      leadLimit: 15,
      topCandidateLimit: 15,
      secDiscoveryLimit: 25,
      secFormTypes: ["S-1"],
      minPrice: 0.5,
      minVolume: 100_000,
      minMarketCap: 50_000_000,
      maxMarketCap: 10_000_000_000,
    },
    ...overrides,
  };
}

function jsonResponse(payload: unknown): Response {
  return Response.json(payload);
}

function apeWisdomPayload(): unknown {
  return {
    pages: 1,
    results: [
      {
        rank: 1,
        ticker: "AAPL",
        name: "Apple Inc.",
        mentions: 40,
        upvotes: 120,
        rank_24h_ago: 5,
        mentions_24h_ago: 18,
      },
      {
        rank: 2,
        ticker: "OTCX",
        name: "OTC Example",
        mentions: 8,
        upvotes: 12,
      },
      {
        rank: 3,
        ticker: "MEGA",
        name: "Mega Cap Example",
        mentions: 6,
        upvotes: 10,
      },
    ],
  };
}

function yahooPayload(): unknown {
  return {
    quoteResponse: {
      result: [
        {
          symbol: "AAPL",
          shortName: "Apple Inc.",
          exchange: "NMS",
          fullExchangeName: "NasdaqGS",
          quoteType: "EQUITY",
          regularMarketPrice: 195.5,
          regularMarketVolume: 55_000_000,
          marketCap: 3_000_000_000,
        },
        {
          symbol: "OTCX",
          shortName: "OTC Example",
          exchange: "OTC",
          quoteType: "EQUITY",
          regularMarketPrice: 2,
          regularMarketVolume: 1000,
          marketCap: 100_000_000,
        },
        {
          symbol: "MEGA",
          shortName: "Mega Cap Example",
          exchange: "NMS",
          quoteType: "EQUITY",
          regularMarketPrice: 120,
          regularMarketVolume: 10_000_000,
          marketCap: 1_000_000_000_000,
        },
      ],
    },
  };
}

function nasdaqListedPayload(): string {
  return [
    "Symbol|Security Name|Market Category|Test Issue|Financial Status|Round Lot Size|ETF|NextShares",
    "AAPL|Apple Inc. Common Stock|Q|N|N|100|N|N",
    "MSFT|Microsoft Common Stock|Q|N|N|100|N|N",
    "TSLA|Tesla Common Stock|Q|N|N|100|N|N",
    "MEGA|Mega Cap Example Common Stock|Q|N|N|100|N|N",
  ].join("\n");
}

function nasdaqOtherListedPayload(): string {
  return [
    "ACT Symbol|Security Name|Exchange|CQS Symbol|ETF|Round Lot Size|Test Issue|NASDAQ Symbol",
    "OTCX|OTC Example|N|OTCX|N|100|Y|OTCX",
  ].join("\n");
}

function cboeListedPayload(): string {
  return "Name,Volume,Last Price\nAAPL,100,$195.50\nMEGA,100,$120.00";
}

function validationLimitApeWisdomPayload(): unknown {
  return {
    pages: 1,
    results: [
      { rank: 1, ticker: "AAPL", name: "Apple Inc.", mentions: 30, upvotes: 90 },
      { rank: 2, ticker: "MSFT", name: "Microsoft", mentions: 20, upvotes: 60 },
      { rank: 3, ticker: "TSLA", name: "Tesla", mentions: 10, upvotes: 30 },
    ],
  };
}

function validationLimitYahooPayload(): unknown {
  return {
    quoteResponse: {
      result: [
        {
          symbol: "AAPL",
          exchange: "NMS",
          quoteType: "EQUITY",
          regularMarketPrice: 195.5,
          regularMarketVolume: 55_000_000,
          marketCap: 3_000_000_000,
        },
        {
          symbol: "MSFT",
          exchange: "NMS",
          quoteType: "EQUITY",
          regularMarketPrice: 410,
          regularMarketVolume: 22_000_000,
          marketCap: 4_000_000_000,
        },
        {
          symbol: "TSLA",
          exchange: "NMS",
          quoteType: "EQUITY",
          regularMarketPrice: 180,
          regularMarketVolume: 80_000_000,
          marketCap: 5_000_000_000,
        },
      ],
    },
  };
}

function emptySecTickersPayload(): unknown {
  return {};
}

function secTickersPayload(): unknown {
  return {
    "0": { cik_str: 4_444_444, ticker: "SECO", title: "Sec Only Co" },
    "1": { cik_str: 3_200_193, ticker: "AAPL", title: "Apple Inc." },
  };
}

function secAtomPayload(): string {
  return [
    "<feed>",
    "<entry>",
    "<title>S-1 - Sec Only Co (0004444444) (Filer)</title>",
    "<updated>2026-06-02T12:00:00-04:00</updated>",
    "<summary>CIK=0004444444</summary>",
    "<id>0004444444-26-000010</id>",
    "</entry>",
    "<entry>",
    "<title>S-1 - Apple Inc. (0003200193) (Filer)</title>",
    "<updated>2026-06-01T12:00:00-04:00</updated>",
    "<summary>CIK=0003200193</summary>",
    "<id>0003200193-26-000020</id>",
    "</entry>",
    "</feed>",
  ].join("");
}

function unmappedSecAtomPayload(): string {
  return [
    "<feed>",
    "<entry>",
    "<title>S-1 - Unmapped One (0005555555) (Filer)</title>",
    "<updated>2026-06-04T12:00:00-04:00</updated>",
    "<summary>CIK=0005555555</summary>",
    "<id>0005555555-26-000010</id>",
    "</entry>",
    "<entry>",
    "<title>S-1 - Unmapped Two (0006666666) (Filer)</title>",
    "<updated>2026-06-04T13:00:00-04:00</updated>",
    "<summary>CIK=0006666666</summary>",
    "<id>0006666666-26-000011</id>",
    "</entry>",
    "</feed>",
  ].join("");
}

function secCompanyFactsPayload(): unknown {
  const annual = [
    { val: 100, form: "10-K", fy: 2025, filed: "2026-02-01", end: "2025-12-31" },
    { val: 80, form: "10-K", fy: 2024, filed: "2025-02-01", end: "2024-12-31" },
  ];
  return {
    facts: {
      "us-gaap": {
        Revenues: { units: { USD: annual } },
        NetIncomeLoss: { units: { USD: annual } },
        NetCashProvidedByUsedInOperatingActivities: { units: { USD: annual } },
        LongTermDebt: { units: { USD: annual } },
      },
    },
  };
}

function listingResponse(url: string): Response | undefined {
  if (url.includes("nasdaqlisted.txt")) {
    return new Response(nasdaqListedPayload());
  }
  if (url.includes("otherlisted.txt")) {
    return new Response(nasdaqOtherListedPayload());
  }
  if (url.includes("listed_symbols/csv")) {
    return new Response(cboeListedPayload());
  }
  return undefined;
}

function secResponse(url: string, withCandidates = false): Response | undefined {
  if (url.includes("company_tickers.json")) {
    return jsonResponse(withCandidates ? secTickersPayload() : emptySecTickersPayload());
  }
  if (url.includes("browse-edgar")) {
    return new Response(withCandidates && url.includes("type=S-1") ? secAtomPayload() : "<feed />");
  }
  return undefined;
}

function fetchImpl(requestedUrls: string[]): FetchLike {
  return async (input) => {
    const url = String(input);
    requestedUrls.push(url);
    const sec = secResponse(url);
    if (sec !== undefined) {
      return sec;
    }
    const listedUniverseResponse = listingResponse(url);
    if (listedUniverseResponse !== undefined) {
      return listedUniverseResponse;
    }

    if (url.includes("apewisdom.io")) {
      return jsonResponse(apeWisdomPayload());
    }
    if (url.includes("query1.finance.yahoo.com")) {
      return jsonResponse(yahooPayload());
    }

    return new Response("not found", { status: 404 });
  };
}

function validationLimitFetchImpl(requestedUrls: string[]): FetchLike {
  return async (input) => {
    const url = String(input);
    requestedUrls.push(url);
    const sec = secResponse(url);
    if (sec !== undefined) {
      return sec;
    }
    const listedUniverseResponse = listingResponse(url);
    if (listedUniverseResponse !== undefined) {
      return listedUniverseResponse;
    }

    if (url.includes("apewisdom.io")) {
      return jsonResponse(validationLimitApeWisdomPayload());
    }
    if (url.includes("query1.finance.yahoo.com")) {
      return jsonResponse(validationLimitYahooPayload());
    }

    return new Response("not found", { status: 404 });
  };
}

function secDiscoveryFetchImpl(requestedUrls: string[]): FetchLike {
  return async (input) => {
    const url = String(input);
    requestedUrls.push(url);
    const sec = secResponse(url, true);
    if (sec !== undefined) {
      return sec;
    }
    if (url.includes("nasdaqlisted.txt")) {
      return new Response(
        [
          "Symbol|Security Name|Market Category|Test Issue|Financial Status|Round Lot Size|ETF|NextShares",
          "AAPL|Apple Inc. Common Stock|Q|N|N|100|N|N",
          "SECO|Sec Only Co Common Stock|Q|N|N|100|N|N",
        ].join("\n"),
      );
    }
    if (url.includes("otherlisted.txt")) {
      return new Response(
        "ACT Symbol|Security Name|Exchange|CQS Symbol|ETF|Round Lot Size|Test Issue|NASDAQ Symbol",
      );
    }
    if (url.includes("listed_symbols/csv")) {
      return new Response("Name,Volume,Last Price\nAAPL,100,$195.50\nSECO,100,$12.00");
    }
    if (url.includes("apewisdom.io")) {
      return jsonResponse({
        pages: 1,
        results: [{ rank: 1, ticker: "AAPL", name: "Apple Inc.", mentions: 40, upvotes: 120 }],
      });
    }
    if (url.includes("query1.finance.yahoo.com")) {
      return jsonResponse({
        quoteResponse: {
          result: [
            {
              symbol: "AAPL",
              shortName: "Apple Inc.",
              exchange: "NMS",
              quoteType: "EQUITY",
              regularMarketPrice: 195.5,
              regularMarketVolume: 55_000_000,
              marketCap: 3_000_000_000,
            },
            {
              symbol: "SECO",
              shortName: "Sec Only Co",
              exchange: "NMS",
              quoteType: "EQUITY",
              regularMarketPrice: 12,
              regularMarketVolume: 500_000,
              marketCap: 250_000_000,
            },
          ],
        },
      });
    }
    return new Response("not found", { status: 404 });
  };
}

function fundamentalsFetchImpl(requestedUrls: string[]): FetchLike {
  return async (input) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url.includes("company_tickers.json")) {
      return jsonResponse({ "0": { cik_str: 3_200_193, ticker: "AAPL", title: "Apple Inc." } });
    }
    if (url.includes("companyfacts")) {
      return jsonResponse(secCompanyFactsPayload());
    }
    const listedUniverseResponse = listingResponse(url);
    if (listedUniverseResponse !== undefined) {
      return listedUniverseResponse;
    }
    if (url.includes("browse-edgar")) {
      return new Response("<feed />");
    }
    if (url.includes("apewisdom.io")) {
      return jsonResponse(apeWisdomPayload());
    }
    if (url.includes("query1.finance.yahoo.com")) {
      return jsonResponse(yahooPayload());
    }
    return new Response("not found", { status: 404 });
  };
}

function oversizedRawFetchImpl(requestedUrls: string[]): FetchLike {
  return async (input) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url.includes("company_tickers.json")) {
      return jsonResponse({ fields: ["cik", "name", "ticker", "exchange"], data: [] });
    }
    if (url.includes("browse-edgar")) {
      return new Response("<feed />");
    }
    const listedUniverseResponse = listingResponse(url);
    if (listedUniverseResponse !== undefined) {
      return listedUniverseResponse;
    }
    if (url.includes("apewisdom.io")) {
      return jsonResponse({
        ...(apeWisdomPayload() as Record<string, unknown>),
        padding: "x".repeat(1_100_000),
      });
    }
    if (url.includes("query1.finance.yahoo.com")) {
      return jsonResponse(yahooPayload());
    }
    return new Response("not found", { status: 404 });
  };
}

function unmappedSecFetchImpl(requestedUrls: string[]): FetchLike {
  return async (input) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url.includes("company_tickers.json")) {
      return jsonResponse(secTickersPayload());
    }
    if (url.includes("browse-edgar")) {
      return new Response(url.includes("type=S-1") ? unmappedSecAtomPayload() : "<feed />");
    }
    const listedUniverseResponse = listingResponse(url);
    if (listedUniverseResponse !== undefined) {
      return listedUniverseResponse;
    }
    if (url.includes("apewisdom.io")) {
      return jsonResponse(apeWisdomPayload());
    }
    if (url.includes("query1.finance.yahoo.com")) {
      return jsonResponse(yahooPayload());
    }
    return new Response("not found", { status: 404 });
  };
}

describe("alpha-search workflow", () => {
  test("persists ApeWisdom-ranked Yahoo-validated research leads without predictions", async () => {
    const requestedUrls: string[] = [];
    const result = await runAlphaSearchWorkflow({
      command: { jobType: "alpha-search", assetClass: "equity", depth: "brief" },
      config: config(),
      now: new Date("2026-06-01T00:00:00.000Z"),
      fetchImpl: fetchImpl(requestedUrls),
      retryDelaysMs: [],
    });

    await expect(readdir(result.artifacts.runDir)).resolves.toEqual(
      expect.arrayContaining([
        "analytics.json",
        "normalized",
        "raw",
        "report.json",
        "report.md",
        "trace.json",
      ]),
    );
    await expect(readdir(result.artifacts.normalizedDir)).resolves.toEqual(
      expect.arrayContaining([
        "social-candidates.json",
        "sec-discovery-candidates.json",
        "alpha-search-candidates.json",
        "listed-universe.json",
        "candidate-profiles.json",
        "rejected-candidates.json",
        "research-leads.json",
        "sec-fundamentals.json",
        "sec-fundamentals-source-gaps.json",
        "source-gaps.json",
      ]),
    );

    expect(result.report.jobType).toBe("alpha-search");
    expect(result.report.predictions).toEqual([]);
    expect(result.analytics).toMatchObject({
      version: 1,
      runId: result.report.runId,
      jobType: "alpha-search",
      alphaSearch: {
        socialCandidateCount: 3,
        secCandidateCount: 0,
        validLeadCount: 1,
        rejectedCandidateCount: 2,
      },
    });
    expect(result.report.extras?.researchLeads).toEqual([
      expect.objectContaining({
        symbol: "AAPL",
        name: "Apple Inc.",
        socialRank: 1,
        mentions: 40,
        marketCap: 3_000_000_000,
      }),
    ]);
    expect(result.report.extras?.rejectedCandidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          symbol: "OTCX",
          reason: "Official listing universe marks candidate as test issue",
          sourceIds: ["apewisdom-all-stocks-OTCX"],
        }),
        expect.objectContaining({
          symbol: "MEGA",
          reason: "Yahoo market cap is above configured alpha-search maximum",
          sourceIds: ["apewisdom-all-stocks-MEGA"],
        }),
      ]),
    );
    expect(result.report.extras?.rejectedCandidates).toHaveLength(2);
    expect(result.markdown).toContain("## Research Leads");
    expect(result.markdown).toContain("## Rejected Candidates");
    expect(result.markdown).toContain("[apewisdom-all-stocks-AAPL@rank-1]");
    expect(result.markdown).not.toMatch(/\bbuy\b/iu);
    expect(
      result.report.sources.find((source) => source.id === "apewisdom-all-stocks-AAPL@rank-1")
        ?.title,
    ).toBe("ApeWisdom AAPL social momentum rank 1");
    expect(result.markdown).not.toContain("## Predictions");
    expect(result.markdown).toContain("Research-only note");
    expect(requestedUrls.some((url) => url.includes("nasdaqlisted.txt"))).toBe(true);
    expect(requestedUrls.some((url) => url.includes("symbols=AAPL%2CMEGA"))).toBe(true);
    expect(result.report.extras?.researchLeads).toEqual([
      {
        symbol: "AAPL",
        name: "Apple Inc.",
        exchange: "NMS",
        price: 195.5,
        volume: 55_000_000,
        marketCap: 3_000_000_000,
        discoverySources: ["apewisdom"],
        socialRank: 1,
        socialMomentumScore: 100,
        mentions: 40,
        upvotes: 120,
        rank24hAgo: 5,
        mentions24hAgo: 18,
        mentionDelta24h: 22,
        rankImprovement: 4,
        upvotesPerMention: 3,
        sourceIds: ["apewisdom-all-stocks-AAPL@rank-1", "market-yahoo-alpha-search"],
      },
    ]);
    expect(result.report.extras?.profileCoverage).toEqual({
      displayedLeadCount: 1,
      candidateProfilesWithFundamentals: 0,
      fundamentalGapCount: 1,
      unmappedSecFilingCount: 0,
    });
    expect(result.markdown).toContain("## Profile Coverage");
    expect(result.markdown).toContain("24h mention delta 22");
    expect(result.markdown).toContain("rank improvement 4");
    expect(result.markdown).toContain("upvotes/mention 3");

    const reportJson = JSON.parse(
      await readFile(join(result.artifacts.runDir, "report.json"), "utf8"),
    ) as {
      readonly jobType?: string;
      readonly predictions?: readonly unknown[];
      readonly sources?: readonly { readonly title?: string }[];
    };
    expect(reportJson.jobType).toBe("alpha-search");
    expect(reportJson.predictions).toEqual([]);
    expect(reportJson.sources?.map((source) => source.title).join("\n")).not.toMatch(/\bbuy\b/iu);
    const analyticsJson = JSON.parse(
      await readFile(join(result.artifacts.runDir, "analytics.json"), "utf8"),
    ) as { readonly runId?: string; readonly alphaSearch?: { readonly validLeadCount?: number } };
    expect(analyticsJson).toMatchObject({
      runId: result.report.runId,
      alphaSearch: { validLeadCount: 1 },
    });

    const candidateProfiles = JSON.parse(
      await readFile(join(result.artifacts.normalizedDir, "candidate-profiles.json"), "utf8"),
    ) as readonly unknown[];
    expect(candidateProfiles).toEqual([
      expect.objectContaining({
        symbol: "AAPL",
        runId: result.report.runId,
        sourceGroup: "apewisdom-only",
        price: 195.5,
        socialMomentumScore: 100,
      }),
    ]);
  });

  test("compacts oversized alpha raw snapshots without trimming normalized sidecars", async () => {
    const requestedUrls: string[] = [];
    const result = await runAlphaSearchWorkflow({
      command: { jobType: "alpha-search", assetClass: "equity", depth: "brief" },
      config: config(),
      now: new Date("2026-06-01T00:00:00.000Z"),
      fetchImpl: oversizedRawFetchImpl(requestedUrls),
      retryDelaysMs: [],
    });

    const rawSnapshots = JSON.parse(
      await readFile(join(result.artifacts.rawDir, "snapshots.json"), "utf8"),
    ) as readonly {
      readonly adapter?: string;
      readonly payloadCompacted?: boolean;
      readonly payloadBytes?: number;
      readonly payloadSha256?: string;
      readonly payload?: { readonly topLevelKeys?: readonly string[] };
    }[];
    const compacted = rawSnapshots.find((snapshot) => snapshot.adapter === "apewisdom");
    const researchLeads = JSON.parse(
      await readFile(join(result.artifacts.normalizedDir, "research-leads.json"), "utf8"),
    ) as readonly unknown[];
    const candidateProfiles = JSON.parse(
      await readFile(join(result.artifacts.normalizedDir, "candidate-profiles.json"), "utf8"),
    ) as readonly unknown[];

    expect(compacted).toMatchObject({
      payloadCompacted: true,
      payloadBytes: expect.any(Number),
      payloadSha256: expect.any(String),
      payload: expect.objectContaining({
        topLevelKeys: expect.arrayContaining(["pages", "results", "padding"]),
      }),
    });
    expect(researchLeads).toHaveLength(1);
    expect(candidateProfiles).toHaveLength(1);
  });

  test("validates a wider candidate pool than the displayed lead limit", async () => {
    const requestedUrls: string[] = [];
    const baseConfig = config();
    const cfg = {
      ...baseConfig,
      alphaSearchOptions: {
        ...baseConfig.alphaSearchOptions,
        topCandidateLimit: 1,
        validationCandidateLimit: 3,
        leadLimit: 1,
      },
    };
    const result = await runAlphaSearchWorkflow({
      command: { jobType: "alpha-search", assetClass: "equity", depth: "brief" },
      config: cfg,
      now: new Date("2026-06-01T00:00:00.000Z"),
      fetchImpl: validationLimitFetchImpl(requestedUrls),
      retryDelaysMs: [],
    });
    const researchLeads = result.report.extras?.researchLeads;
    const persistedLeads = JSON.parse(
      await readFile(join(result.artifacts.normalizedDir, "research-leads.json"), "utf8"),
    ) as readonly unknown[];

    expect(
      decodeURIComponent(requestedUrls.find((url) => url.includes("symbols=")) ?? ""),
    ).toContain("symbols=AAPL,MSFT,TSLA");
    const researchLeadRows = Array.isArray(researchLeads) ? researchLeads : [];
    expect(researchLeadRows).toHaveLength(1);
    expect(persistedLeads).toEqual(researchLeadRows);
    expect(JSON.stringify(persistedLeads)).not.toContain("candidate");
    expect(JSON.stringify(persistedLeads)).not.toContain("instrumentKind");
  });

  test("persists SEC fundamentals in candidate profiles without changing report semantics", async () => {
    const requestedUrls: string[] = [];
    const result = await runAlphaSearchWorkflow({
      command: { jobType: "alpha-search", assetClass: "equity", depth: "brief" },
      config: config(),
      now: new Date("2026-06-01T00:00:00.000Z"),
      fetchImpl: fundamentalsFetchImpl(requestedUrls),
      retryDelaysMs: [],
    });

    const candidateProfiles = JSON.parse(
      await readFile(join(result.artifacts.normalizedDir, "candidate-profiles.json"), "utf8"),
    ) as readonly unknown[];
    const fundamentals = JSON.parse(
      await readFile(join(result.artifacts.normalizedDir, "sec-fundamentals.json"), "utf8"),
    ) as readonly unknown[];
    const fundamentalGaps = JSON.parse(
      await readFile(
        join(result.artifacts.normalizedDir, "sec-fundamentals-source-gaps.json"),
        "utf8",
      ),
    ) as readonly { readonly message?: string }[];

    expect(requestedUrls.some((url) => url.includes("companyfacts"))).toBe(true);
    expect(result.report.extras?.researchLeads).toEqual([
      expect.not.objectContaining({ fundamentals: expect.anything() }),
    ]);
    expect(candidateProfiles[0]).toMatchObject({
      symbol: "AAPL",
      fundamentals: {
        secCik: "0003200193",
        sourceIds: ["alpha-sec-fundamentals-aapl"],
        metrics: {
          revenue: 100,
          revenueDeltaPercent: 25,
          netIncome: 100,
          operatingCashFlow: 100,
          debt: 100,
        },
      },
    });
    expect(fundamentals).toEqual([
      expect.objectContaining({
        symbol: "AAPL",
        metrics: expect.objectContaining({ revenueDeltaPercent: 25 }),
      }),
    ]);
    expect(fundamentalGaps.some((gap) => gap.message?.includes("Missing SEC company facts"))).toBe(
      true,
    );
    expect(result.report.extras?.profileCoverage).toEqual({
      displayedLeadCount: 1,
      candidateProfilesWithFundamentals: 1,
      fundamentalGapCount: 1,
      unmappedSecFilingCount: 0,
    });
    expect(result.markdown).toContain("Candidate profiles with fundamentals: 1");
    expect(result.report.predictions).toEqual([]);
    expect(result.markdown).not.toMatch(/\b(buy|sell|hold)\b/iu);
  });

  test("groups repeated unmapped SEC filing gaps in report and trace only", async () => {
    const requestedUrls: string[] = [];
    const result = await runAlphaSearchWorkflow({
      command: { jobType: "alpha-search", assetClass: "equity", depth: "brief" },
      config: config(),
      now: new Date("2026-06-01T00:00:00.000Z"),
      fetchImpl: unmappedSecFetchImpl(requestedUrls),
      retryDelaysMs: [],
    });

    const groupedGap =
      "sec-alpha-search: SEC filing S-1 2026-06-04 did not map to a ticker (2 filings)";
    expect(result.report.dataGaps).toContain(groupedGap);
    expect(result.trace.sourceGaps).toContain(groupedGap);
    expect(result.markdown).toContain(
      String.raw`sec-alpha-search: SEC filing S-1 2026-06-04 did not map to a ticker \(2 filings\)`,
    );
    expect(result.report.extras?.profileCoverage).toMatchObject({
      unmappedSecFilingCount: 2,
    });
    expect(result.markdown).toContain(
      "Unmapped SEC filings: 2 pre-ticker filing(s) disclosed separately",
    );
    const rawGaps = JSON.parse(
      await readFile(join(result.artifacts.normalizedDir, "source-gaps.json"), "utf8"),
    ) as readonly { readonly message?: string }[];
    expect(
      rawGaps.filter((gap) => gap.message === "SEC filing S-1 2026-06-04 did not map to a ticker"),
    ).toHaveLength(2);
  });

  test("adds SEC-discovered leads and enriches ApeWisdom duplicates", async () => {
    const requestedUrls: string[] = [];
    const result = await runAlphaSearchWorkflow({
      command: { jobType: "alpha-search", assetClass: "equity", depth: "brief" },
      config: config(),
      now: new Date("2026-06-01T00:00:00.000Z"),
      fetchImpl: secDiscoveryFetchImpl(requestedUrls),
      retryDelaysMs: [],
    });

    expect(requestedUrls.some((url) => url.includes("company_tickers.json"))).toBe(true);
    expect(requestedUrls.some((url) => url.includes("browse-edgar"))).toBe(true);
    expect(result.report.extras?.researchLeads).toEqual([
      expect.objectContaining({
        symbol: "AAPL",
        discoverySources: ["apewisdom", "sec-filings"],
        socialRank: 1,
        secCik: "0003200193",
        recentSecFilings: [expect.objectContaining({ form: "S-1", filingDate: "2026-06-01" })],
      }),
      expect.objectContaining({
        symbol: "SECO",
        discoverySources: ["sec-filings"],
        secCik: "0004444444",
        recentSecFilings: [expect.objectContaining({ form: "S-1", filingDate: "2026-06-02" })],
      }),
    ]);
    expect(result.markdown).toContain("SEC filings S-1 2026-06-02");
    expect(result.report.predictions).toEqual([]);
    expect(result.markdown).not.toMatch(/\b(undervalued|10x|buy|sell|hold)\b/iu);
  });
});
