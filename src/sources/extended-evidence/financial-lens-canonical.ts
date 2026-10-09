import { sourceGap } from "../../domain/source-gaps";
import type { ExtendedEvidence, ExtendedEvidenceItem, SourceGap } from "../../domain/types";
import type {
  FinancialStatementFact,
  FinancialStatementSeries,
  FinancialStatementSeriesKey,
  FinancialStatementsArtifact,
} from "./financial-statements-contract";
import {
  conceptScope,
  isContinuingScope,
  TOTAL_OPERATIONS_SCOPE,
} from "./financial-statement-definitions";
import {
  DEBT_MAY_INCLUDE_FINANCE_LEASES,
  formatSecFundamentalsSummary,
  type SecMetricDefinitionKey,
  type SecSicClassification,
} from "./sec-edgar";
import {
  financialStatementFacts,
  financialStatementPeriodMonths,
  financialStatementPeriodsYearAligned,
  financialStatementSeriesByKey,
  isYearAligned,
  latestCommonFinancialStatementFacts,
  latestCommonFinancialStatementPeriodEndFacts,
  latestFinancialStatementFact,
  unadjustedLeaseInclusiveDebt,
} from "./financial-statement-selection";

const CANONICAL_FINANCIAL_LENS_SELECTION_VERSION = 1;
const CANONICAL_FINANCIAL_LENS_SELECTION_VERSION_KEY = "financialLensSelectionVersion";

export interface CanonicalFinancialLensDerivedMetric {
  readonly value: number;
  readonly periodEnd: string;
  readonly periodMonths?: number;
}

export function canonicalFinancialLensDerivedMetric(
  item: ExtendedEvidenceItem | undefined,
  key: CanonicalDerivedMetricKey,
): CanonicalFinancialLensDerivedMetric | undefined {
  if (!hasCanonicalFinancialLensSelection(item)) {
    return;
  }
  const value = item?.metrics?.[`${key}SelectedValue`];
  const periodEnd = item?.metrics?.[`${key}SelectedPeriodEnd`];
  const periodMonths = item?.metrics?.[`${key}SelectedPeriodMonths`];
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    typeof periodEnd !== "string" ||
    (periodMonths !== undefined &&
      (typeof periodMonths !== "number" || !Number.isFinite(periodMonths)))
  ) {
    return;
  }
  return {
    value,
    periodEnd,
    ...(periodMonths !== undefined ? { periodMonths } : {}),
  };
}

function hasCanonicalFinancialLensSelection(item: ExtendedEvidenceItem | undefined): boolean {
  return (
    item?.metrics?.[CANONICAL_FINANCIAL_LENS_SELECTION_VERSION_KEY] ===
    CANONICAL_FINANCIAL_LENS_SELECTION_VERSION
  );
}

export function selectedFinancialLensDerivedMetric(
  item: ExtendedEvidenceItem | undefined,
  key: CanonicalDerivedMetricKey,
  legacyFallback: number | undefined,
): number | undefined {
  if (hasCanonicalFinancialLensSelection(item)) {
    return canonicalFinancialLensDerivedMetric(item, key)?.value;
  }
  return legacyFallback;
}

const FLOW_SERIES = [
  ["revenue", "revenue"],
  ["grossProfit", "grossProfit"],
  ["operatingIncome", "operatingIncome"],
  ["netIncome", "netIncome"],
  ["dilutedEps", "dilutedEps"],
  ["operatingCashFlow", "operatingCashFlow"],
  ["capex", "capitalExpenditure"],
  ["dividendsPaid", "dividendsPaid"],
  ["continuingIncome", "continuingIncome"],
  ["continuingDilutedEps", "continuingDilutedEps"],
] as const satisfies readonly (readonly [string, FinancialStatementSeriesKey])[];

const TOTAL_COUNTERPARTS = {
  continuingIncome: "netIncome",
  continuingDilutedEps: "dilutedEps",
} as const;

const INSTANT_SERIES = [
  ["cash", "cash"],
  ["debt", "debt"],
  ["currentAssets", "currentAssets"],
  ["currentLiabilities", "currentLiabilities"],
  ["stockholdersEquity", "stockholdersEquity"],
  ["assets", "totalAssets"],
] as const satisfies readonly (readonly [string, FinancialStatementSeriesKey])[];

type CanonicalFactMetricKey = (typeof FLOW_SERIES)[number][0] | (typeof INSTANT_SERIES)[number][0];

export type SecFactMetricKey = CanonicalFactMetricKey | SecMetricDefinitionKey;

export type SecMetricKey =
  | SecFactMetricKey
  | `${SecFactMetricKey}PeriodEnd`
  | `${SecFactMetricKey}PeriodMonths`
  | `${SecFactMetricKey}Prior`
  | `${SecFactMetricKey}DeltaPercent`
  | `${SecFactMetricKey}Scope`
  | `${CanonicalDerivedMetricKey}Selected${"Value" | "PeriodEnd" | "PeriodMonths"}`
  | "revenuePeriodEnd"
  | "financialLensSelectionVersion"
  | "sic"
  | "sicDescription";

function priorComparable(
  series: FinancialStatementSeries,
  selected: FinancialStatementFact,
): FinancialStatementFact | undefined {
  const months = financialStatementPeriodMonths(selected);
  return latestFinancialStatementFact(
    financialStatementFacts(series).filter(
      (fact) =>
        fact.periodEnd < selected.periodEnd &&
        fact.basis === selected.basis &&
        fact.concept === selected.concept &&
        financialStatementPeriodMonths(fact) === months &&
        (series.statement === "balanceSheet"
          ? fact.periodStart === undefined &&
            selected.periodStart === undefined &&
            isYearAligned(fact.periodEnd, selected.periodEnd)
          : financialStatementPeriodsYearAligned(fact, selected)) &&
        fact.currency === selected.currency &&
        fact.unit === selected.unit &&
        fact.unitScale === selected.unitScale,
    ),
  );
}

function addFactMetrics(
  metrics: Record<string, number | string>,
  key: CanonicalFactMetricKey,
  fact: FinancialStatementFact | undefined,
  series: FinancialStatementSeries,
): void {
  if (fact === undefined) {
    return;
  }
  metrics[key] = fact.value;
  metrics[`${key}PeriodEnd`] = fact.periodEnd;
  if (fact.basis !== undefined) {
    metrics[`${key}Basis`] = fact.basis;
  }
  const scope = conceptScope(fact.concept);
  if (scope !== undefined) {
    metrics[`${key}Scope`] = scope;
  }
  const months = financialStatementPeriodMonths(fact);
  if (months !== undefined) {
    metrics[`${key}PeriodMonths`] = months;
  }
  const prior = priorComparable(series, fact);
  if (prior !== undefined) {
    metrics[`${key}Prior`] = prior.value;
    if (prior.value !== 0) {
      metrics[`${key}DeltaPercent`] = ((fact.value - prior.value) / Math.abs(prior.value)) * 100;
    }
  }
}

function addCommonDerivedMetric(
  metrics: Record<string, CanonicalFinancialLensDerivedMetric>,
  key: string,
  left: FinancialStatementSeries | undefined,
  right: FinancialStatementSeries | undefined,
  derive: (left: number, right: number) => number | undefined,
): void {
  if (left === undefined || right === undefined) {
    return;
  }
  const facts = latestCommonFinancialStatementFacts([left, right]);
  if (facts === undefined) {
    return;
  }
  const [leftFact, rightFact] = facts;
  if (leftFact === undefined || rightFact === undefined) {
    return;
  }
  const value = derive(leftFact.value, rightFact.value);
  if (value === undefined || !Number.isFinite(value)) {
    return;
  }
  const { periodEnd } = leftFact;
  const months = financialStatementPeriodMonths(leftFact);
  metrics[key] = {
    value,
    periodEnd,
    ...(months !== undefined ? { periodMonths: months } : {}),
  };
}

function addCommonPeriodEndDerivedMetric(
  metrics: Record<string, CanonicalFinancialLensDerivedMetric>,
  key: string,
  left: FinancialStatementSeries | undefined,
  right: FinancialStatementSeries | undefined,
  derive: (left: FinancialStatementFact, right: FinancialStatementFact) => number | undefined,
): void {
  const facts = latestCommonFinancialStatementPeriodEndFacts([left, right]);
  if (facts === undefined || facts[0] === undefined || facts[1] === undefined) {
    return;
  }
  const value = derive(facts[0], facts[1]);
  if (value === undefined || !Number.isFinite(value)) {
    return;
  }
  const months = financialStatementPeriodMonths(facts[0]);
  metrics[key] = {
    value,
    periodEnd: facts[0].periodEnd,
    ...(months !== undefined ? { periodMonths: months } : {}),
  };
}

function dividedBy(left: number, right: number): number | undefined {
  return right === 0 ? undefined : left / right;
}

const COMMON_DERIVED_SERIES = [
  ["grossMargin", "grossProfit", "revenue", dividedBy],
  ["operatingMargin", "operatingIncome", "revenue", dividedBy],
  ["netMargin", "netIncome", "revenue", dividedBy],
  [
    "freeCashFlowProxy",
    "operatingCashFlow",
    "capex",
    (left: number, right: number) => left - right,
  ],
  ["cashConversion", "operatingCashFlow", "netIncome", dividedBy],
  ["netDebt", "debt", "cash", (left: number, right: number) => left - right],
  ["currentRatio", "currentAssets", "currentLiabilities", dividedBy],
  ["debtToEquity", "debt", "stockholdersEquity", dividedBy],
  [
    "payoutRatio",
    "dividendsPaid",
    "netIncome",
    (left: number, right: number) => dividedBy(Math.abs(left), right),
  ],
] as const;

const PERIOD_END_DERIVED_SERIES = [
  ["roe", "stockholdersEquity"],
  ["roa", "assets"],
] as const;

export type CanonicalDerivedMetricKey =
  | (typeof COMMON_DERIVED_SERIES)[number][0]
  | (typeof PERIOD_END_DERIVED_SERIES)[number][0];

// Cash conversion divides by income of the operating cash flow's own operations scope.
function cashConversionIncomeKey(
  operatingCashFlow: FinancialStatementSeries,
): "continuingIncome" | "netIncome" {
  const latest = latestFinancialStatementFact(financialStatementFacts(operatingCashFlow));
  return isContinuingScope(conceptScope(latest?.concept)) ? "continuingIncome" : "netIncome";
}

export function cashConversionScopeGaps(
  artifact: FinancialStatementsArtifact,
): readonly SourceGap[] {
  const { operatingCashFlow } = artifact.statements.cashFlowStatement;
  const incomeKey = cashConversionIncomeKey(operatingCashFlow);
  const income =
    incomeKey === "continuingIncome"
      ? artifact.statements.incomeStatement.continuingIncome
      : artifact.statements.incomeStatement.netIncome;
  if (
    financialStatementFacts(operatingCashFlow).length === 0 ||
    latestCommonFinancialStatementFacts([operatingCashFlow, income]) !== undefined
  ) {
    return [];
  }
  return [
    sourceGap({
      source: "sec-edgar",
      message:
        incomeKey === "continuingIncome"
          ? "SEC cash conversion withheld: operating cash flow is reported for continuing operations, and no income from continuing operations shares its period, currency, and unit"
          : "SEC cash conversion withheld: no net income shares the operating cash flow period, currency, and unit",
      symbol: artifact.symbol,
      provider: "sec-edgar",
      capability: "extended-evidence",
      cause: "provider-data-missing",
      evidenceQualityImpact: "no-cap",
    }),
  ];
}

function canonicalMetrics(artifact: FinancialStatementsArtifact): {
  readonly metrics: Record<string, number | string>;
} {
  const metrics: Record<string, number | string> = {};
  const derivedMetrics: Record<string, CanonicalFinancialLensDerivedMetric> = {};
  const inputs = [...FLOW_SERIES, ...INSTANT_SERIES].map(([metricKey, seriesKey]) => {
    const series = financialStatementSeriesByKey(artifact, seriesKey);
    if (series === undefined) {
      throw new Error(`Canonical financial statements are missing ${seriesKey}`);
    }
    const fact = latestFinancialStatementFact(financialStatementFacts(series));
    const totalPeriodEnd =
      metricKey in TOTAL_COUNTERPARTS
        ? metrics[`${TOTAL_COUNTERPARTS[metricKey as keyof typeof TOTAL_COUNTERPARTS]}PeriodEnd`]
        : undefined;
    // A continuing-operations series older than its total counterpart is history, not a scope split.
    if (
      typeof totalPeriodEnd !== "string" ||
      fact === undefined ||
      fact.periodEnd >= totalPeriodEnd
    ) {
      addFactMetrics(metrics, metricKey, fact, series);
    }
    return [metricKey, series] as const;
  });
  for (const [continuingKey, totalKey] of Object.entries(TOTAL_COUNTERPARTS)) {
    if (metrics[continuingKey] !== undefined && metrics[`${totalKey}Scope`] === undefined) {
      metrics[`${totalKey}Scope`] = TOTAL_OPERATIONS_SCOPE;
    }
  }
  const byMetric = new Map(inputs);
  for (const [key, leftKey, rightKey, derive] of COMMON_DERIVED_SERIES) {
    const left = byMetric.get(leftKey);
    addCommonDerivedMetric(
      derivedMetrics,
      key,
      left,
      byMetric.get(
        key === "cashConversion" && left !== undefined ? cashConversionIncomeKey(left) : rightKey,
      ),
      derive,
    );
  }
  for (const [key, selected] of Object.entries(derivedMetrics)) {
    metrics[`${key}SelectedValue`] = selected.value;
    metrics[`${key}SelectedPeriodEnd`] = selected.periodEnd;
    if (selected.periodMonths !== undefined) {
      metrics[`${key}SelectedPeriodMonths`] = selected.periodMonths;
    }
  }
  for (const [key, denominatorKey] of PERIOD_END_DERIVED_SERIES) {
    addCommonPeriodEndDerivedMetric(
      derivedMetrics,
      key,
      byMetric.get("netIncome"),
      byMetric.get(denominatorKey),
      (netIncome, denominator) => {
        const months = financialStatementPeriodMonths(netIncome);
        return months === undefined || denominator.value === 0
          ? undefined
          : (netIncome.value * (12 / months)) / denominator.value;
      },
    );
    const selected = derivedMetrics[key];
    if (selected !== undefined) {
      metrics[`${key}SelectedValue`] = selected.value;
      metrics[`${key}SelectedPeriodEnd`] = selected.periodEnd;
      if (selected.periodMonths !== undefined) {
        metrics[`${key}SelectedPeriodMonths`] = selected.periodMonths;
      }
    }
  }
  const { debtPeriodEnd } = metrics;
  const [incompleteDebt] = artifact.omissionNotes
    .filter(
      (note) =>
        note.code === "incomplete-composite-series" &&
        note.seriesKey === "debt" &&
        typeof debtPeriodEnd === "string" &&
        (note.periodKey?.replace(/^instant\|/u, "") ?? "") > debtPeriodEnd,
    )
    .toSorted((left, right) => (right.periodKey ?? "").localeCompare(left.periodKey ?? ""));
  const incompletePeriodEnd = incompleteDebt?.periodKey?.replace(/^instant\|/u, "");
  if (incompleteDebt !== undefined && incompletePeriodEnd !== undefined) {
    metrics.debtIncompletePeriodEnd = incompletePeriodEnd;
    metrics.debtIncompleteReason =
      /is incomplete: (?<reason>.*)\.$/u.exec(incompleteDebt.message)?.groups?.reason ??
      incompleteDebt.message;
  }
  const latestDebt = latestFinancialStatementFact(
    financialStatementFacts(artifact.statements.balanceSheet.debt),
  );
  if (
    latestDebt !== undefined &&
    latestDebt.basis === undefined &&
    unadjustedLeaseInclusiveDebt(latestDebt.taxonomy, latestDebt.concept).length > 0
  ) {
    metrics.debtLeaseScope = DEBT_MAY_INCLUDE_FINANCE_LEASES;
  }
  if (Object.keys(metrics).length > 0) {
    metrics[CANONICAL_FINANCIAL_LENS_SELECTION_VERSION_KEY] =
      CANONICAL_FINANCIAL_LENS_SELECTION_VERSION;
  }
  return { metrics };
}

function legacySecItem(evidence: ExtendedEvidence | undefined): ExtendedEvidenceItem | undefined {
  return evidence?.items.find(
    (item) => item.category === "sec-edgar" && item.metrics !== undefined,
  );
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

const CANONICAL_FACT_METRIC_KEYS = new Set<string>(
  [...FLOW_SERIES, ...INSTANT_SERIES].map(([metricKey]) => metricKey),
);

function canonicalSummary(
  legacy: ExtendedEvidenceItem | undefined,
  metrics: Readonly<Record<string, number | string>>,
): string {
  // Without a legacy item there is no us-gaap label or USD basis to render prose against.
  if (legacy === undefined) {
    return "Canonical SEC financial statement inputs.";
  }
  if (hasCanonicalFinancialLensSelection(legacy)) {
    return legacy.summary;
  }
  // Canonical keys render only from canonical metrics; legacy fills keys canonical never produces.
  const fundamentals = formatSecFundamentalsSummary((key) =>
    CANONICAL_FACT_METRIC_KEYS.has(key) ? metrics : legacy.metrics,
  );
  const filings = legacy.summary.replace(/SEC Fundamental Evidence: .*$/su, "").trim();
  return [filings, fundamentals].filter((part) => part !== undefined && part !== "").join(" ");
}

export function withCanonicalFinancialLensInputs(
  evidence: ExtendedEvidence | undefined,
  artifact: FinancialStatementsArtifact,
  sicClassification?: SecSicClassification,
): ExtendedEvidence {
  const legacy = legacySecItem(evidence);
  const { metrics } = canonicalMetrics(artifact);
  if (legacy === undefined && Object.keys(metrics).length === 0) {
    return evidence ?? { items: [], gaps: [] };
  }
  const classificationMetrics = Object.fromEntries(
    Object.entries(legacy?.metrics ?? {}).filter(
      ([key]) => key === "sic" || key === "sicDescription",
    ),
  );
  const canonical: ExtendedEvidenceItem = {
    category: "sec-edgar",
    title: legacy?.title ?? `${artifact.symbol} canonical financial statements`,
    summary: canonicalSummary(legacy, metrics),
    sourceIds: unique([...(legacy?.sourceIds ?? []), artifact.sourceId]),
    observedAt: legacy?.observedAt ?? artifact.analysisAsOf,
    metrics: {
      ...classificationMetrics,
      ...(sicClassification !== undefined
        ? {
            sic: sicClassification.sic,
            ...(sicClassification.sicDescription !== undefined
              ? { sicDescription: sicClassification.sicDescription }
              : {}),
          }
        : {}),
      ...metrics,
    },
    ...(legacy?.identity !== undefined ? { identity: legacy.identity } : {}),
  };
  const items = evidence?.items ?? [];
  return {
    ...(evidence?.instrument !== undefined ? { instrument: evidence.instrument } : {}),
    ...(evidence?.subject !== undefined ? { subject: evidence.subject } : {}),
    items:
      legacy === undefined
        ? [...items.filter((item) => item.category !== "financial-lens"), canonical]
        : items.map((item) => (item === legacy ? canonical : item)),
    gaps: evidence?.gaps ?? [],
  };
}
