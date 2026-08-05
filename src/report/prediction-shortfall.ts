import type { PredictionShortfall, ResearchReport } from "../domain/types";
import { isRecord, stringArrayValue } from "../guards";

const LEGACY_PREDICTION_SHORTFALL =
  /^predictionShortfall: emitted ([0-9]+) of ([0-9]+)(?: target predictions; evidence did not support more)?$/u;
const PREDICTION_SHORTFALL_PROTOCOL = /^predictionShortfall:/u;

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function validatePredictionShortfall(value: unknown): PredictionShortfall {
  if (
    !isRecord(value) ||
    !isCount(value.emittedCount) ||
    !isCount(value.targetCount) ||
    !isCount(value.missingCount) ||
    value.missingCount !== value.targetCount - value.emittedCount ||
    value.missingCount <= 0
  ) {
    throw new Error(
      "Prediction shortfall counts must be non-negative integers with missingCount === targetCount - emittedCount > 0",
    );
  }
  return {
    emittedCount: value.emittedCount,
    targetCount: value.targetCount,
    missingCount: value.missingCount,
  };
}

export function readPredictionShortfall(value: unknown): PredictionShortfall | undefined {
  try {
    return validatePredictionShortfall(value);
  } catch {
    return undefined;
  }
}

export function derivePredictionShortfall(
  emittedCount: number,
  targetCount: number,
): PredictionShortfall | undefined {
  if (!isCount(emittedCount) || !isCount(targetCount)) {
    throw new Error("Prediction shortfall derivation requires non-negative integer counts");
  }
  if (emittedCount >= targetCount) {
    return undefined;
  }
  return validatePredictionShortfall({
    emittedCount,
    targetCount,
    missingCount: targetCount - emittedCount,
  });
}

export function rederivePredictionShortfallAfterPruning(
  predictionShortfall: unknown,
  extras: Record<string, unknown> | undefined,
  emittedCount: number,
): PredictionShortfall | undefined {
  const current = readPredictionShortfall(predictionShortfall);
  const depthProfile = extras?.depthProfile;
  const targetFromProfile =
    isRecord(depthProfile) && isCount(depthProfile.targetPredictions)
      ? depthProfile.targetPredictions
      : undefined;
  const targetCount = current?.targetCount ?? targetFromProfile;
  return targetCount === undefined ? current : derivePredictionShortfall(emittedCount, targetCount);
}

export function rederivePredictionShortfallReportAfterPruning(
  report: ResearchReport,
): ResearchReport {
  const predictionShortfall = rederivePredictionShortfallAfterPruning(
    report.predictionShortfall,
    report.extras,
    report.predictions.length,
  );
  const { predictionShortfall: _predictionShortfall, ...reportWithoutPredictionShortfall } = report;
  return {
    ...reportWithoutPredictionShortfall,
    ...(predictionShortfall === undefined ? {} : { predictionShortfall }),
  };
}

export function predictionShortfallMaterialGap(shortfall: PredictionShortfall): string {
  return `emitted ${String(shortfall.emittedCount)} of ${String(shortfall.targetCount)} target predictions; evidence did not support more`;
}

export function predictionShortfallCompactText(shortfall: PredictionShortfall): string {
  return `emitted ${String(shortfall.emittedCount)} of ${String(shortfall.targetCount)}`;
}

export function withoutPredictionShortfallProtocolGaps(
  dataGaps: readonly string[],
): readonly string[] {
  return dataGaps.filter((gap) => !PREDICTION_SHORTFALL_PROTOCOL.test(gap));
}

function legacyPredictionShortfall(gap: string): PredictionShortfall | undefined {
  const match = LEGACY_PREDICTION_SHORTFALL.exec(gap);
  if (match === null) {
    return undefined;
  }
  try {
    return derivePredictionShortfall(Number(match[1]), Number(match[2]));
  } catch {
    return undefined;
  }
}

function sameShortfall(left: PredictionShortfall, right: PredictionShortfall): boolean {
  return (
    left.emittedCount === right.emittedCount &&
    left.targetCount === right.targetCount &&
    left.missingCount === right.missingCount
  );
}

export interface NormalizedPredictionShortfall {
  readonly predictionShortfall?: PredictionShortfall;
  readonly dataGaps: readonly string[];
}

export function normalizePredictionShortfall(
  predictionShortfall: unknown,
  dataGaps: readonly string[],
): NormalizedPredictionShortfall {
  let normalized = readPredictionShortfall(predictionShortfall);
  const normalizedDataGaps: string[] = [];

  for (const gap of dataGaps) {
    const legacy = legacyPredictionShortfall(gap);
    if (legacy === undefined) {
      normalizedDataGaps.push(gap);
      continue;
    }
    if (normalized === undefined) {
      normalized = legacy;
      continue;
    }
    if (!sameShortfall(normalized, legacy)) {
      // Conflicts stay visible, but reader-facing gaps use canonical text without the protocol prefix.
      normalizedDataGaps.push(predictionShortfallMaterialGap(legacy));
    }
  }

  return {
    ...(normalized === undefined ? {} : { predictionShortfall: normalized }),
    dataGaps: normalizedDataGaps,
  };
}

export function predictionShortfallMaterialGaps(
  predictionShortfall: unknown,
  dataGaps: readonly string[],
): readonly string[] {
  const normalized = normalizePredictionShortfall(predictionShortfall, dataGaps);
  return [
    ...normalized.dataGaps,
    ...(normalized.predictionShortfall === undefined
      ? []
      : [predictionShortfallMaterialGap(normalized.predictionShortfall)]),
  ];
}

export function predictionShortfallGapCount(
  predictionShortfall: unknown,
  dataGaps: readonly string[],
): number {
  return predictionShortfallMaterialGaps(predictionShortfall, dataGaps).length;
}

export function normalizePredictionShortfallReport(
  report: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (report === undefined) {
    return undefined;
  }
  const normalized = normalizePredictionShortfall(
    report.predictionShortfall,
    stringArrayValue(report.dataGaps),
  );
  const {
    predictionShortfall: _predictionShortfall,
    dataGaps: _dataGaps,
    ...reportWithoutShortfall
  } = report;
  return {
    ...reportWithoutShortfall,
    ...(normalized.predictionShortfall === undefined
      ? {}
      : { predictionShortfall: normalized.predictionShortfall }),
    dataGaps: normalized.dataGaps,
  };
}
