import {
  MARKET_REGIME_LABELS,
  type AssetClass,
  type JobType,
  type MarketRegimeLabel,
  type MarketUpdateJobType,
  type Prediction,
} from "../domain/types";
import type {
  CalibrationBin,
  ConditionalCalibrationSummary,
  CalibrationMetric,
  CalibrationSummary,
  MissAutopsyEntry,
  PredictionScore,
} from "./types";

export interface ResolvedPair {
  readonly prediction: Prediction;
  readonly score: PredictionScore;
  readonly assetClass: AssetClass;
  readonly jobType: JobType;
  readonly marketUpdateCadence?: MarketUpdateJobType;
  readonly runId: string;
  readonly missAutopsy?: MissAutopsyEntry;
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
const HORIZON_BUCKETS = [
  { max: 5, label: "1-5d" },
  { max: 10, label: "6-10d" },
  { max: 15, label: "11-15d" },
] as const;
const LONG_HORIZON_BUCKET = "16-20d";

function makeBinLabel(lo: number, hi: number): string {
  return `${String(lo.toFixed(1))}-${String(hi.toFixed(1))}`;
}

function brierScore(pairs: readonly ResolvedPair[]): number {
  if (pairs.length === 0) {
    return 0;
  }
  const sum = pairs.reduce((total, { prediction, score }) => {
    const outcome = score.outcome === "hit" ? 1 : 0;
    const diff = prediction.probability - outcome;
    return total + diff * diff;
  }, 0);
  return sum / pairs.length;
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
    result[key] = { brierScore: brierScore(groupPairs), count: groupPairs.length };
  }

  return result;
}

function horizonBucket({ prediction }: ResolvedPair): string {
  const horizon = prediction.horizonTradingDays;
  for (const bucket of HORIZON_BUCKETS) {
    if (horizon <= bucket.max) {
      return bucket.label;
    }
  }
  return LONG_HORIZON_BUCKET;
}

function countMissAutopsies(pairs: readonly ResolvedPair[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const { missAutopsy } of pairs) {
    if (missAutopsy === undefined) {
      continue;
    }
    counts[missAutopsy.cause] = (counts[missAutopsy.cause] ?? 0) + 1;
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
      result[label] = { brierScore: brierScore(inLabel), count: inLabel.length };
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
  const conditionalActivatedCount =
    conditionalPredictions.activatedCount +
    pairs.filter(({ prediction }) => prediction.kind === "conditional").length;
  const overallBrier = brierScore(pairs);
  return {
    generatedAt: now.toISOString(),
    resolvedCount: pairs.length,
    missAutopsyCount: pairs.filter(({ missAutopsy }) => missAutopsy !== undefined).length,
    brierScore: overallBrier,
    brierSkillScore: brierSkillScore(overallBrier),
    bins: buildBins(pairs),
    byKind: groupMetrics(pairs, ({ prediction }) => prediction.kind),
    byAssetClass: groupMetrics(pairs, ({ assetClass }) => assetClass),
    byJobType: groupMetrics(pairs, ({ jobType }) => jobType),
    byMarketUpdateCadence: groupMetrics(
      pairs.filter(({ marketUpdateCadence }) => marketUpdateCadence !== undefined),
      ({ marketUpdateCadence }) => marketUpdateCadence ?? "unknown",
    ),
    byHorizonBucket: groupMetrics(pairs, horizonBucket),
    byMarketRegime: buildByMarketRegime(pairs),
    marketRegimeCoverage: buildMarketRegimeCoverage(pairs),
    byMissAutopsyCause: countMissAutopsies(pairs),
    conditionalPredictions: {
      activatedCount: conditionalActivatedCount,
      voidedCount: conditionalPredictions.voidedCount,
    },
  };
}
