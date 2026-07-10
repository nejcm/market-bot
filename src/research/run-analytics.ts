import {
  NEAR_BASE_RATE_BAND,
  researchReportEvidenceQuality,
  type ReportIntegrity,
  type ResearchReport,
  type RunTrace,
  type Source,
  type SourceGap,
} from "../domain/types";
import { isRepeatFallbackGap, sourceGapAnalyticsClass } from "../domain/source-gaps";
import { isRecord } from "../sources/guards";
import type { CollectedSources, NewsCollectionAnalytics } from "../sources/types";
import { brierSkillScore } from "../scoring/calibration";
import type { CalibrationMetric } from "../scoring/types";
import {
  applicableCalibrationSlices,
  type ApplicableCalibrationKeys,
  type CalibrationGuidanceDimension,
  type CalibrationGuidanceReason,
} from "./calibration-guidance";
import type { CalibrationContext } from "./research-context-types";
import type { CostPricing } from "../model/pricing";
import type { StageRepromptReason } from "./final-synthesis";
import type { EvidenceLaneSummaryV2 } from "./source-plan";
import { DAY_MS } from "../config/shared";
import { CODE_ASSEMBLED_EXTENDED_EVIDENCE_EXTRA_KEYS } from "./extended-evidence-projections";
import { roundWebSubjectProfileAgeDays } from "./web-subject-profile-age";

export interface RunAnalyticsStage {
  readonly stage: string;
  readonly content: string;
  readonly tokenEstimate: number;
  readonly durationMs?: number;
  readonly costEstimateUsd?: number;
  readonly costPricing?: CostPricing;
  readonly attempt?: number;
  readonly repromptReason?: StageRepromptReason;
}

export interface BuildRunAnalyticsInput {
  readonly report: ResearchReport;
  readonly trace: RunTrace;
  readonly collectedSources: CollectedSources;
  readonly stageOutputs: readonly RunAnalyticsStage[];
  readonly targetPredictions: number;
  readonly sourcePlanSummary?: EvidenceLaneSummaryV2;
  readonly calibrationContext?: CalibrationContext;
  readonly calibrationGuidanceKeys?: ApplicableCalibrationKeys;
}

export interface RunAnalytics {
  readonly version: 2;
  readonly runId: string;
  readonly generatedAt: string;
  readonly jobType: ResearchReport["jobType"];
  readonly assetClass: ResearchReport["assetClass"];
  readonly symbol?: string;
  readonly depth: RunTrace["depth"];
  readonly codeVersion?: RunTrace["codeVersion"];
  readonly reproducibility?: RunTrace["reproducibility"];
  readonly modelInputSanitization?: RunTrace["modelInputSanitization"];
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
    readonly label?: ResearchReport["evidenceQuality"];
    readonly confidence?: ResearchReport["confidence"];
    readonly assessment?: RunTrace["evidenceQualityAssessment"];
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
    readonly completion?: {
      readonly attempted: boolean;
      readonly initialCount: number;
      readonly acceptedCount: number;
      readonly rejectedCount: number;
      readonly outcome: "improved" | "no-eligible-candidates" | "failed";
    };
    /** Legacy artifact compatibility. */
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
  readonly reportIntegrity?: {
    readonly label: ReportIntegrity;
    readonly researchQuality: ReportIntegrity;
    readonly prunedItemCount: number;
    readonly advisoryWarningCount: number;
  };
  readonly sourcePlan?: {
    readonly plannedLaneCount: number;
    readonly coreLaneCount: number;
    readonly materialLaneCount: number;
    readonly supplementalLaneCount: number;
  };
  readonly evidenceLanes?: {
    readonly coveredLaneCount: number;
    readonly gapLaneCount: number;
    readonly coreGapLaneCount: number;
    readonly materialGapLaneCount: number;
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
    readonly guidanceAssessments?: readonly RunAnalyticsCalibrationGuidanceAssessment[];
  };
  readonly verifiedMarketSnapshot?: {
    readonly symbol: string;
    readonly analysisDate: string;
    readonly latestSessionDate: string;
    readonly fetchedAt: string;
    readonly latestSessionAgeDays: number;
  };
  readonly webSources?: {
    readonly accepted: number;
    readonly profileUsed: number;
    readonly reportCited: number;
    /** Current-run web sources cited only in authored extras (e.g. earningsSetup), not in
     *  primary report claims or Predictions. Kept distinct so `unused` reflects genuinely
     *  uncited sources rather than conflating extras citations with dead evidence. */
    readonly extrasCited: number;
    readonly unused: number;
    readonly usageRatio: number;
    readonly usageWarning?: string;
  };
  readonly reusedProfileWebSources?: {
    readonly accepted: number;
    readonly reportCited: number;
    readonly generatedAt: string;
    readonly ageDays: number;
    readonly runDirName: string;
  };
  readonly runShape: {
    readonly traceStages: readonly string[];
    readonly stages: readonly {
      readonly stage: string;
      readonly tokenEstimate: number;
      readonly durationMs?: number;
      readonly costEstimateUsd?: number;
      readonly costPricing?: CostPricing;
      readonly attempt?: number;
      readonly repromptReason?: StageRepromptReason;
    }[];
    readonly tokenEstimate: number;
    readonly costEstimateUsd?: number;
    readonly costPricing?: readonly CostPricing[];
    readonly durationMs?: number;
  };
}

// ---------------------------------------------------------------------------
// Forecast-quality telemetry constants (analytics-only, never rejection gates)
// ---------------------------------------------------------------------------

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

export interface RunAnalyticsCalibrationGuidanceAssessment {
  readonly dimension: CalibrationGuidanceDimension;
  readonly key: string;
  readonly brierScore?: number;
  readonly count?: number;
  readonly runCount?: number;
  readonly brierStandardError?: number;
  readonly lowerConfidenceBound?: number;
  readonly actionable: boolean;
  readonly reason: CalibrationGuidanceReason;
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

function timestampAgeDays(fromTimestamp: string, toTimestamp: string): number | undefined {
  const from = Date.parse(fromTimestamp);
  const to = Date.parse(toTimestamp);
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    return undefined;
  }
  // One-decimal precision so a 1.7-day-old reused profile is not disclosed as 1 day.
  return Math.max(0, roundWebSubjectProfileAgeDays((to - from) / DAY_MS));
}

function calibrationMetricSlice(
  metrics: Record<string, CalibrationMetric> | undefined,
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
  const guidanceAssessments =
    input.calibrationGuidanceKeys === undefined
      ? undefined
      : applicableCalibrationSlices(calibration, input.calibrationGuidanceKeys).map(
          ({ dimension, key, metric, actionable, reason, lowerConfidenceBound }) => ({
            dimension,
            key,
            ...(metric !== undefined
              ? {
                  brierScore: metric.brierScore,
                  count: metric.count,
                  ...(metric.runCount !== undefined ? { runCount: metric.runCount } : {}),
                  ...(metric.brierStandardError !== undefined
                    ? { brierStandardError: metric.brierStandardError }
                    : {}),
                }
              : {}),
            ...(lowerConfidenceBound !== undefined ? { lowerConfidenceBound } : {}),
            actionable,
            reason,
          }),
        );
  if (
    calibration.generatedAt === undefined &&
    calibration.resolvedCount === undefined &&
    assetClass === undefined &&
    jobType === undefined &&
    marketUpdateHorizonBucket === undefined &&
    guidanceAssessments === undefined
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
    ...(guidanceAssessments !== undefined ? { guidanceAssessments } : {}),
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

// Recursively collect every sourceId string reachable under report.extras, excluding the
// Code-assembled Extended Evidence subtrees declared by the projection seam. Authored extras such
// As earningsSetup, businessFramework, spotlights, and historicalContext nest {text, sourceIds}
// Bullets at varying depths, so a walk keeps telemetry robust to extras shape changes.
function collectExtrasSourceIds(extras: Record<string, unknown> | undefined): Set<string> {
  const ids = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }
    if (!isRecord(value)) {
      return;
    }
    for (const [key, nested] of Object.entries(value)) {
      if (CODE_ASSEMBLED_EXTENDED_EVIDENCE_EXTRA_KEYS.has(key)) {
        continue;
      }
      if (key === "sourceIds" && Array.isArray(nested)) {
        for (const id of nested) {
          if (typeof id === "string") {
            ids.add(id);
          }
        }
        continue;
      }
      visit(nested);
    }
  };
  visit(extras);
  return ids;
}

function webSourceRoles(
  report: ResearchReport,
  collectedSources: CollectedSources,
): Pick<RunAnalytics, "webSources" | "reusedProfileWebSources"> {
  const reuse = collectedSources.webSubjectProfileReuse;
  const acceptedIds = new Set(
    report.sources.filter((source) => source.kind === "web").map((source) => source.id),
  );
  if (acceptedIds.size === 0 && reuse === undefined) {
    return {};
  }
  const reusedProfileIds = new Set(
    reuse === undefined
      ? []
      : (collectedSources.webSubjectProfile?.sourceIds ?? []).filter((id) => acceptedIds.has(id)),
  );
  const reusedProfileAgeDays =
    reuse === undefined ? undefined : timestampAgeDays(reuse.generatedAt, report.generatedAt);
  const currentRunIds = new Set([...acceptedIds].filter((id) => !reusedProfileIds.has(id)));
  const profileUsedIds = new Set(
    (collectedSources.webSubjectProfile?.sourceIds ?? []).filter((id) => currentRunIds.has(id)),
  );
  const reportCitedIds = new Set(
    [
      ...report.keyFindings,
      ...report.bullCase,
      ...report.bearCase,
      ...report.risks,
      ...report.catalysts,
      ...report.scenarios,
      ...report.predictions,
    ]
      .flatMap((item) => item.sourceIds)
      .filter((id) => acceptedIds.has(id)),
  );
  const currentRunReportCitedIds = new Set(
    [...reportCitedIds].filter((id) => currentRunIds.has(id)),
  );
  // Web sources cited only in authored extras count as real usage, so fold them into the
  // Usage union (keeps `unused` and usageWarning from flagging genuinely used sources) while
  // Reporting them separately from primary reportCited (run-review finding #1).
  const extrasCitedIds = new Set(
    [...collectExtrasSourceIds(report.extras)].filter((id) => acceptedIds.has(id)),
  );
  const currentRunExtrasCitedIds = new Set(
    [...extrasCitedIds].filter((id) => currentRunIds.has(id) && !currentRunReportCitedIds.has(id)),
  );
  const usedUnion = new Set([...profileUsedIds, ...reportCitedIds, ...extrasCitedIds]);
  const currentRunUsedUnion = new Set([...usedUnion].filter((id) => currentRunIds.has(id)));
  const usageRatio = currentRunIds.size === 0 ? 0 : currentRunUsedUnion.size / currentRunIds.size;
  return {
    ...(currentRunIds.size === 0
      ? {}
      : {
          webSources: {
            accepted: currentRunIds.size,
            profileUsed: profileUsedIds.size,
            reportCited: currentRunReportCitedIds.size,
            extrasCited: currentRunExtrasCitedIds.size,
            unused: currentRunIds.size - currentRunUsedUnion.size,
            usageRatio,
            ...(currentRunIds.size >= 4 && usageRatio < 0.25
              ? {
                  usageWarning:
                    "Accepted web-source usage is disproportionately low; review gather relevance and synthesis citations.",
                }
              : {}),
          },
        }),
    ...(reuse !== undefined && reusedProfileIds.size > 0 && reusedProfileAgeDays !== undefined
      ? {
          reusedProfileWebSources: {
            accepted: reusedProfileIds.size,
            reportCited: [...reportCitedIds].filter((id) => reusedProfileIds.has(id)).length,
            generatedAt: reuse.generatedAt,
            ageDays: reusedProfileAgeDays,
            runDirName: reuse.runDirName,
          },
        }
      : {}),
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
    version: 2,
    runId: report.runId,
    generatedAt: report.generatedAt,
    jobType: report.jobType,
    assetClass: report.assetClass,
    ...(report.symbol !== undefined ? { symbol: report.symbol } : {}),
    depth: trace.depth,
    ...(trace.codeVersion !== undefined ? { codeVersion: trace.codeVersion } : {}),
    ...(trace.reproducibility !== undefined ? { reproducibility: trace.reproducibility } : {}),
    ...(trace.modelInputSanitization !== undefined
      ? { modelInputSanitization: trace.modelInputSanitization }
      : {}),
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
      label: researchReportEvidenceQuality(report),
      ...(trace.evidenceQualityAssessment !== undefined
        ? { assessment: trace.evidenceQualityAssessment }
        : {}),
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
      ...(trace.predictionCompletion !== undefined
        ? {
            completion: {
              attempted: trace.predictionCompletion.attempted,
              initialCount: trace.predictionCompletion.initialCount,
              acceptedCount: trace.predictionCompletion.acceptedPredictionIds.length,
              rejectedCount: trace.predictionCompletion.rejectedCandidateCount,
              outcome: trace.predictionCompletion.outcome,
            },
          }
        : {}),
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
    ...(trace.reportIntegrityAudit !== undefined
      ? {
          reportIntegrity: {
            label: trace.reportIntegrityAudit.reportIntegrity,
            researchQuality: trace.reportIntegrityAudit.researchQuality,
            prunedItemCount: trace.reportIntegrityAudit.prunedItemCount,
            advisoryWarningCount: trace.reportIntegrityAudit.advisoryWarningCount,
          },
        }
      : {}),
    ...(sourcePlanSummary !== undefined
      ? {
          sourcePlan: {
            plannedLaneCount: sourcePlanSummary.plannedLaneCount,
            coreLaneCount: sourcePlanSummary.coreLaneCount,
            materialLaneCount: sourcePlanSummary.materialLaneCount,
            supplementalLaneCount: sourcePlanSummary.supplementalLaneCount,
          },
          evidenceLanes: {
            coveredLaneCount: sourcePlanSummary.coveredLaneCount,
            gapLaneCount: sourcePlanSummary.gapLaneCount,
            coreGapLaneCount: sourcePlanSummary.coreGapLaneCount,
            materialGapLaneCount: sourcePlanSummary.materialGapLaneCount,
            sourceCount: sourcePlanSummary.sourceCount,
            gapCount: sourcePlanSummary.gapCount,
            coverageRatio: sourcePlanSummary.coverageRatio,
          },
        }
      : {}),
    ...(calibrationSnapshot !== undefined ? { calibrationAtGeneration: calibrationSnapshot } : {}),
    ...(verifiedSnapshot !== undefined ? { verifiedMarketSnapshot: verifiedSnapshot } : {}),
    ...webSourceRoles(report, collectedSources),
    runShape: {
      traceStages: trace.stages,
      stages: input.stageOutputs.map((output) => ({
        stage: output.stage,
        tokenEstimate: output.tokenEstimate,
        ...(output.durationMs !== undefined ? { durationMs: output.durationMs } : {}),
        ...(output.costEstimateUsd !== undefined
          ? { costEstimateUsd: output.costEstimateUsd }
          : {}),
        ...(output.costPricing !== undefined ? { costPricing: output.costPricing } : {}),
        ...(output.attempt !== undefined ? { attempt: output.attempt } : {}),
        ...(output.repromptReason !== undefined ? { repromptReason: output.repromptReason } : {}),
      })),
      tokenEstimate: trace.tokenEstimate,
      ...(trace.costEstimateUsd !== undefined ? { costEstimateUsd: trace.costEstimateUsd } : {}),
      ...(trace.costPricing !== undefined ? { costPricing: trace.costPricing } : {}),
      ...(runDurationMs !== undefined ? { durationMs: runDurationMs } : {}),
    },
  };
}
