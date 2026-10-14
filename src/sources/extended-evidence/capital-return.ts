import type {
  FinancialStatementFact,
  FinancialStatementSeriesKey,
} from "./financial-statements-contract";
import {
  compareFinancialStatementFacts,
  earlierShareBasisPeriods,
  financialStatementFacts,
  financialStatementSeriesByKey,
  isYearAligned,
  touchesEarlierShareBasis,
} from "./financial-statement-selection";
import {
  evaluateMetricSection,
  type MetricContext,
  type MetricDefinition,
  type MetricInput,
  type MetricOutcome,
} from "./metric-engine";

type CapitalReturnSeries =
  | "dividendsPaid"
  | "shareRepurchases"
  | "operatingCashFlow"
  | "capitalExpenditure"
  | "dilutedShares";

type FiscalYearSeries = readonly [CapitalReturnSeries, ...CapitalReturnSeries[]];

const SERIES_LABELS: Readonly<Record<CapitalReturnSeries, string>> = {
  dividendsPaid: "dividends paid",
  shareRepurchases: "share repurchases",
  operatingCashFlow: "operating cash flow",
  capitalExpenditure: "capital expenditure",
  dilutedShares: "diluted shares",
};

const DAY_MS = 86_400_000;
const DAYS_PER_YEAR = 365;
const ENDPOINT_TOLERANCE_DAYS = 15;
const SHARE_TREND_BAND = 0.03;
const SHARE_TREND_YEARS = 3;
// R8: the next fiscal year (12 months) plus the 20-F four-month deadline; past this a newer FY was due.
const NEXT_ANNUAL_FILING_DUE_MONTHS = 16;
// A 52/53-week year can end up to a week after the calendar anniversary.
const FISCAL_YEAR_END_SLACK_DAYS = 7;

interface FiscalYearSelection {
  readonly facts: readonly FinancialStatementFact[];
  readonly missing?: string;
}

function eligibleAnnualFacts(
  ctx: MetricContext,
  key: FinancialStatementSeriesKey,
): readonly FinancialStatementFact[] {
  const series =
    ctx.statements === undefined ? undefined : financialStatementSeriesByKey(ctx.statements, key);
  return (series?.annual ?? [])
    .filter(
      (fact) =>
        fact.periodType === "annual" &&
        fact.periodStart !== undefined &&
        isYearAligned(fact.periodStart, fact.periodEnd),
    )
    .toSorted(compareFinancialStatementFacts);
}

function statementInput(fact: FinancialStatementFact, key: CapitalReturnSeries): MetricInput {
  return {
    label: SERIES_LABELS[key],
    value: fact.value,
    artifact: "statements",
    series: key,
    periodType: fact.periodType,
    ...(fact.periodStart !== undefined ? { periodStart: fact.periodStart } : {}),
    periodEnd: fact.periodEnd,
    periodKey: fact.periodKey,
    unit: fact.unit,
    ...(fact.currency !== null ? { currency: fact.currency } : {}),
    sourceIds: fact.sourceIds,
  };
}

// Month-end period ends map to month-end due dates (June 30 -> October 31).
function nextAnnualFilingCutoff(periodEnd: string): string {
  const end = new Date(`${periodEnd.slice(0, 10)}T00:00:00Z`);
  const year = end.getUTCFullYear();
  const month = end.getUTCMonth() + NEXT_ANNUAL_FILING_DUE_MONTHS;
  const day = end.getUTCDate();
  const isMonthEnd = new Date(Date.UTC(year, end.getUTCMonth() + 1, 0)).getUTCDate() === day;
  const targetMonthEnd = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const due = Date.UTC(year, month, isMonthEnd ? targetMonthEnd : Math.min(day, targetMonthEnd));
  return new Date(due + FISCAL_YEAR_END_SLACK_DAYS * DAY_MS).toISOString().slice(0, 10);
}

function staleAnchor(ctx: MetricContext, label: string, periodEnd: string): string | undefined {
  const analysisAsOf = ctx.statements?.analysisAsOf;
  return analysisAsOf !== undefined && analysisAsOf.slice(0, 10) > nextAnnualFilingCutoff(periodEnd)
    ? `stale ${label} as of ${periodEnd}`
    : undefined;
}

// R1: the first series anchors the fiscal year; every other series must share its exact period.
function fiscalYearFacts(ctx: MetricContext, keys: FiscalYearSeries): FiscalYearSelection {
  const [anchorKey, ...joinedKeys] = keys;
  const [anchor] = eligibleAnnualFacts(ctx, anchorKey);
  if (anchor === undefined) {
    return { facts: [], missing: `no year-aligned annual ${SERIES_LABELS[anchorKey]} fact` };
  }
  const stale = staleAnchor(ctx, SERIES_LABELS[anchorKey], anchor.periodEnd);
  if (stale !== undefined) {
    return { facts: [anchor], missing: stale };
  }
  const facts = [anchor];
  for (const key of joinedKeys) {
    const match = eligibleAnnualFacts(ctx, key).find(
      (fact) => fact.periodKey === anchor.periodKey && fact.periodType === anchor.periodType,
    );
    if (match === undefined) {
      return {
        facts,
        missing: `no same-period ${SERIES_LABELS[key]} for the fiscal year ending ${anchor.periodEnd}`,
      };
    }
    facts.push(match);
  }
  return { facts };
}

function missingOutcome(
  reason: string,
  facts: readonly FinancialStatementFact[],
  keys: FiscalYearSeries,
  extraInputs: readonly MetricInput[] = [],
): MetricOutcome {
  const [anchor] = facts;
  return {
    status: "missing",
    reason,
    ...(anchor !== undefined ? { periodEnd: anchor.periodEnd } : {}),
    inputs: [...inputsOf(facts, keys), ...extraInputs],
  };
}

function inputsOf(
  facts: readonly FinancialStatementFact[],
  keys: FiscalYearSeries,
): readonly MetricInput[] {
  return facts.map((fact, index) => statementInput(fact, keys[index]!));
}

function absoluteSum(facts: readonly FinancialStatementFact[]): number {
  return facts.reduce((sum, fact) => sum + Math.abs(fact.value), 0);
}

function latestFyAmount(key: CapitalReturnSeries) {
  return (ctx: MetricContext): MetricOutcome => {
    const { facts, missing } = fiscalYearFacts(ctx, [key]);
    if (missing !== undefined) {
      return missingOutcome(missing, facts, [key]);
    }
    const [fact] = facts;
    return {
      status: "value",
      value: Math.abs(fact!.value),
      ...(fact!.currency !== null ? { currency: fact!.currency } : {}),
      periodEnd: fact!.periodEnd,
      inputs: inputsOf(facts, [key]),
    };
  };
}

function daysBetween(start: string, end: string): number {
  return (Date.parse(end) - Date.parse(start)) / DAY_MS;
}

function shareCountChange(ctx: MetricContext, years: number): MetricOutcome {
  const facts = eligibleAnnualFacts(ctx, "dilutedShares");
  const [latest] = facts;
  if (latest === undefined) {
    return { status: "missing", reason: "no year-aligned annual diluted shares fact" };
  }
  const stale = staleAnchor(ctx, SERIES_LABELS.dilutedShares, latest.periodEnd);
  if (stale !== undefined) {
    return missingOutcome(stale, [latest], ["dilutedShares"]);
  }
  const prior = facts.find(
    (fact) =>
      Math.abs(daysBetween(fact.periodEnd, latest.periodEnd) - years * DAYS_PER_YEAR) <=
      ENDPOINT_TOLERANCE_DAYS,
  );
  if (prior === undefined) {
    return missingOutcome(
      `no annual diluted shares fact ${String(years)}y before the fiscal year ending ${latest.periodEnd}`,
      [latest],
      ["dilutedShares"],
    );
  }
  const inputs = [statementInput(prior, "dilutedShares"), statementInput(latest, "dilutedShares")];
  const series = financialStatementSeriesByKey(ctx.statements!, "dilutedShares")!;
  const window = financialStatementFacts(series).filter(
    (fact) => fact.periodEnd >= prior.periodEnd && fact.periodEnd <= latest.periodEnd,
  );
  // R6: a split inside the window makes the endpoints incomparable; they are refused, not adjusted.
  if (
    touchesEarlierShareBasis(
      window,
      earlierShareBasisPeriods(ctx.statements!.omissionNotes, "dilutedShares"),
    )
  ) {
    return {
      status: "not-meaningful",
      reason: "diluted shares inside the window are on an earlier share basis",
      inputs,
    };
  }
  if (prior.value <= 0) {
    return {
      status: "not-meaningful",
      reason: "earlier diluted share count is not positive",
      inputs,
    };
  }
  return {
    status: "value",
    value: latest.value / prior.value - 1,
    periodEnd: latest.periodEnd,
    inputs,
  };
}

function shareCountTrend(ctx: MetricContext): MetricOutcome {
  const change = shareCountChange(ctx, SHARE_TREND_YEARS);
  if (change.status !== "value" || typeof change.value !== "number") {
    return change;
  }
  if (Math.abs(change.value) < SHARE_TREND_BAND) {
    return { ...change, value: "stable" };
  }
  return { ...change, value: change.value < 0 ? "declining" : "increasing" };
}

function marketCapYield(keys: FiscalYearSeries) {
  return (ctx: MetricContext): MetricOutcome => {
    const { facts, missing } = fiscalYearFacts(ctx, keys);
    if (missing !== undefined) {
      return missingOutcome(missing, facts, keys);
    }
    const { quote } = ctx;
    if (quote === undefined) {
      return missingOutcome("no quote market cap", facts, keys);
    }
    const quoteInput: MetricInput = {
      label: "market cap",
      value: quote.marketCap,
      artifact: "quote",
      series: "marketCap",
      periodEnd: quote.asOf,
      unit: quote.currency ?? "unknown",
      ...(quote.currency !== undefined ? { currency: quote.currency } : {}),
      sourceIds: [quote.sourceId],
    };
    const reportingCurrency = facts[0]!.currency;
    if (quote.currency === undefined || reportingCurrency !== quote.currency) {
      return missingOutcome(
        `reporting currency ${reportingCurrency ?? "unknown"} differs from quote currency ${quote.currency ?? "unknown"}`,
        facts,
        keys,
        [quoteInput],
      );
    }
    const inputs = [...inputsOf(facts, keys), quoteInput];
    if (quote.marketCap <= 0) {
      return { status: "not-meaningful", reason: "market cap is not positive", inputs };
    }
    return {
      status: "value",
      value: absoluteSum(facts) / quote.marketCap,
      periodEnd: facts[0]!.periodEnd,
      inputs,
    };
  };
}

function freeCashFlowRatio(numerators: FiscalYearSeries) {
  const keys: FiscalYearSeries = [...numerators, "operatingCashFlow", "capitalExpenditure"];
  return (ctx: MetricContext): MetricOutcome => {
    const { facts, missing } = fiscalYearFacts(ctx, keys);
    if (missing !== undefined) {
      return missingOutcome(missing, facts, keys);
    }
    const inputs = inputsOf(facts, keys);
    const [operatingCashFlow, capitalExpenditure] = facts.slice(-2);
    const freeCashFlow = operatingCashFlow!.value - Math.abs(capitalExpenditure!.value);
    if (freeCashFlow <= 0) {
      return {
        status: "not-meaningful",
        reason: `free cash flow is zero or negative for the fiscal year ending ${facts[0]!.periodEnd}`,
        inputs,
      };
    }
    return {
      status: "value",
      value: absoluteSum(facts.slice(0, numerators.length)) / freeCashFlow,
      periodEnd: facts[0]!.periodEnd,
      inputs,
    };
  };
}

function depositoryIssuer(ctx: MetricContext): string | undefined {
  return ctx.depositorySic === undefined
    ? undefined
    : `depository issuer (SIC ${ctx.depositorySic}): operating cash flow is not a free cash flow basis`;
}

function latestStockBasedCompensation(ctx: MetricContext): MetricOutcome {
  const fact = ctx.capitalOwnership?.stockBasedCompensation
    .filter(
      (candidate) =>
        candidate.periodStart !== undefined &&
        isYearAligned(candidate.periodStart, candidate.periodEnd),
    )
    .toSorted((left, right) => right.periodEnd.localeCompare(left.periodEnd))
    .at(0);
  if (fact?.periodStart === undefined) {
    return { status: "missing", reason: "no year-aligned annual stock-based compensation fact" };
  }
  const inputs: readonly MetricInput[] = [
    {
      label: "stock-based compensation",
      value: fact.value,
      artifact: "capitalOwnership",
      series: "stockBasedCompensation",
      periodType: "annual",
      periodStart: fact.periodStart,
      periodEnd: fact.periodEnd,
      unit: fact.unit,
      currency: fact.unit,
      sourceIds: fact.sourceIds,
    },
  ];
  const stale = staleAnchor(ctx, "stock-based compensation", fact.periodEnd);
  if (stale !== undefined) {
    return { status: "missing", reason: stale, periodEnd: fact.periodEnd, inputs };
  }
  return {
    status: "value",
    value: fact.value,
    currency: fact.unit,
    periodEnd: fact.periodEnd,
    inputs,
  };
}

const FCF_BASIS =
  "free cash flow = operating cash flow - capital expenditure, all from one year-aligned fiscal year";

const CAPITAL_RETURN_METRICS: readonly MetricDefinition[] = [
  {
    id: "buybacksLatestFy",
    label: "Share repurchases (latest FY)",
    unit: "currency",
    basis: "cash paid for share repurchases in the latest year-aligned fiscal year",
    compute: latestFyAmount("shareRepurchases"),
  },
  {
    id: "dividendsLatestFy",
    label: "Dividends paid (latest FY)",
    unit: "currency",
    basis: "cash dividends paid in the latest year-aligned fiscal year",
    compute: latestFyAmount("dividendsPaid"),
  },
  ...[1, 3, 5].map(
    (years): MetricDefinition => ({
      id: `shareCountChange${String(years)}y`,
      label: `Diluted share count change (${String(years)}y)`,
      unit: "ratio-percent",
      basis: `diluted weighted-average shares, latest fiscal year vs the fiscal year ${String(years)}y earlier`,
      compute: (ctx) => shareCountChange(ctx, years),
    }),
  ),
  {
    id: "shareCountTrend",
    label: "Diluted share count trend (3y)",
    unit: "text",
    basis: `3y diluted share count change: declining at or below -${String(SHARE_TREND_BAND * 100)}%, increasing at or above +${String(SHARE_TREND_BAND * 100)}%, else stable`,
    compute: shareCountTrend,
  },
  {
    id: "buybackYield",
    label: "Buyback yield",
    unit: "ratio-percent",
    basis: "latest FY share repurchases / current quote market cap",
    compute: marketCapYield(["shareRepurchases"]),
  },
  {
    id: "dividendYieldFiled",
    label: "Dividend yield (filed)",
    unit: "ratio-percent",
    basis: "latest FY dividends paid / current quote market cap",
    compute: marketCapYield(["dividendsPaid"]),
  },
  {
    id: "shareholderYield",
    label: "Shareholder yield",
    unit: "ratio-percent",
    basis: "latest FY dividends paid + same-year share repurchases / current quote market cap",
    compute: marketCapYield(["dividendsPaid", "shareRepurchases"]),
  },
  {
    id: "fcfPayoutRatio",
    label: "Dividends / free cash flow",
    unit: "ratio-percent",
    basis: `latest FY dividends paid / ${FCF_BASIS}`,
    applicable: depositoryIssuer,
    compute: freeCashFlowRatio(["dividendsPaid"]),
  },
  {
    id: "totalPayoutToFcf",
    label: "Dividends + repurchases / free cash flow",
    unit: "ratio-percent",
    basis: `latest FY dividends paid + share repurchases / ${FCF_BASIS}`,
    applicable: depositoryIssuer,
    compute: freeCashFlowRatio(["dividendsPaid", "shareRepurchases"]),
  },
  {
    id: "sbcLatestFy",
    label: "Stock-based compensation (latest FY)",
    unit: "currency",
    basis: "stock-based compensation in the latest annual filing",
    compute: latestStockBasedCompensation,
  },
];

export function capitalReturnSection(ctx: MetricContext): ReturnType<typeof evaluateMetricSection> {
  return evaluateMetricSection("capital-return", "Capital Return", CAPITAL_RETURN_METRICS, ctx);
}
