import { describe, expect, test } from "bun:test";
import type { AppConfig } from "../src/config";
import type { ResearchCommand } from "../src/cli/args";
import type { ResearchReport, RunTrace, Source } from "../src/domain/types";
import { buildRunAnalytics } from "../src/research/run-analytics";
import { buildRunTrace } from "../src/research/run-trace";
import { assessEvidenceQuality } from "../src/research/evidence-quality";
import { assessSourcePlan, buildSourcePlan } from "../src/research/source-plan";
import type { WebSubjectProfileArtifact } from "../src/web-evidence";
import type { CollectedSources } from "../src/sources/types";
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

function traceFor(
  command: ResearchCommand,
  sources: CollectedSources,
  options: {
    readonly report?: ResearchReport;
    readonly webGatherLoop?: RunTrace["webGatherLoop"];
  } = {},
) {
  const generatedAt = "2026-05-19T00:00:00.000Z";
  const report = options.report ?? researchReport();
  const sourcePlanning = assessSourcePlan(
    buildSourcePlan(command, generatedAt),
    sources,
    generatedAt,
  );
  return buildRunTrace({
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
    report,
    stageOutputs: [],
    costPricing: [],
    collectedSources: sources,
    ...(options.webGatherLoop !== undefined ? { webGatherLoop: options.webGatherLoop } : {}),
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
      report,
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
        advisoryWarningCount: 1,
        pruned: [],
        advisories: [
          {
            code: "uncited-numeric-summary-sentence",
            location: "summary[0]",
          },
        ],
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
    // No web sources collected, so the per-source synthesis-input block is absent.
    expect(trace.webSourceSynthesisInputs).toBeUndefined();
    expect(trace.reportIntegrityAudit?.advisories).toEqual([
      {
        code: "uncited-numeric-summary-sentence",
        location: "summary[0]",
      },
    ]);
  });

  test("omits empty report integrity advisories", () => {
    const trace = traceFor(
      {
        jobType: "equity",
        assetClass: "equity",
        symbol: "AAPL",
        depth: "deep",
      },
      collectedSources(),
    );

    expect(trace.reportIntegrityAudit).not.toHaveProperty("advisories");
    expect(trace.webEvidenceUtilization).toBeUndefined();
  });

  test("carries the same versioned utilization object as analytics", () => {
    const command: ResearchCommand = {
      jobType: "equity",
      assetClass: "equity",
      symbol: "AAPL",
      depth: "deep",
    };
    const webSources: Source[] = [
      {
        id: "web-1",
        title: "Apple source one",
        fetchedAt: "2026-05-18T00:00:00.000Z",
        kind: "web",
      },
      {
        id: "web-2",
        title: "Apple source two",
        fetchedAt: "2026-05-18T00:00:00.000Z",
        kind: "web",
      },
    ];
    const report = researchReport({
      sources: webSources,
      keyFindings: [{ text: "Finding", sourceIds: ["web-1"] }],
    });
    const sources = collectedSources({ extendedSources: webSources });
    const trace = traceFor(command, sources, { report });
    const analytics = buildRunAnalytics({
      report,
      trace,
      collectedSources: sources,
      stageOutputs: [],
      targetPredictions: 0,
    });

    expect(trace.webEvidenceUtilization).toEqual({
      version: 1,
      acceptedCurrentRun: 2,
      usedCurrentRun: 1,
      profileUsed: 0,
      primaryReportCited: 1,
      structuredExtraCited: 0,
      unusedCurrentRun: 1,
      ratio: 0.5,
      level: "insufficient-sample",
    });
    expect(analytics.webEvidenceUtilization).toEqual(trace.webEvidenceUtilization);
  });

  test("preserves the reused-profile acceptance policy from the gather audit", () => {
    const acceptancePolicy = {
      version: 1,
      mode: "reused-profile-after-low-utilization",
      sourceRunDirName: "prior-aapl",
      priorUtilizationLevel: "low",
      priorUtilizationRatio: 0.2,
      implicitPerQueryAcceptanceCap: 2,
    } as const;
    const trace = traceFor(
      {
        jobType: "equity",
        assetClass: "equity",
        symbol: "AAPL",
        depth: "deep",
      },
      collectedSources(),
      {
        webGatherLoop: {
          rounds: 1,
          acceptedRequests: [],
          rejectedRequests: [],
          sourceUnitsUsed: 0,
          executedTools: [],
          emittedGaps: [],
          sanitizer: {
            sourceCount: 0,
            sanitizedSourceCount: 0,
            emptyAfterSanitizeCount: 0,
            inputCharCount: 0,
            outputCharCount: 0,
            removedInstructionSpanCount: 0,
            removedChromeHtmlCount: 0,
          },
          acceptancePolicy,
        },
      },
    );

    expect(trace.webGatherLoop?.acceptancePolicy).toEqual(acceptancePolicy);
    expect(trace.webEvidenceUtilization).toMatchObject({
      acceptedCurrentRun: 0,
      ratio: 0,
      level: "insufficient-sample",
    });
  });

  test("records per-web-source synthesis inputs when web sources were gathered", () => {
    const command: ResearchCommand = {
      jobType: "equity",
      assetClass: "equity",
      symbol: "AAPL",
      depth: "deep",
    };
    const coveredSource: Source = {
      id: "web-covered-1",
      title: "Apple business profile",
      fetchedAt: "2026-05-10T00:00:00.000Z",
      kind: "web",
      summary: "Apple sells hardware and services.",
    };
    const freshSource: Source = {
      id: "web-fresh-1",
      title: "Apple ships new chip",
      fetchedAt: "2026-05-18T00:00:00.000Z",
      kind: "web",
      summary: "Apple announced a new chip this week.",
    };
    const profile: WebSubjectProfileArtifact = {
      version: 2,
      generatedAt: "2026-05-10T00:00:00.000Z",
      subjectKind: "company",
      subjectId: "AAPL",
      symbol: "AAPL",
      subjectSummary: { answer: "Apple sells devices", sourceIds: ["web-covered-1"] },
      questions: {
        whatItDoes: { answer: "Consumer electronics", sourceIds: ["web-covered-1"] },
        howItMakesMoney: { answer: "Hardware + services", sourceIds: ["web-covered-1"] },
        customers: { answer: "Global consumers", sourceIds: ["web-covered-1"] },
        geography: { answer: "Worldwide", sourceIds: ["web-covered-1"] },
        purchaseRecurrence: { answer: "High", sourceIds: ["web-covered-1"] },
        pricingPower: { answer: "Premium", sourceIds: ["web-covered-1"] },
        recessionCyclicality: { answer: "Moderate", sourceIds: ["web-covered-1"] },
      },
      recentMaterialEvents: [],
      factLedger: [{ claim: "Revenue grew", sourceIds: ["web-covered-1"] }],
      openGaps: [],
      sourceIds: ["web-covered-1"],
    };
    const trace = traceFor(
      command,
      collectedSources({
        extendedSources: [coveredSource, freshSource],
        webSubjectProfile: profile,
      }),
    );

    expect(trace.webSourceSynthesisInputs?.map((entry) => entry.sourceId)).toEqual([
      "web-covered-1",
      "web-fresh-1",
    ]);
    expect(trace.webSourceSynthesisInputs?.[0]).toEqual({
      sourceId: "web-covered-1",
      includedInContext: true,
      modelVisibleText: "none",
      profileCovered: true,
      advisories: ["web-subject-profile-low-trust"],
    });
    expect(trace.webSourceSynthesisInputs?.[1]).toEqual({
      sourceId: "web-fresh-1",
      includedInContext: true,
      modelVisibleText: "summary",
      profileCovered: false,
      advisories: ["fresh-web-preference"],
    });
  });

  test("marks fresh web text as snippet when no summary is present", () => {
    const command: ResearchCommand = {
      jobType: "equity",
      assetClass: "equity",
      symbol: "AAPL",
      depth: "deep",
    };
    const snippetOnly: Source = {
      id: "web-fresh-2",
      title: "Apple supplier update",
      fetchedAt: "2026-05-18T00:00:00.000Z",
      kind: "web",
      snippet: "Supplier reports higher orders.",
    };
    const trace = traceFor(command, collectedSources({ extendedSources: [snippetOnly] }));

    expect(trace.webSourceSynthesisInputs).toEqual([
      {
        sourceId: "web-fresh-2",
        includedInContext: true,
        modelVisibleText: "snippet",
        profileCovered: false,
        advisories: ["fresh-web-preference"],
      },
    ]);
  });
});
