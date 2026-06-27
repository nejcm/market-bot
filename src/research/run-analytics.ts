import type { ResearchReport, RunTrace, Source, SourceGap } from "../domain/types";
import { isRepeatFallbackGap, sourceGapAnalyticsClass } from "../domain/source-gaps";
import { isRecord } from "../sources/guards";
import type { CollectedSources, NewsCollectionAnalytics } from "../sources/types";
import { brierSkillScore } from "../scoring/calibration";
import type { CalibrationContext } from "./research-context-types";
import type { EvidenceLaneSummary } from "./source-plan";

export interface RunAnalyticsStage {
  readonly stage: string;
  readonly content: string;
  readonly tokenEstimate: number;
  readonly costEstimateUsd: number;
}

export interface BuildRunAnalyticsInput {
  readonly report: ResearchReport;
  readonly trace: RunTrace;
  readonly collectedSources: CollectedSources;
  readonly stageOutputs: readonly RunAnalyticsStage[];
  readonly targetPredictions: number;
  readonly sourcePlanSummary?: EvidenceLaneSummary;
  readonly calibrationContext?: CalibrationContext;
}

export interface RunAnalytics {
  readonly version: 1;
  readonly runId: string;
  readonly generatedAt: string;
  readonly jobType: ResearchReport["jobType"];
  readonly assetClass: ResearchReport["assetClass"];
  readonly symbol?: string;
  readonly depth: RunTrace["depth"];
  readonly codeVersion?: RunTrace["codeVersion"];
  readonly sourceFunnel: {
    readonly rawSnapshots: {
      readonly total: number;
      readonly byAdapter: Readonly<Record<string, number>>;
    };
    readonly reportSources: {
      readonly total: number;
      readonly byKind: Readonly<Record<string, number>>;
      readonly byProvider: Readonly<Record<string, number>>;
    };
    readonly sourceGaps: {
      readonly total: number;
      readonly bySource: Readonly<Record<string, number>>;
    };
    readonly sourceGapClasses: {
      readonly missingCredential: number;
      readonly fetchFailed: number;
      readonly unsupportedCoverage: number;
      readonly other: number;
    };
    readonly dataGaps: {
      readonly total: number;
    };
  };
  readonly newsDedupe: NewsCollectionAnalytics;
  readonly evidenceQuality: {
    readonly confidence: ResearchReport["confidence"];
    readonly dataGapCount: number;
    readonly extendedEvidence: {
      readonly itemCount: number;
      readonly gapCount: number;
      readonly itemsByCategory: Readonly<Record<string, number>>;
      readonly gapsBySource: Readonly<Record<string, number>>;
    };
    readonly marketContext: {
      readonly itemCount: number;
      readonly gapCount: number;
      readonly itemsByCategory: Readonly<Record<string, number>>;
      readonly gapsBySource: Readonly<Record<string, number>>;
    };
    readonly evidenceRequestLoop?: {
      readonly rounds: number;
      readonly acceptedRequestCount: number;
      readonly rejectedRequestCount: number;
      readonly sourceUnitsUsed: number;
      readonly executedTools: readonly string[];
      readonly emittedGapCount: number;
    };
  };
  readonly predictions: {
    readonly count: number;
    readonly retryErrorCount: number;
    readonly validationErrorCount: number;
    readonly trimWarningCount: number;
    readonly replacementAttempted: boolean;
    readonly byKind: Readonly<Record<string, number>>;
    readonly horizonTradingDays: {
      readonly min?: number;
      readonly max?: number;
      readonly average?: number;
    };
    readonly citedCount: number;
    readonly uncitedCount: number;
    readonly targetCount: number;
    readonly targetMet: boolean;
    readonly shortfall?: {
      readonly emittedCount: number;
      readonly targetCount: number;
      readonly missingCount: number;
      readonly disclosed: boolean;
    };
    readonly forecastDisagreement?: {
      readonly participantCount: number;
      readonly successfulParticipantCount: number;
      readonly errorCount: number;
      readonly highDisagreementCount: number;
    };
    /** Count of emitted predictions whose probability is within NEAR_BASE_RATE_BAND of 0.5. */
    readonly nearBaseRateCount: number;
    /** Count of emitted predictions outside the near-base-rate band (more informative). */
    readonly informativeCount: number;
    /** True when informativeCount meets the SIGNAL_INFORMATIVE_FLOOR relative to emitted count. */
    readonly signalTargetMet: boolean;
    /** Non-blocking warnings about prediction-mix quality (direction-only, all near base rate). */
    readonly mixWarnings: readonly string[];
  };
  readonly postSynthesisAudit?: {
    readonly warningCount: number;
    readonly byCode: Readonly<Record<string, number>>;
  };
  readonly sourcePlan?: {
    readonly plannedLaneCount: number;
    readonly requiredLaneCount: number;
    readonly optionalLaneCount: number;
  };
  readonly evidenceLanes?: {
    readonly coveredLaneCount: number;
    readonly gapLaneCount: number;
    readonly requiredGapLaneCount: number;
    readonly sourceCount: number;
    readonly gapCount: number;
    readonly coverageRatio: number;
  };
  readonly calibrationAtGeneration?: {
    readonly generatedAt?: string;
    readonly resolvedCount?: number;
    readonly assetClass?: RunAnalyticsCalibrationSlice;
    readonly jobType?: RunAnalyticsCalibrationSlice;
    readonly marketUpdateHorizonBucket?: RunAnalyticsCalibrationSlice;
  };
  readonly verifiedMarketSnapshot?: {
    readonly symbol: string;
    readonly analysisDate: string;
    readonly latestSessionDate: string;
    readonly fetchedAt: string;
    readonly latestSessionAgeDays: number;
  };
  readonly runShape: {
    readonly traceStages: readonly string[];
    readonly stages: readonly {
      readonly stage: string;
      readonly tokenEstimate: number;
      readonly costEstimateUsd: number;
    }[];
    readonly tokenEstimate: number;
    readonly costEstimateUsd: number;
    readonly durationMs?: number;
  };
}

// ---------------------------------------------------------------------------
// Forecast-quality telemetry constants (analytics-only, never rejection gates)
// ---------------------------------------------------------------------------

/** Predictions within this distance of 0.5 probability are "near base rate". */
const NEAR_BASE_RATE_BAND = 0.05;

/**
 * Minimum fraction of emitted predictions that must be outside the near-base-rate
 * band for `signalTargetMet` to be true.
 */
const SIGNAL_INFORMATIVE_FLOOR = 0.5;

function isNearBaseRateProbability(probability: number): boolean {
  return Math.abs(probability - 0.5) <= NEAR_BASE_RATE_BAND + Number.EPSILON;
}

export interface RunAnalyticsCalibrationSlice {
  readonly key: string;
  readonly brierScore: number;
  readonly brierSkillScore: number;
  readonly count: number;
}

function countBy<T>(
  items: readonly T[],
  keyFor: (item: T) => string | undefined,
): Record<string, number> {
  const counts: Record<string, number> = {};

  for (const item of items) {
    const key = keyFor(item) ?? "unknown";
    counts[key] = (counts[key] ?? 0) + 1;
  }

  return counts;
}

function sourceProvider(source: Source): string | undefined {
  if (source.provider !== undefined) {
    return source.provider;
  }
  return source.providerAliases?.[0]?.provider;
}

function sourceGaps(collectedSources: CollectedSources): readonly SourceGap[] {
  return collectedSources.sourceGaps;
}

function sourceGapClasses(
  gaps: readonly SourceGap[],
): RunAnalytics["sourceFunnel"]["sourceGapClasses"] {
  const classes = countBy(gaps, sourceGapAnalyticsClass);
  return {
    missingCredential: classes.missingCredential ?? 0,
    fetchFailed: classes.fetchFailed ?? 0,
    unsupportedCoverage: classes.unsupportedCoverage ?? 0,
    other: classes.other ?? 0,
  };
}

function selectedNewsAliasDuplicateCount(sources: readonly Source[]): number {
  return sources
    .filter((source) => source.kind === "news")
    .reduce((total, source) => total + Math.max(0, (source.providerAliases?.length ?? 1) - 1), 0);
}

function newsDedupe(input: BuildRunAnalyticsInput): RunAnalytics["newsDedupe"] {
  const { newsAnalytics } = input.collectedSources;
  if (newsAnalytics !== undefined) {
    return newsAnalytics;
  }

  const selectedNewsSources = input.report.sources.filter((source) => source.kind === "news");
  const selectedAliasDuplicates = selectedNewsAliasDuplicateCount(selectedNewsSources);
  return {
    // Legacy reports do not preserve pre-selection counts; this reconstructs a lower-bound estimate.
    fetchedNewsSourcesByProvider: countBy(selectedNewsSources, sourceProvider),
    fetchedNewsSourceCount: selectedNewsSources.length + selectedAliasDuplicates,
    canonicalDedupedNewsSourceCount: selectedNewsSources.length,
    canonicalDuplicateNewsSourceCount: selectedAliasDuplicates,
    persistentSuppressedNewsSourceCount: 0,
    relevantBeforeSeenFilterCount: 0,
    relevantSuppressedBySeenFilterCount: 0,
    relevantSelectedCount: 0,
    repeatFallbackKeptCount: 0,
    selectedNewsSourceCount: selectedNewsSources.length,
    repeatFallbackUsed: sourceGaps(input.collectedSources).some((gap) => isRepeatFallbackGap(gap)),
  };
}

function horizonStats(
  horizons: readonly number[],
): RunAnalytics["predictions"]["horizonTradingDays"] {
  if (horizons.length === 0) {
    return {};
  }

  const total = horizons.reduce((sum, horizon) => sum + horizon, 0);
  return {
    min: Math.min(...horizons),
    max: Math.max(...horizons),
    average: total / horizons.length,
  };
}

function durationMs(trace: RunTrace): number | undefined {
  const startedAt = Date.parse(trace.startedAt);
  const completedAt = Date.parse(trace.completedAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt)) {
    return undefined;
  }

  return Math.max(0, completedAt - startedAt);
}

function dateAgeDays(fromDate: string, toDate: string): number | undefined {
  const from = Date.parse(`${fromDate}T00:00:00.000Z`);
  const to = Date.parse(`${toDate}T00:00:00.000Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    return undefined;
  }
  return Math.max(0, Math.round((to - from) / (24 * 60 * 60 * 1000)));
}

function calibrationMetricSlice(
  metrics: Record<string, { readonly brierScore: number; readonly count: number }> | undefined,
  key: string | undefined,
): RunAnalyticsCalibrationSlice | undefined {
  if (metrics === undefined || key === undefined) {
    return undefined;
  }

  const metric = metrics[key];
  if (
    metric === undefined ||
    !Number.isFinite(metric.brierScore) ||
    !Number.isFinite(metric.count)
  ) {
    return undefined;
  }

  return {
    key,
    brierScore: metric.brierScore,
    brierSkillScore: brierSkillScore(metric.brierScore),
    count: metric.count,
  };
}

function calibrationAtGeneration(
  input: BuildRunAnalyticsInput,
): RunAnalytics["calibrationAtGeneration"] {
  const calibration = input.calibrationContext;
  if (calibration === undefined) {
    return undefined;
  }

  const assetClass = calibrationMetricSlice(calibration.byAssetClass, input.report.assetClass);
  const jobType = calibrationMetricSlice(calibration.byJobType, input.report.jobType);
  const marketUpdateHorizonBucket = calibrationMetricSlice(
    calibration.byMarketUpdateHorizonBucket,
    input.trace.marketUpdateHorizonBucket,
  );
  if (
    calibration.generatedAt === undefined &&
    calibration.resolvedCount === undefined &&
    assetClass === undefined &&
    jobType === undefined &&
    marketUpdateHorizonBucket === undefined
  ) {
    return undefined;
  }

  return {
    ...(calibration.generatedAt !== undefined ? { generatedAt: calibration.generatedAt } : {}),
    ...(calibration.resolvedCount !== undefined
      ? { resolvedCount: calibration.resolvedCount }
      : {}),
    ...(assetClass !== undefined ? { assetClass } : {}),
    ...(jobType !== undefined ? { jobType } : {}),
    ...(marketUpdateHorizonBucket !== undefined ? { marketUpdateHorizonBucket } : {}),
  };
}

function verifiedMarketSnapshotFreshness(
  collectedSources: CollectedSources,
): RunAnalytics["verifiedMarketSnapshot"] {
  const snapshot = collectedSources.verifiedMarketSnapshot;
  if (snapshot === undefined) {
    return undefined;
  }

  const latestSessionAgeDays = dateAgeDays(snapshot.latestSessionDate, snapshot.analysisDate);
  return latestSessionAgeDays === undefined
    ? undefined
    : {
        symbol: snapshot.symbol,
        analysisDate: snapshot.analysisDate,
        latestSessionDate: snapshot.latestSessionDate,
        fetchedAt: snapshot.fetchedAt,
        latestSessionAgeDays,
      };
}

export function buildRunAnalytics(input: BuildRunAnalyticsInput): RunAnalytics {
  const { collectedSources, report, sourcePlanSummary, trace } = input;
  const gaps = sourceGaps(collectedSources);
  const { extendedEvidence, marketContext } = collectedSources;
  const runDurationMs = durationMs(trace);
  const citedCount = input.report.predictions.filter(
    (prediction) => prediction.sourceIds.length > 0,
  ).length;
  const evidenceRequestLoop =
    trace.evidenceRequestLoop === undefined
      ? undefined
      : {
          rounds: trace.evidenceRequestLoop.rounds,
          acceptedRequestCount: trace.evidenceRequestLoop.acceptedRequests.length,
          rejectedRequestCount: trace.evidenceRequestLoop.rejectedRequests.length,
          sourceUnitsUsed: trace.evidenceRequestLoop.sourceUnitsUsed,
          executedTools: trace.evidenceRequestLoop.executedTools,
          emittedGapCount: trace.evidenceRequestLoop.emittedGaps.length,
        };
  const forecastDisagreement =
    trace.forecastDisagreement === undefined ||
    !isRecord(report.extras?.forecastDisagreement) ||
    !Array.isArray(report.extras.forecastDisagreement.predictions)
      ? undefined
      : {
          participantCount: trace.forecastDisagreement.participantCount,
          successfulParticipantCount: trace.forecastDisagreement.successfulParticipantCount,
          errorCount: trace.forecastDisagreement.errorCount,
          highDisagreementCount: report.extras.forecastDisagreement.predictions.filter(
            (item) => isRecord(item) && item.band === "high",
          ).length,
        };
  const missingPredictionCount = Math.max(0, input.targetPredictions - report.predictions.length);
  const predictionShortfall =
    missingPredictionCount === 0
      ? undefined
      : {
          emittedCount: report.predictions.length,
          targetCount: input.targetPredictions,
          missingCount: missingPredictionCount,
          disclosed: report.dataGaps.some((gap) => gap.startsWith("predictionShortfall:")),
        };

  const emittedPredictions = report.predictions;
  const nearBaseRateCount = emittedPredictions.filter((prediction) =>
    isNearBaseRateProbability(prediction.probability),
  ).length;
  const informativeCount = emittedPredictions.length - nearBaseRateCount;
  const signalTargetMet =
    emittedPredictions.length === 0 ||
    informativeCount / emittedPredictions.length >= SIGNAL_INFORMATIVE_FLOOR;
  const mixWarnings: string[] = [];
  if (emittedPredictions.length > 0 && emittedPredictions.every((p) => p.kind === "direction")) {
    mixWarnings.push(
      "all emitted predictions are direction kind; consider more informative kinds such as relative, range, or macro",
    );
  }
  if (emittedPredictions.length > 0 && nearBaseRateCount === emittedPredictions.length) {
    mixWarnings.push(
      "all emitted probabilities cluster near the base rate of 0.5; predictions carry limited signal",
    );
  }
  const calibrationSnapshot = calibrationAtGeneration(input);
  const verifiedSnapshot = verifiedMarketSnapshotFreshness(collectedSources);
  const postSynthesisAudit =
    trace.postSynthesisAudit === undefined
      ? undefined
      : {
          warningCount: trace.postSynthesisAudit.warningCount,
          byCode: countBy(trace.postSynthesisAudit.warnings, (warning) => warning.code),
        };

  return {
    version: 1,
    runId: report.runId,
    generatedAt: report.generatedAt,
    jobType: report.jobType,
    assetClass: report.assetClass,
    ...(report.symbol !== undefined ? { symbol: report.symbol } : {}),
    depth: trace.depth,
    ...(trace.codeVersion !== undefined ? { codeVersion: trace.codeVersion } : {}),
    sourceFunnel: {
      rawSnapshots: {
        total: collectedSources.rawSnapshots.length,
        byAdapter: countBy(collectedSources.rawSnapshots, (snapshot) => snapshot.adapter),
      },
      reportSources: {
        total: report.sources.length,
        byKind: countBy(report.sources, (source) => source.kind),
        byProvider: countBy(report.sources, sourceProvider),
      },
      sourceGaps: {
        total: gaps.length,
        bySource: countBy(gaps, (gap) => gap.source),
      },
      sourceGapClasses: sourceGapClasses(gaps),
      dataGaps: {
        total: report.dataGaps.length,
      },
    },
    newsDedupe: newsDedupe(input),
    evidenceQuality: {
      confidence: report.confidence,
      dataGapCount: report.dataGaps.length,
      extendedEvidence: {
        itemCount: extendedEvidence?.items.length ?? 0,
        gapCount: extendedEvidence?.gaps.length ?? 0,
        itemsByCategory: countBy(extendedEvidence?.items ?? [], (item) => item.category),
        gapsBySource: countBy(extendedEvidence?.gaps ?? [], (gap) => gap.source),
      },
      marketContext: {
        itemCount: marketContext?.items.length ?? 0,
        gapCount: marketContext?.gaps.length ?? 0,
        itemsByCategory: countBy(marketContext?.items ?? [], (item) => item.category),
        gapsBySource: countBy(marketContext?.gaps ?? [], (gap) => gap.source),
      },
      ...(evidenceRequestLoop !== undefined ? { evidenceRequestLoop } : {}),
    },
    predictions: {
      count: report.predictions.length,
      retryErrorCount: trace.predictionRetryErrors?.length ?? 0,
      validationErrorCount: trace.predictionErrors?.length ?? 0,
      trimWarningCount: trace.predictionTrimWarnings?.length ?? 0,
      replacementAttempted: trace.predictionReplacementAttempted ?? false,
      byKind: countBy(report.predictions, (prediction) => prediction.kind),
      horizonTradingDays: horizonStats(
        report.predictions.map((prediction) => prediction.horizonTradingDays),
      ),
      citedCount,
      uncitedCount: report.predictions.length - citedCount,
      targetCount: input.targetPredictions,
      targetMet: report.predictions.length >= input.targetPredictions,
      ...(predictionShortfall !== undefined ? { shortfall: predictionShortfall } : {}),
      ...(forecastDisagreement !== undefined ? { forecastDisagreement } : {}),
      nearBaseRateCount,
      informativeCount,
      signalTargetMet,
      mixWarnings,
    },
    ...(postSynthesisAudit !== undefined ? { postSynthesisAudit } : {}),
    ...(sourcePlanSummary !== undefined
      ? {
          sourcePlan: {
            plannedLaneCount: sourcePlanSummary.plannedLaneCount,
            requiredLaneCount: sourcePlanSummary.requiredLaneCount,
            optionalLaneCount: sourcePlanSummary.optionalLaneCount,
          },
          evidenceLanes: {
            coveredLaneCount: sourcePlanSummary.coveredLaneCount,
            gapLaneCount: sourcePlanSummary.gapLaneCount,
            requiredGapLaneCount: sourcePlanSummary.requiredGapLaneCount,
            sourceCount: sourcePlanSummary.sourceCount,
            gapCount: sourcePlanSummary.gapCount,
            coverageRatio: sourcePlanSummary.coverageRatio,
          },
        }
      : {}),
    ...(calibrationSnapshot !== undefined ? { calibrationAtGeneration: calibrationSnapshot } : {}),
    ...(verifiedSnapshot !== undefined ? { verifiedMarketSnapshot: verifiedSnapshot } : {}),
    runShape: {
      traceStages: trace.stages,
      stages: input.stageOutputs.map((output) => ({
        stage: output.stage,
        tokenEstimate: output.tokenEstimate,
        costEstimateUsd: output.costEstimateUsd,
      })),
      tokenEstimate: trace.tokenEstimate,
      costEstimateUsd: trace.costEstimateUsd,
      ...(runDurationMs !== undefined ? { durationMs: runDurationMs } : {}),
    },
  };
}
