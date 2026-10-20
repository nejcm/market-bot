import { marketUpdateHorizonBucket, type AssetClass, type JobType } from "../domain/job-type";
import { type Prediction } from "../domain/prediction";
import { MARKET_REGIME_LABELS, type MarketRegimeLabel } from "../domain/report";
import {
  claimKey,
  observationStrategyForExpression,
  parseObservableExpression,
  type ObservationStrategy,
} from "../forecast/observable";
import { isExchangeTradingDay } from "./exchange-calendar";
import { scoringPolicyFor } from "./policy";
import type {
  CalibrationBin,
  ConditionalCalibrationSummary,
  CalibrationMetric,
  CalibrationSummary,
  MissAutopsyCause,
  PairedSkillMetric,
  PairedSkillPolicy,
  PairedSkillSummary,
  PredictionScore,
} from "./types";

export interface ResolvedPair {
  readonly prediction: Prediction;
  readonly score: PredictionScore;
  readonly assetClass: AssetClass;
  readonly jobType: JobType;
  readonly marketUpdateHorizonBucket?: string;
  readonly runId: string;
  readonly generatedAt: string;
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

// Brier skill against the fixed always-0.5 reference, not an empirical baseline.
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
  return Object.fromEntries(
    [...groupPairs(pairs, keyFn)].map(([key, group]) => [key, calibrationMetric(group)]),
  );
}

function ascendingHorizon(
  metrics: Record<string, CalibrationMetric>,
): Record<string, CalibrationMetric> {
  return Object.fromEntries(
    Object.entries(metrics).toSorted(([left], [right]) => parseInt(left, 10) - parseInt(right, 10)),
  );
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

function utcDate(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

function closeWindowOrigin(assetClass: AssetClass, issuedAt: Date): string {
  if (assetClass === "crypto") {
    return utcDate(issuedAt);
  }
  let session = new Date(`${utcDate(issuedAt)}T00:00:00.000Z`);
  while (!isExchangeTradingDay(session)) {
    session = new Date(session.getTime() + 86_400_000);
  }
  return utcDate(session);
}

// Mirrors the clock each family resolves on in resolver.ts: sessions, calendar days, or the event.
function strategyOrigin(
  strategy: ObservationStrategy,
  assetClass: AssetClass,
  issuedAt: Date,
): string {
  switch (strategy.mode) {
    case "close-window": {
      return closeWindowOrigin(assetClass, issuedAt);
    }
    case "point": {
      return utcDate(issuedAt);
    }
    case "earnings-close-window": {
      return `event ${strategy.eventDate}`;
    }
    case "composite": {
      return strategy.strategies
        .map((nested) => strategyOrigin(nested, assetClass, issuedAt))
        .join(" & ");
    }
  }
}

function observationStrategy(measurableAs: string): ObservationStrategy | undefined {
  try {
    return observationStrategyForExpression(parseObservableExpression(measurableAs));
  } catch {
    return undefined;
  }
}

// NOTE — ponytail: origins are recomputed, not read from the resolver's window, so quarantine-anchored
// Reports and earnings timing that changes between issuances can split or merge; persist the window then.
export function forecastEventKey(
  assetClass: AssetClass,
  measurableAs: string,
  generatedAt: string,
): string {
  const issuedAt = new Date(generatedAt);
  const strategy = observationStrategy(measurableAs);
  const origin =
    strategy === undefined
      ? closeWindowOrigin(assetClass, issuedAt)
      : strategyOrigin(strategy, assetClass, issuedAt);
  return `${assetClass}|${claimKey(measurableAs)}|${origin}`;
}

function compareIssuance(left: ResolvedPair, right: ResolvedPair): number {
  return (
    Date.parse(left.generatedAt) - Date.parse(right.generatedAt) ||
    left.runId.localeCompare(right.runId) ||
    left.prediction.id.localeCompare(right.prediction.id)
  );
}

// One Forecast Event per claim and origin session; the earliest issuance is the original commitment.
function earliestIssuancePerEvent(pairs: readonly ResolvedPair[]): readonly ResolvedPair[] {
  const events = new Map<string, ResolvedPair>();
  for (const pair of pairs.toSorted(compareIssuance)) {
    const key = forecastEventKey(pair.assetClass, pair.prediction.measurableAs, pair.generatedAt);
    if (!events.has(key)) {
      events.set(key, pair);
    }
  }
  const kept = new Set(events.values());
  return pairs.filter((pair) => kept.has(pair));
}

// Pre-registered in ADR 0003; changing any value needs an ADR amendment, not a tweak.
export const PAIRED_SKILL_POLICY: PairedSkillPolicy = {
  minimumUsefulEffect: 0.01,
  minPairedCount: 30,
  minBlockCount: 5,
  confidenceLevel: 0.95,
  bootstrapResamples: 2000,
  seed: 20_261_020,
  poweredBlockCount: 784,
};

function groupPairs(
  pairs: readonly ResolvedPair[],
  keyFn: (pair: ResolvedPair) => string,
): Map<string, ResolvedPair[]> {
  const groups = new Map<string, ResolvedPair[]>();
  for (const pair of pairs) {
    groups.set(keyFn(pair), [...(groups.get(keyFn(pair)) ?? []), pair]);
  }
  return groups;
}

interface PairedBlock {
  readonly count: number;
  readonly deltaSum: number;
}

// Mulberry32: a fixed seed makes every bootstrap interval reproducible from the same pairs.
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function baselineLoss({ prediction, score }: ResolvedPair): number {
  const outcome = score.outcome === "hit" ? 1 : 0;
  return ((prediction.baselineProbability ?? 0.5) - outcome) ** 2;
}

function clusterSubject({ prediction }: ResolvedPair): string {
  return prediction.subject.split(":")[0]!.toUpperCase();
}

// Blocks chain a subject's events whose close windows overlap, so a resample never splits one price path.
function pairedBlocks(pairs: readonly ResolvedPair[]): readonly PairedBlock[] {
  const bySubject = groupPairs(pairs, clusterSubject);
  const blocks: PairedBlock[] = [];
  for (const subject of [...bySubject.keys()].toSorted()) {
    let current: { count: number; deltaSum: number; end: number } | undefined = undefined;
    for (const pair of bySubject.get(subject)!) {
      const { prediction, generatedAt, assetClass } = pair;
      const issued = Date.parse(generatedAt);
      const end = scoringPolicyFor(prediction)
        .closeDueDate(generatedAt, prediction.horizonTradingDays, assetClass)
        .getTime();
      const delta = baselineLoss(pair) - brierLoss(pair);
      if (current !== undefined && issued <= current.end) {
        current.count += 1;
        current.deltaSum += delta;
        current.end = Math.max(current.end, end);
      } else {
        if (current !== undefined) {
          blocks.push({ count: current.count, deltaSum: current.deltaSum });
        }
        current = { count: 1, deltaSum: delta, end: Math.max(issued, end) };
      }
    }
    if (current !== undefined) {
      blocks.push({ count: current.count, deltaSum: current.deltaSum });
    }
  }
  return blocks;
}

function bootstrapInterval(blocks: readonly PairedBlock[]): readonly [number, number] {
  const { bootstrapResamples, confidenceLevel, seed } = PAIRED_SKILL_POLICY;
  const random = seededRandom(seed);
  const estimates: number[] = [];
  for (let resample = 0; resample < bootstrapResamples; resample += 1) {
    let count = 0;
    let deltaSum = 0;
    for (let draw = 0; draw < blocks.length; draw += 1) {
      const block = blocks[Math.floor(random() * blocks.length)]!;
      count += block.count;
      deltaSum += block.deltaSum;
    }
    estimates.push(deltaSum / count);
  }
  const sorted = estimates.toSorted((a, b) => a - b);
  const tail = (1 - confidenceLevel) / 2;
  return [
    sorted[Math.floor(tail * bootstrapResamples)]!,
    sorted[Math.ceil((1 - tail) * bootstrapResamples) - 1]!,
  ];
}

function pairedSkillMetric(pairs: readonly ResolvedPair[]): PairedSkillMetric {
  const blocks = pairedBlocks(pairs);
  const modelBrier = meanBrierLoss(pairs);
  const baselineBrier = pairs.reduce((total, pair) => total + baselineLoss(pair), 0) / pairs.length;
  const deltaBrier = baselineBrier - modelBrier;
  const interval = blocks.length >= 2 ? bootstrapInterval(blocks) : undefined;
  const decidable =
    interval !== undefined &&
    pairs.length >= PAIRED_SKILL_POLICY.minPairedCount &&
    blocks.length >= PAIRED_SKILL_POLICY.minBlockCount;
  let status: PairedSkillMetric["status"] = "not-yet-decidable";
  if (decidable && interval[0] > 0) {
    status = "model-better";
  } else if (decidable && interval[1] < 0) {
    status = "baseline-better";
  }
  return {
    count: pairs.length,
    subjectCount: new Set(pairs.map(clusterSubject)).size,
    blockCount: blocks.length,
    modelBrier,
    baselineBrier,
    deltaBrier,
    ...(interval === undefined ? {} : { ciLow: interval[0], ciHigh: interval[1] }),
    skillVsHalf: brierSkillScore(modelBrier),
    status,
    meetsMinimumUsefulEffect:
      status === "model-better" && deltaBrier >= PAIRED_SKILL_POLICY.minimumUsefulEffect,
  };
}

// Deduped Forecast Events (a re-issued grid event counts once), sorted so input order never moves the interval.
function buildPairedSkill(pairs: readonly ResolvedPair[]): PairedSkillSummary {
  const paired = pairs
    .filter(({ prediction }) => prediction.baselineProbability !== undefined)
    .toSorted(compareIssuance);
  const byKind = groupPairs(paired, ({ prediction }) => prediction.kind);
  return {
    policy: PAIRED_SKILL_POLICY,
    excludedWithoutBaselineCount: pairs.length - paired.length,
    ...(paired.length === 0 ? {} : { overall: pairedSkillMetric(paired) }),
    byKind: Object.fromEntries(
      [...byKind].map(([kind, kindPairs]) => [kind, pairedSkillMetric(kindPairs)]),
    ),
  };
}

export function buildCalibrationSummary(
  pairs: readonly ResolvedPair[],
  now: Date = new Date(),
  conditionalPredictions: ConditionalCalibrationSummary = EMPTY_CONDITIONAL_SUMMARY,
): CalibrationSummary {
  const issuedPairs = pairs.filter(({ score }) => score.scoringVersion === 3);
  const currentPairs = earliestIssuancePerEvent(issuedPairs);
  const conditionalActivatedCount =
    conditionalPredictions.activatedCount +
    currentPairs.filter(({ prediction }) => prediction.kind === "conditional").length;
  const hitCount = currentPairs.filter(({ score }) => score.outcome === "hit").length;
  const overallBrier = overallBrierScore(currentPairs);
  return {
    generatedAt: now.toISOString(),
    resolvedCount: currentPairs.length,
    duplicateForecastCount: issuedPairs.length - currentPairs.length,
    // Omitted, never 0, when nothing has resolved — see CalibrationSummary.
    ...(currentPairs.length === 0 ? {} : { hitRate: hitCount / currentPairs.length }),
    missAutopsyCount: currentPairs.filter(({ missAutopsyCause }) => missAutopsyCause !== undefined)
      .length,
    ...(overallBrier === undefined ? {} : { brierScore: overallBrier }),
    bins: buildBins(currentPairs),
    byKind: groupMetrics(currentPairs, ({ prediction }) => prediction.kind),
    byAssetClass: groupMetrics(currentPairs, ({ assetClass }) => assetClass),
    byJobType: groupMetrics(currentPairs, ({ jobType }) => jobType),
    byMarketUpdateHorizonBucket: ascendingHorizon(
      groupMetrics(
        currentPairs.filter((pair) => pair.marketUpdateHorizonBucket !== undefined),
        (pair) => pair.marketUpdateHorizonBucket ?? "unknown",
      ),
    ),
    byHorizonBucket: ascendingHorizon(groupMetrics(currentPairs, horizonBucket)),
    byMarketRegime: buildByMarketRegime(currentPairs),
    marketRegimeCoverage: buildMarketRegimeCoverage(currentPairs),
    byMissAutopsyCause: countMissAutopsies(currentPairs),
    conditionalPredictions: {
      activatedCount: conditionalActivatedCount,
      voidedCount: conditionalPredictions.voidedCount,
    },
    pairedSkill: buildPairedSkill(currentPairs),
  };
}
