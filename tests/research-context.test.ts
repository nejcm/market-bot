import { describe, expect, test } from "bun:test";
import type { AppConfig } from "../src/config";
import type { ResearchCommand } from "../src/cli/args";
import {
  buildDepthProfile,
  buildPlaybookSelectionPrompt,
  buildSpotlightSelectionPrompt,
  buildStagePrompt,
  deterministicSourceGaps,
  type ResearchContext,
} from "../src/research/research-context";
import { buildSpotlightCandidates } from "../src/research/spotlights";
import { buildCalibrationSummary, type ResolvedPair } from "../src/scoring/calibration";
import type {
  HistoricalPredictionSummary,
  HistoricalResearchContext,
  HistoricalRunContext,
} from "../src/research/historical-context";
import type {
  ExtendedEvidence,
  InstrumentIdentity,
  MarketContext,
  Prediction,
  VerifiedMarketSnapshot,
} from "../src/domain/types";
import type { EarningsSetupCollected } from "../src/sources/types";
import { collectedSources, marketSnapshot, newsSource } from "./support/fixtures";

const config: AppConfig = {
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
  evidenceRequestOptions: {
    maxRounds: 0,
    maxToolCalls: 0,
    sourceBudget: 0,
  },
  researchGatherOptions: {
    maxRounds: 0,
    maxToolCalls: 0,
    sourceBudget: 0,
  },
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

function directionPrediction(id: string, probability: number): Prediction {
  return {
    id,
    claim: "SPY closes higher",
    kind: "direction",
    subject: "SPY",
    measurableAs: "close(SPY, +5) > close(SPY, 0)",
    horizonTradingDays: 5,
    probability,
    sourceIds: [],
  };
}

function resolvedPair(id: string, probability: number, outcome: "hit" | "miss"): ResolvedPair {
  return {
    prediction: directionPrediction(id, probability),
    score: {
      predictionId: id,
      runId: "run-1",
      resolved: true,
      outcome,
      observedAt: "2026-06-01T00:00:00.000Z",
      attemptCount: 1,
      evidence: {},
    },
    assetClass: "equity",
    jobType: "daily",
    marketUpdateHorizonBucket: "1-5d",
    runId: "run-1",
  };
}

describe("buildStagePrompt", () => {
  test("includes mover feature breakdown in evidence payload", () => {
    const command: ResearchCommand = { jobType: "daily", assetClass: "equity", depth: "brief" };
    const prompt = buildStagePrompt(
      "specialist-analysis",
      command,
      collectedSources({
        rawSnapshots: [],
        marketSnapshots: [
          marketSnapshot({
            symbol: "AAPL",
            changePercent24h: 5,
            volume: 1_000_000,
            averageVolume: 500_000,
            open: 105,
            previousClose: 100,
          }),
        ],
        newsSources: [newsSource()],
        sourceGaps: [],
      }),
      config,
      {
        depthProfile: buildDepthProfile(command, config),
        runParams: {
          quickModel: "quick-test",
          synthesisModel: "synthesis-test",
          analystStyle: "concise brief",
          minimumKeyFindings: 3,
          minimumScenarios: 2,
          targetPredictions: 2,
          defaultPredictionHorizon: 5,
          predictionSubjects: ["SPY"],
          focus: ["market regime", "movers"],
          targetKindMix: { favored: ["relative", "range"], minNonDirection: 1 },
          modelParams: undefined,
        },
        marketRegime: {
          assetClass: "equity",
          label: "insufficient-data",
          proxyCount: 0,
          drivers: [],
          sourceIds: [],
        },
        calibrationContext: undefined,
      },
      { system: "Research only.", instruction: "Analyze.", goal: "Find evidence." },
    );
    const parsed = JSON.parse(prompt) as {
      readonly evidence?: {
        readonly movers?: readonly {
          readonly features?: {
            readonly unusualVolumeRatio?: number;
            readonly gapPercent?: number;
            readonly reasons?: readonly string[];
          };
        }[];
      };
    };

    expect(parsed.evidence?.movers?.[0]?.features?.unusualVolumeRatio).toBe(2);
    expect(parsed.evidence?.movers?.[0]?.features?.gapPercent).toBe(5);
    expect(parsed.evidence?.movers?.[0]?.features?.reasons).toContain("5% absolute 24h move");
    expect(parsed.evidence?.movers?.[0]?.features?.reasons).toContain("log10 volume 6");
    expect(parsed.evidence?.movers?.[0]?.features?.reasons).toContain("volume 2x average");
    expect(parsed.evidence?.movers?.[0]?.features?.reasons).toContain("5% absolute opening gap");
  });

  test("uses the non-final required shape for coverage panel stages", () => {
    const command: ResearchCommand = { jobType: "daily", assetClass: "equity", depth: "deep" };
    const prompt = buildStagePrompt(
      "regime-context-analysis",
      command,
      collectedSources({
        rawSnapshots: [],
        marketSnapshots: [marketSnapshot()],
        newsSources: [newsSource()],
        sourceGaps: [],
      }),
      config,
      {
        depthProfile: buildDepthProfile(command, config),
        runParams: {
          quickModel: "quick-test",
          synthesisModel: "synthesis-test",
          analystStyle: "fuller analyst-style",
          minimumKeyFindings: 5,
          minimumScenarios: 3,
          targetPredictions: 3,
          defaultPredictionHorizon: 5,
          predictionSubjects: ["SPY"],
          focus: ["market regime", "movers", "cross-asset themes", "risks", "source gaps"],
          targetKindMix: { favored: ["relative", "range"], minNonDirection: 1 },
          modelParams: undefined,
        },
        marketRegime: {
          assetClass: "equity",
          label: "insufficient-data",
          proxyCount: 0,
          drivers: [],
          sourceIds: [],
        },
        calibrationContext: undefined,
      },
      { system: "Research only.", instruction: "Analyze.", goal: "Expand coverage." },
    );
    const parsed = JSON.parse(prompt) as {
      readonly stage?: string;
      readonly requiredShape?: {
        readonly findings?: readonly { readonly text?: string; readonly sourceIds?: string[] }[];
        readonly dataGaps?: readonly string[];
      };
    };

    expect(parsed.stage).toBe("regime-context-analysis");
    expect(parsed.requiredShape).toEqual({
      findings: [{ text: "string", sourceIds: ["source-id"] }],
      dataGaps: ["string"],
    });
  });

  test("adds explicit prediction repair guidance on final-synthesis retries", () => {
    const command: ResearchCommand = { jobType: "daily", assetClass: "equity", depth: "brief" };
    const prompt = buildStagePrompt(
      "final-synthesis",
      command,
      collectedSources({
        rawSnapshots: [],
        marketSnapshots: [marketSnapshot()],
        newsSources: [newsSource()],
        sourceGaps: [],
      }),
      config,
      {
        depthProfile: buildDepthProfile(command, config),
        runParams: {
          quickModel: "quick-test",
          synthesisModel: "synthesis-test",
          analystStyle: "concise brief",
          minimumKeyFindings: 3,
          minimumScenarios: 2,
          targetPredictions: 2,
          defaultPredictionHorizon: 5,
          predictionSubjects: ["SPY"],
          focus: ["market regime", "movers"],
          targetKindMix: { favored: ["relative", "range"], minNonDirection: 1 },
          modelParams: undefined,
        },
        marketRegime: {
          assetClass: "equity",
          label: "mixed",
          proxyCount: 1,
          drivers: [],
          sourceIds: [],
        },
        calibrationContext: undefined,
      },
      { system: "Research only.", instruction: "Synthesize.", goal: "Final report." },
      [],
      ["predictionShortfall: required 2, received 1"],
    );
    const parsed = JSON.parse(prompt) as {
      readonly predictionRepair?: {
        readonly instruction?: string;
      };
      readonly predictionRepromptErrors?: readonly string[];
    };

    expect(parsed.predictionRepromptErrors).toEqual([
      "predictionShortfall: required 2, received 1",
    ]);
    expect(parsed.predictionRepair).toEqual({
      instruction: expect.stringContaining(
        "Return a complete final report with a valid predictions array, fixing the flagged predictions.",
      ),
    });
    expect(parsed.predictionRepair?.instruction).toContain(
      "Prefer replacement forecasts using these subjects: SPY",
    );
    expect(parsed.predictionRepair?.instruction).toContain(
      "favor these kinds when supported: relative, macro, volatility",
    );
    expect(parsed.predictionRepair?.instruction).toContain(
      "For ticker relative forecasts, use subject form TICKER:BENCHMARK.",
    );
    expect(parsed.predictionRepair?.instruction).toContain(
      "For range forecasts, vary the horizon or range bounds",
    );
    expect(parsed.predictionRepair?.instruction).toContain("at least 2 trading days apart");
  });

  test("threads redundancy-rejection reasons into the final-synthesis retry prompt", () => {
    const command: ResearchCommand = { jobType: "daily", assetClass: "equity", depth: "brief" };
    const redundancyReason =
      "Prediction pred-2: redundant direction forecast for AAPL at 6 trading days (within 2 trading days of accepted 5d)";
    const prompt = buildStagePrompt(
      "final-synthesis",
      command,
      collectedSources({
        rawSnapshots: [],
        marketSnapshots: [marketSnapshot()],
        newsSources: [newsSource()],
        sourceGaps: [],
      }),
      config,
      {
        depthProfile: buildDepthProfile(command, config),
        runParams: {
          quickModel: "quick-test",
          synthesisModel: "synthesis-test",
          analystStyle: "concise brief",
          minimumKeyFindings: 3,
          minimumScenarios: 2,
          targetPredictions: 2,
          defaultPredictionHorizon: 5,
          predictionSubjects: ["SPY"],
          focus: ["market regime", "movers"],
          targetKindMix: { favored: ["relative", "range"], minNonDirection: 1 },
          modelParams: undefined,
        },
        marketRegime: {
          assetClass: "equity",
          label: "mixed",
          proxyCount: 1,
          drivers: [],
          sourceIds: [],
        },
        calibrationContext: undefined,
      },
      { system: "Research only.", instruction: "Synthesize.", goal: "Final report." },
      [],
      [redundancyReason, "predictionShortfall: required 2, received 1"],
    );
    const parsed = JSON.parse(prompt) as {
      readonly predictionRepromptErrors?: readonly string[];
    };

    expect(parsed.predictionRepromptErrors).toEqual([
      redundancyReason,
      "predictionShortfall: required 2, received 1",
    ]);
  });

  test("final-synthesis shape omits model-authored prediction claims", () => {
    const command: ResearchCommand = { jobType: "daily", assetClass: "equity", depth: "brief" };
    const prompt = buildStagePrompt(
      "final-synthesis",
      command,
      collectedSources({
        rawSnapshots: [],
        marketSnapshots: [marketSnapshot()],
        newsSources: [newsSource()],
        sourceGaps: [],
      }),
      config,
      {
        depthProfile: buildDepthProfile(command, config),
        runParams: {
          quickModel: "quick-test",
          synthesisModel: "synthesis-test",
          analystStyle: "concise brief",
          minimumKeyFindings: 3,
          minimumScenarios: 2,
          targetPredictions: 2,
          defaultPredictionHorizon: 5,
          predictionSubjects: ["SPY"],
          focus: ["market regime", "movers"],
          targetKindMix: { favored: ["relative", "range"], minNonDirection: 1 },
          modelParams: undefined,
        },
        marketRegime: {
          assetClass: "equity",
          label: "insufficient-data",
          proxyCount: 0,
          drivers: [],
          sourceIds: [],
        },
        calibrationContext: undefined,
      },
      { system: "Research only.", instruction: "Synthesize.", goal: "Final report." },
    );
    const parsed = JSON.parse(prompt) as {
      readonly instruction?: string;
      readonly requiredShape?: {
        readonly predictions?: readonly Record<string, unknown>[];
      };
    };

    expect(parsed.instruction).toContain("Do not write a claim field");
    expect(parsed.instruction).toContain("probability is the probability that the measurableAs");
    expect(parsed.requiredShape?.predictions?.[0]).not.toHaveProperty("claim");
  });

  test("renders prior calibration from real CalibrationSummary JSON without undefined", () => {
    const command: ResearchCommand = { jobType: "daily", assetClass: "equity", depth: "brief" };
    const summary = buildCalibrationSummary([
      resolvedPair("pred-1", 0.65, "hit"),
      resolvedPair("pred-2", 0.65, "miss"),
    ]);
    // StructuredClone strips type identity to mimic a CalibrationSummary loaded from summary.json.
    const calibrationContext = structuredClone(summary) as never;

    const prompt = buildStagePrompt(
      "specialist-analysis",
      command,
      collectedSources({
        rawSnapshots: [],
        marketSnapshots: [marketSnapshot()],
        newsSources: [newsSource()],
        sourceGaps: [],
      }),
      config,
      {
        depthProfile: buildDepthProfile(command, config),
        runParams: {
          quickModel: "quick-test",
          synthesisModel: "synthesis-test",
          analystStyle: "concise brief",
          minimumKeyFindings: 3,
          minimumScenarios: 2,
          targetPredictions: 2,
          defaultPredictionHorizon: 5,
          predictionSubjects: ["SPY"],
          focus: ["market regime", "movers"],
          targetKindMix: { favored: ["relative", "range"], minNonDirection: 1 },
          modelParams: undefined,
        },
        marketRegime: {
          assetClass: "equity",
          label: "mixed",
          proxyCount: 1,
          drivers: [],
          sourceIds: [],
        },
        calibrationContext,
      },
      { system: "Research only.", instruction: "Analyze.", goal: "Find evidence." },
    );
    const parsed = JSON.parse(prompt) as {
      readonly evidence?: { readonly priorCalibration?: string };
    };
    const block = parsed.evidence?.priorCalibration;

    expect(block).toBeDefined();
    expect(block).not.toContain("undefined");
    expect(block).not.toContain("NaN");
    // Renders the real bin label, hit rate, and sample count from CalibrationSummary.
    expect(block).toContain("0.6-0.7");
    expect(block).toContain("0.50");
    expect(block).toContain("n=2");
  });

  test("surfaces overall skill and per-kind / per-horizon calibration slices", () => {
    const command: ResearchCommand = { jobType: "daily", assetClass: "equity", depth: "brief" };
    const summary = buildCalibrationSummary([
      resolvedPair("pred-1", 0.65, "hit"),
      resolvedPair("pred-2", 0.65, "miss"),
    ]);
    const calibrationContext = structuredClone(summary) as never;

    const prompt = buildStagePrompt(
      "specialist-analysis",
      command,
      collectedSources({
        rawSnapshots: [],
        marketSnapshots: [marketSnapshot()],
        newsSources: [newsSource()],
        sourceGaps: [],
      }),
      config,
      {
        depthProfile: buildDepthProfile(command, config),
        runParams: {
          quickModel: "quick-test",
          synthesisModel: "synthesis-test",
          analystStyle: "concise brief",
          minimumKeyFindings: 3,
          minimumScenarios: 2,
          targetPredictions: 2,
          defaultPredictionHorizon: 5,
          predictionSubjects: ["SPY"],
          focus: ["market regime", "movers"],
          targetKindMix: { favored: ["relative", "range"], minNonDirection: 1 },
          modelParams: undefined,
        },
        marketRegime: {
          assetClass: "equity",
          label: "mixed",
          proxyCount: 1,
          drivers: [],
          sourceIds: [],
        },
        calibrationContext,
      },
      { system: "Research only.", instruction: "Analyze.", goal: "Find evidence." },
    );
    const parsed = JSON.parse(prompt) as {
      readonly evidence?: { readonly priorCalibration?: string };
    };
    const block = parsed.evidence?.priorCalibration;

    expect(block).toBeDefined();
    expect(block).not.toContain("undefined");
    expect(block).not.toContain("NaN");
    // Overall Brier skill vs the 0.5 baseline is surfaced alongside raw Brier.
    expect(block).toContain("Brier skill");
    // Per-kind slice (direction) and per-horizon bucket (1-5d) are surfaced as directives.
    expect(block).toContain("direction");
    expect(block).toContain("1-5d");
    expect(block).toContain("base rates");
  });

  test("injects current-regime calibration only at the sample floor", () => {
    const command: ResearchCommand = { jobType: "daily", assetClass: "equity", depth: "brief" };
    const prompt = buildStagePrompt(
      "specialist-analysis",
      command,
      collectedSources({
        rawSnapshots: [],
        marketSnapshots: [marketSnapshot()],
        newsSources: [newsSource()],
        sourceGaps: [],
      }),
      config,
      {
        depthProfile: buildDepthProfile(command, config),
        runParams: {
          quickModel: "quick-test",
          synthesisModel: "synthesis-test",
          analystStyle: "concise brief",
          minimumKeyFindings: 3,
          minimumScenarios: 2,
          targetPredictions: 2,
          defaultPredictionHorizon: 5,
          predictionSubjects: ["SPY"],
          focus: ["market regime", "movers"],
          targetKindMix: { favored: ["relative", "range"], minNonDirection: 1 },
          modelParams: undefined,
        },
        marketRegime: {
          assetClass: "equity",
          label: "mixed",
          proxyCount: 1,
          drivers: [],
          sourceIds: [],
        },
        calibrationContext: {
          byMarketRegime: { mixed: { brierScore: 0.2, count: 5 } },
        },
      },
      { system: "Research only.", instruction: "Analyze.", goal: "Find evidence." },
    );
    const parsed = JSON.parse(prompt) as {
      readonly evidence?: { readonly priorCalibration?: string };
    };

    expect(parsed.evidence?.priorCalibration).toContain("Current-regime calibration (mixed");
    expect(parsed.evidence?.priorCalibration).toContain("n=5");
  });

  test("omits current-regime calibration below the sample floor", () => {
    const command: ResearchCommand = { jobType: "daily", assetClass: "equity", depth: "brief" };
    const prompt = buildStagePrompt(
      "specialist-analysis",
      command,
      collectedSources({
        rawSnapshots: [],
        marketSnapshots: [marketSnapshot()],
        newsSources: [newsSource()],
        sourceGaps: [],
      }),
      config,
      {
        depthProfile: buildDepthProfile(command, config),
        runParams: {
          quickModel: "quick-test",
          synthesisModel: "synthesis-test",
          analystStyle: "concise brief",
          minimumKeyFindings: 3,
          minimumScenarios: 2,
          targetPredictions: 2,
          defaultPredictionHorizon: 5,
          predictionSubjects: ["SPY"],
          focus: ["market regime", "movers"],
          targetKindMix: { favored: ["relative", "range"], minNonDirection: 1 },
          modelParams: undefined,
        },
        marketRegime: {
          assetClass: "equity",
          label: "mixed",
          proxyCount: 1,
          drivers: [],
          sourceIds: [],
        },
        calibrationContext: {
          byMarketRegime: { mixed: { brierScore: 0.2, count: 4 } },
        },
      },
      { system: "Research only.", instruction: "Analyze.", goal: "Find evidence." },
    );
    const parsed = JSON.parse(prompt) as {
      readonly evidence?: { readonly priorCalibration?: string };
    };

    expect(parsed.evidence?.priorCalibration).toBeUndefined();
  });

  test("injects domain playbooks as a separate prompt field", () => {
    const command: ResearchCommand = { jobType: "daily", assetClass: "equity", depth: "brief" };
    const prompt = buildStagePrompt(
      "critique",
      command,
      collectedSources({
        rawSnapshots: [],
        marketSnapshots: [marketSnapshot()],
        newsSources: [newsSource()],
        sourceGaps: [],
      }),
      config,
      {
        depthProfile: buildDepthProfile(command, config),
        runParams: {
          quickModel: "quick-test",
          synthesisModel: "synthesis-test",
          analystStyle: "concise brief",
          minimumKeyFindings: 3,
          minimumScenarios: 2,
          targetPredictions: 2,
          defaultPredictionHorizon: 5,
          predictionSubjects: ["SPY"],
          focus: ["market regime", "movers"],
          targetKindMix: { favored: ["relative", "range"], minNonDirection: 1 },
          modelParams: undefined,
        },
        marketRegime: {
          assetClass: "equity",
          label: "mixed",
          proxyCount: 1,
          drivers: [],
          sourceIds: [],
        },
        calibrationContext: undefined,
        domainPlaybooks: [
          {
            stage: "critique",
            playbooks: [
              {
                id: "critique-discipline",
                title: "Critique Discipline",
                summary: "Stress-test weak claims.",
                file: "critique-discipline.md",
                jobTypes: ["daily", "weekly", "ticker"],
                assetClasses: ["equity", "crypto"],
                depths: ["brief", "deep"],
                stages: ["critique"],
                instruction: "Challenge weak claims.",
              },
            ],
          },
        ],
      },
      { system: "Research only.", instruction: "Analyze.", goal: "Review evidence." },
    );
    const parsed = JSON.parse(prompt) as {
      readonly instruction?: string;
      readonly domainPlaybooks?: readonly { readonly instruction?: string }[];
    };

    expect(parsed.instruction).toBe("Analyze.");
    expect(parsed.domainPlaybooks?.[0]?.instruction).toBe("Challenge weak claims.");
  });

  test("adds citation guidance that reserves history reports for narrative context", () => {
    const command: ResearchCommand = { jobType: "daily", assetClass: "equity", depth: "brief" };
    const prompt = buildStagePrompt(
      "specialist-analysis",
      command,
      collectedSources({
        rawSnapshots: [],
        marketSnapshots: [marketSnapshot()],
        newsSources: [newsSource()],
        sourceGaps: [],
      }),
      config,
      contextWithHistory(command),
      { system: "Research only.", instruction: "Analyze.", goal: "Find evidence." },
    );
    const parsed = JSON.parse(prompt) as {
      readonly evidence?: { readonly deterministicCitationGuidance?: string };
    };

    expect(parsed.evidence?.deterministicCitationGuidance).toContain("exact numeric market claims");
    expect(parsed.evidence?.deterministicCitationGuidance).toContain("history-report-*");
  });

  test("adds warn-only post-synthesis audit guidance to final synthesis", () => {
    const command: ResearchCommand = {
      jobType: "ticker",
      assetClass: "equity",
      symbol: "AAPL",
      depth: "brief",
    };
    const prompt = buildStagePrompt(
      "final-synthesis",
      command,
      collectedSources({
        rawSnapshots: [],
        marketSnapshots: [marketSnapshot()],
        newsSources: [newsSource()],
        sourceGaps: [],
      }),
      config,
      contextWithHistory(command),
      { system: "Research only.", instruction: "Analyze.", goal: "Find evidence." },
      [],
      [],
      [],
      ["market-aapl", "news-equity-1"],
    );
    const parsed = JSON.parse(prompt) as {
      readonly postSynthesisAuditGuidance?: {
        readonly status?: string;
        readonly unsupportedNumericClaims?: string;
      };
    };

    expect(parsed.postSynthesisAuditGuidance?.status).toContain("warning-only");
    expect(parsed.postSynthesisAuditGuidance?.unsupportedNumericClaims).toContain(
      "history-only numeric or technical claims",
    );
  });

  test("injects market-overview prompt as steering evidence only", () => {
    const command: ResearchCommand = {
      jobType: "market-overview",
      assetClass: "equity",
      depth: "brief",
      horizonTradingDays: 7,
      prompt: "focus on banks",
    };
    const prompt = buildStagePrompt(
      "final-synthesis",
      command,
      collectedSources({
        rawSnapshots: [],
        marketSnapshots: [marketSnapshot()],
        newsSources: [newsSource()],
        sourceGaps: [],
      }),
      config,
      contextWithHistory(command),
      { system: "Research only.", instruction: "Analyze.", goal: "Find evidence." },
    );
    const parsed = JSON.parse(prompt) as {
      readonly evidence?: {
        readonly userSteeringPrompt?: { readonly text?: string; readonly instruction?: string };
      };
    };

    expect(parsed.evidence?.userSteeringPrompt).toEqual({
      text: "focus on banks",
      instruction:
        "Use this as steering for spotlight selection and final synthesis. Do not replace the deterministic market overview evidence.",
    });
  });
});

function missSummary(
  id: string,
  overrides: Partial<HistoricalPredictionSummary> = {},
): HistoricalPredictionSummary {
  return {
    id,
    claim: "AAPL closes higher",
    kind: "direction",
    subject: "AAPL",
    measurableAs: "close(AAPL, +5) > close(AAPL, 0)",
    horizonTradingDays: 5,
    probability: 0.72,
    scoreStatus: "resolved",
    scoreOutcome: "miss",
    ...overrides,
  };
}

function tickerRun(
  runId: string,
  symbol: string,
  predictions: readonly HistoricalPredictionSummary[],
  generatedAt = "2026-05-20T00:00:00.000Z",
): HistoricalRunContext {
  return {
    runId,
    sourceId: `history-report-${runId}`,
    jobType: "ticker",
    assetClass: "equity",
    symbol,
    generatedAt,
    selectionReasons: ["recent"],
    summary: "",
    confidence: "medium",
    keyFindings: [],
    risks: [],
    catalysts: [],
    dataGaps: [],
    predictions,
    scoreSummary: { total: predictions.length, resolved: 0, hit: 0, miss: 0, unresolved: 0 },
    marketSnapshots: [],
  };
}

function historicalContextWith(runs: readonly HistoricalRunContext[]): HistoricalResearchContext {
  return {
    generatedAt: "2026-06-01T00:00:00.000Z",
    recentDays: 14,
    anchorMonths: [],
    runs,
    sources: [],
    gaps: [],
    audit: {
      scannedRunCount: runs.length,
      malformedRunCount: 0,
      malformedScoreCount: 0,
      candidateRunCount: runs.length,
      selectedRunCount: runs.length,
      recentSelectedCount: runs.length,
      anchorSelectedCount: 0,
      sameSymbolSelectedCount: 0,
      spotlightSymbolSelectedCount: 0,
      sameSubjectSelectedCount: 0,
      sameHorizonSelectedCount: 0,
      crossHorizonSelectedCount: 0,
      resolvedMissRunCount: runs.filter((run) => run.scoreSummary.miss > 0).length,
      missCorrectionSelectedCount: runs.filter((run) =>
        run.selectionReasons.includes("miss-correction"),
      ).length,
      gapCount: 0,
    },
    artifactDeltas: [],
  };
}

function contextWithHistory(
  command: ResearchCommand,
  historicalContext?: HistoricalResearchContext,
): ResearchContext {
  return {
    depthProfile: buildDepthProfile(command, config),
    runParams: {
      quickModel: "quick-test",
      synthesisModel: "synthesis-test",
      analystStyle: "concise brief",
      minimumKeyFindings: 3,
      minimumScenarios: 2,
      targetPredictions: 2,
      defaultPredictionHorizon: 5,
      predictionSubjects: ["AAPL"],
      focus: ["instrument"],
      targetKindMix: { favored: ["relative", "range"], minNonDirection: 1 },
      modelParams: undefined,
    },
    marketRegime: {
      assetClass: "equity",
      label: "mixed",
      proxyCount: 1,
      drivers: [],
      sourceIds: [],
    },
    calibrationContext: undefined,
    ...(historicalContext !== undefined ? { historicalContext } : {}),
  };
}

function priorThesisErrorsFor(
  command: ResearchCommand,
  context: ResearchContext,
): string | undefined {
  const prompt = buildStagePrompt(
    "specialist-analysis",
    command,
    collectedSources({
      rawSnapshots: [],
      marketSnapshots: [marketSnapshot()],
      newsSources: [newsSource()],
      sourceGaps: [],
    }),
    config,
    context,
    { system: "Research only.", instruction: "Analyze.", goal: "Find evidence." },
  );
  const parsed = JSON.parse(prompt) as {
    readonly evidence?: { readonly priorThesisErrors?: string };
  };
  return parsed.evidence?.priorThesisErrors;
}

describe("buildStagePrompt prediction kind-mix guidance (#10)", () => {
  function finalSynthesisInstruction(command: ResearchCommand): string {
    const depthProfile = buildDepthProfile(command, config);
    const prompt = buildStagePrompt(
      "final-synthesis",
      command,
      collectedSources({
        rawSnapshots: [],
        marketSnapshots: [marketSnapshot()],
        newsSources: [newsSource()],
        sourceGaps: [],
      }),
      config,
      {
        depthProfile,
        runParams: {
          quickModel: "quick-test",
          synthesisModel: "synthesis-test",
          analystStyle: "concise brief",
          minimumKeyFindings: 3,
          minimumScenarios: 2,
          targetPredictions: depthProfile.targetPredictions,
          defaultPredictionHorizon: depthProfile.defaultPredictionHorizon,
          predictionSubjects: depthProfile.predictionSubjects,
          focus: depthProfile.focus,
          targetKindMix: depthProfile.targetKindMix,
          modelParams: undefined,
        },
        marketRegime: {
          assetClass: command.assetClass,
          label: "mixed",
          proxyCount: 1,
          drivers: [],
          sourceIds: [],
        },
        calibrationContext: undefined,
      },
      { system: "Research only.", instruction: "Synthesize.", goal: "Final report." },
    );
    const parsed = JSON.parse(prompt) as { readonly instruction?: string };
    return parsed.instruction ?? "";
  }

  test("daily-equity (market-update) instruction favors relative/macro/volatility over bare direction", () => {
    const command: ResearchCommand = { jobType: "daily", assetClass: "equity", depth: "brief" };
    const instruction = finalSynthesisInstruction(command);

    expect(instruction).toContain(
      "Favor more informative forecast kinds in this priority order where the evidence supports them: relative, macro, volatility.",
    );
    expect(instruction).toContain("Use bare `direction` only when no better-measured kind fits");
    expect(instruction).toContain(
      "Aim for at least 1 prediction(s) using a kind other than `direction`",
    );
  });

  test("ticker instruction favors its own mix (relative, range)", () => {
    const command: ResearchCommand = {
      jobType: "ticker",
      assetClass: "equity",
      symbol: "AAPL",
      depth: "brief",
    };
    const instruction = finalSynthesisInstruction(command);

    expect(instruction).toContain(
      "Favor more informative forecast kinds in this priority order where the evidence supports them: relative, range.",
    );
  });

  test("daily-crypto instruction favors relative/range and never advertises macro or iv", () => {
    const command: ResearchCommand = { jobType: "daily", assetClass: "crypto", depth: "brief" };
    const instruction = finalSynthesisInstruction(command);

    expect(instruction).toContain(
      "Favor more informative forecast kinds in this priority order where the evidence supports them: relative, range.",
    );
    // Crypto has no point forecasts (macro/iv are equity-only — see src/scoring/observations.ts),
    // So the favored-kind guidance must not steer the model toward kinds it cannot fulfill.
    const guidanceStart = instruction.indexOf("Favor more informative forecast kinds");
    const favoredClause = instruction.slice(guidanceStart, instruction.indexOf(".", guidanceStart));
    const favoredKinds = favoredClause
      .slice(favoredClause.indexOf(":") + 1)
      .split(",")
      .map((kind) => kind.trim());
    expect(favoredKinds).not.toContain("macro");
    expect(favoredKinds).not.toContain("iv");
  });

  test("deep daily-equity raises the non-direction floor over the brief profile", () => {
    const briefCommand: ResearchCommand = {
      jobType: "daily",
      assetClass: "equity",
      depth: "brief",
    };
    const deepCommand: ResearchCommand = { jobType: "daily", assetClass: "equity", depth: "deep" };

    const briefInstruction = finalSynthesisInstruction(briefCommand);
    const deepInstruction = finalSynthesisInstruction(deepCommand);

    expect(briefInstruction).toContain("Aim for at least 1 prediction(s)");
    expect(deepInstruction).toContain("Aim for at least 2 prediction(s)");
  });
});

describe("buildStagePrompt prior-thesis error correction", () => {
  const tickerCommand: ResearchCommand = {
    jobType: "ticker",
    assetClass: "equity",
    symbol: "AAPL",
    depth: "brief",
  };

  test("surfaces prior-miss bullets with run id, claim, probability, outcome, and citation", () => {
    const context = contextWithHistory(
      tickerCommand,
      historicalContextWith([tickerRun("run-aapl-1", "AAPL", [missSummary("p1")])]),
    );

    const block = priorThesisErrorsFor(tickerCommand, context);

    expect(block).toBeDefined();
    expect(block).not.toContain("undefined");
    expect(block).toContain("AAPL");
    expect(block).toContain("run-aapl-1");
    expect(block).toContain("AAPL closes higher");
    expect(block).toContain("p=0.72");
    expect(block).toContain("MISS");
    expect(block).toContain("history-report-run-aapl-1");
  });

  test("caps the number of prior-miss bullets and keeps the most recent", () => {
    const olderMisses = Array.from({ length: 6 }, (_, idx) =>
      missSummary(`old-${String(idx)}`, { claim: `older claim ${String(idx)}` }),
    );
    const context = contextWithHistory(
      tickerCommand,
      historicalContextWith([
        tickerRun(
          "run-recent",
          "AAPL",
          [missSummary("recent", { claim: "recent claim" })],
          "2026-05-25T00:00:00.000Z",
        ),
        tickerRun("run-old", "AAPL", olderMisses, "2026-04-01T00:00:00.000Z"),
      ]),
    );

    const block = priorThesisErrorsFor(tickerCommand, context) ?? "";
    const bulletCount = block.split("\n").filter((line) => line.trim().startsWith("- run")).length;

    expect(bulletCount).toBe(5);
    expect(block).toContain("recent claim");
  });

  test("omits the block when no prior predictions on the instrument resolved as misses", () => {
    const context = contextWithHistory(
      tickerCommand,
      historicalContextWith([
        tickerRun("run-aapl-1", "AAPL", [missSummary("p1", { scoreOutcome: "hit" })]),
      ]),
    );

    expect(priorThesisErrorsFor(tickerCommand, context)).toBeUndefined();
  });

  test("excludes misses from a different instrument", () => {
    const context = contextWithHistory(
      tickerCommand,
      historicalContextWith([
        tickerRun("run-msft", "MSFT", [
          missSummary("p-msft", { claim: "MSFT closes higher", subject: "MSFT" }),
        ]),
      ]),
    );

    expect(priorThesisErrorsFor(tickerCommand, context)).toBeUndefined();
  });

  test("excludes same-run misses whose parsed instruments do not include the ticker", () => {
    const context = contextWithHistory(
      tickerCommand,
      historicalContextWith([
        tickerRun("run-aapl-benchmark-only", "AAPL", [
          missSummary("p-spy", {
            claim: "SPY closes higher",
            subject: "SPY",
            measurableAs: "close(SPY, +5) > close(SPY, 0)",
          }),
        ]),
      ]),
    );

    expect(priorThesisErrorsFor(tickerCommand, context)).toBeUndefined();
  });

  test("excludes same-run misses whose metadata does not match parseable DSL", () => {
    const cases: readonly {
      readonly name: string;
      readonly overrides: Partial<HistoricalPredictionSummary>;
    }[] = [
      { name: "subject mismatch", overrides: { subject: "MSFT" } },
      { name: "kind mismatch", overrides: { kind: "relative" } },
      { name: "horizon mismatch", overrides: { horizonTradingDays: 10 } },
    ];

    for (const { name, overrides } of cases) {
      const context = contextWithHistory(
        tickerCommand,
        historicalContextWith([
          tickerRun(`run-aapl-${name.replaceAll(" ", "-")}`, "AAPL", [
            missSummary("p-invalid", overrides),
          ]),
        ]),
      );

      expect(priorThesisErrorsFor(tickerCommand, context)).toBeUndefined();
    }
  });

  test("does not surface an instrument error block for market-update (daily) runs", () => {
    const dailyCommand: ResearchCommand = {
      jobType: "daily",
      assetClass: "equity",
      depth: "brief",
    };
    const context = contextWithHistory(
      dailyCommand,
      historicalContextWith([tickerRun("run-aapl-1", "AAPL", [missSummary("p1")])]),
    );

    expect(priorThesisErrorsFor(dailyCommand, context)).toBeUndefined();
  });

  test("surfaces observed resolution evidence for the prior miss", () => {
    const context = contextWithHistory(
      tickerCommand,
      historicalContextWith([
        tickerRun("run-aapl-1", "AAPL", [
          missSummary("p1", { scoreEvidence: { close0: 180.5, closeN: 172.3 } }),
        ]),
      ]),
    );

    const block = priorThesisErrorsFor(tickerCommand, context) ?? "";

    expect(block).toContain("observed");
    expect(block).toContain("close0=180.5");
    expect(block).toContain("closeN=172.3");
  });

  test("single-lines observed evidence keys and string values", () => {
    const context = contextWithHistory(
      tickerCommand,
      historicalContextWith([
        tickerRun("run-aapl-1", "AAPL", [
          missSummary("p1", { scoreEvidence: { "bad\nkey": "value\n  - injected" } }),
        ]),
      ]),
    );

    const block = priorThesisErrorsFor(tickerCommand, context) ?? "";

    expect(block).toContain("bad key=value - injected");
    expect(block).not.toContain("bad\nkey");
    expect(block).not.toContain("value\n  - injected");
  });

  test("renders cleanly when the prior miss has no resolution evidence", () => {
    const context = contextWithHistory(
      tickerCommand,
      historicalContextWith([tickerRun("run-aapl-1", "AAPL", [missSummary("p1")])]),
    );

    const block = priorThesisErrorsFor(tickerCommand, context) ?? "";

    expect(block).toContain("resolved MISS");
    expect(block).not.toContain("observed");
    expect(block).not.toContain("undefined");
    expect(block).not.toContain("()");
  });
});

function marketRun(
  runId: string,
  jobType: "daily" | "weekly" | "market-overview",
  predictions: readonly HistoricalPredictionSummary[],
  generatedAt = "2026-05-20T00:00:00.000Z",
  assetClass: "equity" | "crypto" = "equity",
  keyExtras?: Record<string, unknown>,
): HistoricalRunContext {
  return {
    runId,
    sourceId: `history-report-${runId}`,
    jobType,
    assetClass,
    generatedAt,
    selectionReasons: ["recent"],
    summary: "",
    confidence: "medium",
    keyFindings: [],
    risks: [],
    catalysts: [],
    dataGaps: [],
    predictions,
    scoreSummary: { total: predictions.length, resolved: 0, hit: 0, miss: 0, unresolved: 0 },
    marketSnapshots: [],
    ...(keyExtras !== undefined ? { keyExtras } : {}),
  };
}

function marketMiss(
  id: string,
  subject: string,
  overrides: Partial<HistoricalPredictionSummary> = {},
): HistoricalPredictionSummary {
  return missSummary(id, { subject, claim: `${subject} forecast`, ...overrides });
}

function priorMarketForecastErrorsFor(
  command: ResearchCommand,
  context: ResearchContext,
): string | undefined {
  const prompt = buildStagePrompt(
    "specialist-analysis",
    command,
    collectedSources({
      rawSnapshots: [],
      marketSnapshots: [marketSnapshot()],
      newsSources: [newsSource()],
      sourceGaps: [],
    }),
    config,
    context,
    { system: "Research only.", instruction: "Analyze.", goal: "Find evidence." },
  );
  const parsed = JSON.parse(prompt) as {
    readonly evidence?: { readonly priorMarketForecastErrors?: string };
  };
  return parsed.evidence?.priorMarketForecastErrors;
}

function researchRun(
  runId: string,
  predictions: readonly HistoricalPredictionSummary[],
  generatedAt = "2026-05-20T00:00:00.000Z",
  overrides: Partial<HistoricalRunContext> = {},
): HistoricalRunContext {
  return {
    runId,
    sourceId: `history-report-${runId}`,
    jobType: "research",
    assetClass: "equity",
    subjectKey: "semiconductors",
    predictionProxySymbol: "SMH",
    generatedAt,
    selectionReasons: ["recent", "same-subject"],
    summary: "",
    confidence: "medium",
    keyFindings: [],
    risks: [],
    catalysts: [],
    dataGaps: [],
    predictions,
    scoreSummary: { total: predictions.length, resolved: 0, hit: 0, miss: 0, unresolved: 0 },
    marketSnapshots: [],
    ...overrides,
  };
}

function priorThematicForecastErrorsFor(
  command: ResearchCommand,
  context: ResearchContext,
): string | undefined {
  const prompt = buildStagePrompt(
    "specialist-analysis",
    command,
    collectedSources({
      rawSnapshots: [],
      marketSnapshots: [marketSnapshot({ symbol: "SMH" })],
      newsSources: [newsSource()],
      sourceGaps: [],
    }),
    config,
    context,
    { system: "Research only.", instruction: "Analyze.", goal: "Find evidence." },
  );
  const parsed = JSON.parse(prompt) as {
    readonly evidence?: { readonly priorThematicForecastErrors?: string };
  };
  return parsed.evidence?.priorThematicForecastErrors;
}

describe("buildStagePrompt market-scoped forecast error correction (ADR 0015)", () => {
  const dailyCommand: ResearchCommand = { jobType: "daily", assetClass: "equity", depth: "brief" };
  const sevenDayOverviewCommand: ResearchCommand = {
    jobType: "market-overview",
    assetClass: "equity",
    depth: "brief",
    horizonTradingDays: 7,
  };

  test("surfaces prior same-horizon-bucket market misses on configured subjects", () => {
    const context = contextWithHistory(
      dailyCommand,
      historicalContextWith([marketRun("run-daily-1", "daily", [marketMiss("p1", "SPY")])]),
    );

    const block = priorMarketForecastErrorsFor(dailyCommand, context);

    expect(block).toBeDefined();
    expect(block).not.toContain("undefined");
    expect(block).toContain("daily");
    expect(block).toContain("run-daily-1");
    expect(block).toContain("SPY forecast");
    expect(block).toContain("MISS");
    expect(block).toContain("history-report-run-daily-1");
  });

  test("includes FRED macro subjects", () => {
    const context = contextWithHistory(
      dailyCommand,
      historicalContextWith([marketRun("run-macro", "daily", [marketMiss("p-macro", "DGS10")])]),
    );

    expect(priorMarketForecastErrorsFor(dailyCommand, context)).toContain("DGS10 forecast");
  });

  test("includes relative misses when every subject leg is configured", () => {
    const context = contextWithHistory(
      dailyCommand,
      historicalContextWith([
        marketRun("run-relative", "daily", [marketMiss("p-relative", "QQQ:SPY")]),
      ]),
    );

    expect(priorMarketForecastErrorsFor(dailyCommand, context)).toContain("QQQ:SPY forecast");
  });

  test("excludes relative misses with a non-configured ticker leg", () => {
    const context = contextWithHistory(
      dailyCommand,
      historicalContextWith([
        marketRun("run-relative", "daily", [marketMiss("p-relative", "SPY:AAPL")]),
      ]),
    );

    expect(priorMarketForecastErrorsFor(dailyCommand, context)).toBeUndefined();
  });

  test("does not fire for ticker commands", () => {
    const tickerCommand: ResearchCommand = {
      jobType: "ticker",
      assetClass: "equity",
      symbol: "AAPL",
      depth: "brief",
    };
    const context = contextWithHistory(
      tickerCommand,
      historicalContextWith([marketRun("run-daily-1", "daily", [marketMiss("p1", "SPY")])]),
    );

    expect(priorMarketForecastErrorsFor(tickerCommand, context)).toBeUndefined();
  });

  test("excludes spotlight ticker misses even on a configured subject", () => {
    const context = contextWithHistory(
      dailyCommand,
      historicalContextWith([tickerRun("run-spy-ticker", "SPY", [marketMiss("p-spy", "SPY")])]),
    );

    expect(priorMarketForecastErrorsFor(dailyCommand, context)).toBeUndefined();
  });

  test("excludes misses on non-configured subjects", () => {
    const context = contextWithHistory(
      dailyCommand,
      historicalContextWith([marketRun("run-daily-1", "daily", [marketMiss("p-aapl", "AAPL")])]),
    );

    expect(priorMarketForecastErrorsFor(dailyCommand, context)).toBeUndefined();
  });

  test("excludes the other horizon bucket (weekly misses for a daily command)", () => {
    const context = contextWithHistory(
      dailyCommand,
      historicalContextWith([marketRun("run-weekly-1", "weekly", [marketMiss("p1", "SPY")])]),
    );

    expect(priorMarketForecastErrorsFor(dailyCommand, context)).toBeUndefined();
  });

  test("isolates canonical market-overview misses by horizon bucket", () => {
    const context = contextWithHistory(
      sevenDayOverviewCommand,
      historicalContextWith([
        marketRun("run-5d", "market-overview", [marketMiss("p-5d", "SPY")], undefined, "equity", {
          marketUpdateHorizonBucket: "1-5d",
        }),
        marketRun("run-7d", "market-overview", [marketMiss("p-7d", "SPY")], undefined, "equity", {
          marketUpdateHorizonBucket: "6-10d",
        }),
        marketRun("run-daily", "daily", [marketMiss("p-daily", "SPY")]),
      ]),
    );
    const block = priorMarketForecastErrorsFor(sevenDayOverviewCommand, context);

    expect(block).toContain("run-7d");
    expect(block).toContain("SPY forecast");
    expect(block).not.toContain("run-5d");
    expect(block).not.toContain("run-daily");
  });

  test("omits the block when the configured-subject prediction resolved as a hit", () => {
    const context = contextWithHistory(
      dailyCommand,
      historicalContextWith([
        marketRun("run-daily-1", "daily", [marketMiss("p1", "SPY", { scoreOutcome: "hit" })]),
      ]),
    );

    expect(priorMarketForecastErrorsFor(dailyCommand, context)).toBeUndefined();
  });
});

describe("buildStagePrompt research thematic forecast error correction", () => {
  const researchCommand: ResearchCommand = {
    jobType: "research",
    assetClass: "equity",
    subject: "semis",
    subjectKey: "semiconductors",
    predictionProxySymbol: "SMH",
    depth: "brief",
  };

  test("surfaces prior same-subject proxy misses", () => {
    const context = contextWithHistory(
      researchCommand,
      historicalContextWith([
        researchRun("run-semis-1", [
          missSummary("p-smh", { subject: "SMH", claim: "SMH forecast" }),
        ]),
      ]),
    );

    const block = priorThematicForecastErrorsFor(researchCommand, context);

    expect(block).toBeDefined();
    expect(block).toContain("semiconductors");
    expect(block).toContain("SMH");
    expect(block).toContain("run-semis-1");
    expect(block).toContain("SMH forecast");
    expect(block).toContain("MISS");
    expect(block).toContain("history-report-run-semis-1");
  });

  test("excludes prior research misses on a different proxy", () => {
    const context = contextWithHistory(
      researchCommand,
      historicalContextWith([
        researchRun(
          "run-software",
          [missSummary("p-igv", { subject: "IGV", claim: "IGV forecast" })],
          "2026-05-20T00:00:00.000Z",
          { subjectKey: "software", predictionProxySymbol: "IGV" },
        ),
      ]),
    );

    expect(priorThematicForecastErrorsFor(researchCommand, context)).toBeUndefined();
  });

  test("omits thematic error correction when the command has no resolved proxy", () => {
    const commandWithoutProxy: ResearchCommand = {
      jobType: "research",
      assetClass: "equity",
      subject: "semis",
      subjectKey: "semiconductors",
      depth: "brief",
    };
    const context = contextWithHistory(
      commandWithoutProxy,
      historicalContextWith([
        researchRun("run-semis-1", [
          missSummary("p-smh", { subject: "SMH", claim: "SMH forecast" }),
        ]),
      ]),
    );

    expect(priorThematicForecastErrorsFor(commandWithoutProxy, context)).toBeUndefined();
  });
});

describe("buildPlaybookSelectionPrompt", () => {
  test("uses slim selector context", () => {
    const command: ResearchCommand = { jobType: "daily", assetClass: "equity", depth: "brief" };
    const prompt = buildPlaybookSelectionPrompt(
      command,
      collectedSources({
        rawSnapshots: [],
        marketSnapshots: [marketSnapshot()],
        newsSources: [newsSource()],
        sourceGaps: [{ source: "marketaux", message: "missing token" }],
      }),
      {
        depthProfile: buildDepthProfile(command, config),
        runParams: {
          quickModel: "quick-test",
          synthesisModel: "synthesis-test",
          analystStyle: "concise brief",
          minimumKeyFindings: 3,
          minimumScenarios: 2,
          targetPredictions: 2,
          defaultPredictionHorizon: 5,
          predictionSubjects: ["SPY"],
          focus: ["market regime", "movers"],
          targetKindMix: { favored: ["relative", "range"], minNonDirection: 1 },
          modelParams: undefined,
        },
        marketRegime: {
          assetClass: "equity",
          label: "mixed",
          proxyCount: 1,
          drivers: ["SPY higher"],
          sourceIds: ["market-aapl"],
        },
        calibrationContext: undefined,
      },
      { system: "Select.", instruction: "Choose playbooks.", goal: "Keep prompts focused." },
      ["specialist-analysis", "critique", "final-synthesis"],
      [
        {
          id: "market-regime",
          title: "Market Regime",
          summary: "Regime context.",
          eligibleStages: ["specialist-analysis", "critique"],
        },
      ],
    );
    const parsed = JSON.parse(prompt) as {
      readonly stage?: string;
      readonly plannedStages?: readonly string[];
      readonly candidates?: readonly unknown[];
      readonly marketRegime?: { readonly label?: string; readonly drivers?: readonly string[] };
      readonly evidenceCategories?: readonly string[];
      readonly sourceGaps?: readonly string[];
      readonly evidence?: unknown;
      readonly priorStages?: unknown;
    };

    expect(parsed.stage).toBe("playbook-selection");
    expect(parsed.plannedStages).toEqual(["specialist-analysis", "critique", "final-synthesis"]);
    expect(parsed.candidates).toHaveLength(1);
    expect(parsed.marketRegime).toEqual({ label: "mixed" });
    expect(parsed.evidenceCategories).toEqual(["market-data", "news"]);
    expect(parsed.sourceGaps).toEqual(["marketaux: missing token"]);
    expect(parsed.evidence).toBeUndefined();
    expect(parsed.priorStages).toBeUndefined();
  });
});

describe("buildSpotlightSelectionPrompt", () => {
  test("uses candidate-only selector context", () => {
    const command: ResearchCommand = { jobType: "daily", assetClass: "equity", depth: "brief" };
    const sources = collectedSources({
      rawSnapshots: [],
      marketSnapshots: [marketSnapshot()],
      newsSources: [newsSource()],
      sourceGaps: [],
    });
    const context = {
      depthProfile: buildDepthProfile(command, config),
      runParams: {
        quickModel: "quick-test",
        synthesisModel: "synthesis-test",
        analystStyle: "concise brief" as const,
        minimumKeyFindings: 3,
        minimumScenarios: 2,
        targetPredictions: 2,
        defaultPredictionHorizon: 5,
        predictionSubjects: ["SPY"],
        focus: ["market regime", "movers"],
        targetKindMix: { favored: ["relative", "range"] as const, minNonDirection: 1 },
        modelParams: undefined,
      },
      marketRegime: {
        assetClass: "equity" as const,
        label: "mixed" as const,
        proxyCount: 1,
        drivers: ["SPY higher"],
        sourceIds: ["market-aapl"],
      },
      calibrationContext: undefined,
    };
    const prompt = buildSpotlightSelectionPrompt(
      command,
      sources,
      context,
      { system: "Select.", instruction: "Choose spotlights.", goal: "Keep focus." },
      buildSpotlightCandidates({ marketSnapshots: sources.marketSnapshots }),
      2,
    );
    const parsed = JSON.parse(prompt) as {
      readonly stage?: string;
      readonly selectionCap?: number;
      readonly candidates?: readonly { readonly symbol?: string; readonly sourceIds?: string[] }[];
      readonly evidence?: unknown;
      readonly requiredShape?: { readonly selections?: readonly unknown[] };
    };

    expect(parsed.stage).toBe("spotlight-selection");
    expect(parsed.selectionCap).toBe(2);
    expect(parsed.candidates?.[0]).toMatchObject({ symbol: "AAPL", sourceIds: ["market-aapl"] });
    expect(parsed.evidence).toBeUndefined();
    expect(parsed.requiredShape?.selections).toHaveLength(1);
  });

  test("carries the market-overview steering prompt into spotlight selection", () => {
    const command: ResearchCommand = {
      jobType: "market-overview",
      assetClass: "equity",
      depth: "brief",
      horizonTradingDays: 15,
      prompt: "focus on banks",
    };
    const sources = collectedSources({
      rawSnapshots: [],
      marketSnapshots: [marketSnapshot()],
      newsSources: [newsSource()],
      sourceGaps: [],
    });
    const context = {
      depthProfile: buildDepthProfile(command, config),
      runParams: {
        quickModel: "quick-test",
        synthesisModel: "synthesis-test",
        analystStyle: "concise brief" as const,
        minimumKeyFindings: 3,
        minimumScenarios: 2,
        targetPredictions: 2,
        defaultPredictionHorizon: 15,
        predictionSubjects: ["SPY"],
        focus: ["market regime", "movers"],
        targetKindMix: { favored: ["relative", "range"] as const, minNonDirection: 1 },
        modelParams: undefined,
      },
      marketRegime: {
        assetClass: "equity" as const,
        label: "mixed" as const,
        proxyCount: 1,
        drivers: ["SPY higher"],
        sourceIds: ["market-aapl"],
      },
      calibrationContext: undefined,
    };
    const prompt = buildSpotlightSelectionPrompt(
      command,
      sources,
      context,
      { system: "Select.", instruction: "Choose spotlights.", goal: "Keep focus." },
      buildSpotlightCandidates({ marketSnapshots: sources.marketSnapshots }),
      2,
    );
    const parsed = JSON.parse(prompt) as {
      readonly userSteeringPrompt?: { readonly text?: string; readonly instruction?: string };
    };

    expect(parsed.userSteeringPrompt).toEqual({
      text: "focus on banks",
      instruction:
        "Use this as steering for spotlight selection and final synthesis. Do not replace the deterministic market overview evidence.",
    });
  });
});

// ---------------------------------------------------------------------------
// Phase 2.2 — registry subject in evidence payload and missing-snapshot gaps
// ---------------------------------------------------------------------------

function researchContext(command: ResearchCommand): ResearchContext {
  return {
    depthProfile: buildDepthProfile(command, config),
    runParams: {
      quickModel: "quick-test",
      synthesisModel: "synthesis-test",
      analystStyle: "concise brief",
      minimumKeyFindings: 3,
      minimumScenarios: 2,
      targetPredictions: 2,
      defaultPredictionHorizon: 5,
      predictionSubjects: ["SMH"],
      focus: ["market regime"],
      targetKindMix: { favored: ["direction"], minNonDirection: 0 },
      modelParams: undefined,
    },
    marketRegime: {
      assetClass: "equity",
      label: "insufficient-data",
      proxyCount: 0,
      drivers: [],
      sourceIds: [],
    },
    calibrationContext: undefined,
  };
}

describe("phase 2.2 — registrySubject in evidence payload", () => {
  test("includes registrySubject block for resolved research subject", () => {
    const command: ResearchCommand = {
      jobType: "research",
      assetClass: "equity",
      subject: "chip stocks",
      subjectKey: "semiconductors",
      predictionProxySymbol: "SMH",
      depth: "brief",
    };
    const prompt = buildStagePrompt(
      "specialist-analysis",
      command,
      collectedSources({
        marketSnapshots: [
          marketSnapshot({ sourceId: "market-smh", symbol: "SMH" }),
          marketSnapshot({ sourceId: "market-nvda", symbol: "NVDA" }),
        ],
        newsSources: [newsSource()],
      }),
      config,
      researchContext(command),
      { system: "Research only.", instruction: "Analyze.", goal: "Find evidence." },
    );
    const parsed = JSON.parse(prompt) as {
      readonly evidence?: {
        readonly registrySubject?: {
          readonly subjectKey?: string;
          readonly displayName?: string;
          readonly representativeInstruments?: readonly {
            readonly symbol?: string;
            readonly hasLiveSnapshot?: boolean;
          }[];
          readonly provenanceSources?: readonly { readonly sourceId?: string }[];
          readonly predictionProxy?: { readonly symbol?: string };
        };
      };
    };

    const subject = parsed.evidence?.registrySubject;
    expect(subject?.subjectKey).toBe("semiconductors");
    expect(subject?.displayName).toBe("Semiconductors");
    expect(subject?.predictionProxy?.symbol).toBe("SMH");

    const reps = subject?.representativeInstruments ?? [];
    const smh = reps.find((r) => r.symbol === "SMH");
    const nvda = reps.find((r) => r.symbol === "NVDA");
    const amd = reps.find((r) => r.symbol === "AMD");

    expect(smh?.hasLiveSnapshot).toBe(true);
    expect(nvda?.hasLiveSnapshot).toBe(true);
    expect(amd?.hasLiveSnapshot).toBe(false);

    const sourceIds = (subject?.provenanceSources ?? []).map((s) => s.sourceId);
    expect(sourceIds).toContain("vaneck-smh");
    expect(sourceIds).toContain("nasdaq-nvda");
  });

  test("omits registrySubject block for unresolved research subject", () => {
    const command: ResearchCommand = {
      jobType: "research",
      assetClass: "equity",
      subject: "unknown niche",
      depth: "brief",
    };
    const prompt = buildStagePrompt(
      "specialist-analysis",
      command,
      collectedSources({ newsSources: [newsSource()] }),
      config,
      researchContext(command),
      { system: "Research only.", instruction: "Analyze.", goal: "Find evidence." },
    );
    const parsed = JSON.parse(prompt) as {
      readonly evidence?: { readonly registrySubject?: unknown };
    };

    expect(parsed.evidence?.registrySubject).toBeUndefined();
  });
});

describe("phase 2.2 — deterministicSourceGaps for missing representative snapshots", () => {
  test("adds gap for each registry representative without a live snapshot", () => {
    const command: ResearchCommand = {
      jobType: "research",
      assetClass: "equity",
      subject: "chip stocks",
      subjectKey: "semiconductors",
      predictionProxySymbol: "SMH",
      depth: "brief",
    };
    // Only SMH has a snapshot; NVDA, AMD, AVGO are absent
    const gaps = deterministicSourceGaps(
      command,
      collectedSources({
        marketSnapshots: [marketSnapshot({ sourceId: "market-smh", symbol: "SMH" })],
        newsSources: [newsSource()],
      }),
    );

    const repGaps = gaps.filter((g) => g.startsWith("researchRepresentative:"));
    expect(repGaps.length).toBe(3);
    expect(repGaps.some((g) => g.includes("NVDA"))).toBe(true);
    expect(repGaps.some((g) => g.includes("AMD"))).toBe(true);
    expect(repGaps.some((g) => g.includes("AVGO"))).toBe(true);
  });

  test("emits no representative gaps when all representatives have live snapshots", () => {
    const command: ResearchCommand = {
      jobType: "research",
      assetClass: "equity",
      subject: "chip stocks",
      subjectKey: "semiconductors",
      predictionProxySymbol: "SMH",
      depth: "brief",
    };
    const gaps = deterministicSourceGaps(
      command,
      collectedSources({
        marketSnapshots: [
          marketSnapshot({ sourceId: "market-smh", symbol: "SMH" }),
          marketSnapshot({ sourceId: "market-nvda", symbol: "NVDA" }),
          marketSnapshot({ sourceId: "market-amd", symbol: "AMD" }),
          marketSnapshot({ sourceId: "market-avgo", symbol: "AVGO" }),
        ],
        newsSources: [newsSource()],
      }),
    );

    expect(gaps.filter((g) => g.startsWith("researchRepresentative:"))).toHaveLength(0);
  });

  test("emits no representative gaps for unresolved research subject", () => {
    const command: ResearchCommand = {
      jobType: "research",
      assetClass: "equity",
      subject: "unknown niche",
      depth: "brief",
    };
    const gaps = deterministicSourceGaps(
      command,
      collectedSources({ newsSources: [newsSource()] }),
    );

    expect(gaps.filter((g) => g.startsWith("researchRepresentative:"))).toHaveLength(0);
  });
});

describe("#1 — evidence projectors in buildStagePrompt payload", () => {
  const marketContextValue: MarketContext = { assetClass: "equity", items: [], gaps: [] };
  const extendedEvidenceValue: ExtendedEvidence = {
    instrument: { symbol: "AAPL", assetClass: "equity" },
    items: [],
    gaps: [],
  };
  const earningsSetupValue: EarningsSetupCollected = {
    event: {
      symbol: "AAPL",
      date: "2026-07-30",
      timing: "amc",
      sourceIds: ["earnings-aapl"],
      fetchedAt: "2026-06-01T00:00:00.000Z",
    },
    gaps: [],
  };
  const resolvedIdentityValue: InstrumentIdentity = { displayName: "Apple Inc." };
  const verifiedSnapshotValue: VerifiedMarketSnapshot = {
    symbol: "AAPL",
    assetClass: "equity",
    analysisDate: "2026-06-01",
    fetchedAt: "2026-06-01T00:00:00.000Z",
    latestSessionDate: "2026-05-29",
    ohlcv: { date: "2026-05-29", open: 100, high: 105, low: 99, close: 104, volume: 1_000_000 },
    indicators: {
      ema10: null,
      sma50: null,
      sma200: null,
      rsi14: null,
      macd: null,
      macdSignal: null,
      macdHistogram: null,
      bollUpper: null,
      bollMiddle: null,
      bollLower: null,
      atr14: null,
    },
    recentCloses: [],
  };

  function evidenceFor(
    command: ResearchCommand,
    sources: Partial<Parameters<typeof collectedSources>[0]>,
  ): Record<string, unknown> {
    const prompt = buildStagePrompt(
      "specialist-analysis",
      command,
      collectedSources({
        marketSnapshots: [marketSnapshot()],
        newsSources: [newsSource()],
        ...sources,
      }),
      config,
      researchContext(command),
      { system: "Research only.", instruction: "Analyze.", goal: "Find evidence." },
    );
    return (JSON.parse(prompt) as { readonly evidence?: Record<string, unknown> }).evidence ?? {};
  }

  test("non-gated projector contributes its key only when its source is present", () => {
    const command: ResearchCommand = { jobType: "daily", assetClass: "equity", depth: "brief" };

    expect(evidenceFor(command, {}).marketContext).toBeUndefined();
    expect(evidenceFor(command, { marketContext: marketContextValue }).marketContext).toEqual(
      marketContextValue,
    );
  });

  test("verified-snapshot projector contributes all three of its keys", () => {
    const command: ResearchCommand = {
      jobType: "ticker",
      assetClass: "equity",
      symbol: "AAPL",
      depth: "deep",
    };
    const evidence = evidenceFor(command, { verifiedMarketSnapshot: verifiedSnapshotValue });

    expect(evidence.verifiedMarketSnapshot).toEqual(verifiedSnapshotValue);
    expect(evidence.verifiedMarketSnapshotSourceId).toBeDefined();
    expect(evidence.verifiedMarketSnapshotCitationRule).toBeDefined();
  });

  test("ticker-gated projector is suppressed for non-ticker runs even when its source is present", () => {
    const tickerCommand: ResearchCommand = {
      jobType: "ticker",
      assetClass: "equity",
      symbol: "AAPL",
      depth: "deep",
    };
    const dailyCommand: ResearchCommand = {
      jobType: "daily",
      assetClass: "equity",
      depth: "brief",
    };

    expect(
      evidenceFor(tickerCommand, { extendedEvidence: extendedEvidenceValue }).extendedEvidence,
    ).toEqual(extendedEvidenceValue);
    expect(
      evidenceFor(dailyCommand, { extendedEvidence: extendedEvidenceValue }).extendedEvidence,
    ).toBeUndefined();
  });

  test("earnings-setup projector is ticker-gated and contributes its key only when present", () => {
    const tickerCommand: ResearchCommand = {
      jobType: "ticker",
      assetClass: "equity",
      symbol: "AAPL",
      depth: "deep",
    };
    const dailyCommand: ResearchCommand = {
      jobType: "daily",
      assetClass: "equity",
      depth: "brief",
    };

    expect(evidenceFor(tickerCommand, {}).earningsSetup).toBeUndefined();
    expect(evidenceFor(tickerCommand, { earningsSetup: earningsSetupValue }).earningsSetup).toEqual(
      earningsSetupValue,
    );
    expect(
      evidenceFor(dailyCommand, { earningsSetup: earningsSetupValue }).earningsSetup,
    ).toBeUndefined();
  });

  test("resolved-identity projector contributes both of its keys only when present", () => {
    const command: ResearchCommand = {
      jobType: "ticker",
      assetClass: "equity",
      symbol: "AAPL",
      depth: "deep",
    };

    expect(evidenceFor(command, {}).resolvedInstrumentIdentity).toBeUndefined();
    expect(evidenceFor(command, {}).resolvedIdentityInstruction).toBeUndefined();

    const evidence = evidenceFor(command, {
      resolvedInstrumentIdentity: resolvedIdentityValue,
    });
    expect(evidence.resolvedInstrumentIdentity).toEqual(resolvedIdentityValue);
    expect(evidence.resolvedIdentityInstruction).toBeDefined();
  });
});
