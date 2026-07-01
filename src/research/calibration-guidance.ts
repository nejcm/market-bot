import type { CalibrationMetric } from "../scoring/types";
import type { CalibrationContext } from "./research-context-types";

export const MIN_ACTIONABLE_CALIBRATION_OUTCOMES = 30;
export const MIN_ACTIONABLE_CALIBRATION_RUNS = 10;
export const ACTIONABLE_CALIBRATION_Z = 2.2414;
export const BASE_RATE_BRIER = 0.25;

export type CalibrationGuidanceDimension =
  | "assetClass"
  | "jobType"
  | "predictionHorizon"
  | "marketRegime";

export type CalibrationGuidanceReason =
  | "slice-unavailable"
  | "below-outcome-floor"
  | "uncertainty-unavailable"
  | "below-run-floor"
  | "not-negative-with-confidence"
  | "actionable-negative";

export interface CalibrationGuidanceAssessment {
  readonly actionable: boolean;
  readonly reason: CalibrationGuidanceReason;
  readonly lowerConfidenceBound?: number;
}

export interface ApplicableCalibrationSlice extends CalibrationGuidanceAssessment {
  readonly dimension: CalibrationGuidanceDimension;
  readonly key: string;
  readonly metric?: CalibrationMetric;
}

export interface ApplicableCalibrationKeys {
  readonly assetClass: string;
  readonly jobType: string;
  readonly predictionHorizon: string;
  readonly marketRegime: string;
}

export function assessNegativeCalibration(
  metric: CalibrationMetric | undefined,
): CalibrationGuidanceAssessment {
  if (metric === undefined) {
    return { actionable: false, reason: "slice-unavailable" };
  }
  if (metric.count < MIN_ACTIONABLE_CALIBRATION_OUTCOMES) {
    return { actionable: false, reason: "below-outcome-floor" };
  }
  if (metric.runCount === undefined || metric.brierStandardError === undefined) {
    return { actionable: false, reason: "uncertainty-unavailable" };
  }
  if (metric.runCount < MIN_ACTIONABLE_CALIBRATION_RUNS) {
    return { actionable: false, reason: "below-run-floor" };
  }
  const lowerConfidenceBound =
    metric.brierScore - ACTIONABLE_CALIBRATION_Z * metric.brierStandardError;
  return lowerConfidenceBound > BASE_RATE_BRIER
    ? { actionable: true, reason: "actionable-negative", lowerConfidenceBound }
    : { actionable: false, reason: "not-negative-with-confidence", lowerConfidenceBound };
}

export function applicableCalibrationSlices(
  calibration: CalibrationContext | undefined,
  keys: ApplicableCalibrationKeys,
): readonly ApplicableCalibrationSlice[] {
  const slices = [
    {
      dimension: "assetClass",
      key: keys.assetClass,
      metric: calibration?.byAssetClass?.[keys.assetClass],
    },
    {
      dimension: "jobType",
      key: keys.jobType,
      metric: calibration?.byJobType?.[keys.jobType],
    },
    {
      dimension: "predictionHorizon",
      key: keys.predictionHorizon,
      metric: calibration?.byHorizonBucket?.[keys.predictionHorizon],
    },
    {
      dimension: "marketRegime",
      key: keys.marketRegime,
      metric: calibration?.byMarketRegime?.[keys.marketRegime],
    },
  ] as const;
  return slices.map(({ dimension, key, metric }) => ({
    dimension,
    key,
    ...(metric !== undefined ? { metric } : {}),
    ...assessNegativeCalibration(metric),
  }));
}
