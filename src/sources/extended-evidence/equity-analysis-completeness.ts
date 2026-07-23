import type {
  AssetClass,
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
import type { CapitalOwnershipArtifact } from "./capital-ownership";
import {
  DEFAULT_OPERATING_KPI_REGISTRY,
  lookupOperatingKpiRegistry,
  type OperatingKpiRegistryEntry,
} from "./operating-kpi-registry";

const DAY_MS = 86_400_000;
const CURRENT_ANNUAL_MAX_AGE_DAYS = 550;
const QUARTER_FILING_LAG_DAYS = 60;
const HALF_YEAR_FILING_LAG_DAYS = 120;
const PERIOD_END_TOLERANCE_DAYS = 10;
const MIN_ANNUAL_PERIODS = 3;
const MIN_QUARTER_ONLY_PERIODS = 4;

export interface EquityAnalysisCompletenessInput {
  readonly asOf: string;
  readonly symbol?: string;
  readonly assetClass: AssetClass;
  readonly financialStatements?: FinancialStatementsArtifact;
  readonly extendedEvidence?: ExtendedEvidence;
  readonly earningsSetup?: EarningsSetupCollected;
  readonly capitalOwnership?: CapitalOwnershipArtifact;
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
  expectedInterimEnd: string | undefined,
): boolean {
  const series = artifact.statements.perShare.dilutedEps;
  const hasCurrentAnnual = fullYearFacts(series).some(
    (fact) => fact.periodEnd === currentAnnualEnd,
  );
  if (!hasCurrentAnnual) {
    return true;
  }
  if (expectedInterimEnd === undefined) {
    return false;
  }
  const quarterOnlyCount = series.interim.filter((fact) => {
    const months = financialStatementPeriodMonths(fact);
    const trailingStart = addMonths(expectedInterimEnd, -12);
    return (
      months !== undefined &&
      months >= 2 &&
      months <= 4 &&
      trailingStart !== undefined &&
      fact.periodEnd > trailingStart &&
      fact.periodEnd <= expectedInterimEnd
    );
  }).length;
  return !(
    (series.ttm !== undefined &&
      alignedWithExpectedEnd(series.ttm.periodEnd, expectedInterimEnd)) ||
    (artifact.interimCadence === "quarterly" && quarterOnlyCount >= MIN_QUARTER_ONLY_PERIODS)
  );
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
  const hasTrailingCoverage = quarterOnlyCount >= MIN_QUARTER_ONLY_PERIODS || exactTtmCoversWindow;
  if (!hasTrailingCoverage) {
    reasons.push("quarterly-periods-insufficient");
    reasons.push("ttm-unreconciled");
  }
  return reasons;
}

function currentStatementIncomplete(
  artifact: FinancialStatementsArtifact,
  currentAnnual: FinancialStatementFact,
  expectedInterimEnd: string | undefined,
): boolean {
  const currentDurationPeriodKeys = new Set([`annual|${currentAnnual.periodKey}`]);
  let currentBalancePeriodKey = `annual|${currentAnnual.periodKey}`;
  if (expectedInterimEnd !== undefined) {
    const latestInterim = latestFact(
      artifact.statements.incomeStatement.revenue.interim.filter(
        (fact) =>
          fact.periodEnd > currentAnnual.periodEnd &&
          alignedWithExpectedEnd(fact.periodEnd, expectedInterimEnd),
      ),
    );
    if (latestInterim !== undefined) {
      const interimPeriodKey = `interim|${latestInterim.periodKey}`;
      currentDurationPeriodKeys.add(interimPeriodKey);
      currentBalancePeriodKey = interimPeriodKey;
    }
  }
  const requiredBalanceSheetKeys = [
    "cash",
    "totalAssets",
    "totalLiabilities",
    "stockholdersEquity",
  ] as const;
  return artifact.validationNotes.some(
    (note) =>
      note.code === "incomplete-statement" &&
      note.periodKey !== undefined &&
      ((note.message.startsWith("cashFlowStatement ") &&
        currentDurationPeriodKeys.has(note.periodKey)) ||
        (note.message.startsWith("balanceSheet ") &&
          note.periodKey === currentBalancePeriodKey &&
          requiredBalanceSheetKeys.every((key) => note.message.includes(key)))),
  );
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
  const informationalReasons: string[] = [];
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
  let expectedInterimEnd: string | undefined = undefined;
  switch (artifact.interimCadence) {
    case "quarterly": {
      cadenceReasons = quarterlyReasons(revenue, currentAnnual.periodEnd, asOf);
      expectedInterimEnd = latestDuePeriodEnd(
        currentAnnual.periodEnd,
        asOf,
        3,
        QUARTER_FILING_LAG_DAYS,
      );
      break;
    }
    case "semiannual": {
      cadenceReasons = semiannualReasons(revenue, currentAnnual.periodEnd, asOf);
      expectedInterimEnd = latestDuePeriodEnd(
        currentAnnual.periodEnd,
        asOf,
        6,
        HALF_YEAR_FILING_LAG_DAYS,
      );
      break;
    }
    case "irregular": {
      cadenceReasons = irregularReasons(revenue, currentAnnual.periodEnd);
      expectedInterimEnd = latestFact(
        revenue.interim.filter((fact) => fact.periodEnd > currentAnnual.periodEnd),
      )?.periodEnd;
      break;
    }
    case "annual-only":
    case "unknown": {
      cadenceReasons = ["cadence-unestablished"];
      break;
    }
  }
  reasons.push(...cadenceReasons);
  if (
    expectedInterimEnd === undefined &&
    (artifact.interimCadence === "quarterly" || artifact.interimCadence === "semiannual")
  ) {
    informationalReasons.push("annual-as-current");
  }
  if (perShareEvidenceMissing(artifact, currentAnnual.periodEnd, expectedInterimEnd)) {
    reasons.push("per-share-evidence-missing");
  }
  if (currentStatementIncomplete(artifact, currentAnnual, expectedInterimEnd)) {
    reasons.push("current-primary-statements-incomplete");
  }
  if (artifact.structuredFinancialGaps.some((gap) => gap.code === "untagged-6-k")) {
    reasons.push("untagged-interim-evidence");
  }
  return {
    status: reasons.length === 0 ? "complete" : "partial",
    reasonCodes: unique([...reasons, ...informationalReasons]),
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

function capitalOwnershipDimension(
  artifact: CapitalOwnershipArtifact | undefined,
  yahoo: ExtendedEvidenceItem | undefined,
  asOf: string,
): EquityAnalysisCompletenessDimension {
  const reasons = [
    ...(artifact === undefined || artifact.dilutedShares.length < MIN_ANNUAL_PERIODS
      ? ["diluted-share-history-missing"]
      : []),
    ...(artifact === undefined || artifact.stockBasedCompensation.length < MIN_ANNUAL_PERIODS
      ? ["sbc-history-missing"]
      : []),
    ...(artifact === undefined ||
    (artifact.buybacks.length === 0 && artifact.dividendsPaid.length === 0)
      ? ["payout-evidence-missing"]
      : []),
    ...(artifact?.omissions.some((omission) => omission.code === "debt-maturity-untagged") === true
      ? ["debt-maturity-untagged"]
      : []),
    ...(artifact?.subsequentFinancing !== undefined ? ["subsequent-financing-unreconciled"] : []),
  ];
  const sourceIds = unique([
    ...(artifact?.dilutedShares.flatMap((fact) => fact.sourceIds) ?? []),
    ...(artifact?.stockBasedCompensation.flatMap((fact) => fact.sourceIds) ?? []),
    ...(artifact?.buybacks.flatMap((fact) => fact.sourceIds) ?? []),
    ...(artifact?.dividendsPaid.flatMap((fact) => fact.sourceIds) ?? []),
    ...(artifact?.debtPrincipal?.current?.sourceIds ?? []),
    ...(artifact?.debtPrincipal?.noncurrent?.sourceIds ?? []),
    ...(artifact?.subsequentFinancing?.sourceIds ?? []),
    ...(yahoo?.sourceIds ?? []),
  ]);
  return {
    status: reasons.length === 0 ? "complete" : "partial",
    reasonCodes: unique(reasons),
    asOf: artifact?.generatedAt ?? yahoo?.observedAt ?? asOf,
    sourceIds,
  };
}

export function operatingKpisDimension(
  input: Pick<
    EquityAnalysisCompletenessInput,
    "symbol" | "assetClass" | "extendedEvidence" | "asOf"
  >,
  registry: readonly OperatingKpiRegistryEntry[] = DEFAULT_OPERATING_KPI_REGISTRY,
): EquityAnalysisCompletenessDimension {
  const entry =
    input.symbol === undefined
      ? undefined
      : lookupOperatingKpiRegistry(input.symbol, input.assetClass, registry);
  if (entry === undefined) {
    return {
      status: "partial",
      reasonCodes: ["operating-kpi-registry-unconfigured"],
      asOf: input.asOf,
      sourceIds: [],
    };
  }

  if (entry.applicability === "kpi-declared") {
    return {
      status: "partial",
      reasonCodes: entry.kpis.map(
        (kpi) => `operating-kpi-unverified:${entry.symbol.toLowerCase()}-${kpi.key}`,
      ),
      asOf: input.asOf,
      sourceIds: [],
    };
  }

  const evidenceCategories = new Set(entry.notApplicable?.evidenceCategories);
  const evidenceItems =
    input.extendedEvidence?.items.filter((item) => evidenceCategories.has(item.category)) ?? [];
  const sourceIds = unique(evidenceItems.flatMap((item) => item.sourceIds));
  if (sourceIds.length === 0) {
    return {
      status: "partial",
      reasonCodes: ["operating-kpi-not-applicable-evidence-missing"],
      asOf: input.asOf,
      sourceIds: [],
    };
  }

  return {
    status: "not-applicable",
    reasonCodes: [entry.notApplicable?.reasonCode ?? "operating-kpi-not-applicable"],
    asOf: evidenceItems[0]?.observedAt ?? input.asOf,
    sourceIds,
  };
}

function nonCoreDimensions(
  input: EquityAnalysisCompletenessInput,
): Omit<EquityAnalysisCompleteness["dimensions"], "primaryFinancials"> {
  const valuation = itemByCategory(input.extendedEvidence, "valuation");
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
    capitalOwnership: capitalOwnershipDimension(input.capitalOwnership, yahoo, input.asOf),
    operatingKpis: operatingKpisDimension(input),
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
