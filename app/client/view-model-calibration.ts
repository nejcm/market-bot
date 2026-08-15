import type { AlphaCohortDetail, CalibrationDetail, RunDetail } from "../types";
import { MIN_CALIBRATION_SAMPLE } from "../../src/scoring/calibration";
import { numberAt, readStringVerbatim } from "../../src/guards";
import { formatDateMinute, readFiniteNumber, readRecord, runLabel } from "./view-model-format";

export interface CalibrationHeadline {
  readonly brierScore?: number;
  readonly hitRate?: number;
  readonly resolvedCount: number;
  readonly generatedAt?: string;
}

export interface CalibrationSampleWarning {
  readonly show: boolean;
  readonly resolvedCount: number;
  readonly minimum: number;
}

export interface ReliabilityBin {
  readonly label: string;
  readonly pLow: number;
  readonly pHigh: number;
  readonly hitRate: number;
  readonly hitCount: number;
  readonly totalCount: number;
}

export interface CalibrationSliceRow {
  readonly key: string;
  readonly brierScore: number;
  readonly count: number;
}

export interface CalibrationAutopsyCauseRow {
  readonly cause: string;
  readonly count: number;
}

export interface RunCompareCard {
  readonly runId: string;
  readonly label: string;
  readonly generatedAt: string;
  readonly forecasts: string;
  readonly targetMet: boolean;
  readonly shortfall: string;
  readonly calibration: string;
  readonly snapshotFreshness: string;
}

export interface HistoricalContextAuditView {
  readonly scannedRunCount: number;
  readonly candidateRunCount: number;
  readonly selectedRunCount: number;
  readonly recentSelectedCount: number;
  readonly anchorSelectedCount: number;
  readonly sameSymbolSelectedCount: number;
  readonly spotlightSymbolSelectedCount: number;
  readonly sameSubjectSelectedCount: number;
  readonly sameHorizonSelectedCount: number;
  readonly crossHorizonSelectedCount: number;
  readonly resolvedMissRunCount: number;
  readonly missCorrectionSelectedCount: number;
  readonly gapCount: number;
}

export interface AlphaCohortHeadline {
  readonly generatedAt?: string;
  readonly rejectedCandidateCount: number;
  readonly watchlistCandidateCount: number;
  readonly tickerBriefedLeadCount: number;
  readonly unbriefedLeadCount: number;
}

export interface AlphaRejectionBucketRow {
  readonly reason: string;
  readonly rejectedCount: number;
  readonly uniqueSymbolCount: number;
  readonly laterValidatedSymbolCount: number;
  readonly validation: string;
}

export interface AlphaStaleLeadRow {
  readonly ageBucket: string;
  readonly unbriefedLeadCount: number;
  readonly validation: string;
}

export type CalibrationSliceGroup =
  | "byKind"
  | "byAssetClass"
  | "byJobType"
  | "byMarketUpdateHorizonBucket"
  | "byHorizonBucket"
  | "byMarketRegime";

const HORIZON_BUCKET_ORDER = ["1d", "2-5d", "6-10d", "11-15d", "16-20d"];

export function calibrationHeadline(detail: CalibrationDetail): CalibrationHeadline {
  const summary = detail.summary ?? {};
  const brierScore = readFiniteNumber(summary.brierScore);
  const hitRate = readFiniteNumber(summary.hitRate);
  const generatedAt = typeof summary.generatedAt === "string" ? summary.generatedAt : undefined;
  return {
    ...(brierScore !== undefined ? { brierScore } : {}),
    ...(hitRate !== undefined && hitRate >= 0 && hitRate <= 1 ? { hitRate } : {}),
    resolvedCount: readFiniteNumber(summary.resolvedCount) ?? 0,
    ...(generatedAt !== undefined ? { generatedAt } : {}),
  };
}

export function calibrationSampleWarning(headline: CalibrationHeadline): CalibrationSampleWarning {
  return {
    show: headline.resolvedCount < MIN_CALIBRATION_SAMPLE,
    resolvedCount: headline.resolvedCount,
    minimum: MIN_CALIBRATION_SAMPLE,
  };
}

export function reliabilityBins(detail: CalibrationDetail): readonly ReliabilityBin[] {
  const bins = detail.summary?.bins;
  if (!Array.isArray(bins)) {
    return [];
  }

  return bins
    .filter(
      (bin): bin is Record<string, unknown> =>
        typeof bin === "object" && bin !== null && !Array.isArray(bin),
    )
    .flatMap((bin) => {
      const pLow = readFiniteNumber(bin.pLow);
      const pHigh = readFiniteNumber(bin.pHigh);
      const hitRate = readFiniteNumber(bin.hitRate);
      const hitCount = readFiniteNumber(bin.hitCount);
      const totalCount = readFiniteNumber(bin.totalCount);
      const label = typeof bin.label === "string" ? bin.label : undefined;
      return pLow === undefined ||
        pHigh === undefined ||
        hitRate === undefined ||
        hitCount === undefined ||
        totalCount === undefined ||
        label === undefined
        ? []
        : [{ label, pLow, pHigh, hitRate, hitCount, totalCount }];
    })
    .toSorted((left, right) => left.pLow - right.pLow);
}

export function calibrationSlices(
  detail: CalibrationDetail,
  group: CalibrationSliceGroup,
): readonly CalibrationSliceRow[] {
  const slice = detail.summary?.[group];
  if (typeof slice !== "object" || slice === null || Array.isArray(slice)) {
    return [];
  }

  const rows = Object.entries(slice).flatMap(([key, metric]) => {
    if (typeof metric !== "object" || metric === null || Array.isArray(metric)) {
      return [];
    }

    const record = metric as Record<string, unknown>;
    const brierScore = readFiniteNumber(record.brierScore);
    const count = readFiniteNumber(record.count);
    return brierScore === undefined || count === undefined ? [] : [{ key, brierScore, count }];
  });

  return group === "byHorizonBucket" || group === "byMarketUpdateHorizonBucket"
    ? rows.toSorted((left, right) => horizonBucketRank(left.key) - horizonBucketRank(right.key))
    : rows.toSorted((left, right) => right.count - left.count);
}

export function calibrationAutopsyCauses(
  detail: CalibrationDetail,
): readonly CalibrationAutopsyCauseRow[] {
  const counts = detail.summary?.byMissAutopsyCause;
  if (typeof counts !== "object" || counts === null || Array.isArray(counts)) {
    return [];
  }
  return Object.entries(counts)
    .flatMap(([cause, value]) => {
      const count = readFiniteNumber(value);
      return count === undefined ? [] : [{ cause, count }];
    })
    .toSorted((left, right) => right.count - left.count || left.cause.localeCompare(right.cause));
}

function horizonBucketRank(bucket: string): number {
  const index = HORIZON_BUCKET_ORDER.indexOf(bucket);
  return index === -1 ? HORIZON_BUCKET_ORDER.length : index;
}

function formatSkill(value: number | undefined): string {
  if (value === undefined) {
    return "cal n/a";
  }
  return `skill ${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
}

function preferredCalibrationSlice(
  analytics: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const calibration = readRecord(analytics?.calibrationAtGeneration);
  return (
    readRecord(calibration?.marketUpdateHorizonBucket) ??
    readRecord(calibration?.jobType) ??
    readRecord(calibration?.assetClass)
  );
}

export function runCompareCards(details: readonly RunDetail[]): readonly RunCompareCard[] {
  return details.flatMap((detail) => {
    const { analytics } = detail;
    if (analytics === undefined) {
      return [];
    }

    const predictions = readRecord(analytics.predictions);
    const shortfall = readRecord(predictions?.shortfall);
    const targetCount = numberAt(predictions, ["targetCount"]);
    const count = numberAt(predictions, ["count"]);
    const targetMet = predictions?.targetMet === true;
    const calibration = preferredCalibrationSlice(analytics);
    const snapshot = readRecord(analytics.verifiedMarketSnapshot);
    const snapshotAge = readFiniteNumber(snapshot?.latestSessionAgeDays);
    const snapshotSymbol = readStringVerbatim(snapshot, "symbol");

    return [
      {
        runId: detail.summary.runId,
        label: runLabel(detail.summary),
        generatedAt: formatDateMinute(detail.summary.generatedAt),
        forecasts: targetCount > 0 ? `${String(count)}/${String(targetCount)}` : String(count),
        targetMet,
        shortfall:
          shortfall === undefined
            ? "none"
            : `${String(numberAt(shortfall, ["missingCount"]))} missing`,
        calibration: formatSkill(readFiniteNumber(calibration?.brierSkillScore)),
        snapshotFreshness:
          snapshotAge === undefined || snapshotSymbol === undefined
            ? "snapshot n/a"
            : `${snapshotSymbol} snapshot ${String(snapshotAge)}d`,
      },
    ];
  });
}

export function historicalContextAuditView(
  trace?: Record<string, unknown>,
): HistoricalContextAuditView | undefined {
  const audit = readRecord(trace?.historicalContext);
  if (audit === undefined) {
    return undefined;
  }

  return {
    scannedRunCount: numberAt(audit, ["scannedRunCount"]),
    candidateRunCount: numberAt(audit, ["candidateRunCount"]),
    selectedRunCount: numberAt(audit, ["selectedRunCount"]),
    recentSelectedCount: numberAt(audit, ["recentSelectedCount"]),
    anchorSelectedCount: numberAt(audit, ["anchorSelectedCount"]),
    sameSymbolSelectedCount: numberAt(audit, ["sameSymbolSelectedCount"]),
    spotlightSymbolSelectedCount: numberAt(audit, ["spotlightSymbolSelectedCount"]),
    sameSubjectSelectedCount: numberAt(audit, ["sameSubjectSelectedCount"]),
    sameHorizonSelectedCount: numberAt(audit, ["sameHorizonSelectedCount"]),
    crossHorizonSelectedCount: numberAt(audit, ["crossHorizonSelectedCount"]),
    resolvedMissRunCount: numberAt(audit, ["resolvedMissRunCount"]),
    missCorrectionSelectedCount: numberAt(audit, ["missCorrectionSelectedCount"]),
    gapCount: numberAt(audit, ["gapCount"]),
  };
}

export function alphaCohortHeadline(detail: AlphaCohortDetail): AlphaCohortHeadline {
  const { summary } = detail;
  const generatedAt = readStringVerbatim(summary, "generatedAt");
  return {
    ...(generatedAt !== undefined ? { generatedAt } : {}),
    rejectedCandidateCount: numberAt(summary, ["rejectedCandidateCount"]),
    watchlistCandidateCount: numberAt(summary, ["watchlistCandidateCount"]),
    tickerBriefedLeadCount: numberAt(summary, ["tickerBriefedLeadCount"]),
    unbriefedLeadCount: numberAt(summary, ["unbriefedLeadCount"]),
  };
}

function metricText(metrics: unknown): string {
  const record = readRecord(metrics);
  if (record === undefined) {
    return "n/a";
  }
  const rows = Object.entries(record)
    .toSorted(([left], [right]) => Number(left) - Number(right))
    .flatMap(([horizon, value]) => {
      const metric = readRecord(value);
      if (metric === undefined) {
        return [];
      }
      const resolvedCount = numberAt(metric, ["resolvedCount"]);
      if (resolvedCount === 0) {
        return [];
      }
      const hitRate = readFiniteNumber(metric.hitRate);
      const averageExcessReturn = readFiniteNumber(metric.averageExcessReturn);
      return [
        `${horizon}d ${hitRate === undefined ? "n/a" : `${(hitRate * 100).toFixed(1)}%`} hit · ${
          averageExcessReturn === undefined ? "n/a" : `${(averageExcessReturn * 100).toFixed(1)}%`
        } excess · n=${String(resolvedCount)}`,
      ];
    });
  return rows.length === 0 ? "n/a" : rows.join("; ");
}

export function alphaRejectionBucketRows(
  detail: AlphaCohortDetail,
): readonly AlphaRejectionBucketRow[] {
  const buckets = detail.summary?.rejectionBuckets;
  if (!Array.isArray(buckets)) {
    return [];
  }

  return buckets
    .filter((bucket): bucket is Record<string, unknown> => readRecord(bucket) !== undefined)
    .map((bucket) => ({
      reason: readStringVerbatim(bucket, "reason") ?? "unknown",
      rejectedCount: numberAt(bucket, ["rejectedCount"]),
      uniqueSymbolCount: numberAt(bucket, ["uniqueSymbolCount"]),
      laterValidatedSymbolCount: numberAt(bucket, ["laterValidatedSymbolCount"]),
      validation: metricText(bucket.validation),
    }));
}

export function alphaStaleLeadRows(detail: AlphaCohortDetail): readonly AlphaStaleLeadRow[] {
  const buckets = detail.summary?.staleLeadDecay;
  if (!Array.isArray(buckets)) {
    return [];
  }

  return buckets
    .filter((bucket): bucket is Record<string, unknown> => readRecord(bucket) !== undefined)
    .map((bucket) => ({
      ageBucket: readStringVerbatim(bucket, "ageBucket") ?? "unknown",
      unbriefedLeadCount: numberAt(bucket, ["unbriefedLeadCount"]),
      validation: metricText(bucket.validation),
    }));
}
