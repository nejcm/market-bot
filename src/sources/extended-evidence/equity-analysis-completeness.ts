import type {
  AssetClass,
  EquityAnalysisCompleteness,
  EquityAnalysisCompletenessDimension,
  ExtendedEvidence,
  ExtendedEvidenceItem,
  SourceGap,
} from "../../domain/types";
import { resolveCoverageLevel } from "../../domain/equity-analysis-completeness";
import { sourceGap } from "../../domain/source-gaps";
import type { EarningsSetupCollected } from "../types";
import type {
  FinancialStatementFact,
  FinancialStatementSeries,
  FinancialStatementsArtifact,
  InterimCadence,
} from "./financial-statements-contract";
import {
  financialStatementFacts,
  financialStatementPeriodMonths,
  financialStatementPeriodsYearAligned,
  financialStatementSeries,
  latestFinancialStatementFact,
} from "./financial-statement-selection";
import type { CapitalOwnershipArtifact } from "./capital-ownership";
import type {
  AnalystExpectationsArtifact,
  AnalystExpectationsSignal,
} from "./analyst-expectations";
import type {
  InstitutionalOwnershipArtifact,
  InstitutionalOwnershipSignal,
} from "./institutional-ownership";
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
  readonly analystExpectations?: AnalystExpectationsArtifact;
  readonly analystExpectationsSignal?: AnalystExpectationsSignal;
  readonly institutionalOwnership?: InstitutionalOwnershipArtifact;
  readonly institutionalOwnershipSignal?: InstitutionalOwnershipSignal;
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

// The interim period whose filing deadline has already passed, for the cadences that have one.
// Irregular filers have no deadline to compute against, and annual-only/unknown have no interim.
function dueInterimPeriodEnd(
  cadence: InterimCadence,
  annualEnd: string,
  asOf: string,
): string | undefined {
  switch (cadence) {
    case "quarterly": {
      return latestDuePeriodEnd(annualEnd, asOf, 3, QUARTER_FILING_LAG_DAYS);
    }
    case "semiannual": {
      return latestDuePeriodEnd(annualEnd, asOf, 6, HALF_YEAR_FILING_LAG_DAYS);
    }
    default: {
      return undefined;
    }
  }
}

/** Reporting-surface freshness facts: what cadence the issuer files on, the newest period it has
 *  actually reported, and the newest period whose deadline has passed. Absent without a usable
 *  statement artifact (one reporting at least one primary-revenue period); `latestDuePeriodEnd`
 *  is absent when nothing is due — an irregular or annual-only filer, or a first year. */
export interface EquityReportingFreshness {
  readonly interimCadence: InterimCadence;
  readonly latestReportedPeriodEnd: string;
  readonly latestDuePeriodEnd?: string;
}

export function deriveEquityReportingFreshness(
  artifact: FinancialStatementsArtifact | undefined,
  asOf: string,
): EquityReportingFreshness | undefined {
  if (artifact === undefined) {
    return undefined;
  }
  const { revenue } = artifact.statements.incomeStatement;
  // Annual and interim only — a derived TTM would name a period the issuer never filed.
  const latestReported = latestFinancialStatementFact(financialStatementFacts(revenue));
  if (latestReported === undefined) {
    // An artifact with no reported primary-revenue period is not a usable reporting surface;
    // Publishing `interimCadence: unknown` for it would be freshness context that says nothing.
    return undefined;
  }
  const currentAnnual = latestFinancialStatementFact(fullYearFacts(revenue));
  const due =
    currentAnnual === undefined
      ? undefined
      : dueInterimPeriodEnd(artifact.interimCadence, currentAnnual.periodEnd, asOf);
  return {
    interimCadence: artifact.interimCadence,
    latestReportedPeriodEnd: latestReported.periodEnd,
    ...(due !== undefined ? { latestDuePeriodEnd: due } : {}),
  };
}

function hasCompatibleCurrency(artifact: FinancialStatementsArtifact): boolean {
  const currency = artifact.reportingCurrency;
  if (currency === undefined) {
    return false;
  }
  const facts = financialStatementSeries(artifact)
    .filter((series) => series.statement !== "perShare")
    .flatMap((series) => financialStatementFacts(series));
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
  const latestInterim = latestFinancialStatementFact(
    revenue.interim.filter((fact) => fact.periodEnd > annualEnd),
  );
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
    const latestInterim = latestFinancialStatementFact(
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
  const latest = latestFinancialStatementFact(
    revenue.interim.filter((fact) => fact.periodEnd > annualEnd),
  );
  const prior =
    latest === undefined
      ? undefined
      : latestFinancialStatementFact(
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
  const latest = latestFinancialStatementFact(
    revenue.interim.filter((fact) => fact.periodEnd > annualEnd),
  );
  const prior =
    latest === undefined
      ? undefined
      : latestFinancialStatementFact(
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
  const currentAnnual = latestFinancialStatementFact(annualFacts);
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
      expectedInterimEnd = dueInterimPeriodEnd("quarterly", currentAnnual.periodEnd, asOf);
      break;
    }
    case "semiannual": {
      cadenceReasons = semiannualReasons(revenue, currentAnnual.periodEnd, asOf);
      expectedInterimEnd = dueInterimPeriodEnd("semiannual", currentAnnual.periodEnd, asOf);
      break;
    }
    case "irregular": {
      cadenceReasons = irregularReasons(revenue, currentAnnual.periodEnd);
      expectedInterimEnd = latestFinancialStatementFact(
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

function ownershipInformationalReasons(
  signal: InstitutionalOwnershipSignal | undefined,
): readonly string[] {
  if (signal?.status === "forbidden") {
    return ["ownership-provider-entitlement-blocked"];
  }
  if (signal?.status === "missing-credential") {
    return ["ownership-provider-credential-missing"];
  }
  return signal?.status === "available" && signal.sourceIds.length > 0
    ? ["ownership-external-context-available"]
    : [];
}

function capitalOwnershipDimension(
  artifact: CapitalOwnershipArtifact | undefined,
  yahoo: ExtendedEvidenceItem | undefined,
  ownershipSignal: InstitutionalOwnershipSignal | undefined,
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
  const informationalReasons = ownershipInformationalReasons(ownershipSignal);
  const sourceIds = unique([
    ...(artifact?.dilutedShares.flatMap((fact) => fact.sourceIds) ?? []),
    ...(artifact?.stockBasedCompensation.flatMap((fact) => fact.sourceIds) ?? []),
    ...(artifact?.buybacks.flatMap((fact) => fact.sourceIds) ?? []),
    ...(artifact?.dividendsPaid.flatMap((fact) => fact.sourceIds) ?? []),
    ...(artifact?.debtPrincipal?.current?.sourceIds ?? []),
    ...(artifact?.debtPrincipal?.noncurrent?.sourceIds ?? []),
    ...(artifact?.subsequentFinancing?.sourceIds ?? []),
    ...(yahoo?.sourceIds ?? []),
    ...(ownershipSignal?.status === "available" ? ownershipSignal.sourceIds : []),
  ]);
  return {
    status: reasons.length === 0 ? "complete" : "partial",
    reasonCodes: unique([...reasons, ...informationalReasons]),
    asOf: artifact?.generatedAt ?? yahoo?.observedAt ?? asOf,
    sourceIds,
  };
}

function hasConsensus(
  artifact: AnalystExpectationsArtifact | undefined,
  kind: "eps" | "revenue",
): boolean {
  return (artifact?.estimates[kind]?.consensus.length ?? 0) > 0;
}

function expectationsDimension(
  input: EquityAnalysisCompletenessInput,
): EquityAnalysisCompletenessDimension {
  const calendarComplete =
    input.earningsSetup?.event.epsEstimate !== undefined &&
    input.earningsSetup.event.revenueEstimate !== undefined;
  if (calendarComplete) {
    return {
      status: "complete",
      reasonCodes: [],
      asOf: input.earningsSetup?.event.fetchedAt ?? input.asOf,
      sourceIds: unique(input.earningsSetup?.event.sourceIds ?? []),
    };
  }

  const analystSourceIds = unique([
    ...(input.analystExpectations?.estimates.eps?.sourceIds ?? []),
    ...(input.analystExpectations?.estimates.revenue?.sourceIds ?? []),
  ]);
  let providerReason: string | undefined = undefined;
  if (input.analystExpectationsSignal?.status === "forbidden") {
    providerReason = "expectations-provider-entitlement-blocked";
  } else if (input.analystExpectationsSignal?.status === "missing-credential") {
    providerReason = "expectations-provider-credential-missing";
  }
  if (providerReason !== undefined) {
    const inputsWereAssessed =
      input.analystExpectations !== undefined || input.earningsSetup !== undefined;
    return {
      status: inputsWereAssessed ? "partial" : "not-assessed",
      reasonCodes: [
        ...(inputsWereAssessed ? ["expectations-inputs-incomplete"] : []),
        providerReason,
      ],
      asOf:
        input.analystExpectations?.generatedAt ??
        input.earningsSetup?.event.fetchedAt ??
        input.asOf,
      sourceIds: unique([...analystSourceIds, ...(input.earningsSetup?.event.sourceIds ?? [])]),
    };
  }

  if (
    hasConsensus(input.analystExpectations, "eps") &&
    hasConsensus(input.analystExpectations, "revenue")
  ) {
    return {
      status: "complete",
      reasonCodes: [],
      asOf: input.analystExpectations?.generatedAt ?? input.asOf,
      sourceIds: analystSourceIds,
    };
  }

  const hasAnalystResponses = input.analystExpectations !== undefined;
  return {
    status: "partial",
    reasonCodes: [
      hasAnalystResponses || input.earningsSetup !== undefined
        ? "expectations-inputs-incomplete"
        : "expectations-evidence-missing",
    ],
    asOf:
      input.analystExpectations?.generatedAt ?? input.earningsSetup?.event.fetchedAt ?? input.asOf,
    sourceIds: unique([...analystSourceIds, ...(input.earningsSetup?.event.sourceIds ?? [])]),
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
      status: "not-assessed",
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
  return {
    valuation: evidenceDimension({
      complete: hasNumericMetrics(valuation, ["enterpriseValue", "annualizedRevenue"]),
      partialReason:
        valuation === undefined ? "valuation-evidence-missing" : "valuation-inputs-incomplete",
      asOf: valuation?.observedAt ?? input.asOf,
      ...(valuation !== undefined ? { sourceIds: valuation.sourceIds } : {}),
    }),
    expectations: expectationsDimension(input),
    capitalOwnership: capitalOwnershipDimension(
      input.capitalOwnership,
      yahoo,
      input.institutionalOwnershipSignal,
      input.asOf,
    ),
    operatingKpis: operatingKpisDimension(input),
  };
}

// Freshness-negative reason codes only, as an allowlist: a denylist would emit material gaps for
// Informational codes (`annual-as-current` rides along on a `complete` dimension) and for
// Reporting-surface facts that say nothing about currency (`sbc-history-missing` and friends).
export const EQUITY_FRESHNESS_GAP_REASON_CODES: readonly string[] = [
  "current-annual-statement-missing",
  "annual-history-insufficient",
  "latest-due-interim-missing",
  "quarterly-periods-insufficient",
  "semiannual-comparison-missing",
  "irregular-comparison-missing",
  "ttm-unreconciled",
  "cadence-unestablished",
  "per-share-evidence-missing",
  "current-primary-statements-incomplete",
  "untagged-interim-evidence",
  "reporting-currency-missing",
  "reporting-currency-incompatible",
  "subsequent-financing-unreconciled",
];

const FRESHNESS_GAP_REASON_CODES = new Set(EQUITY_FRESHNESS_GAP_REASON_CODES);

function freshnessDetail(freshness: EquityReportingFreshness | undefined): string {
  if (freshness === undefined) {
    return "no reported financial statement period is available";
  }
  return [
    `interim cadence ${freshness.interimCadence}`,
    `latest reported period end ${freshness.latestReportedPeriodEnd}`,
    ...(freshness.latestDuePeriodEnd === undefined
      ? []
      : [`expected due period end ${freshness.latestDuePeriodEnd}`]),
  ].join("; ");
}

// Freshness defects the model must see while it is still writing, as canonical Source Gaps.
// `no-cap` by design: an unfiled quarter is an incomplete reporting surface, not a sourcing
// Failure, so it must not dock Evidence Quality. `SourceGap` has no `code` field, so the reason
// Code is a deterministic message prefix.
export function equityAnalysisCompletenessGaps(
  completeness: EquityAnalysisCompleteness,
  freshness: EquityReportingFreshness | undefined,
  symbol: string | undefined,
): readonly SourceGap[] {
  const detail = freshnessDetail(freshness);
  const subject = symbol?.toUpperCase() ?? "the subject";
  return unique(
    Object.values(completeness.dimensions).flatMap((dimension) => dimension.reasonCodes),
  )
    .filter((code) => FRESHNESS_GAP_REASON_CODES.has(code))
    .map((code) =>
      sourceGap({
        source: "equity-analysis-completeness",
        message: `${code}: ${subject} reporting surface is not current (${detail})`,
        ...(symbol !== undefined ? { symbol } : {}),
        provider: "market-bot",
        capability: "extended-evidence",
        cause: "provider-data-missing",
        evidenceQualityImpact: "no-cap",
        triage: "material",
      }),
    );
}

export function deriveEquityAnalysisCompleteness(
  input: EquityAnalysisCompletenessInput,
): EquityAnalysisCompleteness {
  const primaryFinancials = primaryFinancialsDimension(input.financialStatements, input.asOf);
  const nonCore = nonCoreDimensions(input);
  const financialCoreStatus = primaryFinancials.status;
  const coverageLevel = resolveCoverageLevel(Object.values(nonCore), financialCoreStatus);
  return {
    version: 1,
    financialCoreStatus,
    coverageLevel,
    asOf: input.asOf,
    dimensions: { primaryFinancials, ...nonCore },
  };
}
