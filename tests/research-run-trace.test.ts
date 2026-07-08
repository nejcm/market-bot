import { describe, expect, test } from "bun:test";
import type { AppConfig } from "../src/config";
import { buildRunTrace } from "../src/research/run-trace";
import { assessEvidenceQuality } from "../src/research/evidence-quality";
import { assessSourcePlan, buildSourcePlan } from "../src/research/source-plan";
import { collectedSources, researchReport } from "./support/fixtures";

function configFor(): AppConfig {
  return {
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
    evidenceRequestOptions: { maxRounds: 0, maxToolCalls: 0, sourceBudget: 0 },
    webGatherOptions: { maxRounds: 0, maxToolCalls: 0, sourceBudget: 0 },
    webGatherDisabled: false,
    webProfileReuseDaysBySubjectKind: { company: 30, "crypto-asset": 7, theme: 7 },
    alphaSearchOptions: {
      apeWisdomFilter: "all-stocks",
      apeWisdomBriefPageLimit: 5,
      apeWisdomDeepPageLimit: 10,
      validationCandidateLimit: 25,
      leadLimit: 15,
      topCandidateLimit: 15,
      secDiscoveryLimit: 25,
      secFormTypes: ["S-1", "F-1", "8-K", "6-K"],
      minPrice: 0.5,
      minVolume: 100_000,
      minMarketCap: 50_000_000,
      maxMarketCap: 10_000_000_000,
    },
  };
}

describe("run trace builder", () => {
  test("builds trace fields from run inputs and stage records", () => {
    const generatedAt = "2026-05-19T00:00:00.000Z";
    const command = {
      jobType: "market-overview",
      assetClass: "equity",
      depth: "deep",
      horizonTradingDays: 5,
    } as const;
    const sources = collectedSources();
    const sourcePlanning = assessSourcePlan(
      buildSourcePlan(command, generatedAt),
      sources,
      generatedAt,
    );
    const trace = buildRunTrace({
      jobInput: { command, config: configFor(), provider: { name: "mock" } },
      runId: "run-1",
      generatedAt,
      completedAt: "2026-05-19T00:00:01.000Z",
      runParams: {
        quickModel: "quick-test",
        synthesisModel: "synthesis-test",
        modelParams: undefined,
        minimumKeyFindings: 5,
        minimumScenarios: 3,
        targetPredictions: 6,
        defaultPredictionHorizon: 5,
        predictionSubjects: ["SPY"],
        focus: [],
        analystStyle: "fuller analyst-style",
        targetKindMix: { favored: ["direction"] },
      },
      codeVersion: { dirty: false },
      evidenceQualityAssessment: assessEvidenceQuality(sourcePlanning, generatedAt),
      report: researchReport({
        jobType: "market-overview",
        assetClass: "equity",
        dataGaps: ["gap"],
      }),
      stageOutputs: [
        {
          stage: "specialist-analysis",
          content: "{}",
          tokenEstimate: 7,
          durationMs: 3,
        },
      ],
      costPricing: [],
      collectedSources: sources,
      historicalContext: {
        generatedAt,
        recentDays: 90,
        anchorMonths: [],
        runs: [],
        sources: [],
        gaps: [],
        artifactDeltas: [],
        audit: {
          scannedRunCount: 0,
          malformedRunCount: 0,
          malformedScoreCount: 0,
          candidateRunCount: 0,
          selectedRunCount: 0,
          recentSelectedCount: 0,
          anchorSelectedCount: 0,
          sameSymbolSelectedCount: 0,
          spotlightSymbolSelectedCount: 0,
          sameSubjectSelectedCount: 0,
          sameHorizonSelectedCount: 0,
          crossHorizonSelectedCount: 0,
          resolvedMissRunCount: 0,
          missCorrectionSelectedCount: 0,
          gapCount: 0,
        },
      },
      playbookAudit: { selected: [], rejected: [] },
      predictionRetryErrors: [],
      predictionTrimWarnings: [],
      predictionCompletion: undefined,
      predictionErrors: [],
      reportValidationErrors: [],
      postSynthesisWarnings: [],
      integrityAudit: {
        report: researchReport(),
        reportIntegrity: "high",
        researchQuality: "high",
        prunedItemCount: 0,
        advisoryWarningCount: 0,
        pruned: [],
        advisories: [],
      },
      sourcePlanning,
      configuredForecastDisagreementModels: [],
      challengerModels: [],
    });

    expect(trace).toMatchObject({
      schemaVersion: 2,
      runId: "run-1",
      jobType: "market-overview",
      marketUpdateHorizonBucket: "1-5d",
      provider: "mock",
      quickModel: "quick-test",
      synthesisModel: "synthesis-test",
      sourceGaps: ["gap"],
      stages: ["source-collection", "specialist-analysis"],
      tokenEstimate: 7,
      stageRecords: [{ stage: "specialist-analysis", durationMs: 3 }],
    });
    expect(trace.reproducibility?.effectiveConfigHash).toBeString();
  });
});
