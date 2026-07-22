import type { ExtendedEvidence, ExtendedEvidenceItem } from "../../domain/types";
import type {
  FinancialStatementFact,
  FinancialStatementSeries,
  FinancialStatementsArtifact,
} from "./financial-statements-contract";
import {
  financialStatementPeriodMonths,
  financialStatementPeriodsYearAligned,
} from "./financial-statement-periods";

const FLOW_SERIES = [
  ["revenue", "revenue"],
  ["grossProfit", "grossProfit"],
  ["operatingIncome", "operatingIncome"],
  ["netIncome", "netIncome"],
  ["dilutedEps", "dilutedEps"],
  ["operatingCashFlow", "operatingCashFlow"],
  ["capex", "capitalExpenditure"],
  ["dividendsPaid", "dividendsPaid"],
] as const;

const INSTANT_SERIES = [
  ["cash", "cash"],
  ["debt", "debt"],
  ["currentAssets", "currentAssets"],
  ["currentLiabilities", "currentLiabilities"],
  ["stockholdersEquity", "stockholdersEquity"],
  ["assets", "totalAssets"],
] as const;

function allSeries(artifact: FinancialStatementsArtifact): readonly FinancialStatementSeries[] {
  return [
    ...Object.values(artifact.statements.incomeStatement),
    ...Object.values(artifact.statements.balanceSheet),
    ...Object.values(artifact.statements.cashFlowStatement),
    ...Object.values(artifact.statements.perShare),
  ];
}

function seriesByKey(
  artifact: FinancialStatementsArtifact,
  key: FinancialStatementSeries["key"],
): FinancialStatementSeries {
  const series = allSeries(artifact).find((candidate) => candidate.key === key);
  if (series === undefined) {
    throw new Error(`Canonical financial statements are missing ${key}`);
  }
  return series;
}

function latest(facts: readonly FinancialStatementFact[]): FinancialStatementFact | undefined {
  return facts.toSorted(
    (left, right) =>
      right.periodEnd.localeCompare(left.periodEnd) ||
      (left.periodStart ?? "").localeCompare(right.periodStart ?? "") ||
      right.filedAt.localeCompare(left.filedAt),
  )[0];
}

function priorComparable(
  series: FinancialStatementSeries,
  selected: FinancialStatementFact,
): FinancialStatementFact | undefined {
  const months = financialStatementPeriodMonths(selected);
  return latest(
    [...series.annual, ...series.interim].filter(
      (fact) =>
        fact.periodEnd < selected.periodEnd &&
        financialStatementPeriodMonths(fact) === months &&
        financialStatementPeriodsYearAligned(fact, selected),
    ),
  );
}

function addFactMetrics(
  metrics: Record<string, number | string>,
  key: string,
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

function canonicalMetrics(artifact: FinancialStatementsArtifact): Record<string, number | string> {
  const metrics: Record<string, number | string> = {};
  const revenueSeries = seriesByKey(artifact, "revenue");
  const revenueFact = latest([...revenueSeries.annual, ...revenueSeries.interim]);
  for (const [metricKey, seriesKey] of FLOW_SERIES) {
    const series = seriesByKey(artifact, seriesKey);
    const matchingRevenuePeriod =
      revenueFact === undefined
        ? undefined
        : [...series.annual, ...series.interim].find(
            (fact) => fact.periodKey === revenueFact.periodKey,
          );
    addFactMetrics(
      metrics,
      metricKey,
      matchingRevenuePeriod ?? latest([...series.annual, ...series.interim]),
      series,
    );
  }
  for (const [metricKey, seriesKey] of INSTANT_SERIES) {
    const series = seriesByKey(artifact, seriesKey);
    addFactMetrics(metrics, metricKey, latest([...series.annual, ...series.interim]), series);
  }
  return metrics;
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
): ExtendedEvidence {
  const legacy = legacySecItem(evidence);
  const metrics = canonicalMetrics(artifact);
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
    metrics: { ...classificationMetrics, ...metrics },
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
