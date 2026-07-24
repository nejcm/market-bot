import {
  buildFundamentalHistorySeries,
  fundamentalHistoryCagr,
  type FundamentalHistoryArtifact,
  type FundamentalHistoryPoint,
  type FundamentalHistoryRawSeries,
  type FundamentalHistorySeries,
} from "./fundamental-history";
import type {
  FinancialStatementFact,
  FinancialStatementSeries,
  FinancialStatementSeriesKey,
  FinancialStatementsArtifact,
} from "./financial-statements-contract";
import { financialStatementPeriodMonths } from "./financial-statement-periods";

const EPS_TTM_APPROXIMATION_NOTE =
  "ttm:eps-approximation: diluted EPS TTM adds per-share periods and does not reweight diluted shares";

interface CanonicalHistoryDefinition {
  readonly key: keyof FundamentalHistoryRawSeries;
  readonly canonicalKey: FinancialStatementSeriesKey;
  readonly label: string;
  readonly unit: "currency" | "per-share";
}

const DEFINITIONS: readonly CanonicalHistoryDefinition[] = [
  { key: "revenue", canonicalKey: "revenue", label: "Revenue", unit: "currency" },
  {
    key: "grossProfit",
    canonicalKey: "grossProfit",
    label: "Gross profit",
    unit: "currency",
  },
  {
    key: "operatingIncome",
    canonicalKey: "operatingIncome",
    label: "Operating income",
    unit: "currency",
  },
  { key: "netIncome", canonicalKey: "netIncome", label: "Net income", unit: "currency" },
  {
    key: "dilutedEps",
    canonicalKey: "dilutedEps",
    label: "Diluted EPS",
    unit: "per-share",
  },
  {
    key: "operatingCashFlow",
    canonicalKey: "operatingCashFlow",
    label: "Operating cash flow",
    unit: "currency",
  },
  {
    key: "capex",
    canonicalKey: "capitalExpenditure",
    label: "Capital expenditure",
    unit: "currency",
  },
];

function canonicalSeries(
  artifact: FinancialStatementsArtifact,
  key: FinancialStatementSeriesKey,
): FinancialStatementSeries {
  const series = [
    ...Object.values(artifact.statements.incomeStatement),
    ...Object.values(artifact.statements.balanceSheet),
    ...Object.values(artifact.statements.cashFlowStatement),
    ...Object.values(artifact.statements.perShare),
  ].find((candidate) => candidate.key === key);
  if (series === undefined) {
    throw new Error(`Canonical financial statements are missing ${key}`);
  }
  return series;
}

function annualPoint(fact: FinancialStatementFact): FundamentalHistoryPoint | undefined {
  const months = financialStatementPeriodMonths(fact);
  if (
    fact.periodStart === undefined ||
    months === undefined ||
    months < 10 ||
    months > 14 ||
    (fact.canonicalForm !== "10-K" && fact.canonicalForm !== "20-F")
  ) {
    return undefined;
  }
  return {
    value: fact.value,
    form: fact.canonicalForm,
    fy: fact.fiscalYear,
    fp: fact.fiscalPeriod,
    periodStart: fact.periodStart,
    periodEnd: fact.periodEnd,
    periodMonths: months,
    filedAt: fact.filedAt,
    currency: fact.unit,
  };
}

function ttmPoint(series: FinancialStatementSeries): FundamentalHistoryPoint | undefined {
  const { ttm } = series;
  if (ttm === undefined) {
    return undefined;
  }
  return {
    value: ttm.value,
    form: "TTM",
    fy: ttm.components.latestYearToDate.fiscalYear,
    fp: "TTM",
    periodStart: ttm.periodStart,
    periodEnd: ttm.periodEnd,
    periodMonths: 12,
    filedAt: Object.values(ttm.components)
      .map((fact) => fact.filedAt)
      .toSorted()
      .at(-1)!,
    currency: ttm.unit,
  };
}

function rawSeries(
  artifact: FinancialStatementsArtifact,
  definition: CanonicalHistoryDefinition,
): FundamentalHistorySeries {
  const series = canonicalSeries(artifact, definition.canonicalKey);
  const notes: string[] = [];
  const annual = series.annual.flatMap((fact) => {
    const point = annualPoint(fact);
    return point === undefined ? [] : [point];
  });
  const ttm = ttmPoint(series);
  if (annual.length === 0) {
    notes.push("annual:missing-concept: no canonical annual facts found");
  }
  if (ttm === undefined) {
    notes.push("ttm:unreconciled: canonical TTM is unavailable");
  }
  if (definition.key === "dilutedEps" && ttm !== undefined) {
    notes.push(EPS_TTM_APPROXIMATION_NOTE);
  }
  const growth = fundamentalHistoryCagr(annual, notes);
  const concept = [...series.annual, ...series.interim][0]?.concept;
  return {
    key: definition.key,
    label: definition.label,
    unit: definition.unit,
    ...(concept !== undefined ? { concept } : {}),
    annual,
    ...(ttm !== undefined ? { ttm } : {}),
    ...(growth !== undefined ? { cagr: growth } : {}),
    notes,
  };
}

export function deriveFundamentalHistoryFromFinancialStatements(
  artifact: FinancialStatementsArtifact,
): FundamentalHistoryArtifact {
  const raw = Object.fromEntries(
    DEFINITIONS.map((definition) => [definition.key, rawSeries(artifact, definition)]),
  ) as FundamentalHistoryRawSeries;
  return {
    version: 1,
    generatedAt: artifact.generatedAt,
    symbol: artifact.symbol,
    sourceId: artifact.sourceId,
    ...(artifact.sourceUrl !== undefined ? { sourceUrl: artifact.sourceUrl } : {}),
    series: buildFundamentalHistorySeries(raw),
  };
}
