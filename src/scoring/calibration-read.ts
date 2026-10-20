import { isMarketRegimeLabel } from "../domain/report";
import { isRecord, readNumber, readString } from "../guards";
import {
  isCalibrationCount,
  isPositiveCalibrationCount,
  isUnitInterval,
} from "./calibration-invariant";
import type { CalibrationBin, CalibrationMetric } from "./types";

// Structural parsers shared by the prompt path and the Research Console, so the
// Two readers of summary.json cannot disagree about which bins and slices survive.

export function readNumberWhere(
  record: Record<string, unknown>,
  key: string,
  predicate: (value: number) => boolean,
): number | undefined {
  const value = readNumber(record, key);
  return value !== undefined && predicate(value) ? value : undefined;
}

export function parseCalibrationBin(value: unknown): CalibrationBin | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const pLow = readNumberWhere(value, "pLow", isUnitInterval);
  const pHigh = readNumberWhere(value, "pHigh", isUnitInterval);
  const label = readString(value, "label");
  const hitCount = readNumberWhere(value, "hitCount", isCalibrationCount);
  const totalCount = readNumberWhere(value, "totalCount", isPositiveCalibrationCount);
  const hitRate = readNumberWhere(value, "hitRate", isUnitInterval);
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
  const brierScore = readNumberWhere(value, "brierScore", isUnitInterval);
  const count = readNumberWhere(value, "count", isPositiveCalibrationCount);
  if (brierScore === undefined || count === undefined) {
    return undefined;
  }
  const runCount = readNumberWhere(value, "runCount", isPositiveCalibrationCount);
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

export function parseMetricMap(value: unknown): Record<string, CalibrationMetric> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const entries = Object.entries(value).flatMap(([key, raw]) => {
    const metric = parseCalibrationMetric(raw);
    return metric === undefined ? [] : [[key, metric] as const];
  });
  return Object.fromEntries(entries);
}

export function parseMarketRegimeMetricMap(
  value: unknown,
): Record<string, CalibrationMetric> | undefined {
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
