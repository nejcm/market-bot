import { afterEach, describe, expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AppConfig } from "../src/config";
import type { RunConfig } from "../src/config/runs";
import type { MarketContext, MarketSnapshot, Source } from "../src/domain/types";
import type { ModelProvider } from "../src/model/types";
import { persistResearchJob, runResearchJob } from "../src/research/orchestrator";

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
  },
};

const marketSnapshots: readonly MarketSnapshot[] = [
  {
    sourceId: "market-aapl",
    assetClass: "equity",
    symbol: "AAPL",
    price: 190,
    changePercent24h: 2,
    volume: 80_000_000,
    observedAt: "2026-05-19T00:00:00.000Z",
  },
];

const newsSources: readonly Source[] = [
  {
    id: "news-equity-1",
    title: "Apple supplier demand improves",
    fetchedAt: "2026-05-19T00:00:00.000Z",
    kind: "news",
    assetClass: "equity",
  },
];

const marketContextSources: readonly Source[] = [
  {
    id: "market-context-fred-macro",
    title: "FRED macro Market Context",
    fetchedAt: "2026-05-19T00:00:00.000Z",
    kind: "market-context",
    assetClass: "equity",
    provider: "fred",
  },
];

const marketContext: MarketContext = {
  assetClass: "equity",
  items: [
    {
      category: "fred-macro",
      title: "FRED macro Market Context",
      summary: "Latest FRED macro observations captured for DGS10.",
      sourceIds: ["market-context-fred-macro"],
      observedAt: "2026-05-19T00:00:00.000Z",
      metrics: {
        DGS10: 4.25,
        DGS10Change: 0.15,
      },
    },
  ],
  gaps: [],
};

const dataDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    dataDirs.splice(0).map((dataDir) => rm(dataDir, { recursive: true, force: true })),
  );
});

function providerReturning(content: string): ModelProvider {
  return {
    name: "mock",
    generate: async () => ({
      content,
      tokenEstimate: 100,
      costEstimateUsd: 0.01,
    }),
  };
}

function mockPredictions(count: number, subject = "SPY"): unknown[] {
  return Array.from({ length: count }, (_, idx) => ({
    id: `pred-${String(idx + 1)}`,
    claim: `${subject} closes higher over ${String(idx + 5)} trading days.`,
    kind: "direction",
    subject,
    measurableAs: `close(${subject}, +${String(idx + 5)}) > close(${subject}, 0)`,
    horizonTradingDays: idx + 5,
    probability: 0.6,
    sourceIds: ["market-aapl"],
  }));
}

describe("runResearchJob", () => {
  test("uses resolved run models and model params for provider calls and trace", async () => {
    const requests: { readonly model: string; readonly params: unknown }[] = [];
    const runConfig: RunConfig = {
      "daily-equity": {
        quickModel: "combo-quick",
        synthesisModel: "combo-synthesis",
        modelParams: { temperature: 0.2, reasoningEffort: "medium" },
        minimumPredictions: 2,
      },
      "daily-crypto": {},
      "weekly-equity": {},
      "weekly-crypto": {},
      ticker: {},
    };
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        requests.push({ model: request.model, params: request.params });

        return {
          content: JSON.stringify({
            summary: "Equity market breadth is constructive but source coverage is limited.",
            keyFindings: [{ text: "AAPL is a liquid positive mover.", sourceIds: ["market-aapl"] }],
            bullCase: [{ text: "Demand news supports the move.", sourceIds: ["news-equity-1"] }],
            bearCase: [
              {
                text: "Single-name evidence may not represent the whole market.",
                sourceIds: ["market-aapl"],
              },
            ],
            risks: [{ text: "Macro data is missing.", sourceIds: ["market-aapl"] }],
            catalysts: [
              {
                text: "Supplier demand update is the main catalyst.",
                sourceIds: ["news-equity-1"],
              },
            ],
            scenarios: [
              {
                name: "Base",
                description: "Momentum continues if liquidity persists.",
                sourceIds: ["market-aapl"],
              },
            ],
            confidence: "medium",
            dataGaps: [],
            predictions: mockPredictions(2),
          }),
          tokenEstimate: 100,
          costEstimateUsd: 0.01,
        };
      },
    };

    const result = await runResearchJob({
      command: { jobType: "daily", assetClass: "equity", depth: "brief" },
      config,
      runConfig,
      provider,
      collectedSources: {
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        sourceGaps: [],
      },
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    expect(requests).toEqual([
      { model: "combo-quick", params: { temperature: 0.2, reasoningEffort: "medium" } },
      { model: "combo-quick", params: { temperature: 0.2, reasoningEffort: "medium" } },
      { model: "combo-synthesis", params: { temperature: 0.2, reasoningEffort: "medium" } },
    ]);
    expect(result.trace.quickModel).toBe("combo-quick");
    expect(result.trace.synthesisModel).toBe("combo-synthesis");
  });

  test("applies deep output requirements without changing workflow stages", async () => {
    const prompts: string[] = [];
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        prompts.push(request.messages[1]?.content ?? "");

        return {
          content: JSON.stringify({
            summary: "Deep equity review from supplied sources.",
            keyFindings: [{ text: "AAPL has sourced momentum.", sourceIds: ["market-aapl"] }],
            bullCase: [
              { text: "News supports the sourced momentum.", sourceIds: ["news-equity-1"] },
            ],
            bearCase: [
              { text: "Single-source breadth limits confidence.", sourceIds: ["market-aapl"] },
            ],
            risks: [{ text: "Macro context is incomplete.", sourceIds: ["market-aapl"] }],
            catalysts: [
              { text: "Supplier news is the visible catalyst.", sourceIds: ["news-equity-1"] },
            ],
            scenarios: [
              {
                name: "Base",
                description: "Momentum persists if liquidity remains.",
                sourceIds: ["market-aapl"],
              },
            ],
            confidence: "medium",
            dataGaps: [],
            predictions: mockPredictions(3),
          }),
          tokenEstimate: 100,
          costEstimateUsd: 0.01,
        };
      },
    };

    const result = await runResearchJob({
      command: { jobType: "daily", assetClass: "equity", depth: "deep" },
      config,
      provider,
      collectedSources: {
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        sourceGaps: [],
      },
      now: new Date("2026-05-19T00:00:00.000Z"),
    });
    const finalPrompt = JSON.parse(prompts[2] ?? "{}") as {
      readonly depthProfile?: {
        readonly depth?: string;
        readonly analystStyle?: string;
        readonly minimumKeyFindings?: number;
        readonly minimumScenarios?: number;
      };
      readonly evidence?: {
        readonly marketRegime?: {
          readonly label?: string;
          readonly sourceIds?: readonly string[];
        };
      };
    };

    expect(result.trace.stages).toEqual([
      "source-collection",
      "specialist-analysis",
      "critique",
      "final-synthesis",
    ]);
    expect(result.report.extras?.depth).toBe("deep");
    expect(finalPrompt.depthProfile).toMatchObject({
      depth: "deep",
      analystStyle: "fuller analyst-style",
      minimumKeyFindings: 5,
      minimumScenarios: 3,
    });
    expect(finalPrompt.evidence?.marketRegime).toMatchObject({
      label: "insufficient-data",
      sourceIds: [],
    });
  });

  test("creates a daily Research View from mocked sources and model output", async () => {
    const result = await runResearchJob({
      command: { jobType: "daily", assetClass: "equity", depth: "brief" },
      config,
      provider: providerReturning(
        JSON.stringify({
          summary: "Equity market breadth is constructive but source coverage is limited.",
          keyFindings: [{ text: "AAPL is a liquid positive mover.", sourceIds: ["market-aapl"] }],
          bullCase: [{ text: "Demand news supports the move.", sourceIds: ["news-equity-1"] }],
          bearCase: [
            {
              text: "Single-name evidence may not represent the whole market.",
              sourceIds: ["market-aapl"],
            },
          ],
          risks: [{ text: "Macro data is missing.", sourceIds: ["market-aapl"] }],
          catalysts: [
            { text: "Supplier demand update is the main catalyst.", sourceIds: ["news-equity-1"] },
          ],
          scenarios: [
            {
              name: "Base",
              description: "Momentum continues if liquidity persists.",
              sourceIds: ["market-aapl"],
            },
          ],
          confidence: "medium",
          dataGaps: ["Macro breadth source unavailable"],
          predictions: mockPredictions(2),
        }),
      ),
      collectedSources: {
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        sourceGaps: [],
      },
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    expect(result.report).toMatchObject({
      jobType: "daily",
      assetClass: "equity",
      confidence: "medium",
      notFinancialAdvice: true,
    });
    expect(result.markdown).toContain("Research-only note");
    expect(result.markdown).not.toContain("Weekly Market Update");
    expect(result.trace.sourceGaps).toEqual(["Macro breadth source unavailable"]);
    expect(result.trace.stages).toEqual([
      "source-collection",
      "specialist-analysis",
      "critique",
      "final-synthesis",
    ]);
    expect(result.stageOutputs).toHaveLength(3);
    expect(result.trace.tokenEstimate).toBe(300);
  });

  test("surfaces Market Context in market update prompts, extras, citations, and regime drivers", async () => {
    const prompts: string[] = [];
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        prompts.push(request.messages[1]?.content ?? "");
        return {
          content: JSON.stringify({
            summary: "Daily market evidence includes macro context.",
            keyFindings: [
              {
                text: "FRED macro context is available.",
                sourceIds: ["market-context-fred-macro"],
              },
            ],
            bullCase: [{ text: "Market data is constructive.", sourceIds: ["market-aapl"] }],
            bearCase: [{ text: "News coverage is narrow.", sourceIds: ["news-equity-1"] }],
            risks: [{ text: "Macro data can change.", sourceIds: ["market-context-fred-macro"] }],
            catalysts: [{ text: "Company news is visible.", sourceIds: ["news-equity-1"] }],
            scenarios: [
              {
                name: "Base",
                description: "Market remains tied to macro evidence.",
                sourceIds: ["market-context-fred-macro"],
              },
            ],
            confidence: "high",
            dataGaps: [],
            predictions: [
              {
                id: "pred-macro",
                claim: "DGS10 rises over 5 trading days.",
                kind: "macro",
                subject: "DGS10",
                measurableAs: "fred(DGS10, +5) > fred(DGS10, 0)",
                horizonTradingDays: 5,
                probability: 0.6,
                sourceIds: ["market-context-fred-macro"],
              },
              ...mockPredictions(1),
            ],
          }),
          tokenEstimate: 100,
          costEstimateUsd: 0.01,
        };
      },
    };

    const result = await runResearchJob({
      command: { jobType: "daily", assetClass: "equity", depth: "brief" },
      config,
      provider,
      collectedSources: {
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        marketContext,
        marketContextSources,
        sourceGaps: [],
      },
      now: new Date("2026-05-19T00:00:00.000Z"),
    });
    const finalPrompt = JSON.parse(prompts[2] ?? "{}") as {
      readonly evidence?: {
        readonly marketContext?: unknown;
        readonly marketRegime?: {
          readonly label?: string;
          readonly drivers?: readonly string[];
          readonly sourceIds?: readonly string[];
        };
      };
    };

    expect(finalPrompt.evidence?.marketContext).toBeDefined();
    expect(finalPrompt.evidence?.marketRegime?.label).toBe("insufficient-data");
    expect(finalPrompt.evidence?.marketRegime?.drivers).toContain("FRED macro context: DGS10 4.25");
    expect(finalPrompt.evidence?.marketRegime?.sourceIds).toContain("market-context-fred-macro");
    expect(result.report.sources.map((source) => source.id)).toContain("market-context-fred-macro");
    expect(result.report.extras?.marketContext).toEqual(marketContext);
    expect(result.report.extras?.marketRegime).toMatchObject({
      label: "insufficient-data",
      sourceIds: ["market-context-fred-macro"],
    });
    expect(result.report.predictions[0]?.kind).toBe("macro");
  });

  test("surfaces ticker Extended Evidence in prompt, report, and markdown", async () => {
    const prompts: string[] = [];
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        prompts.push(request.messages[1]?.content ?? "");
        return {
          content: JSON.stringify({
            summary: "AAPL ticker evidence includes macro context.",
            keyFindings: [
              { text: "Macro evidence is available.", sourceIds: ["extended-fred-macro"] },
            ],
            bullCase: [{ text: "Market data is constructive.", sourceIds: ["market-aapl"] }],
            bearCase: [{ text: "News coverage is narrow.", sourceIds: ["news-equity-1"] }],
            risks: [{ text: "Macro data can change.", sourceIds: ["extended-fred-macro"] }],
            catalysts: [{ text: "Company news is visible.", sourceIds: ["news-equity-1"] }],
            scenarios: [
              {
                name: "Base",
                description: "Ticker remains tied to market data.",
                sourceIds: ["market-aapl"],
              },
            ],
            confidence: "high",
            dataGaps: [],
            predictions: mockPredictions(3, "AAPL"),
          }),
          tokenEstimate: 100,
          costEstimateUsd: 0.01,
        };
      },
    };

    const result = await runResearchJob({
      command: { jobType: "ticker", assetClass: "equity", symbol: "AAPL", depth: "brief" },
      config,
      provider,
      collectedSources: {
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        extendedSources: [
          {
            id: "extended-fred-macro",
            title: "FRED macro pack",
            fetchedAt: "2026-05-19T00:00:00.000Z",
            kind: "extended-evidence",
            assetClass: "equity",
            symbol: "AAPL",
          },
        ],
        extendedEvidence: {
          instrument: { assetClass: "equity", symbol: "AAPL" },
          items: [
            {
              category: "fred-macro",
              title: "FRED macro pack",
              summary: "Latest FRED macro observations captured.",
              sourceIds: ["extended-fred-macro"],
              observedAt: "2026-05-19T00:00:00.000Z",
            },
          ],
          gaps: [],
        },
        sourceGaps: [],
      },
      now: new Date("2026-05-19T00:00:00.000Z"),
    });
    const finalPrompt = JSON.parse(prompts[2] ?? "{}") as {
      readonly evidence?: { readonly extendedEvidence?: unknown };
    };

    expect(finalPrompt.evidence?.extendedEvidence).toBeDefined();
    expect(result.report.extendedEvidence).toBeDefined();
    expect(result.markdown).toContain("## Extended Evidence");
    expect(result.markdown).toContain("[extended-fred-macro]");
  });

  test("ignores extended sources for market update source lists", async () => {
    const result = await runResearchJob({
      command: { jobType: "daily", assetClass: "equity", depth: "brief" },
      config,
      provider: providerReturning(
        JSON.stringify({
          summary: "Daily market breadth is sourced.",
          keyFindings: [{ text: "AAPL moved.", sourceIds: ["market-aapl"] }],
          bullCase: [{ text: "Supplier news supports breadth.", sourceIds: ["news-equity-1"] }],
          bearCase: [{ text: "Single-name breadth is limited.", sourceIds: ["market-aapl"] }],
          risks: [{ text: "Breadth can reverse.", sourceIds: ["market-aapl"] }],
          catalysts: [{ text: "Supplier demand is visible.", sourceIds: ["news-equity-1"] }],
          scenarios: [
            {
              name: "Base",
              description: "Momentum continues if liquidity persists.",
              sourceIds: ["market-aapl"],
            },
          ],
          confidence: "medium",
          dataGaps: [],
          predictions: mockPredictions(2),
        }),
      ),
      collectedSources: {
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        extendedSources: [
          {
            id: "extended-fred-macro",
            title: "FRED macro pack",
            fetchedAt: "2026-05-19T00:00:00.000Z",
            kind: "extended-evidence",
            assetClass: "equity",
          },
        ],
        sourceGaps: [],
      },
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    expect(result.report.sources.map((source) => source.id)).not.toContain("extended-fred-macro");
  });

  test("creates a weekly market update with weekly horizon metadata and source gap", async () => {
    const prompts: string[] = [];
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        prompts.push(request.messages[1]?.content ?? "");

        return {
          content: JSON.stringify({
            summary: "Weekly equity overview is sourced but mover data is approximate.",
            keyFindings: [{ text: "AAPL is a liquid positive mover.", sourceIds: ["market-aapl"] }],
            bullCase: [{ text: "Demand news supports the move.", sourceIds: ["news-equity-1"] }],
            bearCase: [
              {
                text: "Single-name evidence may not represent the whole market.",
                sourceIds: ["market-aapl"],
              },
            ],
            risks: [{ text: "Macro data is missing.", sourceIds: ["market-aapl"] }],
            catalysts: [
              {
                text: "Supplier demand update is the main catalyst.",
                sourceIds: ["news-equity-1"],
              },
            ],
            scenarios: [
              {
                name: "Base",
                description: "Momentum continues if liquidity persists.",
                sourceIds: ["market-aapl"],
              },
            ],
            confidence: "medium",
            dataGaps: [],
            predictions: mockPredictions(2).map((prediction) => ({
              ...(prediction as Record<string, unknown>),
              claim: "SPY closes higher over 15 trading days.",
              measurableAs: "close(SPY, +15) > close(SPY, 0)",
              horizonTradingDays: 15,
            })),
          }),
          tokenEstimate: 100,
          costEstimateUsd: 0.01,
        };
      },
    };

    const result = await runResearchJob({
      command: { jobType: "weekly", assetClass: "equity", depth: "brief" },
      config,
      provider,
      collectedSources: {
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        sourceGaps: [],
      },
      now: new Date("2026-05-19T00:00:00.000Z"),
    });
    const finalPrompt = JSON.parse(prompts[2] ?? "{}") as {
      readonly depthProfile?: {
        readonly defaultPredictionHorizon?: number;
        readonly minimumPredictions?: number;
      };
      readonly requiredShape?: {
        readonly predictions?: readonly { readonly horizonTradingDays?: number }[];
      };
    };

    expect(result.report.jobType).toBe("weekly");
    expect(result.report.extras?.marketUpdateCadence).toBe("weekly");
    expect(result.trace.marketUpdateCadence).toBe("weekly");
    expect(result.markdown).toContain("# equity Weekly Market Update");
    expect(result.report.predictions[0]?.horizonTradingDays).toBe(15);
    expect(result.report.dataGaps).toContain(
      "Weekly equity mover universe is seeded from Yahoo day_gainers, not a true trailing 5-session mover screener",
    );
    expect(finalPrompt.depthProfile?.defaultPredictionHorizon).toBe(15);
    expect(finalPrompt.depthProfile?.minimumPredictions).toBe(2);
    expect(finalPrompt.requiredShape?.predictions?.[0]?.horizonTradingDays).toBe(15);
  });

  test("rejects reports with trade-action language", async () => {
    await expect(
      runResearchJob({
        command: { jobType: "ticker", assetClass: "equity", symbol: "AAPL", depth: "deep" },
        config,
        provider: providerReturning(
          JSON.stringify({
            summary: "Buy AAPL after the catalyst.",
            keyFindings: [{ text: "AAPL moved.", sourceIds: ["market-aapl"] }],
            bullCase: [],
            bearCase: [],
            risks: [],
            catalysts: [],
            scenarios: [],
            confidence: "low",
            dataGaps: [],
          }),
        ),
        collectedSources: {
          rawSnapshots: [],
          marketSnapshots,
          newsSources,
          sourceGaps: [],
        },
        now: new Date("2026-05-19T00:00:00.000Z"),
      }),
    ).rejects.toThrow("trade-action language");
  });

  test("persists raw, normalized, report, markdown, and trace artifacts", async () => {
    const dataDir = join(tmpdir(), `market-bot-test-${Date.now()}`);
    dataDirs.push(dataDir);
    const result = await persistResearchJob({
      command: { jobType: "daily", assetClass: "equity", depth: "brief" },
      config: {
        ...config,
        dataDir,
      },
      provider: providerReturning(
        JSON.stringify({
          summary: "Equity market breadth is constructive.",
          keyFindings: [{ text: "AAPL is liquid.", sourceIds: ["market-aapl"] }],
          bullCase: [],
          bearCase: [],
          risks: [],
          catalysts: [],
          scenarios: [],
          confidence: "medium",
          dataGaps: [],
        }),
      ),
      collectedSources: {
        rawSnapshots: [
          {
            id: "raw-1",
            adapter: "mock",
            fetchedAt: "2026-05-19T00:00:00.000Z",
            payload: { ok: true },
          },
        ],
        marketSnapshots,
        newsSources,
        sourceGaps: [],
      },
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    await expect(
      readFile(join(result.artifacts.rawDir, "snapshots.json"), "utf8"),
    ).resolves.toContain("raw-1");
    await expect(
      readFile(join(result.artifacts.normalizedDir, "market-snapshots.json"), "utf8"),
    ).resolves.toContain("market-aapl");
    await expect(readFile(join(result.artifacts.runDir, "report.json"), "utf8")).resolves.toContain(
      "Equity market breadth",
    );
    await expect(readFile(join(result.artifacts.runDir, "report.md"), "utf8")).resolves.toContain(
      "Research-only note",
    );
    await expect(readFile(join(result.artifacts.runDir, "trace.json"), "utf8")).resolves.toContain(
      "quick-test",
    );
    await expect(readFile(join(result.artifacts.runDir, "stages.json"), "utf8")).resolves.toContain(
      "specialist-analysis",
    );
  });

  test("caps Evidence Quality and adds deterministic gaps for sparse sources", async () => {
    const result = await runResearchJob({
      command: { jobType: "daily", assetClass: "equity", depth: "brief" },
      config,
      provider: providerReturning(
        JSON.stringify({
          summary: "Evidence is sparse.",
          keyFindings: [],
          bullCase: [],
          bearCase: [],
          risks: [],
          catalysts: [],
          scenarios: [],
          confidence: "high",
          dataGaps: [],
        }),
      ),
      collectedSources: {
        rawSnapshots: [],
        marketSnapshots: [],
        newsSources: [],
        sourceGaps: [{ source: "yahoo", message: "source request failed with status 500" }],
      },
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    expect(result.report.confidence).toBe("low");
    expect(result.report.dataGaps).toContain("No usable market data snapshots were collected");
    expect(result.report.dataGaps).toContain("No usable news sources were collected");
    expect(result.report.dataGaps).toContain("yahoo: source request failed with status 500");
  });

  test("does not cap Evidence Quality for missing Market Context", async () => {
    const result = await runResearchJob({
      command: { jobType: "daily", assetClass: "equity", depth: "brief" },
      config,
      provider: providerReturning(
        JSON.stringify({
          summary: "Core market evidence is available.",
          keyFindings: [{ text: "AAPL moved.", sourceIds: ["market-aapl"] }],
          bullCase: [{ text: "Supplier news supports breadth.", sourceIds: ["news-equity-1"] }],
          bearCase: [{ text: "Single-name breadth is limited.", sourceIds: ["market-aapl"] }],
          risks: [{ text: "Breadth can reverse.", sourceIds: ["market-aapl"] }],
          catalysts: [{ text: "Supplier demand is visible.", sourceIds: ["news-equity-1"] }],
          scenarios: [
            {
              name: "Base",
              description: "Momentum continues if liquidity persists.",
              sourceIds: ["market-aapl"],
            },
          ],
          confidence: "high",
          dataGaps: [],
          predictions: mockPredictions(2),
        }),
      ),
      collectedSources: {
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        marketContext: {
          assetClass: "equity",
          items: [],
          gaps: [{ source: "fred-macro", message: "MARKET_BOT_FRED_API_KEY is not set" }],
        },
        marketContextSources: [],
        sourceGaps: [{ source: "fred-macro", message: "MARKET_BOT_FRED_API_KEY is not set" }],
      },
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    expect(result.report.confidence).toBe("high");
    expect(result.report.dataGaps).toContain("fred-macro: MARKET_BOT_FRED_API_KEY is not set");
  });

  test("caps Evidence Quality at medium when extended evidence is all gaps", async () => {
    const result = await runResearchJob({
      command: { jobType: "ticker", assetClass: "equity", symbol: "AAPL", depth: "brief" },
      config,
      provider: providerReturning(
        JSON.stringify({
          summary: "Ticker evidence has core sources.",
          keyFindings: [{ text: "AAPL moved.", sourceIds: ["market-aapl"] }],
          bullCase: [{ text: "Supplier news supports the ticker.", sourceIds: ["news-equity-1"] }],
          bearCase: [{ text: "Extended evidence is unavailable.", sourceIds: ["market-aapl"] }],
          risks: [
            { text: "Missing macro evidence limits confidence.", sourceIds: ["market-aapl"] },
          ],
          catalysts: [{ text: "Supplier demand is visible.", sourceIds: ["news-equity-1"] }],
          scenarios: [
            {
              name: "Base",
              description: "Momentum continues if liquidity persists.",
              sourceIds: ["market-aapl"],
            },
          ],
          confidence: "high",
          dataGaps: [],
          predictions: mockPredictions(3, "AAPL"),
        }),
      ),
      collectedSources: {
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        extendedSources: [],
        extendedEvidence: {
          instrument: { assetClass: "equity", symbol: "AAPL" },
          items: [],
          gaps: [
            { source: "fred-macro", message: "MARKET_BOT_FRED_API_KEY is not set" },
            {
              source: "tradier-options",
              message: "MARKET_BOT_TRADIER_API_TOKEN is not set",
            },
          ],
        },
        sourceGaps: [
          { source: "fred-macro", message: "MARKET_BOT_FRED_API_KEY is not set" },
          { source: "tradier-options", message: "MARKET_BOT_TRADIER_API_TOKEN is not set" },
        ],
      },
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    expect(result.report.confidence).toBe("medium");
  });

  test("re-prompts synthesis once when predictions fall below minimum, then ships with shortfall gap", async () => {
    let callCount = 0;
    const provider: ModelProvider = {
      name: "mock",
      generate: async () => {
        callCount += 1;
        return {
          content: JSON.stringify({
            summary: "Evidence is sourced.",
            keyFindings: [{ text: "AAPL moved.", sourceIds: ["market-aapl"] }],
            bullCase: [],
            bearCase: [],
            risks: [],
            catalysts: [],
            scenarios: [],
            confidence: "medium",
            dataGaps: [],
            predictions: [],
          }),
          tokenEstimate: 100,
          costEstimateUsd: 0.01,
        };
      },
    };

    const result = await runResearchJob({
      command: { jobType: "daily", assetClass: "equity", depth: "brief" },
      config,
      provider,
      collectedSources: {
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        sourceGaps: [],
      },
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    expect(callCount).toBe(4);
    expect(result.report.predictions).toHaveLength(0);
    expect(result.report.dataGaps.some((gap) => gap.includes("predictionShortfall"))).toBe(true);
  });

  test("logs prediction validation errors to trace when malformed predictions are dropped", async () => {
    const result = await runResearchJob({
      command: { jobType: "daily", assetClass: "equity", depth: "brief" },
      config,
      provider: providerReturning(
        JSON.stringify({
          summary: "Evidence is sourced.",
          keyFindings: [{ text: "AAPL moved.", sourceIds: ["market-aapl"] }],
          bullCase: [],
          bearCase: [],
          risks: [],
          catalysts: [],
          scenarios: [],
          confidence: "medium",
          dataGaps: [],
          predictions: [
            {
              id: "bad-1",
              kind: "invalid-kind",
              claim: "x",
              subject: "SPY",
              measurableAs: "close(SPY, +5) > close(SPY, 0)",
              horizonTradingDays: 5,
              probability: 0.6,
              sourceIds: [],
            },
            {
              id: "bad-2",
              kind: "direction",
              claim: "x",
              subject: "SPY",
              measurableAs: "close(SPY, +5) > close(SPY, 0)",
              horizonTradingDays: 30,
              probability: 0.6,
              sourceIds: [],
            },
            ...mockPredictions(2),
          ],
        }),
      ),
      collectedSources: {
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        sourceGaps: [],
      },
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    expect(result.report.predictions).toHaveLength(2);
    expect(result.trace.predictionErrors).toBeDefined();
    expect(result.trace.predictionErrors?.length).toBe(2);
  });
});
