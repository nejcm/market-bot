import type { AssetClass, JobType, MarketUpdateJobType, Prediction } from "../domain/types";
import type {
  CalibrationBin,
  CalibrationMetric,
  CalibrationSummary,
  PredictionScore,
} from "./types";

export interface ResolvedPair {
  readonly prediction: Prediction;
  readonly score: PredictionScore;
  readonly assetClass: AssetClass;
  readonly jobType: JobType;
  readonly marketUpdateCadence?: MarketUpdateJobType;
  readonly runId: string;
}

const BIN_EDGES = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1] as const;

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
  if (horizon <= 5) {
    return "1-5d";
  }
  if (horizon <= 10) {
    return "6-10d";
  }
  if (horizon <= 15) {
    return "11-15d";
  }
  return "16-20d";
}

export function buildCalibrationSummary(
  pairs: readonly ResolvedPair[],
  now: Date = new Date(),
): CalibrationSummary {
  return {
    generatedAt: now.toISOString(),
    resolvedCount: pairs.length,
    brierScore: brierScore(pairs),
    bins: buildBins(pairs),
    byKind: groupMetrics(pairs, ({ prediction }) => prediction.kind),
    byAssetClass: groupMetrics(pairs, ({ assetClass }) => assetClass),
    byJobType: groupMetrics(pairs, ({ jobType }) => jobType),
    byMarketUpdateCadence: groupMetrics(
      pairs.filter(({ marketUpdateCadence }) => marketUpdateCadence !== undefined),
      ({ marketUpdateCadence }) => marketUpdateCadence ?? "unknown",
    ),
    byHorizonBucket: groupMetrics(pairs, horizonBucket),
  };
}
