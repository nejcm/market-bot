import { describe, expect, test } from "bun:test";
import { runResearchJob } from "../src/research/orchestrator";
import { legacyMarketOverviewCommand } from "./support/commands";
import { collectedSources as collectedSourceBundle } from "./support/fixtures";
import {
  config,
  emptySelectionStageReport,
  marketSnapshots,
  mockPredictions,
  newsSources,
  priorStageNames,
} from "./support/orchestrator-helpers";
import type { ModelProvider } from "../src/model/types";

describe("runResearchJob completion and redundancy", () => {
  test("attempts completion once and keeps the shortfall when no candidate is returned", async () => {
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
      }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    const finalPrompts = prompts.filter((prompt) => prompt.stage === "final-synthesis");
    expect(finalPrompts).toHaveLength(2);
    expect(finalPrompts[1]?.predictionCompletion).toMatchObject({
      requestedCount: 2,
      existingPredictions: [],
    });
    expect(result.trace.predictionRetryErrors ?? []).toEqual([]);
    expect(result.trace.predictionCompletion).toMatchObject({
      initialCount: 0,
      targetCount: 2,
      acceptedPredictionIds: [],
      outcome: "no-eligible-candidates",
    });
    expect(result.report.predictions).toHaveLength(0);
    expect(result.report.dataGaps.filter((gap) => gap.includes("prediction"))).toEqual([
      "predictionShortfall: emitted 0 of 2 target predictions; evidence did not support more",
    ]);
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
          // Deep market-overview-equity target is 3, so 3 >= 3 — no completion pass.
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

        throw new Error("at-target redundancy trims must not trigger completion");
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
    expect(result.report.dataGaps.some((gap) => gap.includes("predictionShortfall"))).toBe(false);
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

        throw new Error("at-target redundancy trims must not trigger completion");
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
    expect(result.report.dataGaps.some((gap) => gap.includes("predictionShortfall"))).toBe(false);
  });

  test("fires exactly one completion pass when redundant trim drops below target", async () => {
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
          // Deep market-overview-equity target is 3, so 1 < 3 → replacement fires.
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

        if (finalCalls === 2) {
          // Completion response includes the existing prediction plus two additions.
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
              predictions: mockPredictions(3),
            }),
            tokenEstimate: 100,
            costEstimateUsd: 0.01,
          };
        }

        throw new Error("completion pass must fire at most once");
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

    expect(finalPrompts).toHaveLength(2);
    expect(finalPrompts[0]?.predictionRepromptErrors).toBeUndefined();
    expect(finalPrompts[1]?.predictionRepromptErrors).toBeUndefined();
    expect(finalPrompts[1]?.predictionCompletion).toMatchObject({
      requestedCount: 2,
      existingPredictions: [{ id: "pred-1" }],
    });
    expect(result.report.predictions).toHaveLength(3);
    expect(result.trace.predictionRetryErrors ?? []).toEqual([]);
    expect(result.trace.predictionTrimWarnings).toContainEqual(redundancyReason);
    expect(result.trace.predictionCompletion).toMatchObject({
      initialCount: 1,
      targetCount: 3,
      acceptedPredictionIds: ["pred-2", "pred-3"],
      rejectedCandidateCount: 1,
      outcome: "improved",
    });
    expect(result.report.dataGaps.some((gap) => gap.includes("predictionShortfall"))).toBe(false);
  });

  test("accepts partial completion without a second pass", async () => {
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
          // 2 predictions, 1 redundant → 1 after trim < 3 target → replacement fires.
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

        if (finalCalls === 2) {
          // One duplicate and one addition leave the report below target.
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
              predictions: mockPredictions(2),
            }),
            tokenEstimate: 100,
            costEstimateUsd: 0.01,
          };
        }

        throw new Error("residual shortfall must not trigger a second completion pass");
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

    expect(finalPrompts).toHaveLength(2);
    expect(result.trace.predictionCompletion).toMatchObject({
      acceptedPredictionIds: ["pred-2"],
      outcome: "improved",
    });
    expect(result.report.predictions).toHaveLength(2);
    // Shortfall gap present because 2 < 3 target.
    expect(result.report.dataGaps.some((gap) => gap.includes("predictionShortfall"))).toBe(true);
  });

  test("attempts completion for a clean shortfall without replacing accepted predictions", async () => {
    const prompts: Record<string, unknown>[] = [];
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

        // Emit 1 prediction — below deep target 3 but no redundancy.
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
            predictions: mockPredictions(1),
          }),
          tokenEstimate: 100,
          costEstimateUsd: 0.01,
        };
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

    expect(finalPrompts).toHaveLength(2);
    expect(result.trace.predictionCompletion).toMatchObject({
      acceptedPredictionIds: [],
      outcome: "no-eligible-candidates",
    });
    expect(result.report.predictions).toHaveLength(1);
    expect(result.report.dataGaps.some((gap) => gap.includes("predictionShortfall"))).toBe(true);
  });

  test("merges only informative valid completion candidates and preserves the base report", async () => {
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
              summary: "Base report remains authoritative.",
              keyFindings: [{ text: "SPY evidence is sourced.", sourceIds: ["market-aapl"] }],
              bullCase: [],
              bearCase: [],
              risks: [],
              catalysts: [],
              scenarios: [],
              dataGaps: [],
              predictions: [mockPredictions(1)[0]],
            }),
            tokenEstimate: 100,
            costEstimateUsd: 0.01,
          };
        }
        return {
          content: JSON.stringify({
            summary: "This completion prose must be ignored.",
            predictions: [
              mockPredictions(1)[0],
              {
                ...(mockPredictions(2)[1] as Record<string, unknown>),
                id: "near-low",
                probability: 0.45,
              },
              {
                ...(mockPredictions(3)[2] as Record<string, unknown>),
                id: "near-high",
                probability: 0.55,
              },
              {
                ...(mockPredictions(2, "AAPL")[1] as Record<string, unknown>),
                id: "off-subject",
              },
              {
                ...(mockPredictions(4)[3] as Record<string, unknown>),
                id: "unknown-source",
                sourceIds: ["missing-source"],
              },
              {
                id: "shorter-collision",
                kind: "direction",
                subject: "SPY",
                measurableAs: "close(SPY, +4) > close(SPY, 0)",
                horizonTradingDays: 4,
                probability: 0.65,
                sourceIds: ["market-aapl"],
              },
              {
                id: "valid-range",
                kind: "range",
                subject: "SPY",
                measurableAs: "close(SPY, +10) outside [450, 550]",
                horizonTradingDays: 10,
                probability: 0.65,
                sourceIds: ["market-aapl"],
              },
            ],
          }),
          tokenEstimate: 100,
          costEstimateUsd: 0.01,
        };
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

    const [, completionPrompt] = prompts.filter((prompt) => prompt.stage === "final-synthesis");
    expect(Object.keys((completionPrompt?.requiredShape ?? {}) as object)).toEqual(["predictions"]);
    // The completion pass records completion steering, not the primary prediction instruction.
    const completionOutput = result.stageOutputs.findLast(
      (output) => output.stage === "final-synthesis",
    );
    expect(completionOutput?.steering).toContain(
      "Return a JSON object containing only a predictions array with up to",
    );
    expect(result.report.summary).toBe("Base report remains authoritative.");
    expect(result.report.predictions.map((prediction) => prediction.id)).toEqual([
      "pred-1",
      "valid-range",
    ]);
    expect(result.trace.predictionCompletion).toMatchObject({
      acceptedPredictionIds: ["valid-range"],
      rejectedCandidateCount: 6,
      outcome: "improved",
    });
    expect(result.trace.predictionCompletion?.rejectionReasons.join(" ")).toContain(
      "near-base-rate",
    );
    expect(result.trace.predictionCompletion?.rejectionReasons.join(" ")).toContain(
      "unknown sourceId",
    );
  });

  test("keeps the accepted report when completion fails", async () => {
    let finalCalls = 0;
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        const prompt = JSON.parse(request.messages[1]?.content ?? "{}") as Record<string, unknown>;
        if (prompt.stage !== "final-synthesis") {
          return {
            content: emptySelectionStageReport(prompt.stage),
            tokenEstimate: 100,
            costEstimateUsd: 0.01,
          };
        }
        finalCalls += 1;
        if (finalCalls === 2) {
          throw new Error("completion unavailable");
        }
        return {
          content: JSON.stringify({
            summary: "Base report remains available.",
            keyFindings: [{ text: "SPY evidence is sourced.", sourceIds: ["market-aapl"] }],
            bullCase: [],
            bearCase: [],
            risks: [],
            catalysts: [],
            scenarios: [],
            dataGaps: [],
            predictions: [mockPredictions(1)[0]],
          }),
          tokenEstimate: 100,
          costEstimateUsd: 0.01,
        };
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

    expect(result.report.summary).toBe("Base report remains available.");
    expect(result.report.predictions.map((prediction) => prediction.id)).toEqual(["pred-1"]);
    expect(result.trace.predictionCompletion).toMatchObject({
      acceptedPredictionIds: [],
      outcome: "failed",
      failureReason: "completion unavailable",
    });
  });

  test("keeps the accepted report when completion returns malformed JSON", async () => {
    let finalCalls = 0;
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        const prompt = JSON.parse(request.messages[1]?.content ?? "{}") as Record<string, unknown>;
        if (prompt.stage !== "final-synthesis") {
          return {
            content: emptySelectionStageReport(prompt.stage),
            tokenEstimate: 100,
            costEstimateUsd: 0.01,
          };
        }
        finalCalls += 1;
        return {
          content:
            finalCalls === 2
              ? "{not-json"
              : JSON.stringify({
                  summary: "Base report remains available.",
                  keyFindings: [{ text: "SPY evidence is sourced.", sourceIds: ["market-aapl"] }],
                  bullCase: [],
                  bearCase: [],
                  risks: [],
                  catalysts: [],
                  scenarios: [],
                  dataGaps: [],
                  predictions: [mockPredictions(1)[0]],
                }),
          tokenEstimate: 100,
          costEstimateUsd: 0.01,
        };
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

    expect(result.report.predictions.map((prediction) => prediction.id)).toEqual(["pred-1"]);
    expect(result.trace.predictionCompletion?.outcome).toBe("failed");
    expect(result.trace.predictionCompletion?.failureReason).toContain("JSON");
  });
});
