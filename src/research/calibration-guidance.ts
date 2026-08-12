import { isMarketUpdateJobType, type JobType } from "../domain/types";
import type { CalibrationMetric } from "../scoring/types";
import type { CalibrationContext } from "./research-context-types";

export const MIN_ACTIONABLE_CALIBRATION_OUTCOMES = 30;
export const MIN_ACTIONABLE_CALIBRATION_RUNS = 10;
export const ACTIONABLE_CALIBRATION_Z = 2.2414;
export const BASE_RATE_BRIER = 0.25;

export type CalibrationGuidanceDimension =
  | "assetClass"
  | "jobType"
  | "predictionKind"
  | "predictionHorizon"
  | "marketRegime";

export type CalibrationGuidanceReason =
  | "slice-unavailable"
  | "below-outcome-floor"
  | "uncertainty-unavailable"
  | "below-run-floor"
  | "not-negative-with-confidence"
  | "actionable-negative";

export type CalibrationPopulationStatus = "empty-dimension" | "single-cell-dimension";

export interface CalibrationGuidanceAssessment {
  readonly actionable: boolean;
  readonly reason: CalibrationGuidanceReason;
  readonly lowerConfidenceBound?: number;
}

export interface ApplicableCalibrationSlice extends CalibrationGuidanceAssessment {
  readonly dimension: CalibrationGuidanceDimension;
  readonly key: string;
  readonly metric?: CalibrationMetric;
  readonly populationStatus?: CalibrationPopulationStatus;
}

export interface ApplicableCalibrationKeys {
  readonly assetClass: string;
  readonly jobType: JobType;
  readonly predictionHorizon: string;
  readonly marketRegime: string;
}

export function assessNegativeCalibration(
  metric: CalibrationMetric | undefined,
): CalibrationGuidanceAssessment {
  if (metric === undefined) {
    return { actionable: false, reason: "slice-unavailable" };
  }
  const lowerConfidenceBound =
    metric.brierStandardError === undefined
      ? undefined
      : metric.brierScore - ACTIONABLE_CALIBRATION_Z * metric.brierStandardError;
  if (metric.count < MIN_ACTIONABLE_CALIBRATION_OUTCOMES) {
    return {
      actionable: false,
      reason: "below-outcome-floor",
      ...(lowerConfidenceBound !== undefined ? { lowerConfidenceBound } : {}),
    };
  }
  if (metric.runCount === undefined || lowerConfidenceBound === undefined) {
    return { actionable: false, reason: "uncertainty-unavailable" };
  }
  if (metric.runCount < MIN_ACTIONABLE_CALIBRATION_RUNS) {
    return { actionable: false, reason: "below-run-floor", lowerConfidenceBound };
  }
  return lowerConfidenceBound > BASE_RATE_BRIER
    ? { actionable: true, reason: "actionable-negative", lowerConfidenceBound }
    : { actionable: false, reason: "not-negative-with-confidence", lowerConfidenceBound };
}

export function applicableCalibrationSlices(
  calibration: CalibrationContext | undefined,
  keys: ApplicableCalibrationKeys,
): readonly ApplicableCalibrationSlice[] {
  const horizonMetrics = isMarketUpdateJobType(keys.jobType)
    ? calibration?.byMarketUpdateHorizonBucket
    : calibration?.byHorizonBucket;
  const slices = [
    {
      dimension: "assetClass",
      key: keys.assetClass,
      metrics: calibration?.byAssetClass,
    },
    {
      dimension: "jobType",
      key: keys.jobType,
      metrics: calibration?.byJobType,
    },
    {
      dimension: "predictionHorizon",
      key: keys.predictionHorizon,
      metrics: horizonMetrics,
    },
    {
      dimension: "marketRegime",
      key: keys.marketRegime,
      metrics: calibration?.byMarketRegime,
    },
  ] as const;
  return slices.map(({ dimension, key, metrics }) => {
    const populatedCells = metrics === undefined ? undefined : Object.keys(metrics).length;
    const metric = metrics?.[key];
    const assessment = assessNegativeCalibration(metric);
    let populationStatus: CalibrationPopulationStatus | null = null;
    if (populatedCells === 0) {
      populationStatus = "empty-dimension";
    } else if (populatedCells === 1) {
      populationStatus = "single-cell-dimension";
    }
    return {
      dimension,
      key,
      ...(metric !== undefined ? { metric } : {}),
      ...assessment,
      ...(populationStatus !== null ? { populationStatus } : {}),
    };
  });
}

export function applicableKindSlices(
  calibration: CalibrationContext | undefined,
): readonly ApplicableCalibrationSlice[] {
  return Object.entries(calibration?.byKind ?? {}).map(([key, metric]) => ({
    dimension: "predictionKind",
    key,
    metric,
    ...assessNegativeCalibration(metric),
  }));
}
