import {
  MARKET_REGIME_LABELS,
  marketUpdateHorizonBucket,
  type AssetClass,
  type JobType,
  type MarketRegimeLabel,
  type Prediction,
} from "../domain/types";
import type {
  CalibrationBin,
  ConditionalCalibrationSummary,
  CalibrationMetric,
  CalibrationSummary,
  MissAutopsyCause,
  PredictionScore,
} from "./types";

export interface ResolvedPair {
  readonly prediction: Prediction;
  readonly score: PredictionScore;
  readonly assetClass: AssetClass;
  readonly jobType: JobType;
  readonly marketUpdateHorizonBucket?: string;
  readonly runId: string;
  readonly missAutopsyCause?: MissAutopsyCause;
  /** Market Regime label in effect at forecast time; undefined when absent/unparseable. */
  readonly marketRegimeLabel?: MarketRegimeLabel;
}

const EMPTY_CONDITIONAL_SUMMARY: ConditionalCalibrationSummary = {
  activatedCount: 0,
  voidedCount: 0,
};

// Calibration bucket for resolved pairs whose forecast-time regime is absent or
// Unparseable. Excluded from the regime slice but counted in coverage.
export const UNKNOWN_REGIME_BUCKET = "unknown";

// Brier score of the naive always-predict-0.5 forecaster on binary outcomes: (0.5 - {0,1})^2.
export const MIN_CALIBRATION_SAMPLE = 5;

const BASELINE_BRIER = 0.25;
const BIN_EDGES = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1] as const;
function makeBinLabel(lo: number, hi: number): string {
  return `${String(lo.toFixed(1))}-${String(hi.toFixed(1))}`;
}

function brierLoss({ prediction, score }: ResolvedPair): number {
  const outcome = score.outcome === "hit" ? 1 : 0;
  const diff = prediction.probability - outcome;
  return diff * diff;
}

// Mean Brier loss. Every caller reaches this with a non-empty group, because
// Slice maps only ever key groups that have at least one resolved pair.
function meanBrierLoss(pairs: readonly ResolvedPair[]): number {
  return pairs.reduce((total, pair) => total + brierLoss(pair), 0) / pairs.length;
}

// Overall Brier for the corpus. Undefined when nothing has resolved: a Brier of
// 0 means a perfect forecaster, so publishing it for an empty corpus would
// Assert exactly the opposite of what is known. See src/scoring/types.ts.
function overallBrierScore(pairs: readonly ResolvedPair[]): number | undefined {
  return pairs.length === 0 ? undefined : meanBrierLoss(pairs);
}

function calibrationMetric(pairs: readonly ResolvedPair[]): CalibrationMetric {
  const mean = meanBrierLoss(pairs);
  const clusterSums = new Map<string, number>();
  for (const pair of pairs) {
    clusterSums.set(pair.runId, (clusterSums.get(pair.runId) ?? 0) + (brierLoss(pair) - mean));
  }
  const runCount = clusterSums.size;
  if (runCount < 2) {
    return { brierScore: mean, count: pairs.length, runCount };
  }
  const squaredClusterSum = [...clusterSums.values()].reduce(
    (total, clusterSum) => total + clusterSum * clusterSum,
    0,
  );
  const variance =
    (runCount / (runCount - 1)) * (squaredClusterSum / (pairs.length * pairs.length));
  return {
    brierScore: mean,
    count: pairs.length,
    runCount,
    brierStandardError: Math.sqrt(variance),
  };
}

// Brier skill score vs the always-0.5 baseline. Positive beats a coin flip, negative trails it.
// For binary Brier in [0, 1] the skill lands in [-3, 1].
export function brierSkillScore(brier: number): number {
  return 1 - brier / BASELINE_BRIER;
}

function buildBins(pairs: readonly ResolvedPair[]): readonly CalibrationBin[] {
  const bins: CalibrationBin[] = [];

  for (let idx = 0; idx < BIN_EDGES.length - 1; idx += 1) {
    const pLow = BIN_EDGES[idx] as number;
    const pHigh = BIN_EDGES[idx + 1] as number;
    const isLastBin = idx === BIN_EDGES.length - 2;
    const inBin = pairs.filter(({ prediction }) => {
      const p = prediction.probability;
      return p >= pLow && (isLastBin ? p <= pHigh : p < pHigh);
    });
    if (inBin.length === 0) {
      continue;
    }
    const hitCount = inBin.filter(({ score }) => score.outcome === "hit").length;
    bins.push({
      pLow,
      pHigh,
      label: makeBinLabel(pLow, pHigh),
      hitCount,
      totalCount: inBin.length,
      hitRate: hitCount / inBin.length,
    });
  }

  return bins;
}

function groupMetrics(
  pairs: readonly ResolvedPair[],
  keyFn: (pair: ResolvedPair) => string,
): Record<string, CalibrationMetric> {
  const groups = new Map<string, ResolvedPair[]>();

  for (const pair of pairs) {
    const key = keyFn(pair);
    groups.set(key, [...(groups.get(key) ?? []), pair]);
  }

  const result: Record<string, CalibrationMetric> = {};

  for (const [key, groupPairs] of groups) {
    result[key] = calibrationMetric(groupPairs);
  }

  return result;
}

function horizonBucket({ prediction }: ResolvedPair): string {
  return marketUpdateHorizonBucket(prediction.horizonTradingDays);
}

function countMissAutopsies(pairs: readonly ResolvedPair[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const { missAutopsyCause } of pairs) {
    if (missAutopsyCause === undefined) {
      continue;
    }
    counts[missAutopsyCause] = (counts[missAutopsyCause] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(counts).toSorted(
      (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
    ),
  );
}

// Brier + count per real regime label, restricted to labels meeting the
// Minimum-sample floor. Ordered by the canonical regime sequence for stable
// Output; the "unknown" bucket is never a real regime and is excluded here.
function buildByMarketRegime(pairs: readonly ResolvedPair[]): Record<string, CalibrationMetric> {
  const result: Record<string, CalibrationMetric> = {};
  for (const label of MARKET_REGIME_LABELS) {
    const inLabel = pairs.filter(({ marketRegimeLabel }) => marketRegimeLabel === label);
    if (inLabel.length >= MIN_CALIBRATION_SAMPLE) {
      result[label] = calibrationMetric(inLabel);
    }
  }
  return result;
}

// Resolved-pair counts for every regime bucket, including sub-floor regimes and
// The "unknown" bucket, so slice coverage stays honest where a Brier is withheld.
function buildMarketRegimeCoverage(pairs: readonly ResolvedPair[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const { marketRegimeLabel } of pairs) {
    const bucket = marketRegimeLabel ?? UNKNOWN_REGIME_BUCKET;
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }
  const result: Record<string, number> = {};
  for (const label of [...MARKET_REGIME_LABELS, UNKNOWN_REGIME_BUCKET]) {
    const count = counts.get(label);
    if (count !== undefined) {
      result[label] = count;
    }
  }
  return result;
}

export function buildCalibrationSummary(
  pairs: readonly ResolvedPair[],
  now: Date = new Date(),
  conditionalPredictions: ConditionalCalibrationSummary = EMPTY_CONDITIONAL_SUMMARY,
): CalibrationSummary {
  const currentPairs = pairs.filter(({ score }) => score.scoringVersion === 3);
  const conditionalActivatedCount =
    conditionalPredictions.activatedCount +
    currentPairs.filter(({ prediction }) => prediction.kind === "conditional").length;
  const hitCount = currentPairs.filter(({ score }) => score.outcome === "hit").length;
  const overallBrier = overallBrierScore(currentPairs);
  return {
    generatedAt: now.toISOString(),
    resolvedCount: currentPairs.length,
    // Omitted, never 0, when nothing has resolved — see CalibrationSummary.
    ...(currentPairs.length === 0 ? {} : { hitRate: hitCount / currentPairs.length }),
    missAutopsyCount: currentPairs.filter(({ missAutopsyCause }) => missAutopsyCause !== undefined)
      .length,
    ...(overallBrier === undefined ? {} : { brierScore: overallBrier }),
    bins: buildBins(currentPairs),
    byKind: groupMetrics(currentPairs, ({ prediction }) => prediction.kind),
    byAssetClass: groupMetrics(currentPairs, ({ assetClass }) => assetClass),
    byJobType: groupMetrics(currentPairs, ({ jobType }) => jobType),
    byMarketUpdateHorizonBucket: groupMetrics(
      currentPairs.filter((pair) => pair.marketUpdateHorizonBucket !== undefined),
      (pair) => pair.marketUpdateHorizonBucket ?? "unknown",
    ),
    byHorizonBucket: groupMetrics(currentPairs, horizonBucket),
    byMarketRegime: buildByMarketRegime(currentPairs),
    marketRegimeCoverage: buildMarketRegimeCoverage(currentPairs),
    byMissAutopsyCause: countMissAutopsies(currentPairs),
    conditionalPredictions: {
      activatedCount: conditionalActivatedCount,
      voidedCount: conditionalPredictions.voidedCount,
    },
  };
}
