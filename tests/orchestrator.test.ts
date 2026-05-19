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
      },
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    await expect(readFile(join(result.artifacts.rawDir, "snapshots.json"), "utf8")).resolves.toContain("raw-1");
    await expect(readFile(join(result.artifacts.normalizedDir, "market-snapshots.json"), "utf8")).resolves.toContain("market-aapl");
    await expect(readFile(join(result.artifacts.runDir, "report.json"), "utf8")).resolves.toContain("Equity market breadth");
    await expect(readFile(join(result.artifacts.runDir, "report.md"), "utf8")).resolves.toContain("Research-only note");
    await expect(readFile(join(result.artifacts.runDir, "trace.json"), "utf8")).resolves.toContain("quick-test");
  });
});
