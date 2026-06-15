import type { ResearchReport, RunTrace, Source, SourceGap } from "../domain/types";
import { isRepeatFallbackGap, sourceGapAnalyticsClass } from "../domain/source-gaps";
import { isRecord } from "../sources/guards";
import type { CollectedSources, NewsCollectionAnalytics } from "../sources/types";

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
}

export interface RunAnalytics {
  readonly version: 1;
  readonly runId: string;
  readonly generatedAt: string;
  readonly jobType: ResearchReport["jobType"];
  readonly assetClass: ResearchReport["assetClass"];
  readonly symbol?: string;
  readonly depth: RunTrace["depth"];
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
    readonly forecastDisagreement?: {
      readonly participantCount: number;
      readonly successfulParticipantCount: number;
      readonly errorCount: number;
      readonly highDisagreementCount: number;
    };
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

export function buildRunAnalytics(input: BuildRunAnalyticsInput): RunAnalytics {
  const { collectedSources, report, trace } = input;
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

  return {
    version: 1,
    runId: report.runId,
    generatedAt: report.generatedAt,
    jobType: report.jobType,
    assetClass: report.assetClass,
    ...(report.symbol !== undefined ? { symbol: report.symbol } : {}),
    depth: trace.depth,
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
      byKind: countBy(report.predictions, (prediction) => prediction.kind),
      horizonTradingDays: horizonStats(
        report.predictions.map((prediction) => prediction.horizonTradingDays),
      ),
      citedCount,
      uncitedCount: report.predictions.length - citedCount,
      targetCount: input.targetPredictions,
      targetMet: report.predictions.length >= input.targetPredictions,
      ...(forecastDisagreement !== undefined ? { forecastDisagreement } : {}),
    },
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
