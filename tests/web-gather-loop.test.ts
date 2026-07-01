import { describe, expect, test } from "bun:test";
import type { AppConfig } from "../src/config";
import type { ResearchCommand } from "../src/cli/args";
import type { ModelParams } from "../src/model/types";
import type { Source } from "../src/domain/types";
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
        message: "web_search: web_search query must mention the run subject",
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
        message: "web_search: duplicate web gather request",
      }),
    );
    expect(result.collectedSources.sourceGaps).toContainEqual(
      expect.objectContaining({
        source: "web-gather",
        message: "web_fetch: duplicate web gather request",
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
