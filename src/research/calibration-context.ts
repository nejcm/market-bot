import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ResearchCommand } from "../cli/args";
import {
  isMarketRegimeLabel,
  marketUpdateHorizonBucket,
  NEAR_BASE_RATE_BAND,
} from "../domain/types";
import { isRecord, readNumber, readString } from "../sources/guards";
import { brierSkillScore, MIN_CALIBRATION_SAMPLE } from "../scoring/calibration";
import type { CalibrationBin, CalibrationMetric } from "../scoring/types";
import type { CalibrationContext, ResearchContext } from "./research-context-types";

export async function loadCalibrationContext(
  dataDir: string,
): Promise<CalibrationContext | undefined> {
  try {
    const raw = await readFile(join(dataDir, "../calibration/summary.json"), "utf8");
    return parseCalibrationContext(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

// Domain invariants the producer guarantees (see src/scoring/calibration.ts).
// These are enforced at the untrusted disk boundary, not assumed.
// Finite-but-impossible values like hitRate 1.5 or negative counts are dropped.
function isProbability(value: number): boolean {
  return value >= 0 && value <= 1;
}

function isCount(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function isPositiveCount(value: number): boolean {
  return Number.isInteger(value) && value >= 1;
}

// Brier skill vs the always-0.5 baseline. Binary Brier in [0, 1] bounds the skill to [-3, 1].
// Values outside that range are impossible and dropped.
function isBrierSkill(value: number): boolean {
  return value >= -3 && value <= 1;
}

function readNumberWhere(
  record: Record<string, unknown>,
  key: string,
  predicate: (value: number) => boolean,
): number | undefined {
  const value = readNumber(record, key);
  return value !== undefined && predicate(value) ? value : undefined;
}

// Runtime schema validation at the disk boundary: summary.json is untrusted on read.
// Malformed or schema-drifted fields are dropped rather than cast through with `as`.
// Mirrors the custom-validation pattern in src/report/schema.ts (no Zod).
export function parseCalibrationContext(value: unknown): CalibrationContext | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const generatedAt = readString(value, "generatedAt");
  const resolvedCount = readNumberWhere(value, "resolvedCount", isCount);
  const missAutopsyCount = readNumberWhere(value, "missAutopsyCount", isCount);
  const brierScore = readNumberWhere(value, "brierScore", isProbability);
  const brierSkill = readNumberWhere(value, "brierSkillScore", isBrierSkill);
  const bins = Array.isArray(value.bins)
    ? value.bins.flatMap((bin) => {
        const parsed = parseCalibrationBin(bin);
        return parsed === undefined ? [] : [parsed];
      })
    : undefined;
  const byKind = parseMetricMap(value.byKind);
  const byAssetClass = parseMetricMap(value.byAssetClass);
  const byJobType = parseMetricMap(value.byJobType);
  const byMarketUpdateHorizonBucket =
    parseMetricMap(value.byMarketUpdateHorizonBucket) ??
    parseMetricMap(value.byMarketUpdateCadence);
  const byHorizonBucket = parseMetricMap(value.byHorizonBucket);
  const byMarketRegime = parseMarketRegimeMetricMap(value.byMarketRegime);
  const marketRegimeCoverage = parseMarketRegimeCoverage(value.marketRegimeCoverage);
  const byMissAutopsyCause = parseCountMap(value.byMissAutopsyCause);
  const conditionalPredictions = parseConditionalCalibrationSummary(value.conditionalPredictions);
  return {
    ...(generatedAt !== undefined ? { generatedAt } : {}),
    ...(resolvedCount !== undefined ? { resolvedCount } : {}),
    ...(missAutopsyCount !== undefined ? { missAutopsyCount } : {}),
    ...(brierScore !== undefined ? { brierScore } : {}),
    ...(brierSkill !== undefined ? { brierSkillScore: brierSkill } : {}),
    ...(bins !== undefined ? { bins } : {}),
    ...(byKind !== undefined ? { byKind } : {}),
    ...(byAssetClass !== undefined ? { byAssetClass } : {}),
    ...(byJobType !== undefined ? { byJobType } : {}),
    ...(byMarketUpdateHorizonBucket !== undefined ? { byMarketUpdateHorizonBucket } : {}),
    ...(byHorizonBucket !== undefined ? { byHorizonBucket } : {}),
    ...(byMarketRegime !== undefined ? { byMarketRegime } : {}),
    ...(marketRegimeCoverage !== undefined ? { marketRegimeCoverage } : {}),
    ...(byMissAutopsyCause !== undefined ? { byMissAutopsyCause } : {}),
    ...(conditionalPredictions !== undefined ? { conditionalPredictions } : {}),
  };
}

function parseConditionalCalibrationSummary(
  value: unknown,
): CalibrationContext["conditionalPredictions"] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const activatedCount = readNumberWhere(value, "activatedCount", isCount);
  const voidedCount = readNumberWhere(value, "voidedCount", isCount);
  if (activatedCount === undefined || voidedCount === undefined) {
    return undefined;
  }
  return { activatedCount, voidedCount };
}

function parseCalibrationBin(value: unknown): CalibrationBin | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const pLow = readNumberWhere(value, "pLow", isProbability);
  const pHigh = readNumberWhere(value, "pHigh", isProbability);
  const label = readString(value, "label");
  const hitCount = readNumberWhere(value, "hitCount", isCount);
  const totalCount = readNumberWhere(value, "totalCount", isPositiveCount);
  const hitRate = readNumberWhere(value, "hitRate", isProbability);
  if (
    pLow === undefined ||
    pHigh === undefined ||
    label === undefined ||
    hitCount === undefined ||
    totalCount === undefined ||
    hitRate === undefined ||
    pLow >= pHigh ||
    hitCount > totalCount
  ) {
    return undefined;
  }
  return { pLow, pHigh, label, hitCount, totalCount, hitRate };
}

function parseCalibrationMetric(value: unknown): CalibrationMetric | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const brierScore = readNumberWhere(value, "brierScore", isProbability);
  const count = readNumberWhere(value, "count", isPositiveCount);
  if (brierScore === undefined || count === undefined) {
    return undefined;
  }
  return { brierScore, count };
}

function parseMetricMap(value: unknown): Record<string, CalibrationMetric> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const entries = Object.entries(value).flatMap(([key, raw]) => {
    const metric = parseCalibrationMetric(raw);
    return metric === undefined ? [] : [[key, metric] as const];
  });
  return Object.fromEntries(entries);
}

function parseMarketRegimeMetricMap(value: unknown): Record<string, CalibrationMetric> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const entries = Object.entries(value).flatMap(([key, raw]) => {
    if (!isMarketRegimeLabel(key)) {
      return [];
    }
    const metric = parseCalibrationMetric(raw);
    return metric === undefined ? [] : [[key, metric] as const];
  });
  return Object.fromEntries(entries);
}

function parseMarketRegimeCoverage(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const entries = Object.entries(value).flatMap(([key, raw]) =>
    (isMarketRegimeLabel(key) || key === "unknown") && typeof raw === "number" && isCount(raw)
      ? [[key, raw] as const]
      : [],
  );
  return Object.fromEntries(entries);
}

function parseCountMap(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const entries = Object.entries(value).flatMap(([key, raw]) =>
    typeof raw === "number" && isCount(raw) ? [[key, raw] as const] : [],
  );
  return Object.fromEntries(entries);
}

function formatSkill(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
}

// Render a per-slice calibration section (by kind / by horizon) as a directive. Each slice shows
// Brier skill vs the always-0.5 baseline so the model sees where it currently has no edge.
function renderMetricSlice(
  lines: string[],
  title: string,
  metricsByKey: Record<string, CalibrationMetric> | undefined,
): void {
  const entries = metricsByKey === undefined ? [] : Object.entries(metricsByKey);
  if (entries.length === 0) {
    return;
  }
  lines.push(`${title} (Brier skill vs always-0.5; negative means worse than a coin flip):`);
  for (const [key, metric] of entries) {
    lines.push(
      `  ${key}: skill ${formatSkill(brierSkillScore(metric.brierScore))} (Brier ${metric.brierScore.toFixed(3)}, n=${String(metric.count)})`,
    );
  }
}

function renderCurrentRegimeCalibration(
  calibration: CalibrationContext,
  context: Pick<ResearchContext, "marketRegime">,
): string | undefined {
  const metric = calibration.byMarketRegime?.[context.marketRegime.label];
  if (metric === undefined || metric.count < MIN_CALIBRATION_SAMPLE) {
    return undefined;
  }
  return `Current-regime calibration (${context.marketRegime.label}, all run types): skill ${formatSkill(brierSkillScore(metric.brierScore))} (Brier ${metric.brierScore.toFixed(3)}, n=${String(metric.count)}). Use this alongside the run-type and horizon slices; ignore thinner regime slices below n=${String(MIN_CALIBRATION_SAMPLE)}.`;
}

function isActionableNegative(metric: CalibrationMetric | undefined): metric is CalibrationMetric {
  return (
    metric !== undefined &&
    metric.count >= MIN_CALIBRATION_SAMPLE &&
    brierSkillScore(metric.brierScore) < 0
  );
}

interface ApplicableCalibrationSlice {
  readonly label: string;
  readonly metric: CalibrationMetric;
}

function actionableNegativeSlices(
  calibration: CalibrationContext,
  command: ResearchCommand,
  context: Pick<ResearchContext, "depthProfile" | "marketRegime">,
): readonly ApplicableCalibrationSlice[] {
  const horizonBucket = marketUpdateHorizonBucket(context.depthProfile.defaultPredictionHorizon);
  return [
    {
      label: `asset class ${command.assetClass}`,
      metric: calibration.byAssetClass?.[command.assetClass],
    },
    { label: `job type ${command.jobType}`, metric: calibration.byJobType?.[command.jobType] },
    {
      label: `default horizon ${horizonBucket}`,
      metric: calibration.byHorizonBucket?.[horizonBucket],
    },
    {
      label: `current regime ${context.marketRegime.label}`,
      metric: calibration.byMarketRegime?.[context.marketRegime.label],
    },
  ].flatMap(({ label, metric }) => (isActionableNegative(metric) ? [{ label, metric }] : []));
}

export function buildCalibrationBlock(
  calibration: CalibrationContext | undefined,
  command: ResearchCommand,
  context: Pick<ResearchContext, "depthProfile" | "marketRegime">,
): string | undefined {
  if (calibration === undefined) {
    return undefined;
  }
  const lines: string[] = [];
  const currentRegimeLine = renderCurrentRegimeCalibration(calibration, context);
  if (currentRegimeLine !== undefined) {
    lines.push(currentRegimeLine);
  }
  if (typeof calibration.brierScore === "number") {
    lines.push(`Overall Brier score: ${calibration.brierScore.toFixed(3)} (lower is better)`);
    lines.push(
      `Brier skill vs always-0.5 baseline: ${formatSkill(brierSkillScore(calibration.brierScore))} (>0 beats always-stating-0.5, <0 is worse)`,
    );
  }
  if (typeof calibration.resolvedCount === "number") {
    lines.push(`Resolved predictions: ${calibration.resolvedCount}`);
  }
  if (calibration.conditionalPredictions !== undefined) {
    lines.push(
      `Conditional Predictions: ${String(calibration.conditionalPredictions.activatedCount)} activated, ${String(calibration.conditionalPredictions.voidedCount)} voided/excluded`,
    );
  }
  if (Array.isArray(calibration.bins) && calibration.bins.length > 0) {
    lines.push("Bin summary (stated probability band vs actual hit rate):");
    for (const bin of calibration.bins) {
      const validBin = parseCalibrationBin(bin);
      if (validBin !== undefined) {
        lines.push(
          `  ${validBin.label}: actual hit ${validBin.hitRate.toFixed(2)} (n=${String(validBin.totalCount)})`,
        );
      }
    }
  }
  renderMetricSlice(lines, "Per-kind calibration", calibration.byKind);
  renderMetricSlice(lines, "Per-horizon calibration", calibration.byHorizonBucket);
  const negativeSlices = actionableNegativeSlices(calibration, command, context);
  if (negativeSlices.length > 0) {
    lines.push("Actionable negative applicable slices:");
    for (const { label, metric } of negativeSlices) {
      lines.push(
        `  ${label}: skill ${formatSkill(brierSkillScore(metric.brierScore))} (Brier ${metric.brierScore.toFixed(3)}, n=${String(metric.count)})`,
      );
    }
    const bandLow = (0.5 - NEAR_BASE_RATE_BAND).toFixed(2);
    const bandHigh = (0.5 + NEAR_BASE_RATE_BAND).toFixed(2);
    lines.push(
      `Applicable calibration is negative: emit only evidence-backed forecasts whose probability is outside the ${bandLow}-${bandHigh} near-base-rate band. Prefer fewer forecasts plus predictionShortfall over near-0.5 padding. Do not inflate confidence just to escape the band.`,
    );
  }
  return lines.length > 0 ? lines.join("\n") : undefined;
}
