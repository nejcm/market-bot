import { isRecord, readString, readStringArray } from "../guards";
import type { EquityAnalysisCompleteness, EquityAnalysisCompletenessDimension } from "./types";

export const EQUITY_ANALYSIS_COMPLETENESS_DIMENSION_KEYS = [
  "primaryFinancials",
  "valuation",
  "expectations",
  "capitalOwnership",
  "operatingKpis",
] as const;

function isDimensionStatus(value: unknown): boolean {
  return (
    value === "complete" ||
    value === "partial" ||
    value === "blocked" ||
    value === "not-applicable" ||
    value === "not-assessed"
  );
}

export function readEquityAnalysisCompleteness(
  value: unknown,
): EquityAnalysisCompleteness | undefined {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    (value.financialCoreStatus !== "complete" &&
      value.financialCoreStatus !== "partial" &&
      value.financialCoreStatus !== "blocked") ||
    (value.coverageLevel !== "comprehensive" &&
      value.coverageLevel !== "substantial" &&
      value.coverageLevel !== "limited") ||
    readString(value, "asOf") === undefined ||
    !isRecord(value.dimensions)
  ) {
    return undefined;
  }
  for (const key of EQUITY_ANALYSIS_COMPLETENESS_DIMENSION_KEYS) {
    const dimension = value.dimensions[key];
    if (
      !isRecord(dimension) ||
      !isDimensionStatus(dimension.status) ||
      readStringArray(dimension, "reasonCodes") === undefined ||
      readString(dimension, "asOf") === undefined ||
      readStringArray(dimension, "sourceIds") === undefined
    ) {
      return undefined;
    }
  }
  const { primaryFinancials } = value.dimensions;
  if (
    !isRecord(primaryFinancials) ||
    primaryFinancials.status === "not-applicable" ||
    primaryFinancials.status === "not-assessed" ||
    value.financialCoreStatus !== primaryFinancials.status
  ) {
    return undefined;
  }
  return value as unknown as EquityAnalysisCompleteness;
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.includes("T") && Number.isFinite(Date.parse(value));
}

export function assertEquityAnalysisCompleteness(value: EquityAnalysisCompleteness): void {
  if (value.version !== 1 || !isIsoTimestamp(value.asOf)) {
    throw new Error("Equity analysis completeness requires version 1 and an ISO asOf timestamp");
  }
  const primaryStatus = value.dimensions.primaryFinancials.status;
  if (primaryStatus !== "complete" && primaryStatus !== "partial" && primaryStatus !== "blocked") {
    throw new Error("Primary financial completeness status is invalid");
  }
  if (value.financialCoreStatus !== primaryStatus) {
    throw new Error("Financial core status must equal the primaryFinancials status");
  }
  for (const key of EQUITY_ANALYSIS_COMPLETENESS_DIMENSION_KEYS) {
    const dimension = value.dimensions[key];
    if (!isDimensionStatus(dimension.status)) {
      throw new Error(`Equity analysis completeness ${key} status is invalid`);
    }
    if (!isIsoTimestamp(dimension.asOf)) {
      throw new Error(`Equity analysis completeness ${key} asOf must be an ISO timestamp`);
    }
    if (dimension.reasonCodes.some((code) => code.trim() === "")) {
      throw new Error(`Equity analysis completeness ${key} reason codes must be non-empty`);
    }
    if (
      dimension.status === "not-applicable" &&
      (dimension.sourceIds.length === 0 ||
        dimension.reasonCodes.length === 0 ||
        dimension.reasonCodes.some((code) => /credential|entitlement/iu.test(code)))
    ) {
      throw new Error(
        `Equity analysis completeness ${key} not-applicable status requires affirmative evidence`,
      );
    }
    if (dimension.status === "not-assessed" && dimension.reasonCodes.length === 0) {
      throw new Error(
        `Equity analysis completeness ${key} not-assessed status requires a reason code`,
      );
    }
  }
  const dimensions = [
    value.dimensions.valuation,
    value.dimensions.expectations,
    value.dimensions.capitalOwnership,
    value.dimensions.operatingKpis,
  ];
  const expectedCoverage = resolveCoverageLevel(dimensions, primaryStatus);
  if (value.coverageLevel !== expectedCoverage) {
    throw new Error("Equity analysis completeness coverageLevel conflicts with dimension statuses");
  }
}

export function resolveCoverageLevel(
  dimensions: readonly EquityAnalysisCompletenessDimension[],
  financialCoreStatus: EquityAnalysisCompleteness["financialCoreStatus"],
): EquityAnalysisCompleteness["coverageLevel"] {
  // Not-assessed dimensions deliberately remain un-credited, so the label never moves a grade.
  const completeOrNotApplicable = dimensions.filter(
    (dimension) => dimension.status === "complete" || dimension.status === "not-applicable",
  ).length;
  if (financialCoreStatus !== "complete" || completeOrNotApplicable <= 1) {
    return "limited";
  }
  if (completeOrNotApplicable === dimensions.length) {
    return "comprehensive";
  }
  return "substantial";
}
