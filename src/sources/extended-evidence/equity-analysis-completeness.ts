import type {
  EquityAnalysisCompleteness,
  EquityAnalysisCompletenessDimension,
  ExtendedEvidence,
  ExtendedEvidenceItem,
} from "../../domain/types";
import type { EarningsSetupCollected } from "../types";
import type {
  FinancialStatementFact,
  FinancialStatementSeries,
  FinancialStatementsArtifact,
} from "./financial-statements-contract";
import {
  financialStatementPeriodMonths,
  financialStatementPeriodsYearAligned,
} from "./financial-statement-periods";

const DAY_MS = 86_400_000;
const CURRENT_ANNUAL_MAX_AGE_DAYS = 550;
const QUARTER_FILING_LAG_DAYS = 60;
const HALF_YEAR_FILING_LAG_DAYS = 120;
const PERIOD_END_TOLERANCE_DAYS = 10;
const MIN_ANNUAL_PERIODS = 3;
const MIN_QUARTER_ONLY_PERIODS = 4;

export interface EquityAnalysisCompletenessInput {
  readonly asOf: string;
  readonly financialStatements?: FinancialStatementsArtifact;
  readonly extendedEvidence?: ExtendedEvidence;
  readonly earningsSetup?: EarningsSetupCollected;
}

type PrimaryFinancialsDimension = EquityAnalysisCompletenessDimension & {
  readonly status: "complete" | "partial" | "blocked";
};

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function dateMs(value: string): number | undefined {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function daysBetween(start: string, end: string): number | undefined {
  const startMs = dateMs(start);
  const endMs = dateMs(end);
  return startMs === undefined || endMs === undefined ? undefined : (endMs - startMs) / DAY_MS;
}

function addDays(value: string, days: number): string | undefined {
  const parsed = dateMs(value);
  return parsed === undefined
    ? undefined
    : new Date(parsed + days * DAY_MS).toISOString().slice(0, 10);
}

function addMonths(value: string, months: number): string | undefined {
  const parsed = dateMs(value);
  if (parsed === undefined) {
    return undefined;
  }
  const date = new Date(parsed);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const targetLastDay = new Date(Date.UTC(year, month + months + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month + months, day === lastDay ? targetLastDay : day))
    .toISOString()
    .slice(0, 10);
}

function fullYearFacts(series: FinancialStatementSeries): readonly FinancialStatementFact[] {
  return series.annual.filter((fact) => {
    const months = financialStatementPeriodMonths(fact);
    return months !== undefined && months >= 10 && months <= 14;
  });
}

function latestFact(facts: readonly FinancialStatementFact[]): FinancialStatementFact | undefined {
  return facts.toSorted(
    (left, right) =>
      right.periodEnd.localeCompare(left.periodEnd) || right.filedAt.localeCompare(left.filedAt),
  )[0];
}

function alignedWithExpectedEnd(actual: string, expected: string): boolean {
  return Math.abs(daysBetween(actual, expected) ?? Infinity) <= PERIOD_END_TOLERANCE_DAYS;
}

function latestDuePeriodEnd(
  annualEnd: string,
  asOf: string,
  months: number,
  filingLagDays: number,
): string | undefined {
  let periodEnd = addMonths(annualEnd, months);
  let latest: string | undefined = undefined;
  while (periodEnd !== undefined) {
    const dueAt = addDays(periodEnd, filingLagDays);
    if (dueAt === undefined || dueAt > asOf.slice(0, 10)) {
      break;
    }
    latest = periodEnd;
    periodEnd = addMonths(periodEnd, months);
  }
  return latest;
}

function hasCompatibleCurrency(artifact: FinancialStatementsArtifact): boolean {
  const currency = artifact.reportingCurrency;
  if (currency === undefined) {
    return false;
  }
  const facts = [
    ...Object.values(artifact.statements.incomeStatement),
    ...Object.values(artifact.statements.balanceSheet),
    ...Object.values(artifact.statements.cashFlowStatement),
  ].flatMap((series) => [...series.annual, ...series.interim]);
  return facts.every((fact) => fact.currency === currency);
}

function perShareEvidenceMissing(
  artifact: FinancialStatementsArtifact,
  currentAnnualEnd: string,
  interimDue: boolean,
): boolean {
  const series = artifact.statements.perShare.dilutedEps;
  const issued = series.annual.length > 0 || series.interim.length > 0;
  if (!issued) {
    return false;
  }
  const hasCurrentAnnual = fullYearFacts(series).some(
    (fact) => fact.periodEnd === currentAnnualEnd,
  );
  return !hasCurrentAnnual || (interimDue && series.ttm === undefined);
}

function quarterlyReasons(
  revenue: FinancialStatementSeries,
  annualEnd: string,
  asOf: string,
): readonly string[] {
  const expectedEnd = latestDuePeriodEnd(annualEnd, asOf, 3, QUARTER_FILING_LAG_DAYS);
  if (expectedEnd === undefined) {
    return [];
  }
  const latestInterim = latestFact(revenue.interim.filter((fact) => fact.periodEnd > annualEnd));
  const reasons: string[] = [];
  if (
    latestInterim === undefined ||
    !alignedWithExpectedEnd(latestInterim.periodEnd, expectedEnd)
  ) {
    reasons.push("latest-due-interim-missing");
  }
  const trailingStart = addMonths(expectedEnd, -12);
  const quarterOnlyCount = revenue.interim.filter((fact) => {
    const months = financialStatementPeriodMonths(fact);
    return (
      months !== undefined &&
      months >= 2 &&
      months <= 4 &&
      trailingStart !== undefined &&
      fact.periodEnd > trailingStart &&
      fact.periodEnd <= expectedEnd
    );
  }).length;
  const exactTtmCoversWindow =
    revenue.ttm !== undefined && alignedWithExpectedEnd(revenue.ttm.periodEnd, expectedEnd);
  if (quarterOnlyCount < MIN_QUARTER_ONLY_PERIODS && !exactTtmCoversWindow) {
    reasons.push("quarterly-periods-insufficient");
  }
  if (!exactTtmCoversWindow) {
    reasons.push("ttm-unreconciled");
  }
  return reasons;
}

function semiannualReasons(
  revenue: FinancialStatementSeries,
  annualEnd: string,
  asOf: string,
): readonly string[] {
  const expectedEnd = latestDuePeriodEnd(annualEnd, asOf, 6, HALF_YEAR_FILING_LAG_DAYS);
  if (expectedEnd === undefined) {
    return [];
  }
  const latest = latestFact(revenue.interim.filter((fact) => fact.periodEnd > annualEnd));
  const prior =
    latest === undefined
      ? undefined
      : latestFact(
          revenue.interim.filter(
            (fact) =>
              fact.periodEnd < annualEnd &&
              financialStatementPeriodsYearAligned(fact, latest) &&
              financialStatementPeriodMonths(fact) === financialStatementPeriodMonths(latest),
          ),
        );
  const reasons: string[] = [];
  if (latest === undefined || !alignedWithExpectedEnd(latest.periodEnd, expectedEnd)) {
    reasons.push("latest-due-interim-missing");
  }
  if (prior === undefined) {
    reasons.push("semiannual-comparison-missing");
  }
  if (revenue.ttm === undefined || !alignedWithExpectedEnd(revenue.ttm.periodEnd, expectedEnd)) {
    reasons.push("ttm-unreconciled");
  }
  return reasons;
}

function irregularReasons(revenue: FinancialStatementSeries, annualEnd: string): readonly string[] {
  const latest = latestFact(revenue.interim.filter((fact) => fact.periodEnd > annualEnd));
  const prior =
    latest === undefined
      ? undefined
      : latestFact(
          revenue.interim.filter(
            (fact) =>
              fact.periodEnd < annualEnd && financialStatementPeriodsYearAligned(fact, latest),
          ),
        );
  return [
    ...(latest === undefined ? ["latest-due-interim-missing"] : []),
    ...(prior === undefined ? ["irregular-comparison-missing"] : []),
    ...(revenue.ttm === undefined ? ["ttm-unreconciled"] : []),
  ];
}

function primaryFinancialsDimension(
  artifact: FinancialStatementsArtifact | undefined,
  asOf: string,
): PrimaryFinancialsDimension {
  if (artifact === undefined) {
    return {
      status: "blocked",
      reasonCodes: ["current-annual-statement-missing"],
      asOf,
      sourceIds: [],
    };
  }
  const sourceIds = unique([
    artifact.sourceId,
    ...artifact.structuredFinancialGaps.flatMap((gap) => gap.sourceIds),
  ]);
  const { revenue } = artifact.statements.incomeStatement;
  const annualFacts = fullYearFacts(revenue);
  const currentAnnual = latestFact(annualFacts);
  const annualAge =
    currentAnnual === undefined
      ? undefined
      : daysBetween(currentAnnual.periodEnd, asOf.slice(0, 10));
  if (
    currentAnnual === undefined ||
    annualAge === undefined ||
    annualAge < 0 ||
    annualAge > CURRENT_ANNUAL_MAX_AGE_DAYS
  ) {
    return {
      status: "blocked",
      reasonCodes: ["current-annual-statement-missing"],
      asOf: artifact.analysisAsOf,
      sourceIds,
    };
  }

  const reasons: string[] = [];
  if (annualFacts.length < MIN_ANNUAL_PERIODS) {
    reasons.push("annual-history-insufficient");
  }
  if (!hasCompatibleCurrency(artifact)) {
    reasons.push(
      artifact.reportingCurrency === undefined
        ? "reporting-currency-missing"
        : "reporting-currency-incompatible",
    );
  }
  let cadenceReasons: readonly string[] = [];
  switch (artifact.interimCadence) {
    case "quarterly": {
      cadenceReasons = quarterlyReasons(revenue, currentAnnual.periodEnd, asOf);
      break;
    }
    case "semiannual": {
      cadenceReasons = semiannualReasons(revenue, currentAnnual.periodEnd, asOf);
      break;
    }
    case "irregular": {
      cadenceReasons = irregularReasons(revenue, currentAnnual.periodEnd);
      break;
    }
    case "annual-only":
    case "unknown": {
      cadenceReasons = ["cadence-unestablished"];
      break;
    }
  }
  reasons.push(...cadenceReasons);
  const interimDue =
    (artifact.interimCadence === "quarterly" &&
      latestDuePeriodEnd(currentAnnual.periodEnd, asOf, 3, QUARTER_FILING_LAG_DAYS) !==
        undefined) ||
    (artifact.interimCadence === "semiannual" &&
      latestDuePeriodEnd(currentAnnual.periodEnd, asOf, 6, HALF_YEAR_FILING_LAG_DAYS) !==
        undefined) ||
    (artifact.interimCadence === "irregular" &&
      revenue.interim.some((fact) => fact.periodEnd > currentAnnual.periodEnd));
  if (perShareEvidenceMissing(artifact, currentAnnual.periodEnd, interimDue)) {
    reasons.push("per-share-evidence-missing");
  }
  if (artifact.structuredFinancialGaps.some((gap) => gap.code === "untagged-6-k")) {
    reasons.push("untagged-interim-evidence");
  }
  return {
    status: reasons.length === 0 ? "complete" : "partial",
    reasonCodes: unique(reasons),
    asOf: artifact.analysisAsOf,
    sourceIds,
  };
}

function itemByCategory(
  evidence: ExtendedEvidence | undefined,
  category: ExtendedEvidenceItem["category"],
): ExtendedEvidenceItem | undefined {
  return evidence?.items.find((item) => item.category === category);
}

function hasNumericMetrics(
  item: ExtendedEvidenceItem | undefined,
  keys: readonly string[],
): boolean {
  return keys.every((key) => typeof item?.metrics?.[key] === "number");
}

function evidenceDimension(input: {
  readonly complete: boolean;
  readonly partialReason: string;
  readonly asOf: string;
  readonly sourceIds?: readonly string[];
}): EquityAnalysisCompletenessDimension {
  return {
    status: input.complete ? "complete" : "partial",
    reasonCodes: input.complete ? [] : [input.partialReason],
    asOf: input.asOf,
    sourceIds: unique(input.sourceIds ?? []),
  };
}

function nonCoreDimensions(
  input: EquityAnalysisCompletenessInput,
): Omit<EquityAnalysisCompleteness["dimensions"], "primaryFinancials"> {
  const valuation = itemByCategory(input.extendedEvidence, "valuation");
  const sec = input.extendedEvidence?.items.find(
    (item) => item.category === "sec-edgar" && item.metrics !== undefined,
  );
  const yahoo = itemByCategory(input.extendedEvidence, "yahoo-fundamentals");
  const expectationsSourceIds = input.earningsSetup?.event.sourceIds ?? [];
  return {
    valuation: evidenceDimension({
      complete: hasNumericMetrics(valuation, ["enterpriseValue", "annualizedRevenue"]),
      partialReason:
        valuation === undefined ? "valuation-evidence-missing" : "valuation-inputs-incomplete",
      asOf: valuation?.observedAt ?? input.asOf,
      ...(valuation !== undefined ? { sourceIds: valuation.sourceIds } : {}),
    }),
    expectations: evidenceDimension({
      complete:
        input.earningsSetup?.event.epsEstimate !== undefined &&
        input.earningsSetup.event.revenueEstimate !== undefined,
      partialReason:
        input.earningsSetup === undefined
          ? "expectations-evidence-missing"
          : "expectations-inputs-incomplete",
      asOf: input.earningsSetup?.event.fetchedAt ?? input.asOf,
      sourceIds: expectationsSourceIds,
    }),
    capitalOwnership: evidenceDimension({
      complete: hasNumericMetrics(yahoo, ["sharesOutstanding"]),
      partialReason:
        yahoo === undefined
          ? "capital-ownership-evidence-missing"
          : "capital-ownership-inputs-incomplete",
      asOf: yahoo?.observedAt ?? input.asOf,
      ...(yahoo !== undefined ? { sourceIds: yahoo.sourceIds } : {}),
    }),
    operatingKpis: evidenceDimension({
      complete: hasNumericMetrics(sec, ["revenue", "grossProfit", "operatingIncome", "netIncome"]),
      partialReason:
        sec === undefined ? "operating-kpi-evidence-missing" : "operating-kpi-inputs-incomplete",
      asOf: sec?.observedAt ?? input.asOf,
      ...(sec !== undefined ? { sourceIds: sec.sourceIds } : {}),
    }),
  };
}

export function deriveEquityAnalysisCompleteness(
  input: EquityAnalysisCompletenessInput,
): EquityAnalysisCompleteness {
  const primaryFinancials = primaryFinancialsDimension(input.financialStatements, input.asOf);
  const nonCore = nonCoreDimensions(input);
  const completeOrNotApplicable = Object.values(nonCore).filter(
    (dimension) => dimension.status === "complete" || dimension.status === "not-applicable",
  ).length;
  const financialCoreStatus = primaryFinancials.status;
  let coverageLevel: EquityAnalysisCompleteness["coverageLevel"] = "substantial";
  if (financialCoreStatus !== "complete" || completeOrNotApplicable <= 1) {
    coverageLevel = "limited";
  } else if (completeOrNotApplicable === 4) {
    coverageLevel = "comprehensive";
  }
  return {
    version: 1,
    financialCoreStatus,
    coverageLevel,
    asOf: input.asOf,
    dimensions: { primaryFinancials, ...nonCore },
  };
}
