import { expect, test } from "bun:test";
import type { InstrumentCommand } from "../src/cli/args";
import { resolveRunParams } from "../src/config/runs";
import { buildDepthProfileFromParams } from "../src/research/depth-profile";
import { synthesizeReportUntilValid, type StageReprompt } from "../src/research/final-synthesis";
import { collectedSources, marketSnapshot, newsSource, researchReport } from "./support/fixtures";
import { config, mockPredictions } from "./support/orchestrator-helpers";

test.each([
  { jobType: "equity", count: 1, requested: 2, skipCode: undefined },
  { jobType: "equity", count: 2, requested: undefined, skipCode: "floor-met" },
  { jobType: "equity", count: 3, requested: undefined, skipCode: "target-met" },
  { jobType: "crypto", count: 2, requested: 3, skipCode: undefined },
  { jobType: "crypto", count: 5, requested: undefined, skipCode: "target-met" },
] as const)(
  "completion eligibility for $jobType with $count accepted predictions",
  async ({ jobType, count, requested, skipCode }) => {
    const command: InstrumentCommand = {
      jobType,
      assetClass: jobType,
      symbol: "AAPL",
      depth: "deep",
    };
    const runParams = resolveRunParams(command, config);
    const { predictionCompletionFloor: _floor, ...defaultRunParams } = runParams;
    const reprompts: StageReprompt[] = [];
    const result = await synthesizeReportUntilValid({
      runId: "completion-floor-test",
      generatedAt: "2026-05-19T00:00:00.000Z",
      command,
      collectedSources: collectedSources({ marketSnapshots: [marketSnapshot()] }),
      context: {
        runParams: jobType === "crypto" ? defaultRunParams : runParams,
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
      runFinalSynthesis: async (_priorStages, reprompt) => {
        if (reprompt?.predictionCompletion !== undefined) {
          reprompts.push(reprompt);
        }
        return {
          stage: "final-synthesis",
          tokenEstimate: 0,
          content: JSON.stringify(
            reprompt?.predictionCompletion === undefined
              ? { ...researchReport(), predictions: mockPredictions(count, "AAPL") }
              : { predictions: [] },
          ),
        };
      },
    });
    expect(result.reportValidationErrors).toEqual([]);
    expect(result.predictionCompletionSkipCode).toBe(skipCode);
    expect(reprompts).toHaveLength(requested === undefined ? 0 : 1);
    expect(reprompts[0]?.predictionCompletion?.requestedCount).toBe(requested);
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
