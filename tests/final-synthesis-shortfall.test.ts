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
      knownSourceIds: new Set(["market-aapl"]),
      allowedSubjects: new Set(["AAPL"]),
      priorStages: [],
      maxPredictionReprompts: 0,
      runFinalSynthesis: async () => {
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
