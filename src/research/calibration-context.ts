import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ResearchCommand } from "../cli/args";
import { isMarketRegimeLabel, marketUpdateHorizonBucket } from "../domain/types";
import { isRecord, readNumber, readString } from "../sources/guards";
import { brierSkillScore } from "../scoring/calibration";
import type { CalibrationBin, CalibrationMetric } from "../scoring/types";
import { applicableCalibrationSlices } from "./calibration-guidance";
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
  const hitRate = readNumberWhere(value, "hitRate", isProbability);
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
    ...(hitRate !== undefined ? { hitRate } : {}),
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
  const runCount = readNumberWhere(value, "runCount", isPositiveCount);
  const brierStandardError = readNumberWhere(
    value,
    "brierStandardError",
    (candidate) => candidate >= 0,
  );
  return {
    brierScore,
    count,
    ...(runCount !== undefined && runCount <= count ? { runCount } : {}),
    ...(brierStandardError !== undefined ? { brierStandardError } : {}),
  };
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

function calibrationSliceLabel(dimension: string, key: string): string {
  switch (dimension) {
    case "assetClass": {
      return `asset class ${key}`;
    }
    case "jobType": {
      return `job type ${key}`;
    }
    case "predictionHorizon": {
      return `default horizon ${key}`;
    }
    default: {
      return `current regime ${key}`;
    }
  }
}

export function buildCalibrationBlock(
  calibration: CalibrationContext | undefined,
  command: ResearchCommand,
  context: Pick<ResearchContext, "depthProfile" | "marketRegime">,
): string | undefined {
  if (calibration === undefined) {
    return undefined;
  }
  const horizonBucket = marketUpdateHorizonBucket(context.depthProfile.defaultPredictionHorizon);
  const actionableSlices = applicableCalibrationSlices(calibration, {
    assetClass: command.assetClass,
    jobType: command.jobType,
    predictionHorizon: horizonBucket,
    marketRegime: context.marketRegime.label,
  }).filter(
    (
      slice,
    ): slice is typeof slice & {
      readonly metric: CalibrationMetric & { readonly runCount: number };
      readonly lowerConfidenceBound: number;
    } =>
      slice.actionable &&
      slice.metric !== undefined &&
      slice.metric.runCount !== undefined &&
      slice.lowerConfidenceBound !== undefined,
  );
  if (actionableSlices.length === 0) {
    return undefined;
  }
  const lines = ["Actionable negative calibration slices:"];
  for (const slice of actionableSlices) {
    const { metric } = slice;
    lines.push(
      `  ${calibrationSliceLabel(slice.dimension, slice.key)}: skill ${formatSkill(brierSkillScore(metric.brierScore))} (Brier ${metric.brierScore.toFixed(3)}, n=${String(metric.count)}, runs=${String(metric.runCount)}, lower bound=${slice.lowerConfidenceBound.toFixed(3)})`,
    );
  }
  lines.push(
    "Use these slices only to discipline probability confidence. They must not suppress prediction count, reject forecast shapes, or change evidence-support requirements.",
  );
  return lines.join("\n");
}
