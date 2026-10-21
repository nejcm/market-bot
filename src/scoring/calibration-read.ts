import { isMarketRegimeLabel } from "../domain/report";
import { isRecord, readNumber, readString } from "../guards";
import {
  isCalibrationCount,
  isPositiveCalibrationCount,
  isUnitInterval,
} from "./calibration-invariant";
import type {
  CalibrationBin,
  CalibrationMetric,
  PairedSkillDecisionRule,
  PairedSkillMetric,
  PairedSkillPolicy,
  PairedSkillStatus,
  PairedSkillSummary,
} from "./types";

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

const PAIRED_SKILL_STATUSES: readonly PairedSkillStatus[] = [
  "model-better",
  "baseline-better",
  "not-yet-decidable",
];

function isDelta(value: number): boolean {
  return value >= -1 && value <= 1;
}

export function pairedSkillDecisionRule(
  status: PairedSkillStatus,
  meetsMinimumUsefulEffect: boolean,
): PairedSkillDecisionRule {
  if (status === "baseline-better") {
    return "publish-baseline";
  }
  return status === "model-better" && meetsMinimumUsefulEffect ? "keep-model" : "keep-recording";
}

const DECISION_RULE_TEXT: Record<PairedSkillDecisionRule, string> = {
  "keep-model": "keep model probabilities; consider a model/baseline mixture",
  "keep-recording": "keep recording, no change",
  "publish-baseline": "publish the Forecast Baseline as the stated probability",
};

export function pairedSkillDecisionText(rule: PairedSkillDecisionRule | undefined): string {
  return rule === undefined ? "none (decided per kind)" : DECISION_RULE_TEXT[rule];
}

function parsePairedSkillMetric(value: unknown, perKind: boolean): PairedSkillMetric | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const count = readNumberWhere(value, "count", isPositiveCalibrationCount);
  const subjectCount = readNumberWhere(value, "subjectCount", isPositiveCalibrationCount);
  const blockCount = readNumberWhere(value, "blockCount", isPositiveCalibrationCount);
  const modelBrier = readNumberWhere(value, "modelBrier", isUnitInterval);
  const baselineBrier = readNumberWhere(value, "baselineBrier", isUnitInterval);
  const deltaBrier = readNumberWhere(value, "deltaBrier", isDelta);
  const skillVsHalf = readNumberWhere(value, "skillVsHalf", (candidate) => candidate <= 1);
  const ciLow = readNumberWhere(value, "ciLow", isDelta);
  const ciHigh = readNumberWhere(value, "ciHigh", isDelta);
  const status = PAIRED_SKILL_STATUSES.find((candidate) => candidate === value.status);
  if (
    count === undefined ||
    subjectCount === undefined ||
    blockCount === undefined ||
    modelBrier === undefined ||
    baselineBrier === undefined ||
    deltaBrier === undefined ||
    skillVsHalf === undefined ||
    status === undefined
  ) {
    return undefined;
  }
  return {
    count,
    subjectCount,
    blockCount,
    modelBrier,
    baselineBrier,
    deltaBrier,
    ...(ciLow !== undefined && ciHigh !== undefined && ciLow <= ciHigh ? { ciLow, ciHigh } : {}),
    skillVsHalf,
    status,
    meetsMinimumUsefulEffect: value.meetsMinimumUsefulEffect === true,
    ...(perKind
      ? { decisionRule: pairedSkillDecisionRule(status, value.meetsMinimumUsefulEffect === true) }
      : {}),
  };
}

function parsePairedSkillByKind(value: unknown): Record<string, PairedSkillMetric> {
  return isRecord(value)
    ? Object.fromEntries(
        Object.entries(value).flatMap(([kind, raw]) => {
          const metric = parsePairedSkillMetric(raw, true);
          return metric === undefined ? [] : [[kind, metric] as const];
        }),
      )
    : {};
}

export function parsePairedSkillSummary(value: unknown): PairedSkillSummary | undefined {
  if (!isRecord(value) || !isRecord(value.policy)) {
    return undefined;
  }
  const { policy } = value;
  const minimumUsefulEffect = readNumberWhere(policy, "minimumUsefulEffect", isUnitInterval);
  const minPairedCount = readNumberWhere(policy, "minPairedCount", isCalibrationCount);
  const minBlockCount = readNumberWhere(policy, "minBlockCount", isCalibrationCount);
  const confidenceLevel = readNumberWhere(policy, "confidenceLevel", isUnitInterval);
  const bootstrapResamples = readNumberWhere(policy, "bootstrapResamples", isCalibrationCount);
  const seed = readNumberWhere(policy, "seed", isCalibrationCount);
  const poweredBlockCount = readNumberWhere(policy, "poweredBlockCount", isCalibrationCount);
  const excludedWithoutBaselineCount = readNumberWhere(
    value,
    "excludedWithoutBaselineCount",
    isCalibrationCount,
  );
  if (
    minimumUsefulEffect === undefined ||
    minPairedCount === undefined ||
    minBlockCount === undefined ||
    confidenceLevel === undefined ||
    bootstrapResamples === undefined ||
    seed === undefined ||
    poweredBlockCount === undefined ||
    excludedWithoutBaselineCount === undefined
  ) {
    return undefined;
  }
  const overall = parsePairedSkillMetric(value.overall, false);
  const nextReviewDate = readString(value, "nextReviewDate");
  return {
    policy: {
      minimumUsefulEffect,
      minPairedCount,
      minBlockCount,
      confidenceLevel,
      bootstrapResamples,
      seed,
      poweredBlockCount,
    },
    excludedWithoutBaselineCount,
    ...(overall === undefined ? {} : { overall }),
    byKind: parsePairedSkillByKind(value.byKind),
    ...(nextReviewDate !== undefined && /^\d{4}-\d{2}-\d{2}$/u.test(nextReviewDate)
      ? { nextReviewDate }
      : {}),
  };
}

export function pairedSkillStatusText(
  metric: PairedSkillMetric,
  policy: PairedSkillPolicy,
): string {
  const floors = [
    ...(metric.count < policy.minPairedCount ? [`${String(policy.minPairedCount)}-event`] : []),
    ...(metric.blockCount < policy.minBlockCount ? [`${String(policy.minBlockCount)}-block`] : []),
  ];
  if (floors.length > 0) {
    return `${metric.status} (below ${floors.join(" and ")} floor)`;
  }
  return metric.meetsMinimumUsefulEffect
    ? `${metric.status} (meets minimum useful effect)`
    : metric.status;
}

export function pairedSkillPolicyNote(policy: PairedSkillPolicy): string {
  return `Floor ${String(policy.minPairedCount)} events and ${String(policy.minBlockCount)} blocks; 80% power for ΔBrier ${String(policy.minimumUsefulEffect)} (SD 0.10) needs about ${String(policy.poweredBlockCount)} independent blocks, so expect not-yet-decidable until then and treat earlier statuses as provisional. Minimum useful effect ΔBrier ≥ ${String(policy.minimumUsefulEffect)} gates keeping model probabilities; baseline-better needs only an interval below 0.`;
}
