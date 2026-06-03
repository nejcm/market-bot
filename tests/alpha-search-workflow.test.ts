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
          marketCap: 3_000_000_000_000,
        },
        {
          symbol: "OTCX",
          shortName: "OTC Example",
          exchange: "OTC",
          quoteType: "EQUITY",
          regularMarketPrice: 2,
          regularMarketVolume: 1000,
        },
      ],
    },
  };
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
        },
        {
          symbol: "MSFT",
          exchange: "NMS",
          quoteType: "EQUITY",
          regularMarketPrice: 410,
          regularMarketVolume: 22_000_000,
        },
        {
          symbol: "TSLA",
          exchange: "NMS",
          quoteType: "EQUITY",
          regularMarketPrice: 180,
          regularMarketVolume: 80_000_000,
        },
      ],
    },
  };
}

function fetchImpl(requestedUrls: string[]): FetchLike {
  return async (input) => {
    const url = String(input);
    requestedUrls.push(url);

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

    if (url.includes("apewisdom.io")) {
      return jsonResponse(validationLimitApeWisdomPayload());
    }
    if (url.includes("query1.finance.yahoo.com")) {
      return jsonResponse(validationLimitYahooPayload());
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
      expect.arrayContaining(["normalized", "raw", "report.json", "report.md", "trace.json"]),
    );
    await expect(readdir(result.artifacts.normalizedDir)).resolves.toEqual(
      expect.arrayContaining([
        "social-candidates.json",
        "rejected-candidates.json",
        "research-leads.json",
        "source-gaps.json",
      ]),
    );

    expect(result.report.jobType).toBe("alpha-search");
    expect(result.report.predictions).toEqual([]);
    expect(result.report.extras?.researchLeads).toEqual([
      expect.objectContaining({
        symbol: "AAPL",
        name: "Apple Inc.",
        socialRank: 1,
        mentions: 40,
      }),
    ]);
    expect(result.report.extras?.rejectedCandidates).toEqual([
      expect.objectContaining({
        symbol: "OTCX",
        reason: "OTC or pink-sheet instrument",
        sourceIds: ["apewisdom-all-stocks-OTCX"],
      }),
    ]);
    expect(result.markdown).toContain("## Research Leads");
    expect(result.markdown).toContain("## Rejected Candidates");
    expect(result.markdown).toContain("[apewisdom-all-stocks-AAPL]");
    expect(result.markdown).not.toMatch(/\bbuy\b/iu);
    expect(
      result.report.sources.find((source) => source.id === "apewisdom-all-stocks-AAPL")?.title,
    ).toBe("ApeWisdom AAPL social momentum rank 1");
    expect(result.markdown).not.toContain("## Predictions");
    expect(result.markdown).toContain("Research-only note");
    expect(requestedUrls.some((url) => url.includes("symbols=AAPL%2COTCX"))).toBe(true);

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
    expect(Array.isArray(researchLeads) ? researchLeads : []).toHaveLength(1);
    expect(persistedLeads).toHaveLength(1);
  });
});
