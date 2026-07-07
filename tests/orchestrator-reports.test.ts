import { describe, expect, test } from "bun:test";
import { runResearchJob } from "../src/research/orchestrator";
import { legacyMarketOverviewCommand } from "./support/commands";
import { collectedSources as collectedSourceBundle } from "./support/fixtures";
import { providerReturning } from "./support/mocks";
import {
  config,
  marketContext,
  marketContextSources,
  marketSnapshots,
  mockPredictions,
  newsSources,
} from "./support/orchestrator-helpers";
import type { ModelProvider } from "../src/model/types";

describe("runResearchJob report assembly and market context", () => {
  test("creates a daily Research View from mocked sources and model output", async () => {
    const result = await runResearchJob({
      command: legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "brief" }),
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
      collectedSources: collectedSourceBundle({
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        sourceGaps: [],
      }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    expect(result.report).toMatchObject({
      jobType: "market-overview",
      assetClass: "equity",
      evidenceQuality: "medium",
      notFinancialAdvice: true,
    });
    expect(result.markdown).toContain("Research-only note");
    expect(result.markdown).not.toContain("Weekly Market Update");
    expect(result.trace.sourceGaps).toEqual(["Macro breadth source unavailable"]);
    expect(result.trace.stages).toEqual([
      "source-collection",
      "spotlight-selection",
      "playbook-selection",
      "specialist-analysis",
      "critique",
      "final-synthesis",
    ]);
    expect(result.stageOutputs).toHaveLength(5);
    expect(result.trace.tokenEstimate).toBe(500);
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
      command: legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "brief" }),
      config,
      provider,
      collectedSources: collectedSourceBundle({
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        marketContext,
        marketContextSources,
        sourceGaps: [],
      }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });
    const finalPrompt = JSON.parse(
      prompts.find((prompt) => JSON.parse(prompt).stage === "final-synthesis") ?? "{}",
    ) as {
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
            keyFindings: [{ text: "SEC evidence is available.", sourceIds: ["extended-sec"] }],
            bullCase: [{ text: "Market data is constructive.", sourceIds: ["market-aapl"] }],
            bearCase: [{ text: "News coverage is narrow.", sourceIds: ["news-equity-1"] }],
            risks: [{ text: "Company filing data can change.", sourceIds: ["extended-sec"] }],
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
      command: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "brief" },
      config,
      provider,
      collectedSources: collectedSourceBundle({
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        extendedSources: [
          {
            id: "extended-sec",
            title: "AAPL SEC filings",
            fetchedAt: "2026-05-19T00:00:00.000Z",
            kind: "extended-evidence",
            assetClass: "equity",
            symbol: "AAPL",
            provider: "sec-edgar",
            identity: {
              providerIds: [{ provider: "sec-edgar", idKind: "cik", value: "0000320193" }],
              aliases: [{ provider: "sec-edgar", idKind: "ticker", value: "AAPL" }],
            },
          },
        ],
        extendedEvidence: {
          instrument: { assetClass: "equity", symbol: "AAPL" },
          items: [
            {
              category: "sec-edgar",
              title: "AAPL SEC filings",
              summary: "Recent SEC filings captured.",
              sourceIds: ["extended-sec"],
              observedAt: "2026-05-19T00:00:00.000Z",
              identity: {
                providerIds: [{ provider: "sec-edgar", idKind: "cik", value: "0000320193" }],
                aliases: [{ provider: "sec-edgar", idKind: "ticker", value: "AAPL" }],
              },
            },
          ],
          gaps: [],
        },
        sourceGaps: [],
      }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });
    const finalPrompt = JSON.parse(
      prompts.find((prompt) => JSON.parse(prompt).stage === "final-synthesis") ?? "{}",
    ) as {
      readonly evidence?: {
        readonly extendedEvidence?: {
          readonly items?: readonly { readonly identity?: unknown }[];
        };
      };
    };

    expect(finalPrompt.evidence?.extendedEvidence).toBeDefined();
    expect(finalPrompt.evidence?.extendedEvidence?.items?.[0]?.identity).toEqual({
      providerIds: [{ provider: "sec-edgar", idKind: "cik", value: "0000320193" }],
      aliases: [{ provider: "sec-edgar", idKind: "ticker", value: "AAPL" }],
    });
    expect(result.report.extendedEvidence).toBeDefined();
    expect(result.markdown).toContain("## Extended Evidence");
    expect(result.markdown).toContain("[extended-sec]");
  });

  test("ignores extended sources for market update source lists", async () => {
    const result = await runResearchJob({
      command: legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "brief" }),
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
      collectedSources: collectedSourceBundle({
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
      }),
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
      command: legacyMarketOverviewCommand("weekly", { assetClass: "equity", depth: "brief" }),
      config,
      provider,
      collectedSources: collectedSourceBundle({
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        sourceGaps: [],
      }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });
    const finalPrompt = JSON.parse(
      prompts.find((prompt) => JSON.parse(prompt).stage === "final-synthesis") ?? "{}",
    ) as {
      readonly depthProfile?: {
        readonly defaultPredictionHorizon?: number;
        readonly targetPredictions?: number;
      };
      readonly requiredShape?: {
        readonly predictions?: readonly { readonly horizonTradingDays?: number }[];
      };
    };

    expect(result.report.jobType).toBe("market-overview");
    expect(result.report.extras?.legacyMarketUpdateAlias).toBe("weekly");
    expect(result.trace.legacyMarketUpdateAlias).toBe("weekly");
    expect(result.markdown).toContain("# equity Market Overview");
    expect(result.report.predictions[0]?.horizonTradingDays).toBe(15);
    expect(result.report.dataGaps).toContain(
      "Market overview mover universe is seeded from Yahoo day_gainers, day_losers, and most_actives — a single-day multi-screener set, not a trailing horizon mover screener",
    );
    expect(finalPrompt.depthProfile?.defaultPredictionHorizon).toBe(15);
    expect(finalPrompt.depthProfile?.targetPredictions).toBe(2);
    expect(finalPrompt.requiredShape?.predictions?.[0]?.horizonTradingDays).toBe(15);
  });

  test("drops a model data gap that restates the deterministic weekly mover gap", async () => {
    const provider: ModelProvider = {
      name: "mock",
      generate: async () => ({
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
          dataGaps: [
            "Market overview mover universe is seeded from Yahoo day_gainers, day_losers, and most_actives, not a trailing horizon mover screener.",
          ],
          predictions: mockPredictions(2),
        }),
        tokenEstimate: 100,
        costEstimateUsd: 0.01,
      }),
    };

    const result = await runResearchJob({
      command: legacyMarketOverviewCommand("weekly", { assetClass: "equity", depth: "brief" }),
      config,
      provider,
      collectedSources: collectedSourceBundle({
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        sourceGaps: [],
      }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    const moverGaps = result.report.dataGaps.filter((gap) =>
      gap.includes("trailing horizon mover screener"),
    );
    expect(moverGaps).toEqual([
      "Market overview mover universe is seeded from Yahoo day_gainers, day_losers, and most_actives — a single-day multi-screener set, not a trailing horizon mover screener",
    ]);
  });

  test("rejects reports with trade-action language", async () => {
    await expect(
      runResearchJob({
        command: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "deep" },
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
        collectedSources: collectedSourceBundle({
          rawSnapshots: [],
          marketSnapshots,
          newsSources,
          sourceGaps: [],
        }),
        now: new Date("2026-05-19T00:00:00.000Z"),
      }),
    ).rejects.toThrow("trade-action language");
  });
});
