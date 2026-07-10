import { describe, expect, test } from "bun:test";
import type { AppConfig } from "../src/config";
import type { ResearchCommand } from "../src/cli/args";
import type { ModelParams } from "../src/model/types";
import type { Source, WebSearchType } from "../src/domain/types";
import { runWebGatherLoop, type WebGatherStageOutput } from "../src/research/web-gather-loop";
import type { ResearchContext } from "../src/research/research-context";
import type { FetchLike } from "../src/sources/types";
import { collectedSources, marketSnapshot } from "./support/fixtures";

const command: ResearchCommand = {
  jobType: "equity",
  assetClass: "equity",
  symbol: "AAPL",
  depth: "deep",
};

const config: AppConfig = {
  provider: "openai",
  quickModel: "quick-test",
  synthesisModel: "synthesis-test",
  modelTimeoutMs: 120_000,
  dataDir: "data/runs",
  promptDir: "prompts",
  sourceOptions: {
    equityMoverLimit: 2,
    cryptoMoverLimit: 2,
    newsLimit: 2,
    sourceTimeoutMs: 1000,
    exaApiKey: "exa-key",
  },
  evidenceRequestOptions: { maxRounds: 0, maxToolCalls: 0, sourceBudget: 0 },
  webGatherOptions: { maxRounds: 2, maxToolCalls: 4, sourceBudget: 8 },
  webGatherDisabled: false,
  webProfileReuseDaysBySubjectKind: { company: 30, "crypto-asset": 7, theme: 7 },
  alphaSearchOptions: {
    apeWisdomFilter: "all-stocks",
    apeWisdomBriefPageLimit: 5,
    apeWisdomDeepPageLimit: 10,
    validationCandidateLimit: 25,
    leadLimit: 15,
    topCandidateLimit: 15,
    secDiscoveryLimit: 25,
    secFormTypes: ["S-1", "F-1", "8-K", "6-K"],
    minPrice: 0.5,
    minVolume: 100_000,
    minMarketCap: 50_000_000,
    maxMarketCap: 10_000_000_000,
  },
};

const context: ResearchContext = {
  depthProfile: {
    depth: "deep",
    analystStyle: "fuller analyst-style",
    minimumKeyFindings: 5,
    minimumScenarios: 3,
    targetPredictions: 6,
    defaultPredictionHorizon: 10,
    predictionSubjects: ["AAPL"],
    focus: [],
    targetKindMix: { favored: ["direction"] },
  },
  runParams: {
    quickModel: "quick-test",
    synthesisModel: "synthesis-test",
    modelParams: undefined as ModelParams | undefined,
    minimumKeyFindings: 5,
    minimumScenarios: 3,
    targetPredictions: 6,
    defaultPredictionHorizon: 10,
    predictionSubjects: ["AAPL"],
    focus: [],
    analystStyle: "fuller analyst-style",
    targetKindMix: { favored: ["direction"] },
  },
  marketRegime: {
    assetClass: "equity",
    label: "insufficient-data",
    proxyCount: 0,
    drivers: [],
    sourceIds: [],
  },
  calibrationContext: undefined,
};

function stage(content: unknown): WebGatherStageOutput {
  return {
    stage: "web-gather",
    content: typeof content === "string" ? content : JSON.stringify(content),
    tokenEstimate: 100,
    costEstimateUsd: 0.01,
  };
}

const firecrawlLoopFetch: FetchLike = async (input) => {
  const url = String(input);
  if (url.includes("api.exa.ai")) {
    return new Response("boom", { status: 500 });
  }
  return Response.json({
    success: true,
    creditsUsed: 2,
    data: {
      web: [
        {
          url: "https://firecrawl.example/aapl-1",
          title: "Apple overview",
          description: "Apple designs devices.",
          markdown: "Apple designs devices and services.",
        },
        {
          url: "https://firecrawl.example/aapl-2",
          title: "Apple segments",
          description: "Apple reports segments.",
          markdown: "Apple reports products and services segments.",
        },
      ],
    },
  });
};

const exaFetch: FetchLike = async (input) => {
  const url = String(input);
  if (url.includes("/contents")) {
    return Response.json({
      results: [
        {
          id: "exa-fetch-1",
          url: "https://example.com/aapl-business",
          title: "Apple business profile",
          summary: "Apple sells hardware and services globally.",
        },
      ],
    });
  }
  return Response.json({
    results: [
      {
        id: "exa-search-1",
        url: "https://example.com/aapl-business",
        title: "Apple business profile",
        summary: "Apple sells iPhone, Mac, services, and wearables.",
        highlights: ["Apple reports products and services revenue."],
      },
    ],
  });
};

// Captures the effective numResults each Exa search executed with, read from the request body because the query string is stripped before it reaches fetch. Two results are returned so non-background searches do not trigger the thin-result widening path.
function recordingExaFetch(): { readonly fetch: FetchLike; readonly searchNumResults: number[] } {
  const searchNumResults: number[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = String(input);
    if (url.includes("/contents")) {
      return Response.json({
        results: [
          {
            id: "exa-fetch-1",
            url: "https://example.com/aapl-business",
            title: "Apple business profile",
            summary: "Apple sells hardware and services globally.",
          },
        ],
      });
    }
    if (url.includes("/search")) {
      const body =
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as { readonly numResults?: number })
          : {};
      if (typeof body.numResults === "number") {
        searchNumResults.push(body.numResults);
      }
    }
    return Response.json({
      results: [
        {
          id: "exa-search-1",
          url: "https://example.com/aapl-business",
          title: "Apple business profile",
          summary: "Apple sells iPhone, Mac, services, and wearables.",
          highlights: ["Apple reports products and services revenue."],
        },
        {
          id: "exa-search-2",
          url: "https://example.com/aapl-services",
          title: "Apple services",
          summary: "Apple services revenue keeps growing.",
          highlights: ["Services revenue expands each quarter."],
        },
      ],
    });
  };
  return { fetch, searchNumResults };
}

function secFilingSource(overrides: Partial<Source> = {}): Source {
  return {
    id: "extended-sec-edgar-aapl-10k",
    title: "AAPL SEC 10-K",
    fetchedAt: "2026-05-01T00:00:00.000Z",
    kind: "extended-evidence",
    provider: "sec-edgar",
    snippet: "[Business] Apple designs and sells devices. [Risk Factors] Supply chain risk.",
    ...overrides,
  };
}

describe("runWebGatherLoop", () => {
  test("skips outside enabled deep web-gather scope", async () => {
    const result = await runWebGatherLoop({
      command: { ...command, depth: "brief" },
      config,
      collectedSources: collectedSources(),
      context,
      now: new Date("2026-05-19T00:00:00.000Z"),
      generateRound: async () => stage({ requests: [] }),
    });

    expect(result.stageOutputs).toEqual([]);
    expect(result.audit).toBeUndefined();
    expect(result.collectedSources.sourceGaps).toEqual([]);
  });

  test("runs web gather for thematic list research", async () => {
    const recorded = recordingExaFetch();
    const result = await runWebGatherLoop({
      command: {
        jobType: "research",
        assetClass: "equity",
        subject: "Top-10 list of promising biotech stocks",
        subjectKey: "biotech",
        predictionProxySymbol: "XBI",
        depth: "deep",
      },
      config: { ...config, webGatherOptions: { maxRounds: 1, maxToolCalls: 2, sourceBudget: 4 } },
      collectedSources: collectedSources(),
      context,
      now: new Date("2026-05-19T00:00:00.000Z"),
      fetchImpl: recorded.fetch,
      retryDelaysMs: [],
      generateRound: async () =>
        stage({
          requests: [
            {
              tool: "web_search",
              args: {
                query: "biotech promising stocks analyst picks",
                searchType: "current-subject",
              },
              rationale: "current sourced candidate evidence",
            },
          ],
        }),
    });

    expect(result.stageOutputs).toHaveLength(1);
    expect(result.audit?.acceptedRequests).toEqual([
      expect.objectContaining({ tool: "web_search" }),
    ]);
    expect(recorded.searchNumResults).toEqual([8]);
    expect(result.collectedSources.extendedSources).toHaveLength(2);
  });

  const themeBudgetConfig: AppConfig = {
    ...config,
    webGatherOptions: {
      maxRounds: 1,
      maxToolCalls: 2,
      sourceBudget: 4,
      themeOverrides: { maxRounds: 1, maxToolCalls: 6, sourceBudget: 12 },
    },
  };

  test("honors zero theme tool-call budget as disabled", async () => {
    let generated = false;
    const result = await runWebGatherLoop({
      command: {
        jobType: "research",
        assetClass: "equity",
        subject: "biotech",
        depth: "deep",
      },
      config: {
        ...themeBudgetConfig,
        webGatherOptions: {
          ...themeBudgetConfig.webGatherOptions,
          themeOverrides: { maxRounds: 1, maxToolCalls: 0, sourceBudget: 12 },
        },
      },
      collectedSources: collectedSources(),
      context,
      now: new Date("2026-05-19T00:00:00.000Z"),
      generateRound: async () => {
        generated = true;
        return stage({ requests: [] });
      },
    });

    expect(generated).toBe(false);
    expect(result.stageOutputs).toEqual([]);
    expect(result.audit).toBeUndefined();
    expect(result.collectedSources.sourceGaps).toEqual([]);
  });

  test("honors zero theme source budget without emitting missing-key gap", async () => {
    let generated = false;
    const sourceOptionsWithoutExa = { ...themeBudgetConfig.sourceOptions };
    delete sourceOptionsWithoutExa.exaApiKey;
    const result = await runWebGatherLoop({
      command: {
        jobType: "research",
        assetClass: "equity",
        subject: "biotech",
        depth: "deep",
      },
      config: {
        ...themeBudgetConfig,
        sourceOptions: sourceOptionsWithoutExa,
        webGatherOptions: {
          ...themeBudgetConfig.webGatherOptions,
          themeOverrides: { maxRounds: 1, maxToolCalls: 6, sourceBudget: 0 },
        },
      },
      collectedSources: collectedSources(),
      context,
      now: new Date("2026-05-19T00:00:00.000Z"),
      generateRound: async () => {
        generated = true;
        return stage({ requests: [] });
      },
    });

    expect(generated).toBe(false);
    expect(result.stageOutputs).toEqual([]);
    expect(result.audit).toBeUndefined();
    expect(result.collectedSources.sourceGaps).toEqual([]);
  });

  test("honors zero base tool-call budget as disabled for theme overrides", async () => {
    let generated = false;
    const result = await runWebGatherLoop({
      command: {
        jobType: "research",
        assetClass: "equity",
        subject: "biotech",
        depth: "deep",
      },
      config: {
        ...themeBudgetConfig,
        webGatherOptions: {
          ...themeBudgetConfig.webGatherOptions,
          maxToolCalls: 0,
        },
      },
      collectedSources: collectedSources(),
      context,
      now: new Date("2026-05-19T00:00:00.000Z"),
      generateRound: async () => {
        generated = true;
        return stage({ requests: [] });
      },
    });

    expect(generated).toBe(false);
    expect(result.stageOutputs).toEqual([]);
    expect(result.audit).toBeUndefined();
    expect(result.collectedSources.sourceGaps).toEqual([]);
  });

  test("honors zero base source budget without emitting theme missing-key gap", async () => {
    let generated = false;
    const sourceOptionsWithoutExa = { ...themeBudgetConfig.sourceOptions };
    delete sourceOptionsWithoutExa.exaApiKey;
    const result = await runWebGatherLoop({
      command: {
        jobType: "research",
        assetClass: "equity",
        subject: "biotech",
        depth: "deep",
      },
      config: {
        ...themeBudgetConfig,
        sourceOptions: sourceOptionsWithoutExa,
        webGatherOptions: {
          ...themeBudgetConfig.webGatherOptions,
          sourceBudget: 0,
        },
      },
      collectedSources: collectedSources(),
      context,
      now: new Date("2026-05-19T00:00:00.000Z"),
      generateRound: async () => {
        generated = true;
        return stage({ requests: [] });
      },
    });

    expect(generated).toBe(false);
    expect(result.stageOutputs).toEqual([]);
    expect(result.audit).toBeUndefined();
    expect(result.collectedSources.sourceGaps).toEqual([]);
  });

  test("applies the theme web-gather budget for thematic runs", async () => {
    const seen: ResearchContext["webGather"][] = [];
    await runWebGatherLoop({
      command: {
        jobType: "research",
        assetClass: "equity",
        subject: "biotech",
        depth: "deep",
      },
      config: themeBudgetConfig,
      collectedSources: collectedSources(),
      context,
      now: new Date("2026-05-19T00:00:00.000Z"),
      generateRound: async (_sources, roundContext) => {
        seen.push(roundContext.webGather);
        return stage({ requests: [] });
      },
    });

    expect(seen[0]?.maxToolCalls).toBe(6);
    expect(seen[0]?.sourceBudget).toBe(12);
  });

  test("keeps the base web-gather budget for instrument runs", async () => {
    const seen: ResearchContext["webGather"][] = [];
    await runWebGatherLoop({
      command,
      config: themeBudgetConfig,
      collectedSources: collectedSources({
        marketSnapshots: [marketSnapshot({ symbol: "AAPL", name: "Apple Inc." })],
      }),
      context,
      now: new Date("2026-05-19T00:00:00.000Z"),
      generateRound: async (_sources, roundContext) => {
        seen.push(roundContext.webGather);
        return stage({ requests: [] });
      },
    });

    expect(seen[0]?.maxToolCalls).toBe(2);
    expect(seen[0]?.sourceBudget).toBe(4);
  });

  test("accepts category/landscape queries for a theme subject", async () => {
    const recorded = recordingExaFetch();
    const result = await runWebGatherLoop({
      command: {
        jobType: "research",
        assetClass: "equity",
        subject: "biotech",
        depth: "deep",
      },
      config: themeBudgetConfig,
      collectedSources: collectedSources(),
      context,
      now: new Date("2026-05-19T00:00:00.000Z"),
      fetchImpl: recorded.fetch,
      retryDelaysMs: [],
      generateRound: async () =>
        stage({
          requests: [
            {
              tool: "web_search",
              args: { query: "biotech sector drivers 2026", searchType: "background" },
              rationale: "category landscape angle",
            },
          ],
        }),
    });

    expect(result.audit?.acceptedRequests).toEqual([
      expect.objectContaining({ tool: "web_search" }),
    ]);
    expect(result.audit?.rejectedRequests).toEqual([]);
  });

  test("widens one thematic list search before reused-profile narrowing", async () => {
    const recorded = recordingExaFetch();
    const result = await runWebGatherLoop({
      command: {
        jobType: "research",
        assetClass: "equity",
        subject: "Top-10 list of promising biotech stocks",
        subjectKey: "biotech",
        predictionProxySymbol: "XBI",
        depth: "deep",
      },
      config: { ...config, webGatherOptions: { maxRounds: 1, maxToolCalls: 3, sourceBudget: 6 } },
      collectedSources: collectedSources(),
      context,
      reusedProfileCoverage: { present: true, topics: ["whatItIs"] },
      now: new Date("2026-05-19T00:00:00.000Z"),
      fetchImpl: recorded.fetch,
      retryDelaysMs: [],
      generateRound: async () =>
        stage({
          requests: [
            {
              tool: "web_search",
              args: {
                query: "biotech promising stocks analyst picks",
                searchType: "current-subject",
              },
              rationale: "current sourced candidate evidence",
            },
            {
              tool: "web_search",
              args: {
                query: "biotech best stocks analyst upside",
                searchType: "current-subject",
              },
              rationale: "corroborate current list evidence",
            },
          ],
        }),
    });

    expect(recorded.searchNumResults).toEqual([8, 3]);
    expect(result.audit?.acceptedRequests).toEqual([
      expect.objectContaining({
        args: expect.objectContaining({ numResults: 8 }),
      }),
      expect.objectContaining({
        args: expect.objectContaining({ numResults: 3 }),
      }),
    ]);
  });

  test("widens thematic list research without explicit equity words", async () => {
    const recorded = recordingExaFetch();
    const result = await runWebGatherLoop({
      command: {
        jobType: "research",
        assetClass: "equity",
        subject: "best semiconductors 2026",
        subjectKey: "semiconductors",
        predictionProxySymbol: "SMH",
        depth: "deep",
      },
      config: { ...config, webGatherOptions: { maxRounds: 1, maxToolCalls: 2, sourceBudget: 4 } },
      collectedSources: collectedSources(),
      context,
      now: new Date("2026-05-19T00:00:00.000Z"),
      fetchImpl: recorded.fetch,
      retryDelaysMs: [],
      generateRound: async () =>
        stage({
          requests: [
            {
              tool: "web_search",
              args: {
                query: "semiconductors 2026 analyst picks",
                searchType: "current-subject",
              },
              rationale: "current sourced candidate evidence",
            },
          ],
        }),
    });

    expect(recorded.searchNumResults).toEqual([8]);
    expect(result.audit?.acceptedRequests).toHaveLength(1);
  });

  test("emits search-unavailable gap when Exa is absent for eligible deep runs", async () => {
    const { exaApiKey: _exaApiKey, ...sourceOptionsWithoutExa } = config.sourceOptions;
    const result = await runWebGatherLoop({
      command,
      config: { ...config, sourceOptions: sourceOptionsWithoutExa },
      collectedSources: collectedSources(),
      context,
      now: new Date("2026-05-19T00:00:00.000Z"),
      generateRound: async () => stage({ requests: [] }),
    });

    expect(result.stageOutputs).toEqual([]);
    expect(result.audit).toBeUndefined();
    expect(result.collectedSources.sourceGaps).toContainEqual(
      expect.objectContaining({
        source: "web-gather",
        message: "search-unavailable: MARKET_BOT_EXA_API_KEY is not set; web gather skipped",
        provider: "exa",
        capability: "web-gather",
        cause: "missing-credential",
        evidenceQualityImpact: "extended-evidence-cap",
      }),
    );
    expect(result.collectedSources.extendedEvidence?.gaps).toEqual(
      result.collectedSources.sourceGaps,
    );
  });

  test("emits search-unavailable gap when Exa is absent for thematic research", async () => {
    const { exaApiKey: _exaApiKey, ...sourceOptionsWithoutExa } = config.sourceOptions;
    const result = await runWebGatherLoop({
      command: {
        jobType: "research",
        assetClass: "equity",
        subject: "Top-10 list of promising biotech stocks",
        subjectKey: "biotech",
        predictionProxySymbol: "XBI",
        depth: "deep",
      },
      config: { ...config, sourceOptions: sourceOptionsWithoutExa },
      collectedSources: collectedSources(),
      context,
      now: new Date("2026-05-19T00:00:00.000Z"),
      generateRound: async () => stage({ requests: [] }),
    });

    expect(result.stageOutputs).toEqual([]);
    expect(result.audit).toBeUndefined();
    expect(result.collectedSources.sourceGaps).toContainEqual(
      expect.objectContaining({
        source: "web-gather",
        message: "search-unavailable: MARKET_BOT_EXA_API_KEY is not set; web gather skipped",
        cause: "missing-credential",
      }),
    );
  });

  test("merges accepted web search sources and exposes web gather context", async () => {
    const prompts: ResearchContext[] = [];
    const result = await runWebGatherLoop({
      command,
      config: { ...config, webGatherOptions: { maxRounds: 1, maxToolCalls: 2, sourceBudget: 4 } },
      collectedSources: collectedSources({
        marketSnapshots: [marketSnapshot({ symbol: "AAPL", name: "Apple Inc." })],
      }),
      context,
      now: new Date("2026-05-19T00:00:00.000Z"),
      fetchImpl: exaFetch,
      retryDelaysMs: [],
      generateRound: async (_sources, roundContext) => {
        prompts.push(roundContext);
        return stage({
          requests: [
            {
              tool: "web_search",
              args: {
                query: "Apple business model revenue segments",
                searchType: "background",
              },
              rationale: "business profile evidence",
            },
          ],
        });
      },
    });

    expect(prompts[0]?.webGather).toMatchObject({
      availableTools: ["web_search", "web_fetch"],
      toolUnits: { web_search: 2, web_fetch: 1 },
      subjectTerms: expect.arrayContaining(["aapl", "apple"]),
    });
    expect(result.collectedSources.extendedSources).toHaveLength(1);
    expect(result.collectedSources.extendedSources[0]).toMatchObject({
      kind: "web",
      provider: "exa",
      symbol: "AAPL",
      rawRef: expect.stringMatching(/^raw-/u),
    });
    expect(result.collectedSources.rawSnapshots.map((snapshot) => snapshot.adapter)).toEqual([
      "exa-search",
    ]);
    expect(result.audit?.acceptedRequests).toHaveLength(1);
    expect(result.audit?.acceptedRequests[0]?.sanitizer).toMatchObject({
      sourceCount: 1,
      sanitizedSourceCount: 1,
    });
    expect(result.audit?.acceptedRequests[0]?.freshness).toEqual({
      searchType: "background",
      endPublishedDate: "2026-05-19T00:00:00.000Z",
      livecrawl: false,
      widened: false,
    });
    expect(result.audit?.sourceUnitsUsed).toBe(2);
    expect(result.audit?.sanitizer).toMatchObject({
      sourceCount: 1,
      sanitizedSourceCount: 1,
      emptyAfterSanitizeCount: 0,
    });
  });

  test("dedupes gather source IDs already present or repeated in a batch; distinct IDs still append", async () => {
    const duplicateResultFetch: FetchLike = async (input, init) => {
      const url = String(input);
      if (url.includes("/contents")) {
        return exaFetch(input, init);
      }
      return Response.json({
        results: [
          {
            id: "exa-search-duplicate-1",
            url: "https://example.com/aapl-business",
            title: "Apple business profile",
            summary: "Apple sells iPhone, Mac, services, and wearables.",
            highlights: ["Apple reports products and services revenue."],
          },
          {
            id: "exa-search-duplicate-2",
            url: "https://example.com/aapl-business",
            title: "Apple business profile duplicate",
            summary: "Apple sells hardware and services globally.",
            highlights: ["Apple reports products and services revenue."],
          },
        ],
      });
    };
    const runOptions = {
      command,
      config: { ...config, webGatherOptions: { maxRounds: 1, maxToolCalls: 2, sourceBudget: 4 } },
      context,
      now: new Date("2026-05-19T00:00:00.000Z"),
      fetchImpl: exaFetch,
      retryDelaysMs: [],
      generateRound: async () =>
        stage({
          requests: [
            {
              tool: "web_search",
              args: { query: "Apple business model revenue segments", searchType: "background" },
              rationale: "business profile evidence",
            },
          ],
        }),
    };

    // Discover the deterministic source the gather emits for the exaFetch URL.
    const discovery = await runWebGatherLoop({
      ...runOptions,
      collectedSources: collectedSources({
        marketSnapshots: [marketSnapshot({ symbol: "AAPL", name: "Apple Inc." })],
      }),
    });
    const [gathered] = discovery.collectedSources.extendedSources;
    expect(gathered).toBeDefined();

    // Same ID already present (e.g. carried in via a reused profile) collapses to one entry.
    const deduped = await runWebGatherLoop({
      ...runOptions,
      collectedSources: collectedSources({
        marketSnapshots: [marketSnapshot({ symbol: "AAPL", name: "Apple Inc." })],
        extendedSources: [gathered!],
      }),
    });
    expect(
      deduped.collectedSources.extendedSources.filter((source) => source.id === gathered!.id),
    ).toHaveLength(1);

    // Duplicate rows within one fresh provider response also collapse to the first occurrence.
    const duplicateBatch = await runWebGatherLoop({
      ...runOptions,
      collectedSources: collectedSources({
        marketSnapshots: [marketSnapshot({ symbol: "AAPL", name: "Apple Inc." })],
      }),
      fetchImpl: duplicateResultFetch,
    });
    expect(duplicateBatch.collectedSources.extendedSources).toHaveLength(1);
    expect(duplicateBatch.collectedSources.extendedSources[0]?.id).toBe(gathered!.id);

    // A distinct pre-existing source is preserved alongside the fresh gather. It is deliberately not a SEC company-profile source (provider/id would gate the web search), so gather still runs and the fresh source is appended next to it.
    const distinct = secFilingSource({
      id: "extended-newswire-aapl-1",
      provider: "newswire",
      snippet: "Prior gather evidence for Apple.",
    });
    const appended = await runWebGatherLoop({
      ...runOptions,
      collectedSources: collectedSources({
        marketSnapshots: [marketSnapshot({ symbol: "AAPL", name: "Apple Inc." })],
        extendedSources: [distinct],
      }),
    });
    const appendedIds = appended.collectedSources.extendedSources.map((source) => source.id);
    expect(appendedIds).toHaveLength(2);
    expect(appendedIds).toContain(distinct.id);
    expect(appendedIds).toContain(gathered!.id);
  });

  test("rejects off-company web search queries", async () => {
    const result = await runWebGatherLoop({
      command,
      config: { ...config, webGatherOptions: { maxRounds: 1, maxToolCalls: 2, sourceBudget: 4 } },
      collectedSources: collectedSources({
        marketSnapshots: [marketSnapshot({ symbol: "AAPL", name: "Apple Inc." })],
      }),
      context,
      now: new Date("2026-05-19T00:00:00.000Z"),
      fetchImpl: exaFetch,
      retryDelaysMs: [],
      generateRound: async () =>
        stage({
          requests: [
            {
              tool: "web_search",
              args: { query: "Snapple beverage customer wins", searchType: "background" },
              rationale: "off subject",
            },
          ],
        }),
    });

    expect(result.audit?.acceptedRequests).toEqual([]);
    expect(result.audit?.rejectedRequests).toEqual([
      expect.objectContaining({
        tool: "web_search",
        reason: "web_search query must mention the run subject",
      }),
    ]);
    expect(result.collectedSources.sourceGaps).toContainEqual(
      expect.objectContaining({
        source: "web-gather",
        message: "a model web query was rejected for drifting off-subject",
      }),
    );
  });

  test("enforces subject terms for research themes", async () => {
    const result = await runWebGatherLoop({
      command: {
        jobType: "research",
        assetClass: "equity",
        subject: "AI infrastructure buildout",
        depth: "deep",
      },
      config: { ...config, webGatherOptions: { maxRounds: 1, maxToolCalls: 2, sourceBudget: 4 } },
      collectedSources: collectedSources(),
      context,
      now: new Date("2026-05-19T00:00:00.000Z"),
      fetchImpl: exaFetch,
      retryDelaysMs: [],
      generateRound: async () =>
        stage({
          requests: [
            {
              tool: "web_search",
              args: { query: "restaurant payment terminals", searchType: "market" },
              rationale: "off subject",
            },
            {
              tool: "web_search",
              args: { query: "AI market news", searchType: "news" },
              rationale: "generic single-token subject drift",
            },
            {
              tool: "web_search",
              args: {
                query: "AI infrastructure buildout power constraints",
                searchType: "current-subject",
              },
              rationale: "on subject",
            },
          ],
        }),
    });

    expect(result.audit?.acceptedRequests).toEqual([
      expect.objectContaining({ tool: "web_search" }),
    ]);
    expect(result.audit?.rejectedRequests).toEqual([
      expect.objectContaining({ reason: "web_search query must mention the run subject" }),
      expect.objectContaining({ reason: "web_search query must mention the run subject" }),
    ]);
  });

  test("allows web fetch only for URLs surfaced by prior search", async () => {
    let round = 0;
    const contexts: ResearchContext[] = [];
    const result = await runWebGatherLoop({
      command,
      config,
      collectedSources: collectedSources({
        marketSnapshots: [marketSnapshot({ symbol: "AAPL", name: "Apple Inc." })],
      }),
      context,
      now: new Date("2026-05-19T00:00:00.000Z"),
      fetchImpl: exaFetch,
      retryDelaysMs: [],
      generateRound: async (_sources, roundContext) => {
        round += 1;
        contexts.push(roundContext);
        return stage({
          requests:
            round === 1
              ? [
                  {
                    tool: "web_search",
                    args: { query: "AAPL business model", searchType: "background" },
                    rationale: "find relevant urls",
                  },
                ]
              : [
                  {
                    tool: "web_fetch",
                    args: { url: "https://example.com/aapl-business" },
                    rationale: "fetch full result",
                  },
                  {
                    tool: "web_fetch",
                    args: { url: "https://evil.example/not-surfaced" },
                    rationale: "bad url",
                  },
                ],
        });
      },
    });

    expect(contexts[1]?.webGather?.surfacedUrls).toContain("https://example.com/aapl-business");
    expect(result.audit?.acceptedRequests).toHaveLength(2);
    expect(result.audit?.rejectedRequests).toEqual([
      expect.objectContaining({
        tool: "web_fetch",
        reason: "web_fetch url was not returned by web_search in this run",
      }),
    ]);
    expect(result.collectedSources.sourceGaps).toContainEqual(
      expect.objectContaining({
        source: "web-gather",
        message: "a model web fetch was rejected because the site is not on the fetch allowlist",
      }),
    );
    expect(result.collectedSources.rawSnapshots.map((snapshot) => snapshot.adapter)).toEqual([
      "exa-search",
      "exa-contents",
    ]);
  });

  test("rejects duplicate web gather requests after normalization", async () => {
    let round = 0;
    const result = await runWebGatherLoop({
      command,
      config,
      collectedSources: collectedSources({
        marketSnapshots: [marketSnapshot({ symbol: "AAPL", name: "Apple Inc." })],
      }),
      context,
      now: new Date("2026-05-19T00:00:00.000Z"),
      fetchImpl: exaFetch,
      retryDelaysMs: [],
      generateRound: async () => {
        round += 1;
        return stage({
          requests:
            round === 1
              ? [
                  {
                    tool: "web_search",
                    args: { query: "Apple business model", searchType: "background" },
                    rationale: "find relevant urls",
                  },
                  {
                    tool: "web_search",
                    args: {
                      query: "  apple   BUSINESS   model  ",
                      searchType: "background",
                    },
                    rationale: "duplicate query",
                  },
                ]
              : [
                  {
                    tool: "web_fetch",
                    args: { url: "https://example.com/aapl-business" },
                    rationale: "fetch surfaced url",
                  },
                  {
                    tool: "web_fetch",
                    args: { url: "https://example.com/aapl-business?utm_source=feed" },
                    rationale: "duplicate canonical url",
                  },
                ],
        });
      },
    });

    expect(result.audit?.acceptedRequests.map((entry) => entry.tool)).toEqual([
      "web_search",
      "web_fetch",
    ]);
    expect(result.audit?.rejectedRequests).toEqual([
      expect.objectContaining({
        tool: "web_search",
        reason: "duplicate web gather request",
      }),
      expect.objectContaining({
        tool: "web_fetch",
        reason: "duplicate web gather request",
      }),
    ]);
    expect(result.collectedSources.sourceGaps).toContainEqual(
      expect.objectContaining({
        source: "web-gather",
        message: "a repeated model web request was skipped",
      }),
    );
    expect(result.collectedSources.sourceGaps).toContainEqual(
      expect.objectContaining({
        source: "web-gather",
        message: "a repeated model web request was skipped",
      }),
    );
  });

  test("rejects web search when asymmetric source budget is exhausted", async () => {
    const result = await runWebGatherLoop({
      command,
      config: { ...config, webGatherOptions: { maxRounds: 1, maxToolCalls: 4, sourceBudget: 3 } },
      collectedSources: collectedSources({
        marketSnapshots: [marketSnapshot({ symbol: "AAPL", name: "Apple Inc." })],
      }),
      context,
      now: new Date("2026-05-19T00:00:00.000Z"),
      fetchImpl: exaFetch,
      retryDelaysMs: [],
      generateRound: async () =>
        stage({
          requests: [
            {
              tool: "web_search",
              args: { query: "Apple business model", searchType: "background" },
              rationale: "first search",
            },
            {
              tool: "web_search",
              args: { query: "AAPL revenue segments", searchType: "background" },
              rationale: "second search",
            },
          ],
        }),
    });

    expect(result.audit?.acceptedRequests).toHaveLength(1);
    expect(result.audit?.sourceUnitsUsed).toBe(2);
    expect(result.audit?.rejectedRequests).toEqual([
      expect.objectContaining({
        tool: "web_search",
        reason: "web gather source budget exceeded",
      }),
    ]);
    expect(result.collectedSources.sourceGaps).toContainEqual(
      expect.objectContaining({
        source: "web-gather",
        message: "a model web request was skipped because the web-gather budget was exhausted",
      }),
    );
  });

  test("humanizes web-gather tool-call budget gaps", async () => {
    const result = await runWebGatherLoop({
      command,
      config: { ...config, webGatherOptions: { maxRounds: 1, maxToolCalls: 1, sourceBudget: 8 } },
      collectedSources: collectedSources({
        marketSnapshots: [marketSnapshot({ symbol: "AAPL", name: "Apple Inc." })],
      }),
      context,
      now: new Date("2026-05-19T00:00:00.000Z"),
      fetchImpl: exaFetch,
      retryDelaysMs: [],
      generateRound: async () =>
        stage({
          requests: [
            {
              tool: "web_search",
              args: { query: "Apple business model", searchType: "background" },
              rationale: "first search",
            },
            {
              tool: "web_search",
              args: { query: "AAPL revenue segments", searchType: "background" },
              rationale: "second search",
            },
          ],
        }),
    });

    expect(result.audit?.rejectedRequests).toEqual([
      expect.objectContaining({
        tool: "web_search",
        reason: "web gather tool-call budget exceeded",
      }),
    ]);
    expect(result.collectedSources.sourceGaps).toContainEqual(
      expect.objectContaining({
        source: "web-gather",
        message: "a model web request was skipped because the web-gather budget was exhausted",
      }),
    );
  });

  test("rejects web search numResults above executor maximum", async () => {
    const result = await runWebGatherLoop({
      command,
      config: { ...config, webGatherOptions: { maxRounds: 1, maxToolCalls: 4, sourceBudget: 8 } },
      collectedSources: collectedSources({
        marketSnapshots: [marketSnapshot({ symbol: "AAPL", name: "Apple Inc." })],
      }),
      context,
      now: new Date("2026-05-19T00:00:00.000Z"),
      generateRound: async () =>
        stage({
          requests: [
            {
              tool: "web_search",
              args: { query: "Apple business model", searchType: "background", numResults: 9 },
              rationale: "oversized search",
            },
          ],
        }),
    });

    expect(result.audit?.acceptedRequests).toEqual([]);
    expect(result.audit?.rejectedRequests).toEqual([
      expect.objectContaining({
        tool: "web_search",
        reason: "web_search numResults must be at most 8",
      }),
    ]);
    expect(result.collectedSources.sourceGaps).toContainEqual(
      expect.objectContaining({
        source: "web-gather",
        message: "web_search: web_search numResults must be at most 8",
      }),
    );
  });

  test("rejects web search without an explicit search type", async () => {
    const result = await runWebGatherLoop({
      command,
      config: { ...config, webGatherOptions: { maxRounds: 1, maxToolCalls: 2, sourceBudget: 4 } },
      collectedSources: collectedSources({
        marketSnapshots: [marketSnapshot({ symbol: "AAPL", name: "Apple Inc." })],
      }),
      context,
      now: new Date("2026-05-19T00:00:00.000Z"),
      fetchImpl: exaFetch,
      retryDelaysMs: [],
      generateRound: async () =>
        stage({
          requests: [
            {
              tool: "web_search",
              args: { query: "Apple business model" },
              rationale: "missing classification",
            },
          ],
        }),
    });

    expect(result.audit?.acceptedRequests).toEqual([]);
    expect(result.audit?.rejectedRequests).toContainEqual(
      expect.objectContaining({
        reason: "web_search searchType must be news, market, current-subject, or background",
      }),
    );
  });

  test("emits a malformed gap and stops on invalid JSON", async () => {
    const result = await runWebGatherLoop({
      command,
      config,
      collectedSources: collectedSources(),
      context,
      now: new Date("2026-05-19T00:00:00.000Z"),
      generateRound: async () => stage("not-json"),
    });

    expect(result.audit?.rounds).toBe(1);
    expect(result.audit?.emittedGaps).toEqual([
      expect.objectContaining({
        source: "web-gather",
        message: "Web gather stage returned invalid JSON",
        capability: "web-gather",
      }),
    ]);
    expect(result.collectedSources.sourceGaps).toContainEqual(
      expect.objectContaining({
        source: "web-gather",
        message: "Web gather stage returned invalid JSON",
        capability: "web-gather",
      }),
    );
  });

  test("derives SEC filing coverage from a gathered 10-K packet for company subjects", async () => {
    const prompts: ResearchContext[] = [];
    const result = await runWebGatherLoop({
      command,
      config: { ...config, webGatherOptions: { maxRounds: 1, maxToolCalls: 2, sourceBudget: 4 } },
      collectedSources: collectedSources({
        marketSnapshots: [marketSnapshot({ symbol: "AAPL", name: "Apple Inc." })],
        extendedSources: [secFilingSource()],
      }),
      context,
      now: new Date("2026-05-19T00:00:00.000Z"),
      fetchImpl: exaFetch,
      retryDelaysMs: [],
      generateRound: async (_sources, roundContext) => {
        prompts.push(roundContext);
        return stage({ requests: [] });
      },
    });

    expect(prompts[0]?.webGather?.secFilingCoverage).toEqual({
      present: true,
      sections: ["Business", "Risk Factors"],
    });
    expect(result.audit?.acceptedRequests).toEqual([]);
  });

  test("omits SEC filing coverage when no filing packet was collected", async () => {
    const prompts: ResearchContext[] = [];
    await runWebGatherLoop({
      command,
      config: { ...config, webGatherOptions: { maxRounds: 1, maxToolCalls: 2, sourceBudget: 4 } },
      collectedSources: collectedSources({
        marketSnapshots: [marketSnapshot({ symbol: "AAPL", name: "Apple Inc." })],
      }),
      context,
      now: new Date("2026-05-19T00:00:00.000Z"),
      fetchImpl: exaFetch,
      retryDelaysMs: [],
      generateRound: async (_sources, roundContext) => {
        prompts.push(roundContext);
        return stage({ requests: [] });
      },
    });

    expect(prompts[0]?.webGather?.secFilingCoverage).toBeUndefined();
  });

  test("omits SEC filing coverage for crypto subjects even with extended sources present", async () => {
    const prompts: ResearchContext[] = [];
    await runWebGatherLoop({
      command: {
        jobType: "crypto",
        assetClass: "crypto",
        symbol: "BTC",
        depth: "deep",
      },
      config: { ...config, webGatherOptions: { maxRounds: 1, maxToolCalls: 2, sourceBudget: 4 } },
      collectedSources: collectedSources({
        extendedSources: [secFilingSource({ symbol: "BTC" })],
      }),
      context,
      now: new Date("2026-05-19T00:00:00.000Z"),
      fetchImpl: exaFetch,
      retryDelaysMs: [],
      generateRound: async (_sources, roundContext) => {
        prompts.push(roundContext);
        return stage({ requests: [] });
      },
    });

    expect(prompts[0]?.webGather?.secFilingCoverage).toBeUndefined();
  });

  test("rejects a background search that duplicates SEC-covered filing sections", async () => {
    const result = await runWebGatherLoop({
      command,
      config: { ...config, webGatherOptions: { maxRounds: 1, maxToolCalls: 2, sourceBudget: 4 } },
      collectedSources: collectedSources({
        marketSnapshots: [marketSnapshot({ symbol: "AAPL", name: "Apple Inc." })],
        extendedSources: [secFilingSource()],
      }),
      context,
      now: new Date("2026-05-19T00:00:00.000Z"),
      fetchImpl: exaFetch,
      retryDelaysMs: [],
      generateRound: async () =>
        stage({
          requests: [
            {
              tool: "web_search",
              args: { query: "AAPL Apple business model overview", searchType: "background" },
              rationale: "durable company profile evidence",
            },
          ],
        }),
    });

    expect(result.audit?.acceptedRequests).toEqual([]);
    expect(result.audit?.rejectedRequests).toEqual([
      expect.objectContaining({
        tool: "web_search",
        reason: expect.stringContaining("sec-covered-durable-profile"),
      }),
    ]);
  });

  test("accepts a background search covering an SEC-covered topic when the rationale states a gap", async () => {
    const result = await runWebGatherLoop({
      command,
      config: { ...config, webGatherOptions: { maxRounds: 1, maxToolCalls: 2, sourceBudget: 4 } },
      collectedSources: collectedSources({
        marketSnapshots: [marketSnapshot({ symbol: "AAPL", name: "Apple Inc." })],
        extendedSources: [secFilingSource()],
      }),
      context,
      now: new Date("2026-05-19T00:00:00.000Z"),
      fetchImpl: exaFetch,
      retryDelaysMs: [],
      generateRound: async () =>
        stage({
          requests: [
            {
              tool: "web_search",
              args: {
                query: "AAPL Apple recent business model update",
                searchType: "background",
              },
              rationale: "the filing is missing a recent update to the business model",
            },
          ],
        }),
    });

    expect(result.audit?.acceptedRequests).toEqual([
      expect.objectContaining({ tool: "web_search" }),
    ]);
    expect(result.audit?.rejectedRequests).toEqual([]);
  });

  test("rejects a background search that duplicates reused profile coverage", async () => {
    const result = await runWebGatherLoop({
      command,
      config: { ...config, webGatherOptions: { maxRounds: 1, maxToolCalls: 2, sourceBudget: 4 } },
      collectedSources: collectedSources({
        marketSnapshots: [marketSnapshot({ symbol: "AAPL", name: "Apple Inc." })],
      }),
      context,
      reusedProfileCoverage: { present: true, topics: ["howItMakesMoney"] },
      now: new Date("2026-05-19T00:00:00.000Z"),
      fetchImpl: exaFetch,
      retryDelaysMs: [],
      generateRound: async () =>
        stage({
          requests: [
            {
              tool: "web_search",
              args: { query: "AAPL Apple revenue model", searchType: "background" },
              rationale: "durable company profile evidence",
            },
          ],
        }),
    });

    expect(result.audit?.acceptedRequests).toEqual([]);
    expect(result.audit?.rejectedRequests).toEqual([
      expect.objectContaining({
        reason: expect.stringContaining("profile-covered-durable-topic"),
      }),
    ]);
  });

  test("recognizes crypto protocol overviews as reused what-it-does coverage", async () => {
    const result = await runWebGatherLoop({
      command: { jobType: "crypto", assetClass: "crypto", symbol: "BTC", depth: "deep" },
      config: { ...config, webGatherOptions: { maxRounds: 1, maxToolCalls: 2, sourceBudget: 4 } },
      collectedSources: collectedSources({
        marketSnapshots: [marketSnapshot({ assetClass: "crypto", symbol: "BTC", name: "Bitcoin" })],
      }),
      context: {
        ...context,
        depthProfile: { ...context.depthProfile, predictionSubjects: ["BTC"] },
        runParams: { ...context.runParams, predictionSubjects: ["BTC"] },
      },
      reusedProfileCoverage: { present: true, topics: ["whatItDoes"] },
      now: new Date("2026-05-19T00:00:00.000Z"),
      fetchImpl: exaFetch,
      retryDelaysMs: [],
      generateRound: async () =>
        stage({
          requests: [
            {
              tool: "web_search",
              args: { query: "BTC Bitcoin protocol overview", searchType: "background" },
              rationale: "durable crypto profile evidence",
            },
          ],
        }),
    });

    expect(result.audit?.acceptedRequests).toEqual([]);
    expect(result.audit?.rejectedRequests).toEqual([
      expect.objectContaining({
        reason: expect.stringContaining("profile-covered-durable-topic"),
      }),
    ]);
  });

  test("allows reused profile coverage searches with an explicit corroboration rationale", async () => {
    const result = await runWebGatherLoop({
      command,
      config: { ...config, webGatherOptions: { maxRounds: 1, maxToolCalls: 2, sourceBudget: 4 } },
      collectedSources: collectedSources({
        marketSnapshots: [marketSnapshot({ symbol: "AAPL", name: "Apple Inc." })],
      }),
      context,
      reusedProfileCoverage: { present: true, topics: ["howItMakesMoney"] },
      now: new Date("2026-05-19T00:00:00.000Z"),
      fetchImpl: exaFetch,
      retryDelaysMs: [],
      generateRound: async () =>
        stage({
          requests: [
            {
              tool: "web_search",
              args: { query: "AAPL Apple revenue model", searchType: "background" },
              rationale: "corroborate the reused profile with current independent evidence",
            },
          ],
        }),
    });

    expect(result.audit?.acceptedRequests).toEqual([
      expect.objectContaining({ tool: "web_search" }),
    ]);
    expect(result.audit?.rejectedRequests).toEqual([]);
  });

  const narrowedSearchTypes: readonly WebSearchType[] = [
    "news",
    "market",
    "current-subject",
    "background",
  ];
  for (const searchType of narrowedSearchTypes) {
    test(`narrows the default ingestion to 3 under reused profile coverage for ${searchType} searches`, async () => {
      const recording = recordingExaFetch();
      const result = await runWebGatherLoop({
        command,
        config: {
          ...config,
          webGatherOptions: { maxRounds: 1, maxToolCalls: 2, sourceBudget: 4 },
        },
        collectedSources: collectedSources({
          marketSnapshots: [marketSnapshot({ symbol: "AAPL", name: "Apple Inc." })],
        }),
        context,
        reusedProfileCoverage: { present: true, topics: ["howItMakesMoney"] },
        now: new Date("2026-05-19T00:00:00.000Z"),
        fetchImpl: recording.fetch,
        retryDelaysMs: [],
        generateRound: async () =>
          stage({
            requests: [
              {
                tool: "web_search",
                // Off the reused-profile topic (howItMakesMoney), so a background query is not rejected as duplicate coverage.
                args: { query: "AAPL Apple recent product news", searchType },
                rationale: "recent material developments",
              },
            ],
          }),
      });

      expect(recording.searchNumResults).toEqual([3]);
      expect(result.audit?.acceptedRequests).toEqual([
        expect.objectContaining({
          tool: "web_search",
          args: expect.objectContaining({ searchType, numResults: 3 }),
        }),
      ]);
    });
  }

  test("respects an explicit numResults under reused profile coverage", async () => {
    const recording = recordingExaFetch();
    const result = await runWebGatherLoop({
      command,
      config: { ...config, webGatherOptions: { maxRounds: 1, maxToolCalls: 2, sourceBudget: 4 } },
      collectedSources: collectedSources({
        marketSnapshots: [marketSnapshot({ symbol: "AAPL", name: "Apple Inc." })],
      }),
      context,
      reusedProfileCoverage: { present: true, topics: ["howItMakesMoney"] },
      now: new Date("2026-05-19T00:00:00.000Z"),
      fetchImpl: recording.fetch,
      retryDelaysMs: [],
      generateRound: async () =>
        stage({
          requests: [
            {
              tool: "web_search",
              args: { query: "AAPL Apple recent product news", searchType: "news", numResults: 6 },
              rationale: "recent material developments",
            },
          ],
        }),
    });

    expect(recording.searchNumResults).toEqual([6]);
    expect(result.audit?.acceptedRequests).toEqual([
      expect.objectContaining({
        tool: "web_search",
        args: expect.objectContaining({ numResults: 6 }),
      }),
    ]);
  });

  test("leaves the default ingestion at 5 without reused profile coverage", async () => {
    const recording = recordingExaFetch();
    const result = await runWebGatherLoop({
      command,
      config: { ...config, webGatherOptions: { maxRounds: 1, maxToolCalls: 2, sourceBudget: 4 } },
      collectedSources: collectedSources({
        marketSnapshots: [marketSnapshot({ symbol: "AAPL", name: "Apple Inc." })],
      }),
      context,
      now: new Date("2026-05-19T00:00:00.000Z"),
      fetchImpl: recording.fetch,
      retryDelaysMs: [],
      generateRound: async () =>
        stage({
          requests: [
            {
              tool: "web_search",
              args: { query: "AAPL Apple recent product news", searchType: "news" },
              rationale: "recent material developments",
            },
          ],
        }),
    });

    expect(recording.searchNumResults).toEqual([5]);
    expect(result.audit?.acceptedRequests).toEqual([
      expect.objectContaining({
        tool: "web_search",
        args: expect.not.objectContaining({ numResults: expect.anything() }),
      }),
    ]);
  });

  test("keeps web-gather skipped when only Firecrawl is configured (fallback-only policy)", async () => {
    const { exaApiKey: _exaApiKey, ...sourceOptionsWithoutExa } = config.sourceOptions;
    const result = await runWebGatherLoop({
      command,
      config: {
        ...config,
        sourceOptions: { ...sourceOptionsWithoutExa, firecrawlApiKey: "firecrawl-key" },
      },
      collectedSources: collectedSources(),
      context,
      now: new Date("2026-05-19T00:00:00.000Z"),
      generateRound: async () => stage({ requests: [] }),
    });

    expect(result.stageOutputs).toEqual([]);
    expect(result.audit).toBeUndefined();
    expect(result.collectedSources.sourceGaps).toContainEqual(
      expect.objectContaining({
        source: "web-gather",
        provider: "exa",
        cause: "missing-credential",
      }),
    );
  });

  test("serves Firecrawl sources through the loop when Exa fails", async () => {
    const result = await runWebGatherLoop({
      command,
      config: {
        ...config,
        sourceOptions: { ...config.sourceOptions, firecrawlApiKey: "firecrawl-key" },
        webGatherOptions: { maxRounds: 1, maxToolCalls: 2, sourceBudget: 4 },
      },
      collectedSources: collectedSources({
        marketSnapshots: [marketSnapshot({ symbol: "AAPL", name: "Apple Inc." })],
      }),
      context,
      now: new Date("2026-05-19T00:00:00.000Z"),
      fetchImpl: firecrawlLoopFetch,
      retryDelaysMs: [],
      generateRound: async () =>
        stage({
          requests: [
            {
              tool: "web_search",
              args: { query: "AAPL Apple business model", searchType: "background" },
              rationale: "profile evidence",
            },
          ],
        }),
    });

    expect(result.collectedSources.extendedSources).toHaveLength(2);
    expect(
      result.collectedSources.extendedSources.every((source) => source.provider === "firecrawl"),
    ).toBe(true);
    expect(result.audit?.acceptedRequests[0]?.fallback).toMatchObject({
      attemptedProviders: ["exa", "firecrawl"],
      servedProvider: "firecrawl",
      fallbackReason: "hard-failure",
    });
  });

  test("accepts a background search for a topic the SEC packet does not cover", async () => {
    const result = await runWebGatherLoop({
      command,
      config: { ...config, webGatherOptions: { maxRounds: 1, maxToolCalls: 2, sourceBudget: 4 } },
      collectedSources: collectedSources({
        marketSnapshots: [marketSnapshot({ symbol: "AAPL", name: "Apple Inc." })],
        extendedSources: [secFilingSource()],
      }),
      context,
      now: new Date("2026-05-19T00:00:00.000Z"),
      fetchImpl: exaFetch,
      retryDelaysMs: [],
      generateRound: async () =>
        stage({
          requests: [
            {
              tool: "web_search",
              args: { query: "AAPL Apple management track record", searchType: "background" },
              rationale: "durable profile area not in the filing packet",
            },
          ],
        }),
    });

    expect(result.audit?.acceptedRequests).toEqual([
      expect.objectContaining({ tool: "web_search" }),
    ]);
    expect(result.audit?.rejectedRequests).toEqual([]);
  });
});
