import type { ExtendedEvidence, ExtendedEvidenceItem } from "../../domain/types";
import type {
  FinancialStatementFact,
  FinancialStatementSeries,
  FinancialStatementSeriesKey,
  FinancialStatementsArtifact,
} from "./financial-statements-contract";
import type { SecDebtMetricKey, SecMetricDefinitionKey, SecSicClassification } from "./sec-edgar";
import {
  financialStatementFacts,
  financialStatementPeriodMonths,
  financialStatementPeriodsYearAligned,
  financialStatementSeriesByKey,
  latestCommonFinancialStatementFacts,
  latestCommonFinancialStatementPeriodEndFacts,
  latestFinancialStatementFact,
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

export function hasCanonicalFinancialLensSelection(
  item: ExtendedEvidenceItem | undefined,
): boolean {
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
] as const satisfies readonly (readonly [string, FinancialStatementSeriesKey])[];

const INSTANT_SERIES = [
  ["cash", "cash"],
  ["debt", "debt"],
  ["currentAssets", "currentAssets"],
  ["currentLiabilities", "currentLiabilities"],
  ["stockholdersEquity", "stockholdersEquity"],
  ["assets", "totalAssets"],
] as const satisfies readonly (readonly [string, FinancialStatementSeriesKey])[];

export type CanonicalFactMetricKey =
  | (typeof FLOW_SERIES)[number][0]
  | (typeof INSTANT_SERIES)[number][0];

export type SecFactMetricKey = CanonicalFactMetricKey | SecMetricDefinitionKey | SecDebtMetricKey;

export type SecMetricKey =
  | SecFactMetricKey
  | `${SecFactMetricKey}PeriodEnd`
  | `${SecFactMetricKey}PeriodMonths`
  | `${SecFactMetricKey}Prior`
  | `${SecFactMetricKey}DeltaPercent`
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
        financialStatementPeriodMonths(fact) === months &&
        financialStatementPeriodsYearAligned(fact, selected) &&
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
    addFactMetrics(
      metrics,
      metricKey,
      latestFinancialStatementFact(financialStatementFacts(series)),
      series,
    );
    return [metricKey, series] as const;
  });
  const byMetric = new Map(inputs);
  for (const [key, leftKey, rightKey, derive] of COMMON_DERIVED_SERIES) {
    addCommonDerivedMetric(
      derivedMetrics,
      key,
      byMetric.get(leftKey),
      byMetric.get(rightKey),
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
    summary: legacy?.summary ?? "Canonical SEC financial statement inputs.",
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
