import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AppConfig } from "../src/config";
import type { MarketSnapshot, Source } from "../src/domain/types";
import type { ModelProvider } from "../src/model/types";
import { persistResearchJob, runResearchJob } from "../src/research/orchestrator";

const config: AppConfig = {
  provider: "openai",
  quickModel: "quick-test",
  synthesisModel: "synthesis-test",
  dataDir: "data/runs",
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
    volume: 80000000,
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

describe("runResearchJob", () => {
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
            bullCase: [{ text: "News supports the sourced momentum.", sourceIds: ["news-equity-1"] }],
            bearCase: [{ text: "Single-source breadth limits confidence.", sourceIds: ["market-aapl"] }],
            risks: [{ text: "Macro context is incomplete.", sourceIds: ["market-aapl"] }],
            catalysts: [{ text: "Supplier news is the visible catalyst.", sourceIds: ["news-equity-1"] }],
            scenarios: [{ name: "Base", description: "Momentum persists if liquidity remains.", sourceIds: ["market-aapl"] }],
            confidence: "medium",
            dataGaps: [],
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
    };

    expect(result.trace.stages).toEqual(["source-collection", "specialist-analysis", "critique", "final-synthesis"]);
    expect(result.report.extras?.depth).toBe("deep");
    expect(finalPrompt.depthProfile).toMatchObject({
      depth: "deep",
      analystStyle: "fuller analyst-style",
      minimumKeyFindings: 5,
      minimumScenarios: 3,
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
          bearCase: [{ text: "Single-name evidence may not represent the whole market.", sourceIds: ["market-aapl"] }],
          risks: [{ text: "Macro data is missing.", sourceIds: ["market-aapl"] }],
          catalysts: [{ text: "Supplier demand update is the main catalyst.", sourceIds: ["news-equity-1"] }],
          scenarios: [{ name: "Base", description: "Momentum continues if liquidity persists.", sourceIds: ["market-aapl"] }],
          confidence: "medium",
          dataGaps: ["Macro breadth source unavailable"],
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
    expect(result.trace.sourceGaps).toEqual(["Macro breadth source unavailable"]);
    expect(result.trace.stages).toEqual(["source-collection", "specialist-analysis", "critique", "final-synthesis"]);
    expect(result.stageOutputs).toHaveLength(3);
    expect(result.trace.tokenEstimate).toBe(300);
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
        rawSnapshots: [{ id: "raw-1", adapter: "mock", fetchedAt: "2026-05-19T00:00:00.000Z", payload: { ok: true } }],
        marketSnapshots,
        newsSources,
        sourceGaps: [],
      },
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    await expect(readFile(join(result.artifacts.rawDir, "snapshots.json"), "utf8")).resolves.toContain("raw-1");
    await expect(readFile(join(result.artifacts.normalizedDir, "market-snapshots.json"), "utf8")).resolves.toContain("market-aapl");
    await expect(readFile(join(result.artifacts.runDir, "report.json"), "utf8")).resolves.toContain("Equity market breadth");
    await expect(readFile(join(result.artifacts.runDir, "report.md"), "utf8")).resolves.toContain("Research-only note");
    await expect(readFile(join(result.artifacts.runDir, "trace.json"), "utf8")).resolves.toContain("quick-test");
    await expect(readFile(join(result.artifacts.runDir, "stages.json"), "utf8")).resolves.toContain("specialist-analysis");
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
});
