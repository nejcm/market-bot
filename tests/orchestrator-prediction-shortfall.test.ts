import { describe, expect, test } from "bun:test";
import { runResearchJob } from "../src/research/orchestrator";
import { legacyMarketOverviewCommand } from "./support/commands";
import {
  collectedSources as collectedSourceBundle,
  verifiedMarketSnapshot,
} from "./support/fixtures";
import {
  config,
  emptySelectionStageReport,
  marketSnapshots,
  newsSources,
  priorStageNames,
} from "./support/orchestrator-helpers";
import type { ModelProvider } from "../src/model/types";

describe("runResearchJob prediction shortfall and redundancy", () => {
  test("makes one final-synthesis call below target and keeps the shortfall", async () => {
    const prompts: Record<string, unknown>[] = [];
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        const prompt = JSON.parse(request.messages[1]?.content ?? "{}") as Record<string, unknown>;
        prompts.push(prompt);
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
            dataGaps: ["A fifth prediction was not emitted because evidence was weak."],
            predictions: [],
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
        sourceGaps: [],
        verifiedMarketSnapshot: verifiedMarketSnapshot(),
      }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    const finalPrompts = prompts.filter((prompt) => prompt.stage === "final-synthesis");
    expect(finalPrompts).toHaveLength(1);
    expect(result.trace.predictionRetryErrors ?? []).toEqual([]);
    expect(result.report.predictions).toHaveLength(0);
    expect(result.report.predictionShortfall).toEqual({
      emittedCount: 0,
      targetCount: 2,
      missingCount: 2,
    });
    expect(result.report.dataGaps.filter((gap) => gap.includes("prediction"))).toEqual([]);
  });

  test("records redundancy trims without reprompting when post-trim count meets target", async () => {
    const prompts: Record<string, unknown>[] = [];
    let finalCalls = 0;
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        const prompt = JSON.parse(request.messages[1]?.content ?? "{}") as Record<string, unknown>;
        prompts.push(prompt);

        if (prompt.stage !== "final-synthesis") {
          return {
            content: emptySelectionStageReport(prompt.stage),
            tokenEstimate: 100,
            costEstimateUsd: 0.01,
          };
        }

        finalCalls += 1;
        if (finalCalls === 1) {
          // Emit 4 predictions; one is a redundant adjacent → trimmed to 3.
          // Deep market-overview-equity target is 3, so 3 >= 3 — no shortfall.
          return {
            content: JSON.stringify({
              summary: "Evidence is sourced.",
              keyFindings: [{ text: "SPY moved.", sourceIds: ["market-aapl"] }],
              bullCase: [],
              bearCase: [],
              risks: [],
              catalysts: [],
              scenarios: [],
              confidence: "medium",
              dataGaps: [],
              predictions: [
                {
                  id: "pred-1",
                  claim: "SPY closes higher over 5 trading days.",
                  kind: "direction",
                  subject: "SPY",
                  measurableAs: "close(SPY, +5) > close(SPY, 0)",
                  horizonTradingDays: 5,
                  probability: 0.6,
                  sourceIds: ["market-aapl"],
                },
                {
                  id: "pred-adjacent",
                  claim: "SPY closes higher over 6 trading days.",
                  kind: "direction",
                  subject: "SPY",
                  measurableAs: "close(SPY, +6) > close(SPY, 0)",
                  horizonTradingDays: 6,
                  probability: 0.6,
                  sourceIds: ["market-aapl"],
                },
                {
                  id: "pred-range",
                  claim: "SPY breaks out of range.",
                  kind: "range",
                  subject: "SPY",
                  measurableAs: "close(SPY, +10) outside [520, 560]",
                  horizonTradingDays: 10,
                  probability: 0.65,
                  sourceIds: ["market-aapl"],
                },
                {
                  id: "pred-vol",
                  claim: "VIX spikes above 20.",
                  kind: "volatility",
                  subject: "^VIX",
                  measurableAs: "max(close(^VIX), 0..+10) > 20",
                  horizonTradingDays: 10,
                  probability: 0.55,
                  sourceIds: ["market-aapl"],
                },
              ],
            }),
            tokenEstimate: 100,
            costEstimateUsd: 0.01,
          };
        }

        throw new Error("redundancy trims must not trigger another final-synthesis call");
      },
    };

    const result = await runResearchJob({
      command: legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "deep" }),
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

    const finalPrompts = prompts.filter((prompt) => prompt.stage === "final-synthesis");
    const redundancyReason =
      "Prediction pred-adjacent: redundant direction forecast for SPY at 6 trading days (within 2 trading days of accepted 5d)";

    expect(finalPrompts).toHaveLength(1);
    expect(finalPrompts[0]?.predictionRepromptErrors).toBeUndefined();
    expect(result.trace.predictionRetryErrors ?? []).toEqual([]);
    expect(result.trace.predictionTrimWarnings).toContain(redundancyReason);
    expect(result.trace.predictionReplacementAttempted).toBeUndefined();
    expect(result.report.predictions).toHaveLength(3);
    expect(result.report.predictions.map((p) => p.id)).toEqual([
      "pred-1",
      "pred-range",
      "pred-vol",
    ]);
    expect(result.report.predictionShortfall).toBeUndefined();
    expect(priorStageNames(finalPrompts[0] ?? {})).toEqual([
      "specialist-analysis",
      "regime-context-analysis",
      "mover-theme-analysis",
      "critique",
    ]);
  });

  test("ships non-redundant forecasts when adjacent direction forecasts are trimmed", async () => {
    const prompts: Record<string, unknown>[] = [];
    let finalCalls = 0;
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        const prompt = JSON.parse(request.messages[1]?.content ?? "{}") as Record<string, unknown>;
        prompts.push(prompt);

        if (prompt.stage !== "final-synthesis") {
          return {
            content: emptySelectionStageReport(prompt.stage),
            tokenEstimate: 100,
            costEstimateUsd: 0.01,
          };
        }

        finalCalls += 1;
        if (finalCalls === 1) {
          return {
            content: JSON.stringify({
              summary: "Evidence is sourced.",
              keyFindings: [{ text: "SPY moved.", sourceIds: ["market-aapl"] }],
              bullCase: [],
              bearCase: [],
              risks: [],
              catalysts: [],
              scenarios: [],
              confidence: "medium",
              dataGaps: [],
              predictions: [
                {
                  id: "pred-1",
                  claim: "SPY closes higher over 5 trading days.",
                  kind: "direction",
                  subject: "SPY",
                  measurableAs: "close(SPY, +5) > close(SPY, 0)",
                  horizonTradingDays: 5,
                  probability: 0.6,
                  sourceIds: ["market-aapl"],
                },
                {
                  id: "pred-adjacent",
                  claim: "SPY closes higher over 6 trading days.",
                  kind: "direction",
                  subject: "SPY",
                  measurableAs: "close(SPY, +6) > close(SPY, 0)",
                  horizonTradingDays: 6,
                  probability: 0.6,
                  sourceIds: ["market-aapl"],
                },
                {
                  id: "pred-distinct",
                  claim: "SPY closes higher over 8 trading days.",
                  kind: "direction",
                  subject: "SPY",
                  measurableAs: "close(SPY, +8) > close(SPY, 0)",
                  horizonTradingDays: 8,
                  probability: 0.6,
                  sourceIds: ["market-aapl"],
                },
              ],
            }),
            tokenEstimate: 100,
            costEstimateUsd: 0.01,
          };
        }

        throw new Error("redundancy trims must not trigger another final-synthesis call");
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
        sourceGaps: [],
      }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });
    const finalPrompts = prompts.filter((prompt) => prompt.stage === "final-synthesis");
    const redundancyReason =
      "Prediction pred-adjacent: redundant direction forecast for SPY at 6 trading days (within 2 trading days of accepted 5d)";

    expect(finalPrompts).toHaveLength(1);
    expect(finalPrompts[0]?.predictionRepromptErrors).toBeUndefined();
    expect(result.trace.predictionRetryErrors ?? []).toEqual([]);
    expect(result.trace.predictionTrimWarnings).toContain(redundancyReason);
    expect(result.report.predictions.map((prediction) => prediction.id)).toEqual([
      "pred-1",
      "pred-distinct",
    ]);
    expect(result.report.predictionShortfall).toBeUndefined();
  });

  test("discloses a post-trim shortfall without another final-synthesis call", async () => {
    const prompts: Record<string, unknown>[] = [];
    let finalCalls = 0;
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        const prompt = JSON.parse(request.messages[1]?.content ?? "{}") as Record<string, unknown>;
        prompts.push(prompt);

        if (prompt.stage !== "final-synthesis") {
          return {
            content: emptySelectionStageReport(prompt.stage),
            tokenEstimate: 100,
            costEstimateUsd: 0.01,
          };
        }

        finalCalls += 1;
        if (finalCalls === 1) {
          // Emit 2 predictions; one is redundant-adjacent → trimmed to 1.
          // Deep market-overview-equity target is 3, so 1 < 3 → shortfall of 2.
          return {
            content: JSON.stringify({
              summary: "Evidence is sourced.",
              keyFindings: [{ text: "SPY moved.", sourceIds: ["market-aapl"] }],
              bullCase: [],
              bearCase: [],
              risks: [],
              catalysts: [],
              scenarios: [],
              confidence: "medium",
              dataGaps: [],
              predictions: [
                {
                  id: "pred-1",
                  claim: "SPY closes higher over 5 trading days.",
                  kind: "direction",
                  subject: "SPY",
                  measurableAs: "close(SPY, +5) > close(SPY, 0)",
                  horizonTradingDays: 5,
                  probability: 0.6,
                  sourceIds: ["market-aapl"],
                },
                {
                  id: "pred-adjacent",
                  claim: "SPY closes higher over 6 trading days.",
                  kind: "direction",
                  subject: "SPY",
                  measurableAs: "close(SPY, +6) > close(SPY, 0)",
                  horizonTradingDays: 6,
                  probability: 0.6,
                  sourceIds: ["market-aapl"],
                },
              ],
            }),
            tokenEstimate: 100,
            costEstimateUsd: 0.01,
          };
        }

        throw new Error("a valid report must not trigger another final-synthesis call");
      },
    };

    const result = await runResearchJob({
      command: legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "deep" }),
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

    const finalPrompts = prompts.filter((prompt) => prompt.stage === "final-synthesis");
    const redundancyReason =
      "Prediction pred-adjacent: redundant direction forecast for SPY at 6 trading days (within 2 trading days of accepted 5d)";

    expect(finalPrompts).toHaveLength(1);
    expect(finalPrompts[0]?.predictionRepromptErrors).toBeUndefined();
    expect(result.report.predictions.map((prediction) => prediction.id)).toEqual(["pred-1"]);
    expect(result.trace.predictionRetryErrors ?? []).toEqual([]);
    expect(result.trace.predictionTrimWarnings).toContainEqual(redundancyReason);
    expect(result.report.predictionShortfall).toEqual({
      emittedCount: 1,
      targetCount: 3,
      missingCount: 2,
    });
  });
});
