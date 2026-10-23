import { expect, test } from "bun:test";
import type { InstrumentCommand } from "../src/cli/args";
import { resolveRunParams } from "../src/config/runs";
import { buildDepthProfileFromParams } from "../src/research/depth-profile";
import { synthesizeReportUntilValid } from "../src/research/final-synthesis";
import { collectedSources, marketSnapshot, newsSource, researchReport } from "./support/fixtures";
import { config, mockPredictions } from "./support/orchestrator-helpers";

test.each([
  { jobType: "equity", count: 0 },
  { jobType: "equity", count: 1 },
  { jobType: "equity", count: 3 },
  { jobType: "crypto", count: 2 },
  { jobType: "crypto", count: 5 },
] as const)(
  "one final-synthesis call for $jobType with $count valid predictions",
  async ({ jobType, count }) => {
    const command: InstrumentCommand = {
      jobType,
      assetClass: jobType,
      symbol: "AAPL",
      depth: "deep",
    };
    const runParams = resolveRunParams(command, config);
    let calls = 0;
    const result = await synthesizeReportUntilValid({
      runId: "prediction-shortfall-test",
      generatedAt: "2026-05-19T00:00:00.000Z",
      command,
      collectedSources: collectedSources({ marketSnapshots: [marketSnapshot()] }),
      context: {
        runParams,
        depthProfile: buildDepthProfileFromParams(command, runParams),
        marketRegime: {
          assetClass: jobType,
          label: "mixed",
          proxyCount: 1,
          drivers: [],
          sourceIds: [],
        },
        calibrationContext: undefined,
        evidenceQualityAssessment: {
          version: 1,
          rubricVersion: 3,
          label: "medium",
          checks: [],
          limitingReasons: [],
          advisoryReasons: [],
        },
      },
      sources: [newsSource({ id: "market-aapl", kind: "market-data" })],
      knownSourceIds: new Set(["market-aapl", "price-history-AAPL", "price-history-SPY"]),
      allowedSubjects: new Set(["AAPL"]),
      priorStages: [],
      maxPredictionReprompts: 0,
      runFinalSynthesis: async (_prior, reprompt) => {
        expect(reprompt?.allowedSourceIds).toEqual([
          "market-aapl",
          "price-history-AAPL",
          "price-history-SPY",
        ]);
        calls += 1;
        return {
          stage: "final-synthesis",
          tokenEstimate: 0,
          content: JSON.stringify({
            ...researchReport(),
            predictions: mockPredictions(count, "AAPL"),
          }),
        };
      },
    });
    expect(result.reportValidationErrors).toEqual([]);
    expect(calls).toBe(1);
    expect(result.stageOutputs).toHaveLength(1);
    expect(result.report.predictions).toHaveLength(count);
    expect(result.report.predictionShortfall).toEqual(
      count < runParams.targetPredictions
        ? {
            emittedCount: count,
            targetCount: runParams.targetPredictions,
            missingCount: runParams.targetPredictions - count,
          }
        : undefined,
    );
  },
);

test("a prediction repair that omits eventGrid keeps the earlier valid grid probability", async () => {
  const command: InstrumentCommand = {
    jobType: "equity",
    assetClass: "equity",
    symbol: "AAPL",
    depth: "deep",
  };
  const runParams = resolveRunParams(command, config);
  const responses = [
    {
      predictions: [...mockPredictions(1, "AAPL"), { id: "bad", measurableAs: "nonsense" }],
      eventGrid: [{ id: "grid-relative-5", probability: 0.45 }],
    },
    { predictions: mockPredictions(1, "AAPL") },
  ];
  const result = await synthesizeReportUntilValid({
    runId: "event-grid-carry-test",
    generatedAt: "2026-05-19T00:00:00.000Z",
    command,
    collectedSources: collectedSources({ marketSnapshots: [marketSnapshot()] }),
    context: {
      runParams,
      depthProfile: buildDepthProfileFromParams(command, runParams),
      marketRegime: {
        assetClass: "equity",
        label: "mixed",
        proxyCount: 1,
        drivers: [],
        sourceIds: [],
      },
      calibrationContext: undefined,
      evidenceQualityAssessment: {
        version: 1,
        rubricVersion: 3,
        label: "medium",
        checks: [],
        limitingReasons: [],
        advisoryReasons: [],
      },
    },
    sources: ["market-aapl", "price-history-AAPL", "price-history-SPY"].map((id) =>
      newsSource({ id, kind: "market-data" }),
    ),
    knownSourceIds: new Set(["market-aapl", "price-history-AAPL", "price-history-SPY"]),
    allowedSubjects: new Set(["AAPL"]),
    priorStages: [],
    maxPredictionReprompts: 1,
    runFinalSynthesis: async () => ({
      stage: "final-synthesis",
      tokenEstimate: 0,
      content: JSON.stringify({ ...researchReport(), ...responses.shift() }),
    }),
  });
  expect(responses).toHaveLength(0);
  expect(
    result.report.predictions
      .filter(({ origin }) => origin === "grid")
      .map(({ id, probability }) => [id, probability]),
  ).toEqual([["grid-relative-5", 0.45]]);
});

test("a prediction restating a grid event is folded and excluded from the shortfall count", async () => {
  const command: InstrumentCommand = {
    jobType: "equity",
    assetClass: "equity",
    symbol: "AAPL",
    depth: "deep",
  };
  const runParams = resolveRunParams(command, config);
  const restatement = {
    id: "pred-2",
    kind: "relative",
    subject: "AAPL:SPY",
    measurableAs: "close(AAPL, +5) / close(AAPL, 0) > close(SPY, +5) / close(SPY, 0)",
    horizonTradingDays: 5,
    probability: 0.3,
    sourceIds: ["market-aapl"],
  };
  const result = await synthesizeReportUntilValid({
    runId: "event-grid-fold-test",
    generatedAt: "2026-05-19T00:00:00.000Z",
    command,
    collectedSources: collectedSources({ marketSnapshots: [marketSnapshot()] }),
    context: {
      runParams,
      depthProfile: buildDepthProfileFromParams(command, runParams),
      marketRegime: {
        assetClass: "equity",
        label: "mixed",
        proxyCount: 1,
        drivers: [],
        sourceIds: [],
      },
      calibrationContext: undefined,
      evidenceQualityAssessment: {
        version: 1,
        rubricVersion: 3,
        label: "medium",
        checks: [],
        limitingReasons: [],
        advisoryReasons: [],
      },
    },
    sources: ["market-aapl", "price-history-AAPL", "price-history-SPY"].map((id) =>
      newsSource({ id, kind: "market-data" }),
    ),
    knownSourceIds: new Set(["market-aapl", "price-history-AAPL", "price-history-SPY"]),
    allowedSubjects: new Set(["AAPL"]),
    priorStages: [],
    maxPredictionReprompts: 0,
    runFinalSynthesis: async () => ({
      stage: "final-synthesis",
      tokenEstimate: 0,
      content: JSON.stringify({
        ...researchReport(),
        predictions: [...mockPredictions(1, "AAPL"), restatement],
      }),
    }),
  });
  expect(
    result.report.predictions.map(({ id, origin, probability }) => [id, origin, probability]),
  ).toEqual([
    ["pred-1", "model", 0.65],
    ["grid-relative-5", "grid", 0.3],
  ]);
  expect(result.report.predictionShortfall).toEqual({
    emittedCount: 1,
    targetCount: runParams.targetPredictions,
    missingCount: runParams.targetPredictions - 1,
  });
  expect(result.report.dataGaps.join("\n")).not.toContain("not issued separately");
});
