import { afterEach, describe, expect, test } from "bun:test";
import { marketContextGap, sourceGap } from "../src/domain/source-gaps";
import { persistResearchJob, runResearchJob } from "../src/research/orchestrator";
import { isRecord } from "../src/sources/guards";
import { legacyMarketOverviewCommand } from "./support/commands";
import { collectedSources as collectedSourceBundle } from "./support/fixtures";
import { providerReturning } from "./support/mocks";
import {
  config,
  createDataDirRegistry,
  marketSnapshots,
  mockPredictions,
  modelReport,
  newsSources,
} from "./support/orchestrator-helpers";
import { access, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelProvider } from "../src/model/types";

const { dataDirs, cleanupDataDirs } = createDataDirRegistry();

afterEach(cleanupDataDirs);

describe("runResearchJob evidence quality and forecast disagreement", () => {
  test("persists configured deep Forecast Disagreement as partial non-fatal evidence", async () => {
    const dataDir = join(tmpdir(), `market-bot-forecast-disagreement-${Date.now()}`);
    dataDirs.push(dataDir);
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        const prompt = JSON.parse(request.messages[1]?.content ?? "{}") as Record<string, unknown>;
        if (prompt.stage === "playbook-selection") {
          return {
            content: JSON.stringify({ selections: [] }),
            tokenEstimate: 10,
            costEstimateUsd: 0.001,
          };
        }
        if (prompt.stage === "forecast-disagreement") {
          if (request.model === "challenger-bad") {
            throw new Error("challenger timeout");
          }
          const report = isRecord(prompt.report) ? prompt.report : {};
          const predictions = Array.isArray(report.predictions) ? report.predictions : [];
          return {
            content: JSON.stringify({
              predictions: predictions.flatMap((prediction) =>
                isRecord(prediction) && typeof prediction.id === "string"
                  ? [{ id: prediction.id, probability: 0.9 }]
                  : [],
              ),
            }),
            tokenEstimate: 25,
            costEstimateUsd: 0.002,
          };
        }
        return {
          content: modelReport("AAPL"),
          tokenEstimate: 100,
          costEstimateUsd: 0.01,
        };
      },
    };

    const result = await persistResearchJob({
      command: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "deep" },
      config: {
        ...config,
        dataDir,
        forecastDisagreementOptions: { challengerModels: ["challenger-ok", "challenger-bad"] },
      },
      provider,
      collectedSources: collectedSourceBundle({
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        sourceGaps: [],
      }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });
    const sidecar = JSON.parse(
      await readFile(join(result.artifacts.normalizedDir, "forecast-disagreement.json"), "utf8"),
    ) as Record<string, unknown>;

    expect(result.trace.stages.filter((stage) => stage === "forecast-disagreement")).toHaveLength(
      2,
    );
    expect(
      result.trace.stageRecords
        ?.filter((record) => record.stage === "forecast-disagreement")
        .every((record) => (record.durationMs ?? 0) > 0),
    ).toBe(true);
    expect(result.trace.forecastDisagreement).toEqual({
      configuredModelCount: 2,
      challengerModelCount: 2,
      participantCount: 3,
      successfulParticipantCount: 2,
      errorCount: 1,
    });
    expect(result.analytics.predictions.forecastDisagreement).toEqual({
      participantCount: 3,
      successfulParticipantCount: 2,
      errorCount: 1,
      highDisagreementCount: 6,
    });
    expect(result.report.dataGaps).toContain(
      "forecastDisagreement: 1 configured challenger model(s) failed; partial uncertainty signal only",
    );
    expect(result.report.extras?.forecastDisagreement).toMatchObject({
      participantCount: 3,
      successfulParticipantCount: 2,
      errorCount: 1,
    });
    expect(sidecar).toMatchObject({
      provider: "mock",
      baselineModel: "synthesis-test",
      challengerModels: ["challenger-ok", "challenger-bad"],
      participantCount: 3,
      successfulParticipantCount: 2,
      errorCount: 1,
    });
    expect(JSON.stringify(sidecar)).toContain("challenger timeout");
    await expect(readFile(join(result.artifacts.runDir, "report.json"), "utf8")).resolves.toContain(
      "forecastDisagreement",
    );
  });

  test("does not persist movers.json for ticker runs", async () => {
    const dataDir = join(tmpdir(), `market-bot-ticker-movers-${Date.now()}`);
    dataDirs.push(dataDir);
    const result = await persistResearchJob({
      command: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "brief" },
      config: { ...config, dataDir },
      provider: providerReturning(
        JSON.stringify({
          summary: "AAPL evidence is mixed.",
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
      collectedSources: collectedSourceBundle({ marketSnapshots, newsSources, sourceGaps: [] }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    await expect(access(join(result.artifacts.normalizedDir, "movers.json"))).rejects.toThrow();
  });

  test("caps Evidence Quality and adds deterministic gaps for sparse sources", async () => {
    const result = await runResearchJob({
      command: legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "brief" }),
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
      collectedSources: collectedSourceBundle({
        rawSnapshots: [],
        marketSnapshots: [],
        newsSources: [],
        sourceGaps: [{ source: "yahoo", message: "source request failed with status 500" }],
      }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    expect(result.report.evidenceQuality).toBe("low");
    expect(result.report.dataGaps).toContain("No usable market data snapshots were collected");
    expect(result.report.dataGaps).toContain("No usable news sources were collected");
    expect(result.report.dataGaps).toContain("yahoo: source request failed with status 500");
    expect(result.trace.predictionCompletion).toBeUndefined();
  });

  test("does not cap Evidence Quality for missing Market Context", async () => {
    const result = await runResearchJob({
      command: legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "brief" }),
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
      collectedSources: collectedSourceBundle({
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        marketContext: {
          assetClass: "equity",
          items: [],
          gaps: [
            marketContextGap(
              sourceGap({ source: "fred-macro", message: "MARKET_BOT_FRED_API_KEY is not set" }),
            ),
          ],
        },
        marketContextSources: [],
        sourceGaps: [
          marketContextGap(
            sourceGap({ source: "fred-macro", message: "MARKET_BOT_FRED_API_KEY is not set" }),
          ),
        ],
      }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    expect(result.report.evidenceQuality).toBe("medium");
    expect(result.report.dataGaps).toContain("fred-macro: MARKET_BOT_FRED_API_KEY is not set");
  });

  test("does not cap Evidence Quality for missing optional news credentials", async () => {
    const result = await runResearchJob({
      command: legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "brief" }),
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
      collectedSources: collectedSourceBundle({
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        sourceGaps: [
          sourceGap({
            source: "marketaux-news",
            message: "missing MARKET_BOT_MARKETAUX_API_TOKEN",
            provider: "marketaux",
            capability: "news",
            cause: "missing-credential",
            evidenceQualityImpact: "no-cap",
          }),
          sourceGap({
            source: "finnhub-news",
            message: "missing MARKET_BOT_FINNHUB_API_TOKEN",
            provider: "finnhub",
            capability: "news",
            cause: "missing-credential",
            evidenceQualityImpact: "no-cap",
          }),
        ],
      }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    expect(result.report.evidenceQuality).toBe("medium");
    expect(result.report.dataGaps).toEqual([
      "marketaux-news: missing MARKET_BOT_MARKETAUX_API_TOKEN",
      "finnhub-news: missing MARKET_BOT_FINNHUB_API_TOKEN",
    ]);
  });

  test("caps Evidence Quality at medium when extended evidence is all gaps", async () => {
    const result = await runResearchJob({
      command: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "brief" },
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
      collectedSources: collectedSourceBundle({
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
      }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    expect(result.report.evidenceQuality).toBe("low");
  });

  test("allows Web Subject Profile evidence to offset one extended evidence gap", async () => {
    const result = await runResearchJob({
      command: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "brief" },
      config,
      provider: providerReturning(
        JSON.stringify({
          summary: "Ticker evidence has core and web profile sources.",
          keyFindings: [{ text: "AAPL moved.", sourceIds: ["market-aapl"] }],
          bullCase: [{ text: "Supplier news supports the ticker.", sourceIds: ["news-equity-1"] }],
          bearCase: [
            { text: "Optional macro evidence is unavailable.", sourceIds: ["market-aapl"] },
          ],
          risks: [{ text: "Macro context is incomplete.", sourceIds: ["market-aapl"] }],
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
      collectedSources: collectedSourceBundle({
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        extendedSources: [],
        extendedEvidence: {
          instrument: { assetClass: "equity", symbol: "AAPL" },
          items: [
            {
              category: "web-subject-profile",
              title: "Web Subject Profile",
              summary: "Cited Web Subject Profile captured for AAPL.",
              sourceIds: ["web-aapl-profile"],
              observedAt: "2026-05-19T00:00:00.000Z",
            },
          ],
          gaps: [
            {
              source: "fred-macro",
              message: "MARKET_BOT_FRED_API_KEY is not set",
              evidenceQualityImpact: "extended-evidence-cap",
            },
          ],
        },
        sourceGaps: [
          {
            source: "fred-macro",
            message: "MARKET_BOT_FRED_API_KEY is not set",
            evidenceQualityImpact: "extended-evidence-cap",
          },
        ],
      }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    expect(result.report.evidenceQuality).toBe("low");
  });
});
